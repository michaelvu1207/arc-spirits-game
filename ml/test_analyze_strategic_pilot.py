from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from analyze_strategic_pilot import analyze


def summary(seed: int, baseline_win: bool, teacher_win: bool) -> dict:
    outcome = lambda win: {
        "reached30": win,
        "finalVP": 30 if win else 20,
        "post15VpPerRound": 1.0 if win else 0.5,
        "stalled": False,
    }
    counters = {
        "evaluations": 10,
        "decisive": 2,
        "changed": 1,
        "nonDecisiveAbstentions": 8,
        "invalidAbstentions": 0,
        "candidateRollouts": 100,
        "candidateRolloutStalls": 0,
        "byRoundBand": {
            "11-20": {"evaluations": 10, "decisive": 2, "changed": 1}
        },
    }
    row = {
        "seed": seed,
        "guardian": "Pixia",
        "baseline": outcome(baseline_win),
        "teacher": outcome(teacher_win),
        "counters": counters,
    }
    return {
        "mode": "loop",
        "family": "combined",
        "sourceCommit": "abc123",
        "checkpointSha256": "checkpoint",
        "catalogSha256": "catalog",
        "rollouts": 8,
        "maxStatusLevel": 2,
        "navigationMinRound": 1,
        "navigationMaxLogitGap": 9.0,
        "games": 1,
        "seedBase": seed,
        "baselineWins": int(baseline_win),
        "teacherWins": int(teacher_win),
        "paired": [row],
    }


class StrategicPilotAnalyzerTest(unittest.TestCase):
    def test_validates_and_aggregates_exact_paired_seed_block(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "shard-0.jsonl.summary.json").write_text(
                json.dumps(summary(100, False, True))
            )
            (root / "shard-1.jsonl.summary.json").write_text(
                json.dumps(summary(101, True, True))
            )
            report = analyze(
                root,
                expected_games=2,
                bootstrap=200,
                bootstrap_seed=7,
                wrapper_timeouts=1,
            )
        self.assertEqual(report["games"], 2)
        self.assertEqual(report["seed0"], 100)
        self.assertEqual(report["seedLast"], 101)
        self.assertEqual(report["pairedOutcomes"]["teacherOnlyWin"], 1)
        self.assertEqual(report["intervention"]["evaluatedGameRate"], 1.0)
        self.assertEqual(report["artifactValidation"]["wrapperTimeoutsAfterSummary"], 1)

    def test_rejects_provenance_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            first = summary(100, False, False)
            second = summary(101, False, False)
            second["catalogSha256"] = "different"
            (root / "shard-0.jsonl.summary.json").write_text(json.dumps(first))
            (root / "shard-1.jsonl.summary.json").write_text(json.dumps(second))
            with self.assertRaisesRegex(ValueError, "provenance mismatch catalogSha256"):
                analyze(
                    root,
                    expected_games=2,
                    bootstrap=20,
                    bootstrap_seed=7,
                    wrapper_timeouts=0,
                )


if __name__ == "__main__":
    unittest.main()
