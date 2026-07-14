from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "ml/run_v34_phase2_analysis_recovery.py"


class RecoveryLauncherTests(unittest.TestCase):
    def test_self_test_exercises_exclusive_markers_and_exec_handshake(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = Path(raw) / "probe"
            result = subprocess.run(
                [sys.executable, str(LAUNCHER), "self-test", "--directory", str(target)],
                cwd=REPO,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertTrue(value["passed"])
            self.assertTrue(value["reservationExists"])
            self.assertTrue(value["attemptStartedExists"])
            self.assertTrue(value["stdoutCreatedExclusively"])
            self.assertTrue(value["stderrCreatedExclusively"])
            self.assertTrue(value["execConfirmedExists"])
            self.assertTrue(value["exitRecordExists"])
            self.assertFalse(value["outcomesInspected"])

    def test_self_test_refuses_reuse_of_existing_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            result = subprocess.run(
                [sys.executable, str(LAUNCHER), "self-test", "--directory", raw],
                cwd=REPO,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
