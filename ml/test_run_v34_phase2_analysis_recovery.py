from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ml.run_v34_phase2_analysis_recovery import (
    ENV_FINGERPRINT_EXCLUDED,
    analysis_environment_sha256,
    environment_sha256,
)


REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "ml/run_v34_phase2_analysis_recovery.py"


class RecoveryLauncherTests(unittest.TestCase):
    def test_transport_and_session_values_do_not_change_analysis_fingerprint(self) -> None:
        first = {"PATH": "/usr/bin", "HOME": "/home/ubuntu", "SSH_CLIENT": "first", "XDG_SESSION_ID": "1"}
        second = {"PATH": "/usr/bin", "HOME": "/home/ubuntu", "SSH_CLIENT": "second", "XDG_SESSION_ID": "2"}
        self.assertEqual(analysis_environment_sha256(first), analysis_environment_sha256(second))
        self.assertNotEqual(environment_sha256(first), environment_sha256(second))

    def test_analysis_relevant_value_changes_fingerprint(self) -> None:
        first = {"PATH": "/usr/bin", "HOME": "/home/ubuntu"}
        second = {"PATH": "/usr/local/bin", "HOME": "/home/ubuntu"}
        self.assertNotEqual(analysis_environment_sha256(first), analysis_environment_sha256(second))

    def test_expected_transport_exclusion_set_is_exact(self) -> None:
        self.assertEqual(
            set(ENV_FINGERPRINT_EXCLUDED),
            {
                "COLUMNS",
                "DBUS_SESSION_BUS_ADDRESS",
                "LINES",
                "OLDPWD",
                "SHLVL",
                "SSH_AUTH_SOCK",
                "SSH_CLIENT",
                "SSH_CONNECTION",
                "SSH_TTY",
                "TERM",
                "XDG_RUNTIME_DIR",
                "XDG_SESSION_ID",
                "_",
            },
        )

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
