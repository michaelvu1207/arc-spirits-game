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
        self.reach30_pred: list[float] = []
        self.strategic: list[bool] = []
        self.game_ids: list[str] = []
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
                        raw_behavior_mask = record["behaviorMask"]
                        if (
                            not isinstance(raw_behavior_mask, list)
                            or any(value not in (0, 1, False, True) for value in raw_behavior_mask)
                        ):
                            raise ValueError("behaviorMask must contain only booleans")
                        behavior_mask = np.asarray(raw_behavior_mask, dtype=bool)
                        chosen = int(record["chosen"])
                        temperature = float(record["behaviorTemperature"])
                        logp_old = float(record["logpOld"])
                        reach30_pred = float(record["reach30Pred"])
                        game_id = record["gameId"]
                        strategic = record["strategic"] in (1, True)
                        ret = float(record["ret"])
                        if (
                            obs_v1.shape != (self.obs_dim,)
                            or obs_v2.shape != (self.spec.flat_length,)
                            or cands.ndim != 2
                            or cands.shape[0] == 0
                            or cands.shape[1] != self.act_dim
                            or behavior_mask.shape != (cands.shape[0],)
                            or not bool(behavior_mask.any())
                            or not 0 <= chosen < cands.shape[0]
                            or not bool(behavior_mask[chosen])
                            or not math.isfinite(temperature)
                            or temperature <= 0
                            or not math.isclose(
                                temperature, expected_temperature, rel_tol=0.0, abs_tol=1e-8
                            )
                            or not math.isfinite(logp_old)
                            or not math.isfinite(reach30_pred)
                            or not 0.0 <= reach30_pred <= 1.0
                            or not math.isfinite(ret)
                            or not isinstance(game_id, str)
                            or not game_id
                            or record["strategic"] not in (0, 1, False, True)
                        ):
                            raise ValueError("row shape/support/metadata mismatch")
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
                    self.reach30_pred.append(reach30_pred)
                    self.strategic.append(strategic)
                    self.game_ids.append(game_id)

        game_counts = Counter(self.game_ids)
        strategic_counts = Counter(
            game_id for game_id, strategic in zip(self.game_ids, self.strategic) if strategic
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
                (1.0 / strategic_counts[game_id]) if strategic else 0.0
                for game_id, strategic in zip(self.game_ids, self.strategic)
            ],
            dtype=np.float32,
        )
        self.games = len(game_counts)
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
            self.reach30_pred[index],
            self.outcome_target[index],
            self.finish_round[index],
            self.reach_weight[index],
            self.outcome_weight[index],
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
        torch.tensor([float(row[8]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[9]) for row in batch], dtype=torch.float32),
        torch.tensor([int(row[10]) for row in batch], dtype=torch.int64),
        torch.tensor([float(row[11]) for row in batch], dtype=torch.float32),
        torch.tensor([float(row[12]) for row in batch], dtype=torch.float32),
    )


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


def outcome_surrogate_loss(
    terms: dict[str, torch.Tensor],
    target: torch.Tensor,
    reach30_pred: torch.Tensor,
    weight: torch.Tensor,
    *,
    clip_epsilon: float,
    total_rows: int,
    total_episode_weight: float,
) -> torch.Tensor:
    """Unbiased minibatch estimator of equal-game clipped offline PG loss."""
    if total_episode_weight <= 0 or not bool((weight > 0).any()):
        return torch.zeros((), dtype=target.dtype, device=target.device)
    advantage = target - reach30_pred.clamp(0.05, 0.95)
    log_ratio = (
        terms["student_chosen_logp"] - terms["teacher_chosen_logp"]
    ).clamp(-20.0, 20.0)
    ratio = log_ratio.exp()
    surrogate = torch.minimum(
        ratio * advantage,
        ratio.clamp(1.0 - clip_epsilon, 1.0 + clip_epsilon) * advantage,
    )
    return -(surrogate * weight).sum() * (
        total_rows / (target.shape[0] * total_episode_weight)
    )


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
                temperature, logp_old, *_rest,
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
            ).abs().numpy()
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


def evaluate(
    model: EntityCandidateScorer,
    teacher: CandidateScorer,
    loader: DataLoader,
    *,
    device: torch.device,
    horizons: tuple[int, ...],
) -> dict[str, Any]:
    model.eval()
    kl_chunks: list[np.ndarray] = []
    teacher_entropy_chunks: list[np.ndarray] = []
    student_entropy_chunks: list[np.ndarray] = []
    agree = value_mse = rows = 0.0
    reach_scores: list[np.ndarray] = []
    reach_targets: list[np.ndarray] = []
    reach_finish: list[np.ndarray] = []
    reach_weights: list[np.ndarray] = []
    with torch.no_grad():
        for batch in loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, ret,
                temperature, _logp_old, _reach30_pred, outcome_target,
                finish_round, reach_weight, _outcome_weight,
            ) = batch
            obs_v1, obs_v2 = obs_v1.to(device), obs_v2.to(device)
            cands, valid, behavior = cands.to(device), valid.to(device), behavior.to(device)
            chosen, temperature = chosen.to(device), temperature.to(device)
            teacher_logits, _, _ = teacher(obs_v1, cands, valid)
            student_logits, _, value = model(obs_v2, cands, valid)
            terms = masked_policy_terms(
                teacher_logits, student_logits, behavior, temperature, chosen
            )
            batch_rows = obs_v1.shape[0]
            kl_chunks.append(terms["kl"].cpu().numpy())
            teacher_entropy_chunks.append(terms["teacher_entropy"].cpu().numpy())
            student_entropy_chunks.append(terms["student_entropy"].cpu().numpy())
            agree += terms["agree"].float().sum().item()
            value_mse += F.mse_loss(value, ret.to(device), reduction="sum").item()
            rows += batch_rows
            reach_scores.append(torch.sigmoid(model.reach30_all_logits(obs_v2)).cpu().numpy())
            reach_targets.append(outcome_target.numpy())
            reach_finish.append(finish_round.numpy())
            reach_weights.append(reach_weight.numpy())
    kl = np.concatenate(kl_chunks).astype(np.float64)
    teacher_entropy = np.concatenate(teacher_entropy_chunks).astype(np.float64)
    student_entropy = np.concatenate(student_entropy_chunks).astype(np.float64)
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
    return {
        "teacherKlMean": float(kl.mean()),
        "teacherKlP99": float(np.percentile(kl, 99)),
        "teacherKlMax": float(kl.max()),
        "top1Agreement": agree / rows,
        "teacherEntropyMean": float(teacher_entropy.mean()),
        "studentEntropyMean": float(student_entropy.mean()),
        "entropyDelta": float((student_entropy - teacher_entropy).mean()),
        "valueMse": value_mse / rows,
        "reach30ByHorizon": by_horizon,
    }


def train(
    data_dir: Path,
    val_data_dir: Path,
    teacher_path: Path,
    out_path: Path,
    *,
    init_path: Path | None = None,
    epochs: int = 6,
    batch_size: int = 256,
    lr: float = 3e-4,
    teacher_kl_coef: float = 1.0,
    value_coef: float = 0.5,
    reach30_coef: float = 1.0,
    outcome_pg_coef: float = 0.0,
    clip_epsilon: float = 0.2,
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
    device: torch.device | None = None,
) -> dict[str, Any]:
    if device is None:
        device = get_device()
    for name, value in {
        "teacher_kl_coef": teacher_kl_coef,
        "value_coef": value_coef,
        "reach30_coef": reach30_coef,
        "outcome_pg_coef": outcome_pg_coef,
    }.items():
        if value < 0 or not math.isfinite(value):
            raise ValueError(f"{name} must be finite and nonnegative")
    if not 0 <= clip_epsilon < 1:
        raise ValueError("clip_epsilon must be in [0,1)")

    train_ds = OutcomeDistillDataset(data_dir, expected_temperature=expected_temperature)
    val_ds = OutcomeDistillDataset(val_data_dir, expected_temperature=expected_temperature)
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
    val_loader = DataLoader(
        val_ds, batch_size=batch_size, shuffle=False, collate_fn=collate
    )
    stats: dict[str, Any] = {
        "schemaVersion": "arc-v28-training-v1",
        "data": str(data_dir),
        "validationData": str(val_data_dir),
        "teacher": str(teacher_path),
        "teacherSha256": sha256(teacher_path),
        "init": str(init_path) if init_path else None,
        "initSha256": sha256(init_path) if init_path else None,
        "samples": len(train_ds),
        "validationSamples": len(val_ds),
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
            "seed": seed,
            "selectBestTeacherKl": select_best_teacher_kl,
            "maxMeanKl": max_mean_kl,
            "maxP99Kl": max_p99_kl,
        },
        "epochs": [],
    }
    best_state: dict[str, torch.Tensor] | None = None
    best_kl = float("inf")
    best_epoch = 0
    for epoch in range(1, epochs + 1):
        model.train()
        totals = Counter()
        rows = 0
        for batch in train_loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, ret,
                temperature, _logp_old, reach30_pred, outcome_target,
                finish_round, reach_weight, outcome_weight,
            ) = batch
            obs_v1, obs_v2 = obs_v1.to(device), obs_v2.to(device)
            cands, valid, behavior = cands.to(device), valid.to(device), behavior.to(device)
            chosen, ret = chosen.to(device), ret.to(device)
            temperature = temperature.to(device)
            with torch.no_grad():
                teacher_logits, _, _ = teacher(obs_v1, cands, valid)
            student_logits, _, value = model(obs_v2, cands, valid)
            terms = masked_policy_terms(
                teacher_logits, student_logits, behavior, temperature, chosen
            )
            teacher_kl = terms["kl"].mean()
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
            outcome_loss = outcome_surrogate_loss(
                terms,
                outcome_target.to(device),
                reach30_pred.to(device),
                outcome_weight.to(device),
                clip_epsilon=clip_epsilon,
                total_rows=len(train_ds),
                total_episode_weight=train_ds.total_outcome_weight,
            )
            loss = (
                teacher_kl_coef * teacher_kl
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
            totals["teacherKl"] += float(teacher_kl.detach()) * batch_rows
            totals["valueMse"] += float(value_loss.detach()) * batch_rows
            totals["reach30Loss"] += float(reach_loss.detach()) * batch_rows
            totals["outcomePgLoss"] += float(outcome_loss.detach()) * batch_rows
            totals["top1Agreement"] += float(terms["agree"].float().sum())
            rows += batch_rows
        model.reach30_trained = True
        model.reach30_horizon = horizons[-1]
        assert_finite_weights(model, f"V28 epoch {epoch}")
        validation = evaluate(
            model, teacher, val_loader, device=device, horizons=horizons
        )
        epoch_stats = {
            "epoch": epoch,
            "train": {key: value / rows for key, value in totals.items()},
            "validation": validation,
        }
        stats["epochs"].append(epoch_stats)
        print(
            f"epoch {epoch}/{epochs} "
            f"kl={totals['teacherKl'] / rows:.6f} "
            f"agree={totals['top1Agreement'] / rows:.3f} "
            f"outcome={totals['outcomePgLoss'] / rows:.6f} "
            f"val_kl={validation['teacherKlMean']:.6f} "
            f"val_kl_p99={validation['teacherKlP99']:.6f}",
            flush=True,
        )
        if max_mean_kl is not None and validation["teacherKlMean"] > max_mean_kl:
            raise RuntimeError(
                f"V28 mean validation KL {validation['teacherKlMean']:.6f} > {max_mean_kl}"
            )
        if max_p99_kl is not None and validation["teacherKlP99"] > max_p99_kl:
            raise RuntimeError(
                f"V28 p99 validation KL {validation['teacherKlP99']:.6f} > {max_p99_kl}"
            )
        if select_best_teacher_kl and validation["teacherKlMean"] < best_kl:
            best_kl = validation["teacherKlMean"]
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())

    if select_best_teacher_kl:
        if best_state is None:
            raise RuntimeError("no finite V28 checkpoint selected")
        model.load_state_dict(best_state)
        stats["bestEpoch"] = best_epoch
        stats["bestValidationTeacherKl"] = best_kl
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
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--teacher-kl-coef", type=float, default=1.0)
    parser.add_argument("--value-coef", type=float, default=0.5)
    parser.add_argument("--reach30-coef", type=float, default=1.0)
    parser.add_argument("--outcome-pg-coef", type=float, default=0.0)
    parser.add_argument("--clip-epsilon", type=float, default=0.2)
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
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        teacher_kl_coef=args.teacher_kl_coef,
        value_coef=args.value_coef,
        reach30_coef=args.reach30_coef,
        outcome_pg_coef=args.outcome_pg_coef,
        clip_epsilon=args.clip_epsilon,
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
        device=torch.device(args.device) if args.device else None,
    )
    args.stats_out.parent.mkdir(parents=True, exist_ok=True)
    args.stats_out.write_text(json.dumps(stats, indent=2) + "\n")
    print(f"checkpoint written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
