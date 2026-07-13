"""Focused regression tests for the V23 persistent-option Python contract."""
from __future__ import annotations

import copy
import json
import math
import tempfile
from pathlib import Path

import numpy as np
import torch

from expand_options import expand_options, verify_parity
from model import build_model
from ppo import (
    apply_option_feature_cutoff,
    audit_low_level_option_columns,
    compute_smdp_gae,
    load_trajectory_buffer,
    train_ppo,
)
from train import export_weights, load_json_weights_into


def _zero_low_level_option_columns(model) -> None:
    for attr in (
        "trunk",
        "value_head",
        "farm_value_head",
        "placement_head",
        "reward_pick_head",
        "route_mode_head",
        "reach30_head",
    ):
        first = next(
            layer for layer in getattr(model, attr) if isinstance(layer, torch.nn.Linear)
        )
        with torch.no_grad():
            first.weight[:, -model.option_dim :].zero_()


def test_option_expansion_and_checkpoint_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        source_model = build_model(199, 84, torch.device("cpu"))
        source = Path(td) / "source.json"
        export_weights(source_model, 199, 84, source)
        source_payload = json.loads(source.read_text())
        expanded = expand_options(source_payload)
        verify_parity(source_payload, expanded, samples=3)
        expanded_path = Path(td) / "expanded.json"
        expanded_path.write_text(json.dumps(expanded))
        restored = build_model(199, 84, torch.device("cpu"), option_dim=4)
        assert load_json_weights_into(restored, expanded_path)
        for head in (
            restored.trunk,
            restored.value_head,
            restored.farm_value_head,
            restored.route_mode_head,
            restored.reward_pick_head,
            restored.placement_head,
        ):
            first = next(layer for layer in head if isinstance(layer, torch.nn.Linear))
            assert torch.count_nonzero(first.weight[:, -4:]) == 0
        assert torch.equal(restored.option_logits(torch.randn(5, 199)), torch.zeros(5, 4))


def test_smdp_duration_and_terminal_math() -> None:
    gamma, lam = 0.9, 0.95
    values = np.asarray([0.5, 0.25])
    adv, ret, rewards, durations = compute_smdp_gae(
        [[1.0, 2.0], [3.0]], values, [False, True], gamma, lam
    )
    assert np.array_equal(durations, [2, 1])
    assert np.allclose(rewards, [2.8, 3.0])
    delta1 = 3.0 - 0.25
    delta0 = 2.8 + gamma**2 * 0.25 - 0.5
    assert np.allclose(adv, [delta0 + gamma**2 * lam * delta1, delta1])
    assert np.allclose(ret, adv + values)
    # A forced-only event is a valid zero-duration SMDP transition.
    forced_adv, _, _, forced_duration = compute_smdp_gae(
        [[], [1.0]], [0.2, 0.4], [False, True], gamma, lam
    )
    assert np.array_equal(forced_duration, [0, 1])
    assert np.isfinite(forced_adv).all()


def _option_dataset(root: Path) -> None:
    obs = np.zeros(199, dtype=np.float32)
    cands = np.zeros((1, 84), dtype=np.float32)
    rows = []
    for step_idx, (round_index, option_id, reward, done) in enumerate(
        [(1, 0, 1.0, False), (3, 1, 2.0, True)]
    ):
        rows.append(
            {
                "gameId": "g0",
                "stepIdx": step_idx,
                "obs": obs.tolist(),
                "cands": cands.tolist(),
                "chosen": 0,
                "rStep": reward,
                "done": done,
                "policyMask": 0,
                "vPred": 0.0,
                "playerCount": 1,
                "seat": "solo",
                "round": round_index,
                "optionId": option_id,
            }
        )
    (root / "traj.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    events = []
    for round_index, option_id, decision_count in [(1, 0, 1), (2, 2, 0), (3, 1, 1)]:
        events.append(
            {
                "gameId": "g0",
                "seat": "solo",
                "round": round_index,
                "obs": obs.tolist(),
                "optionId": option_id,
                "behaviorMask": [1, 1, 1, 0],
                "logpOld": math.log(1 / 3),
                "optionVPred": 0.0,
                "playerCount": 1,
                "eventId": f"g0:r{round_index}",
                "lowLevelDecisionCount": decision_count,
            }
        )
    (root / "options-0.jsonl").write_text(
        "".join(json.dumps(event) + "\n" for event in events)
    )
    (root / "meta.json").write_text(json.dumps({"obs_dim": 199, "act_dim": 84}))


def test_option_loader_control_mask_and_fixed_budget_update() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _option_dataset(root)
        buffer = load_trajectory_buffer(
            root, gamma=0.999, gae_lambda=0.95, placement_rewards=(1, 0.3, -0.3, -1)
        )
        assert buffer.option_dim == 4 and buffer.option_events is not None
        assert np.array_equal(buffer.option_events.durations, [1, 0, 1])
        assert buffer.option_rejected_episodes == 0
        kept, width = apply_option_feature_cutoff(buffer, 0)
        assert (kept, width) == (0, 4) and np.count_nonzero(buffer.options) == 0
        model = build_model(199, 84, torch.device("cpu"), option_dim=4)
        _zero_low_level_option_columns(model)
        # Exact uniform supported option behavior at update start.
        last = [layer for layer in model.option_head if isinstance(layer, torch.nn.Linear)][-1]
        with torch.no_grad():
            last.weight.zero_()
            last.bias.zero_()
        history = train_ppo(
            model,
            buffer,
            torch.device("cpu"),
            epochs=1,
            batch_size=2,
            policy_coef=0,
            placement_coef=0,
            option_rows_per_epoch=8,
            option_batch_size=4,
            option_feature_cutoff=0,
            seed=7,
        )
        assert history[0]["option_events"] == 8
        assert history[0]["option_optimizer_steps"] == 2
        assert history[0]["option_support_violations"] == 0
        assert all(
            value == 0.0
            for norms in history[0]["option_column_norms"].values()
            for value in norms
        )


def test_option_loader_rejects_decision_count_mismatch() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _option_dataset(root)
        path = root / "options-0.jsonl"
        events = [json.loads(line) for line in path.read_text().splitlines()]
        events[0]["lowLevelDecisionCount"] = 2
        path.write_text("".join(json.dumps(event) + "\n" for event in events))
        try:
            load_trajectory_buffer(
                root, gamma=0.999, gae_lambda=0.95, placement_rewards=(1, 0.3, -0.3, -1)
            )
        except ValueError as exc:
            assert "No complete PPO trajectories" in str(exc)
        else:
            raise AssertionError("decision-count mismatch was accepted")


def test_treatment_option_columns_differentiate_and_keep_solo_mask_zero() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _option_dataset(root)
        buffer = load_trajectory_buffer(
            root, gamma=0.999, gae_lambda=0.95, placement_rewards=(1, 0.3, -0.3, -1)
        )
        apply_option_feature_cutoff(buffer, 4)
        model = build_model(199, 84, torch.device("cpu"), option_dim=4)
        _zero_low_level_option_columns(model)
        history = train_ppo(
            model,
            buffer,
            torch.device("cpu"),
            epochs=1,
            batch_size=2,
            policy_coef=0,
            value_coef=1,
            placement_coef=0,
            option_rows_per_epoch=8,
            option_batch_size=4,
            option_feature_cutoff=4,
            seed=11,
        )
        norms = history[0]["option_column_norms"]["value"]
        assert norms[0] > 0 and norms[1] > 0 and norms[3] == 0
        audit_low_level_option_columns(model, buffer, 4, active_heads={"value"})


def test_paired_arms_keep_option_head_updates_identical() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        _option_dataset(root)
        control_buffer = load_trajectory_buffer(
            root, gamma=0.999, gae_lambda=0.95, placement_rewards=(1, 0.3, -0.3, -1)
        )
        treatment_buffer = load_trajectory_buffer(
            root, gamma=0.999, gae_lambda=0.95, placement_rewards=(1, 0.3, -0.3, -1)
        )
        apply_option_feature_cutoff(control_buffer, 0)
        apply_option_feature_cutoff(treatment_buffer, 4)
        torch.manual_seed(101)
        base = build_model(199, 84, torch.device("cpu"), option_dim=4)
        _zero_low_level_option_columns(base)
        option_last = [
            layer for layer in base.option_head if isinstance(layer, torch.nn.Linear)
        ][-1]
        with torch.no_grad():
            option_last.weight.zero_()
            option_last.bias.zero_()
        control = copy.deepcopy(base)
        treatment = copy.deepcopy(base)
        common = dict(
            epochs=1,
            batch_size=2,
            policy_coef=0,
            value_coef=1,
            placement_coef=0,
            option_rows_per_epoch=8,
            option_batch_size=4,
            seed=29,
        )
        train_ppo(
            control,
            control_buffer,
            torch.device("cpu"),
            option_feature_cutoff=0,
            **common,
        )
        train_ppo(
            treatment,
            treatment_buffer,
            torch.device("cpu"),
            option_feature_cutoff=4,
            **common,
        )
        for name in ("option_head", "option_value_head"):
            left = getattr(control, name).state_dict()
            right = getattr(treatment, name).state_dict()
            assert left.keys() == right.keys()
            assert all(torch.equal(left[key], right[key]) for key in left)


def main() -> None:
    for test in (
        test_option_expansion_and_checkpoint_roundtrip,
        test_smdp_duration_and_terminal_math,
        test_option_loader_control_mask_and_fixed_budget_update,
        test_option_loader_rejects_decision_count_mismatch,
        test_treatment_option_columns_differentiate_and_keep_solo_mask_zero,
        test_paired_arms_keep_option_head_updates_identical,
    ):
        test()
        print(f"PASS {test.__name__}")


if __name__ == "__main__":
    main()
