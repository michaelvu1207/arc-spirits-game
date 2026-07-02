"""
End-to-end tests for --model v2 trainer integration (train.py + model_v2.py).

(ml/test_train_v2.py was already taken by the bc_warmstart_v2/distill tests,
hence the _integration suffix.)

Synthetic datasets are built on the 56 REAL arc-obs-v2 rows from
ml/data_fixtures/obsv2_fixture.json (obs pool) with synthesized
cands/chosen/ret + PPO trajectory fields on top.

Run with pytest if available, or directly (the venv has no pytest):
  ml/.venv/bin/python ml/test_train_v2_integration.py
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
from model import load_dims_from_meta
from model_v2 import load_checkpoint
from obs_v2 import ObsV2Spec
from ppo import load_trajectory_buffer, parse_placement_rewards

FIXTURE_PATH = Path(__file__).parent / "data_fixtures" / "obsv2_fixture.json"
ACT_DIM = 52
OBS_V1_DIM = 62
N_CANDS = 3

_fixture_cache: dict | None = None

# Small model + few rows: these tests exercise wiring/contracts, not capacity.
V2_KW = dict(model_version="v2", v2_d_model=32, v2_layers=1, v2_heads=2)


def fixture() -> dict:
    global _fixture_cache
    if _fixture_cache is None:
        _fixture_cache = json.loads(FIXTURE_PATH.read_text())
    return _fixture_cache


def make_v2_dataset(
    d: Path,
    n_games: int = 50,
    steps: int = 4,
    seed: int = 0,
    full_meta: bool = True,
    n_legacy: int = 0,
) -> None:
    """
    PAIRED trajectory rows (authoritative contract, commit 2b4ef69): `obs` = a
    62-float v1 stub AND `obsV2` = a real flat arc-obs-v2 array; usable by
    awr/alphazero AND ppo. Each game reuses ONE fixture obsV2 row for all its
    steps and gets placement = (pool_idx % 4) + 1, so the placement target is
    a deterministic function of the obs (overfit-able). The policy rule is
    candidate-based: the candidate with the largest first feature yields rStep=1.
    n_legacy appends old-format v1-only rows (no obsV2) that --model v2 must skip.
    """
    fx = fixture()
    pool = fx["flat"]
    rng = np.random.default_rng(seed)
    d.mkdir(parents=True, exist_ok=True)
    rows = []
    for g in range(n_games):
        pool_idx = g % len(pool)
        obs_v2 = pool[pool_idx]
        placement = (pool_idx % 4) + 1
        for t in range(steps):
            cands = rng.standard_normal((N_CANDS, ACT_DIM))
            good = int(np.argmax(cands[:, 0]))
            chosen = int(rng.integers(0, N_CANDS))
            r = 1.0 if chosen == good else 0.0
            done = t == steps - 1
            row = {
                "obs": rng.standard_normal(OBS_V1_DIM).round(4).tolist(),
                "obsV2": obs_v2,
                "cands": cands.tolist(),
                "chosen": chosen,
                "ret": r,
                "gameId": f"g{g}",
                "stepIdx": t,
                "rStep": r,
                "done": done,
                "logpOld": math.log(1.0 / N_CANDS),
                "vPred": 0.5,
            }
            if done:
                row["placement"] = placement
            rows.append(row)
    for _ in range(n_legacy):
        rows.append({
            "obs": rng.standard_normal(OBS_V1_DIM).round(4).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": int(rng.integers(0, N_CANDS)),
            "ret": float(rng.uniform(0.0, 1.0)),
        })
    with open(d / "traj.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    if full_meta:
        # In-repo convention (bc_warmstart_v2.py): obsV2Meta under `obs_v2`,
        # obs_dim = the v1 width of the `obs` field.
        meta = {"obs_dim": OBS_V1_DIM, "act_dim": ACT_DIM, "obs_v2": fx["meta"]}
    else:
        # Minimal meta: layout must come from the rows' self-describing obsV2 header.
        meta = {"obs_version": 2, "act_dim": ACT_DIM}
    (d / "meta.json").write_text(json.dumps(meta))


def _assert_finite(history: list[dict]) -> None:
    for i, h in enumerate(history):
        for k, v in h.items():
            assert math.isfinite(v), (i, k, v)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_resolve_spec_meta_and_header_paths():
    fx = fixture()
    with tempfile.TemporaryDirectory() as td:
        d_full = Path(td) / "full"
        d_min = Path(td) / "minimal"
        make_v2_dataset(d_full, n_games=2, steps=1, full_meta=True)
        make_v2_dataset(d_min, n_games=2, steps=1, full_meta=False)
        spec_full, act_full = train_mod.resolve_v2_spec(d_full)
        spec_min, act_min = train_mod.resolve_v2_spec(d_min)
    assert spec_full.header == spec_min.header == fx["meta"]["flatHeader"]
    assert spec_full.flat_length == fx["meta"]["flatLength"] == 3419
    assert act_full == act_min == ACT_DIM
    # Direct spec constructors agree too.
    assert ObsV2Spec.from_meta(fx["meta"]).header == ObsV2Spec.from_flat(fx["flat"][0]).header


def test_awr_v2_end_to_end_loss_decreases():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "weights" / "v2.pt"
        make_v2_dataset(d, n_games=50, steps=4, seed=1)
        history = train_mod.train(
            data_dir=d, out_path=out, epochs=4, batch_size=64, mode="awr",
            warm_start=False, placement_coef=0.1, **V2_KW,
        )
        assert len(history) == 4
        _assert_finite(history)
        assert history[-1]["policy_loss"] < history[0]["policy_loss"], history
        assert history[0]["placement_loss"] > 0, "placement aux never fired"
        assert history[-1]["placement_loss"] < history[0]["placement_loss"], history
        assert out.exists() and out.with_suffix(".manifest.json").exists()
        manifest = json.loads(out.with_suffix(".manifest.json").read_text())
        assert manifest["format"] == "arc-entity-scorer-v2"
        assert manifest["obs_flat_len"] == 3419 and manifest["act_dim"] == ACT_DIM
    print(
        f"awr v2: policy_loss {history[0]['policy_loss']:.4f} -> {history[-1]['policy_loss']:.4f}, "
        f"placement_loss {history[0]['placement_loss']:.4f} -> {history[-1]['placement_loss']:.4f}"
    )


def test_ppo_v2_end_to_end():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "weights" / "v2_ppo.pt"
        make_v2_dataset(d, n_games=50, steps=4, seed=2)
        history = train_mod.train(
            data_dir=d, out_path=out, epochs=4, batch_size=64, mode="ppo",
            warm_start=False, placement_coef=0.1, **V2_KW,
        )
        assert len(history) == 4
        _assert_finite(history)
        # Value regression on a fixed buffer must improve; the PPO ratio path ran
        # (approx_kl/clip_frac recorded) and the placement aux loss decreased.
        assert history[-1]["value_loss"] < history[0]["value_loss"], history
        assert history[-1]["placement_loss"] < history[0]["placement_loss"], history
        assert history[-1]["mean_p_chosen"] >= history[0]["mean_p_chosen"] - 0.01, history
        assert out.exists() and out.with_suffix(".manifest.json").exists()
    print(
        f"ppo v2: value_loss {history[0]['value_loss']:.4f} -> {history[-1]['value_loss']:.4f}, "
        f"mean_p_chosen {history[0]['mean_p_chosen']:.3f} -> {history[-1]['mean_p_chosen']:.3f}"
    )


def test_checkpoint_save_and_init_from_resume():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out1 = Path(td) / "w" / "first.pt"
        out2 = Path(td) / "w" / "second.pt"
        make_v2_dataset(d, n_games=20, steps=2, seed=3)
        train_mod.train(
            data_dir=d, out_path=out1, epochs=1, batch_size=64, mode="awr",
            warm_start=False, **V2_KW,
        )

        # build_policy_model_v2 with --init-from must reproduce the checkpoint exactly.
        model, spec, act_dim = train_mod.build_policy_model_v2(
            d, torch.device("cpu"), Path(td) / "w" / "missing.pt", out1, True, 32, 1, 2
        )
        ref = load_checkpoint(out1, torch.device("cpu"))
        for (ka, va), (kb, vb) in zip(
            sorted(model.state_dict().items()), sorted(ref.state_dict().items())
        ):
            assert ka == kb and torch.equal(va, vb), f"resume mismatch at {ka}"
        assert spec.flat_length == 3419 and act_dim == ACT_DIM

        # Full resume run: --init-from out1, exporting to a new path.
        history = train_mod.train(
            data_dir=d, out_path=out2, epochs=1, batch_size=64, mode="awr",
            warm_start=True, init_from=out1, **V2_KW,
        )
        _assert_finite(history)
        assert out2.exists() and out2.with_suffix(".manifest.json").exists()


def test_paired_rows_games_files_and_legacy_skips():
    """Paired-row contract + hygiene: v2 reads obsV2 and skips v1-only rows;
    v1 reads obs from the same files; games-*.jsonl summaries are ignored
    everywhere, including load_dims_from_meta's no-meta fallback."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        make_v2_dataset(d, n_games=10, steps=2, seed=5, n_legacy=3)
        # Actor pool per-game summary shard — sorts before traj.jsonl, has no obs.
        (d / "games-0.jsonl").write_text('{"seed": 1, "finished": true, "samples": 2}\n')

        ds_v2 = train_mod.DecisionDataset(d, obs_key="obsV2")
        assert len(ds_v2) == 20 and ds_v2.n_missing_obs == 3, (len(ds_v2), ds_v2.n_missing_obs)
        assert ds_v2.obs_list[0].shape == (3419,)

        ds_v1 = train_mod.DecisionDataset(d, obs_key="obs")
        assert len(ds_v1) == 23 and ds_v1.n_missing_obs == 0  # legacy rows train in v1
        assert ds_v1.obs_list[0].shape == (OBS_V1_DIM,)

        buf = load_trajectory_buffer(
            d, gamma=0.997, gae_lambda=0.95,
            placement_rewards=parse_placement_rewards("1.0,0.3,-0.3,-1.0"),
            obs_key="obsV2",
        )
        assert len(buf) == 20 and buf.obs.shape[1] == 3419

        # No meta.json: the dims fallback must skip games-0.jsonl (it sorts first).
        (d / "meta.json").unlink()
        obs_dim, act_dim = load_dims_from_meta(d)
        assert (obs_dim, act_dim) == (OBS_V1_DIM, ACT_DIM), (obs_dim, act_dim)


def test_v1_regression_and_format_guards():
    rng = np.random.default_rng(4)
    rows = []
    for _ in range(50):
        rows.append({
            "obs": rng.standard_normal(8).tolist(),
            "cands": rng.standard_normal((N_CANDS, 4)).tolist(),
            "chosen": int(rng.integers(0, N_CANDS)),
            "ret": float(rng.uniform(0.0, 1.0)),
        })
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        d.mkdir(parents=True)
        with open(d / "old.jsonl", "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        (d / "meta.json").write_text(json.dumps({"obs_dim": 8, "act_dim": 4}))

        out = Path(td) / "w" / "policy.json"
        history = train_mod.train(
            data_dir=d, out_path=out, epochs=1, batch_size=32, mode="awr", warm_start=False
        )
        _assert_finite(history)
        assert out.exists()
        assert json.loads(out.read_text())["format"] == "arc-cand-scorer-v1"

        # Format guards: v2 never writes JSON, v1 never writes .pt.
        for kwargs, bad_out in [
            (dict(model_version="v2"), Path(td) / "x.json"),
            (dict(model_version="v1"), Path(td) / "x.pt"),
            (dict(model_version="v2", init_from=out), Path(td) / "x.pt"),
        ]:
            try:
                train_mod.train(data_dir=d, out_path=bad_out, epochs=1, **kwargs)
            except ValueError:
                pass
            else:
                raise AssertionError(f"expected ValueError for {kwargs} out={bad_out}")


def main() -> int:
    if not FIXTURE_PATH.exists():
        print(f"fixture not found: {FIXTURE_PATH}")
        return 1
    tests = [
        test_resolve_spec_meta_and_header_paths,
        test_awr_v2_end_to_end_loss_decreases,
        test_ppo_v2_end_to_end,
        test_checkpoint_save_and_init_from_resume,
        test_paired_rows_games_files_and_legacy_skips,
        test_v1_regression_and_format_guards,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}\n")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
