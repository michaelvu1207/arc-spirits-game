#!/usr/bin/env python3
"""Fail-closed paired analysis for two solo league objective arms."""

from __future__ import annotations

import argparse
import glob
import json
import math
import random
import subprocess
from pathlib import Path
from statistics import fmean
from typing import Any, Iterable


def _lines(path: Path) -> Iterable[str]:
    if path.suffix != ".zst":
        with path.open(encoding="utf-8") as handle:
            yield from handle
        return
    result = subprocess.run(
        ["zstd", "-dc", "--", str(path)],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    yield from result.stdout.splitlines()


def load_eval(root: Path, gen: int, lane: str) -> dict[int, dict[str, Any]]:
    eval_dir = root / "data" / f"gen{gen}" / f"{lane}_eval"
    paths = sorted(
        Path(path)
        for pattern in ("games-*.jsonl", "games-*.jsonl.zst")
        for path in glob.glob(str(eval_dir / pattern))
    )
    if not paths:
        raise ValueError(f"no evaluation game files under {eval_dir}")
    games: dict[int, dict[str, Any]] = {}
    for path in paths:
        for line in _lines(path):
            if not line.strip():
                continue
            game = json.loads(line)
            seed = game.get("seed")
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise ValueError(f"invalid evaluation seed in {path}: {seed!r}")
            if seed in games:
                raise ValueError(f"duplicate evaluation seed {seed} under {eval_dir}")
            if not isinstance(game.get("perSeat"), list) or len(game["perSeat"]) != 1:
                raise ValueError(f"seed {seed} is not a one-seat evaluation")
            games[seed] = game
    return games


def load_history(root: Path, gen: int, lane: str) -> dict[str, Any]:
    path = root / "history.jsonl"
    matches = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                row = json.loads(line)
                if row.get("gen") == gen and row.get("lane") == lane:
                    matches.append(row)
    if len(matches) != 1:
        raise ValueError(f"expected one history row for gen={gen} lane={lane}, got {len(matches)}")
    return matches[0]


def _seat(game: dict[str, Any]) -> dict[str, Any]:
    return game["perSeat"][0]


def _first30(game: dict[str, Any]) -> int | None:
    value = _seat(game).get("cycle", {}).get("first30Round")
    return value if isinstance(value, int) and not isinstance(value, bool) and value <= 30 else None


def _metric(game: dict[str, Any], name: str) -> float:
    seat = _seat(game)
    cycle = seat.get("cycle", {})
    source = cycle if name in cycle else seat
    value = source.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"seed {game['seed']} has invalid {name}: {value!r}")
    return float(value)


def _bootstrap_ci(values: list[float], *, samples: int, seed: int) -> list[float]:
    if not values:
        raise ValueError("cannot bootstrap an empty paired sample")
    rng = random.Random(seed)
    n = len(values)
    means = sorted(fmean(values[rng.randrange(n)] for _ in range(n)) for _ in range(samples))
    lo = means[max(0, math.floor(0.025 * samples))]
    hi = means[min(samples - 1, math.ceil(0.975 * samples) - 1)]
    return [lo, hi]


def _mcnemar_exact(control_only: int, treatment_only: int) -> float:
    discordant = control_only + treatment_only
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, k) for k in range(min(control_only, treatment_only) + 1))
    return min(1.0, 2.0 * tail / (2**discordant))


def analyze_pair(
    control_root: Path,
    treatment_root: Path,
    *,
    gen: int,
    lane: str = "main-0",
    bootstrap_samples: int = 10_000,
    bootstrap_seed: int = 26001,
) -> dict[str, Any]:
    if bootstrap_samples < 100:
        raise ValueError("bootstrap_samples must be at least 100")
    control = load_eval(control_root, gen, lane)
    treatment = load_eval(treatment_root, gen, lane)
    if control.keys() != treatment.keys():
        missing_control = sorted(treatment.keys() - control.keys())
        missing_treatment = sorted(control.keys() - treatment.keys())
        raise ValueError(
            "evaluation seed sets differ: "
            f"missing control={missing_control[:10]} missing treatment={missing_treatment[:10]}"
        )
    seeds = sorted(control)
    control_reach = [_first30(control[seed]) is not None for seed in seeds]
    treatment_reach = [_first30(treatment[seed]) is not None for seed in seeds]
    reach_delta = [float(treatment_reach[i]) - float(control_reach[i]) for i in range(len(seeds))]
    control_only = sum(c and not t for c, t in zip(control_reach, treatment_reach))
    treatment_only = sum(t and not c for c, t in zip(control_reach, treatment_reach))

    metric_names = [
        "finalVP",
        "finalSpirits",
        "finalAttackDice",
        "finalMaxBarrier",
        "post15VpPerRound",
        "decisions",
    ]
    metrics: dict[str, Any] = {}
    for offset, name in enumerate(metric_names, start=1):
        c_values = [_metric(control[seed], name) for seed in seeds]
        t_values = [_metric(treatment[seed], name) for seed in seeds]
        deltas = [t - c for c, t in zip(c_values, t_values)]
        metrics[name] = {
            "controlMean": fmean(c_values),
            "treatmentMean": fmean(t_values),
            "pairedMeanDelta": fmean(deltas),
            "pairedBootstrap95CI": _bootstrap_ci(
                deltas, samples=bootstrap_samples, seed=bootstrap_seed + offset
            ),
        }

    control_censored = [float(_first30(control[seed]) or 31) for seed in seeds]
    treatment_censored = [float(_first30(treatment[seed]) or 31) for seed in seeds]
    censored_delta = [t - c for c, t in zip(control_censored, treatment_censored)]
    metrics["censoredFirst30Round"] = {
        "controlMean": fmean(control_censored),
        "treatmentMean": fmean(treatment_censored),
        "pairedMeanDelta": fmean(censored_delta),
        "pairedBootstrap95CI": _bootstrap_ci(
            censored_delta, samples=bootstrap_samples, seed=bootstrap_seed + 100
        ),
        "interpretation": "lower is better; failures are encoded as round 31",
    }

    control_history = load_history(control_root, gen, lane)
    treatment_history = load_history(treatment_root, gen, lane)
    paired_fields = [
        "catalogPath",
        "catalogSha256",
        "games",
        "trainerSeed",
        "optimizerStepsPerEpoch",
        "optimizerStepsTotal",
        "evalGames",
    ]
    mismatches = {
        field: [control_history.get(field), treatment_history.get(field)]
        for field in paired_fields
        if control_history.get(field) != treatment_history.get(field)
    }
    if mismatches:
        raise ValueError(f"paired history fields differ: {mismatches}")

    return {
        "schemaVersion": 1,
        "generation": gen,
        "lane": lane,
        "controlRoot": str(control_root),
        "treatmentRoot": str(treatment_root),
        "pairedSeeds": len(seeds),
        "seedRange": [seeds[0], seeds[-1]],
        "pairedHistory": {field: control_history.get(field) for field in paired_fields},
        "trainingSamples": {
            "control": control_history.get("samples"),
            "treatment": treatment_history.get("samples"),
        },
        "reach30": {
            "control": sum(control_reach),
            "treatment": sum(treatment_reach),
            "controlRate": fmean(float(value) for value in control_reach),
            "treatmentRate": fmean(float(value) for value in treatment_reach),
            "pairedRateDelta": fmean(reach_delta),
            "pairedBootstrap95CI": _bootstrap_ci(
                reach_delta, samples=bootstrap_samples, seed=bootstrap_seed
            ),
            "controlOnly": control_only,
            "treatmentOnly": treatment_only,
            "mcnemarExactTwoSidedP": _mcnemar_exact(control_only, treatment_only),
        },
        "stalls": {
            "control": sum(bool(control[seed].get("stalled")) for seed in seeds),
            "treatment": sum(bool(treatment[seed].get("stalled")) for seed in seeds),
        },
        "metrics": metrics,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--control-root", type=Path, required=True)
    parser.add_argument("--treatment-root", type=Path, required=True)
    parser.add_argument("--gen", type=int, required=True)
    parser.add_argument("--lane", default="main-0")
    parser.add_argument("--bootstrap-samples", type=int, default=10_000)
    parser.add_argument("--bootstrap-seed", type=int, default=26001)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = analyze_pair(
        args.control_root,
        args.treatment_root,
        gen=args.gen,
        lane=args.lane,
        bootstrap_samples=args.bootstrap_samples,
        bootstrap_seed=args.bootstrap_seed,
    )
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
