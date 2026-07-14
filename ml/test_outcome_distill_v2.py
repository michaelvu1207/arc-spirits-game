"""Focused contract and end-to-end tests for outcome_distill_v2.py."""

from __future__ import annotations

import json
import tempfile
import traceback
from pathlib import Path

import numpy as np
import torch

from model import build_model
from outcome_distill_v2 import (
    OutcomeDistillDataset,
    masked_policy_terms,
    outcome_surrogate_loss,
    train,
)
from train import export_weights


FIXTURE = Path(__file__).parent / "data_fixtures" / "obsv2_fixture.json"


def make_teacher(path: Path, *, seed: int = 7):
    torch.manual_seed(seed)
    model = build_model(
        7, 5, device=torch.device("cpu"), trunk_hidden=(16,), value_hidden=(8,)
    ).eval()
    export_weights(model, 7, 5, path)
    return model


def write_dataset(
    data_dir: Path,
    teacher,
    *,
    seed: int,
    games: int = 8,
) -> None:
    fixture = json.loads(FIXTURE.read_text())
    flat = np.asarray(fixture["flat"], dtype=np.float32)
    rng = np.random.default_rng(seed)
    data_dir.mkdir(parents=True, exist_ok=True)
    with open(data_dir / "shard-0.jsonl", "w") as handle:
        for game in range(games):
            for step in range(2):
                obs = rng.normal(size=7).astype(np.float32)
                cands = rng.normal(size=(4, 5)).astype(np.float32)
                behavior_mask = np.asarray([True, True, False, True])
                with torch.no_grad():
                    logits, _, value = teacher(
                        torch.from_numpy(obs).unsqueeze(0),
                        torch.from_numpy(cands).unsqueeze(0),
                        torch.ones(1, 4, dtype=torch.bool),
                    )
                    scaled = logits[0] / 0.55
                    scaled[~torch.from_numpy(behavior_mask)] = float("-inf")
                    logp = torch.log_softmax(scaled, dim=-1)
                    chosen = int(logp.argmax())
                won = game % 2 == 0
                record = {
                    "obs": obs.tolist(),
                    "obsV2": flat[(game * 2 + step) % flat.shape[0]].tolist(),
                    "cands": cands.tolist(),
                    "chosen": chosen,
                    "behaviorMask": behavior_mask.astype(int).tolist(),
                    "behaviorTemperature": 0.55,
                    "logpOld": float(logp[chosen]),
                    "reach30Pred": 0.4 + 0.1 * won,
                    "strategic": int(step == 0),
                    "ret": float(value),
                    "gameId": f"g-{seed}-{game}",
                }
                if step == 1:
                    record.update({
                        "reach30Target": int(won),
                        "reach30Horizon": 30,
                        "endRound": 22 if won else 30,
                    })
                handle.write(json.dumps(record) + "\n")
    (data_dir / "meta.json").write_text(json.dumps({
        "obs_dim": 7,
        "act_dim": 5,
        "obs_version": 2,
        "obs_v2": fixture["meta"],
        "samples": games * 2,
        "games": games,
    }))


def test_dataset_equal_game_weights_and_support() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        teacher = make_teacher(root / "teacher.json")
        write_dataset(root / "data", teacher, seed=11)
        dataset = OutcomeDistillDataset(root / "data")
        assert len(dataset) == 16 and dataset.games == 8 and dataset.true_wins == 4
        assert np.isclose(dataset.reach_weight.sum(), 8)
        assert np.isclose(dataset.outcome_weight.sum(), 8)
        assert all(mask[chosen] for mask, chosen in zip(dataset.behavior_masks, dataset.chosen))


def test_identical_logits_have_zero_kl_and_unit_ratio_surrogate() -> None:
    logits = torch.tensor([[1.0, 2.0, -3.0], [0.5, -0.5, 0.0]])
    support = torch.tensor([[True, True, False], [True, False, True]])
    chosen = torch.tensor([1, 0])
    terms = masked_policy_terms(
        logits, logits.clone(), support, torch.tensor([0.55, 0.55]), chosen
    )
    assert torch.allclose(terms["kl"], torch.zeros(2), atol=1e-7)
    loss = outcome_surrogate_loss(
        terms,
        torch.tensor([1.0, 0.0]),
        torch.tensor([0.4, 0.6]),
        torch.tensor([1.0, 1.0]),
        clip_epsilon=0.2,
        total_rows=2,
        total_episode_weight=2,
    )
    assert torch.isfinite(loss)
    assert abs(float(loss)) < 1e-7  # advantages +0.6 and -0.6 cancel at ratio one


def test_stage1_and_stage2_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        teacher_path = root / "teacher.json"
        teacher = make_teacher(teacher_path)
        write_dataset(root / "train", teacher, seed=21, games=12)
        write_dataset(root / "validation", teacher, seed=22, games=8)
        stage1 = root / "stage1.pt"
        stats1 = train(
            root / "train",
            root / "validation",
            teacher_path,
            stage1,
            epochs=2,
            batch_size=8,
            lr=1e-3,
            d_model=32,
            layers=1,
            heads=2,
            seed=28,
            select_best_teacher_kl=True,
            teacher_logp_tolerance=1e-5,
            device=torch.device("cpu"),
        )
        assert stage1.exists() and stage1.with_suffix(".manifest.json").exists()
        assert stats1["teacherLogpAudit"]["validation"]["maxAbsError"] < 1e-5
        assert stats1["bestEpoch"] in (1, 2)

        stage2 = root / "stage2.pt"
        stats2 = train(
            root / "train",
            root / "validation",
            teacher_path,
            stage2,
            init_path=stage1,
            epochs=1,
            batch_size=8,
            lr=1e-4,
            outcome_pg_coef=0.1,
            seed=282800,
            max_mean_kl=10.0,
            max_p99_kl=10.0,
            teacher_logp_tolerance=1e-5,
            device=torch.device("cpu"),
        )
        assert stage2.exists()
        assert stats2["initSha256"] == stats1["checkpointSha256"]
        assert stats2["epochs"][0]["train"]["outcomePgLoss"] != 0


def main() -> int:
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, test in tests:
        try:
            test()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
