"""
Synthetic end-to-end tests for the PPO trainer (ppo.py + train.py --mode ppo).

Run with pytest if available, or directly (the venv has no pytest):
  ml/.venv/bin/python ml/test_ppo.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import traceback
from pathlib import Path

os.environ.setdefault("ARC_DEVICE", "cpu")  # deterministic + fast for tiny nets

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch

import train as train_mod
import verify_export
from model import build_model
from ppo import compute_gae, load_trajectory_buffer, parse_placement_rewards, train_ppo

OBS_DIM = 8
ACT_DIM = 4
N_CANDS = 3

PLACEMENT_REWARDS = parse_placement_rewards("1.0,0.3,-0.3,-1.0")


def _write_rows(d: Path, rows: list[dict]) -> None:
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "traj.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    (d / "meta.json").write_text(json.dumps({"obs_dim": OBS_DIM, "act_dim": ACT_DIM}))


def make_traj_dataset(d: Path, n_games: int = 100, steps: int = 4, seed: int = 0) -> None:
    """Bandit-like trajectories: the candidate with the largest first feature is
    'good' (rStep=1, else 0), the behavior policy is uniform, and placement is
    1 or 4 depending on whether the majority of picks were good."""
    rng = np.random.default_rng(seed)
    rows: list[dict] = []
    for g in range(n_games):
        n_good = 0
        for t in range(steps):
            obs = rng.standard_normal(OBS_DIM)
            cands = rng.standard_normal((N_CANDS, ACT_DIM))
            good = int(np.argmax(cands[:, 0]))
            chosen = int(rng.integers(0, N_CANDS))
            r = 1.0 if chosen == good else 0.0
            n_good += int(chosen == good)
            done = t == steps - 1
            row = {
                "obs": obs.tolist(),
                "cands": cands.tolist(),
                "chosen": chosen,
                "ret": r,  # legacy field: trajectory rows are a superset of old rows
                "gameId": f"g{g}",
                "stepIdx": t,
                "rStep": r,
                "done": done,
                "logpOld": math.log(1.0 / N_CANDS),
                "vPred": 0.5,
            }
            if done:
                row["placement"] = 1 if 2 * n_good >= steps else 4
            rows.append(row)
    # Shuffle rows across games to prove the loader re-orders by gameId/stepIdx.
    rng.shuffle(rows)
    _write_rows(d, rows)


def _mean_prob_of(model, buffer, target_idx: np.ndarray) -> float:
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(len(buffer)):
            obs = torch.from_numpy(buffer.obs[i]).float()
            cands = torch.from_numpy(buffer.cands[i]).float()
            _, probs, _ = model.score_single(obs, cands)
            out.append(float(probs[0, target_idx[i]]))
    return float(np.mean(out))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_gae_matches_hand_computed_fixture():
    # 3-step episode, gamma=0.9, lam=0.8, V=[0.5,0.4,0.3], r=[1,0,2], done on last:
    #   delta_2 = 2 + 0            - 0.3 = 1.7      A_2 = 1.7
    #   delta_1 = 0 + 0.9*0.3      - 0.4 = -0.13    A_1 = -0.13 + 0.72*1.7   = 1.094
    #   delta_0 = 1 + 0.9*0.4      - 0.5 = 0.86     A_0 = 0.86  + 0.72*1.094 = 1.64768
    #   returns = A + V = [2.14768, 1.494, 2.0]
    adv, ret = compute_gae(
        rewards=[1.0, 0.0, 2.0],
        values=[0.5, 0.4, 0.3],
        dones=[False, False, True],
        gamma=0.9,
        lam=0.8,
    )
    assert np.allclose(adv, [1.64768, 1.094, 1.7], atol=1e-9), adv
    assert np.allclose(ret, [2.14768, 1.494, 2.0], atol=1e-9), ret


def test_gae_truncated_episode_bootstraps_last_value():
    # Single non-terminal step: delta = 0 + 0.9*1.0 - 0.5 = 0.4
    adv, ret = compute_gae([0.0], [0.5], [False], gamma=0.9, lam=0.8, last_value=1.0)
    assert np.allclose(adv, [0.4]), adv
    assert np.allclose(ret, [0.9]), ret


def test_placement_reward_lands_on_terminal_step():
    # 2-step game, rStep=0, vPred=0, placement=1 -> terminal reward +1.0.
    # With gamma=lam=1 the return at both steps is exactly 1.0.
    rng = np.random.default_rng(1)
    rows = []
    for t in range(2):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0,
            "ret": 0.0,
            "gameId": "g0",
            "stepIdx": t,
            "rStep": 0.0,
            "done": t == 1,
            "logpOld": math.log(1.0 / N_CANDS),
            "vPred": 0.0,
        })
    rows[-1]["placement"] = 1
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        buf = load_trajectory_buffer(d, gamma=1.0, gae_lambda=1.0,
                                     placement_rewards=PLACEMENT_REWARDS)
    assert len(buf) == 2
    assert np.allclose(buf.returns, [1.0, 1.0]), buf.returns
    assert np.allclose(buf.advantages, [1.0, 1.0]), buf.advantages


def test_ppo_improves_good_action_prob():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        make_traj_dataset(d)
        buf = load_trajectory_buffer(d, gamma=0.997, gae_lambda=0.95,
                                     placement_rewards=PLACEMENT_REWARDS)
        assert len(buf) == 400
        good = np.array([int(np.argmax(c[:, 0])) for c in buf.cands])
        model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
        p_before = _mean_prob_of(model, buf, good)
        train_ppo(
            model, buf, torch.device("cpu"),
            epochs=8, batch_size=64, lr=1e-3, clip_eps=0.2,
            policy_coef=1.0, value_coef=0.5, entropy_coef=0.01,
            entropy_anneal=False, value_clip_eps=0.0, target_kl=None, seed=0,
        )
        p_after = _mean_prob_of(model, buf, good)
    print(f"good-action prob: before={p_before:.3f} after={p_after:.3f}")
    assert p_after > p_before + 0.05, (p_before, p_after)
    assert p_after > 0.38, p_after  # uniform baseline is 1/3


def test_train_cli_ppo_end_to_end_and_export_roundtrip():
    torch.manual_seed(0)
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "weights" / "policy_ppo.json"
        make_traj_dataset(d, n_games=30, steps=3, seed=2)
        train_mod.train(data_dir=d, out_path=out, epochs=2, batch_size=64,
                        mode="ppo", warm_start=False)
        assert out.exists()
        payload = json.loads(out.read_text())
        assert payload["format"] == "arc-cand-scorer-v1"
        # Round-trip the export through the existing numpy-vs-torch verifier.
        assert verify_export.verify(out, d, n_checks=5)


def test_old_format_rows_still_train_in_awr_mode():
    # Backward compat both ways: old rows (no PPO fields) train under awr,
    # and new trajectory rows still load in DecisionDataset.
    rng = np.random.default_rng(3)
    rows = []
    for _ in range(50):
        cands = rng.standard_normal((N_CANDS, ACT_DIM))
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": cands.tolist(),
            "chosen": int(rng.integers(0, N_CANDS)),
            "ret": float(rng.uniform(0.0, 1.0)),
        })
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "weights" / "policy_awr.json"
        _write_rows(d, rows)
        train_mod.train(data_dir=d, out_path=out, epochs=1, batch_size=32,
                        mode="awr", warm_start=False)
        assert out.exists()

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        make_traj_dataset(d, n_games=10, steps=3, seed=4)
        ds = train_mod.DecisionDataset(d)
        assert len(ds) == 30


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
