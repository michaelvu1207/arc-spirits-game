#!/usr/bin/env python3
"""Aggregate per-game summary JSONL (games-*.jsonl from the actor pool) into the
balance/strength report that feeds the M4 dashboard (BOT_TAKEOVER_PLAN.md).

Input rows: {seed, seats, weightsOrProfiles, rounds, winnerSeat,
             perSeat: [{seat, finalVP, placement, finalStatus}], wallMs}

Usage:
  python3 ml/dashboard.py <dir-or-glob> [--out report.json]

Emits (stdout + optional --out): per-candidate win rate / placement / VP
distributions, corruption (finalStatus) distribution, rounds-to-finish stats,
and head-to-head placement matrix. Extend with per-round VP curves and
spirit/class pick rates once trajectory traces carry them (M4).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import defaultdict


def load_rows(spec: str):
    paths = sorted(glob.glob(os.path.join(spec, "games-*.jsonl"))) if os.path.isdir(spec) else sorted(glob.glob(spec))
    for p in paths:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def pct(x, n):
    return round(100.0 * x / n, 2) if n else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", help="directory containing games-*.jsonl, or a glob")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    games = 0
    by_candidate = defaultdict(lambda: {
        "games": 0, "wins": 0, "placements": defaultdict(int),
        "vp_sum": 0.0, "vp_max": 0.0, "status": defaultdict(int),
    })
    rounds_all = []
    h2h = defaultdict(lambda: defaultdict(int))  # cand -> opponent-cand -> better-placement count

    for row in load_rows(args.spec):
        seats = row.get("perSeat") or []
        if not seats:
            continue
        games += 1
        rounds_all.append(row.get("rounds", 0))
        # weightsOrProfiles may be a single label or per-seat list
        wop = row.get("weightsOrProfiles")
        labels = wop if isinstance(wop, list) else [wop] * len(seats)
        for i, s in enumerate(seats):
            label = str(labels[i] if i < len(labels) else wop)
            c = by_candidate[label]
            c["games"] += 1
            c["vp_sum"] += s.get("finalVP", 0)
            c["vp_max"] = max(c["vp_max"], s.get("finalVP", 0))
            c["placements"][s.get("placement", 0)] += 1
            c["status"][s.get("finalStatus", -1)] += 1
            if s.get("seat") == row.get("winnerSeat"):
                c["wins"] += 1
            for j, o in enumerate(seats):
                if i == j:
                    continue
                ol = str(labels[j] if j < len(labels) else wop)
                if s.get("placement", 9) < o.get("placement", 9):
                    h2h[label][ol] += 1

    report = {"games": games, "candidates": {}, "rounds": {}}
    if rounds_all:
        rs = sorted(rounds_all)
        report["rounds"] = {
            "mean": round(sum(rs) / len(rs), 2),
            "p50": rs[len(rs) // 2], "p90": rs[int(0.9 * len(rs))],
        }
    for label, c in sorted(by_candidate.items()):
        n = c["games"]
        report["candidates"][label] = {
            "games": n,
            "winRatePct": pct(c["wins"], n),
            "meanVP": round(c["vp_sum"] / n, 2) if n else None,
            "maxVP": c["vp_max"],
            "placementPct": {str(k): pct(v, n) for k, v in sorted(c["placements"].items())},
            "finalStatusPct": {str(k): pct(v, n) for k, v in sorted(c["status"].items())},
            "headToHeadBetterPlace": dict(h2h.get(label, {})),
        }

    out = json.dumps(report, indent=2)
    print(out)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
