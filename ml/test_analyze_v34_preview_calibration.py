import json
import tempfile
import unittest
from pathlib import Path

from ml.analyze_v34_preview_calibration import analyze, auc, calibration_metrics


def row(seed: int, target: int, prediction: float) -> dict:
    return {
        "seed": seed,
        "round": 12,
        "seat": "Red",
        "phase": "navigation",
        "chosenPrediction": prediction,
        "candidateCount": 4,
        "finiteCandidateCount": 4,
        "terminalSuccessOverrides": 0,
        "terminalFailureOverrides": 0,
        "terminalOverrideMismatches": 0,
        "target": target,
    }


class PreviewCalibrationTest(unittest.TestCase):
    def write(self, rows: list[dict]) -> tuple[tempfile.TemporaryDirectory, Path]:
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "preview.jsonl"
        path.write_text("".join(json.dumps(value) + "\n" for value in rows))
        return directory, path

    def test_auc_ties_and_metrics(self):
        self.assertEqual(auc([0, 1], [0.2, 0.8]), 1.0)
        self.assertEqual(auc([0, 1], [0.5, 0.5]), 0.5)
        metrics = calibration_metrics([0, 1], [0.1, 0.9])
        self.assertAlmostEqual(metrics["brier"], 0.01)
        self.assertAlmostEqual(metrics["ece"], 0.1)

    def test_passing_exact_seed_coverage(self):
        directory, path = self.write([row(100, 0, 0.1), row(101, 1, 0.9)])
        try:
            report = analyze([path], 100, 2)
            self.assertTrue(report["passed"])
            self.assertEqual(report["uniqueSeeds"], 2)
            self.assertEqual(report["candidateCount"], report["finiteCandidateCount"])
        finally:
            directory.cleanup()

    def test_rejects_missing_seed_bad_finiteness_and_schema_drift(self):
        for rows, pattern in (
            ([row(100, 0, 0.1)], "coverage"),
            ([{**row(100, 0, 0.1), "finiteCandidateCount": 3}, row(101, 1, 0.9)], "finiteness"),
            ([{**row(100, 0, 0.1), "extra": 1}, row(101, 1, 0.9)], "keys"),
        ):
            directory, path = self.write(rows)
            try:
                with self.assertRaisesRegex(ValueError, pattern):
                    analyze([path], 100, 2)
            finally:
                directory.cleanup()

    def test_requires_both_labels(self):
        directory, path = self.write([row(100, 0, 0.1), row(101, 0, 0.2)])
        try:
            with self.assertRaisesRegex(ValueError, "both positive and negative"):
                analyze([path], 100, 2)
        finally:
            directory.cleanup()


if __name__ == "__main__":
    unittest.main()

