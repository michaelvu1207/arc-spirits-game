#!/usr/bin/env python3
"""Compare matched long-horizon league arms from immutable game artifacts.

The league's small in-generation Elo probe is intentionally weak and can saturate.
This report instead attributes only the learner seat (GameSummary.neuralSeats) and
tracks the build-convert-finish metrics that motivated v16.
"""
from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path


def pct(numerator: float, denominator: float) -> float | None:
    return round(100 * numerator / denominator, 2) if denominator else None


def mean(total: float, count: int, digits: int = 3) -> float | None:
    return round(total / count, digits) if count else None


def history_by_gen(root: Path, lane: str) -> dict[int, dict]:
    out: dict[int, dict] = {}
    path = root / "history.jsonl"
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("lane") == lane and isinstance(row.get("gen"), int):
            out[row["gen"]] = row
    return out


def learner_rows(eval_dir: Path):
    for path in sorted(eval_dir.glob("games-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                game = json.loads(line)
            except json.JSONDecodeError:
                continue
            learner_seats = set(game.get("neuralSeats") or [])
            if not learner_seats:
                continue
            for seat in game.get("perSeat") or []:
                if seat.get("seat") in learner_seats:
                    yield game, seat


TRAIN_RE = re.compile(
    r"PPO epoch \d+/\d+ .*?strategic_value_loss=([0-9.eE+-]+).*?"
    r"tactical_value_loss=([0-9.eE+-]+).*?approx_kl=([0-9.eE+-]+).*?"
    r"clip_frac=([0-9.eE+-]+)"
)
LOAD_RE = re.compile(
    r"Loaded (\d+) PPO steps.*? (\d+) strategic .*?"
    r"(\d+) malformed episode\(s\) rejected, (\d+) malformed row\(s\).*?"
    r"(\d+) missing 'obs'"
)


def trainer_metrics(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(errors="replace")
    epochs = TRAIN_RE.findall(text)
    loaded = LOAD_RE.search(text)
    out = {}
    if epochs:
        strategic, tactical, kl, clip = epochs[-1]
        out.update({
            "strategicValueLoss": float(strategic),
            "tacticalValueLoss": float(tactical),
            "approxKl": float(kl),
            "clipFraction": float(clip),
        })
    if loaded:
        steps, strategic, bad_episodes, bad_rows, missing_obs = map(int, loaded.groups())
        out.update({
            "ppoSteps": steps,
            "strategicSteps": strategic,
            "malformedEpisodes": bad_episodes,
            "malformedRows": bad_rows,
            "missingObsRows": missing_obs,
        })
    return out


def generation_metrics(root: Path, lane: str, gen: int, history: dict) -> dict | None:
    rows = list(learner_rows(root / "data" / f"gen{gen}" / f"{lane}_eval"))
    if not rows:
        return None
    games = len(rows)
    wins = reach15 = reach30 = converted = fallen = 0
    vp_sum = place_sum = post15_sum = 0.0
    decisions = optional_yields = 0
    rounds15to30_sum = 0.0
    vp_round_sum: dict[str, float] = {}
    vp_round_count: dict[str, int] = {}
    action_sum: dict[str, float] = {}
    engine_sum: dict[str, float] = {}
    for game, seat in rows:
        wins += seat.get("seat") == game.get("winnerSeat")
        vp_sum += float(seat.get("finalVP") or 0)
        place_sum += float(seat.get("placement") or 0)
        fallen += seat.get("finalStatus") == 3
        cycle = seat.get("cycle") or {}
        first15, first30 = cycle.get("first15Round"), cycle.get("first30Round")
        if first15 is not None:
            reach15 += 1
        if first30 is not None:
            reach30 += 1
        if first15 is not None and first30 is not None:
            converted += 1
            rounds15to30_sum += first30 - first15
        post15_sum += float(cycle.get("post15VpPerRound") or 0)
        decisions += int(cycle.get("decisions") or 0)
        optional_yields += int(cycle.get("optionalYieldDecisions") or 0)
        for rnd, vp in (cycle.get("vpAfterRound") or {}).items():
            vp_round_sum[rnd] = vp_round_sum.get(rnd, 0.0) + float(vp)
            vp_round_count[rnd] = vp_round_count.get(rnd, 0) + 1
        for key in ("locationInteractions", "summons", "awakens", "combats", "rewards", "pvpAttacks"):
            action_sum[key] = action_sum.get(key, 0.0) + float(cycle.get(key) or 0)
        for key in ("finalAttackDice", "finalSpirits", "finalMaxBarrier"):
            engine_sum[key] = engine_sum.get(key, 0.0) + float(cycle.get(key) or 0)
    hist = history.get(gen) or {}
    return {
        "gen": gen,
        "games": games,
        "winRatePct": pct(wins, games),
        "meanVP": mean(vp_sum, games, 2),
        "meanPlacement": mean(place_sum, games, 3),
        "fallenPct": pct(fallen, games),
        "reach15Pct": pct(reach15, games),
        "reach30Pct": pct(reach30, games),
        "conversion15To30Pct": pct(converted, reach15),
        "meanRounds15To30": mean(rounds15to30_sum, converted, 2),
        "meanPost15VpPerRound": mean(post15_sum, games, 3),
        "optionalYieldDecisionPct": pct(optional_yields, decisions),
        "meanVpAfterRound": {
            rnd: mean(total, vp_round_count[rnd], 2)
            for rnd, total in sorted(vp_round_sum.items(), key=lambda item: int(item[0]))
        },
        "meanActionsPerGame": {key: mean(total, games, 2) for key, total in sorted(action_sum.items())},
        "meanFinalEngine": {key: mean(total, games, 2) for key, total in sorted(engine_sum.items())},
        "leagueProbe": {
            "elo": hist.get("eloEstimate"),
            "pairwisePct": round(100 * hist["evalPairwiseScore"], 2)
            if hist.get("evalPairwiseScore") is not None else None,
            "poolWallMs": hist.get("poolWallMs"),
            "trainMs": hist.get("trainMs"),
        },
        "trainer": trainer_metrics(root / "data" / f"gen{gen}" / lane / "train.log"),
    }


def indexed_learner_rows(root: Path, lane: str, gens: set[int]) -> dict[tuple, tuple[dict, dict]]:
    out = {}
    for gen in sorted(gens):
        eval_dir = root / "data" / f"gen{gen}" / f"{lane}_eval"
        for game, seat in learner_rows(eval_dir):
            out[(gen, game.get("seed"), seat.get("seat"))] = (game, seat)
    return out


def bootstrap_delta(deltas: list[float], seed: int, samples: int = 4000) -> dict:
    if not deltas:
        return {"pairs": 0, "meanDelta": None, "ci95": [None, None]}
    observed = sum(deltas) / len(deltas)
    if len(deltas) == 1:
        return {"pairs": 1, "meanDelta": round(observed, 4), "ci95": [None, None]}
    rng = random.Random(seed)
    n = len(deltas)
    means = sorted(sum(rng.choices(deltas, k=n)) / n for _ in range(samples))
    lo = means[int(0.025 * samples)]
    hi = means[min(samples - 1, int(0.975 * samples))]
    return {
        "pairs": n,
        "meanDelta": round(observed, 4),
        "ci95": [round(lo, 4), round(hi, 4)],
    }


def paired_pooled(control: Path, treatment: Path, lane: str, common_gens: set[int]) -> dict:
    control_rows = indexed_learner_rows(control, lane, common_gens)
    treatment_rows = indexed_learner_rows(treatment, lane, common_gens)
    keys = sorted(set(control_rows) & set(treatment_rows))

    def optional_yield_rate(item):
        cycle = item[1].get("cycle") or {}
        decisions = int(cycle.get("decisions") or 0)
        return float(cycle.get("optionalYieldDecisions") or 0) / decisions if decisions else 0.0

    metrics = {
        "win": lambda item: float(item[1].get("seat") == item[0].get("winnerSeat")),
        "finalVP": lambda item: float(item[1].get("finalVP") or 0),
        # Negative is better for placement because first place is 1.
        "placement": lambda item: float(item[1].get("placement") or 0),
        "reach30": lambda item: float((item[1].get("cycle") or {}).get("first30Round") is not None),
        "post15VpPerRound": lambda item: float((item[1].get("cycle") or {}).get("post15VpPerRound") or 0),
        "optionalYieldRate": optional_yield_rate,
        "finalAttackDice": lambda item: float((item[1].get("cycle") or {}).get("finalAttackDice") or 0),
        "finalSpirits": lambda item: float((item[1].get("cycle") or {}).get("finalSpirits") or 0),
        "finalMaxBarrier": lambda item: float((item[1].get("cycle") or {}).get("finalMaxBarrier") or 0),
    }
    out = {"commonGenerations": sorted(common_gens), "pairedGames": len(keys), "metrics": {}}
    for index, (name, fn) in enumerate(metrics.items()):
        deltas = [fn(treatment_rows[key]) - fn(control_rows[key]) for key in keys]
        out["metrics"][name] = bootstrap_delta(deltas, seed=0xA6C500 + index)
    return out


DELTA_FIELDS = (
    "winRatePct", "meanVP", "meanPlacement", "fallenPct", "reach15Pct", "reach30Pct",
    "conversion15To30Pct", "meanRounds15To30", "meanPost15VpPerRound",
    "optionalYieldDecisionPct",
)


def compare(control: Path, treatment: Path, lane: str = "main-0") -> dict:
    histories = {"control": history_by_gen(control, lane), "treatment": history_by_gen(treatment, lane)}
    arms = {}
    for name, root in (("control", control), ("treatment", treatment)):
        gens = sorted(histories[name])
        arms[name] = [
            metrics for gen in gens
            if (metrics := generation_metrics(root, lane, gen, histories[name])) is not None
        ]
    c_by_gen = {row["gen"]: row for row in arms["control"]}
    t_by_gen = {row["gen"]: row for row in arms["treatment"]}
    deltas = []
    for gen in sorted(set(c_by_gen) & set(t_by_gen)):
        c, t = c_by_gen[gen], t_by_gen[gen]
        row = {"gen": gen}
        for key in DELTA_FIELDS:
            row[key] = round(t[key] - c[key], 3) if t.get(key) is not None and c.get(key) is not None else None
        deltas.append(row)
    common_gens = set(c_by_gen) & set(t_by_gen)
    return {
        "controlRoot": str(control), "treatmentRoot": str(treatment), "lane": lane,
        "arms": arms, "treatmentMinusControl": deltas,
        "pairedPooled": paired_pooled(control, treatment, lane, common_gens),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--control", required=True, type=Path)
    parser.add_argument("--treatment", required=True, type=Path)
    parser.add_argument("--lane", default="main-0")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = compare(args.control, args.treatment, args.lane)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
