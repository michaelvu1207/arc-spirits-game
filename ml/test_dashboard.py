"""
Tests for the balance/strength dashboard (ml/dashboard.py) on synthetic fixtures.

Run with pytest if available, or directly (the venv has no pytest):
  python3 ml/test_dashboard.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dashboard import gauntlet_tables, league_tables, summarize_games

ML_DIR = Path(__file__).parent


def game_row(seed, labels, placements, statuses, vps=None, rounds=20, finished=True):
    """One GameSummary row. labels: per-seat weightsOrProfiles list or single str."""
    seat_names = ["Red", "Blue", "Orange", "Green"][: len(placements)]
    vps = vps or [10 - 2 * (p - 1) for p in placements]
    winner = seat_names[placements.index(1)]
    return {
        "seed": seed,
        "seats": len(placements),
        "weightsOrProfiles": labels,
        "rounds": rounds,
        "winnerSeat": winner if finished else None,
        "finished": finished,
        "stalled": False,
        "samples": 10,
        "perSeat": [
            {"seat": seat_names[i], "finalVP": vps[i], "placement": placements[i],
             "finalStatus": statuses[i]}
            for i in range(len(placements))
        ],
        "wallMs": 100,
    }


def write_games(d: Path, rows: list[dict], name: str = "games-0.jsonl") -> None:
    d.mkdir(parents=True, exist_ok=True)
    with open(d / name, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

def test_summary_math():
    # candidate A wins both games (seat 0); B never wins; A corrupt once.
    rows = [
        game_row(1, ["A", "B"], [1, 2], [3, 0]),
        game_row(2, ["A", "B"], [1, 2], [0, 3]),
    ]
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        write_games(d, rows)
        rep = summarize_games(str(d))
    assert rep["games"] == 2
    a, b = rep["candidates"]["A"], rep["candidates"]["B"]
    assert a["winRatePct"] == 100.0 and b["winRatePct"] == 0.0
    assert a["placementPct"]["1"] == 100.0 and b["placementPct"]["2"] == 100.0
    assert a["finalStatusPct"]["3"] == 50.0 and b["finalStatusPct"]["3"] == 50.0
    assert a["headToHeadBetterPlace"]["B"] == 2
    assert rep["rounds"]["mean"] == 20


def test_summary_cli_back_compat():
    rows = [game_row(1, "solo", [1, 2], [0, 0])]
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        write_games(d, rows)
        # Old invocation form: no subcommand.
        r = subprocess.run(
            [sys.executable, str(ML_DIR / "dashboard.py"), str(d)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 0, r.stderr
        rep = json.loads(r.stdout)
        assert rep["games"] == 1 and rep["candidates"]["solo"]["games"] == 2


# ---------------------------------------------------------------------------
# league
# ---------------------------------------------------------------------------

def make_league_fixture(d: Path) -> None:
    (d / "league").mkdir(parents=True)
    state = {
        "version": "league-v1", "gen": 2, "phase": "idle", "updatedAt": "2026-07-02T00:00:00Z",
        "members": [
            {"id": "heur-medium", "kind": "heuristic", "createdGen": 0, "matchStats": {}},
            {"id": "main-0", "kind": "main", "createdGen": 0, "matchStats": {
                "heur-medium": {"games": 10, "better": 8, "worse": 2},
                "exp-0": {"games": 4, "better": 1, "worse": 3},
            }},
            {"id": "exp-0", "kind": "main_exploiter", "createdGen": 0, "matchStats": {
                "main-0": {"games": 4, "better": 3, "worse": 1},
            }},
        ],
    }
    (d / "league" / "state.json").write_text(json.dumps(state))
    hist = [
        {"ts": "t1", "gen": 1, "lane": "main-0", "kind": "main", "games": 8, "samples": 100,
         "opponents": {"heur-medium": 6, "exp-0": 2}, "evalGames": 4, "evalWinRate": 0.5,
         "evalPairwiseScore": 0.625, "eloEstimate": 100, "promoted": False},
        {"ts": "t2", "gen": 2, "lane": "main-0", "kind": "main", "games": 8, "samples": 110,
         "opponents": {"heur-medium": 4, "exp-0": 4}, "evalGames": 4, "evalWinRate": 0.75,
         "evalPairwiseScore": 0.75, "eloEstimate": 150, "promoted": True},
        {"ts": "t2", "gen": 2, "lane": "exp-0", "kind": "main_exploiter", "games": 8,
         "samples": 90, "opponents": {"main-0": 8}, "evalGames": 4, "evalWinRate": 0.25,
         "evalPairwiseScore": 0.4, "eloEstimate": 60, "promoted": False},
    ]
    with open(d / "league" / "history.jsonl", "w") as f:
        for r in hist:
            f.write(json.dumps(r) + "\n")
    # gen1: 2 games; corrupt seats 3/8; winner corrupt in 1/2 finished games.
    write_games(d / "league" / "data" / "gen1" / "main-0", [
        game_row(1, "ck", [1, 2, 3, 4], [3, 0, 0, 0]),   # winner corrupted
        game_row(2, "ck", [2, 1, 4, 3], [0, 0, 3, 3]),   # winner clean
    ])
    # eval dir must be EXCLUDED from corruption scanning.
    write_games(d / "league" / "data" / "gen1" / "main-0_eval", [
        game_row(9, "ck", [1, 2], [3, 3]),
    ])
    # gen2: all clean.
    write_games(d / "league" / "data" / "gen2" / "main-0", [
        game_row(3, "ck", [1, 2, 3, 4], [0, 0, 0, 0]),
    ])


def test_league_tables():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        make_league_fixture(d)
        t = league_tables(d / "league")

    main = t["lanes"]["main-0"]
    assert [e["gen"] for e in main] == [1, 2]
    assert [e["elo"] for e in main] == [100, 150]
    assert main[0]["winRatePct"] == 50.0 and main[1]["promoted"] is True
    assert main[1]["pairwisePct"] == 75.0

    m = t["matrix"]["main-0"]
    assert m["heur-medium"]["betterRatePct"] == 80.0  # 8 of 10 decided
    assert m["exp-0"]["betterRatePct"] == 25.0
    assert "heur-medium" not in t["matrix"]  # empty matchStats members excluded

    assert t["exposure"]["main-0"] == {"exp-0": 6, "heur-medium": 10}

    c = t["corruption"]["main-0"]
    assert c[1]["games"] == 2
    assert c[1]["corruptSeatPct"] == 37.5      # 3 of 8 seats (eval dir excluded)
    assert c[1]["winnerCorruptPct"] == 50.0    # 1 of 2 finished winners
    assert c[2]["corruptSeatPct"] == 0.0 and c[2]["winnerCorruptPct"] == 0.0


# ---------------------------------------------------------------------------
# gauntlet
# ---------------------------------------------------------------------------

def make_gauntlet_fixture(d: Path) -> None:
    d.mkdir(parents=True)
    full = {
        "gauntletVersion": "gauntlet-v1", "games": 800, "smoke": False,
        "candidate": {"kind": "weights", "ref": "x.json", "slug": "cand-full"},
        "eloVsAnchors": {"aggregate": {"games": 2400, "score": 0.78, "elo": 221},
                         "perAnchor": {"medium": {"games": 200, "score": 0.9, "elo": 331},
                                       "insane": {"games": 200, "score": 0.7, "elo": 150}}},
        "winRate": 0.61, "meanPlacement": 1.7, "meanVP": 21.5, "timestamp": "t0",
    }
    smoke = {
        "gauntletVersion": "gauntlet-v1", "games": 40, "smoke": True,
        "candidate": {"kind": "weights", "ref": "y.json", "slug": "cand-smoke"},
        "eloVsAnchors": {"aggregate": {"games": 120, "score": 0.5, "elo": 10},
                         "perAnchor": {"medium": {"games": 60, "score": 0.5, "elo": 10}}},
        "winRate": 0.25, "meanPlacement": 2.5, "meanVP": 10.0, "timestamp": "t1",
    }
    (d / "cand-full.json").write_text(json.dumps(full))
    (d / "cand-smoke.json").write_text(json.dumps(smoke))
    (d / "not-a-result.json").write_text(json.dumps({"bench": True}))  # must be skipped
    with open(d / "history.jsonl", "w") as f:
        f.write(json.dumps({"ts": "t0", "rev": "abc", "weights": "x.json", "elo": 221,
                            "games": 800, "smoke": False, "winRate": 0.61}) + "\n")
        f.write(json.dumps({"ts": "t1", "rev": "def", "weights": "x.json", "elo": 230,
                            "games": 40, "smoke": True, "winRate": 0.63}) + "\n")


def test_gauntlet_tables():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "res"
        make_gauntlet_fixture(d)
        t = gauntlet_tables(d)
    slugs = [c["slug"] for c in t["candidates"]]
    assert slugs == ["cand-full", "cand-smoke"]  # sorted by elo desc, bench skipped
    full = t["candidates"][0]
    assert full["elo"] == 221 and full["smoke"] is False and full["scorePct"] == 78.0
    assert full["worstAnchor"] == "insane (150)" and full["bestAnchor"] == "medium (331)"
    assert len(t["history"]) == 2
    assert t["history"][1]["smoke"] is True and t["history"][1]["elo"] == 230


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def test_report_rolls_up_everything():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        make_league_fixture(d)
        make_gauntlet_fixture(d / "gres")
        games_dir = d / "pool"
        write_games(games_dir, [game_row(1, ["A", "B"], [1, 2], [3, 0])])
        out = d / "report.md"
        r = subprocess.run(
            [sys.executable, str(ML_DIR / "dashboard.py"), "report",
             "--games", str(games_dir),
             "--league-dir", str(d / "league"),
             "--results-dir", str(d / "gres"),
             "--out", str(out)],
            capture_output=True, text=True, timeout=60,
        )
        assert r.returncode == 0, r.stderr
        md = out.read_text()
    for needle in [
        "# Arc Spirits balance/strength report",
        "## Pool summary", "## League", "## Gauntlet",
        "PFSP matchup matrix", "Corruption attractor", "Nightly Elo time series",
        "cand-full", "37.5",  # corruption number survives into the roll-up
    ]:
        assert needle in md, f"missing {needle!r} in report"
    # Missing sources degrade gracefully.
    with tempfile.TemporaryDirectory() as td2:
        r2 = subprocess.run(
            [sys.executable, str(ML_DIR / "dashboard.py"), "report",
             "--league-dir", str(Path(td2) / "none"),
             "--results-dir", str(Path(td2) / "none2")],
            capture_output=True, text=True, timeout=60,
        )
        assert r2.returncode == 0, r2.stderr
        assert "no league data" in r2.stdout and "no gauntlet results" in r2.stdout


def main() -> int:
    tests = [
        test_summary_math,
        test_summary_cli_back_compat,
        test_league_tables,
        test_gauntlet_tables,
        test_report_rolls_up_everything,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
