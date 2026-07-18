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
    confidence: float = 0.95,
) -> dict[str, float]:
    if not 0 < confidence < 1:
        raise ValueError("confidence must be in (0,1)")
    rng = random.Random(seed)
    n = len(pairs)
    draws = []
    for _ in range(samples):
        sample = [pairs[rng.randrange(n)] for _ in range(n)]
        draws.append(statistic(sample))
    draws.sort()
    alpha = 1.0 - confidence
    return {
        "lower": percentile(draws, alpha / 2),
        "upper": percentile(draws, 1.0 - alpha / 2),
    }


def decode_contract(report: dict[str, Any]) -> dict[str, Any]:
    """Decision semantics that must match; transport/obs version may differ."""
    decode = report.get("decode")
    if not isinstance(decode, dict):
        raise ValueError("report has no decode contract")
    return {
        key: value
        for key, value in decode.items()
        if key not in ("policyObsVersion", "inferenceSocket")
    }


def exact_mcnemar(discordant_a: int, discordant_b: int) -> float:
    total = discordant_a + discordant_b
    if total == 0:
        return 1.0
    # Summing integer binomial coefficients and then converting to float overflows
    # once a held-out block has roughly a thousand discordant games.  Compute the
    # lower Binomial(n, 0.5) tail with log-sum-exp instead.
    cutoff = min(discordant_a, discordant_b)
    log_terms = [
        math.lgamma(total + 1)
        - math.lgamma(k + 1)
        - math.lgamma(total - k + 1)
        - total * math.log(2.0)
        for k in range(cutoff + 1)
    ]
    peak = max(log_terms)
    lower_tail = math.exp(peak) * sum(math.exp(value - peak) for value in log_terms)
    return min(1.0, 2.0 * lower_tail)


def main() -> None:
    parser = argparse.ArgumentParser(description="Paired comparison of solo held-out reports")
    parser.add_argument("--a", type=Path, required=True)
    parser.add_argument("--b", type=Path, required=True)
    parser.add_argument("--label-a", default="control")
    parser.add_argument("--label-b", default="treatment")
    parser.add_argument("--bootstrap", type=int, default=10_000)
    parser.add_argument("--bootstrap-seed", type=int, default=20260713)
    parser.add_argument(
        "--simultaneous-comparisons",
        type=int,
        default=3,
        help="Bonferroni family size for the simultaneous paired win-delta interval",
    )
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.bootstrap <= 0:
        raise ValueError("--bootstrap must be positive")
    if args.simultaneous_comparisons <= 0:
        raise ValueError("--simultaneous-comparisons must be positive")

    report_a = load_report(args.a)
    report_b = load_report(args.b)
    for field in ("seed0", "games", "maxRounds", "maxStatusLevel"):
        if report_a.get(field) != report_b.get(field):
            raise ValueError(f"reports differ on paired-evaluation field {field}")
    if decode_contract(report_a) != decode_contract(report_b):
        raise ValueError("reports differ on paired decision/decode semantics")

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
    finish_delta = lambda sample: sum(
        float(b.get("first30Round") or 31) - float(a.get("first30Round") or 31)
        for a, b in sample
    ) / len(sample)
    post15_delta = lambda sample: sum(
        float(b["post15VpPerRound"]) - float(a["post15VpPerRound"])
        for a, b in sample
    ) / len(sample)
    simultaneous_confidence = 1.0 - 0.05 / args.simultaneous_comparisons
    simultaneous_interval = bootstrap_ci(
        pairs,
        win_delta,
        args.bootstrap,
        args.bootstrap_seed ^ 0xB0F3,
        confidence=simultaneous_confidence,
    )
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
            "deltaBootstrapSimultaneous": {
                "confidence": simultaneous_confidence,
                "familySize": args.simultaneous_comparisons,
                **simultaneous_interval,
            },
            **(
                {"deltaBootstrap9833Simultaneous": simultaneous_interval}
                if args.simultaneous_comparisons == 3
                else {}
            ),
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
        "censoredFirst30Round": {
            "meanA": sum(float(a.get("first30Round") or 31) for a, _ in pairs) / len(pairs),
            "meanB": sum(float(b.get("first30Round") or 31) for _, b in pairs) / len(pairs),
            "meanDeltaBMinusA": finish_delta(pairs),
            "deltaBootstrap95": bootstrap_ci(
                pairs, finish_delta, args.bootstrap, args.bootstrap_seed ^ 0xF130
            ),
            "interpretation": "lower is better; failures are round 31",
        },
        "post15VpPerRound": {
            "meanA": sum(float(a["post15VpPerRound"]) for a, _ in pairs) / len(pairs),
            "meanB": sum(float(b["post15VpPerRound"]) for _, b in pairs) / len(pairs),
            "meanDeltaBMinusA": post15_delta(pairs),
            "deltaBootstrap95": bootstrap_ci(
                pairs, post15_delta, args.bootstrap, args.bootstrap_seed ^ 0xA515
            ),
        },
        "stalls": {
            "a": sum(bool(a["stalled"]) for a, _ in pairs),
            "b": sum(bool(b["stalled"]) for _, b in pairs),
        },
        "bootstrap": {
            "samples": args.bootstrap,
            "seed": args.bootstrap_seed,
            "simultaneousComparisons": args.simultaneous_comparisons,
        },
    }
    rendered = json.dumps(output, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
