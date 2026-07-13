"""
Divergence-guard tests (grad clipping, NaN halt+restore, export refusal) for
ml/train.py + ml/ppo.py — the fair-rules league shipped a NaN checkpoint at
gen ~13 before these existed.

Run with pytest if available, or directly (the venv has no pytest):
  ml/.venv/bin/python ml/test_train_guards.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import traceback
from pathlib import Path

os.environ.setdefault("ARC_DEVICE", "cpu")

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch

import train as train_mod
from model import build_model

OBS_DIM = 8
ACT_DIM = 4
N_CANDS = 3


def make_traj_dataset(d: Path, n_games: int = 30, steps: int = 3, seed: int = 0) -> None:
    rng = np.random.default_rng(seed)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "traj.jsonl", "w") as f:
        for g in range(n_games):
            for t in range(steps):
                cands = rng.standard_normal((N_CANDS, ACT_DIM))
                chosen = int(rng.integers(0, N_CANDS))
                r = 1.0 if chosen == int(np.argmax(cands[:, 0])) else 0.0
                row = {
                    "obs": rng.standard_normal(OBS_DIM).tolist(),
                    "cands": cands.tolist(),
                    "chosen": chosen,
                    "ret": r,
                    "gameId": f"g{g}",
                    "stepIdx": t,
                    "rStep": r,
                    "done": t == steps - 1,
                    "logpOld": math.log(1.0 / N_CANDS),
                    "vPred": 0.5,
                }
                if row["done"]:
                    row["placement"] = 1 if r else 4
                f.write(json.dumps(row) + "\n")
    (d / "meta.json").write_text(json.dumps({"obs_dim": OBS_DIM, "act_dim": ACT_DIM}))


def _weights_all_finite(path: Path) -> bool:
    w = json.loads(path.read_text())  # would raise on bare NaN tokens already
    def walk(x):
        if isinstance(x, list):
            return all(walk(v) for v in x)
        if isinstance(x, (int, float)):
            return math.isfinite(x)
        return True
    return all(
        walk(w[k])
        for k in ("trunk", "value", "farm_value", "route_mode", "reward_pick", "reach30")
        if k in w
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_export_refuses_poisoned_model():
    model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    with torch.no_grad():
        model.trunk[0].weight[0, 0] = float("nan")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "poisoned.json"
        try:
            train_mod.export_weights(model, OBS_DIM, ACT_DIM, out)
        except ValueError as e:
            assert "non-finite" in str(e) and "trunk" in str(e), e
        else:
            raise AssertionError("export_weights wrote a NaN checkpoint")
        assert not out.exists(), "corrupt file reached disk"

    # Inf must be refused too, and assert_finite_weights is the same guard the
    # v2 save path (train.export_model) runs before model_v2.save_checkpoint.
    model2 = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    with torch.no_grad():
        model2.value_head[0].bias[0] = float("inf")
    try:
        train_mod.assert_finite_weights(model2, "save_checkpoint")
    except ValueError as e:
        assert "value_head" in str(e), e
    else:
        raise AssertionError("assert_finite_weights accepted inf")


def test_awr_explosion_halts_with_finite_export():
    """lr so large that weights overflow even with clipping: training must halt
    gracefully and the exported checkpoint must be the restored finite snapshot."""
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "w" / "p.json"
        make_traj_dataset(d, seed=1)
        history = train_mod.train(
            data_dir=d, out_path=out, epochs=4, batch_size=32, mode="awr",
            warm_start=False, lr=1e18, max_grad_norm=1.0,
        )
        assert out.exists()
        assert _weights_all_finite(out), "exported weights contain non-finite values"
        assert len(history) < 4, "expected an early halt at lr=1e18"
    print(f"awr explosion: halted after {len(history)} finite epoch(s), export finite")


def test_ppo_explosion_halts_with_finite_export():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "w" / "p.json"
        make_traj_dataset(d, seed=2)
        history = train_mod.train(
            data_dir=d, out_path=out, epochs=4, batch_size=32, mode="ppo",
            warm_start=False, lr=1e18, max_grad_norm=1.0,
        )
        assert out.exists()
        assert _weights_all_finite(out), "exported weights contain non-finite values"
        assert len(history) < 4, "expected an early PPO halt at lr=1e18"
    print(f"ppo explosion: halted after {len(history)} finite epoch(s), export finite")


def _trunk0(path: Path) -> np.ndarray:
    return np.asarray(json.loads(path.read_text())["trunk"][0]["W"], dtype=np.float64)


def test_grad_clipping_is_wired_into_the_step():
    """Deterministic proof that clip_grad_norm_ actually gates the update:
    identically-seeded runs at the same lr move weights ~not-at-all under a
    near-zero clip norm and substantially with clipping off."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        make_traj_dataset(d, seed=3)
        runs = {}
        for name, (lr, clip) in {
            "init": (1e-12, 0.0),   # effectively frozen: the init-weights reference
            "clipped": (0.5, 1e-8),
            "free": (0.5, 0.0),
        }.items():
            torch.manual_seed(0)  # same init AND same shuffle order per run
            out = Path(td) / "w" / f"{name}.json"
            h = train_mod.train(
                data_dir=d, out_path=out, epochs=2, batch_size=32, mode="awr",
                warm_start=False, lr=lr, max_grad_norm=clip,
            )
            assert len(h) == 2 and _weights_all_finite(out)
            runs[name] = _trunk0(out)
        d_clip = float(np.abs(runs["clipped"] - runs["init"]).mean())
        d_free = float(np.abs(runs["free"] - runs["init"]).mean())
    assert d_free > 100 * max(d_clip, 1e-12), (d_clip, d_free)
    print(f"clip wiring: mean|dW| clipped={d_clip:.2e} vs unclipped={d_free:.2e}")


def test_bc_warmstart_save_path_guard():
    """bc_warmstart_v2 has no halt/restore loop — a diverged run must RAISE at
    save_checkpoint instead of writing a NaN .pt; a sane run still completes."""
    from bc_warmstart_v2 import train_bc
    from test_train_v2 import write_dataset

    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 24)  # pinned paired rows (obs v1 + obsV2)
        out = Path(td) / "w" / "bc.pt"
        try:
            train_bc(d, out, epochs=2, batch_size=8, lr=1e18, d_model=32, layers=1,
                     heads=2, seed=0, max_grad_norm=1.0, device=torch.device("cpu"))
        except ValueError as e:
            assert "non-finite" in str(e), e
        else:
            raise AssertionError("bc_warmstart_v2 wrote a NaN checkpoint")
        assert not out.exists() and not out.with_suffix(".manifest.json").exists()

        # Default clipping doesn't break a normal run; the checkpoint loads.
        from model_v2 import load_checkpoint
        out2 = Path(td) / "w" / "bc_ok.pt"
        stats = train_bc(d, out2, epochs=1, batch_size=8, lr=3e-4, d_model=32, layers=1,
                         heads=2, seed=0, device=torch.device("cpu"))
        assert out2.exists() and math.isfinite(stats["epochs"][0]["ce"])
        load_checkpoint(out2)
    print("bc save path: explosion raises, nothing on disk; normal run clean")


def test_distill_save_path_guard():
    """distill exports through train.export_weights, so a diverged student must
    raise there — never ship a NaN arc-cand-scorer-v1 JSON."""
    from distill import distill
    from model_v2 import build_model_v2, save_checkpoint
    from test_train_v2 import load_fixture, write_dataset

    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        write_dataset(d, 24)  # pinned paired rows (obs v1 + obsV2)
        spec, _, _ = load_fixture()
        teacher = build_model_v2(spec, 52, d_model=32, layers=1, heads=2, seed=3)
        teacher_pt = Path(td) / "teacher.pt"
        save_checkpoint(teacher, teacher_pt)
        out = Path(td) / "w" / "student.json"
        try:
            distill(d, teacher_pt, out, epochs=2, batch_size=8, lr=1e18,
                    trunk_hidden=(32,), value_hidden=(16,), seed=0,
                    max_grad_norm=1.0, device=torch.device("cpu"))
        except ValueError as e:
            assert "non-finite" in str(e), e
        else:
            raise AssertionError("distill exported a NaN student JSON")
        assert not out.exists()
    print("distill save path: explosion raises at export_weights, nothing on disk")


def main() -> int:
    tests = [
        test_export_refuses_poisoned_model,
        test_awr_explosion_halts_with_finite_export,
        test_ppo_explosion_halts_with_finite_export,
        test_grad_clipping_is_wired_into_the_step,
        test_bc_warmstart_save_path_guard,
        test_distill_save_path_guard,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
