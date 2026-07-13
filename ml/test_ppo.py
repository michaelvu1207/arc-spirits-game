"""
Synthetic end-to-end tests for the PPO trainer (ppo.py + train.py --mode ppo).

Run with pytest if available, or directly (the venv has no pytest):
  ml/.venv/bin/python ml/test_ppo.py
"""

from __future__ import annotations

import json
import contextlib
import io
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
from ppo import (
    behavior_log_probs,
    compute_discounted_returns,
    compute_gae,
    load_trajectory_buffer,
    normalize_policy_advantages,
    parse_placement_rewards,
    train_ppo,
)

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


def test_discounted_returns_propagate_terminal_outcome_without_gae_lambda():
    ret = compute_discounted_returns(
        rewards=[0.0, 0.0, 1.0],
        dones=[False, False, True],
        gamma=1.0,
    )
    assert np.array_equal(ret, [1.0, 1.0, 1.0]), ret


def test_strategic_mc_blend_reaches_early_strategy_but_not_tactical_rows():
    rng = np.random.default_rng(1001)
    rows = []
    for t in range(3):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0,
            "gameId": "strategic-g0",
            "stepIdx": t,
            "rStep": 0.0,
            "done": t == 2,
            "policyMask": 1,
            "logpOld": math.log(1.0 / N_CANDS),
            "behaviorMask": [1, 1, 1],
            "behaviorTemperature": 1.0,
            "vPred": 0.0,
            "strategic": 1 if t == 0 else 0,
        })
    rows[-1]["placement"] = 1
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        ordinary = load_trajectory_buffer(
            d, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS,
            strategic_mc_coef=0.0,
        )
        strategic = load_trajectory_buffer(
            d, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS,
            strategic_mc_coef=1.0, strategic_mc_gamma=1.0,
        )
    # GAE reaches the first decision through (gamma*lambda)^2 = 0.2025.
    assert math.isclose(float(ordinary.advantages[0]), 0.2025, abs_tol=1e-6)
    # Full-return credit gives the strategic first decision the complete terminal outcome.
    assert math.isclose(float(strategic.advantages[0]), 1.0, abs_tol=1e-6)
    # The tactical middle decision remains ordinary GAE.
    assert math.isclose(
        float(strategic.advantages[1]), float(ordinary.advantages[1]), abs_tol=1e-7
    )
    assert np.array_equal(strategic.strategic_mask, [True, False, False])


def test_strategic_mc_zero_is_bit_identical_and_truncated_episode_does_not_blend():
    rng = np.random.default_rng(1002)
    base_rows = []
    for t in range(2):
        base_rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0,
            "gameId": "truncated-g0",
            "stepIdx": t,
            "rStep": 0.25 if t == 0 else 0.0,
            "done": False,
            "policyMask": 1,
            "logpOld": math.log(1.0 / N_CANDS),
            "behaviorMask": [1, 1, 1],
            "behaviorTemperature": 1.0,
            "vPred": 0.4,
        })
    strategic_rows = [{**row, "strategic": 1} for row in base_rows]
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        legacy_dir = root / "legacy"
        strategic_dir = root / "strategic"
        _write_rows(legacy_dir, base_rows)
        _write_rows(strategic_dir, strategic_rows)
        legacy = load_trajectory_buffer(
            legacy_dir, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS,
            strategic_mc_coef=0.0,
        )
        zero = load_trajectory_buffer(
            strategic_dir, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS,
            strategic_mc_coef=0.0,
        )
        truncated = load_trajectory_buffer(
            strategic_dir, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS,
            strategic_mc_coef=1.0,
        )
    assert np.array_equal(legacy.advantages, zero.advantages)
    assert np.array_equal(legacy.returns, zero.returns)
    assert np.array_equal(zero.advantages, truncated.advantages)
    assert np.array_equal(zero.returns, truncated.returns)


def test_strategic_outcome_credit_uses_pure_placement_baseline_only():
    rng = np.random.default_rng(1003)
    probs = [0.1, 0.2, 0.3, 0.4]
    rows = []
    for t in range(3):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0,
            "gameId": "outcome-g0",
            "stepIdx": t,
            "rStep": 0.25 if t == 1 else 0.0,
            "done": t == 2,
            "policyMask": 1,
            "logpOld": math.log(1.0 / N_CANDS),
            "behaviorMask": [1, 1, 1],
            "behaviorTemperature": 1.0,
            "vPred": 0.0,
            "strategic": 1 if t == 0 else 0,
            "placementProbs": probs,
        })
    rows[-1]["placement"] = 1
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        ordinary = load_trajectory_buffer(
            d, gamma=0.9, gae_lambda=0.5, placement_rewards=PLACEMENT_REWARDS
        )
        outcome = load_trajectory_buffer(
            d,
            gamma=0.9,
            gae_lambda=0.5,
            placement_rewards=PLACEMENT_REWARDS,
            strategic_outcome_coef=1.0,
        )
    baseline = float(np.dot(probs, PLACEMENT_REWARDS))
    assert math.isclose(float(outcome.advantages[0]), 1.0 - baseline, abs_tol=1e-6)
    assert math.isclose(
        float(outcome.advantages[1]), float(ordinary.advantages[1]), abs_tol=1e-7
    )
    # The tactical critic is not trained toward the pure outcome target.
    assert np.array_equal(outcome.returns, ordinary.returns)
    assert bool(outcome.placement_prob_mask.all())
    assert np.allclose(outcome.placement_probs[0], probs)


def test_strategic_outcome_credit_requires_recorded_behavior_outcome_head():
    rng = np.random.default_rng(1004)
    row = {
        "obs": rng.standard_normal(OBS_DIM).tolist(),
        "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
        "chosen": 0,
        "gameId": "legacy-outcome-g0",
        "stepIdx": 0,
        "rStep": 0.2,
        "done": True,
        "policyMask": 1,
        "logpOld": math.log(1.0 / N_CANDS),
        "behaviorMask": [1, 1, 1],
        "behaviorTemperature": 1.0,
        "vPred": 0.0,
        "strategic": 1,
        "placement": 1,
    }
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, [row])
        ordinary = load_trajectory_buffer(
            d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
        )
        missing = load_trajectory_buffer(
            d,
            gamma=1.0,
            gae_lambda=1.0,
            placement_rewards=PLACEMENT_REWARDS,
            strategic_outcome_coef=1.0,
        )
    assert np.array_equal(missing.advantages, ordinary.advantages)
    assert not bool(missing.placement_prob_mask.any())


def test_strategic_credit_modes_are_mutually_exclusive():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, _win_row(12))
        try:
            load_trajectory_buffer(
                d,
                gamma=1.0,
                gae_lambda=1.0,
                placement_rewards=PLACEMENT_REWARDS,
                strategic_mc_coef=0.5,
                strategic_outcome_coef=0.5,
            )
        except ValueError as exc:
            assert "mutually exclusive" in str(exc)
        else:
            raise AssertionError("incompatible strategic credit modes were accepted")


def test_strategic_and_tactical_advantages_normalize_separately():
    advantages = np.array([10.0, 20.0, 1.0, 3.0], dtype=np.float32)
    policy = np.array([True, True, True, True])
    strategic = np.array([True, True, False, False])
    grouped = normalize_policy_advantages(advantages, policy, strategic)
    assert np.allclose(grouped, [-1.0, 1.0, -1.0, 1.0]), grouped


def test_v1_size_controls_parse_and_build_explicit_architecture():
    assert train_mod.parse_hidden_sizes("256, 128") == (256, 128)
    try:
        train_mod.parse_hidden_sizes("128,0")
    except Exception as exc:
        assert "positive integers" in str(exc)
    else:
        raise AssertionError("zero-width layer was accepted")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        model = train_mod.build_policy_model(
            OBS_DIM,
            ACT_DIM,
            torch.device("cpu"),
            td_path / "new-policy.json",
            init_from=None,
            warm_start=False,
            trunk_hidden=(32, 16),
            value_hidden=(12,),
        )
        # A checkpoint whose first layer matches but deeper layer differs used to
        # leave a partially copied model after reporting "skipped (mismatch)".
        source = build_model(
            OBS_DIM,
            ACT_DIM,
            torch.device("cpu"),
            trunk_hidden=(32, 32),
            value_hidden=(12,),
        )
        checkpoint = td_path / "source.json"
        train_mod.export_weights(source, OBS_DIM, ACT_DIM, checkpoint)
        torch.manual_seed(123)
        expected_fresh = build_model(
            OBS_DIM,
            ACT_DIM,
            torch.device("cpu"),
            trunk_hidden=(32, 16),
            value_hidden=(12,),
        )
        torch.manual_seed(123)
        mismatched = train_mod.build_policy_model(
            OBS_DIM,
            ACT_DIM,
            torch.device("cpu"),
            td_path / "different-out.json",
            init_from=checkpoint,
            warm_start=True,
            trunk_hidden=(32, 16),
            value_hidden=(12,),
        )
    assert model.trunk_hidden == (32, 16)
    assert model.value_hidden == (12,)
    assert all(
        torch.equal(actual, expected)
        for actual, expected in zip(mismatched.parameters(), expected_fresh.parameters())
    )


def test_behavior_temperature_and_filter_give_unit_ratio_at_update_start():
    """The learner must reconstruct the actor's filtered, temperature-scaled softmax exactly."""
    torch.manual_seed(11)
    model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    obs = torch.randn(1, OBS_DIM)
    cands = torch.randn(1, N_CANDS, ACT_DIM)
    mask = torch.tensor([[True, False, True]])
    temperature = torch.tensor([0.35])
    chosen = torch.tensor([2])

    with torch.no_grad():
        logits, _, _ = model(obs, cands, mask)
        log_probs = behavior_log_probs(logits, mask, temperature)
        logp_old = log_probs.gather(1, chosen.unsqueeze(1)).squeeze(1).clone()
        ratio = torch.exp(
            behavior_log_probs(logits, mask, temperature)
            .gather(1, chosen.unsqueeze(1))
            .squeeze(1)
            - logp_old
        )

        valid_logits = logits[0, [0, 2]] / temperature[0]
        expected = torch.log_softmax(valid_logits, dim=0)[1]

    assert ratio.item() == 1.0
    assert torch.equal(logp_old[0], expected)
    assert torch.isneginf(log_probs[0, 1])


def test_loader_preserves_behavior_temperature_and_filter_and_rejects_bad_support():
    rng = np.random.default_rng(13)
    base = {
        "obs": rng.standard_normal(OBS_DIM).tolist(),
        "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
        "ret": 0.0,
        "gameId": "g0",
        "rStep": 0.0,
        "done": True,
        "logpOld": -0.25,
        "vPred": 0.0,
        "behaviorTemperature": 0.35,
        "behaviorMask": [1, 0, 1],
        "farmValue": 0.7,
        "rewardPi": [0.2, 0.3, 0.5],
        "routeMode": 1.0,
    }
    valid = {**base, "stepIdx": 0, "chosen": 2}
    invalid = {**base, "gameId": "bad", "stepIdx": 0, "chosen": 1}
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, [valid, invalid])
        buf = load_trajectory_buffer(
            d,
            gamma=1.0,
            gae_lambda=1.0,
            placement_rewards=PLACEMENT_REWARDS,
        )
    assert len(buf) == 1
    assert np.array_equal(buf.behavior_mask[0], [True, False, True])
    assert math.isclose(float(buf.behavior_temperature[0]), 0.35, abs_tol=1e-6)
    assert bool(buf.farm_mask[0]) and math.isclose(float(buf.farm_value[0]), 0.7, abs_tol=1e-6)
    assert bool(buf.reward_mask[0]) and np.allclose(buf.reward_pi[0], [0.2, 0.3, 0.5])
    assert bool(buf.route_mask[0]) and float(buf.route_mode[0]) == 1.0


def test_complete_episode_keeps_dense_rewards_and_deterministic_terminal_override():
    """A hybrid tactical override has no behavior probability, but it is still the
    terminal transition. Dropping it would lose its dense reward, placement, done,
    value target, and auxiliary labels and would splice GAE across the wrong tail."""
    rng = np.random.default_rng(15)
    rows = []
    dense_rewards = [0.2, 0.3, 0.4]
    policy_masks = [1, 1, 0]
    for t, (reward, policy_mask) in enumerate(zip(dense_rewards, policy_masks)):
        row = {
            "obs": rng.standard_normal(OBS_DIM).astype(np.float32).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).astype(np.float32).tolist(),
            "chosen": t % N_CANDS,
            "ret": 0.0,
            "gameId": "hybrid-terminal-g0",
            "stepIdx": t,
            "rStep": reward,
            "done": t == 2,
            "policyMask": policy_mask,
            "vPred": 0.0,
            "farmValue": 0.25 * (t + 1),
        }
        if policy_mask:
            row["logpOld"] = math.log(1.0 / N_CANDS)
            row["behaviorTemperature"] = 1.0
            row["behaviorMask"] = [1, 1, 1]
        if t == 2:
            row["placement"] = 1
            row["routeMode"] = 0.0
        rows.append(row)

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        buf = load_trajectory_buffer(
            d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
        )

    assert len(buf) == 3
    assert np.array_equal(buf.policy_mask, [True, True, False])
    # Terminal placement adds 1.0 to the final 0.4 dense reward.
    assert np.allclose(buf.returns, [1.9, 1.7, 1.4]), buf.returns
    assert np.allclose(buf.advantages, [1.9, 1.7, 1.4]), buf.advantages
    assert np.array_equal(buf.farm_mask, [True, True, True])
    assert np.array_equal(buf.route_mask, [False, False, True])
    assert float(buf.route_mode[-1]) == 0.0


def test_malformed_middle_row_rejects_complete_episode_instead_of_splicing_gae():
    rng = np.random.default_rng(16)
    rows = []
    for t in range(3):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0,
            "gameId": "broken-g0",
            "stepIdx": t,
            "rStep": 1.0,
            "done": t == 2,
            "policyMask": 1,
            "logpOld": math.log(1.0 / N_CANDS),
            "vPred": 0.0,
        })
    del rows[1]["vPred"]
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        try:
            load_trajectory_buffer(
                d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
            )
        except ValueError as exc:
            assert "No complete PPO trajectories" in str(exc)
        else:
            raise AssertionError("malformed episode was silently spliced")


def test_ppo_trains_configured_farm_reward_and_route_auxiliary_heads():
    rng = np.random.default_rng(17)
    rows = []
    for t in range(12):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": t % N_CANDS,
            "ret": 0.0,
            "gameId": "aux-g0",
            "stepIdx": t,
            "rStep": float(t % 2),
            "done": t == 11,
            "logpOld": math.log(1.0 / N_CANDS),
            "vPred": 0.0,
            "farmValue": (t % 3) / 2,
            "rewardPi": [1.0 if i == (t + 1) % N_CANDS else 0.0 for i in range(N_CANDS)],
            "routeMode": float(t % 2),
        })
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "data"
        out = Path(td) / "weights" / "policy_aux_ppo.json"
        _write_rows(d, rows)
        history = train_mod.train(
            data_dir=d,
            out_path=out,
            epochs=1,
            batch_size=12,
            mode="ppo",
            warm_start=False,
            placement_coef=0.0,
            farm_value_coef=1.0,
            reward_pick_coef=1.0,
            route_mode_coef=1.0,
        )
    assert len(history) == 1
    assert history[0]["farm_value_loss"] > 0
    assert history[0]["reward_pick_loss"] > 0
    assert history[0]["route_mode_loss"] > 0


def test_singleton_policy_minibatch_has_finite_nonzero_advantage_and_update():
    normalized = normalize_policy_advantages(
        np.array([1.25], dtype=np.float32), np.array([True])
    )
    assert np.array_equal(normalized, [1.25])

    rng = np.random.default_rng(19)
    row = {
        "obs": rng.standard_normal(OBS_DIM).tolist(),
        "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
        "chosen": 1,
        "gameId": "singleton-g0",
        "stepIdx": 0,
        "rStep": 1.25,
        "done": True,
        "policyMask": 1,
        "logpOld": math.log(1.0 / N_CANDS),
        "behaviorMask": [1, 1, 1],
        "behaviorTemperature": 1.0,
        "vPred": 0.0,
    }
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, [row])
        buf = load_trajectory_buffer(
            d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
        )
        model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
        history = train_ppo(
            model,
            buf,
            torch.device("cpu"),
            epochs=1,
            batch_size=1,
            lr=1e-4,
            entropy_coef=0.0,
            seed=3,
        )
    assert len(history) == 1
    assert history[0]["policy_steps"] == 1
    assert math.isfinite(history[0]["policy_loss"])
    assert all(torch.isfinite(p).all() for p in model.parameters())


def test_filtered_behavior_support_has_finite_entropy_kl_and_parameter_update():
    """A real actor row often removes a candidate after legal enumeration.

    PPO must keep `-inf` log-probability for that candidate when reconstructing
    the behavior distribution, without letting the entropy or reference-KL
    backward pass create `0 * -inf` / `-inf - -inf` NaNs.
    """
    rng = np.random.default_rng(191)
    obs = rng.standard_normal(OBS_DIM).astype(np.float32)
    cands = rng.standard_normal((N_CANDS, ACT_DIM)).astype(np.float32)
    behavior_mask = np.array([True, False, True])
    chosen = 2
    model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    with torch.no_grad():
        logits, _, _ = model(
            torch.from_numpy(obs).unsqueeze(0),
            torch.from_numpy(cands).unsqueeze(0),
            torch.from_numpy(behavior_mask).unsqueeze(0),
        )
        logp_old = float(
            behavior_log_probs(
                logits,
                torch.from_numpy(behavior_mask).unsqueeze(0),
                torch.tensor([0.7]),
            )[0, chosen]
        )
    row = {
        "obs": obs.tolist(),
        "cands": cands.tolist(),
        "chosen": chosen,
        "gameId": "filtered-support-g0",
        "stepIdx": 0,
        "rStep": 1.0,
        "done": True,
        "policyMask": 1,
        "logpOld": logp_old,
        "behaviorMask": behavior_mask.astype(int).tolist(),
        "behaviorTemperature": 0.7,
        "vPred": 0.0,
    }
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, [row])
        buf = load_trajectory_buffer(
            d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
        )
        before = [parameter.detach().clone() for parameter in model.parameters()]
        history = train_ppo(
            model,
            buf,
            torch.device("cpu"),
            epochs=1,
            batch_size=1,
            lr=1e-4,
            entropy_coef=0.01,
            kl_ref_coef=0.1,
            seed=5,
        )
    assert len(history) == 1
    assert math.isfinite(history[0]["entropy"])
    assert math.isfinite(history[0]["kl_ref"])
    assert all(torch.isfinite(parameter).all() for parameter in model.parameters())
    assert any(
        not torch.equal(old, new)
        for old, new in zip(before, model.parameters())
    )


def test_route_auxiliary_warns_when_enabled_without_real_labels():
    rng = np.random.default_rng(20)
    row = {
        "obs": rng.standard_normal(OBS_DIM).tolist(),
        "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
        "chosen": 0,
        "gameId": "no-route-g0",
        "stepIdx": 0,
        "rStep": 0.0,
        "done": True,
        "policyMask": 0,
        "vPred": 0.0,
    }
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, [row])
        buf = load_trajectory_buffer(
            d, gamma=1.0, gae_lambda=1.0, placement_rewards=PLACEMENT_REWARDS
        )
        model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            train_ppo(
                model,
                buf,
                torch.device("cpu"),
                epochs=1,
                batch_size=1,
                policy_coef=0.0,
                route_mode_coef=1.0,
                entropy_coef=0.0,
                seed=4,
            )
    assert "contains no routeMode labels" in stderr.getvalue()


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


def _two_step_terminal(*, placement=None, all_fallen=0, won=0, **buf_kw) -> float:
    """A 2-step rStep=0/vPred=0 game with the given terminal flags; returns the terminal return
    (== terminal reward at gamma=lam=1)."""
    rng = np.random.default_rng(7)
    rows = []
    for t in range(2):
        rows.append({
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "chosen": 0, "ret": 0.0, "gameId": "g0", "stepIdx": t, "rStep": 0.0,
            "done": t == 1, "logpOld": math.log(1.0 / N_CANDS), "vPred": 0.0,
        })
    if placement is not None:
        rows[-1]["placement"] = placement
    rows[-1]["allFallen"] = all_fallen
    rows[-1]["won"] = won
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        buf = load_trajectory_buffer(d, gamma=1.0, gae_lambda=1.0,
                                     placement_rewards=PLACEMENT_REWARDS, **buf_kw)
    return float(buf.returns[-1])


def test_all_fallen_loss_replaces_placement_on_collapse():
    # Collapse "winner" (placement=1 would pay +1.0) with allFallen=1: --all-fallen-loss REPLACES
    # the placement reward with the loss, so the collapse pays the loss to every seat.
    assert math.isclose(_two_step_terminal(placement=1, all_fallen=1, all_fallen_loss=-1.0),
                        -1.0, abs_tol=1e-6)
    # The loss VALUE is used (not last-place placement by coincidence): flip it to -2.0.
    assert math.isclose(_two_step_terminal(placement=1, all_fallen=1, all_fallen_loss=-2.0),
                        -2.0, abs_tol=1e-6)
    # Off (0): normal placement reward even on an all-Fallen game (bit-parity for existing configs).
    assert math.isclose(_two_step_terminal(placement=1, all_fallen=1, all_fallen_loss=0.0),
                        1.0, abs_tol=1e-6)
    # Non-collapse game (allFallen=0): placement reward, unaffected by the loss knob.
    assert math.isclose(_two_step_terminal(placement=1, all_fallen=0, all_fallen_loss=-1.0),
                        1.0, abs_tol=1e-6)


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


def _win_row(end_round: int | None, won: int = 1) -> list[dict]:
    """One 1-step done episode with a true-win flag (and optional endRound)."""
    rng = np.random.default_rng(7)
    row = {
        "obs": rng.standard_normal(OBS_DIM).tolist(),
        "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
        "chosen": 0,
        "ret": 0.0,
        "gameId": "g0",
        "stepIdx": 0,
        "rStep": 0.0,
        "done": True,
        "logpOld": math.log(1.0 / N_CANDS),
        "vPred": 0.0,
        "won": won,
    }
    if end_round is not None:
        row["endRound"] = end_round
    return [row]


def _terminal_return(rows: list[dict], **kw) -> float:
    # gamma=lam=1, vPred=0, no placement -> the done step's return == rewards[-1].
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_rows(d, rows)
        buf = load_trajectory_buffer(d, gamma=1.0, gae_lambda=1.0,
                                     placement_rewards=PLACEMENT_REWARDS, **kw)
    assert len(buf) == 1
    return float(buf.returns[0])


def test_win_bonus_halflife_decays_late_wins():
    wb = 1.0
    R = 8.0
    # Flat bonus when the halflife is off (default), regardless of endRound.
    assert math.isclose(_terminal_return(_win_row(28), win_bonus=wb), 1.0, abs_tol=1e-6)
    # With R=8: <=round-12 pays full, round 20 -> 0.5x, round 28 -> 0.25x.
    assert math.isclose(_terminal_return(_win_row(12), win_bonus=wb, win_bonus_halflife=R), 1.0, abs_tol=1e-6)
    assert math.isclose(_terminal_return(_win_row(8), win_bonus=wb, win_bonus_halflife=R), 1.0, abs_tol=1e-6)
    assert math.isclose(_terminal_return(_win_row(20), win_bonus=wb, win_bonus_halflife=R), 0.5, abs_tol=1e-6)
    assert math.isclose(_terminal_return(_win_row(28), win_bonus=wb, win_bonus_halflife=R), 0.25, abs_tol=1e-6)
    # A non-win row never earns the bonus, decayed or not.
    assert math.isclose(_terminal_return(_win_row(12, won=0), win_bonus=wb, win_bonus_halflife=R), 0.0, abs_tol=1e-6)
    # Old-format rows (no endRound) stay undecayed — the flag can't punish missing data.
    assert math.isclose(_terminal_return(_win_row(None), win_bonus=wb, win_bonus_halflife=R), 1.0, abs_tol=1e-6)


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
