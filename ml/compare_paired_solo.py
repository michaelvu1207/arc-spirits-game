#!/usr/bin/env python3
"""Compare two solo held-out reports on the exact same seed block.

The reports must be produced with ``evaluate-solo-checkpoint.mjs --include-games``.
Resampling whole games preserves the pairing, unlike treating two win rates as
independent samples.  The exact McNemar test answers whether the discordant win
counts are compatible with equal policies; the bootstrap intervals quantify the
paired win-rate and score deltas.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path
from typing import Any, Callable


def load_report(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        report = json.load(handle)
    games = report.get("perGame")
    if not isinstance(games, list) or not games:
        raise ValueError(f"{path}: missing non-empty perGame data (use --include-games)")
    return report


def percentile(sorted_values: list[float], q: float) -> float:
    position = (len(sorted_values) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    fraction = position - lower
    return sorted_values[lower] + fraction * (sorted_values[upper] - sorted_values[lower])


def bootstrap_ci(
    pairs: list[tuple[dict[str, Any], dict[str, Any]]],
    statistic: Callable[[list[tuple[dict[str, Any], dict[str, Any]]]], float],
    samples: int,
    seed: int,
) -> dict[str, float]:
    rng = random.Random(seed)
    n = len(pairs)
    draws = []
    for _ in range(samples):
        sample = [pairs[rng.randrange(n)] for _ in range(n)]
        draws.append(statistic(sample))
    draws.sort()
    return {"lower": percentile(draws, 0.025), "upper": percentile(draws, 0.975)}


def exact_mcnemar(discordant_a: int, discordant_b: int) -> float:
    total = discordant_a + discordant_b
    if total == 0:
        return 1.0
    tail = sum(math.comb(total, k) for k in range(min(discordant_a, discordant_b) + 1))
    return min(1.0, 2.0 * tail / (2**total))


def main() -> None:
    parser = argparse.ArgumentParser(description="Paired comparison of solo held-out reports")
    parser.add_argument("--a", type=Path, required=True)
    parser.add_argument("--b", type=Path, required=True)
    parser.add_argument("--label-a", default="control")
    parser.add_argument("--label-b", default="treatment")
    parser.add_argument("--bootstrap", type=int, default=10_000)
    parser.add_argument("--bootstrap-seed", type=int, default=20260713)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.bootstrap <= 0:
        raise ValueError("--bootstrap must be positive")

    report_a = load_report(args.a)
    report_b = load_report(args.b)
    for field in ("seed0", "games", "maxRounds", "maxStatusLevel", "decode"):
        if report_a.get(field) != report_b.get(field):
            raise ValueError(f"reports differ on paired-evaluation field {field}")

    by_seed_a = {int(game["seed"]): game for game in report_a["perGame"]}
    by_seed_b = {int(game["seed"]): game for game in report_b["perGame"]}
    if len(by_seed_a) != len(report_a["perGame"]) or len(by_seed_b) != len(report_b["perGame"]):
        raise ValueError("duplicate seed in perGame data")
    if by_seed_a.keys() != by_seed_b.keys():
        raise ValueError("reports do not contain the exact same seed set")
    seeds = sorted(by_seed_a)
    pairs = [(by_seed_a[seed], by_seed_b[seed]) for seed in seeds]

    both_win = sum(bool(a["trueWin"]) and bool(b["trueWin"]) for a, b in pairs)
    a_only = sum(bool(a["trueWin"]) and not bool(b["trueWin"]) for a, b in pairs)
    b_only = sum(not bool(a["trueWin"]) and bool(b["trueWin"]) for a, b in pairs)
    neither = len(pairs) - both_win - a_only - b_only

    win_delta = lambda sample: sum(
        int(bool(b["trueWin"])) - int(bool(a["trueWin"])) for a, b in sample
    ) / len(sample)
    vp_delta = lambda sample: sum(float(b["finalVP"]) - float(a["finalVP"]) for a, b in sample) / len(sample)
    output = {
        "schemaVersion": "solo-paired-comparison-v1",
        "a": {"label": args.label_a, "report": str(args.a), "weights": report_a.get("weights")},
        "b": {"label": args.label_b, "report": str(args.b), "weights": report_b.get("weights")},
        "games": len(pairs),
        "seed0": report_a["seed0"],
        "pairedOutcomes": {
            "bothWin": both_win,
            "aOnlyWin": a_only,
            "bOnlyWin": b_only,
            "neitherWin": neither,
        },
        "winRate": {
            "a": sum(bool(a["trueWin"]) for a, _ in pairs) / len(pairs),
            "b": sum(bool(b["trueWin"]) for _, b in pairs) / len(pairs),
            "deltaBMinusA": win_delta(pairs),
            "deltaBootstrap95": bootstrap_ci(pairs, win_delta, args.bootstrap, args.bootstrap_seed),
            "exactMcNemarP": exact_mcnemar(a_only, b_only),
        },
        "finalVP": {
            "meanA": sum(float(a["finalVP"]) for a, _ in pairs) / len(pairs),
            "meanB": sum(float(b["finalVP"]) for _, b in pairs) / len(pairs),
            "meanDeltaBMinusA": vp_delta(pairs),
            "deltaBootstrap95": bootstrap_ci(
                pairs, vp_delta, args.bootstrap, args.bootstrap_seed ^ 0x9E3779B9
            ),
        },
        "stalls": {
            "a": sum(bool(a["stalled"]) for a, _ in pairs),
            "b": sum(bool(b["stalled"]) for _, b in pairs),
        },
        "bootstrap": {"samples": args.bootstrap, "seed": args.bootstrap_seed},
    }
    rendered = json.dumps(output, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
