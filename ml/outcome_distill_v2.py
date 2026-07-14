"""Exact v1-to-v2 behavior distillation with conservative solo outcome credit.

This trainer is intentionally narrower than the generic BC/PPO entry points. It
implements the preregistered V28 experiment:

* recompute the frozen v1 teacher distribution on each actor row's exact
  behaviorMask and behaviorTemperature;
* train raw v2 logits by KL on that same tempered support (no double tempering);
* train equal-game 20/25/30-round objective critics; and
* optionally apply an equal-game, strategic-row-only clipped importance-ratio
  terminal-success surrogate while retaining the teacher KL anchor.

Every input contract is fail-closed. A malformed support, incomplete episode,
teacher-logp mismatch, non-finite gradient, or breached trust region invalidates
the run instead of producing a checkpoint.
"""

from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from torch.utils.data import Subset

sys.path.insert(0, str(Path(__file__).parent))
from model import CandidateScorer, build_model, get_device  # noqa: E402
from model_v2 import (  # noqa: E402
    EntityCandidateScorer,
    build_model_v2,
    load_checkpoint,
    save_checkpoint,
)
from obs_v2 import ObsV2Spec  # noqa: E402
from ppo import binary_ece, reach30_multihorizon_minibatch_loss  # noqa: E402
from train import (  # noqa: E402
    assert_finite_weights,
    hidden_sizes_from_checkpoint,
    load_json_weights_into,
    option_dim_from_checkpoint,
    v2_reach30_horizons,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def top_fraction_mean(values: np.ndarray, fraction: float) -> float:
    """Mean of the largest ceil(fraction * N) values, with at least one value."""
    if values.ndim != 1 or values.size == 0:
        raise ValueError("top_fraction_mean requires a non-empty one-dimensional array")
    if not 0 < fraction <= 1:
        raise ValueError("top_fraction_mean fraction must be in (0,1]")
    count = max(1, math.ceil(fraction * values.size))
    if count == values.size:
        return float(values.mean())
    boundary = values.size - count
    return float(np.partition(values, boundary)[boundary:].mean())


def strategic_tail_cvar(
    per_row_kl: torch.Tensor,
    strategic_mask: torch.Tensor,
    fraction: float,
) -> tuple[torch.Tensor, int, int]:
    """Differentiable CVaR over rows chosen by detached strategic KL rank."""
    if per_row_kl.ndim != 1 or strategic_mask.shape != per_row_kl.shape:
        raise ValueError("strategic_tail_cvar expects matching one-dimensional tensors")
    if strategic_mask.dtype is not torch.bool:
        raise ValueError("strategic_tail_cvar mask must be boolean")
    if not 0 < fraction <= 1:
        raise ValueError("strategic_tail_cvar fraction must be in (0,1]")
    strategic = per_row_kl[strategic_mask]
    rows = int(strategic.numel())
    if rows == 0:
        return per_row_kl.sum() * 0.0, 0, 0
    count = max(1, math.ceil(fraction * rows))
    selected = torch.topk(strategic.detach(), count, sorted=False).indices
    return strategic[selected].mean(), rows, count


def integer_distribution(values: list[int]) -> dict[str, float | int]:
    if not values:
        return {"count": 0}
    array = np.asarray(values, dtype=np.float64)
    return {
        "count": int(array.size),
        "min": int(array.min()),
        "mean": float(array.mean()),
        "p50": float(np.percentile(array, 50)),
        "p95": float(np.percentile(array, 95)),
        "max": int(array.max()),
    }


def float_distribution(values: np.ndarray) -> dict[str, float | int]:
    if values.ndim != 1:
        raise ValueError("float_distribution expects a one-dimensional array")
    if values.size == 0:
        return {"count": 0}
    values = values.astype(np.float64, copy=False)
    if not np.isfinite(values).all():
        raise ValueError("float_distribution received non-finite values")
    return {
        "count": int(values.size),
        "min": float(values.min()),
        "mean": float(values.mean()),
        "p50": float(np.percentile(values, 50)),
        "p95": float(np.percentile(values, 95)),
        "p99": float(np.percentile(values, 99)),
        "max": float(values.max()),
    }


class OutcomeDistillDataset(Dataset):
    """Complete paired actor trajectories with exact behavior-policy metadata."""

    def __init__(self, data_dir: Path, *, expected_temperature: float = 0.55) -> None:
        meta_path = data_dir / "meta.json"
        if not meta_path.exists():
            raise FileNotFoundError(meta_path)
        meta = json.loads(meta_path.read_text())
        if int(meta.get("obs_version", -1)) != 2 or "obs_v2" not in meta:
            raise ValueError(f"{meta_path}: V28 requires paired obs-v2 metadata")
        self.obs_dim = int(meta["obs_dim"])
        self.act_dim = int(meta["act_dim"])
        self.spec = ObsV2Spec.from_meta(meta["obs_v2"])

        self.obs_v1: list[np.ndarray] = []
        self.obs_v2: list[np.ndarray] = []
        self.cands: list[np.ndarray] = []
        self.behavior_masks: list[np.ndarray] = []
        self.chosen: list[int] = []
        self.ret: list[float] = []
        self.temperature: list[float] = []
        self.logp_old: list[float] = []
        self.policy_rows: list[bool] = []
        self.reach30_pred: list[float] = []
        self.strategic: list[bool] = []
        self.game_ids: list[str] = []
        self.decision_types: list[str] = []
        self.rounds: list[int] = []
        self.step_indices: list[int] = []
        outcomes: dict[str, tuple[float, int, int]] = {}
        terminal_counts: Counter[str] = Counter()

        paths = sorted(path for path in data_dir.rglob("shard-*.jsonl") if path.is_file())
        if not paths:
            raise FileNotFoundError(f"{data_dir}: no shard-*.jsonl files")
        for path in paths:
            with open(path) as handle:
                for line_number, line in enumerate(handle, 1):
                    try:
                        record: dict[str, Any] = json.loads(line)
                        obs_v1 = np.asarray(record["obs"], dtype=np.float32)
                        obs_v2 = np.asarray(record["obsV2"], dtype=np.float32)
                        cands = np.asarray(record["cands"], dtype=np.float32)
                        chosen = int(record["chosen"])
                        raw_policy_row = record["policyMask"]
                        if raw_policy_row not in (0, 1, False, True):
                            raise ValueError("policyMask must be boolean")
                        policy_row = raw_policy_row in (1, True)
                        if policy_row:
                            raw_behavior_mask = record["behaviorMask"]
                            if (
                                not isinstance(raw_behavior_mask, list)
                                or any(
                                    value not in (0, 1, False, True)
                                    for value in raw_behavior_mask
                                )
                            ):
                                raise ValueError("behaviorMask must contain only booleans")
                            behavior_mask = np.asarray(raw_behavior_mask, dtype=bool)
                            temperature = float(record["behaviorTemperature"])
                            logp_old = float(record["logpOld"])
                        else:
                            # Deterministic/heuristic policyMask=0 rows remain valid
                            # value/critic states, but are excluded from all policy
                            # losses and teacher-logp diagnostics.
                            behavior_mask = np.ones(cands.shape[0], dtype=bool)
                            temperature = expected_temperature
                            logp_old = 0.0
                        reach30_pred = float(record["reach30Pred"])
                        game_id = record["gameId"]
                        strategic = record["strategic"] in (1, True)
                        ret = float(record["ret"])
                        decision_type = record["decisionType"]
                        round_number = int(record["round"])
                        step_index = int(record["stepIdx"])
                        if (
                            obs_v1.shape != (self.obs_dim,)
                            or obs_v2.shape != (self.spec.flat_length,)
                            or cands.ndim != 2
                            or cands.shape[0] == 0
                            or cands.shape[1] != self.act_dim
                            or not 0 <= chosen < cands.shape[0]
                            or not math.isfinite(reach30_pred)
                            or not 0.0 <= reach30_pred <= 1.0
                            or not math.isfinite(ret)
                            or not isinstance(game_id, str)
                            or not game_id
                            or record["strategic"] not in (0, 1, False, True)
                            or not isinstance(decision_type, str)
                            or not decision_type
                            or round_number < 1
                            or step_index < 0
                        ):
                            raise ValueError("row shape/support/metadata mismatch")
                        if policy_row and (
                            behavior_mask.shape != (cands.shape[0],)
                            or not bool(behavior_mask.any())
                            or not bool(behavior_mask[chosen])
                            or not math.isfinite(temperature)
                            or temperature <= 0
                            or not math.isclose(
                                temperature,
                                expected_temperature,
                                rel_tol=0.0,
                                abs_tol=1e-8,
                            )
                            or not math.isfinite(logp_old)
                        ):
                            raise ValueError("policy row behavior support/temperature mismatch")
                        if "reach30Target" in record:
                            target = record["reach30Target"]
                            horizon = int(record["reach30Horizon"])
                            finish_round = int(record["endRound"])
                            if (
                                target not in (0, 1, False, True)
                                or horizon != 30
                                or finish_round <= 0
                            ):
                                raise ValueError("malformed terminal objective")
                            outcome = (float(bool(target)), horizon, finish_round)
                            if game_id in outcomes and outcomes[game_id] != outcome:
                                raise ValueError("inconsistent terminal objective within game")
                            outcomes[game_id] = outcome
                            terminal_counts[game_id] += 1
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                        raise ValueError(f"{path}:{line_number}: {exc}") from exc
                    self.obs_v1.append(obs_v1)
                    self.obs_v2.append(obs_v2)
                    self.cands.append(cands)
                    self.behavior_masks.append(behavior_mask)
                    self.chosen.append(chosen)
                    self.ret.append(ret)
                    self.temperature.append(temperature)
                    self.logp_old.append(logp_old)
                    self.policy_rows.append(policy_row)
                    self.reach30_pred.append(reach30_pred)
                    self.strategic.append(strategic)
                    self.game_ids.append(game_id)
                    self.decision_types.append(decision_type)
                    self.rounds.append(round_number)
                    self.step_indices.append(step_index)

        game_counts = Counter(self.game_ids)
        strategic_counts = Counter(
            game_id
            for game_id, strategic, policy_row in zip(
                self.game_ids, self.strategic, self.policy_rows
            )
            if strategic and policy_row
        )
        if set(outcomes) != set(game_counts):
            missing = sorted(set(game_counts) - set(outcomes))[:5]
            raise ValueError(f"incomplete objective labels for {len(missing)}+ games: {missing}")
        bad_terminal = [game_id for game_id, count in terminal_counts.items() if count != 1]
        if bad_terminal:
            raise ValueError(f"games must have exactly one terminal objective row: {bad_terminal[:5]}")
        if any(strategic_counts[game_id] <= 0 for game_id in game_counts):
            raise ValueError("every episode must contain at least one strategic row")

        self.outcome_target = np.asarray(
            [outcomes[game_id][0] for game_id in self.game_ids], dtype=np.float32
        )
        self.finish_round = np.asarray(
            [outcomes[game_id][2] if outcomes[game_id][0] else 0 for game_id in self.game_ids],
            dtype=np.int64,
        )
        self.reach_weight = np.asarray(
            [1.0 / game_counts[game_id] for game_id in self.game_ids], dtype=np.float32
        )
        self.outcome_weight = np.asarray(
            [
                (1.0 / strategic_counts[game_id]) if strategic and policy_row else 0.0
                for game_id, strategic, policy_row in zip(
                    self.game_ids, self.strategic, self.policy_rows
                )
            ],
            dtype=np.float32,
        )
        self.games = len(game_counts)
        self.policy_row_count = int(sum(self.policy_rows))
        self.strategic_policy_row_count = int(
            sum(
                strategic and policy_row
                for strategic, policy_row in zip(self.strategic, self.policy_rows)
            )
        )
        self.nonstrategic_policy_row_count = (
            self.policy_row_count - self.strategic_policy_row_count
        )
        self.true_wins = int(sum(outcome[0] for outcome in outcomes.values()))
        self.reach30_horizon = 30
        self.total_reach_weight = float(self.reach_weight.sum())
        self.total_outcome_weight = float(self.outcome_weight.sum())
        if not math.isclose(self.total_reach_weight, self.games, rel_tol=1e-5):
            raise ValueError("reach weights are not equal-game normalized")
        if not math.isclose(self.total_outcome_weight, self.games, rel_tol=1e-5):
            raise ValueError("outcome weights are not equal-game normalized")

    def __len__(self) -> int:
        return len(self.obs_v1)

    def __getitem__(self, index: int) -> tuple:
        return (
            self.obs_v1[index],
            self.obs_v2[index],
            self.cands[index],
            self.behavior_masks[index],
            self.chosen[index],
            self.ret[index],
            self.temperature[index],
            self.logp_old[index],
            self.policy_rows[index],
            self.reach30_pred[index],
            self.outcome_target[index],
            self.finish_round[index],
            self.reach_weight[index],
            self.outcome_weight[index],
            self.rounds[index],
        )


def collate(batch: list[tuple]) -> tuple[torch.Tensor, ...]:
    obs_v1 = torch.from_numpy(np.stack([row[0] for row in batch]))
    obs_v2 = torch.from_numpy(np.stack([row[1] for row in batch]))
    max_candidates = max(row[2].shape[0] for row in batch)
    act_dim = batch[0][2].shape[1]
    cands = torch.zeros(len(batch), max_candidates, act_dim, dtype=torch.float32)
    valid = torch.zeros(len(batch), max_candidates, dtype=torch.bool)
    behavior = torch.zeros(len(batch), max_candidates, dtype=torch.bool)
    for index, row in enumerate(batch):
        count = row[2].shape[0]
        cands[index, :count] = torch.from_numpy(row[2])
        valid[index, :count] = True
        behavior[index, :count] = torch.from_numpy(row[3])
    return (
        obs_v1,
        obs_v2,
        cands,
        valid,
        behavior,
        torch.tensor([int(row[4]) for row in batch], dtype=torch.int64),
        torch.tensor([float(row[5]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[6]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[7]) for row in batch], dtype=torch.float32),
        torch.tensor([bool(row[8]) for row in batch], dtype=torch.bool),
        torch.tensor([float(row[9]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[10]) for row in batch], dtype=torch.float32),
        torch.tensor([int(row[11]) for row in batch], dtype=torch.int64),
        torch.tensor([float(row[12]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[13]) for row in batch], dtype=torch.float32),
        torch.tensor([int(row[14]) for row in batch], dtype=torch.int64),
    )


def game_seed(game_id: str) -> int:
    try:
        return int(game_id.split("-", 1)[0])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"gameId does not begin with absolute seed: {game_id!r}") from exc


def seed_subset(
    dataset: OutcomeDistillDataset, *, seed0: int, games: int
) -> Subset:
    if games <= 0:
        raise ValueError("validation split games must be positive")
    expected = set(range(seed0, seed0 + games))
    observed_games = {
        game_id for game_id in dataset.game_ids if game_seed(game_id) in expected
    }
    observed_seeds = {game_seed(game_id) for game_id in observed_games}
    if observed_seeds != expected:
        missing = sorted(expected - observed_seeds)[:5]
        extra = sorted(observed_seeds - expected)[:5]
        raise ValueError(f"validation seed split mismatch missing={missing} extra={extra}")
    indices = [
        index
        for index, game_id in enumerate(dataset.game_ids)
        if game_seed(game_id) in expected
    ]
    return Subset(dataset, indices)


def load_teacher(
    path: Path, *, obs_dim: int, act_dim: int, device: torch.device
) -> CandidateScorer:
    widths = hidden_sizes_from_checkpoint(path)
    if widths is None:
        raise ValueError(f"cannot infer teacher architecture from {path}")
    option_dim = option_dim_from_checkpoint(path)
    if option_dim != 0:
        raise ValueError("V28 exact distillation currently requires option_dim=0 teacher")
    teacher = build_model(
        obs_dim,
        act_dim,
        device=device,
        trunk_hidden=widths[0],
        value_hidden=widths[1],
    )
    if not load_json_weights_into(teacher, path):
        raise ValueError(f"failed to load frozen teacher {path}")
    teacher.eval()
    assert_finite_weights(teacher, "V28 frozen teacher")
    for parameter in teacher.parameters():
        parameter.requires_grad_(False)
    return teacher


def masked_policy_terms(
    teacher_logits: torch.Tensor,
    student_logits: torch.Tensor,
    behavior_mask: torch.Tensor,
    temperature: torch.Tensor,
    chosen: torch.Tensor,
) -> dict[str, torch.Tensor]:
    """Exact raw-logit-scale policy terms on actor support and temperature."""
    if bool((behavior_mask.sum(dim=1) <= 0).any()):
        raise ValueError("empty behavior support")
    scaled_teacher = (teacher_logits / temperature.unsqueeze(1)).masked_fill(
        ~behavior_mask, float("-inf")
    )
    scaled_student = (student_logits / temperature.unsqueeze(1)).masked_fill(
        ~behavior_mask, float("-inf")
    )
    teacher_logp = F.log_softmax(scaled_teacher, dim=-1)
    student_logp = F.log_softmax(scaled_student, dim=-1)
    teacher_prob = teacher_logp.exp()
    safe_teacher_logp = teacher_logp.masked_fill(~behavior_mask, 0.0)
    safe_student_logp = student_logp.masked_fill(~behavior_mask, 0.0)
    per_row_kl = (
        teacher_prob * (safe_teacher_logp - safe_student_logp)
    ).sum(dim=-1)
    teacher_entropy = -(teacher_prob * safe_teacher_logp).sum(dim=-1)
    student_prob = student_logp.exp()
    student_entropy = -(student_prob * safe_student_logp).sum(dim=-1)
    gather = chosen.unsqueeze(1)
    return {
        "teacher_logp": teacher_logp,
        "student_logp": student_logp,
        "teacher_chosen_logp": teacher_logp.gather(1, gather).squeeze(1),
        "student_chosen_logp": student_logp.gather(1, gather).squeeze(1),
        "kl": per_row_kl,
        "teacher_entropy": teacher_entropy,
        "student_entropy": student_entropy,
        "agree": scaled_teacher.argmax(dim=-1) == scaled_student.argmax(dim=-1),
    }


def anchored_outcome_surrogate(
    terms: dict[str, torch.Tensor],
    target: torch.Tensor,
    reach30_pred: torch.Tensor,
    weight: torch.Tensor,
    *,
    anchor_chosen_logp: torch.Tensor | None,
    clip_epsilon: float,
    behavior_ratio_cap: float | None,
    total_rows: int,
    total_episode_weight: float,
) -> dict[str, torch.Tensor]:
    """Equal-game offline PPO centered on a frozen anchor policy.

    Actor rows were sampled by the frozen teacher, so ``anchor / teacher`` is a
    detached off-policy correction. PPO's trainable ratio is ``current / anchor``
    and is clipped around one. With no anchor this reduces to the original V28
    teacher-centered estimator for backwards-compatible experiments.
    """
    if behavior_ratio_cap is not None and (
        not math.isfinite(behavior_ratio_cap) or behavior_ratio_cap <= 0
    ):
        raise ValueError("behavior_ratio_cap must be finite and positive")
    if anchor_chosen_logp is None:
        anchor_chosen_logp = terms["teacher_chosen_logp"]
    if anchor_chosen_logp.shape != target.shape:
        raise ValueError("anchor chosen-logp shape differs from outcome target")
    active = weight > 0
    advantage = target - reach30_pred.clamp(0.05, 0.95)
    behavior_log_ratio = (
        anchor_chosen_logp - terms["teacher_chosen_logp"]
    ).clamp(-20.0, 20.0)
    behavior_ratio_raw = behavior_log_ratio.exp().detach()
    behavior_ratio = (
        behavior_ratio_raw.clamp(max=behavior_ratio_cap)
        if behavior_ratio_cap is not None
        else behavior_ratio_raw
    )
    update_log_ratio = (
        terms["student_chosen_logp"] - anchor_chosen_logp
    ).clamp(-20.0, 20.0)
    update_ratio = update_log_ratio.exp()
    clipped_update_ratio = update_ratio.clamp(
        1.0 - clip_epsilon, 1.0 + clip_epsilon
    )
    surrogate = behavior_ratio * torch.minimum(
        update_ratio * advantage,
        clipped_update_ratio * advantage,
    )
    if total_episode_weight <= 0 or not bool((weight > 0).any()):
        loss = terms["student_chosen_logp"].sum() * 0.0
    else:
        loss = -(surrogate * weight).sum() * (
            total_rows / (target.shape[0] * total_episode_weight)
        )
    return {
        "loss": loss,
        "active": active,
        "advantage": advantage.detach(),
        "behaviorRatioRaw": behavior_ratio_raw,
        "behaviorRatio": behavior_ratio.detach(),
        "behaviorCapped": (
            behavior_ratio_raw > behavior_ratio_cap
            if behavior_ratio_cap is not None
            else torch.zeros_like(active)
        ),
        "updateRatio": update_ratio.detach(),
        "updateClipped": (update_ratio.detach() != clipped_update_ratio.detach()),
    }


def outcome_surrogate_loss(
    terms: dict[str, torch.Tensor],
    target: torch.Tensor,
    reach30_pred: torch.Tensor,
    weight: torch.Tensor,
    *,
    clip_epsilon: float,
    total_rows: int,
    total_episode_weight: float,
    anchor_chosen_logp: torch.Tensor | None = None,
    behavior_ratio_cap: float | None = None,
) -> torch.Tensor:
    """Compatibility wrapper returning only the anchored surrogate loss."""
    return anchored_outcome_surrogate(
        terms,
        target,
        reach30_pred,
        weight,
        anchor_chosen_logp=anchor_chosen_logp,
        clip_epsilon=clip_epsilon,
        behavior_ratio_cap=behavior_ratio_cap,
        total_rows=total_rows,
        total_episode_weight=total_episode_weight,
    )["loss"]


def teacher_logp_audit(
    teacher: CandidateScorer,
    dataset: OutcomeDistillDataset,
    *,
    batch_size: int,
    device: torch.device,
    max_rows: int = 4096,
) -> dict[str, float | int]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, collate_fn=collate)
    deltas: list[np.ndarray] = []
    seen = 0
    with torch.no_grad():
        for batch in loader:
            (
                obs_v1, _obs_v2, cands, valid, behavior, chosen, _ret,
                temperature, logp_old, policy_row, *_rest,
            ) = batch
            teacher_logits, _, _ = teacher(
                obs_v1.to(device), cands.to(device), valid.to(device)
            )
            terms = masked_policy_terms(
                teacher_logits,
                teacher_logits,
                behavior.to(device),
                temperature.to(device),
                chosen.to(device),
            )
            delta = (
                terms["teacher_chosen_logp"].cpu() - logp_old
            ).abs()[policy_row].numpy()
            if delta.size == 0:
                continue
            take = min(delta.size, max_rows - seen)
            deltas.append(delta[:take])
            seen += take
            if seen >= max_rows:
                break
    values = np.concatenate(deltas).astype(np.float64)
    return {
        "rows": int(values.size),
        "meanAbsError": float(values.mean()),
        "p99AbsError": float(np.percentile(values, 99)),
        "maxAbsError": float(values.max()),
    }


def outcome_diagnostic_summary(
    chunks: dict[str, list[np.ndarray]],
) -> dict[str, Any]:
    required = {
        "advantage",
        "behaviorRatioRaw",
        "behaviorRatio",
        "behaviorCapped",
        "updateRatio",
        "updateClipped",
        "target",
        "round",
    }
    if set(chunks) != required:
        raise ValueError(f"outcome diagnostic keys differ: {sorted(chunks)}")
    arrays = {
        key: np.concatenate(values) if values else np.asarray([], dtype=np.float64)
        for key, values in chunks.items()
    }
    sizes = {array.size for array in arrays.values()}
    if len(sizes) != 1:
        raise ValueError("outcome diagnostic arrays have different lengths")

    def group(mask: np.ndarray) -> dict[str, Any]:
        count = int(mask.sum())
        if count == 0:
            return {"count": 0}
        return {
            "count": count,
            "advantage": float_distribution(arrays["advantage"][mask]),
            "behaviorRatioRaw": float_distribution(arrays["behaviorRatioRaw"][mask]),
            "behaviorRatio": float_distribution(arrays["behaviorRatio"][mask]),
            "behaviorCapFraction": float(arrays["behaviorCapped"][mask].mean()),
            "updateRatio": float_distribution(arrays["updateRatio"][mask]),
            "updateClipFraction": float(arrays["updateClipped"][mask].mean()),
        }

    all_mask = np.ones(arrays["advantage"].size, dtype=bool)
    rounds = arrays["round"]
    return {
        "all": group(all_mask),
        "byOutcome": {
            "loss": group(arrays["target"] < 0.5),
            "win": group(arrays["target"] >= 0.5),
        },
        "byAdvantageSign": {
            "negative": group(arrays["advantage"] < 0),
            "zero": group(arrays["advantage"] == 0),
            "positive": group(arrays["advantage"] > 0),
        },
        "byRoundBand": {
            "01-08": group((rounds >= 1) & (rounds <= 8)),
            "09-15": group((rounds >= 9) & (rounds <= 15)),
            "16-22": group((rounds >= 16) & (rounds <= 22)),
            "23-30": group((rounds >= 23) & (rounds <= 30)),
        },
    }


def append_outcome_diagnostics(
    chunks: dict[str, list[np.ndarray]],
    diagnostics: dict[str, torch.Tensor],
    target: torch.Tensor,
    rounds: torch.Tensor,
) -> None:
    active = diagnostics["active"]
    for key in (
        "advantage",
        "behaviorRatioRaw",
        "behaviorRatio",
        "behaviorCapped",
        "updateRatio",
        "updateClipped",
    ):
        chunks[key].append(diagnostics[key][active].detach().cpu().numpy())
    chunks["target"].append(target[active].detach().cpu().numpy())
    chunks["round"].append(rounds[active].detach().cpu().numpy())


def outcome_reference_audit(
    teacher: CandidateScorer,
    reference: EntityCandidateScorer,
    dataset: OutcomeDistillDataset,
    *,
    batch_size: int,
    behavior_ratio_cap: float | None,
    device: torch.device,
) -> dict[str, Any]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, collate_fn=collate)
    chunks: dict[str, list[np.ndarray]] = {
        key: []
        for key in (
            "advantage",
            "behaviorRatioRaw",
            "behaviorRatio",
            "behaviorCapped",
            "updateRatio",
            "updateClipped",
            "target",
            "round",
        )
    }
    with torch.no_grad():
        for batch in loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, _ret,
                temperature, _logp_old, _policy_row, reach30_pred, outcome_target,
                _finish_round, _reach_weight, outcome_weight, round_number,
            ) = batch
            obs_v1, obs_v2 = obs_v1.to(device), obs_v2.to(device)
            cands, valid, behavior = cands.to(device), valid.to(device), behavior.to(device)
            chosen, temperature = chosen.to(device), temperature.to(device)
            teacher_logits, _, _ = teacher(obs_v1, cands, valid)
            reference_logits, _, _ = reference(obs_v2, cands, valid)
            reference_terms = masked_policy_terms(
                teacher_logits, reference_logits, behavior, temperature, chosen
            )
            diagnostics = anchored_outcome_surrogate(
                reference_terms,
                outcome_target.to(device),
                reach30_pred.to(device),
                outcome_weight.to(device),
                anchor_chosen_logp=reference_terms["student_chosen_logp"],
                clip_epsilon=0.2,
                behavior_ratio_cap=behavior_ratio_cap,
                total_rows=len(dataset),
                total_episode_weight=dataset.total_outcome_weight,
            )
            append_outcome_diagnostics(
                chunks,
                diagnostics,
                outcome_target.to(device),
                round_number.to(device),
            )
    summary = outcome_diagnostic_summary(chunks)
    summary["strategicPolicyRows"] = dataset.strategic_policy_row_count
    return summary


def evaluate(
    model: EntityCandidateScorer,
    teacher: CandidateScorer,
    loader: DataLoader,
    *,
    outcome_reference: EntityCandidateScorer | None = None,
    device: torch.device,
    horizons: tuple[int, ...],
) -> dict[str, Any]:
    model.eval()
    kl_chunks: list[np.ndarray] = []
    teacher_entropy_chunks: list[np.ndarray] = []
    student_entropy_chunks: list[np.ndarray] = []
    strategic_kl_chunks: list[np.ndarray] = []
    strategic_teacher_entropy_chunks: list[np.ndarray] = []
    strategic_student_entropy_chunks: list[np.ndarray] = []
    strategic_reference_entropy_chunks: list[np.ndarray] = []
    agree = value_mse = rows = policy_rows = 0.0
    strategic_agree = strategic_rows = 0.0
    reach_scores: list[np.ndarray] = []
    reach_targets: list[np.ndarray] = []
    reach_finish: list[np.ndarray] = []
    reach_weights: list[np.ndarray] = []
    with torch.no_grad():
        for batch in loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, ret,
                temperature, _logp_old, policy_row, _reach30_pred, outcome_target,
                finish_round, reach_weight, outcome_weight, _round_number,
            ) = batch
            obs_v1, obs_v2 = obs_v1.to(device), obs_v2.to(device)
            cands, valid, behavior = cands.to(device), valid.to(device), behavior.to(device)
            chosen, temperature = chosen.to(device), temperature.to(device)
            teacher_logits, _, _ = teacher(obs_v1, cands, valid)
            student_logits, _, value = model(obs_v2, cands, valid)
            terms = masked_policy_terms(
                teacher_logits, student_logits, behavior, temperature, chosen
            )
            reference_terms = None
            if outcome_reference is not None:
                reference_logits, _, _ = outcome_reference(obs_v2, cands, valid)
                reference_terms = masked_policy_terms(
                    teacher_logits, reference_logits, behavior, temperature, chosen
                )
            batch_rows = obs_v1.shape[0]
            policy_device = policy_row.to(device)
            strategic_device = outcome_weight.to(device) > 0
            kl_chunks.append(terms["kl"][policy_device].cpu().numpy())
            teacher_entropy_chunks.append(
                terms["teacher_entropy"][policy_device].cpu().numpy()
            )
            student_entropy_chunks.append(
                terms["student_entropy"][policy_device].cpu().numpy()
            )
            agree += terms["agree"][policy_device].float().sum().item()
            policy_rows += int(policy_row.sum())
            strategic_kl_chunks.append(terms["kl"][strategic_device].cpu().numpy())
            strategic_teacher_entropy_chunks.append(
                terms["teacher_entropy"][strategic_device].cpu().numpy()
            )
            strategic_student_entropy_chunks.append(
                terms["student_entropy"][strategic_device].cpu().numpy()
            )
            if reference_terms is not None:
                strategic_reference_entropy_chunks.append(
                    reference_terms["student_entropy"][strategic_device].cpu().numpy()
                )
            strategic_agree += terms["agree"][strategic_device].float().sum().item()
            strategic_rows += int(strategic_device.sum())
            value_mse += F.mse_loss(value, ret.to(device), reduction="sum").item()
            rows += batch_rows
            reach_scores.append(torch.sigmoid(model.reach30_all_logits(obs_v2)).cpu().numpy())
            reach_targets.append(outcome_target.numpy())
            reach_finish.append(finish_round.numpy())
            reach_weights.append(reach_weight.numpy())
    kl = np.concatenate(kl_chunks).astype(np.float64)
    teacher_entropy = np.concatenate(teacher_entropy_chunks).astype(np.float64)
    student_entropy = np.concatenate(student_entropy_chunks).astype(np.float64)
    strategic_kl = np.concatenate(strategic_kl_chunks).astype(np.float64)
    strategic_teacher_entropy = np.concatenate(
        strategic_teacher_entropy_chunks
    ).astype(np.float64)
    strategic_student_entropy = np.concatenate(
        strategic_student_entropy_chunks
    ).astype(np.float64)
    scores = np.concatenate(reach_scores).astype(np.float64)
    target = np.concatenate(reach_targets).astype(np.float64)
    finish = np.concatenate(reach_finish).astype(np.int64)
    weights = np.concatenate(reach_weights).astype(np.float64)
    by_horizon: dict[str, dict[str, float]] = {}
    for index, horizon in enumerate(horizons):
        nested_target = ((target > 0.5) & (finish <= horizon)).astype(np.float64)
        score = scores[:, index]
        clipped = np.clip(score, 1e-7, 1.0 - 1e-7)
        by_horizon[str(horizon)] = {
            "nll": float(np.average(
                -(nested_target * np.log(clipped) + (1 - nested_target) * np.log(1 - clipped)),
                weights=weights,
            )),
            "brier": float(np.average((score - nested_target) ** 2, weights=weights)),
            "ece": binary_ece(nested_target, score, weights=weights),
        }
    result = {
        "teacherKlMean": float(kl.mean()),
        "teacherKlP95": float(np.percentile(kl, 95)),
        "teacherKlP99": float(np.percentile(kl, 99)),
        "teacherKlMax": float(kl.max()),
        "policyRows": int(policy_rows),
        "top1Agreement": agree / policy_rows,
        "teacherEntropyMean": float(teacher_entropy.mean()),
        "studentEntropyMean": float(student_entropy.mean()),
        "entropyDelta": float((student_entropy - teacher_entropy).mean()),
        "strategicPolicyRows": int(strategic_rows),
        "strategicTeacherKlMean": float(strategic_kl.mean()),
        "strategicTeacherKlP95": float(np.percentile(strategic_kl, 95)),
        "strategicTeacherKlP99": float(np.percentile(strategic_kl, 99)),
        "strategicTeacherKlCvar05": top_fraction_mean(strategic_kl, 0.05),
        "strategicTeacherKlMax": float(strategic_kl.max()),
        "strategicTop1Agreement": strategic_agree / strategic_rows,
        "strategicTeacherEntropyMean": float(strategic_teacher_entropy.mean()),
        "strategicStudentEntropyMean": float(strategic_student_entropy.mean()),
        "strategicEntropyDelta": float(
            (strategic_student_entropy - strategic_teacher_entropy).mean()
        ),
        "valueMse": value_mse / rows,
        "reach30ByHorizon": by_horizon,
    }
    if strategic_reference_entropy_chunks:
        strategic_reference_entropy = np.concatenate(
            strategic_reference_entropy_chunks
        ).astype(np.float64)
        result["strategicReferenceEntropyMean"] = float(
            strategic_reference_entropy.mean()
        )
        result["strategicStudentMinusReferenceEntropy"] = float(
            (strategic_student_entropy - strategic_reference_entropy).mean()
        )
    return result


def enforce_trust_region(
    metrics: dict[str, Any],
    *,
    context: str,
    max_mean_kl: float | None,
    max_p99_kl: float | None,
    max_strategic_mean_kl: float | None,
    max_strategic_p99_kl: float | None,
    min_top1_agreement: float | None,
    min_strategic_top1_agreement: float | None,
) -> None:
    checks = [
        (max_mean_kl, metrics["teacherKlMean"], "mean validation KL", "max"),
        (max_p99_kl, metrics["teacherKlP99"], "p99 validation KL", "max"),
        (
            max_strategic_mean_kl,
            metrics["strategicTeacherKlMean"],
            "strategic mean validation KL",
            "max",
        ),
        (
            max_strategic_p99_kl,
            metrics["strategicTeacherKlP99"],
            "strategic p99 validation KL",
            "max",
        ),
        (
            min_top1_agreement,
            metrics["top1Agreement"],
            "validation top1 agreement",
            "min",
        ),
        (
            min_strategic_top1_agreement,
            metrics["strategicTop1Agreement"],
            "strategic validation top1 agreement",
            "min",
        ),
    ]
    for limit, raw_observed, label, direction in checks:
        observed = float(raw_observed)
        if not math.isfinite(observed):
            raise RuntimeError(f"{context} {label} is non-finite: {observed}")
        if limit is None:
            continue
        failed = observed > limit if direction == "max" else observed < limit
        if failed:
            raise RuntimeError(
                f"{context} {label} {observed:.6f} fails {direction} limit {limit}"
            )


def train(
    data_dir: Path,
    val_data_dir: Path,
    teacher_path: Path,
    out_path: Path,
    *,
    init_path: Path | None = None,
    outcome_reference_path: Path | None = None,
    epochs: int = 6,
    batch_size: int = 256,
    lr: float = 3e-4,
    teacher_kl_coef: float = 1.0,
    value_coef: float = 0.5,
    reach30_coef: float = 1.0,
    outcome_pg_coef: float = 0.0,
    clip_epsilon: float = 0.2,
    outcome_behavior_ratio_cap: float | None = None,
    d_model: int = 128,
    layers: int = 3,
    heads: int = 4,
    seed: int = 0,
    max_grad_norm: float = 1.0,
    expected_temperature: float = 0.55,
    select_best_teacher_kl: bool = False,
    max_mean_kl: float | None = None,
    max_p99_kl: float | None = None,
    teacher_logp_tolerance: float = 1e-3,
    audit_only: bool = False,
    val_select_seed0: int | None = None,
    val_select_games: int | None = None,
    val_gate_seed0: int | None = None,
    val_gate_games: int | None = None,
    early_stop_patience: int = 0,
    early_stop_min_delta: float = 0.0,
    early_stop_min_epochs: int = 0,
    max_strategic_mean_kl: float | None = None,
    max_strategic_p99_kl: float | None = None,
    min_top1_agreement: float | None = None,
    min_strategic_top1_agreement: float | None = None,
    strategic_kl_fraction: float | None = None,
    strategic_tail_fraction: float | None = None,
    strategic_tail_coef: float = 0.0,
    selection_metric: str = "teacherKlMean",
    device: torch.device | None = None,
) -> dict[str, Any]:
    if device is None:
        device = get_device()
    for name, value in {
        "teacher_kl_coef": teacher_kl_coef,
        "value_coef": value_coef,
        "reach30_coef": reach30_coef,
        "outcome_pg_coef": outcome_pg_coef,
        "strategic_tail_coef": strategic_tail_coef,
    }.items():
        if value < 0 or not math.isfinite(value):
            raise ValueError(f"{name} must be finite and nonnegative")
    if not 0 <= clip_epsilon < 1:
        raise ValueError("clip_epsilon must be in [0,1)")
    if outcome_behavior_ratio_cap is not None and (
        not math.isfinite(outcome_behavior_ratio_cap)
        or outcome_behavior_ratio_cap <= 0
    ):
        raise ValueError("outcome_behavior_ratio_cap must be finite and positive")
    if early_stop_patience < 0 or early_stop_min_epochs < 0 or early_stop_min_delta < 0:
        raise ValueError("early-stop controls must be nonnegative")
    if early_stop_patience and not select_best_teacher_kl:
        raise ValueError("early stopping requires select_best_teacher_kl")
    if (val_select_seed0 is None) != (val_select_games is None):
        raise ValueError("validation selection split requires seed0 and games")
    if (val_gate_seed0 is None) != (val_gate_games is None):
        raise ValueError("validation gate split requires seed0 and games")
    if val_gate_seed0 is not None and val_select_seed0 is None:
        raise ValueError("validation gate split requires a selection split")
    if strategic_kl_fraction is not None and not 0 < strategic_kl_fraction < 1:
        raise ValueError("strategic_kl_fraction must be in (0,1)")
    if strategic_tail_fraction is not None and not 0 < strategic_tail_fraction <= 1:
        raise ValueError("strategic_tail_fraction must be in (0,1]")
    if strategic_tail_coef > 0 and strategic_tail_fraction is None:
        raise ValueError("positive strategic_tail_coef requires strategic_tail_fraction")
    if strategic_kl_fraction is not None and strategic_tail_coef > 0:
        raise ValueError("strategic mean balancing and strategic tail CVaR are mutually exclusive")
    allowed_selection_metrics = {
        "teacherKlMean",
        "strategicTeacherKlMean",
        "strategicTeacherKlCvar05",
    }
    if selection_metric not in allowed_selection_metrics:
        raise ValueError(f"selection_metric must be one of {sorted(allowed_selection_metrics)}")

    train_ds = OutcomeDistillDataset(data_dir, expected_temperature=expected_temperature)
    val_ds = OutcomeDistillDataset(val_data_dir, expected_temperature=expected_temperature)
    if (strategic_kl_fraction is not None or strategic_tail_coef > 0) and (
        train_ds.strategic_policy_row_count <= 0
        or train_ds.nonstrategic_policy_row_count <= 0
    ):
        raise ValueError("strategic policy objectives require both policy subgroups")
    if (
        train_ds.spec.header != val_ds.spec.header
        or train_ds.obs_dim != val_ds.obs_dim
        or train_ds.act_dim != val_ds.act_dim
    ):
        raise ValueError("training and validation schemas differ")
    horizons = v2_reach30_horizons(train_ds.reach30_horizon)
    teacher = load_teacher(
        teacher_path,
        obs_dim=train_ds.obs_dim,
        act_dim=train_ds.act_dim,
        device=device,
    )
    outcome_reference = None
    if outcome_reference_path is not None:
        outcome_reference = load_checkpoint(
            outcome_reference_path, device=device, spec=train_ds.spec
        ).to(device)
        if outcome_reference.act_dim != train_ds.act_dim:
            raise ValueError("outcome reference action width differs from dataset")
        outcome_reference.eval()
        assert_finite_weights(outcome_reference, "frozen outcome reference")
        for parameter in outcome_reference.parameters():
            parameter.requires_grad_(False)
    train_audit = teacher_logp_audit(
        teacher, train_ds, batch_size=batch_size, device=device
    )
    val_audit = teacher_logp_audit(
        teacher, val_ds, batch_size=batch_size, device=device
    )
    if max(train_audit["maxAbsError"], val_audit["maxAbsError"]) > teacher_logp_tolerance:
        raise ValueError(
            f"teacher logp audit exceeds {teacher_logp_tolerance}: "
            f"train={train_audit}, validation={val_audit}"
        )
    reference_audit = (
        outcome_reference_audit(
            teacher,
            outcome_reference,
            train_ds,
            batch_size=batch_size,
            behavior_ratio_cap=outcome_behavior_ratio_cap,
            device=device,
        )
        if outcome_reference is not None
        else None
    )
    if audit_only:
        return {
            "schemaVersion": "arc-v28-preflight-v1",
            "valid": True,
            "data": str(data_dir),
            "validationData": str(val_data_dir),
            "teacher": str(teacher_path),
            "teacherSha256": sha256(teacher_path),
            "outcomeReference": (
                str(outcome_reference_path) if outcome_reference_path is not None else None
            ),
            "outcomeReferenceSha256": (
                sha256(outcome_reference_path)
                if outcome_reference_path is not None
                else None
            ),
            "outcomeReferenceAudit": reference_audit,
            "observation": {
                "v1Dim": train_ds.obs_dim,
                "v2FlatDim": train_ds.spec.flat_length,
                "actDim": train_ds.act_dim,
                "v2Header": list(train_ds.spec.header),
            },
            "train": {
                "rows": len(train_ds),
                "policyRows": train_ds.policy_row_count,
                "games": train_ds.games,
                "trueWins": train_ds.true_wins,
                "equalGameReachWeight": train_ds.total_reach_weight,
                "equalGameOutcomeWeight": train_ds.total_outcome_weight,
            },
            "validation": {
                "rows": len(val_ds),
                "policyRows": val_ds.policy_row_count,
                "games": val_ds.games,
                "trueWins": val_ds.true_wins,
                "equalGameReachWeight": val_ds.total_reach_weight,
                "equalGameOutcomeWeight": val_ds.total_outcome_weight,
            },
            "expectedBehaviorTemperature": expected_temperature,
            "teacherLogpTolerance": teacher_logp_tolerance,
            "teacherLogpAudit": {"train": train_audit, "validation": val_audit},
        }

    if init_path is None:
        model = build_model_v2(
            train_ds.spec,
            train_ds.act_dim,
            device=device,
            d_model=d_model,
            layers=layers,
            heads=heads,
            reach30_horizons=horizons,
            seed=seed,
        )
    else:
        model = load_checkpoint(init_path, device=device, spec=train_ds.spec)
        if model.act_dim != train_ds.act_dim:
            raise ValueError("initial checkpoint action width differs from dataset")
        model.enable_reach30_horizons(horizons)
    model = model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    train_loader = DataLoader(
        train_ds,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=collate,
        generator=torch.Generator().manual_seed(seed),
    )
    if val_select_seed0 is not None:
        selection_data: Dataset = seed_subset(
            val_ds, seed0=val_select_seed0, games=int(val_select_games)
        )
        gate_data: Dataset | None = (
            seed_subset(val_ds, seed0=int(val_gate_seed0), games=int(val_gate_games))
            if val_gate_seed0 is not None
            else None
        )
        if gate_data is not None and set(selection_data.indices) & set(gate_data.indices):
            raise ValueError("validation selection and gate rows overlap")
    else:
        selection_data = val_ds
        gate_data = None
    val_loader = DataLoader(
        selection_data, batch_size=batch_size, shuffle=False, collate_fn=collate
    )
    gate_loader = (
        DataLoader(gate_data, batch_size=batch_size, shuffle=False, collate_fn=collate)
        if gate_data is not None
        else None
    )
    stats: dict[str, Any] = {
        "schemaVersion": "arc-v28-training-v1",
        "data": str(data_dir),
        "validationData": str(val_data_dir),
        "teacher": str(teacher_path),
        "teacherSha256": sha256(teacher_path),
        "init": str(init_path) if init_path else None,
        "initSha256": sha256(init_path) if init_path else None,
        "outcomeReference": (
            str(outcome_reference_path) if outcome_reference_path is not None else None
        ),
        "outcomeReferenceSha256": (
            sha256(outcome_reference_path) if outcome_reference_path is not None else None
        ),
        "outcomeReferenceAudit": reference_audit,
        "samples": len(train_ds),
        "policySamples": train_ds.policy_row_count,
        "validationSamples": len(val_ds),
        "validationPolicySamples": val_ds.policy_row_count,
        "games": train_ds.games,
        "validationGames": val_ds.games,
        "trueWins": train_ds.true_wins,
        "validationTrueWins": val_ds.true_wins,
        "teacherLogpAudit": {"train": train_audit, "validation": val_audit},
        "config": {
            "epochs": epochs,
            "batchSize": batch_size,
            "learningRate": lr,
            "teacherKlCoef": teacher_kl_coef,
            "valueCoef": value_coef,
            "reach30Coef": reach30_coef,
            "outcomePgCoef": outcome_pg_coef,
            "clipEpsilon": clip_epsilon,
            "outcomeBehaviorRatioCap": outcome_behavior_ratio_cap,
            "seed": seed,
            "selectBestTeacherKl": select_best_teacher_kl,
            "maxMeanKl": max_mean_kl,
            "maxP99Kl": max_p99_kl,
            "validationSelection": (
                {"seed0": val_select_seed0, "games": val_select_games}
                if val_select_seed0 is not None
                else None
            ),
            "validationGate": (
                {"seed0": val_gate_seed0, "games": val_gate_games}
                if val_gate_seed0 is not None
                else None
            ),
            "earlyStopPatience": early_stop_patience,
            "earlyStopMinDelta": early_stop_min_delta,
            "earlyStopMinEpochs": early_stop_min_epochs,
            "strategicKlFraction": strategic_kl_fraction,
            "strategicTailFraction": strategic_tail_fraction,
            "strategicTailCoef": strategic_tail_coef,
            "selectionMetric": selection_metric,
        },
        "epochs": [],
    }
    best_state: dict[str, torch.Tensor] | None = None
    best_kl = float("inf")
    best_epoch = 0
    significant_best = float("inf")
    stale_epochs = 0
    for epoch in range(1, epochs + 1):
        model.train()
        totals = Counter()
        strategic_rows_per_batch: list[int] = []
        tail_topk_per_batch: list[int] = []
        outcome_chunks: dict[str, list[np.ndarray]] = {
            key: []
            for key in (
                "advantage",
                "behaviorRatioRaw",
                "behaviorRatio",
                "behaviorCapped",
                "updateRatio",
                "updateClipped",
                "target",
                "round",
            )
        }
        rows = 0
        for batch in train_loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, ret,
                temperature, _logp_old, policy_row, reach30_pred, outcome_target,
                finish_round, reach_weight, outcome_weight, round_number,
            ) = batch
            obs_v1, obs_v2 = obs_v1.to(device), obs_v2.to(device)
            cands, valid, behavior = cands.to(device), valid.to(device), behavior.to(device)
            chosen, ret = chosen.to(device), ret.to(device)
            temperature = temperature.to(device)
            with torch.no_grad():
                teacher_logits, _, _ = teacher(obs_v1, cands, valid)
                reference_terms = None
                if outcome_reference is not None:
                    reference_logits, _, _ = outcome_reference(obs_v2, cands, valid)
                    reference_terms = masked_policy_terms(
                        teacher_logits,
                        reference_logits,
                        behavior,
                        temperature,
                        chosen,
                    )
            student_logits, _, value = model(obs_v2, cands, valid)
            terms = masked_policy_terms(
                teacher_logits, student_logits, behavior, temperature, chosen
            )
            policy_device = policy_row.to(device)
            strategic_device = outcome_weight.to(device) > 0
            if strategic_kl_fraction is None:
                teacher_kl = terms["kl"][policy_device].sum() * (
                    len(train_ds) / (obs_v1.shape[0] * train_ds.policy_row_count)
                )
            else:
                nonstrategic_device = policy_device & ~strategic_device
                teacher_kl = (
                    strategic_kl_fraction
                    * terms["kl"][strategic_device].sum()
                    * (
                        len(train_ds)
                        / (obs_v1.shape[0] * train_ds.strategic_policy_row_count)
                    )
                    + (1.0 - strategic_kl_fraction)
                    * terms["kl"][nonstrategic_device].sum()
                    * (
                        len(train_ds)
                        / (obs_v1.shape[0] * train_ds.nonstrategic_policy_row_count)
                    )
                )
            if strategic_tail_fraction is None:
                strategic_tail_loss = terms["kl"].sum() * 0.0
                strategic_batch_rows = int(strategic_device.sum())
                strategic_tail_rows = 0
            else:
                strategic_tail_loss, strategic_batch_rows, strategic_tail_rows = (
                    strategic_tail_cvar(
                        terms["kl"], strategic_device, strategic_tail_fraction
                    )
                )
            value_loss = F.mse_loss(value, ret)
            reach_loss = reach30_multihorizon_minibatch_loss(
                model.reach30_all_logits(obs_v2),
                outcome_target.to(device),
                torch.ones_like(outcome_target, dtype=torch.bool, device=device),
                reach_weight.to(device),
                finish_round.to(device),
                horizons,
                total_rows=len(train_ds),
                total_episode_weight=train_ds.total_reach_weight,
            )
            outcome_diagnostics = anchored_outcome_surrogate(
                terms,
                outcome_target.to(device),
                reach30_pred.to(device),
                outcome_weight.to(device),
                anchor_chosen_logp=(
                    reference_terms["student_chosen_logp"]
                    if reference_terms is not None
                    else None
                ),
                clip_epsilon=clip_epsilon,
                behavior_ratio_cap=outcome_behavior_ratio_cap,
                total_rows=len(train_ds),
                total_episode_weight=train_ds.total_outcome_weight,
            )
            outcome_loss = outcome_diagnostics["loss"]
            append_outcome_diagnostics(
                outcome_chunks,
                outcome_diagnostics,
                outcome_target.to(device),
                round_number.to(device),
            )
            loss = (
                teacher_kl_coef * teacher_kl
                + strategic_tail_coef * strategic_tail_loss
                + value_coef * value_loss
                + reach30_coef * reach_loss
                + outcome_pg_coef * outcome_loss
            )
            if not bool(torch.isfinite(loss)):
                raise FloatingPointError(f"non-finite V28 loss in epoch {epoch}")
            optimizer.zero_grad()
            loss.backward()
            gradients = [
                parameter.grad for parameter in model.parameters() if parameter.grad is not None
            ]
            if not gradients or any(not bool(torch.isfinite(gradient).all()) for gradient in gradients):
                raise FloatingPointError(f"non-finite/missing V28 gradients in epoch {epoch}")
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()
            batch_rows = obs_v1.shape[0]
            totals["teacherKlSum"] += float(terms["kl"][policy_device].sum().detach())
            totals["strategicTailLoss"] += float(strategic_tail_loss.detach())
            totals["batches"] += 1
            strategic_rows_per_batch.append(strategic_batch_rows)
            tail_topk_per_batch.append(strategic_tail_rows)
            totals["valueMse"] += float(value_loss.detach()) * batch_rows
            totals["reach30Loss"] += float(reach_loss.detach()) * batch_rows
            totals["outcomePgLoss"] += float(outcome_loss.detach()) * batch_rows
            totals["top1Agreement"] += float(
                terms["agree"][policy_device].float().sum()
            )
            totals["policyRows"] += int(policy_row.sum())
            rows += batch_rows
        model.reach30_trained = True
        model.reach30_horizon = horizons[-1]
        assert_finite_weights(model, f"V28 epoch {epoch}")
        validation = evaluate(
            model,
            teacher,
            val_loader,
            outcome_reference=outcome_reference,
            device=device,
            horizons=horizons,
        )
        train_stats = {
            "teacherKl": totals["teacherKlSum"] / totals["policyRows"],
            "strategicTailCvar": totals["strategicTailLoss"] / totals["batches"],
            "strategicRowsPerBatch": integer_distribution(strategic_rows_per_batch),
            "strategicTailTopKPerBatch": integer_distribution(tail_topk_per_batch),
            "top1Agreement": totals["top1Agreement"] / totals["policyRows"],
            "valueMse": totals["valueMse"] / rows,
            "reach30Loss": totals["reach30Loss"] / rows,
            "outcomePgLoss": totals["outcomePgLoss"] / rows,
            "outcomeDiagnostics": outcome_diagnostic_summary(outcome_chunks),
            "policyRows": int(totals["policyRows"]),
        }
        epoch_stats = {
            "epoch": epoch,
            "train": train_stats,
            "validation": validation,
        }
        stats["epochs"].append(epoch_stats)
        print(
            f"epoch {epoch}/{epochs} "
            f"kl={train_stats['teacherKl']:.6f} "
            f"tail={train_stats['strategicTailCvar']:.6f} "
            f"agree={train_stats['top1Agreement']:.3f} "
            f"outcome={totals['outcomePgLoss'] / rows:.6f} "
            f"val_kl={validation['teacherKlMean']:.6f} "
            f"val_kl_p99={validation['teacherKlP99']:.6f}",
            flush=True,
        )
        if gate_loader is None:
            enforce_trust_region(
                validation,
                context=f"epoch {epoch}",
                max_mean_kl=max_mean_kl,
                max_p99_kl=max_p99_kl,
                max_strategic_mean_kl=max_strategic_mean_kl,
                max_strategic_p99_kl=max_strategic_p99_kl,
                min_top1_agreement=min_top1_agreement,
                min_strategic_top1_agreement=min_strategic_top1_agreement,
            )
        selection_value = validation[selection_metric]
        if select_best_teacher_kl and selection_value < best_kl:
            best_kl = selection_value
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
        if selection_value < significant_best - early_stop_min_delta:
            significant_best = selection_value
            stale_epochs = 0
        else:
            stale_epochs += 1
        if (
            early_stop_patience > 0
            and epoch >= early_stop_min_epochs
            and stale_epochs >= early_stop_patience
        ):
            stats["earlyStopped"] = True
            stats["earlyStopEpoch"] = epoch
            break

    if select_best_teacher_kl:
        if best_state is None:
            raise RuntimeError("no finite V28 checkpoint selected")
        model.load_state_dict(best_state)
        stats["bestEpoch"] = best_epoch
        stats["bestValidationSelectionMetric"] = best_kl
        stats["selectionMetric"] = selection_metric
        if selection_metric == "teacherKlMean":
            stats["bestValidationTeacherKl"] = best_kl
    final_validation = evaluate(
        model,
        teacher,
        gate_loader if gate_loader is not None else val_loader,
        outcome_reference=outcome_reference,
        device=device,
        horizons=horizons,
    )
    stats["gateValidation" if gate_loader is not None else "finalValidation"] = final_validation
    enforce_trust_region(
        final_validation,
        context="final checkpoint",
        max_mean_kl=max_mean_kl,
        max_p99_kl=max_p99_kl,
        max_strategic_mean_kl=max_strategic_mean_kl,
        max_strategic_p99_kl=max_strategic_p99_kl,
        min_top1_agreement=min_top1_agreement,
        min_strategic_top1_agreement=min_strategic_top1_agreement,
    )
    model.eval()
    assert_finite_weights(model, "V28 save checkpoint")
    manifest = save_checkpoint(model, out_path)
    stats["out"] = str(out_path)
    stats["manifest"] = str(manifest)
    stats["checkpointSha256"] = sha256(out_path)
    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--val-data", type=Path, required=True)
    parser.add_argument("--teacher", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--stats-out", type=Path, required=True)
    parser.add_argument("--init", type=Path)
    parser.add_argument(
        "--outcome-reference",
        type=Path,
        help="frozen policy that centers PPO update ratios; teacher remains behavior denominator",
    )
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--teacher-kl-coef", type=float, default=1.0)
    parser.add_argument("--value-coef", type=float, default=0.5)
    parser.add_argument("--reach30-coef", type=float, default=1.0)
    parser.add_argument("--outcome-pg-coef", type=float, default=0.0)
    parser.add_argument("--clip-epsilon", type=float, default=0.2)
    parser.add_argument("--outcome-behavior-ratio-cap", type=float)
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--layers", type=int, default=3)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--expected-temperature", type=float, default=0.55)
    parser.add_argument("--select-best-teacher-kl", action="store_true")
    parser.add_argument("--max-mean-kl", type=float)
    parser.add_argument("--max-p99-kl", type=float)
    parser.add_argument("--teacher-logp-tolerance", type=float, default=1e-3)
    parser.add_argument("--audit-only", action="store_true",
                        help="validate both datasets and teacher log-probs without building an optimizer")
    parser.add_argument("--val-select-seed0", type=int)
    parser.add_argument("--val-select-games", type=int)
    parser.add_argument("--val-gate-seed0", type=int)
    parser.add_argument("--val-gate-games", type=int)
    parser.add_argument("--early-stop-patience", type=int, default=0)
    parser.add_argument("--early-stop-min-delta", type=float, default=0.0)
    parser.add_argument("--early-stop-min-epochs", type=int, default=0)
    parser.add_argument("--max-strategic-mean-kl", type=float)
    parser.add_argument("--max-strategic-p99-kl", type=float)
    parser.add_argument("--min-top1-agreement", type=float)
    parser.add_argument("--min-strategic-top1-agreement", type=float)
    parser.add_argument("--strategic-kl-fraction", type=float)
    parser.add_argument("--strategic-tail-fraction", type=float)
    parser.add_argument("--strategic-tail-coef", type=float, default=0.0)
    parser.add_argument(
        "--selection-metric",
        choices=[
            "teacherKlMean",
            "strategicTeacherKlMean",
            "strategicTeacherKlCvar05",
        ],
        default="teacherKlMean",
    )
    parser.add_argument("--device", type=str)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    stats = train(
        args.data,
        args.val_data,
        args.teacher,
        args.out,
        init_path=args.init,
        outcome_reference_path=args.outcome_reference,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        teacher_kl_coef=args.teacher_kl_coef,
        value_coef=args.value_coef,
        reach30_coef=args.reach30_coef,
        outcome_pg_coef=args.outcome_pg_coef,
        clip_epsilon=args.clip_epsilon,
        outcome_behavior_ratio_cap=args.outcome_behavior_ratio_cap,
        d_model=args.d_model,
        layers=args.layers,
        heads=args.heads,
        seed=args.seed,
        max_grad_norm=args.max_grad_norm,
        expected_temperature=args.expected_temperature,
        select_best_teacher_kl=args.select_best_teacher_kl,
        max_mean_kl=args.max_mean_kl,
        max_p99_kl=args.max_p99_kl,
        teacher_logp_tolerance=args.teacher_logp_tolerance,
        audit_only=args.audit_only,
        val_select_seed0=args.val_select_seed0,
        val_select_games=args.val_select_games,
        val_gate_seed0=args.val_gate_seed0,
        val_gate_games=args.val_gate_games,
        early_stop_patience=args.early_stop_patience,
        early_stop_min_delta=args.early_stop_min_delta,
        early_stop_min_epochs=args.early_stop_min_epochs,
        max_strategic_mean_kl=args.max_strategic_mean_kl,
        max_strategic_p99_kl=args.max_strategic_p99_kl,
        min_top1_agreement=args.min_top1_agreement,
        min_strategic_top1_agreement=args.min_strategic_top1_agreement,
        strategic_kl_fraction=args.strategic_kl_fraction,
        strategic_tail_fraction=args.strategic_tail_fraction,
        strategic_tail_coef=args.strategic_tail_coef,
        selection_metric=args.selection_metric,
        device=torch.device(args.device) if args.device else None,
    )
    args.stats_out.parent.mkdir(parents=True, exist_ok=True)
    args.stats_out.write_text(json.dumps(stats, indent=2) + "\n")
    if args.audit_only:
        print(f"preflight written: {args.stats_out}")
    else:
        print(f"checkpoint written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
