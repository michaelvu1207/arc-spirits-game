#!/usr/bin/env python3
"""Balance/strength dashboard over the real training artifacts (M4).

Data sources:
  - games-*.jsonl        actor-pool per-game summaries (poolTypes.ts GameSummary)
  - ml/league/           league manager state.json + history.jsonl + data/gen*/<lane>/
  - ml/gauntlet_results/ gauntlet runner *.json + nightly history.jsonl (Elo series)

Commands:
  summary  <dir-or-glob>       per-candidate win/placement/VP/corruption aggregates
                               (original behavior; `dashboard.py <spec>` still works)
  league   [--league-dir D]    per-lane Elo/winrate trajectory across generations,
                               PFSP matchup matrix, training exposure, and the
                               corruption-attractor metric (finalStatus==3 share)
                               per lane per generation
  gauntlet [--results-dir D]   Elo vs the fixed gauntlet-v1 anchors per candidate +
                               the nightly Elo time series (smoke runs marked)
  report   [--out F.md] ...    one markdown roll-up of all three (tables only)

league/gauntlet print markdown to stdout (--json for machine output).

Corruption attribution: rows written since GameSummary.neuralSeats landed carry
per-seat learner attribution, so learnerCorruptPct (finalStatus==3 share over the
LEARNER's seats only) answers "did the learner itself corrupt?" directly. Rows
without neuralSeats fall back to corruptSeatPct — ALL seats of that lane's
training-pool games (data/gen*/<lane>/, _eval dirs excluded). winnerCorruptPct —
the share of finished games whose WINNER ended at status 3 — remains the
attribution-free corruption-attractor signal.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


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


# ---------------------------------------------------------------------------
# summary — per-candidate aggregates from games-*.jsonl (original behavior)
# ---------------------------------------------------------------------------

def summarize_games(spec: str) -> dict:
    games = 0
    by_candidate = defaultdict(lambda: {
        "games": 0, "wins": 0, "placements": defaultdict(int),
        "vp_sum": 0.0, "vp_max": 0.0, "status": defaultdict(int),
    })
    rounds_all = []
    h2h = defaultdict(lambda: defaultdict(int))  # cand -> opponent-cand -> better-placement count

    for row in load_rows(spec):
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
    return report


# ---------------------------------------------------------------------------
# league — trajectory, PFSP matrix, exposure, corruption per lane/generation
# ---------------------------------------------------------------------------

def league_tables(league_dir: str | Path, corruption: bool = True) -> dict:
    league_dir = Path(league_dir)
    out: dict = {"leagueDir": str(league_dir), "lanes": {}, "matrix": {}, "exposure": {},
                 "corruption": {}, "state": None}

    state_path = league_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
        out["state"] = {"version": state.get("version"), "gen": state.get("gen"),
                        "phase": state.get("phase"), "updatedAt": state.get("updatedAt"),
                        "members": [m.get("id") for m in state.get("members", [])]}
        for m in state.get("members", []):
            stats = m.get("matchStats") or {}
            if not stats:
                continue
            row = {}
            for opp, s in sorted(stats.items()):
                better, worse, games = s.get("better", 0), s.get("worse", 0), s.get("games", 0)
                decided = better + worse
                row[opp] = {"games": games, "better": better, "worse": worse,
                            "betterRatePct": pct(better, decided)}
            out["matrix"][m["id"]] = row

    history_path = league_dir / "history.jsonl"
    if history_path.exists():
        with open(history_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                lane = r.get("lane", "?")
                out["lanes"].setdefault(lane, []).append({
                    "gen": r.get("gen"),
                    "elo": r.get("eloEstimate"),
                    "winRatePct": pct(r.get("evalWinRate", 0) * r.get("evalGames", 0),
                                      r.get("evalGames", 0)) if r.get("evalGames") else None,
                    "pairwisePct": round(100 * r["evalPairwiseScore"], 1)
                    if r.get("evalPairwiseScore") is not None else None,
                    "games": r.get("games"),
                    "samples": r.get("samples"),
                    "promoted": bool(r.get("promoted")),
                })
                exp = out["exposure"].setdefault(lane, defaultdict(int))
                for opp, n in (r.get("opponents") or {}).items():
                    exp[opp] += int(n)
        for lane in out["lanes"]:
            out["lanes"][lane].sort(key=lambda x: (x["gen"] is None, x["gen"]))
        out["exposure"] = {lane: dict(sorted(v.items())) for lane, v in out["exposure"].items()}

    if corruption:
        data_dir = league_dir / "data"
        if data_dir.is_dir():
            for gen_dir in sorted(data_dir.glob("gen*"),
                                  key=lambda p: int(re.sub(r"\D", "", p.name) or 0)):
                m = re.match(r"gen(\d+)$", gen_dir.name)
                if not m:
                    continue
                gen = int(m.group(1))
                for lane_dir in sorted(p for p in gen_dir.iterdir() if p.is_dir()):
                    if lane_dir.name.endswith("_eval"):
                        continue  # training-pool games only (see attribution caveat)
                    n_games = n_seats = n_corrupt = n_finished = n_winner_corrupt = 0
                    n_learner_seats = n_learner_corrupt = 0
                    for row in load_rows(str(lane_dir)):
                        seats = row.get("perSeat") or []
                        if not seats:
                            continue
                        n_games += 1
                        n_seats += len(seats)
                        n_corrupt += sum(1 for s in seats if s.get("finalStatus") == 3)
                        # Learner-only attribution (GameSummary.neuralSeats = seats the
                        # LEARNER policy drove; league-opponent seats excluded upstream).
                        learners = set(row.get("neuralSeats") or [])
                        if learners:
                            for s in seats:
                                if s.get("seat") in learners:
                                    n_learner_seats += 1
                                    if s.get("finalStatus") == 3:
                                        n_learner_corrupt += 1
                        winner = row.get("winnerSeat")
                        if row.get("finished") and winner is not None:
                            n_finished += 1
                            ws = next((s for s in seats if s.get("seat") == winner), None)
                            if ws is not None and ws.get("finalStatus") == 3:
                                n_winner_corrupt += 1
                    if n_games:
                        out["corruption"].setdefault(lane_dir.name, {})[gen] = {
                            "games": n_games,
                            "corruptSeatPct": pct(n_corrupt, n_seats),
                            # None when no row carried neuralSeats (pre-attribution data).
                            "learnerCorruptPct": pct(n_learner_corrupt, n_learner_seats)
                            if n_learner_seats else None,
                            "winnerCorruptPct": pct(n_winner_corrupt, n_finished),
                        }
    return out


# ---------------------------------------------------------------------------
# gauntlet — Elo vs the fixed anchors + nightly time series
# ---------------------------------------------------------------------------

def gauntlet_tables(results_dir: str | Path) -> dict:
    results_dir = Path(results_dir)
    out: dict = {"resultsDir": str(results_dir), "candidates": [], "history": []}
    if not results_dir.is_dir():
        return out

    for p in sorted(results_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if d.get("gauntletVersion") is None:  # not a gauntlet result (e.g. bench files)
            continue
        anchors = (d.get("eloVsAnchors") or {}).get("perAnchor") or {}
        worst = min(anchors.items(), key=lambda kv: kv[1].get("elo", 0), default=None)
        best = max(anchors.items(), key=lambda kv: kv[1].get("elo", 0), default=None)
        agg = (d.get("eloVsAnchors") or {}).get("aggregate") or {}
        out["candidates"].append({
            "slug": (d.get("candidate") or {}).get("slug") or p.stem,
            "elo": agg.get("elo"),
            "scorePct": round(100 * agg["score"], 1) if agg.get("score") is not None else None,
            "games": d.get("games"),
            "smoke": bool(d.get("smoke")),
            "winRatePct": round(100 * d["winRate"], 1) if d.get("winRate") is not None else None,
            "meanPlacement": d.get("meanPlacement"),
            "meanVP": d.get("meanVP"),
            "worstAnchor": f"{worst[0]} ({worst[1].get('elo')})" if worst else None,
            "bestAnchor": f"{best[0]} ({best[1].get('elo')})" if best else None,
            "timestamp": d.get("timestamp"),
        })
    out["candidates"].sort(key=lambda c: (c["elo"] is None, -(c["elo"] or 0)))

    history_path = results_dir / "history.jsonl"
    if history_path.exists():
        with open(history_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                out["history"].append({
                    "ts": r.get("ts"), "rev": r.get("rev"),
                    "weights": r.get("weights"), "elo": r.get("elo"),
                    "games": r.get("games"), "smoke": bool(r.get("smoke")),
                    "winRatePct": round(100 * r["winRate"], 1) if r.get("winRate") is not None else None,
                })
    return out


# ---------------------------------------------------------------------------
# markdown rendering
# ---------------------------------------------------------------------------

def md_table(headers: list[str], rows: list[list]) -> str:
    def cell(v):
        return "-" if v is None else str(v)
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        lines.append("| " + " | ".join(cell(v) for v in r) + " |")
    return "\n".join(lines)


def render_summary_md(report: dict, spec: str) -> str:
    lines = [f"## Pool summary — `{spec}`", "",
             f"{report['games']} games; rounds mean {report['rounds'].get('mean', '-')} "
             f"(p50 {report['rounds'].get('p50', '-')}, p90 {report['rounds'].get('p90', '-')})", ""]
    rows = []
    for label, c in report["candidates"].items():
        rows.append([
            os.path.basename(label)[:48], c["games"], c["winRatePct"], c["meanVP"],
            c["placementPct"].get("1"), c["finalStatusPct"].get("3"),
        ])
    lines.append(md_table(
        ["candidate", "seat-games", "win %", "mean VP", "1st %", "corrupt %"], rows))
    return "\n".join(lines)


def render_league_md(t: dict) -> str:
    lines = [f"## League — `{t['leagueDir']}`", ""]
    if t.get("state"):
        s = t["state"]
        lines += [f"{s['version']} | gen {s['gen']} | phase {s['phase']} | "
                  f"{len(s['members'])} members | updated {s['updatedAt']}", ""]
    if t["lanes"]:
        lines += ["### Per-lane trajectory (Elo estimate / eval winrate)", ""]
        rows = []
        for lane in sorted(t["lanes"]):
            for e in t["lanes"][lane]:
                rows.append([lane, e["gen"], e["elo"], e["winRatePct"], e["pairwisePct"],
                             e["games"], e["samples"], "Y" if e["promoted"] else "-"])
        lines.append(md_table(
            ["lane", "gen", "elo", "win %", "pairwise %", "games", "samples", "promoted"], rows))
        lines.append("")
        for lane in sorted(t["lanes"]):
            elos = [str(e["elo"]) for e in t["lanes"][lane]]
            lines.append(f"- **{lane}** Elo: {' -> '.join(elos)}")
        lines.append("")
    if t["matrix"]:
        lines += ["### PFSP matchup matrix (better-placement rate %, decided games)", ""]
        opponents = sorted({o for row in t["matrix"].values() for o in row})
        rows = []
        for lane in sorted(t["matrix"]):
            r = [lane]
            for opp in opponents:
                s = t["matrix"][lane].get(opp)
                r.append(f"{s['betterRatePct']}% ({s['games']})" if s else None)
            rows.append(r)
        lines.append(md_table(["lane \\ opponent"] + opponents, rows))
        lines.append("")
    if t["exposure"]:
        lines += ["### Training exposure (pool games by opponent)", ""]
        opponents = sorted({o for row in t["exposure"].values() for o in row})
        rows = [[lane] + [t["exposure"][lane].get(o) for o in opponents]
                for lane in sorted(t["exposure"])]
        lines.append(md_table(["lane \\ opponent"] + opponents, rows))
        lines.append("")
    if t["corruption"]:
        lines += ["### Corruption attractor (finalStatus==3), training pools per lane/gen", ""]
        rows = []
        for lane in sorted(t["corruption"]):
            for gen in sorted(t["corruption"][lane]):
                c = t["corruption"][lane][gen]
                lc = c.get("learnerCorruptPct")
                rows.append([lane, gen, c["games"], c["corruptSeatPct"],
                             lc if lc is not None else c["corruptSeatPct"],
                             c["winnerCorruptPct"]])
        lines.append(md_table(
            ["lane", "gen", "games", "corrupt seats %", "learner corrupt %",
             "winner corrupt %"], rows))
        lines += ["", "_learner corrupt % = finalStatus==3 share over the LEARNER's seats "
                  "only (GameSummary.neuralSeats); falls back to the all-seats number for "
                  "rows without attribution. corrupt seats % = share of ALL seats; winner "
                  "corrupt % = share of finished games whose winner ended corrupted._"]
    return "\n".join(lines)


def render_gauntlet_md(t: dict) -> str:
    lines = [f"## Gauntlet (fixed gauntlet-v1 anchors) — `{t['resultsDir']}`", ""]
    if t["candidates"]:
        rows = [[c["slug"][:48], c["elo"], c["scorePct"], c["games"],
                 "smoke" if c["smoke"] else "full", c["winRatePct"], c["meanPlacement"],
                 c["worstAnchor"], c["bestAnchor"]] for c in t["candidates"]]
        lines.append(md_table(
            ["candidate", "elo", "score %", "games", "run", "win %", "mean place",
             "worst anchor", "best anchor"], rows))
        lines.append("")
    if t["history"]:
        lines += ["### Nightly Elo time series", ""]
        rows = [[h["ts"], os.path.basename(str(h["weights"]))[:40], h["elo"],
                 h["winRatePct"], h["games"], "smoke" if h["smoke"] else "full", h["rev"]]
                for h in t["history"]]
        lines.append(md_table(["ts", "weights", "elo", "win %", "games", "run", "rev"], rows))
    elif t["candidates"]:
        lines.append("_no nightly history.jsonl yet — table above is per-candidate results._")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_summary(args) -> int:
    report = summarize_games(args.spec)
    out = json.dumps(report, indent=2)
    print(out)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out + "\n")
    return 0


def cmd_league(args) -> int:
    t = league_tables(args.league_dir, corruption=not args.no_corruption)
    print(json.dumps(t, indent=2) if args.json else render_league_md(t))
    return 0


def cmd_gauntlet(args) -> int:
    t = gauntlet_tables(args.results_dir)
    print(json.dumps(t, indent=2) if args.json else render_gauntlet_md(t))
    return 0


def cmd_report(args) -> int:
    parts = ["# Arc Spirits balance/strength report", ""]
    if args.games:
        parts += [render_summary_md(summarize_games(args.games), args.games), ""]
    league_t = league_tables(args.league_dir)
    if league_t["lanes"] or league_t["matrix"] or league_t["corruption"]:
        parts += [render_league_md(league_t), ""]
    else:
        parts += [f"_no league data under `{args.league_dir}`_", ""]
    gauntlet_t = gauntlet_tables(args.results_dir)
    if gauntlet_t["candidates"] or gauntlet_t["history"]:
        parts += [render_gauntlet_md(gauntlet_t), ""]
    else:
        parts += [f"_no gauntlet results under `{args.results_dir}`_", ""]
    md = "\n".join(parts)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md + "\n")
        print(f"report written: {args.out}")
    else:
        print(md)
    return 0


COMMANDS = {"summary", "league", "gauntlet", "report"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    # Back-compat: `dashboard.py <dir-or-glob>` (no subcommand) == summary.
    if argv and argv[0] not in COMMANDS and not argv[0].startswith("-"):
        argv = ["summary"] + argv
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("summary", help="per-candidate aggregates from games-*.jsonl")
    s.add_argument("spec", help="directory containing games-*.jsonl, or a glob")
    s.add_argument("--out", default=None, help="also write the JSON report here")
    s.set_defaults(fn=cmd_summary)

    l = sub.add_parser("league", help="lane trajectories, PFSP matrix, corruption")
    l.add_argument("--league-dir", default="ml/league")
    l.add_argument("--no-corruption", action="store_true",
                   help="skip scanning data/gen*/ games files")
    l.add_argument("--json", action="store_true")
    l.set_defaults(fn=cmd_league)

    g = sub.add_parser("gauntlet", help="Elo vs anchors + nightly time series")
    g.add_argument("--results-dir", default="ml/gauntlet_results")
    g.add_argument("--json", action="store_true")
    g.set_defaults(fn=cmd_gauntlet)

    r = sub.add_parser("report", help="markdown roll-up of summary+league+gauntlet")
    r.add_argument("--games", default=None, help="optional games-*.jsonl dir/glob for the summary section")
    r.add_argument("--league-dir", default="ml/league")
    r.add_argument("--results-dir", default="ml/gauntlet_results")
    r.add_argument("--out", default=None, help="write the markdown here (default: stdout)")
    r.set_defaults(fn=cmd_report)

    return ap.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
