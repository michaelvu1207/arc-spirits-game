"""
Tests for ml/bc_warmstart_v2.py and ml/distill.py.

Uses the real-encoder fixture (ml/data_fixtures/obsv2_fixture.json — regenerate
with `FIXTURE=1 npx vitest run src/lib/play/ml/_obsv2fixture.test.ts`) to build
synthetic-but-schema-exact datasets: real flat v2 observations, random candidate
vectors with a learnable signal (chosen = argmax of candidate feature 0).

Run:  ml/.venv/bin/python ml/test_train_v2.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import torch

from bc_warmstart_v2 import DecisionDatasetV2, load_spec_for_dataset, train_bc
from distill import distill
from model_v2 import build_model_v2, load_checkpoint, save_checkpoint
from obs_v2 import ObsV2Spec

ACT_DIM = 52
OBS_V1_DIM = 83
FIXTURE = Path(__file__).parent / "data_fixtures" / "obsv2_fixture.json"


def load_fixture() -> tuple[ObsV2Spec, np.ndarray, dict]:
    with open(FIXTURE) as f:
        fx = json.load(f)
    return ObsV2Spec.from_meta(fx["meta"]), np.asarray(fx["flat"], dtype=np.float32), fx["meta"]


def write_dataset(
    data_dir: Path,
    n_rows: int,
    n_v1_only: int = 0,
    seed: int = 11,
    solo_objective: bool = False,
) -> dict:
    """
    PINNED-contract rows (docs/encoder-v2.md): obs = current v1 83-float ALWAYS,
    obsV2 = real flat v2 encoding, cands random with a learnable signal
    (chosen = argmax(cands[:, 0])). `n_v1_only` extra rows omit obsV2 to
    exercise the skip-and-count path.
    """
    _, flat, meta = load_fixture()
    rng = np.random.default_rng(seed)
    data_dir.mkdir(parents=True, exist_ok=True)
    with open(data_dir / "gen.jsonl", "w") as f:
        for i in range(n_rows + n_v1_only):
            n_cands = int(rng.integers(3, 12))
            cands = rng.random((n_cands, ACT_DIM)).astype(np.float32)
            rec = {
                "obs": rng.random(OBS_V1_DIM).astype(np.float32).round(4).tolist(),
                "cands": cands.round(4).tolist(),
                "chosen": int(np.argmax(cands[:, 0])),
                "ret": float(rng.uniform(-1, 1)),
            }
            if i < n_rows:
                rec["obsV2"] = flat[i % flat.shape[0]].tolist()
                if solo_objective:
                    game = i // 2
                    rec["gameId"] = f"solo-{seed}-{game}"
                    if i % 2 == 1:
                        won = (game % 2) == 0
                        rec.update({
                            "reach30Target": int(won),
                            "reach30Horizon": 30,
                            "endRound": 20 + (game % 9) if won else 30,
                        })
            f.write(json.dumps(rec) + "\n")
    ds_meta = {
        "obs_dim": OBS_V1_DIM,
        "act_dim": ACT_DIM,
        "obs_version": 2,
        "obs_v2": meta,
        "samples": n_rows + n_v1_only,
    }
    with open(data_dir / "meta.json", "w") as f:
        json.dump(ds_meta, f)
    return ds_meta


# ── bc_warmstart_v2 ──────────────────────────────────────────────────────────

def test_bc_dataset_and_meta_validation():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 24, n_v1_only=5)
        spec, act_dim = load_spec_for_dataset(d)
        assert act_dim == ACT_DIM
        # BC reads obsV2 and skips+counts the v1-only rows.
        ds = DecisionDatasetV2(d, spec)
        assert len(ds) == 24
        assert ds.skipped_no_v2 == 5
        assert ds.obs_list[0].shape == (spec.flat_length,)

        with open(d / "meta.json") as f:
            meta = json.load(f)

        # obs_version other than 2 must be refused.
        bad = dict(meta, obs_version=1)
        with open(d / "meta.json", "w") as f:
            json.dump(bad, f)
        try:
            load_spec_for_dataset(d)
            raise AssertionError("accepted obs_version 1")
        except ValueError:
            pass

        # Missing obs_v2 block must be refused (pinned contract).
        bad = {k: v for k, v in meta.items() if k != "obs_v2"}
        with open(d / "meta.json", "w") as f:
            json.dump(bad, f)
        try:
            load_spec_for_dataset(d)
            raise AssertionError("accepted dataset without obs_v2 block")
        except ValueError:
            pass

        # Missing meta.json entirely.
        (d / "meta.json").unlink()
        try:
            load_spec_for_dataset(d)
            raise AssertionError("accepted dataset without meta.json")
        except FileNotFoundError:
            pass


def test_bc_warmstart_end_to_end():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 64)
        out = Path(td) / "weights" / "v2_bc.pt"
        stats = train_bc(
            d, out, epochs=4, batch_size=16, lr=1e-3,
            d_model=64, layers=1, heads=2, seed=0, device=torch.device("cpu"),
        )
        first, last = stats["epochs"][0], stats["epochs"][-1]
        assert last["ce"] < first["ce"], f"BC CE did not decrease: {first['ce']} -> {last['ce']}"
        assert last["acc"] > first["acc"], f"BC accuracy did not improve: {first['acc']} -> {last['acc']}"
        assert out.exists() and Path(stats["manifest"]).exists()

        spec, _, _ = load_fixture()
        model = load_checkpoint(out, spec=spec)
        assert model.d_model == 64 and model.layers == 1
        # The learned signal is "highest candidate feature 0 wins" — the trained
        # model should beat chance on fresh rows with the same rule.
        _, flat, _ = load_fixture()
        rng = np.random.default_rng(99)
        cands = torch.from_numpy(rng.random((16, 8, ACT_DIM)).astype(np.float32))
        mask = torch.ones(16, 8, dtype=torch.bool)
        obs = torch.from_numpy(np.tile(flat, (1, 1))[:16])
        with torch.no_grad():
            logits, _, _ = model.eval()(obs, cands, mask)
        acc = (logits.argmax(dim=-1) == cands[:, :, 0].argmax(dim=-1)).float().mean().item()
        assert acc > 1.5 / 8, f"held-out argmax accuracy {acc:.3f} is at chance"


def test_bc_disjoint_validation_and_multihorizon_critic():
    with tempfile.TemporaryDirectory() as td:
        train_dir = Path(td) / "train"
        val_dir = Path(td) / "val"
        write_dataset(train_dir, 64, seed=21, solo_objective=True)
        write_dataset(val_dir, 32, seed=22, solo_objective=True)
        out = Path(td) / "weights" / "v2_p30.pt"
        stats = train_bc(
            train_dir,
            out,
            epochs=2,
            batch_size=16,
            lr=1e-3,
            d_model=32,
            layers=1,
            heads=2,
            seed=0,
            val_data_dir=val_dir,
            reach30_coef=1.0,
            device=torch.device("cpu"),
        )
        assert stats["val_samples"] == 32
        assert all("val_reach30_nll" in epoch for epoch in stats["epochs"])
        assert set(stats["epochs"][-1]["val_reach30_by_horizon"]) == {"20", "25", "30"}
        model = load_checkpoint(out)
        assert model.reach30_trained
        assert model.reach30_horizons == (20, 25, 30)
        assert model.reach30_horizon == 30


def test_bc_cli_smoke():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 16)
        out = Path(td) / "v2_bc.pt"
        r = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "bc_warmstart_v2.py"),
             "--data", str(d), "--out", str(out), "--epochs", "1",
             "--d-model", "32", "--layers", "1", "--heads", "2", "--device", "cpu"],
            capture_output=True, text=True, timeout=300,
        )
        assert r.returncode == 0, f"bc CLI failed:\n{r.stdout}\n{r.stderr}"
        assert out.exists() and out.with_suffix(".manifest.json").exists()


# ── distill ──────────────────────────────────────────────────────────────────

def test_distill_end_to_end():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 64)
        spec, _, _ = load_fixture()
        teacher = build_model_v2(spec, ACT_DIM, d_model=32, layers=1, heads=2, seed=3)
        teacher_pt = Path(td) / "teacher.pt"
        save_checkpoint(teacher, teacher_pt)

        out_json = Path(td) / "policy_distilled.json"
        stats = distill(
            d, teacher_pt, out_json, epochs=4, batch_size=16, lr=1e-3,
            trunk_hidden=(32, 32), value_hidden=(16,),
            seed=0, device=torch.device("cpu"),
        )
        first, last = stats["epochs"][0], stats["epochs"][-1]
        assert last["kl"] < first["kl"], f"distill KL did not decrease: {first['kl']} -> {last['kl']}"
        assert last["top1_agree"] >= first["top1_agree"], (
            f"teacher/student top-1 agreement regressed: {first['top1_agree']} -> {last['top1_agree']}"
        )

        # Export must be the live-net JSON format.
        with open(out_json) as f:
            exported = json.load(f)
        assert exported["format"] == "arc-cand-scorer-v1"
        assert exported["obs_dim"] == OBS_V1_DIM and exported["act_dim"] == ACT_DIM
        assert exported["trunk_hidden"] == [32, 32] and exported["value_hidden"] == [16]
        assert exported["params"] > 0


def test_distill_refuses_mismatched_teacher():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 8)
        # Teacher trained on a DIFFERENT obs layout (rune cap 9 instead of 8).
        other = ObsV2Spec.from_header([2, 6, 0, 1, 122, 1, 6, 55, 2, 42, 58, 3, 6, 49, 4, 9, 18, 5, 1, 10])
        teacher = build_model_v2(other, ACT_DIM, d_model=32, layers=1, heads=2, seed=0)
        teacher_pt = Path(td) / "teacher.pt"
        save_checkpoint(teacher, teacher_pt)
        try:
            distill(d, teacher_pt, Path(td) / "out.json", epochs=1, device=torch.device("cpu"))
            raise AssertionError("distilled from a teacher with a mismatched obs layout")
        except ValueError:
            pass


def main() -> int:
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
