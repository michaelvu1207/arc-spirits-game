"""Profile exact teacher/student KL and detect exact obs-v2 target aliases."""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any

import numpy as np
import torch
from torch.utils.data import DataLoader

sys.path.insert(0, str(Path(__file__).parent))
from model_v2 import load_checkpoint  # noqa: E402
from outcome_distill_v2 import (  # noqa: E402
    OutcomeDistillDataset,
    collate,
    load_teacher,
    masked_policy_terms,
    seed_subset,
    sha256,
)


def metric_summary(
    kl: list[float], agree: list[bool], entropy_delta: list[float]
) -> dict[str, float | int]:
    if not kl:
        return {"rows": 0}
    values = np.asarray(kl, dtype=np.float64)
    entropy = np.asarray(entropy_delta, dtype=np.float64)
    return {
        "rows": int(values.size),
        "klMean": float(values.mean()),
        "klP95": float(np.percentile(values, 95)),
        "klP99": float(np.percentile(values, 99)),
        "klMax": float(values.max()),
        "top1Agreement": float(np.mean(agree)),
        "entropyDeltaMean": float(entropy.mean()),
    }


def round_bucket(round_number: int) -> str:
    if round_number <= 8:
        return "01-08"
    if round_number <= 15:
        return "09-15"
    if round_number <= 22:
        return "16-22"
    return "23-30"


def diagnose(
    data_dir: Path,
    teacher_path: Path,
    student_path: Path,
    *,
    batch_size: int = 256,
    alias_tv_threshold: float = 0.0001,
    worst_rows: int = 100,
    seed0: int | None = None,
    games: int | None = None,
    device: torch.device | None = None,
) -> dict[str, Any]:
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dataset = OutcomeDistillDataset(data_dir)
    teacher = load_teacher(
        teacher_path, obs_dim=dataset.obs_dim, act_dim=dataset.act_dim, device=device
    )
    student = load_checkpoint(student_path, device=device, spec=dataset.spec).eval()
    if (seed0 is None) != (games is None):
        raise ValueError("diagnostic seed filter requires both seed0 and games")
    if seed0 is None:
        eval_data = dataset
        row_indices = list(range(len(dataset)))
    else:
        eval_data = seed_subset(dataset, seed0=seed0, games=int(games))
        row_indices = list(eval_data.indices)
    loader = DataLoader(eval_data, batch_size=batch_size, shuffle=False, collate_fn=collate)

    groups: dict[str, dict[str, list]] = defaultdict(
        lambda: {"kl": [], "agree": [], "entropy": []}
    )
    worst: list[dict[str, Any]] = []
    alias_reference: dict[bytes, tuple[np.ndarray, int]] = {}
    aliases: list[dict[str, Any]] = []
    max_alias_tv = 0.0
    cursor = 0
    with torch.no_grad():
        for batch in loader:
            (
                obs_v1, obs_v2, cands, valid, behavior, chosen, _ret,
                temperature, _logp_old, policy_row, *_rest,
            ) = batch
            batch_rows = obs_v1.shape[0]
            teacher_logits, _, _ = teacher(
                obs_v1.to(device), cands.to(device), valid.to(device)
            )
            student_logits, _, _ = student(
                obs_v2.to(device), cands.to(device), valid.to(device)
            )
            terms = masked_policy_terms(
                teacher_logits,
                student_logits,
                behavior.to(device),
                temperature.to(device),
                chosen.to(device),
            )
            teacher_prob = terms["teacher_logp"].exp().cpu().numpy()
            kl = terms["kl"].cpu().numpy()
            agree = terms["agree"].cpu().numpy()
            entropy_delta = (
                terms["student_entropy"] - terms["teacher_entropy"]
            ).cpu().numpy()
            for local in range(batch_rows):
                global_index = row_indices[cursor + local]
                if not bool(policy_row[local]):
                    continue
                support_size = int(behavior[local].sum())
                decision_type = dataset.decision_types[global_index]
                strategic = dataset.strategic[global_index]
                buckets = (
                    "overall",
                    f"decisionType:{decision_type}",
                    f"round:{round_bucket(dataset.rounds[global_index])}",
                    f"supportSize:{support_size}",
                    f"strategic:{str(strategic).lower()}",
                )
                for bucket in buckets:
                    groups[bucket]["kl"].append(float(kl[local]))
                    groups[bucket]["agree"].append(bool(agree[local]))
                    groups[bucket]["entropy"].append(float(entropy_delta[local]))

                valid_count = int(valid[local].sum())
                digest = hashlib.sha256()
                digest.update(np.asarray(dataset.obs_v2[global_index], np.float32).tobytes())
                digest.update(np.asarray(dataset.cands[global_index], np.float32).tobytes())
                digest.update(np.asarray(dataset.behavior_masks[global_index], np.uint8).tobytes())
                digest.update(np.float32(dataset.temperature[global_index]).tobytes())
                key = digest.digest()
                target = teacher_prob[local, :valid_count].copy()
                previous = alias_reference.get(key)
                if previous is None:
                    alias_reference[key] = (target, global_index)
                else:
                    previous_target, previous_index = previous
                    if previous_target.shape != target.shape:
                        tv = 1.0
                    else:
                        tv = float(0.5 * np.abs(previous_target - target).sum())
                    max_alias_tv = max(max_alias_tv, tv)
                    if tv > alias_tv_threshold:
                        aliases.append({
                            "first": {
                                "gameId": dataset.game_ids[previous_index],
                                "stepIdx": dataset.step_indices[previous_index],
                            },
                            "second": {
                                "gameId": dataset.game_ids[global_index],
                                "stepIdx": dataset.step_indices[global_index],
                            },
                            "teacherTargetTv": tv,
                        })
                worst.append({
                    "gameId": dataset.game_ids[global_index],
                    "stepIdx": dataset.step_indices[global_index],
                    "round": dataset.rounds[global_index],
                    "decisionType": decision_type,
                    "supportSize": support_size,
                    "strategic": strategic,
                    "kl": float(kl[local]),
                    "top1Agree": bool(agree[local]),
                    "entropyDelta": float(entropy_delta[local]),
                })
            cursor += batch_rows
    summaries = {
        bucket: metric_summary(values["kl"], values["agree"], values["entropy"])
        for bucket, values in sorted(groups.items())
    }
    worst.sort(key=lambda row: (-row["kl"], row["gameId"], row["stepIdx"]))
    finite = all(
        math.isfinite(float(value))
        for summary in summaries.values()
        for key, value in summary.items()
        if key != "rows"
    )
    return {
        "schemaVersion": "arc-v29-distill-diagnostic-v1",
        "valid": finite and not aliases,
        "data": str(data_dir),
        "teacher": str(teacher_path),
        "teacherSha256": sha256(teacher_path),
        "student": str(student_path),
        "studentSha256": sha256(student_path),
        "seed0": seed0,
        "games": games,
        "policyRows": int(sum(dataset.policy_rows[index] for index in row_indices)),
        "metrics": summaries,
        "aliasAudit": {
            "definition": "exact obsV2+candidates+behaviorMask+temperature hash",
            "uniqueInputs": len(alias_reference),
            "duplicateInputs": int(sum(dataset.policy_rows[index] for index in row_indices)) - len(alias_reference),
            "tvThreshold": alias_tv_threshold,
            "aliasesAboveThreshold": len(aliases),
            "maxDuplicateTargetTv": max_alias_tv,
            "examples": aliases[:100],
        },
        "worstRows": worst[:worst_rows],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--teacher", type=Path, required=True)
    parser.add_argument("--student", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--alias-tv-threshold", type=float, default=0.0001)
    parser.add_argument("--worst-rows", type=int, default=100)
    parser.add_argument("--seed0", type=int)
    parser.add_argument("--games", type=int)
    parser.add_argument("--device", type=str)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = diagnose(
        args.data,
        args.teacher,
        args.student,
        batch_size=args.batch_size,
        alias_tv_threshold=args.alias_tv_threshold,
        worst_rows=args.worst_rows,
        seed0=args.seed0,
        games=args.games,
        device=torch.device(args.device) if args.device else None,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({
        "valid": report["valid"],
        "policyRows": report["policyRows"],
        "overall": report["metrics"]["overall"],
        "aliasAudit": report["aliasAudit"],
    }, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
