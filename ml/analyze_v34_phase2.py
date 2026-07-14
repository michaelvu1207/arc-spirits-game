#!/usr/bin/env python3
"""Fail-closed analysis for the frozen V34 Phase 2 strength screen.

The analyzer intentionally consumes only immutable, hash-bound completion
manifests.  It validates every scheduled condition before reading any outcome,
keeps systems-rejected slots in the registered 24-endpoint family, and emits no
winner: a core pass only authorizes independent guardian confirmation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from statistics import NormalDist
from typing import Any, Iterable, Mapping, Sequence

import numpy as np


ANALYSIS_SCHEMA = "arc-v34-phase2-analysis-v1"
BASE_PROTOCOL_SCHEMA = "arc-controlled-experiment-v1"
STRENGTH_PROTOCOL_SCHEMA = "arc-v34-strength-protocol-v1"
SOURCE_LOCK_SCHEMA = "arc-v34-source-lock-v1"
SYSTEMS_ELIGIBILITY_SCHEMA = "arc-v34-systems-eligibility-v1"
SYSTEMS_AUTHORIZATION_SCHEMA = "arc-v34-systems-authorization-v1"
PHASE2_AUTHORIZATION_SCHEMA = "arc-v34-phase2-authorization-v1"
STRENGTH_LOCK_SCHEMA = "arc-v34-strength-tooling-lock-v1"
CONDITION_SCHEMA = "arc-v34-phase2-condition-v1"
REPORT_SCHEMA = "solo-heldout-v2"

REFERENCE_ARM = "raw"
REGISTERED_ARMS = (
    "rerank-p025",
    "rerank-p050",
    "rerank-p075",
    "rerank-p100",
    "heuristic-s4-h2",
    "heuristic-s8-h3",
)
OUTCOMES = (
    "winPoints",
    "finalVp",
    "post15VpPerRound",
    "censoredFirst30Round",
)
SEED0 = 957_000_000
GAMES = 4_096
SEED_MAX = 957_004_095
REPLAY_PREFLIGHT_SEED0 = 957_800_000
BOOTSTRAP_DRAWS = 10_000
BOOTSTRAP_SEED = 34_022_026
FAMILY_SIZE = 24
CONFIDENCE = 0.95

INTEGRITY_COUNTER_KEYS = {
    "informationSafetyFailures",
    "replayMismatches",
    "servingErrors",
    "provenanceMismatches",
}
INTEGRITY_KEYS = {*INTEGRITY_COUNTER_KEYS, "derivedOnlyAfterStrictValidation", "evidence"}
CONDITION_KEYS = {
    "schemaVersion",
    "valid",
    "immutable",
    "condition",
    "attempt",
    "workers",
    "arm",
    "sourceCommit",
    "seed0",
    "games",
    "seedMax",
    "commonDecode",
    "checkpoint",
    "catalog",
    "inference",
    "telemetry",
    "stalls",
    "integrity",
    "inputs",
}
CONDITION_INPUT_KEYS = {
    "strengthLock",
    "baseProtocol",
    "strengthProtocol",
    "systemsEligibility",
    "phase2Authorization",
    "strengthPreflight",
    "report",
    "replayReport",
    "replayStdout",
    "replayStderr",
    "replayExitCode",
    "inferLog",
    "stdout",
    "stderr",
    "launch",
    "launchPid",
    "exitCode",
}
LAUNCH_KEYS = {
    "schemaVersion",
    "condition",
    "attempt",
    "workers",
    "gpu",
    "sourceCommit",
    "watchdogSeconds",
    "watchdogKillAfterSeconds",
    "strengthLock",
    "seed0",
    "games",
    "seedMax",
    "commonDecode",
    "arm",
    "checkpoint",
    "catalog",
    "retryJustification",
    "evaluatorArgs",
    "replayEvaluatorArgs",
}
REPORT_KEYS = {
    "schemaVersion",
    "sourceCommit",
    "weights",
    "weightsSha256",
    "catalog",
    "catalogSha256",
    "inference",
    "seed0",
    "games",
    "maxRounds",
    "maxStatusLevel",
    "decode",
    "trueWins",
    "trueWinRate",
    "trueWinWilson95",
    "namedWinRate",
    "stalls",
    "stallRate",
    "reach15Rate",
    "nearMiss27To29Rate",
    "vp",
    "vpBuckets",
    "guardianBreakdown",
    "first30Round",
    "engine",
    "performance",
    "perGame",
}
ROW_KEYS = {
    "seed",
    "guardian",
    "trueWin",
    "stalled",
    "finalVP",
    "first30Round",
    "post15VpPerRound",
    "finalAttackDice",
    "finalSpirits",
    "finalMaxBarrier",
    "cycle",
}
CYCLE_KEYS = {
    "vpAfterRound",
    "first15Round",
    "first30Round",
    "decisions",
    "productiveDecisions",
    "optionalYieldDecisions",
    "locationInteractions",
    "summons",
    "awakens",
    "combats",
    "rewards",
    "pvpAttacks",
    "finalAttackDice",
    "finalSpirits",
    "finalMaxBarrier",
    "post15VpPerRound",
}
INFERENCE_KEYS = {"format", "obsDim", "actDim", "weightsPath", "weightsSha256", "wire"}
PERFORMANCE_KEYS = {
    "wallSeconds",
    "gamesPerSecond",
    "workers",
    "gameWallMsP50",
    "gameWallMsP95",
}
SEARCH_PERFORMANCE_KEYS = {
    "mode",
    "decisions",
    "simulations",
    "byPhase",
    "decisionWallMsP50",
    "decisionWallMsP95",
}
LOCKED_TOOLING_FILES = {
    "ml/analyze_v34_phase2.py",
    "ml/test_analyze_v34_phase2.py",
    "scripts/check-v34-replay-determinism.sh",
    "scripts/run-v34-phase2-screen.sh",
    "ml/experiments/v34-latency-first-expert-iteration/strength-integrity-fable-review.md",
    "ml/experiments/v34-latency-first-expert-iteration/strength-tooling-plan.md",
    "ml/experiments/v34-latency-first-expert-iteration/strength-tooling-fable-review.md",
    "ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json",
    "scripts/lock-v34-strength-inputs.mjs",
    "scripts/record-v34-phase2-condition.mjs",
    "scripts/record-v34-strength-preflight.mjs",
    "scripts/run-v34-strength-preflight.sh",
    "scripts/test-v34-phase2-condition.mjs",
    "scripts/v34-strength-tooling-files.mjs",
    "scripts/validate-v34-strength-protocol.mjs",
    "scripts/verify-v34-strength-chain.mjs",
}


@dataclass(frozen=True)
class Artifact:
    path: Path
    sha256: str
    value: dict[str, Any]


@dataclass(frozen=True)
class Condition:
    arm: str
    manifest: Artifact
    report: Artifact
    integrity: dict[str, int]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def is_commit(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value)
    )


def exact_keys(
    value: Any,
    expected: set[str],
    label: str,
    *,
    optional: set[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    keys = set(value)
    optional = optional or set()
    missing = expected - keys
    extra = keys - expected - optional
    if missing or extra:
        raise ValueError(
            f"{label} has non-exact keys (missing={sorted(missing)}, extra={sorted(extra)})"
        )
    return value


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def nonnegative_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def js_number_string(value: int | float) -> str:
    """Mirror JavaScript String(number) for the finite protocol numbers used in argv."""

    number = finite_number(value, "protocol CLI number")
    return str(int(number)) if number.is_integer() else str(number)


def resolve_path(raw: Any, repo: Path, *, relative_to: Path | None = None) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("artifact path must be a non-empty string")
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path.resolve()
    repo_path = (repo / path).resolve()
    if repo_path.exists() or relative_to is None:
        return repo_path
    return (relative_to / path).resolve()


def load_json(path: Path, label: str) -> Artifact:
    path = path.resolve()
    if not path.is_file():
        raise ValueError(f"{label}: missing artifact {path}")
    digest = sha256(path)
    try:
        value = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label}: invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label}: JSON root must be an object")
    return Artifact(path, digest, value)


def verify_ref(
    ref: Any,
    repo: Path,
    label: str,
    *,
    relative_to: Path | None = None,
    expect_json: bool = True,
) -> Artifact | Path:
    ref = exact_keys(ref, {"path", "sha256"}, label)
    expected = ref["sha256"]
    if not is_sha256(expected):
        raise ValueError(f"{label}: invalid SHA-256")
    path = resolve_path(ref["path"], repo, relative_to=relative_to)
    if not path.is_file() or sha256(path) != expected:
        raise ValueError(f"{label}: missing or hash-invalid artifact")
    return load_json(path, label) if expect_json else path


def verify_file_record(record: Any, repo: Path, label: str) -> Path:
    record = exact_keys(record, {"path", "bytes", "sha256"}, label)
    expected_size = record["bytes"]
    expected_hash = record["sha256"]
    if type(expected_size) is not int or expected_size < 0 or not is_sha256(expected_hash):
        raise ValueError(f"{label}: malformed file record")
    path = resolve_path(record["path"], repo)
    if (
        not path.is_file()
        or path.stat().st_size != expected_size
        or sha256(path) != expected_hash
    ):
        raise ValueError(f"{label}: missing, size-invalid, or hash-invalid file")
    return path


def file_record_matches(record: Any, artifact: Artifact, repo: Path, label: str) -> None:
    path = verify_file_record(record, repo, label)
    if path != artifact.path or sha256(path) != artifact.sha256:
        raise ValueError(f"{label}: file record does not name the supplied artifact")


def ref_matches(ref: Any, artifact: Artifact, repo: Path, label: str) -> None:
    loaded = verify_ref(ref, repo, label)
    assert isinstance(loaded, Artifact)
    if loaded.path != artifact.path or loaded.sha256 != artifact.sha256:
        raise ValueError(f"{label}: reference does not name the supplied artifact")


def repo_label(path: Path, repo: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def artifact_ref(artifact: Artifact, repo: Path) -> dict[str, str]:
    return {"path": repo_label(artifact.path, repo), "sha256": artifact.sha256}


def validate_base_protocol(protocol: dict[str, Any]) -> None:
    if protocol.get("schemaVersion") != BASE_PROTOCOL_SCHEMA:
        raise ValueError("unexpected base protocol schema")
    phase2 = protocol.get("phase2", {})
    family = phase2.get("family", {})
    gates = phase2.get("gates", {})
    if (
        phase2.get("seed0") != SEED0
        or phase2.get("games") != GAMES
        or phase2.get("seedMax") != SEED_MAX
        or phase2.get("referenceArm") != REFERENCE_ARM
        or tuple(phase2.get("registeredCandidateSlots", ())) != REGISTERED_ARMS
        or family.get("candidateSlots") != 6
        or family.get("coreOutcomesPerSlot") != 4
        or family.get("familySize") != FAMILY_SIZE
        or family.get("draws") != BOOTSTRAP_DRAWS
        or family.get("rngSeed") != BOOTSTRAP_SEED
        or family.get("simultaneousConfidence") != CONFIDENCE
        or family.get("familyNeverShrinksAfterSystemsRejection") is not True
    ):
        raise ValueError("base protocol Phase 2 contract changed")
    common = protocol.get("commonDecode", {})
    if (
        common.get("seats") != 1
        or common.get("maxRounds") != 30
        or common.get("maxStatusLevel") != 2
        or common.get("guardianSchedule") != "absolute-balanced"
        or common.get("selection") != "hybrid"
        or common.get("sample") is not True
        or common.get("temperature") != 0.55
        or common.get("learnMonsterRewardChoices") is not False
        or common.get("policyObsVersion") != 2
        or common.get("inferenceWire") != "binary"
    ):
        raise ValueError("base protocol common decode changed")
    expected_gates = {
        "pairedWinGainPointsMin": 3,
        "pairedWinLowerBoundStrictlyAbove": 0,
        "finalVpLowerBoundMin": 0,
        "post15VpPerRoundLowerBoundMin": 0,
        "censoredFirst30RoundUpperBoundMax": 0,
        "stalls": 0,
        "informationSafetyFailures": 0,
        "replayMismatches": 0,
        "servingErrors": 0,
        "provenanceMismatches": 0,
    }
    if gates != expected_gates:
        raise ValueError("base protocol Phase 2 gates changed")
    arms = protocol.get("systems", {}).get("candidateArms")
    if not isinstance(arms, list) or tuple(arm.get("id") for arm in arms) != REGISTERED_ARMS:
        raise ValueError("base protocol candidate-arm registry changed")


def validate_strength_protocol(
    strength: dict[str, Any], base: Artifact, source_lock: Artifact, repo: Path
) -> None:
    if strength.get("schemaVersion") != STRENGTH_PROTOCOL_SCHEMA:
        raise ValueError("unexpected strength protocol schema")
    base_ref = strength.get("base", {})
    if (
        base_ref.get("protocolSha256") != base.sha256
        or resolve_path(base_ref.get("protocolPath"), repo) != base.path
        or base_ref.get("sourceLockSha256") != source_lock.sha256
        or resolve_path(base_ref.get("sourceLockPath"), repo) != source_lock.path
        or base_ref.get("catalogPath") != base.value.get("inputs", {}).get("catalog", {}).get("path")
        or base_ref.get("catalogSha256") != base.value.get("inputs", {}).get("catalog", {}).get("sha256")
        or base_ref.get("checkpointPath") != base.value.get("inputs", {}).get("policy", {}).get("path")
        or base_ref.get("checkpointSha256") != base.value.get("inputs", {}).get("policy", {}).get("sha256")
    ):
        raise ValueError("strength protocol base hash chain changed")
    for name, entry in (
        ("catalog", base.value.get("inputs", {}).get("catalog", {})),
        ("checkpoint", base.value.get("inputs", {}).get("policy", {})),
    ):
        path = resolve_path(entry.get("path"), repo)
        if not path.is_file() or not is_sha256(entry.get("sha256")) or sha256(path) != entry["sha256"]:
            raise ValueError(f"frozen {name} is missing or hash-invalid")
    phase2 = strength.get("phase2", {})
    family = phase2.get("family", {})
    if (
        phase2.get("seed0") != SEED0
        or phase2.get("games") != GAMES
        or phase2.get("seedMax") != SEED_MAX
        or phase2.get("referenceArm") != REFERENCE_ARM
        or tuple(phase2.get("registeredCandidateSlots", ())) != REGISTERED_ARMS
        or tuple(phase2.get("outcomes", ())) != OUTCOMES
        or family.get("draws") != BOOTSTRAP_DRAWS
        or family.get("rngSeed") != BOOTSTRAP_SEED
        or family.get("candidateSlots") != 6
        or family.get("outcomesPerSlot") != 4
        or family.get("familySize") != FAMILY_SIZE
        or family.get("confidence") != CONFIDENCE
        or family.get("systemsRejectedSlotsRemainFailed") is not True
    ):
        raise ValueError("strength protocol Phase 2 contract changed")
    common = strength.get("commonDecode", {})
    if common != {
        "seats": 1,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "guardianSchedule": "absolute-balanced",
        "selection": "hybrid",
        "sample": True,
        "temperature": 0.55,
        "learnMonsterRewardChoices": False,
        "obsVersion": 1,
        "policyObsVersion": 2,
        "inferenceWire": "binary",
    }:
        raise ValueError("strength protocol common decode changed")
    gates = phase2.get("gates", {})
    expected_gates = {
        "winPointGainMin": 3.0,
        "winSimultaneousLowerStrictlyAbove": 0.0,
        "finalVpSimultaneousLowerMin": -0.5,
        "post15SimultaneousLowerMin": -0.025,
        "censoredFirst30SimultaneousUpperMax": 0.5,
        "stalls": 0,
        "informationSafetyFailures": 0,
        "replayMismatches": 0,
        "servingErrors": 0,
        "evaluationProvenanceMismatches": 0,
        "bindingEvidenceHashesMustMatch": True,
    }
    if gates != expected_gates:
        raise ValueError("strength protocol Phase 2 gates changed")
    environment = strength.get("environment", {})
    if (
        environment.get("python") != platform.python_version()
        or environment.get("numpy") != np.__version__
        or environment.get("rng") != "numpy.random.Generator(PCG64)"
        or environment.get("exactFixtureRequired") is not True
    ):
        raise ValueError("strength protocol environment differs from analyzer runtime")


def validate_source_lock(source_lock: Artifact, repo: Path) -> None:
    value = source_lock.value
    if value.get("schemaVersion") != SOURCE_LOCK_SCHEMA or not is_commit(value.get("implementationCommit")):
        raise ValueError("invalid original source lock")
    expected_auth = {
        "previewCalibrationSeedsOpen": True,
        "systemsSeedsOpen": False,
        "phase2SeedsOpen": False,
        "guardianSeedsOpen": False,
        "teacherSeedsOpen": False,
        "finalDevelopmentSeedsOpen": False,
        "hiddenSeedsOpen": False,
        "multiplayerSeedsOpen": False,
        "humanReferenceSeedsOpen": False,
        "productionPromotionOpen": False,
    }
    if value.get("authorization") != expected_auth:
        raise ValueError("original source-lock authorization changed")
    files = value.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("original source lock has no file inventory")
    for raw_path, expected in files.items():
        path = resolve_path(raw_path, repo)
        if not is_sha256(expected) or not path.is_file() or sha256(path) != expected:
            raise ValueError(f"original source-lock mismatch: {raw_path}")


def validate_preflight_and_systems_authorization(
    systems_authorization: Artifact,
    source_lock: Artifact,
    base: Artifact,
    repo: Path,
) -> None:
    auth = systems_authorization.value
    if auth.get("schemaVersion") != SYSTEMS_AUTHORIZATION_SCHEMA or auth.get("strengthUse") is not False:
        raise ValueError("invalid systems authorization")
    ref_matches(auth.get("sourceLock"), source_lock, repo, "systems source lock")
    preflight = verify_ref(auth.get("preflight"), repo, "systems preflight")
    collection = verify_ref(auth.get("previewCollection"), repo, "preview collection")
    calibration = verify_ref(auth.get("previewCalibration"), repo, "preview calibration")
    assert isinstance(preflight, Artifact) and isinstance(collection, Artifact) and isinstance(calibration, Artifact)
    if (
        preflight.value.get("schemaVersion") != "arc-v34-preflight-evidence-v1"
        or preflight.value.get("passed") is not True
        or preflight.value.get("sourceLock", {}).get("sha256") != source_lock.sha256
        or preflight.value.get("sourceLock", {}).get("implementationCommit")
        != source_lock.value.get("implementationCommit")
    ):
        raise ValueError("preflight is not bound to the source lock")
    expected_checks = {
        "vitest",
        "python",
        "typecheck",
        "protocol",
        "shellSyntax",
        "determinization",
    }
    checks = preflight.value.get("checks")
    if not isinstance(checks, dict) or set(checks) != expected_checks:
        raise ValueError("preflight check inventory changed")
    for name, check in checks.items():
        if not isinstance(check, dict) or check.get("exitCode") != 0:
            raise ValueError(f"preflight check failed: {name}")
        log_path = resolve_path(check.get("log"), repo, relative_to=preflight.path.parent)
        if not is_sha256(check.get("logSha256")) or not log_path.is_file() or sha256(log_path) != check["logSha256"]:
            raise ValueError(f"preflight log mismatch: {name}")
    preview = base.value.get("previewCalibration", {})
    collection_value = collection.value
    if (
        collection_value.get("schemaVersion") != "arc-v34-preview-collection-v1"
        or collection_value.get("seed0") != preview.get("seed0")
        or collection_value.get("games") != preview.get("games")
        or collection_value.get("completed") != preview.get("games")
        or nonnegative_int(collection_value.get("stalls"), "preview stalls") > preview.get("games", -1)
        or collection_value.get("checkpoint", {}).get("sha256")
        != base.value.get("inputs", {}).get("policy", {}).get("sha256")
        or collection_value.get("catalog", {}).get("sha256")
        != base.value.get("inputs", {}).get("catalog", {}).get("sha256")
        or collection_value.get("inference", {}).get("wire")
        != base.value.get("commonDecode", {}).get("inferenceWire")
    ):
        raise ValueError("preview collection contract mismatch")
    calibration_value = calibration.value
    if (
        calibration_value.get("schemaVersion") != "arc-v34-preview-calibration-v1"
        or calibration_value.get("seed0") != preview.get("seed0")
        or calibration_value.get("games") != preview.get("games")
        or calibration_value.get("uniqueSeeds") != preview.get("games")
        or calibration_value.get("candidateCount") != calibration_value.get("finiteCandidateCount")
        or calibration_value.get("terminalOverrides", {}).get("mismatches") != 0
    ):
        raise ValueError("preview calibration contract mismatch")
    collected_inputs = {
        row.get("name"): row.get("sha256")
        for row in collection_value.get("previewInputs", [])
        if isinstance(row, dict)
    }
    calibration_inputs = calibration_value.get("inputs")
    if not isinstance(calibration_inputs, list) or len(calibration_inputs) != len(collected_inputs):
        raise ValueError("preview calibration input inventory mismatch")
    for row in calibration_inputs:
        if not isinstance(row, dict) or collected_inputs.get(row.get("name")) != row.get("sha256"):
            raise ValueError("preview calibration input hash mismatch")
    critic_pass = calibration_value.get("passed") is True and collection_value.get("stalls") == 0
    enabled = ["rerank-p100", "heuristic-s4-h2", "heuristic-s8-h3"]
    if critic_pass:
        enabled[0:0] = ["rerank-p025", "rerank-p050", "rerank-p075"]
    disabled = [] if critic_pass else ["rerank-p025", "rerank-p050", "rerank-p075"]
    if (
        auth.get("criticCalibrationPassed") is not critic_pass
        or auth.get("enabledCandidateArms") != enabled
        or sorted((auth.get("disabledCandidateArms") or {}).keys()) != disabled
    ):
        raise ValueError("systems authorization arm set mismatch")
    if auth.get("authorization") != {
        "systemsSeedsOpen": True,
        "phase2SeedsOpen": False,
        "guardianSeedsOpen": False,
        "teacherSeedsOpen": False,
        "finalDevelopmentSeedsOpen": False,
        "hiddenSeedsOpen": False,
        "multiplayerSeedsOpen": False,
        "humanReferenceSeedsOpen": False,
        "productionPromotionOpen": False,
    }:
        raise ValueError("systems authorization seed flags changed")


def validate_systems_eligibility(
    systems: Artifact,
    base: Artifact,
    systems_authorization: Artifact,
    repo: Path,
) -> tuple[str, ...]:
    value = systems.value
    if (
        value.get("schemaVersion") != SYSTEMS_ELIGIBILITY_SCHEMA
        or value.get("strengthUse") is not False
        or value.get("outcomesLoaded") is not False
    ):
        raise ValueError("invalid systems eligibility artifact")
    ref_matches(value.get("protocol"), base, repo, "systems base protocol")
    ref_matches(value.get("systemsAuthorization"), systems_authorization, repo, "systems authorization")
    arms = value.get("arms")
    if not isinstance(arms, list) or tuple(arm.get("id") for arm in arms if isinstance(arm, dict)) != REGISTERED_ARMS:
        raise ValueError("systems eligibility does not preserve the six-slot registry")
    eligible = value.get("eligibleCandidateArms")
    if not isinstance(eligible, list) or len(eligible) != len(set(eligible)):
        raise ValueError("systems eligibility arm list is malformed")
    derived: list[str] = []
    enabled_before = set(systems_authorization.value.get("enabledCandidateArms", ()))
    binding_limits = {
        f"binding-w{row['workers']}": row["decisionP95MsMax"]
        for row in base.value.get("systems", {}).get("binding", ())
        if isinstance(row, dict) and "workers" in row and "decisionP95MsMax" in row
    }
    if set(binding_limits) != {"binding-w1", "binding-w8"}:
        raise ValueError("binding latency contract changed")
    for arm in arms:
        arm_id = arm["id"]
        enabled = arm.get("enabledBeforeSystems")
        operational = arm.get("operationallyEligible")
        if type(enabled) is not bool or type(operational) is not bool or enabled != (arm_id in enabled_before):
            raise ValueError(f"{arm_id}: systems enablement mismatch")
        if operational:
            if not enabled or arm.get("rejectionReason") is not None:
                raise ValueError(f"{arm_id}: invalid operational eligibility")
            workers = arm.get("selectedWorkers")
            if type(workers) is not int or workers <= 0 or workers > 96:
                raise ValueError(f"{arm_id}: invalid selected worker count")
            binding = arm.get("binding")
            if not isinstance(binding, dict) or set(binding) != set(binding_limits):
                raise ValueError(f"{arm_id}: missing binding evidence")
            for stage, limit in binding_limits.items():
                finite_number(binding[stage], f"{arm_id} {stage}")
                if binding[stage] > limit:
                    raise ValueError(f"{arm_id}: systems eligibility contradicts binding gate")
            stage_reports = arm.get("stageReports")
            if not isinstance(stage_reports, list) or not stage_reports:
                raise ValueError(f"{arm_id}: no binding stage reports")
            for index, ref in enumerate(stage_reports):
                verify_ref(ref, repo, f"{arm_id} stage report {index}")
            derived.append(arm_id)
        elif not isinstance(arm.get("rejectionReason"), str) or not arm["rejectionReason"]:
            raise ValueError(f"{arm_id}: rejected slot lacks a reason")
    if eligible != derived or value.get("phase2MayOpen") is not (len(derived) > 0):
        raise ValueError("systems eligibility summary differs from arm records")
    return tuple(derived)


def validate_phase2_authorization(
    authorization: Artifact,
    systems: Artifact,
    eligible: tuple[str, ...],
    repo: Path,
) -> None:
    value = authorization.value
    if value.get("schemaVersion") != PHASE2_AUTHORIZATION_SCHEMA:
        raise ValueError("unexpected Phase 2 authorization schema")
    ref_matches(value.get("systemsEligibility"), systems, repo, "Phase 2 systems eligibility")
    if (
        tuple(value.get("registeredFamilyCandidateSlots", ())) != REGISTERED_ARMS
        or tuple(value.get("eligibleCandidateArms", ())) != eligible
    ):
        raise ValueError("Phase 2 authorization arm registry changed")
    if value.get("authorization") != {
        "phase2SeedsOpen": True,
        "guardianSeedsOpen": False,
        "teacherSeedsOpen": False,
        "finalDevelopmentSeedsOpen": False,
        "hiddenSeedsOpen": False,
        "multiplayerSeedsOpen": False,
        "humanReferenceSeedsOpen": False,
        "productionPromotionOpen": False,
    }:
        raise ValueError("Phase 2 authorization seed flags changed")


def validate_strength_preflight(
    preflight: Artifact,
    source_lock: Artifact,
    strength_protocol: Artifact,
    systems: Artifact,
    phase2_authorization: Artifact,
    eligible: tuple[str, ...],
    repo: Path,
) -> None:
    value = exact_keys(
        preflight.value,
        {
            "schemaVersion",
            "implementationCommit",
            "baseSourceLock",
            "strengthProtocol",
            "systemsEligibility",
            "phase2Authorization",
            "toolingFiles",
            "environment",
            "resources",
            "checks",
            "passed",
            "recordedAt",
        },
        "strength preflight",
    )
    if (
        value.get("schemaVersion") != "arc-v34-strength-preflight-evidence-v1"
        or value.get("passed") is not True
        or not is_commit(value.get("implementationCommit"))
    ):
        raise ValueError("strength preflight is invalid or failed")
    ref_matches(value["baseSourceLock"], source_lock, repo, "preflight source lock")
    ref_matches(value["strengthProtocol"], strength_protocol, repo, "preflight strength protocol")
    ref_matches(value["systemsEligibility"], systems, repo, "preflight systems eligibility")
    ref_matches(value["phase2Authorization"], phase2_authorization, repo, "preflight Phase 2 authorization")
    if value.get("environment") != {
        "python": strength_protocol.value.get("environment", {}).get("python"),
        "numpy": strength_protocol.value.get("environment", {}).get("numpy"),
    }:
        raise ValueError("strength preflight environment changed")
    tooling = value.get("toolingFiles")
    if not isinstance(tooling, dict) or set(tooling) != LOCKED_TOOLING_FILES:
        raise ValueError("strength preflight tooling inventory changed")
    for raw_path, expected in tooling.items():
        path = resolve_path(raw_path, repo)
        if not is_sha256(expected) or not path.is_file() or sha256(path) != expected:
            raise ValueError(f"strength preflight tooling mismatch: {raw_path}")
    resources = exact_keys(
        value.get("resources"),
        {
            "schemaVersion",
            "scratchFreeBytes",
            "scratchRequiredBytes",
            "persistentFreeBytes",
            "persistentRequiredBytes",
            "eligibleGpus",
            "excludedGpu",
            "freeEligibleGpus",
            "gpuProbeError",
            "passed",
        },
        "strength resource preflight",
    )
    runtime = strength_protocol.value.get("runtime", {})
    if (
        resources.get("schemaVersion") != "arc-v34-strength-resource-preflight-v1"
        or resources.get("passed") is not True
        or resources.get("scratchRequiredBytes") != runtime.get("minimumScratchFreeBytes")
        or resources.get("persistentRequiredBytes") != (1 + len(eligible)) * 1024**3
        or nonnegative_int(resources.get("scratchFreeBytes"), "scratch free bytes") < resources["scratchRequiredBytes"]
        or nonnegative_int(resources.get("persistentFreeBytes"), "persistent free bytes") < resources["persistentRequiredBytes"]
        or resources.get("eligibleGpus") != runtime.get("eligibleGpus")
        or resources.get("excludedGpu") != runtime.get("excludedGpu")
        or resources.get("gpuProbeError") is not None
        or not isinstance(resources.get("freeEligibleGpus"), list)
        or not resources["freeEligibleGpus"]
        or runtime.get("excludedGpu") in resources["freeEligibleGpus"]
    ):
        raise ValueError("strength resource preflight changed or failed")
    expected_checks = {
        "sourceLock",
        "evidenceChain",
        "strengthProtocol",
        "pythonFixtures",
        "recorderFixtures",
        "replayDeterminism",
        "vitest",
        "typecheck",
        "nodeSyntax",
        "shellSyntax",
        "determinization",
        "resources",
    }
    checks = value.get("checks")
    if not isinstance(checks, dict) or set(checks) != expected_checks:
        raise ValueError("strength preflight check inventory changed")
    for name, check in checks.items():
        check = exact_keys(check, {"exitCode", "log", "logSha256"}, f"strength preflight {name}")
        log = resolve_path(check["log"], repo, relative_to=preflight.path.parent)
        if check["exitCode"] != 0 or not log.is_file() or sha256(log) != check["logSha256"]:
            raise ValueError(f"strength preflight check invalid: {name}")
    replay_audit_path = preflight.path.parent / "replay-determinism-audit.json"
    replay_audit = load_json(replay_audit_path, "replay-determinism preflight").value
    replay_log_path = resolve_path(
        checks["replayDeterminism"]["log"], repo, relative_to=preflight.path.parent
    )
    try:
        replay_log_value = json.loads(replay_log_path.read_text().strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise ValueError("replay-determinism preflight log is malformed") from error
    replay_contract = strength_protocol.value.get("phase2", {}).get("replayAudit", {})
    if (
        replay_audit != replay_log_value
        or replay_audit.get("schemaVersion") != "arc-v34-replay-determinism-preflight-v1"
        or replay_audit.get("passed") is not True
        or replay_audit.get("implementationCommit") != value.get("implementationCommit")
        or replay_audit.get("gpu") not in runtime.get("eligibleGpus", [])
        or replay_audit.get("gpu") == runtime.get("excludedGpu")
        or replay_audit.get("seed0") != REPLAY_PREFLIGHT_SEED0
        or replay_audit.get("games") != 64
        or replay_audit.get("primaryWorkers") != runtime.get("rawWorkers")
        or replay_audit.get("replayWorkers") != replay_contract.get("workers")
        or replay_audit.get("sameInferenceProcess") is not True
        or replay_audit.get("comparedBySeed") is not True
        or replay_audit.get("mismatches") != 0
        or replay_audit.get("checkpointSha256")
        != strength_protocol.value.get("base", {}).get("checkpointSha256")
        or replay_audit.get("catalogSha256")
        != strength_protocol.value.get("base", {}).get("catalogSha256")
        or replay_audit.get("inference", {}).get("weightsSha256")
        != strength_protocol.value.get("base", {}).get("checkpointSha256")
        or replay_audit.get("lifecycle")
        != {"servingLines": 1, "shutdownLines": 1, "reloadLines": 0, "errorLines": 0}
    ):
        raise ValueError("replay-determinism preflight evidence is malformed or failed")


def validate_strength_lock(
    lock: Artifact,
    source_lock: Artifact,
    strength_protocol: Artifact,
    systems: Artifact,
    phase2_authorization: Artifact,
    eligible: tuple[str, ...],
    repo: Path,
    *,
    verify_git: bool,
) -> Artifact:
    value = exact_keys(
        lock.value,
        {
            "schemaVersion",
            "implementationCommit",
            "baseSourceLock",
            "strengthProtocol",
            "systemsEligibility",
            "phase2Authorization",
            "strengthPreflight",
            "files",
            "environment",
            "eligibleCandidateArms",
            "authorization",
            "createdAt",
        },
        "strength-tooling lock",
    )
    if value.get("schemaVersion") != STRENGTH_LOCK_SCHEMA or not is_commit(value.get("implementationCommit")):
        raise ValueError("invalid strength-tooling lock")
    ref_matches(value.get("baseSourceLock"), source_lock, repo, "strength lock source lock")
    ref_matches(value.get("strengthProtocol"), strength_protocol, repo, "strength lock protocol")
    ref_matches(value.get("systemsEligibility"), systems, repo, "strength lock systems eligibility")
    ref_matches(value.get("phase2Authorization"), phase2_authorization, repo, "strength lock Phase 2 authorization")
    preflight = verify_ref(value.get("strengthPreflight"), repo, "strength lock preflight")
    assert isinstance(preflight, Artifact)
    validate_strength_preflight(
        preflight,
        source_lock,
        strength_protocol,
        systems,
        phase2_authorization,
        eligible,
        repo,
    )
    if value.get("implementationCommit") != preflight.value.get("implementationCommit"):
        raise ValueError("strength lock commit differs from strength preflight")
    files = value.get("files")
    if not isinstance(files, dict) or set(files) != LOCKED_TOOLING_FILES:
        raise ValueError("strength lock omits required Phase 2 tooling")
    for raw_path, expected in files.items():
        path = resolve_path(raw_path, repo)
        if not is_sha256(expected) or not path.is_file() or sha256(path) != expected:
            raise ValueError(f"strength-tooling mismatch: {raw_path}")
    environment = value.get("environment")
    if environment != {"python": platform.python_version(), "numpy": np.__version__}:
        raise ValueError("strength lock runtime differs from analyzer runtime")
    if environment != {
        "python": strength_protocol.value.get("environment", {}).get("python"),
        "numpy": strength_protocol.value.get("environment", {}).get("numpy"),
    }:
        raise ValueError("strength lock runtime differs from strength protocol")
    if value.get("authorization") != {
        "phase2ExecutionOpen": True,
        "guardianSeedsOpen": False,
        "teacherSeedsOpen": False,
        "finalDevelopmentSeedsOpen": False,
        "hiddenSeedsOpen": False,
        "multiplayerSeedsOpen": False,
        "humanReferenceSeedsOpen": False,
        "productionPromotionOpen": False,
    }:
        raise ValueError("strength-tooling authorization changed")
    if tuple(value.get("eligibleCandidateArms", ())) != eligible:
        raise ValueError("strength lock eligible arm set changed")
    if verify_git:
        try:
            result = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", value["implementationCommit"], "HEAD"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise ValueError("cannot verify strength-lock commit ancestry") from exc
        if result.returncode != 0:
            raise ValueError("strength-lock commit is not an ancestor of the executing tree")
    return preflight


def validate_cycle(cycle: Any, arm: str, seed: int) -> dict[str, Any]:
    cycle = exact_keys(cycle, CYCLE_KEYS, f"{arm} seed {seed} cycle")
    vp_after = cycle["vpAfterRound"]
    if not isinstance(vp_after, dict):
        raise ValueError(f"{arm} seed {seed}: cycle vpAfterRound must be an object")
    for round_text, vp in vp_after.items():
        if not isinstance(round_text, str) or not round_text.isdigit() or int(round_text) < 1:
            raise ValueError(f"{arm} seed {seed}: invalid vpAfterRound key")
        finite_number(vp, f"{arm} seed {seed} cycle VP")
    for field in (
        "decisions",
        "productiveDecisions",
        "optionalYieldDecisions",
        "locationInteractions",
        "summons",
        "awakens",
        "combats",
        "rewards",
        "pvpAttacks",
        "finalAttackDice",
        "finalSpirits",
        "finalMaxBarrier",
    ):
        nonnegative_int(cycle[field], f"{arm} seed {seed} cycle {field}")
    if cycle["productiveDecisions"] > cycle["decisions"] or cycle["optionalYieldDecisions"] > cycle["decisions"]:
        raise ValueError(f"{arm} seed {seed}: impossible cycle decision counts")
    for field in ("first15Round", "first30Round"):
        value = cycle[field]
        if value is not None and (type(value) is not int or value < 1 or value > 30):
            raise ValueError(f"{arm} seed {seed}: invalid cycle {field}")
    finite_number(cycle["post15VpPerRound"], f"{arm} seed {seed} cycle post15 rate")
    return cycle


def validate_report(
    report: dict[str, Any],
    *,
    arm: str,
    expected_workers: int,
    implementation_commit: str,
    base: dict[str, Any],
    strength: dict[str, Any],
) -> dict[int, dict[str, Any]]:
    exact_keys(report, REPORT_KEYS, f"{arm} report")
    policy = base["inputs"]["policy"]
    catalog = base["inputs"]["catalog"]
    if (
        report.get("schemaVersion") != REPORT_SCHEMA
        or report.get("sourceCommit") != implementation_commit
        or report.get("weights") != policy.get("path")
        or report.get("weightsSha256") != policy.get("sha256")
        or report.get("catalog") != catalog.get("path")
        or report.get("catalogSha256") != catalog.get("sha256")
        or report.get("seed0") != SEED0
        or report.get("games") != GAMES
        or report.get("maxRounds") != 30
        or report.get("maxStatusLevel") != 2
    ):
        raise ValueError(f"{arm}: report provenance or frozen horizon mismatch")
    inference = exact_keys(report["inference"], INFERENCE_KEYS, f"{arm} inference")
    if (
        inference.get("format") != policy.get("format")
        or inference.get("obsDim") != policy.get("obsDim")
        or inference.get("actDim") != policy.get("actDim")
        or inference.get("weightsSha256") != policy.get("sha256")
        or inference.get("wire") != "binary"
        or not isinstance(inference.get("weightsPath"), str)
        or not inference["weightsPath"]
    ):
        raise ValueError(f"{arm}: inference handshake differs from frozen policy")
    decode = report["decode"]
    expected_decode: dict[str, Any] = {
        "policyObsVersion": 2,
        "inferenceSocket": decode.get("inferenceSocket") if isinstance(decode, dict) else None,
        "learnMonsterRewardChoices": False,
        "sample": True,
        "temperature": 0.55,
    }
    if not isinstance(expected_decode["inferenceSocket"], str) or not expected_decode["inferenceSocket"]:
        raise ValueError(f"{arm}: report lacks an inference socket")
    arm_config = next((row for row in base["systems"]["candidateArms"] if row["id"] == arm), None)
    if arm != REFERENCE_ARM:
        if arm_config is None:
            raise ValueError(f"{arm}: unregistered candidate")
        if arm_config["kind"] == "critic-rerank":
            expected_decode["rerank"] = {"policyRankWeight": arm_config["policyRankWeight"]}
        elif arm_config["kind"] == "heuristic-batched":
            heuristic = base["systems"]["heuristicDecode"]
            expected_decode["search"] = {
                "sims": arm_config["simulations"],
                "objective": "solo-reach30",
                "horizonRounds": arm_config["horizonRounds"],
                "frac": heuristic["frac"],
                "valueWeight": heuristic["valueWeight"],
                "rollout": "heuristic",
                "navTemperature": heuristic["navTemperature"],
            }
        else:
            raise ValueError(f"{arm}: unknown arm kind")
    if decode != expected_decode:
        raise ValueError(f"{arm}: decode schema/parameters are not exact")
    exact_keys(report["trueWinWilson95"], {"lower", "upper"}, f"{arm} Wilson interval")
    exact_keys(report["vp"], {"mean", "p10", "median", "p90", "min", "max"}, f"{arm} VP")
    exact_keys(
        report["vpBuckets"],
        {"under15", "from15To19", "from20To24", "from25To26", "from27To29", "atLeast30WithoutStall", "stalledAtLeast30"},
        f"{arm} VP buckets",
    )
    exact_keys(report["first30Round"], {"mean", "median"}, f"{arm} first30 aggregate")
    exact_keys(
        report["engine"],
        {"meanPost15VpPerRound", "meanFinalAttackDice", "meanFinalSpirits", "meanFinalMaxBarrier"},
        f"{arm} engine aggregate",
    )
    performance_expected = set(PERFORMANCE_KEYS)
    if arm != REFERENCE_ARM:
        performance_expected.add("search")
    performance = exact_keys(report["performance"], performance_expected, f"{arm} performance")
    if performance.get("workers") != expected_workers:
        raise ValueError(f"{arm}: report worker count differs from frozen allocation")
    for field in ("wallSeconds", "gamesPerSecond", "gameWallMsP50", "gameWallMsP95"):
        if finite_number(performance[field], f"{arm} performance {field}") < 0:
            raise ValueError(f"{arm}: negative performance metric")
    if (
        performance["wallSeconds"] <= 0
        or performance["gamesPerSecond"] <= 0
        or performance["gameWallMsP95"] < performance["gameWallMsP50"]
    ):
        raise ValueError(f"{arm}: invalid performance ordering or throughput")
    if arm != REFERENCE_ARM:
        search = exact_keys(performance["search"], SEARCH_PERFORMANCE_KEYS, f"{arm} search telemetry")
        exact_keys(search["byPhase"], {"navigation", "encounter"}, f"{arm} search phase telemetry")
        decisions = nonnegative_int(search["decisions"], f"{arm} search decisions")
        simulations = nonnegative_int(search["simulations"], f"{arm} search simulations")
        if decisions <= 0:
            raise ValueError(f"{arm}: no strategic decisions were recorded")
        for field in ("navigation", "encounter"):
            nonnegative_int(search["byPhase"][field], f"{arm} search {field}")
        if sum(search["byPhase"].values()) != decisions:
            raise ValueError(f"{arm}: strategic phase counts do not sum to decisions")
        finite_number(search["decisionWallMsP50"], f"{arm} decision p50")
        finite_number(search["decisionWallMsP95"], f"{arm} decision p95")
        if search["decisionWallMsP50"] < 0 or search["decisionWallMsP95"] < search["decisionWallMsP50"]:
            raise ValueError(f"{arm}: invalid decision latency telemetry")
        if arm_config["kind"] == "critic-rerank":
            if search["mode"] != "critic-rerank" or simulations != 0:
                raise ValueError(f"{arm}: critic rerank telemetry mismatch")
        elif search["mode"] != "heuristic-batched" or simulations != decisions * arm_config["simulations"]:
            raise ValueError(f"{arm}: heuristic search telemetry mismatch")
    rows = report["perGame"]
    if not isinstance(rows, list) or len(rows) != GAMES:
        raise ValueError(f"{arm}: report does not contain exactly 4,096 per-game rows")
    guardians = [row["name"] for row in strength.get("guardian", {}).get("guardiansFromFrozenCatalog", ())]
    if len(guardians) != 10 or len(set(guardians)) != 10:
        raise ValueError("strength protocol guardian registry is malformed")
    by_seed: dict[int, dict[str, Any]] = {}
    for row in rows:
        exact_keys(row, ROW_KEYS, f"{arm} per-game row")
        seed = row["seed"]
        if type(seed) is not int or seed < SEED0 or seed > SEED_MAX or seed in by_seed:
            raise ValueError(f"{arm}: missing, duplicate, or out-of-range per-game seed")
        if type(row["trueWin"]) is not bool or type(row["stalled"]) is not bool:
            raise ValueError(f"{arm} seed {seed}: invalid outcome flags")
        final_vp = finite_number(row["finalVP"], f"{arm} seed {seed} finalVP")
        post15 = finite_number(row["post15VpPerRound"], f"{arm} seed {seed} post15 rate")
        first30 = row["first30Round"]
        if first30 is not None and (type(first30) is not int or first30 < 1 or first30 > 30):
            raise ValueError(f"{arm} seed {seed}: invalid first30Round")
        expected_guardian = guardians[seed % len(guardians)]
        if row["guardian"] != expected_guardian:
            raise ValueError(f"{arm} seed {seed}: guardian is not the seed-only assignment")
        if row["trueWin"] != (final_vp >= 30 and not row["stalled"]):
            raise ValueError(f"{arm} seed {seed}: trueWin disagrees with score/stall")
        cycle = validate_cycle(row["cycle"], arm, seed)
        if (
            row["first30Round"] != cycle["first30Round"]
            or post15 != float(cycle["post15VpPerRound"])
            or row["finalAttackDice"] != cycle["finalAttackDice"]
            or row["finalSpirits"] != cycle["finalSpirits"]
            or row["finalMaxBarrier"] != cycle["finalMaxBarrier"]
        ):
            raise ValueError(f"{arm} seed {seed}: strategic telemetry differs from cycle summary")
        by_seed[seed] = row
    if set(by_seed) != set(range(SEED0, SEED_MAX + 1)):
        raise ValueError(f"{arm}: exact Phase 2 seed coverage failed")
    true_wins = sum(row["trueWin"] for row in rows)
    stalls = sum(row["stalled"] for row in rows)
    if (
        report["trueWins"] != true_wins
        or not math.isclose(finite_number(report["trueWinRate"], f"{arm} win rate"), true_wins / GAMES, rel_tol=0, abs_tol=1e-15)
        or report["stalls"] != stalls
        or not math.isclose(finite_number(report["stallRate"], f"{arm} stall rate"), stalls / GAMES, rel_tol=0, abs_tol=1e-15)
    ):
        raise ValueError(f"{arm}: report aggregates differ from per-game rows")
    if stalls != 0:
        raise ValueError(f"{arm}: stalled report aborts Phase 2 analysis")
    breakdown = report["guardianBreakdown"]
    if not isinstance(breakdown, list) or len(breakdown) != len(guardians):
        raise ValueError(f"{arm}: guardian breakdown is incomplete")
    breakdown_names: set[str] = set()
    for entry in breakdown:
        exact_keys(entry, {"guardian", "games", "trueWins", "trueWinRate", "trueWinWilson95", "meanVP", "medianVP"}, f"{arm} guardian breakdown")
        exact_keys(entry["trueWinWilson95"], {"lower", "upper"}, f"{arm} guardian Wilson")
        guardian = entry["guardian"]
        if guardian not in guardians or guardian in breakdown_names:
            raise ValueError(f"{arm}: guardian breakdown identity mismatch")
        expected_rows = [row for row in rows if row["guardian"] == guardian]
        if entry["games"] != len(expected_rows) or entry["trueWins"] != sum(row["trueWin"] for row in expected_rows):
            raise ValueError(f"{arm}: guardian breakdown counts mismatch")
        breakdown_names.add(guardian)
    return by_seed


def load_conditions(
    manifest_paths: Sequence[Path],
    *,
    repo: Path,
    strength_lock: Artifact,
    strength_protocol: Artifact,
    systems: Artifact,
    phase2_authorization: Artifact,
    strength_preflight: Artifact,
    eligible: tuple[str, ...],
    base: Artifact,
) -> dict[str, Condition]:
    expected = (REFERENCE_ARM, *eligible)
    conditions: dict[str, Condition] = {}
    for manifest_path in manifest_paths:
        manifest = load_json(manifest_path, "Phase 2 condition manifest")
        value = exact_keys(manifest.value, CONDITION_KEYS, "Phase 2 condition manifest")
        condition_id = value.get("condition")
        if (
            value.get("schemaVersion") != CONDITION_SCHEMA
            or value.get("valid") is not True
            or value.get("immutable") is not True
            or condition_id not in expected
            or condition_id in conditions
        ):
            raise ValueError("condition manifests are malformed, duplicated, or unscheduled")
        attempt = value.get("attempt")
        if attempt not in (1, 2):
            raise ValueError(f"{condition_id}: invalid condition attempt")
        systems_arm = next(row for row in systems.value["arms"] if row["id"] == condition_id) if condition_id != REFERENCE_ARM else None
        expected_workers = 24 if condition_id == REFERENCE_ARM else systems_arm["selectedWorkers"]
        expected_arm = (
            {"id": REFERENCE_ARM, "kind": "raw", "selectedWorkers": 24}
            if condition_id == REFERENCE_ARM
            else {
                **next(row for row in base.value["systems"]["candidateArms"] if row["id"] == condition_id),
                "selectedWorkers": expected_workers,
            }
        )
        if (
            value.get("workers") != expected_workers
            or value.get("arm") != expected_arm
            or value.get("sourceCommit") != strength_lock.value.get("implementationCommit")
            or value.get("seed0") != SEED0
            or value.get("games") != GAMES
            or value.get("seedMax") != SEED_MAX
            or value.get("commonDecode") != strength_protocol.value.get("commonDecode")
            or value.get("checkpoint")
            != {
                "path": base.value.get("inputs", {}).get("policy", {}).get("path"),
                "sha256": base.value.get("inputs", {}).get("policy", {}).get("sha256"),
            }
            or value.get("catalog") != base.value.get("inputs", {}).get("catalog")
            or value.get("stalls") != 0
        ):
            raise ValueError(f"{condition_id}: completion provenance differs from the frozen contract")
        sidecar = Path(f"{manifest.path}.sha256")
        expected_sidecar = f"{manifest.sha256}  {manifest.path.name}"
        if not sidecar.is_file() or sidecar.read_text().strip() != expected_sidecar:
            raise ValueError(f"{condition_id}: completion sidecar is missing or invalid")
        input_keys = set(CONDITION_INPUT_KEYS)
        if attempt == 2:
            input_keys.update({"retryJustification", "retryFailureEvidence"})
        inputs = exact_keys(value.get("inputs"), input_keys, f"{condition_id} completion inputs")
        for name, record in inputs.items():
            verify_file_record(record, repo, f"{condition_id} input {name}")
        file_record_matches(inputs["strengthLock"], strength_lock, repo, f"{condition_id} strength lock")
        file_record_matches(inputs["baseProtocol"], base, repo, f"{condition_id} base protocol")
        file_record_matches(inputs["strengthProtocol"], strength_protocol, repo, f"{condition_id} strength protocol")
        file_record_matches(inputs["systemsEligibility"], systems, repo, f"{condition_id} systems eligibility")
        file_record_matches(inputs["phase2Authorization"], phase2_authorization, repo, f"{condition_id} Phase 2 authorization")
        file_record_matches(inputs["strengthPreflight"], strength_preflight, repo, f"{condition_id} strength preflight")
        report_path = verify_file_record(inputs["report"], repo, f"{condition_id} evaluator report")
        report = load_json(report_path, f"{condition_id} evaluator report")
        replay_path = verify_file_record(inputs["replayReport"], repo, f"{condition_id} replay report")
        replay_report = load_json(replay_path, f"{condition_id} replay report")
        if value.get("inference") != report.value.get("inference"):
            raise ValueError(f"{condition_id}: completion inference differs from evaluator report")
        if Path(verify_file_record(inputs["exitCode"], repo, f"{condition_id} exit code")).read_text().strip() != "0":
            raise ValueError(f"{condition_id}: completion exit code is not zero")
        if Path(verify_file_record(inputs["replayExitCode"], repo, f"{condition_id} replay exit code")).read_text().strip() != "0":
            raise ValueError(f"{condition_id}: replay exit code is not zero")
        replay = exact_keys(replay_report.value, REPORT_KEYS, f"{condition_id} replay report")
        replay_contract = strength_protocol.value.get("phase2", {}).get("replayAudit", {})
        for field in (
            "schemaVersion",
            "sourceCommit",
            "weights",
            "weightsSha256",
            "catalog",
            "catalogSha256",
            "inference",
            "maxRounds",
            "maxStatusLevel",
            "decode",
        ):
            if replay.get(field) != report.value.get(field):
                raise ValueError(f"{condition_id}: replay {field} differs from the primary report")
        replay_rows = replay.get("perGame")
        primary_rows = report.value.get("perGame")
        if (
            replay.get("seed0") != replay_contract.get("seed0")
            or replay.get("games") != replay_contract.get("games")
            or replay.get("seed0") + replay.get("games") - 1 != replay_contract.get("seedMax")
            or replay.get("stalls") != 0
            or replay.get("stallRate") != 0
            or replay.get("performance", {}).get("workers") != replay_contract.get("workers")
            or not isinstance(replay_rows, list)
            or len(replay_rows) != replay_contract.get("games")
            or not isinstance(primary_rows, list)
        ):
            raise ValueError(f"{condition_id}: replay execution differs from the frozen contract")
        replay_by_seed = {row.get("seed"): row for row in replay_rows}
        primary_by_seed = {
            row.get("seed"): row for row in primary_rows[: replay_contract["games"]]
        }
        if len(replay_by_seed) != replay_contract["games"] or len(primary_by_seed) != replay_contract["games"]:
            raise ValueError(f"{condition_id}: replay seed coverage is duplicated or incomplete")
        replay_mismatches = sum(
            replay_by_seed.get(seed) != primary_row
            for seed, primary_row in primary_by_seed.items()
        )
        if replay_mismatches != 0:
            raise ValueError(f"{condition_id}: replay differs from the primary prefix")
        replay_true_wins = sum(row.get("trueWin") is True for row in replay_rows)
        if (
            replay.get("trueWins") != replay_true_wins
            or not math.isclose(
                finite_number(replay.get("trueWinRate"), f"{condition_id} replay win rate"),
                replay_true_wins / replay_contract["games"],
                rel_tol=0,
                abs_tol=1e-15,
            )
        ):
            raise ValueError(f"{condition_id}: replay aggregates differ from replay rows")
        infer_log = verify_file_record(inputs["inferLog"], repo, f"{condition_id} inference log").read_text()
        infer_lines = infer_log.splitlines()
        serving_lines = sum(line.startswith("[infer] serving ") for line in infer_lines)
        shutdown_lines = sum(line == "[infer] shut down" for line in infer_lines)
        reload_lines = sum("[infer] reloaded weights" in line for line in infer_lines)
        error_lines = sum(
            any(token in line for token in ("Traceback", "reload FAILED", "RuntimeError", "Exception"))
            for line in infer_lines
        )
        stats = [
            tuple(int(value) for value in match.groups())
            for line in infer_lines
            if (match := re.search(r"\[infer\] reqs=(\d+) rows=(\d+) batches=(\d+)", line))
        ]
        requests = sum(row[0] for row in stats)
        rows = sum(row[1] for row in stats)
        batches = sum(row[2] for row in stats)
        if (
            serving_lines != 1
            or shutdown_lines != 1
            or reload_lines != 0
            or error_lines != 0
            or requests <= 0
            or rows < requests
            or batches <= 0
        ):
            raise ValueError(f"{condition_id}: inference log is incomplete or contains an error")
        launch_path = verify_file_record(inputs["launch"], repo, f"{condition_id} launch")
        launch = exact_keys(
            load_json(launch_path, f"{condition_id} launch").value,
            LAUNCH_KEYS,
            f"{condition_id} launch",
        )
        runtime = strength_protocol.value.get("runtime", {})
        if (
            launch.get("schemaVersion") != "arc-v34-phase2-launch-v1"
            or launch.get("condition") != condition_id
            or launch.get("attempt") != attempt
            or launch.get("workers") != expected_workers
            or launch.get("sourceCommit") != strength_lock.value.get("implementationCommit")
            or launch.get("seed0") != SEED0
            or launch.get("games") != GAMES
            or launch.get("seedMax") != SEED_MAX
            or launch.get("commonDecode") != strength_protocol.value.get("commonDecode")
            or launch.get("arm") != expected_arm
            or launch.get("gpu") not in runtime.get("eligibleGpus", [])
            or launch.get("gpu") == runtime.get("excludedGpu")
            or launch.get("watchdogSeconds") != 23_400
            or launch.get("watchdogKillAfterSeconds") != 60
            or launch.get("checkpoint")
            != {
                "path": base.value.get("inputs", {}).get("policy", {}).get("path"),
                "sha256": base.value.get("inputs", {}).get("policy", {}).get("sha256"),
            }
            or launch.get("catalog") != base.value.get("inputs", {}).get("catalog")
        ):
            raise ValueError(f"{condition_id}: launch provenance mismatch")
        launch_lock = launch.get("strengthLock", {})
        ref_matches(launch_lock, strength_lock, repo, f"{condition_id} launch strength lock")
        socket = report.value.get("decode", {}).get("inferenceSocket")
        arm_args: list[str] = []
        if expected_arm["kind"] == "critic-rerank":
            arm_args = [
                "--rerank-policy-weight",
                js_number_string(expected_arm["policyRankWeight"]),
            ]
        elif expected_arm["kind"] == "heuristic-batched":
            heuristic = base.value["systems"]["heuristicDecode"]
            arm_args = [
                "--search-sims", js_number_string(expected_arm["simulations"]),
                "--search-horizon", js_number_string(expected_arm["horizonRounds"]),
                "--search-objective", "solo-reach30",
                "--search-rollout", "heuristic",
                "--search-frac", js_number_string(heuristic["frac"]),
                "--search-value-weight", js_number_string(heuristic["valueWeight"]),
                "--search-nav-temperature", js_number_string(heuristic["navTemperature"]),
            ]
        common_decode = strength_protocol.value["commonDecode"]
        expected_argv = [
            "scripts/evaluate-solo-checkpoint.mjs",
            "--weights", base.value["inputs"]["policy"]["path"],
            "--catalog", base.value["inputs"]["catalog"]["path"],
            "--source-commit", strength_lock.value["implementationCommit"],
            "--infer-socket", socket,
            "--policy-obs-version", str(common_decode["policyObsVersion"]),
            "--games", str(GAMES),
            "--workers", str(expected_workers),
            "--seed0", str(SEED0),
            "--max-rounds", str(common_decode["maxRounds"]),
            "--max-status-level", str(common_decode["maxStatusLevel"]),
            "--sample",
            "--temperature", str(common_decode["temperature"]),
            "--include-games",
            *arm_args,
            "--out", inputs["report"]["path"],
        ]
        replay_contract = strength_protocol.value["phase2"]["replayAudit"]
        expected_replay_argv = expected_argv.copy()
        expected_replay_argv[expected_replay_argv.index("--games") + 1] = str(replay_contract["games"])
        expected_replay_argv[expected_replay_argv.index("--workers") + 1] = str(replay_contract["workers"])
        expected_replay_argv[expected_replay_argv.index("--out") + 1] = inputs["replayReport"]["path"]
        if (
            launch.get("evaluatorArgs") != expected_argv
            or launch.get("replayEvaluatorArgs") != expected_replay_argv
        ):
            raise ValueError(f"{condition_id}: launch evaluator argv differs from the frozen contract")
        if attempt == 1:
            if launch.get("retryJustification") is not None:
                raise ValueError(f"{condition_id}: first attempt carries retry justification")
        else:
            justification_path = verify_file_record(inputs["retryJustification"], repo, f"{condition_id} retry justification")
            failure_path = verify_file_record(inputs["retryFailureEvidence"], repo, f"{condition_id} retry failure")
            justification = load_json(justification_path, f"{condition_id} retry justification").value
            failure = load_json(failure_path, f"{condition_id} retry failure").value
            retry_launch_ref = launch.get("retryJustification")
            if (
                not isinstance(retry_launch_ref, dict)
                or retry_launch_ref.get("sha256") != sha256(justification_path)
                or resolve_path(retry_launch_ref.get("path"), repo) != justification_path
            ):
                raise ValueError(f"{condition_id}: launch retry justification mismatch")
            failure_record = justification.get("failureEvidence")
            retryable_codes = {"server-start": 90, "process-interrupted": 92}
            if (
                justification.get("schemaVersion") != "arc-v34-phase2-retry-justification-v1"
                or justification.get("condition") != condition_id
                or justification.get("attempt") != 2
                or justification.get("identicalSeedRetry") is not True
                or justification.get("outcomesInspected") is not False
                or justification.get("infrastructureAttributed") is not True
                or justification.get("attempt1ReportExisted") is not False
                or justification.get("reasonCode") not in retryable_codes
                or justification.get("sourceCommit") != strength_lock.value.get("implementationCommit")
                or justification.get("strengthLockSha256") != strength_lock.sha256
                or justification.get("seed0") != SEED0
                or justification.get("games") != GAMES
                or justification.get("seedMax") != SEED_MAX
                or not isinstance(justification.get("reason"), str)
                or not justification["reason"]
                or failure_record is None
                or verify_file_record(failure_record, repo, f"{condition_id} attempt-1 failure") != failure_path
                or failure.get("schemaVersion") != "arc-v34-phase2-attempt-failure-v1"
                or failure.get("condition") != condition_id
                or failure.get("attempt") != 1
                or failure.get("runtimeError") is not True
                or failure.get("reportExists") is not False
                or failure.get("outcomesInspected") is not False
                or failure.get("sourceCommit") != strength_lock.value.get("implementationCommit")
                or failure.get("strengthLockSha256") != strength_lock.sha256
                or failure.get("reasonCode") != justification.get("reasonCode")
                or failure.get("exitCode") != retryable_codes.get(justification.get("reasonCode"))
                or set(failure.get("files", {}))
                != {"exitCode", "inferLog", "launch", "launchPid", "stderr", "stdout"}
            ):
                raise ValueError(f"{condition_id}: retry evidence is malformed or outcome-dependent")
            for name, record in failure["files"].items():
                verify_file_record(record, repo, f"{condition_id} attempt-1 failure {name}")
        integrity = exact_keys(value["integrity"], INTEGRITY_KEYS, f"{condition_id} integrity")
        if integrity.get("derivedOnlyAfterStrictValidation") is not True:
            raise ValueError(f"{condition_id}: integrity was not derived after strict validation")
        checked_integrity = {
            field: nonnegative_int(integrity[field], f"{condition_id} {field}")
            for field in sorted(INTEGRITY_COUNTER_KEYS)
        }
        if any(checked_integrity.values()):
            raise ValueError(f"{condition_id}: completion integrity counters are nonzero")
        evidence = exact_keys(
            integrity["evidence"],
            {"informationSafety", "replay", "serving", "provenance"},
            f"{condition_id} integrity evidence",
        )
        information_safety = exact_keys(
            evidence["informationSafety"],
            {"strengthPreflight", "vitestExitCode", "determinizationExitCode"},
            f"{condition_id} information-safety evidence",
        )
        file_record_matches(
            information_safety["strengthPreflight"],
            strength_preflight,
            repo,
            f"{condition_id} integrity strength preflight",
        )
        if (
            information_safety["vitestExitCode"] != 0
            or information_safety["determinizationExitCode"] != 0
            or strength_preflight.value.get("passed") is not True
            or strength_preflight.value.get("checks", {}).get("vitest", {}).get("exitCode") != 0
            or strength_preflight.value.get("checks", {}).get("determinization", {}).get("exitCode") != 0
        ):
            raise ValueError(f"{condition_id}: information-safety evidence failed")
        replay_evidence = exact_keys(
            evidence["replay"],
            {"seed0", "games", "workers", "exactPerGameEquality", "preflightExitCode", "mismatches"},
            f"{condition_id} replay evidence",
        )
        expected_replay = strength_protocol.value.get("phase2", {}).get("replayAudit", {})
        if replay_evidence != {
            "seed0": expected_replay.get("seed0"),
            "games": expected_replay.get("games"),
            "workers": expected_replay.get("workers"),
            "exactPerGameEquality": True,
            "preflightExitCode": 0,
            "mismatches": replay_mismatches,
        }:
            raise ValueError(f"{condition_id}: replay evidence differs from the frozen contract")
        serving_evidence = exact_keys(
            evidence["serving"],
            {"servingLines", "shutdownLines", "errorLines", "requests", "rows", "batches"},
            f"{condition_id} serving evidence",
        )
        if serving_evidence != {
            "servingLines": serving_lines,
            "shutdownLines": shutdown_lines,
            "errorLines": error_lines,
            "requests": requests,
            "rows": rows,
            "batches": batches,
        }:
            raise ValueError(f"{condition_id}: serving evidence differs from the inference log")
        provenance_evidence = exact_keys(
            evidence["provenance"],
            {
                "acceptedGameSummariesChecked",
                "evaluatorCrossGameHandshakeInvariant",
                "fixedInferenceProcess",
                "reloadLines",
            },
            f"{condition_id} provenance evidence",
        )
        if provenance_evidence != {
            "acceptedGameSummariesChecked": len(report.value["perGame"]),
            "evaluatorCrossGameHandshakeInvariant": True,
            "fixedInferenceProcess": True,
            "reloadLines": reload_lines,
        }:
            raise ValueError(f"{condition_id}: provenance evidence differs from the frozen contract")
        telemetry = exact_keys(
            value.get("telemetry"),
            {"plannerMode", "strategicDecisions", "strategicSimulations", "decisionWallMsP50", "decisionWallMsP95", "byPhase", "wallSeconds"},
            f"{condition_id} completion telemetry",
        )
        report_search = report.value.get("performance", {}).get("search")
        expected_telemetry = {
            "plannerMode": expected_arm["kind"],
            "strategicDecisions": report_search.get("decisions", 0) if report_search else 0,
            "strategicSimulations": report_search.get("simulations", 0) if report_search else 0,
            "decisionWallMsP50": report_search.get("decisionWallMsP50") if report_search else None,
            "decisionWallMsP95": report_search.get("decisionWallMsP95") if report_search else None,
            "byPhase": report_search.get("byPhase", {"navigation": 0, "encounter": 0}) if report_search else {"navigation": 0, "encounter": 0},
            "wallSeconds": report.value.get("performance", {}).get("wallSeconds"),
        }
        if telemetry != expected_telemetry:
            raise ValueError(f"{condition_id}: completion telemetry differs from evaluator report")
        conditions[condition_id] = Condition(condition_id, manifest, report, checked_integrity)
    if tuple(conditions) != expected:
        # CLI order is part of the immutable aggregate contract; it also makes a
        # swapped/omitted reference fail before any outcomes are inspected.
        raise ValueError(f"condition manifest order must be {list(expected)}")
    return conditions


def paired_effects(indexed: Mapping[str, Mapping[int, dict[str, Any]]], eligible: Iterable[str]) -> dict[str, np.ndarray]:
    raw = indexed[REFERENCE_ARM]
    effects: dict[str, np.ndarray] = {}
    for arm in eligible:
        candidate = indexed[arm]
        wins = np.fromiter(
            ((float(candidate[seed]["trueWin"]) - float(raw[seed]["trueWin"])) * 100.0 for seed in range(SEED0, SEED_MAX + 1)),
            dtype=np.float64,
            count=GAMES,
        )
        final_vp = np.fromiter(
            (float(candidate[seed]["finalVP"]) - float(raw[seed]["finalVP"]) for seed in range(SEED0, SEED_MAX + 1)),
            dtype=np.float64,
            count=GAMES,
        )
        post15 = np.fromiter(
            (float(candidate[seed]["post15VpPerRound"]) - float(raw[seed]["post15VpPerRound"]) for seed in range(SEED0, SEED_MAX + 1)),
            dtype=np.float64,
            count=GAMES,
        )
        censored = np.fromiter(
            (
                float(candidate[seed]["first30Round"] if candidate[seed]["first30Round"] is not None else 31)
                - float(raw[seed]["first30Round"] if raw[seed]["first30Round"] is not None else 31)
                for seed in range(SEED0, SEED_MAX + 1)
            ),
            dtype=np.float64,
            count=GAMES,
        )
        for outcome, array in zip(OUTCOMES, (wins, final_vp, post15, censored), strict=True):
            effects[f"{arm}:{outcome}"] = array
    return effects


def max_t_family(
    effects: Mapping[str, np.ndarray],
    *,
    draws: int = BOOTSTRAP_DRAWS,
    rng_seed: int = BOOTSTRAP_SEED,
    confidence: float = CONFIDENCE,
    family_size: int = FAMILY_SIZE,
    chunk_size: int = 64,
) -> dict[str, Any]:
    if draws <= 0 or family_size <= 0 or not (0 < confidence < 1):
        raise ValueError("invalid max-t configuration")
    labels = list(effects)
    if not labels:
        raise ValueError("max-t family has no observed endpoints")
    lengths = {np.asarray(effects[label]).shape for label in labels}
    if len(lengths) != 1:
        raise ValueError("max-t endpoints have unequal shapes")
    shape = lengths.pop()
    if len(shape) != 1 or shape[0] < 2:
        raise ValueError("max-t endpoints require at least two paired seeds")
    matrix = np.column_stack([np.asarray(effects[label], dtype=np.float64) for label in labels])
    if not np.isfinite(matrix).all():
        raise ValueError("max-t endpoints must be finite")
    means = matrix.mean(axis=0)
    standard_errors = matrix.std(axis=0, ddof=1) / math.sqrt(matrix.shape[0])
    active = standard_errors > 0
    maxima = np.zeros(draws, dtype=np.float64)
    rng = np.random.Generator(np.random.PCG64(rng_seed))
    if np.any(active):
        active_matrix = matrix[:, active]
        active_means = means[active]
        active_se = standard_errors[active]
        for start in range(0, draws, chunk_size):
            count = min(chunk_size, draws - start)
            indices = rng.integers(0, matrix.shape[0], size=(count, matrix.shape[0]))
            bootstrap_means = active_matrix[indices].mean(axis=1)
            studentized = (bootstrap_means - active_means) / active_se
            maxima[start : start + count] = np.max(np.abs(studentized), axis=1)
    rank = math.ceil(confidence * draws) - 1
    empirical = float(np.partition(maxima, rank)[rank])
    alpha = 0.05 if confidence == 0.95 else 1 - confidence
    floor = float(NormalDist().inv_cdf(1 - alpha / (2 * family_size)))
    critical = max(empirical, floor)
    endpoints: dict[str, dict[str, Any]] = {}
    for index, label in enumerate(labels):
        mean = float(means[index])
        se = float(standard_errors[index])
        endpoints[label] = {
            "mean": mean,
            "standardError": se,
            "zeroStandardError": se == 0.0,
            "simultaneousLower": mean if se == 0.0 else mean - critical * se,
            "simultaneousUpper": mean if se == 0.0 else mean + critical * se,
        }
    return {
        "method": "complete-seed centered paired max-t bootstrap",
        "draws": draws,
        "rng": "numpy.random.Generator(numpy.random.PCG64)",
        "rngSeed": rng_seed,
        "confidence": confidence,
        "nearestRankIndex": rank,
        "registeredEndpointCount": family_size,
        "observedEndpointCount": len(labels),
        "nonzeroStandardErrorEndpointCount": int(active.sum()),
        "empiricalCritical": empirical,
        "bonferroniNormalFloor": floor,
        "critical": critical,
        "endpoints": endpoints,
    }


def evaluate_arm_gates(
    endpoints: Mapping[str, Mapping[str, Any]],
    *,
    binding: Mapping[str, Any],
    integrity: Mapping[str, int],
    stalls: int,
) -> dict[str, bool]:
    """Evaluate every preregistered core gate, including zero-SE point bounds."""

    return {
        "winPointGainAtLeast3": endpoints["winPoints"]["mean"] >= 3.0,
        "winSimultaneousLowerStrictlyAbove0": endpoints["winPoints"]["simultaneousLower"] > 0.0,
        "finalVpSimultaneousLowerAtLeastMinus0p5": endpoints["finalVp"]["simultaneousLower"] >= -0.5,
        "post15SimultaneousLowerAtLeastMinus0p025": endpoints["post15VpPerRound"]["simultaneousLower"] >= -0.025,
        "censoredFirst30SimultaneousUpperAtMost0p5": endpoints["censoredFirst30Round"]["simultaneousUpper"] <= 0.5,
        "bindingLatencyStillValid": binding["binding-w1"] <= 1000 and binding["binding-w8"] <= 2000,
        "stallsZero": stalls == 0,
        "informationSafetyFailuresZero": integrity["informationSafetyFailures"] == 0,
        "replayMismatchesZero": integrity["replayMismatches"] == 0,
        "servingErrorsZero": integrity["servingErrors"] == 0,
        "provenanceMismatchesZero": integrity["provenanceMismatches"] == 0,
    }


def analyze_phase2(
    *,
    repo: Path,
    base: Artifact,
    strength_protocol: Artifact,
    source_lock: Artifact,
    systems_authorization: Artifact,
    systems: Artifact,
    phase2_authorization: Artifact,
    strength_lock: Artifact,
    manifest_paths: Sequence[Path],
    verify_git: bool = True,
) -> dict[str, Any]:
    repo = repo.resolve()
    validate_base_protocol(base.value)
    validate_source_lock(source_lock, repo)
    validate_strength_protocol(strength_protocol.value, base, source_lock, repo)
    validate_preflight_and_systems_authorization(systems_authorization, source_lock, base, repo)
    eligible = validate_systems_eligibility(systems, base, systems_authorization, repo)
    if not eligible:
        raise ValueError("Phase 2 authorization cannot be consumed with no systems-eligible arm")
    validate_phase2_authorization(phase2_authorization, systems, eligible, repo)
    strength_preflight = validate_strength_lock(
        strength_lock,
        source_lock,
        strength_protocol,
        systems,
        phase2_authorization,
        eligible,
        repo,
        verify_git=verify_git,
    )
    conditions = load_conditions(
        manifest_paths,
        repo=repo,
        strength_lock=strength_lock,
        strength_protocol=strength_protocol,
        systems=systems,
        phase2_authorization=phase2_authorization,
        strength_preflight=strength_preflight,
        eligible=eligible,
        base=base,
    )
    systems_by_arm = {row["id"]: row for row in systems.value["arms"]}

    # Validate every complete report and all exact cross-condition pairings
    # before constructing the first strength endpoint.
    indexed: dict[str, dict[int, dict[str, Any]]] = {}
    for arm, condition in conditions.items():
        workers = 24 if arm == REFERENCE_ARM else systems_by_arm[arm]["selectedWorkers"]
        indexed[arm] = validate_report(
            condition.report.value,
            arm=arm,
            expected_workers=workers,
            implementation_commit=strength_lock.value["implementationCommit"],
            base=base.value,
            strength=strength_protocol.value,
        )
    raw_integrity = conditions[REFERENCE_ARM].integrity
    if any(raw_integrity.values()):
        raise ValueError("raw reference contains safety/provenance failures")
    for seed in range(SEED0, SEED_MAX + 1):
        raw_guardian = indexed[REFERENCE_ARM][seed]["guardian"]
        if any(indexed[arm][seed]["guardian"] != raw_guardian for arm in eligible):
            raise ValueError(f"seed {seed}: guardian pairing differs across conditions")

    effects = paired_effects(indexed, eligible)
    family = max_t_family(effects)
    arm_results: list[dict[str, Any]] = []
    passing: list[str] = []
    for arm in REGISTERED_ARMS:
        operational = arm in eligible
        if not operational:
            arm_results.append(
                {
                    "arm": arm,
                    "systemsEligible": False,
                    "reportComplete": False,
                    "failedRegisteredSlot": True,
                    "rejectionReason": systems_by_arm[arm]["rejectionReason"],
                    "endpoints": None,
                    "gates": {"systemsEligible": False},
                    "corePass": False,
                }
            )
            continue
        endpoints = {
            outcome: family["endpoints"][f"{arm}:{outcome}"] for outcome in OUTCOMES
        }
        integrity = conditions[arm].integrity
        binding = systems_by_arm[arm]["binding"]
        gates = evaluate_arm_gates(
            endpoints,
            binding=binding,
            integrity=integrity,
            stalls=conditions[arm].report.value["stalls"],
        )
        core_pass = all(gates.values())
        if core_pass:
            passing.append(arm)
        arm_results.append(
            {
                "arm": arm,
                "systemsEligible": True,
                "reportComplete": True,
                "failedRegisteredSlot": False,
                "rejectionReason": None,
                "selectedWorkers": systems_by_arm[arm]["selectedWorkers"],
                "bindingDecisionWallMsP95": binding,
                "integrity": integrity,
                "endpoints": endpoints,
                "gates": gates,
                "corePass": core_pass,
            }
        )
    rejected = [arm for arm in REGISTERED_ARMS if arm not in eligible]
    input_refs = {
        "baseProtocol": artifact_ref(base, repo),
        "originalSourceLock": artifact_ref(source_lock, repo),
        "strengthProtocol": artifact_ref(strength_protocol, repo),
        "systemsAuthorization": artifact_ref(systems_authorization, repo),
        "systemsEligibility": artifact_ref(systems, repo),
        "phase2Authorization": artifact_ref(phase2_authorization, repo),
        "strengthToolingLock": artifact_ref(strength_lock, repo),
        "strengthPreflight": artifact_ref(strength_preflight, repo),
        "conditions": [
            {
                "arm": arm,
                "manifest": artifact_ref(conditions[arm].manifest, repo),
                "report": artifact_ref(conditions[arm].report, repo),
            }
            for arm in conditions
        ],
    }
    return {
        "schemaVersion": ANALYSIS_SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "strengthUse": True,
        "inputs": input_refs,
        "contract": {
            "seed0": SEED0,
            "games": GAMES,
            "seedMax": SEED_MAX,
            "referenceArm": REFERENCE_ARM,
            "registeredCandidateSlots": list(REGISTERED_ARMS),
            "systemsEligibleArms": list(eligible),
            "systemsRejectedFailedSlots": rejected,
            "outcomes": list(OUTCOMES),
            "python": platform.python_version(),
            "numpy": np.__version__,
        },
        "simultaneousFamily": family,
        "arms": arm_results,
        "corePassingArms": passing,
        "decision": {
            "laneAStatus": "guardian-confirmation-required" if passing else "closed-no-core-pass",
            "laneBReferenceArm": REFERENCE_ARM,
            "guardianAuthorizationMayOpen": bool(passing),
            "guardianAuthorizationMustNameExactly": passing,
            "winnerSelected": False,
            "guardianSeedsOpen": False,
            "teacherSeedsOpen": False,
            "finalDevelopmentSeedsOpen": False,
            "hiddenSeedsOpen": False,
            "multiplayerSeedsOpen": False,
            "humanReferenceSeedsOpen": False,
            "productionPromotionOpen": False,
        },
    }


def deterministic_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"


def write_immutable_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = deterministic_json(value)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o444)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--strength-protocol", type=Path, required=True)
    parser.add_argument("--source-lock", type=Path, required=True)
    parser.add_argument("--systems-authorization", type=Path, required=True)
    parser.add_argument("--systems-eligibility", type=Path, required=True)
    parser.add_argument("--phase2-authorization", type=Path, required=True)
    parser.add_argument("--strength-lock", type=Path, required=True)
    parser.add_argument(
        "--condition",
        type=Path,
        action="append",
        required=True,
        help="immutable condition manifest; repeat in raw then authorized-arm order",
    )
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo = args.repo.resolve()
    manifest_paths = [resolve_path(str(path), repo) for path in args.condition]
    strength_lock_path = resolve_path(str(args.strength_lock), repo)
    recorder = repo / "scripts/record-v34-phase2-condition.mjs"
    if not recorder.is_file():
        raise ValueError("locked JS completion verifier is missing")
    for manifest_path in manifest_paths:
        verification = subprocess.run(
            [
                "node",
                str(recorder),
                "verify",
                "--strength-lock",
                str(strength_lock_path),
                "--manifest",
                str(manifest_path),
            ],
            cwd=repo,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if verification.returncode != 0:
            raise ValueError(f"JS completion verification failed: {manifest_path}")
    result = analyze_phase2(
        repo=repo,
        base=load_json(resolve_path(str(args.protocol), repo), "base protocol"),
        strength_protocol=load_json(resolve_path(str(args.strength_protocol), repo), "strength protocol"),
        source_lock=load_json(resolve_path(str(args.source_lock), repo), "original source lock"),
        systems_authorization=load_json(resolve_path(str(args.systems_authorization), repo), "systems authorization"),
        systems=load_json(resolve_path(str(args.systems_eligibility), repo), "systems eligibility"),
        phase2_authorization=load_json(resolve_path(str(args.phase2_authorization), repo), "Phase 2 authorization"),
        strength_lock=load_json(strength_lock_path, "strength-tooling lock"),
        manifest_paths=manifest_paths,
    )
    write_immutable_json(resolve_path(str(args.out), repo), result)
    print(deterministic_json(result), end="")


if __name__ == "__main__":
    main()
