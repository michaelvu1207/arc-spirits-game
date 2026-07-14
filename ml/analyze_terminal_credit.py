#!/usr/bin/env python3
"""Fail-closed paired analysis for the preregistered V31 terminal-credit screen."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from compare_paired_solo import decode_contract, exact_mcnemar, load_report


def percentile(values: np.ndarray, q: float) -> float:
    return float(np.percentile(values, q * 100.0))


def derived_seed(seed: int, label: str) -> int:
    digest = hashlib.sha256(label.encode()).digest()
    return seed ^ int.from_bytes(digest[:8], "little")


def bootstrap_mean_ci(
    values: np.ndarray,
    *,
    samples: int,
    seed: int,
    confidence: float,
) -> dict[str, float]:
    if values.ndim != 1 or values.size == 0:
        raise ValueError("bootstrap values must be a non-empty vector")
    if samples <= 0 or not 0 < confidence < 1:
        raise ValueError("invalid bootstrap contract")
    rng = np.random.default_rng(seed)
    draws = np.empty(samples, dtype=np.float64)
    chunk = max(1, min(256, samples))
    for start in range(0, samples, chunk):
        count = min(chunk, samples - start)
        indices = rng.integers(0, values.size, size=(count, values.size))
        draws[start : start + count] = values[indices].mean(axis=1)
    alpha = 1.0 - confidence
    return {
        "lower": percentile(draws, alpha / 2),
        "upper": percentile(draws, 1.0 - alpha / 2),
    }


def bootstrap_paired_means(
    values: dict[str, np.ndarray], *, samples: int, seed: int
) -> dict[str, np.ndarray]:
    sizes = {array.size for array in values.values()}
    if len(sizes) != 1 or not sizes or next(iter(sizes)) <= 0:
        raise ValueError("paired bootstrap arrays must have one non-zero shared length")
    size = next(iter(sizes))
    rng = np.random.default_rng(seed)
    draws = {key: np.empty(samples, dtype=np.float64) for key in values}
    chunk = max(1, min(256, samples))
    for start in range(0, samples, chunk):
        count = min(chunk, samples - start)
        indices = rng.integers(0, size, size=(count, size))
        for key, array in values.items():
            draws[key][start : start + count] = array[indices].mean(axis=1)
    return draws


def interval_from_draws(draws: np.ndarray, confidence: float) -> dict[str, float]:
    alpha = 1.0 - confidence
    return {
        "lower": percentile(draws, alpha / 2),
        "upper": percentile(draws, 1.0 - alpha / 2),
    }


def holm_adjust(p_values: dict[str, float]) -> dict[str, float]:
    ordered = sorted(p_values.items(), key=lambda item: (item[1], item[0]))
    adjusted: dict[str, float] = {}
    running = 0.0
    family = len(ordered)
    for rank, (label, value) in enumerate(ordered):
        running = max(running, min(1.0, (family - rank) * value))
        adjusted[label] = running
    return {label: adjusted[label] for label in sorted(adjusted)}


def index_report(report: dict[str, Any], *, label: str) -> dict[int, dict[str, Any]]:
    rows = report["perGame"]
    by_seed = {int(row["seed"]): row for row in rows}
    if len(by_seed) != len(rows):
        raise ValueError(f"{label}: duplicate per-game seed")
    return by_seed


def validate_reports(
    reports: dict[str, dict[str, Any]],
    *,
    expected_seed0: int,
    expected_games: int,
) -> dict[str, dict[int, dict[str, Any]]]:
    reference = next(iter(reports.values()))
    expected_seeds = set(range(expected_seed0, expected_seed0 + expected_games))
    indexed: dict[str, dict[int, dict[str, Any]]] = {}
    for label, report in reports.items():
        for field in ("seed0", "games", "maxRounds", "maxStatusLevel", "catalogSha256"):
            if report.get(field) != reference.get(field):
                raise ValueError(f"{label}: report differs on {field}")
        if int(report["seed0"]) != expected_seed0 or int(report["games"]) != expected_games:
            raise ValueError(f"{label}: report does not match expected development block")
        if decode_contract(report) != decode_contract(reference):
            raise ValueError(f"{label}: decode semantics differ")
        by_seed = index_report(report, label=label)
        if set(by_seed) != expected_seeds:
            raise ValueError(f"{label}: per-game seed set differs from expected block")
        if int(report.get("stalls", -1)) != sum(bool(row["stalled"]) for row in by_seed.values()):
            raise ValueError(f"{label}: stall aggregate differs from per-game rows")
        indexed[label] = by_seed
    reference_label = next(iter(indexed))
    for seed in expected_seeds:
        guardian = indexed[reference_label][seed].get("guardian")
        if not isinstance(guardian, str) or not guardian:
            raise ValueError(f"{reference_label}: seed {seed} has no guardian label")
        if any(rows[seed].get("guardian") != guardian for rows in indexed.values()):
            raise ValueError(f"seed {seed}: guardian assignment differs across reports")
    return indexed


def pair_metrics(
    indexed: dict[str, dict[int, dict[str, Any]]],
    *,
    baseline: str,
    treatment: str,
    bootstrap: int,
    bootstrap_seed: int,
    simultaneous_family: int,
) -> dict[str, Any]:
    seeds = sorted(indexed[baseline])
    a = [indexed[baseline][seed] for seed in seeds]
    b = [indexed[treatment][seed] for seed in seeds]
    win_a = np.asarray([bool(row["trueWin"]) for row in a], dtype=np.int8)
    win_b = np.asarray([bool(row["trueWin"]) for row in b], dtype=np.int8)
    win_delta = win_b.astype(np.float64) - win_a
    vp_delta = np.asarray(
        [float(right["finalVP"]) - float(left["finalVP"]) for left, right in zip(a, b)]
    )
    finish_delta = np.asarray(
        [
            float(right.get("first30Round") or 31) - float(left.get("first30Round") or 31)
            for left, right in zip(a, b)
        ]
    )
    post15_delta = np.asarray(
        [
            float(right["post15VpPerRound"]) - float(left["post15VpPerRound"])
            for left, right in zip(a, b)
        ]
    )
    dice_delta = np.asarray(
        [
            float(right["finalAttackDice"]) - float(left["finalAttackDice"])
            for left, right in zip(a, b)
        ]
    )
    spirits_delta = np.asarray(
        [
            float(right["finalSpirits"]) - float(left["finalSpirits"])
            for left, right in zip(a, b)
        ]
    )
    barrier_delta = np.asarray(
        [
            float(right["finalMaxBarrier"]) - float(left["finalMaxBarrier"])
            for left, right in zip(a, b)
        ]
    )
    a_only = int(((win_a == 1) & (win_b == 0)).sum())
    b_only = int(((win_a == 0) & (win_b == 1)).sum())
    label = f"{baseline}-vs-{treatment}"
    confidence = 1.0 - 0.05 / simultaneous_family
    draws = bootstrap_paired_means(
        {
            "win": win_delta,
            "vp": vp_delta,
            "finish": finish_delta,
            "post15": post15_delta,
            "dice": dice_delta,
            "spirits": spirits_delta,
            "barrier": barrier_delta,
        },
        samples=bootstrap,
        seed=derived_seed(bootstrap_seed, label),
    )
    return {
        "baseline": baseline,
        "treatment": treatment,
        "games": len(seeds),
        "winRate": {
            "baseline": float(win_a.mean()),
            "treatment": float(win_b.mean()),
            "delta": float(win_delta.mean()),
            "deltaBootstrap95": interval_from_draws(draws["win"], 0.95),
            "deltaBootstrapSimultaneous": {
                "confidence": confidence,
                "familySize": simultaneous_family,
                **interval_from_draws(draws["win"], confidence),
            },
            "baselineOnlyWins": a_only,
            "treatmentOnlyWins": b_only,
            "exactMcNemarP": exact_mcnemar(a_only, b_only),
        },
        "finalVP": {
            "meanDelta": float(vp_delta.mean()),
            "deltaBootstrap95": interval_from_draws(draws["vp"], 0.95),
        },
        "censoredFirst30Round": {
            "meanDelta": float(finish_delta.mean()),
            "deltaBootstrap95": interval_from_draws(draws["finish"], 0.95),
            "interpretation": "lower is better; failures are round 31",
        },
        "post15VpPerRound": {
            "meanDelta": float(post15_delta.mean()),
            "deltaBootstrap95": interval_from_draws(draws["post15"], 0.95),
        },
        "engine": {
            "finalAttackDiceMeanDelta": float(dice_delta.mean()),
            "finalAttackDiceDeltaBootstrap95": interval_from_draws(draws["dice"], 0.95),
            "finalSpiritsMeanDelta": float(spirits_delta.mean()),
            "finalSpiritsDeltaBootstrap95": interval_from_draws(draws["spirits"], 0.95),
            "finalMaxBarrierMeanDelta": float(barrier_delta.mean()),
            "finalMaxBarrierDeltaBootstrap95": interval_from_draws(draws["barrier"], 0.95),
        },
        "byGuardian": {
            guardian: {
                "games": len(indices),
                "baselineWinRate": float(win_a[indices].mean()),
                "treatmentWinRate": float(win_b[indices].mean()),
                "winRateDelta": float(win_delta[indices].mean()),
                "finalVpMeanDelta": float(vp_delta[indices].mean()),
            }
            for guardian in sorted({str(row["guardian"]) for row in a})
            for indices in [[
                index for index, row in enumerate(a) if str(row["guardian"]) == guardian
            ]]
        },
        "stalls": {
            "baseline": sum(bool(row["stalled"]) for row in a),
            "treatment": sum(bool(row["stalled"]) for row in b),
        },
    }


def analyze_reports(
    reports: dict[str, dict[str, Any]],
    *,
    treatment_labels: list[str],
    expected_seed0: int,
    expected_games: int,
    bootstrap: int,
    bootstrap_seed: int,
) -> dict[str, Any]:
    required = {"v23", "v30", "anchor", *treatment_labels}
    if set(reports) != required or len(treatment_labels) != 3:
        raise ValueError(f"expected v23/v30/anchor and three treatments, got {sorted(reports)}")
    indexed = validate_reports(
        reports, expected_seed0=expected_seed0, expected_games=expected_games
    )
    parity = pair_metrics(
        indexed,
        baseline="v30",
        treatment="anchor",
        bootstrap=bootstrap,
        bootstrap_seed=bootstrap_seed,
        simultaneous_family=1,
    )
    training_parity_pass = (
        parity["winRate"]["delta"] >= -0.01
        and parity["winRate"]["deltaBootstrap95"]["lower"] >= -0.03
        and parity["stalls"]["baseline"] == 0
        and parity["stalls"]["treatment"] == 0
    )

    arms: dict[str, Any] = {}
    anchor_p: dict[str, float] = {}
    v23_p: dict[str, float] = {}
    for label in treatment_labels:
        causal = pair_metrics(
            indexed,
            baseline="anchor",
            treatment=label,
            bootstrap=bootstrap,
            bootstrap_seed=bootstrap_seed,
            simultaneous_family=3,
        )
        strength = pair_metrics(
            indexed,
            baseline="v23",
            treatment=label,
            bootstrap=bootstrap,
            bootstrap_seed=bootstrap_seed,
            simultaneous_family=3,
        )
        anchor_p[label] = causal["winRate"]["exactMcNemarP"]
        v23_p[label] = strength["winRate"]["exactMcNemarP"]
        causal_pass = (
            causal["winRate"]["delta"] >= 0.02
            and causal["winRate"]["deltaBootstrapSimultaneous"]["lower"] > 0
        )
        strength_pass = (
            strength["winRate"]["delta"] >= 0.03
            and strength["winRate"]["deltaBootstrapSimultaneous"]["lower"] > 0
        )
        late_game_pass = all(
            comparison["finalVP"]["meanDelta"] >= 0
            and comparison["post15VpPerRound"]["meanDelta"] >= 0
            and comparison["censoredFirst30Round"]["meanDelta"] <= 0
            for comparison in (causal, strength)
        )
        zero_stalls = all(
            comparison["stalls"][side] == 0
            for comparison in (causal, strength)
            for side in ("baseline", "treatment")
        )
        arms[label] = {
            "causalVsAnchor": causal,
            "strengthVsV23": strength,
            "gates": {
                "trainingParity": training_parity_pass,
                "causal": causal_pass,
                "strength": strength_pass,
                "lateGame": late_game_pass,
                "zeroStalls": zero_stalls,
            },
        }
        arms[label]["eligible"] = all(arms[label]["gates"].values())

    holm = {
        "causalVsAnchor": holm_adjust(anchor_p),
        "strengthVsV23": holm_adjust(v23_p),
        "decisionUse": False,
    }
    eligible = [label for label in treatment_labels if arms[label]["eligible"]]
    winner = None
    if eligible:
        wins = {
            label: int(reports[label]["trueWins"])
            for label in eligible
        }
        max_wins = max(wins.values())
        tied = [label for label in eligible if wins[label] >= max_wins - 1]
        tied.sort(
            key=lambda label: (
                sum(
                    float(row.get("first30Round") or 31)
                    for row in indexed[label].values()
                )
                / expected_games,
                -sum(
                    float(row["post15VpPerRound"])
                    for row in indexed[label].values()
                )
                / expected_games,
                treatment_labels.index(label),
            )
        )
        winner = tied[0]

    return {
        "schemaVersion": "arc-v31-terminal-credit-analysis-v1",
        "valid": True,
        "seed0": expected_seed0,
        "games": expected_games,
        "bootstrap": {
            "replicates": bootstrap,
            "seed": bootstrap_seed,
            "unit": "complete paired game",
        },
        "trainingParity": {"comparison": parity, "passed": training_parity_pass},
        "arms": arms,
        "mcnemarHolmSensitivity": holm,
        "winner": winner,
        "decision": (
            f"Freeze {winner} as the sole V31 development winner before hidden evaluation."
            if winner is not None
            else "No V31 treatment passes every development gate; do not open hidden seeds."
        ),
    }


def parse_treatment(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("treatment must be LABEL=REPORT.json")
    label, raw_path = value.split("=", 1)
    if not label or not raw_path or label in {"v23", "v30", "anchor"}:
        raise argparse.ArgumentTypeError("invalid treatment label/path")
    return label, Path(raw_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v23", type=Path, required=True)
    parser.add_argument("--v30", type=Path, required=True)
    parser.add_argument("--anchor", type=Path, required=True)
    parser.add_argument("--treatment", action="append", type=parse_treatment, required=True)
    parser.add_argument("--seed0", type=int, default=944000000)
    parser.add_argument("--games", type=int, default=4096)
    parser.add_argument("--bootstrap", type=int, default=10000)
    parser.add_argument("--bootstrap-seed", type=int, default=310199)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if len(args.treatment) != 3:
        parser.error("exactly three --treatment LABEL=PATH values are required")
    treatment_paths = dict(args.treatment)
    if len(treatment_paths) != 3:
        parser.error("treatment labels must be unique")
    paths = {"v23": args.v23, "v30": args.v30, "anchor": args.anchor, **treatment_paths}
    reports = {label: load_report(path) for label, path in paths.items()}
    result = analyze_reports(
        reports,
        treatment_labels=list(treatment_paths),
        expected_seed0=args.seed0,
        expected_games=args.games,
        bootstrap=args.bootstrap,
        bootstrap_seed=args.bootstrap_seed,
    )
    result["reports"] = {label: str(path) for label, path in paths.items()}
    rendered = json.dumps(result, indent=2) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
