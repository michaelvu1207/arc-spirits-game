#!/usr/bin/env python3
"""Validate and aggregate sharded V25 strategic teacher pilot artifacts.

The Vitest harness writes its immutable summary as the final synchronous action.
This analyzer therefore treats a summary as usable only after independently
validating provenance, complete seed coverage, per-shard counts, and paired rows.
Wrapper exit status is reported separately: a process deliberately SIGSTOPped for
load control can exceed Vitest's wall-clock timeout after its summary is complete.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Callable

from compare_paired_solo import bootstrap_ci, exact_mcnemar


PROVENANCE_FIELDS = (
    "mode",
    "family",
    "sourceCommit",
    "checkpointSha256",
    "catalogSha256",
    "rollouts",
    "maxStatusLevel",
    "navigationMinRound",
    "navigationMaxLogitGap",
)
COUNTER_FIELDS = (
    "evaluations",
    "decisive",
    "changed",
    "nonDecisiveAbstentions",
    "invalidAbstentions",
    "candidateRollouts",
    "candidateRolloutStalls",
)


def _mean(rows: list[dict[str, Any]], arm: str, field: str) -> float:
    return sum(float(row[arm][field]) for row in rows) / len(rows)


def _rate(count: int, total: int) -> float:
    return count / total if total else 0.0


def _sum_counters(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total: dict[str, Any] = {field: 0 for field in COUNTER_FIELDS}
    total["byRoundBand"] = {}
    for row in rows:
        counters = row.get("counters")
        if not isinstance(counters, dict):
            raise ValueError(f"seed {row.get('seed')}: missing counters")
        for field in COUNTER_FIELDS:
            value = counters.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"seed {row.get('seed')}: invalid counter {field}={value!r}")
            total[field] += value
        for band, counts in counters.get("byRoundBand", {}).items():
            target = total["byRoundBand"].setdefault(
                band, {"evaluations": 0, "decisive": 0, "changed": 0}
            )
            for field in ("evaluations", "decisive", "changed"):
                value = counts.get(field)
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError(
                        f"seed {row.get('seed')} band {band}: invalid {field}={value!r}"
                    )
                target[field] += value
    return total


def load_shards(root: Path, expected_games: int | None) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    paths = sorted(root.glob("shard-*.jsonl.summary.json"))
    if not paths:
        raise FileNotFoundError(f"{root}: no shard summaries")
    reference: dict[str, Any] | None = None
    by_seed: dict[int, dict[str, Any]] = {}
    artifacts: list[str] = []
    for path in paths:
        summary = json.loads(path.read_text())
        if not isinstance(summary, dict):
            raise ValueError(f"{path}: summary is not an object")
        if reference is None:
            reference = summary
        for field in PROVENANCE_FIELDS:
            if summary.get(field) != reference.get(field):
                raise ValueError(
                    f"{path}: provenance mismatch {field}: "
                    f"{summary.get(field)!r} != {reference.get(field)!r}"
                )
        games = summary.get("games")
        seed_base = summary.get("seedBase")
        paired = summary.get("paired")
        if (
            isinstance(games, bool)
            or not isinstance(games, int)
            or games <= 0
            or isinstance(seed_base, bool)
            or not isinstance(seed_base, int)
            or not isinstance(paired, list)
            or len(paired) != games
        ):
            raise ValueError(f"{path}: malformed games/seedBase/paired contract")
        expected_seeds = list(range(seed_base, seed_base + games))
        actual_seeds = [row.get("seed") for row in paired]
        if actual_seeds != expected_seeds:
            raise ValueError(f"{path}: paired seeds {actual_seeds!r} != {expected_seeds!r}")
        for row in paired:
            seed = int(row["seed"])
            if seed in by_seed:
                raise ValueError(f"duplicate paired seed {seed} in {path}")
            for arm in ("baseline", "teacher"):
                outcome = row.get(arm)
                if not isinstance(outcome, dict):
                    raise ValueError(f"{path}: seed {seed} missing {arm} outcome")
                for field in ("reached30", "finalVP", "post15VpPerRound", "stalled"):
                    if field not in outcome:
                        raise ValueError(f"{path}: seed {seed} {arm} missing {field}")
            by_seed[seed] = row
        if int(summary.get("baselineWins", -1)) != sum(
            bool(row["baseline"]["reached30"]) for row in paired
        ):
            raise ValueError(f"{path}: baselineWins does not match paired rows")
        if int(summary.get("teacherWins", -1)) != sum(
            bool(row["teacher"]["reached30"]) for row in paired
        ):
            raise ValueError(f"{path}: teacherWins does not match paired rows")
        artifacts.append(str(path))
    rows = [by_seed[seed] for seed in sorted(by_seed)]
    if expected_games is not None and len(rows) != expected_games:
        raise ValueError(f"expected {expected_games} paired games, found {len(rows)}")
    if rows and [int(row["seed"]) for row in rows] != list(
        range(int(rows[0]["seed"]), int(rows[0]["seed"]) + len(rows))
    ):
        raise ValueError("aggregate seed block is not contiguous")
    assert reference is not None
    return reference, rows, artifacts


def analyze(
    root: Path,
    *,
    expected_games: int | None,
    bootstrap: int,
    bootstrap_seed: int,
    wrapper_timeouts: int,
) -> dict[str, Any]:
    provenance, rows, artifacts = load_shards(root, expected_games)
    n = len(rows)
    baseline_wins = sum(bool(row["baseline"]["reached30"]) for row in rows)
    teacher_wins = sum(bool(row["teacher"]["reached30"]) for row in rows)
    baseline_only = sum(
        bool(row["baseline"]["reached30"]) and not bool(row["teacher"]["reached30"])
        for row in rows
    )
    teacher_only = sum(
        not bool(row["baseline"]["reached30"]) and bool(row["teacher"]["reached30"])
        for row in rows
    )
    both_win = sum(
        bool(row["baseline"]["reached30"]) and bool(row["teacher"]["reached30"])
        for row in rows
    )
    neither = n - baseline_only - teacher_only - both_win

    def delta(field: str) -> Callable[[list[dict[str, Any]]], float]:
        return lambda sample: sum(
            float(row["teacher"][field]) - float(row["baseline"][field]) for row in sample
        ) / len(sample)

    win_delta = lambda sample: sum(
        int(bool(row["teacher"]["reached30"]))
        - int(bool(row["baseline"]["reached30"]))
        for row in sample
    ) / len(sample)
    counters = _sum_counters(rows)
    evaluated_games = sum(int(row["counters"]["evaluations"] > 0) for row in rows)
    changed_games = sum(int(row["counters"]["changed"] > 0) for row in rows)
    baseline_stalls = sum(bool(row["baseline"]["stalled"]) for row in rows)
    teacher_stalls = sum(bool(row["teacher"]["stalled"]) for row in rows)
    baseline_vp = _mean(rows, "baseline", "finalVP")
    teacher_vp = _mean(rows, "teacher", "finalVP")
    baseline_post15 = _mean(rows, "baseline", "post15VpPerRound")
    teacher_post15 = _mean(rows, "teacher", "post15VpPerRound")
    candidate_stall_rate = _rate(
        counters["candidateRolloutStalls"], counters["candidateRollouts"]
    )
    pilot_gate = {
        "netPairedWinsAtLeast4": teacher_only - baseline_only >= 4,
        "meanVPNonRegressing": teacher_vp >= baseline_vp,
        "post15NonRegressing": teacher_post15 >= baseline_post15,
        "zeroResultingGameStalls": baseline_stalls == 0 and teacher_stalls == 0,
        "evaluatedAtLeast90PctGames": _rate(evaluated_games, n) >= 0.90,
        "changedAtLeast50PctGames": _rate(changed_games, n) >= 0.50,
        "changedAtLeast1PctDecisions": _rate(counters["changed"], counters["evaluations"]) >= 0.01,
        "candidateRolloutStallRateAtMost0_1Pct": candidate_stall_rate <= 0.001,
    }
    support_valid = all(
        pilot_gate[key]
        for key in (
            "zeroResultingGameStalls",
            "evaluatedAtLeast90PctGames",
            "changedAtLeast50PctGames",
            "changedAtLeast1PctDecisions",
            "candidateRolloutStallRateAtMost0_1Pct",
        )
    )
    effect_pass = all(
        pilot_gate[key]
        for key in (
            "netPairedWinsAtLeast4",
            "meanVPNonRegressing",
            "post15NonRegressing",
        )
    )
    return {
        "schemaVersion": "strategic-pilot-aggregate-v1",
        "verdict": (
            "advance_to_confirmation"
            if support_valid and effect_pass
            else "reject_effect"
            if support_valid
            else "invalid_support_or_stability"
        ),
        "games": n,
        "seed0": int(rows[0]["seed"]),
        "seedLast": int(rows[-1]["seed"]),
        "provenance": {field: provenance.get(field) for field in PROVENANCE_FIELDS},
        "pairedOutcomes": {
            "bothWin": both_win,
            "baselineOnlyWin": baseline_only,
            "teacherOnlyWin": teacher_only,
            "neitherWin": neither,
        },
        "winRate": {
            "baseline": baseline_wins / n,
            "teacher": teacher_wins / n,
            "deltaTeacherMinusBaseline": win_delta(rows),
            "deltaBootstrap95": bootstrap_ci(rows, win_delta, bootstrap, bootstrap_seed),
            "exactMcNemarP": exact_mcnemar(baseline_only, teacher_only),
        },
        "finalVP": {
            "baselineMean": baseline_vp,
            "teacherMean": teacher_vp,
            "meanDelta": teacher_vp - baseline_vp,
            "deltaBootstrap95": bootstrap_ci(
                rows, delta("finalVP"), bootstrap, bootstrap_seed ^ 0x9E3779B9
            ),
        },
        "post15VpPerRound": {
            "baselineMean": baseline_post15,
            "teacherMean": teacher_post15,
            "meanDelta": teacher_post15 - baseline_post15,
            "deltaBootstrap95": bootstrap_ci(
                rows, delta("post15VpPerRound"), bootstrap, bootstrap_seed ^ 0x85EBCA6B
            ),
        },
        "stalls": {"baseline": baseline_stalls, "teacher": teacher_stalls},
        "intervention": {
            **counters,
            "evaluatedGames": evaluated_games,
            "evaluatedGameRate": _rate(evaluated_games, n),
            "changedGames": changed_games,
            "changedGameRate": _rate(changed_games, n),
            "changedDecisionRate": _rate(counters["changed"], counters["evaluations"]),
            "candidateRolloutStallRate": candidate_stall_rate,
        },
        "pilotGate": {**pilot_gate, "supportValid": support_valid, "effectPass": effect_pass},
        "artifactValidation": {
            "summaries": len(artifacts),
            "allComplete": True,
            "wrapperTimeoutsAfterSummary": wrapper_timeouts,
            "wrapperTimeoutReason": (
                "Vitest wall-clock included deliberate SIGSTOP load throttling; each accepted "
                "summary passed provenance, seed, count, and paired-row validation."
                if wrapper_timeouts
                else None
            ),
            "files": artifacts,
        },
        "bootstrap": {"samples": bootstrap, "seed": bootstrap_seed},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--expected-games", type=int)
    parser.add_argument("--bootstrap", type=int, default=20_000)
    parser.add_argument("--bootstrap-seed", type=int, default=20260713)
    parser.add_argument("--wrapper-timeouts", type=int, default=0)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.bootstrap <= 0:
        raise ValueError("--bootstrap must be positive")
    report = analyze(
        args.root,
        expected_games=args.expected_games,
        bootstrap=args.bootstrap,
        bootstrap_seed=args.bootstrap_seed,
        wrapper_timeouts=args.wrapper_timeouts,
    )
    rendered = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
