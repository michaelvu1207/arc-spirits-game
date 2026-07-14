#!/usr/bin/env python3
"""Create the immutable V34 Phase 2 recovery-v2b authorization."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_v34_phase2_analysis_recovery import (
    REVISION1_AUTHORIZATION_ABSOLUTE,
    REVISION1_FILE_RECORDS,
    REVISION1_GIT_DIR,
    REVISION1_HEAD,
    REVISION1_ONE_SHOT_PATHS,
    SUPERSESSION_MINIMUM_ANCESTRY,
    exclusive_json,
    load_json,
    sha256_file,
)


REPO = Path(__file__).resolve().parents[1]
ARTIFACTS = Path("ml/experiments/v34-latency-first-expert-iteration/artifacts")
ROOT = Path("/data/share8/michaelvuaprilexperimentation/arc-bot")
GIT_DIR = Path("/data/share8/michaelvuaprilexperimentation/arc-v34-phase2-recovery-v2b-git/.git")
AUTHORIZATION_RELATIVE = ARTIFACTS / "phase2-analysis-recovery-v2b-authorization.json"
PRELAUNCH_RELATIVE = ARTIFACTS / "phase2-analysis-recovery-v2b-prelaunch.json"
RESERVATION_RELATIVE = ARTIFACTS / "phase2-analysis-recovery-v2b-reservation.json"


def file_record(relative: str | Path) -> dict[str, Any]:
    relative = Path(relative)
    path = REPO / relative
    return {"path": str(relative), "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--authorization-basis-commit", required=True)
    args = parser.parse_args()
    if len(args.authorization_basis_commit) != 40 or any(
        character not in "0123456789abcdef" for character in args.authorization_basis_commit
    ):
        raise RuntimeError("authorization basis commit is not a full lowercase SHA-1")
    out = args.out.resolve()
    expected = (REPO / AUTHORIZATION_RELATIVE).resolve()
    if out != expected:
        raise RuntimeError("authorization output path changed")

    revision1 = load_json(REPO / REVISION1_FILE_RECORDS["revision1Authorization"]["path"], "revision-1 authorization")
    authorization = copy.deepcopy(revision1)
    authorization.update(
        {
            "authorized": True,
            "authorizedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "authorizationBasisCommit": args.authorization_basis_commit,
            "reviewedImplementationCommit": "1c04a4e8b2b59b02ec70dd898e6c24c9a8c836af",
            "requiredAncestryCommit": SUPERSESSION_MINIMUM_ANCESTRY,
            "decision": {
                "reviewer": "Claude Fable",
                "model": "fable",
                "effort": "high",
                "verdict": "ACCEPT",
                "remainingBlockingGaps": [],
                "outcomeArtifactsReadByReviewer": False,
            },
            "supersession": {
                "revision1Disposition": {
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
                },
                "lineagePolicy": {
                    "minimumRequiredAncestryCommit": SUPERSESSION_MINIMUM_ANCESTRY,
                    "forbiddenHead": REVISION1_HEAD,
                    "forbiddenGitDir": REVISION1_GIT_DIR,
                    "forbiddenAuthorizationPath": REVISION1_AUTHORIZATION_ABSOLUTE,
                    "forbiddenOneShotPaths": copy.deepcopy(REVISION1_ONE_SHOT_PATHS),
                    "allNewPathsDisjoint": True,
                },
            },
        }
    )

    artifact_root = ROOT / ARTIFACTS
    paths = {
        "analysisOutput": str(artifact_root / "phase2-analysis.json"),
        "prelaunch": str(ROOT / PRELAUNCH_RELATIVE),
        "stdout": str(artifact_root / "phase2-analysis-attempt-2-v2b.stdout"),
        "stderr": str(artifact_root / "phase2-analysis-attempt-2-v2b.stderr"),
        "reservation": str(ROOT / RESERVATION_RELATIVE),
        "attemptStarted": str(artifact_root / "phase2-analysis-attempt-2-v2b-started.json"),
        "execConfirmed": str(artifact_root / "phase2-analysis-attempt-2-v2b-exec-confirmed.json"),
        "exitRecord": str(artifact_root / "phase2-analysis-attempt-2-v2b-exit.json"),
        "gitDir": str(GIT_DIR),
    }
    authorization["paths"] = paths
    authorization["gitEnvironment"] = {
        "GIT_DIR": str(GIT_DIR),
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    executable = authorization["command"]["executable"]
    authorization["launcherInvocation"] = [
        executable,
        "ml/run_v34_phase2_analysis_recovery.py",
        "launch",
        "--authorization",
        str(ROOT / AUTHORIZATION_RELATIVE),
        "--prelaunch",
        str(ROOT / PRELAUNCH_RELATIVE),
        "--reservation",
        str(ROOT / RESERVATION_RELATIVE),
    ]
    authorization["failurePolicy"] = "any failure after v2b attempt-started permanently closes V34 Lane A"
    authorization["successPolicy"] = "copy, hash, and commit every result and launcher artifact before any value is read"

    bound_files = authorization["boundFiles"]
    bound_files.update(copy.deepcopy(REVISION1_FILE_RECORDS))
    current_records = {
        "recoveryLauncher": "ml/run_v34_phase2_analysis_recovery.py",
        "preflightGenerator": "ml/prepare_v34_phase2_analysis_recovery.py",
        "recoveryLauncherTests": "ml/test_run_v34_phase2_analysis_recovery.py",
        "v2Plan": "ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-v2-plan.md",
        "supersessionPlan": "ml/experiments/v34-latency-first-expert-iteration/phase2-analysis-recovery-v2-plan.md",
        "supersessionGenerator": "ml/prepare_v34_phase2_analysis_recovery.py",
        "supersessionGeneratorTests": "ml/test_prepare_v34_phase2_analysis_recovery.py",
        "supersessionLauncherTests": "ml/test_run_v34_phase2_analysis_recovery.py",
        "supersessionRejectedFableReview": (
            "ml/experiments/v34-latency-first-expert-iteration/"
            "phase2-analysis-recovery-v2-supersession-enforcement-fable-review.md"
        ),
        "supersessionFinalFableReview": (
            "ml/experiments/v34-latency-first-expert-iteration/"
            "phase2-analysis-recovery-v2-supersession-final-fable-review.md"
        ),
        "supersessionAuthorizationGenerator": "ml/create_v34_phase2_recovery_v2b_authorization.py",
    }
    for label, relative in current_records.items():
        bound_files[label] = file_record(relative)

    exclusive_json(out, authorization)


if __name__ == "__main__":
    main()
