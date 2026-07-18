"""Fail-closed V34 public-preview reach-30 calibration audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable


ROW_KEYS = {
    "seed",
    "round",
    "seat",
    "phase",
    "chosenPrediction",
    "candidateCount",
    "finiteCandidateCount",
    "terminalSuccessOverrides",
    "terminalFailureOverrides",
    "terminalOverrideMismatches",
    "target",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def auc(labels: list[int], scores: list[float]) -> float:
    positives = sum(labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        raise ValueError("preview calibration requires both positive and negative labels")
    ordered = sorted(zip(scores, labels), key=lambda item: item[0])
    rank_sum_positive = 0.0
    position = 0
    while position < len(ordered):
        end = position + 1
        while end < len(ordered) and ordered[end][0] == ordered[position][0]:
            end += 1
        average_rank = (position + 1 + end) / 2
        rank_sum_positive += average_rank * sum(label for _, label in ordered[position:end])
        position = end
    return (rank_sum_positive - positives * (positives + 1) / 2) / (positives * negatives)


def calibration_metrics(labels: list[int], scores: list[float], bins: int = 15) -> dict[str, Any]:
    if len(labels) != len(scores) or not labels:
        raise ValueError("preview calibration has no aligned rows")
    brier = sum((score - label) ** 2 for score, label in zip(scores, labels)) / len(labels)
    bucket_rows: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for score, label in zip(scores, labels):
        bucket_rows[min(bins - 1, int(score * bins))].append((score, label))
    ece = 0.0
    bucket_report = []
    for index, rows in enumerate(bucket_rows):
        count = len(rows)
        mean_prediction = sum(score for score, _ in rows) / count if count else None
        empirical_rate = sum(label for _, label in rows) / count if count else None
        if count:
            ece += count / len(labels) * abs(mean_prediction - empirical_rate)
        bucket_report.append(
            {
                "index": index,
                "lowerInclusive": index / bins,
                "upperInclusive": (index + 1) / bins if index == bins - 1 else None,
                "upperExclusive": (index + 1) / bins if index < bins - 1 else None,
                "count": count,
                "meanPrediction": mean_prediction,
                "empiricalRate": empirical_rate,
            }
        )
    return {"auc": auc(labels, scores), "brier": brier, "ece": ece, "bins": bucket_report}


def analyze(paths: Iterable[Path], seed0: int, games: int) -> dict[str, Any]:
    paths = sorted(paths)
    if games < 1 or seed0 < 1:
        raise ValueError("seed0 and games must be positive")
    if not paths:
        raise ValueError("no preview audit inputs")
    expected_seeds = set(range(seed0, seed0 + games))
    observed_seeds: set[int] = set()
    targets_by_seed: dict[int, int] = {}
    labels: list[int] = []
    scores: list[float] = []
    candidate_count = 0
    finite_candidate_count = 0
    success_overrides = 0
    failure_overrides = 0
    phase_counts = {"navigation": 0, "encounter": 0}
    rows = 0
    for path in paths:
        if not path.is_file():
            raise ValueError(f"missing preview audit input {path}")
        for line_number, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if set(row) != ROW_KEYS:
                raise ValueError(f"{path}:{line_number} row keys changed")
            seed = row["seed"]
            target = row["target"]
            score = row["chosenPrediction"]
            count = row["candidateCount"]
            finite = row["finiteCandidateCount"]
            if not isinstance(seed, int) or seed not in expected_seeds:
                raise ValueError(f"{path}:{line_number} seed outside registered range")
            if target not in (0, 1):
                raise ValueError(f"{path}:{line_number} invalid target")
            prior_target = targets_by_seed.setdefault(seed, target)
            if prior_target != target:
                raise ValueError(f"{path}:{line_number} inconsistent target for seed {seed}")
            if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError(f"{path}:{line_number} invalid chosen prediction")
            if not isinstance(count, int) or count < 2 or finite != count:
                raise ValueError(f"{path}:{line_number} candidate finiteness gate failed")
            if row["phase"] not in phase_counts or row["seat"] != "Red":
                raise ValueError(f"{path}:{line_number} invalid phase or solo seat")
            if not isinstance(row["round"], int) or not 1 <= row["round"] <= 30:
                raise ValueError(f"{path}:{line_number} invalid round")
            for key in ("terminalSuccessOverrides", "terminalFailureOverrides"):
                if not isinstance(row[key], int) or row[key] < 0 or row[key] > count:
                    raise ValueError(f"{path}:{line_number} invalid {key}")
            if row["terminalOverrideMismatches"] != 0:
                raise ValueError(f"{path}:{line_number} terminal override mismatch")
            observed_seeds.add(seed)
            labels.append(target)
            scores.append(float(score))
            candidate_count += count
            finite_candidate_count += finite
            success_overrides += row["terminalSuccessOverrides"]
            failure_overrides += row["terminalFailureOverrides"]
            phase_counts[row["phase"]] += 1
            rows += 1
    if observed_seeds != expected_seeds:
        missing = sorted(expected_seeds - observed_seeds)
        extra = sorted(observed_seeds - expected_seeds)
        raise ValueError(f"preview calibration seed coverage mismatch missing={missing[:10]} extra={extra[:10]}")
    metrics = calibration_metrics(labels, scores, bins=15)
    thresholds = {"aucMin": 0.75, "eceMax": 0.10, "brierMax": 0.20}
    passed = (
        metrics["auc"] >= thresholds["aucMin"]
        and metrics["ece"] <= thresholds["eceMax"]
        and metrics["brier"] <= thresholds["brierMax"]
        and candidate_count == finite_candidate_count
    )
    return {
        "schemaVersion": "arc-v34-preview-calibration-v1",
        "strengthUse": False,
        "outcomeUse": "reach30-label-calibration-only",
        "seed0": seed0,
        "games": games,
        "seedMax": seed0 + games - 1,
        "uniqueSeeds": len(observed_seeds),
        "rows": rows,
        "phaseCounts": phase_counts,
        "labelCounts": {"negative": len(labels) - sum(labels), "positive": sum(labels)},
        "candidateCount": candidate_count,
        "finiteCandidateCount": finite_candidate_count,
        "terminalOverrides": {"success": success_overrides, "failure": failure_overrides, "mismatches": 0},
        "metrics": metrics,
        "thresholds": thresholds,
        "passed": passed,
        "criticRerankerArmsEnabled": passed,
        "inputs": [{"name": path.name, "sha256": sha256(path)} for path in paths],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--seed0", type=int, required=True)
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    report = analyze((Path(value) for value in args.input), args.seed0, args.games)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

