"""Focused regression tests for the V24 terminal-reward teacher contract."""

from __future__ import annotations

import copy
import json
import math
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("ARC_DEVICE", "cpu")
sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch

import train as train_mod
from model import build_model
from ppo import (
    apply_observation_feature_cutoff,
    load_terminal_teacher_replay,
    load_trajectory_buffer,
    parse_placement_rewards,
    select_terminal_teacher_indices,
    terminal_teacher_minibatch_loss,
    train_ppo,
)

OBS_DIM = 8
ACT_DIM = 4
N_CANDS = 3
PLACEMENT_REWARDS = parse_placement_rewards("1.0,0.3,-0.3,-1.0")


def _write_trajectory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(2400)
    rows = []
    for game in range(2):
        for step in range(2):
            rows.append(
                {
                    "obs": rng.standard_normal(OBS_DIM).tolist(),
                    "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
                    "chosen": (game + step) % N_CANDS,
                    "gameId": f"g{game}",
                    "stepIdx": step,
                    "rStep": float(step),
                    "done": step == 1,
                    "policyMask": 1,
                    "logpOld": math.log(1 / N_CANDS),
                    "behaviorMask": [1, 1, 1],
                    "behaviorTemperature": 1.0,
                    "vPred": 0.0,
                }
            )
    (path / "traj.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows)
    )
    (path / "meta.json").write_text(
        json.dumps({"obs_dim": OBS_DIM, "act_dim": ACT_DIM})
    )


def _teacher_rows() -> list[dict]:
    rng = np.random.default_rng(2401)
    return [
        {
            "stateId": f"state-{index}",
            "obs": rng.standard_normal(OBS_DIM).tolist(),
            "cands": rng.standard_normal((N_CANDS, ACT_DIM)).tolist(),
            "evaluatedMask": [1, 0, 1],
            "terminalPi": [0.8 - 0.1 * index, 0.0, 0.2 + 0.1 * index],
            "teacherWeight": index + 1,
        }
        for index in range(3)
    ]


def _write_teacher(path: Path, rows: list[dict] | None = None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    output = path / "terminal-teacher-0.jsonl"
    output.write_text(
        "".join(json.dumps(row) + "\n" for row in (rows or _teacher_rows()))
    )
    return output


def _load_buffer(path: Path):
    return load_trajectory_buffer(
        path,
        gamma=0.99,
        gae_lambda=0.95,
        placement_rewards=PLACEMENT_REWARDS,
    )


def test_terminal_teacher_schema_dims_masks_and_observation_cutoff() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        trajectory_path = root / "trajectory"
        teacher_path = root / "teacher"
        _write_trajectory(trajectory_path)
        _write_teacher(teacher_path)
        replay = load_terminal_teacher_replay(
            teacher_path,
            expected_obs_dim=OBS_DIM,
            expected_act_dim=ACT_DIM,
        )
        buffer = _load_buffer(trajectory_path)
        original_teacher = replay.obs.copy()
        kept, width = apply_observation_feature_cutoff(buffer, OBS_DIM - 2, replay)
    assert (kept, width) == (OBS_DIM - 2, OBS_DIM)
    assert len(replay) == 3 and replay.obs_dim == OBS_DIM and replay.act_dim == ACT_DIM
    assert np.array_equal(replay.obs[:, :kept], original_teacher[:, :kept])
    assert np.count_nonzero(replay.obs[:, kept:]) == 0
    assert np.array_equal(replay.evaluated_mask[0], [True, False, True])
    assert np.allclose(replay.terminal_pi[0], [0.8, 0.0, 0.2])
    assert np.array_equal(replay.weight, [1.0, 2.0, 3.0])


def test_terminal_teacher_loader_rejects_malformed_contracts() -> None:
    cases: list[tuple[str, callable]] = [
        ("obs width", lambda row: row.update(obs=[0.0] * (OBS_DIM - 1))),
        ("action width", lambda row: row.update(cands=[[0.0] * (ACT_DIM - 1)] * 3)),
        ("nonbinary mask", lambda row: row.update(evaluatedMask=[1, "1", 1])),
        ("single support", lambda row: row.update(evaluatedMask=[1, 0, 0], terminalPi=[1, 0, 0])),
        ("mass off mask", lambda row: row.update(terminalPi=[0.7, 0.1, 0.2])),
        ("unnormalized", lambda row: row.update(terminalPi=[0.7, 0.0, 0.2])),
        ("bad weight", lambda row: row.update(teacherWeight=0)),
    ]
    for label, mutate in cases:
        with tempfile.TemporaryDirectory() as td:
            row = copy.deepcopy(_teacher_rows()[0])
            mutate(row)
            path = _write_teacher(Path(td), [row])
            try:
                load_terminal_teacher_replay(
                    path,
                    expected_obs_dim=OBS_DIM,
                    expected_act_dim=ACT_DIM,
                )
            except ValueError:
                pass
            else:
                raise AssertionError(f"terminal-teacher loader accepted {label}")

    with tempfile.TemporaryDirectory() as td:
        rows = _teacher_rows()[:2]
        rows[1]["stateId"] = rows[0]["stateId"]
        path = _write_teacher(Path(td), rows)
        try:
            load_terminal_teacher_replay(path)
        except ValueError as exc:
            assert "duplicate" in str(exc)
        else:
            raise AssertionError("duplicate terminal-teacher stateId was accepted")


def test_terminal_teacher_soft_ce_uses_only_evaluated_mask_and_policy_trunk() -> None:
    with tempfile.TemporaryDirectory() as td:
        replay = load_terminal_teacher_replay(_write_teacher(Path(td)))
    torch.manual_seed(2402)
    model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    idx = np.array([0], dtype=np.int64)
    loss, agreement = terminal_teacher_minibatch_loss(
        model, replay, idx, torch.device("cpu")
    )
    with torch.no_grad():
        obs = torch.from_numpy(replay.obs[idx])
        cands = torch.from_numpy(replay.cands[0][None, :, :])
        mask = torch.from_numpy(replay.evaluated_mask[0][None, :])
        logits, _, _ = model(obs, cands, mask)
        supported = logits[0, [0, 2]]
        expected = -(
            torch.tensor([0.8, 0.2]) * torch.log_softmax(supported, dim=0)
        ).sum()
        expected_agreement = float(
            int(torch.argmax(supported).item() == torch.argmax(torch.tensor([0.8, 0.2])).item())
        )
    assert torch.allclose(loss.detach(), expected, atol=1e-7)
    assert agreement == expected_agreement
    loss.backward()
    assert any(
        parameter.grad is not None and bool(torch.count_nonzero(parameter.grad))
        for name, parameter in model.named_parameters()
        if name.startswith("trunk.")
    )
    for name, parameter in model.named_parameters():
        if not name.startswith("trunk."):
            assert parameter.grad is None, name


def test_terminal_teacher_batches_are_deterministic_and_coef_zero_is_exact_parity() -> None:
    first = select_terminal_teacher_indices(
        3, 8, seed=2403, epoch=2, minibatch=5
    )
    again = select_terminal_teacher_indices(
        3, 8, seed=2403, epoch=2, minibatch=5
    )
    different = select_terminal_teacher_indices(
        3, 8, seed=2403, epoch=2, minibatch=6
    )
    assert np.array_equal(first, again)
    assert not np.array_equal(first, different)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        trajectory_path = root / "trajectory"
        _write_trajectory(trajectory_path)
        replay = load_terminal_teacher_replay(_write_teacher(root / "teacher"))
        buffer = _load_buffer(trajectory_path)
    torch.manual_seed(2403)
    base = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
    ordinary = copy.deepcopy(base)
    matched = copy.deepcopy(base)
    ordinary_history = train_ppo(
        ordinary,
        buffer,
        torch.device("cpu"),
        epochs=2,
        batch_size=2,
        lr=1e-4,
        seed=2403,
    )
    matched_history = train_ppo(
        matched,
        buffer,
        torch.device("cpu"),
        epochs=2,
        batch_size=2,
        lr=1e-4,
        seed=2403,
        terminal_teacher=replay,
        terminal_teacher_coef=0.0,
        terminal_teacher_batch_size=3,
    )
    assert "terminal_teacher_loss" not in ordinary_history[0]
    assert matched_history[0]["terminal_teacher_batches"] == 2
    assert matched_history[0]["terminal_teacher_rows"] == 6
    assert matched_history[0]["optimizer_steps"] == ordinary_history[0]["optimizer_steps"]
    for name, value in ordinary.state_dict().items():
        assert torch.equal(value, matched.state_dict()[name]), name


def test_terminal_teacher_updates_only_policy_and_rejects_options() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        trajectory_path = root / "trajectory"
        _write_trajectory(trajectory_path)
        replay = load_terminal_teacher_replay(_write_teacher(root / "teacher"))
        buffer = _load_buffer(trajectory_path)
        model = build_model(OBS_DIM, ACT_DIM, torch.device("cpu"))
        before = copy.deepcopy(model.state_dict())
        train_ppo(
            model,
            buffer,
            torch.device("cpu"),
            epochs=1,
            batch_size=2,
            lr=1e-3,
            seed=2404,
            policy_coef=0.0,
            value_coef=0.0,
            entropy_coef=0.0,
            terminal_teacher=replay,
            terminal_teacher_coef=0.1,
            terminal_teacher_batch_size=3,
        )
        assert any(
            not torch.equal(value, model.state_dict()[name])
            for name, value in before.items()
            if name.startswith("trunk.")
        )
        for name, value in before.items():
            if not name.startswith("trunk."):
                assert torch.equal(value, model.state_dict()[name]), name

        option_model = build_model(
            OBS_DIM, ACT_DIM, torch.device("cpu"), option_dim=4
        )
        try:
            train_ppo(
                option_model,
                buffer,
                torch.device("cpu"),
                terminal_teacher=replay,
            )
        except ValueError as exc:
            assert "option-enabled" in str(exc)
        else:
            raise AssertionError("terminal teacher accepted an option-enabled model")

        option_checkpoint = root / "option.json"
        train_mod.export_weights(option_model, OBS_DIM, ACT_DIM, option_checkpoint)
        try:
            train_mod.train(
                data_dir=trajectory_path,
                out_path=root / "out.json",
                mode="ppo",
                init_from=option_checkpoint,
                terminal_teacher_data=root / "teacher",
            )
        except ValueError as exc:
            assert "option-enabled checkpoint" in str(exc)
        else:
            raise AssertionError("train CLI accepted an option checkpoint")


def test_terminal_teacher_cli_guards() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        out = root / "out.json"
        teacher = root / "teacher"
        _write_teacher(teacher)
        cases = [
            ({"terminal_teacher_coef": 0.1}, "requires --terminal-teacher-data"),
            (
                {"mode": "awr", "terminal_teacher_data": teacher},
                "require --mode ppo --model v1",
            ),
            (
                {"terminal_teacher_data": teacher, "terminal_teacher_batch_size": 0},
                "positive integer",
            ),
            (
                {"terminal_teacher_data": teacher, "target_kl": 0.01},
                "incompatible with --target-kl",
            ),
            (
                {"terminal_teacher_data": teacher, "option_feature_cutoff": 0},
                "rejects option-enabled",
            ),
        ]
        for kwargs, message in cases:
            try:
                train_mod.train(
                    data_dir=root / "missing-data",
                    out_path=out,
                    mode=kwargs.pop("mode", "ppo"),
                    **kwargs,
                )
            except ValueError as exc:
                assert message in str(exc), (message, str(exc))
            else:
                raise AssertionError(f"CLI guard did not fire: {message}")


def test_terminal_teacher_train_entrypoint_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        trajectory = root / "trajectory"
        teacher = root / "teacher"
        output = root / "policy.json"
        _write_trajectory(trajectory)
        _write_teacher(teacher)
        history = train_mod.train(
            data_dir=trajectory,
            out_path=output,
            mode="ppo",
            epochs=1,
            batch_size=2,
            lr=1e-4,
            warm_start=False,
            seed=2405,
            obs_feature_cutoff=OBS_DIM - 2,
            terminal_teacher_data=teacher,
            terminal_teacher_coef=0.0,
            terminal_teacher_batch_size=3,
        )
        payload = json.loads(output.read_text())
    assert history[0]["terminal_teacher_batches"] == 2
    assert history[0]["terminal_teacher_rows"] == 6
    assert payload["obs_dim"] == OBS_DIM and payload["act_dim"] == ACT_DIM


if __name__ == "__main__":
    tests = [
        test_terminal_teacher_schema_dims_masks_and_observation_cutoff,
        test_terminal_teacher_loader_rejects_malformed_contracts,
        test_terminal_teacher_soft_ce_uses_only_evaluated_mask_and_policy_trunk,
        test_terminal_teacher_batches_are_deterministic_and_coef_zero_is_exact_parity,
        test_terminal_teacher_updates_only_policy_and_rejects_options,
        test_terminal_teacher_cli_guards,
        test_terminal_teacher_train_entrypoint_end_to_end,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
