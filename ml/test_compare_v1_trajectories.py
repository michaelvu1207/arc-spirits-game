"""Focused tests for scripts/compare_v1_trajectories.py.

Run directly (pytest is not required):
  ml/.venv/bin/python ml/test_compare_v1_trajectories.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from compare_v1_trajectories import run_comparison  # noqa: E402


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def trajectory_row(
    game_id: str,
    step: int,
    *,
    chosen: int = 1,
    logp: float = -0.7,
    value: float = 0.25,
    reach30: float = 0.4,
) -> dict:
    return {
        "obs": [0.1, 0.2, step],
        "cands": [[1.0, 0.0], [0.0, 1.0]],
        "chosen": chosen,
        "ret": 0.75,
        "round": step + 1,
        "vp": 3,
        "gameId": game_id,
        "stepIdx": step,
        "rStep": 0.1,
        "done": step == 1,
        "decisionType": "lockNavigation",
        "strategic": 1,
        "playerCount": 1,
        "logpOld": logp,
        "behaviorTemperature": 0.55,
        "behaviorMask": [1, 1],
        "policyMask": 1,
        "vPred": value,
        "placementProbs": [0.6, 0.2, 0.15, 0.05],
        "reach30Pred": reach30,
        "reach30Horizon": 30,
        "iter": 7,
    }


def game_summary(seed: int, *, final_vp: int = 30, wall_ms: float = 100) -> dict:
    return {
        "seed": seed,
        "seats": 1,
        "weightsOrProfiles": [f"/different/path/checkpoint-{seed}.json"],
        "rounds": 22,
        "winnerSeat": "Red",
        "finished": True,
        "stalled": False,
        "samples": 2,
        "neuralSeats": ["Red"],
        "perSeat": [
            {
                "seat": "Red",
                "finalVP": final_vp,
                "placement": 1,
                "finalStatus": 0,
                "policy": "neural",
            }
        ],
        "wallMs": wall_ms,
    }


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_passes_across_shard_order_and_ignored_metadata() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        local, socket, repeat, out = (root / name for name in ("local", "socket", "repeat", "out"))
        rows = [trajectory_row("10-1p-Red", 0), trajectory_row("10-1p-Red", 1)]
        # Deliberately split/reorder worker shards. Stable semantic keys, not file
        # order, worker assignment, or league matchup nesting must drive comparison.
        write_jsonl(local / "shard-0.jsonl", [rows[1]])
        write_jsonl(local / "m-3" / "shard-1.jsonl", [rows[0]])
        write_jsonl(
            socket / "shard-7.jsonl",
            [
                {**rows[0], "logpOld": rows[0]["logpOld"] + 1e-5, "vPred": 0.25001},
                {**rows[1], "reach30Pred": 0.40001},
            ],
        )
        repeat_rows = [
            {**rows[0], "logpOld": rows[0]["logpOld"] + 1e-5, "vPred": 0.25001},
            {**rows[1], "reach30Pred": 0.40001},
        ]
        write_jsonl(repeat / "shard-2.jsonl", [repeat_rows[1], repeat_rows[0]])
        write_jsonl(local / "m-3" / "games-0.jsonl", [game_summary(10, wall_ms=90)])
        write_jsonl(
            socket / "games-4.jsonl",
            [
                {
                    **game_summary(10, wall_ms=900),
                    "weightsOrProfiles": ["/socket/live/checkpoint.json"],
                }
            ],
        )
        write_jsonl(repeat / "games-1.jsonl", [game_summary(10, wall_ms=120)])

        report = run_comparison(local, socket, out, socket_repeat_dir=repeat)
        assert report["passed"] is True, report
        assert len(report["comparisons"]) == 2
        first = report["comparisons"][0]
        assert first["trajectory"]["commonRows"] == 2
        assert first["games"]["semanticMismatches"] == 0
        assert first["ppoRatio"]["rows"] == 2
        assert abs(first["ppoRatio"]["max"] - 1.00001000005) < 1e-9
        assert read_json(out / "parity.json")["passed"] is True
        assert read_jsonl(out / "first-divergences.jsonl") == []


def test_reports_duplicates_missing_exact_numeric_and_game_mismatches() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        local, socket, out = (root / name for name in ("local", "socket", "out"))
        local_rows = [
            trajectory_row("1-1p-Red", 0),
            trajectory_row("2-1p-Red", 0),
            trajectory_row("3-1p-Red", 0),
        ]
        socket_rows = [
            trajectory_row("1-1p-Red", 0, chosen=0),
            trajectory_row("2-1p-Red", 0, value=0.5),
        ]
        write_jsonl(local / "shard-0.jsonl", local_rows)
        write_jsonl(socket / "shard-0.jsonl", socket_rows)
        # Duplicate stable key in a different shard must not be silently overwritten.
        write_jsonl(socket / "shard-1.jsonl", [socket_rows[1]])
        write_jsonl(
            local / "games-0.jsonl",
            [game_summary(1), game_summary(2), game_summary(3)],
        )
        write_jsonl(
            socket / "games-0.jsonl",
            [game_summary(1, final_vp=29), game_summary(2)],
        )

        report = run_comparison(local, socket, out)
        comparison = report["comparisons"][0]
        assert report["passed"] is False
        assert comparison["trajectory"]["missingFromRight"] == 1
        assert comparison["trajectory"]["rowsWithExactMismatch"] == 1
        assert comparison["trajectory"]["chosenActionMismatches"] == 1
        assert comparison["numeric"]["vPred"]["rowsOutsideTolerance"] == 1
        assert comparison["games"]["missingFromRight"] == 1
        assert comparison["games"]["semanticMismatches"] == 1
        assert comparison["input"]["duplicates"] == 1
        kinds = {row["kind"] for row in read_jsonl(out / "first-divergences.jsonl")}
        assert "duplicate" in kinds
        assert "exactFieldMismatch" in kinds
        assert "numericToleranceExceeded" in kinds
        assert "missingTrajectoryRow" in kinds
        assert "gameSummaryMismatch" in kinds
        assert "missingGameSummary" in kinds


def test_cli_exit_code_and_artifacts() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        local, socket, out = (root / name for name in ("local", "socket", "out"))
        write_jsonl(local / "shard-0.jsonl", [trajectory_row("8-1p-Red", 0)])
        write_jsonl(socket / "shard-0.jsonl", [trajectory_row("8-1p-Red", 0)])
        write_jsonl(local / "games-0.jsonl", [game_summary(8)])
        write_jsonl(socket / "games-0.jsonl", [game_summary(8, wall_ms=999)])
        result = subprocess.run(
            [
                sys.executable,
                str(REPO / "scripts" / "compare_v1_trajectories.py"),
                "--local",
                str(local),
                "--socket",
                str(socket),
                "--out",
                str(out),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.startswith("PASS:")
        assert (out / "parity.json").exists()
        assert (out / "first-divergences.jsonl").exists()


def main() -> int:
    tests = [
        test_passes_across_shard_order_and_ignored_metadata,
        test_reports_duplicates_missing_exact_numeric_and_game_mismatches,
        test_cli_exit_code_and_artifacts,
    ]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {test.__name__}")
            import traceback

            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
