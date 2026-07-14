"""Focused contract and end-to-end tests for outcome_distill_v2.py."""

from __future__ import annotations

import json
import tempfile
import traceback
from pathlib import Path

import numpy as np
import torch

from model import build_model
from model_v2 import load_checkpoint
from outcome_distill_v2 import (
    OutcomeDistillDataset,
    anchored_outcome_surrogate,
    enforce_trust_region,
    masked_policy_terms,
    outcome_surrogate_loss,
    strategic_tail_cvar,
    top_fraction_mean,
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
                policy_row = step == 0 or (step == 1 and game % 2 == 0)
                record = {
                    "obs": obs.tolist(),
                    "obsV2": flat[(game * 2 + step) % flat.shape[0]].tolist(),
                    "cands": cands.tolist(),
                    "chosen": chosen,
                    "policyMask": int(policy_row),
                    "reach30Pred": 0.4 + 0.1 * won,
                    "strategic": int(step == 0),
                    "decisionType": "lockNavigation" if step == 0 else "resolveMonsterReward",
                    "round": game + 1,
                    "stepIdx": step,
                    "ret": float(value),
                    "gameId": f"{seed * 100000 + game}-1p-Red",
                }
                if policy_row:
                    record.update({
                        "behaviorMask": behavior_mask.astype(int).tolist(),
                        "behaviorTemperature": 0.55,
                        "logpOld": float(logp[chosen]),
                    })
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
        assert dataset.policy_row_count == 12
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


def test_anchored_surrogate_clipping_gradient_and_zero_weight() -> None:
    current_logp = torch.log(
        torch.tensor([0.7, 1.3, 1.3, 0.7, 1.0], requires_grad=True)
    )
    current_logp.retain_grad()
    teacher_logp = torch.tensor([-np.log(3.0), 0.0, 0.0, 0.0, 0.0])
    anchor_logp = torch.zeros(5)
    terms = {
        "teacher_chosen_logp": teacher_logp,
        "student_chosen_logp": current_logp,
    }
    diagnostics = anchored_outcome_surrogate(
        terms,
        target=torch.tensor([1.0, 1.0, 0.0, 0.0, 1.0]),
        reach30_pred=torch.full((5,), 0.5),
        weight=torch.tensor([1.0, 1.0, 1.0, 1.0, 0.0]),
        anchor_chosen_logp=anchor_logp,
        clip_epsilon=0.2,
        behavior_ratio_cap=2.0,
        total_rows=5,
        total_episode_weight=4.0,
    )
    diagnostics["loss"].backward()
    assert np.isclose(float(diagnostics["behaviorRatioRaw"][0]), 3.0)
    assert np.isclose(float(diagnostics["behaviorRatio"][0]), 2.0)
    assert bool(diagnostics["behaviorCapped"][0])
    # Positive advantage below the lower clip remains trainable and increases log-probability.
    assert float(current_logp.grad[0]) < 0
    # Positive advantage above the upper clip and negative advantage below the lower clip freeze.
    assert abs(float(current_logp.grad[1])) < 1e-8
    assert abs(float(current_logp.grad[3])) < 1e-8
    # Negative advantage above the upper clip decreases log-probability.
    assert float(current_logp.grad[2]) > 0
    # Non-strategic/zero-weight rows never receive outcome gradient.
    assert abs(float(current_logp.grad[4])) < 1e-8


def test_trust_region_checks_every_registered_metric() -> None:
    metrics = {
        "teacherKlMean": 0.01,
        "teacherKlP99": 0.2,
        "top1Agreement": 0.91,
        "strategicTeacherKlMean": 0.02,
        "strategicTeacherKlP99": 0.41,
        "strategicTop1Agreement": 0.92,
    }
    try:
        enforce_trust_region(
            metrics,
            context="fixture epoch",
            max_mean_kl=0.05,
            max_p99_kl=0.5,
            max_strategic_mean_kl=0.05,
            max_strategic_p99_kl=0.4,
            min_top1_agreement=0.88,
            min_strategic_top1_agreement=0.88,
        )
    except RuntimeError as exc:
        assert "strategic p99" in str(exc)
    else:
        raise AssertionError("strategic p99 trust breach was accepted")


def test_strategic_tail_cvar_selection_gradient_and_empty_group() -> None:
    kl = torch.tensor([0.1, 0.8, 0.2, 0.6, 0.9], requires_grad=True)
    strategic = torch.tensor([True, True, False, True, False])
    tail, rows, selected = strategic_tail_cvar(kl, strategic, 0.5)
    assert rows == 3 and selected == 2
    assert torch.allclose(tail, torch.tensor(0.7))
    (kl.mean() + 0.0 * tail).backward(retain_graph=True)
    assert torch.allclose(kl.grad, torch.full_like(kl, 0.2))
    kl.grad.zero_()
    tail.backward()
    assert torch.equal(kl.grad != 0, torch.tensor([False, True, False, True, False]))

    empty, rows, selected = strategic_tail_cvar(
        kl.detach().clone().requires_grad_(True), torch.zeros(5, dtype=torch.bool), 0.05
    )
    assert rows == 0 and selected == 0 and float(empty.detach()) == 0.0


def test_top_fraction_mean_uses_ceil_and_at_least_one() -> None:
    values = np.asarray([0.1, 0.2, 0.3, 0.9], dtype=np.float64)
    assert np.isclose(top_fraction_mean(values, 0.05), 0.9)
    assert np.isclose(top_fraction_mean(values, 0.5), 0.6)


def test_stage1_and_stage2_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        teacher_path = root / "teacher.json"
        teacher = make_teacher(teacher_path)
        write_dataset(root / "train", teacher, seed=21, games=12)
        write_dataset(root / "validation", teacher, seed=22, games=8)
        preflight = train(
            root / "train",
            root / "validation",
            teacher_path,
            root / "unused.pt",
            batch_size=8,
            audit_only=True,
            teacher_logp_tolerance=1e-5,
            device=torch.device("cpu"),
        )
        assert preflight["valid"] is True
        assert not (root / "unused.pt").exists()
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
            val_select_seed0=2200000,
            val_select_games=4,
            val_gate_seed0=2200004,
            val_gate_games=4,
            early_stop_patience=2,
            early_stop_min_delta=0.0001,
            early_stop_min_epochs=1,
            strategic_kl_fraction=0.5,
            selection_metric="strategicTeacherKlCvar05",
            teacher_logp_tolerance=1e-5,
            device=torch.device("cpu"),
        )
        assert stage1.exists() and stage1.with_suffix(".manifest.json").exists()
        assert stats1["teacherLogpAudit"]["validation"]["maxAbsError"] < 1e-5
        assert stats1["bestEpoch"] in (1, 2)
        assert stats1["selectionMetric"] == "strategicTeacherKlCvar05"
        assert "strategicTeacherKlCvar05" in stats1["gateValidation"]
        assert stats1["gateValidation"]["strategicPolicyRows"] == 4

        plain_zero = root / "plain-zero.pt"
        anchored_zero = root / "anchored-zero.pt"
        common_zero = {
            "init_path": stage1,
            "epochs": 1,
            "batch_size": 8,
            "lr": 1e-4,
            "outcome_pg_coef": 0.0,
            "seed": 282800,
            "teacher_logp_tolerance": 1e-5,
            "device": torch.device("cpu"),
        }
        train(
            root / "train",
            root / "validation",
            teacher_path,
            plain_zero,
            **common_zero,
        )
        train(
            root / "train",
            root / "validation",
            teacher_path,
            anchored_zero,
            outcome_reference_path=stage1,
            outcome_behavior_ratio_cap=2.0,
            **common_zero,
        )
        plain_state = load_checkpoint(plain_zero).state_dict()
        anchored_state = load_checkpoint(anchored_zero).state_dict()
        assert plain_state.keys() == anchored_state.keys()
        assert all(
            torch.equal(plain_state[key], anchored_state[key]) for key in plain_state
        )

        stage2 = root / "stage2.pt"
        stats2 = train(
            root / "train",
            root / "validation",
            teacher_path,
            stage2,
            init_path=stage1,
            outcome_reference_path=stage1,
            epochs=1,
            batch_size=8,
            lr=1e-4,
            outcome_pg_coef=0.1,
            outcome_behavior_ratio_cap=2.0,
            seed=282800,
            max_mean_kl=10.0,
            max_p99_kl=10.0,
            teacher_logp_tolerance=1e-5,
            device=torch.device("cpu"),
        )
        assert stage2.exists()
        assert stats2["initSha256"] == stats1["checkpointSha256"]
        assert stats2["outcomeReferenceSha256"] == stats1["checkpointSha256"]
        assert stats2["outcomeReferenceAudit"]["all"]["count"] == 12
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
