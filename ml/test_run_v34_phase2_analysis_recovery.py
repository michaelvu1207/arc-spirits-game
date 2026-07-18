from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ml.run_v34_phase2_analysis_recovery import (
    ENV_FINGERPRINT_EXCLUDED,
    REQUIRED_SUPERSESSION_BOUND_FILES,
    REVISION1_AUTHORIZATION_ABSOLUTE,
    REVISION1_FILE_RECORDS,
    REVISION1_GIT_DIR,
    REVISION1_HEAD,
    REVISION1_ONE_SHOT_PATHS,
    SUPERSESSION_MINIMUM_ANCESTRY,
    RecoveryLaunchError,
    analysis_environment_sha256,
    environment_sha256,
    validate_supersession_contract,
)


REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "ml/run_v34_phase2_analysis_recovery.py"


def supersession_fixture() -> tuple[dict, dict]:
    bound_files = copy.deepcopy(REVISION1_FILE_RECORDS)
    for label in REQUIRED_SUPERSESSION_BOUND_FILES - set(bound_files):
        bound_files[label] = {"path": f"{label}.txt", "bytes": 0, "sha256": "0" * 64}
    disposition = {
        "authorization": copy.deepcopy(REVISION1_FILE_RECORDS["revision1Authorization"]),
        "incident": copy.deepcopy(REVISION1_FILE_RECORDS["revision1AuthorizationIncident"]),
        "gitContext": copy.deepcopy(REVISION1_FILE_RECORDS["revision1GitContext"]),
        "gitInventory": copy.deepcopy(REVISION1_FILE_RECORDS["revision1GitInventory"]),
        "gitContextCreated": True,
        "prelaunchCreated": False,
        "reservationCreated": False,
        "attemptStartedCreated": False,
        "stdoutCreated": False,
        "stderrCreated": False,
        "execConfirmedCreated": False,
        "exitRecordCreated": False,
        "analysisJsonCreated": False,
        "analyzerProcessesStarted": 0,
        "authorizedAnalyzerProcessConsumed": False,
        "immutableAndAbandoned": True,
        "outcomesInspected": False,
    }
    lineage = {
        "minimumRequiredAncestryCommit": SUPERSESSION_MINIMUM_ANCESTRY,
        "forbiddenHead": REVISION1_HEAD,
        "forbiddenGitDir": REVISION1_GIT_DIR,
        "forbiddenAuthorizationPath": REVISION1_AUTHORIZATION_ABSOLUTE,
        "forbiddenOneShotPaths": copy.deepcopy(REVISION1_ONE_SHOT_PATHS),
        "allNewPathsDisjoint": True,
    }
    value = {
        "requiredAncestryCommit": SUPERSESSION_MINIMUM_ANCESTRY,
        "boundFiles": bound_files,
        "decision": {
            "reviewer": "Claude Fable",
            "model": "fable",
            "effort": "high",
            "verdict": "ACCEPT",
            "remainingBlockingGaps": [],
            "outcomeArtifactsReadByReviewer": False,
        },
        "supersession": {"revision1Disposition": disposition, "lineagePolicy": lineage},
    }
    paths = {label: f"/new-lineage/{label}" for label in REVISION1_ONE_SHOT_PATHS}
    paths["gitDir"] = "/new-lineage/git/.git"
    return value, paths


class RecoveryLauncherTests(unittest.TestCase):
    def test_supersession_contract_accepts_disjoint_new_lineage(self) -> None:
        value, paths = supersession_fixture()
        validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

    def test_supersession_contract_rejects_revision1_git_database(self) -> None:
        value, paths = supersession_fixture()
        paths["gitDir"] = REVISION1_GIT_DIR
        with self.assertRaisesRegex(RecoveryLaunchError, "Git database cannot be reused"):
            validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

    def test_supersession_contract_rejects_any_revision1_one_shot_path(self) -> None:
        value, paths = supersession_fixture()
        paths["stdout"] = REVISION1_ONE_SHOT_PATHS["reservation"]
        with self.assertRaisesRegex(RecoveryLaunchError, "one-shot path cannot be reused"):
            validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

    def test_supersession_contract_rejects_missing_evidence_binding(self) -> None:
        value, paths = supersession_fixture()
        del value["boundFiles"]["revision1AuthorizationIncident"]
        with self.assertRaisesRegex(RecoveryLaunchError, "bound files are missing"):
            validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

    def test_supersession_contract_rejects_inaccurate_disposition(self) -> None:
        value, paths = supersession_fixture()
        value["supersession"]["revision1Disposition"]["analyzerProcessesStarted"] = 1
        with self.assertRaisesRegex(RecoveryLaunchError, "disposition changed"):
            validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

    def test_supersession_contract_rejects_nonaccepting_review(self) -> None:
        value, paths = supersession_fixture()
        value["decision"]["verdict"] = "REJECT"
        with self.assertRaisesRegex(RecoveryLaunchError, "not an outcome-blind ACCEPT"):
            validate_supersession_contract(value, Path("/new-lineage/authorization.json"), paths)

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
