#!/usr/bin/env python3
"""Frozen, outcome-blind readiness contracts for the P30 campaign."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from v35_p30_crypto import (
    canonical_json,
    read_regular_nofollow,
    role_public_key_path,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)
from v35_p30_analysis_review import (
    APPROVED_REVIEW_CONTAINER,
    CLAUDE_AUTH_DELIVERY,
    CONTAINER_REVIEW_ROOT,
    SANITIZED_ENVIRONMENT_KEYS,
    expected_container_cleanup_argv,
    expected_container_config,
    expected_container_create_argv,
    expected_container_start_argv,
    validate_authenticated_liveness,
    validate_clock_skew_preflight,
)


PHASE0_NAMES = (
    "fault-injection",
    "analyzer-rehearsal",
    "cuda-determinism",
)
PHASE0_REPORT_SCHEMAS = {
    "fault-injection": "arc-v35-p30-fault-injection-preflight-v1",
    "analyzer-rehearsal": "arc-v35-p30-analyzer-synthetic-rehearsal-v1",
    "cuda-determinism": "arc-v35-p30-cuda-determinism-preflight-v1",
}
PHASE0_READINESS_SCHEMA = "arc-v35-p30-phase0-readiness-v1"
REVIEW_RECEIPT_SCHEMA = "arc-v35-p30-gate-review-receipt-v2"
FULL_CAMPAIGN_AUTHORIZATION_SCHEMA = (
    "arc-v35-p30-full-campaign-authorization-v1"
)
GATE_REVIEW_REQUEST_SCHEMA = "arc-v35-p30-gate-review-request-v1"


def gate_review_prompt(mode: str, input_paths: list[str]) -> str:
    if mode not in {"phase0-runtime", "full-campaign"} or not input_paths:
        raise ValueError("invalid P30 gate-review prompt inputs")
    input_names = ", ".join(input_paths)
    if mode == "phase0-runtime":
        return (
            "Independently audit the Arc Spirits P30 launch evidence in "
            f"{input_names}. Verify the signed CPU fault matrix, synthetic analyzer "
            "rehearsal, exact fresh-server CUDA determinism, isolation, disk/runtime "
            "safety, and that no outcome metric was exposed. Identify any P0/P1 launch "
            "blocker. End the final nonempty line with exactly VERDICT: ACCEPT only if "
            "none remains; otherwise end with exactly VERDICT: REJECT."
        )
    return (
        "Review the immutable P30 full-campaign authorization inputs in "
        f"{input_names}. Verify Phase 0 readiness, the signed matched generation-one "
        "storage/runtime projection, outcome blindness, GPU7-only isolation, and the "
        "remaining campaign stop gates. Identify any P0/P1 blocker to continuing the "
        "sealed campaign. End the final nonempty line with exactly VERDICT: ACCEPT "
        "only if none remains; otherwise end with exactly VERDICT: REJECT."
    )


def ledger_for(protocol: Mapping[str, Any]) -> Path:
    trust = protocol["executionTrust"]
    return Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]


def artifact_root(protocol: Mapping[str, Any]) -> Path:
    return Path(
        "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-artifacts"
    ) / str(protocol["executionTrust"]["campaignInstanceId"])


def phase0_output_root(protocol: Mapping[str, Any], name: str) -> Path:
    if name not in PHASE0_NAMES:
        raise ValueError("unknown P30 phase-zero preflight")
    return artifact_root(protocol) / "phase0" / name


def phase0_authorization_path(protocol: Mapping[str, Any], name: str) -> Path:
    if name not in PHASE0_NAMES:
        raise ValueError("unknown P30 phase-zero preflight")
    return ledger_for(protocol) / "authorizations" / f"phase0-{name}.json"


def phase0_readiness_path(protocol: Mapping[str, Any]) -> Path:
    return ledger_for(protocol) / "preflights" / "phase0-readiness.signed.json"


def gate_review_paths(
    protocol: Mapping[str, Any], mode: str
) -> dict[str, Path]:
    if mode not in {"phase0-runtime", "full-campaign"}:
        raise ValueError("unknown P30 gate-review mode")
    root = ledger_for(protocol) / "reviews" / mode
    return {
        "request": ledger_for(protocol)
        / "requests"
        / f"{mode}-fable-review.json",
        "attempt": root / "attempt.json",
        "stdout": root / "fable.stdout",
        "stderr": root / "fable.stderr",
        "receipt": root / "review-receipt.signed.json",
    }


def full_campaign_authorization_path(protocol: Mapping[str, Any]) -> Path:
    return (
        ledger_for(protocol)
        / "authorizations"
        / "full-campaign.signed.json"
    )


def _read_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def binding(path: Path) -> dict[str, str]:
    return {"path": str(path), "sha256": sha256_file(path)}


def gate_review_launcher_sha256() -> str:
    return sha256_file(
        Path(__file__).resolve().parent / "run_v35_p30_gate_review_local.py"
    )


def validate_gate_review_receipt(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    mode: str,
    required_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    paths = gate_review_paths(protocol, mode)
    signed = _read_object(paths["receipt"], f"{mode} review receipt")
    receipt = verify_signed_payload(
        signed,
        expected_role="review-attester",
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "review-attester"
        ),
    )
    expected_keys = {
        "schemaVersion",
        "valid",
        "immutable",
        "promotionEligible",
        "outcomesInspected",
        "mode",
        "model",
        "effort",
        "tools",
        "noSessionPersistence",
        "verdict",
        "protocol",
        "sourceContractSha256",
        "inputs",
        "request",
        "attempt",
        "completion",
        "launcherSha256",
        "claudeExecutable",
        "containerRuntime",
        "containerArgv",
        "containerName",
        "containerInvocationSha256",
        "containerId",
        "containerConfig",
        "containerConfigSha256",
        "startArgv",
        "cleanupArgv",
        "cleanupVerified",
        "authenticatedLiveness",
        "clockSkewPreflight",
        "argv",
        "cwd",
        "containerCwd",
        "environmentKeys",
        "authDelivery",
        "startedAtUtc",
        "finishedAtUtc",
        "exitCode",
        "stdout",
        "stderr",
        "signature",
    }
    pinned_claude = protocol["executionTrust"]["reviewRuntime"][
        "claudeExecutable"
    ]
    pinned_container = protocol["executionTrust"]["reviewRuntime"]["container"]
    argv = receipt.get("argv")
    environment_keys = receipt.get("environmentKeys")
    capsule = Path(str(receipt.get("cwd")))
    container_name = receipt.get("containerName")
    container_id = receipt.get("containerId")
    expected_prompt = gate_review_prompt(
        mode,
        [
            str(CONTAINER_REVIEW_ROOT / "inputs" / f"input-{index:02d}{Path(item['path']).suffix}")
            for index, item in enumerate(required_inputs)
        ],
    )
    expected_claude_argv = [
        pinned_claude["path"], "-p", "--model", "fable", "--effort", "high",
        "--tools", "Read", "--no-session-persistence", expected_prompt,
    ]
    expected_create_argv = expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=expected_claude_argv
    )
    expected_config = expected_container_config(
        capsule=capsule, container_name=container_name, container_id=container_id,
        claude_argv=expected_claude_argv,
    )
    expected_invocation_sha = sha256_bytes(canonical_json(expected_create_argv))
    expected_config_sha = sha256_bytes(canonical_json(expected_config))
    authenticated_liveness = receipt.get("authenticatedLiveness")
    validate_authenticated_liveness(
        authenticated_liveness, capsule=capsule, verify_local_files=False
    )
    clock_skew_preflight = receipt.get("clockSkewPreflight")
    validate_clock_skew_preflight(clock_skew_preflight)
    attempt_payload = _read_object(paths["attempt"], f"{mode} review attempt")
    request_payload = _read_object(paths["request"], f"{mode} review request")
    expected_request_subject = {
        "logicalId": f"{mode}-fable-review",
        "mode": mode,
        "inputs": required_inputs,
        "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
        "launcherSha256": gate_review_launcher_sha256(),
    }
    expected_attempt_keys = {
        "schemaVersion", "valid", "immutable", "promotionEligible",
        "outcomesInspected", "mode", "request", "inputsSha256",
        "launcherSha256", "claudeExecutable", "containerRuntime",
        "containerName", "containerInvocationSha256", "containerId",
        "containerConfigSha256", "nonce", "reservedAtUtc",
        "authenticatedLiveness",
        "clockSkewPreflight",
    }
    if (
        set(signed) != expected_keys
        or receipt.get("schemaVersion") != REVIEW_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("immutable") is not True
        or receipt.get("promotionEligible") is not False
        or receipt.get("outcomesInspected") is not False
        or receipt.get("mode") != mode
        or receipt.get("model") != "fable"
        or receipt.get("effort") != "high"
        or receipt.get("tools") != ["Read"]
        or receipt.get("noSessionPersistence") is not True
        or receipt.get("verdict") != "ACCEPT"
        or receipt.get("protocol")
        != {"path": str(protocol_path), "sha256": sha256_file(protocol_path)}
        or receipt.get("sourceContractSha256")
        != protocol["sourceContract"]["sha256"]
        or receipt.get("inputs") != required_inputs
        or receipt.get("request") != binding(paths["request"])
        or request_payload.get("role") != "review-attester"
        or request_payload.get("verb") != "attest-gate-review"
        or request_payload.get("subject") != expected_request_subject
        or request_payload.get("expectedOutputPath") != str(paths["receipt"])
        or receipt.get("attempt") != binding(paths["attempt"])
        or not isinstance(receipt.get("completion"), dict)
        or set(receipt["completion"]) != {"path", "sha256"}
        or not Path(receipt["completion"]["path"]).is_absolute()
        or len(receipt["completion"]["sha256"]) != 64
        or receipt.get("launcherSha256") != gate_review_launcher_sha256()
        or receipt.get("claudeExecutable") != pinned_claude
        or receipt.get("containerRuntime") != pinned_container
        or pinned_container != APPROVED_REVIEW_CONTAINER
        or argv != expected_claude_argv
        or receipt.get("containerArgv") != expected_create_argv
        or receipt.get("containerInvocationSha256") != expected_invocation_sha
        or receipt.get("containerConfig") != expected_config
        or receipt.get("containerConfigSha256") != expected_config_sha
        or receipt.get("startArgv") != expected_container_start_argv(container_name)
        or receipt.get("cleanupArgv") != expected_container_cleanup_argv(container_name)
        or receipt.get("cleanupVerified") is not True
        or not capsule.is_absolute()
        or receipt.get("containerCwd") != str(CONTAINER_REVIEW_ROOT)
        or environment_keys != list(SANITIZED_ENVIRONMENT_KEYS)
        or receipt.get("authDelivery") != CLAUDE_AUTH_DELIVERY
        or set(attempt_payload) != expected_attempt_keys
        or attempt_payload.get("schemaVersion") != "arc-v35-p30-gate-review-attempt-v2"
        or attempt_payload.get("valid") is not True
        or attempt_payload.get("immutable") is not True
        or attempt_payload.get("promotionEligible") is not False
        or attempt_payload.get("outcomesInspected") is not False
        or attempt_payload.get("mode") != mode
        or attempt_payload.get("request") != binding(paths["request"])
        or attempt_payload.get("inputsSha256") != outcome_blind_inputs_hash(required_inputs)
        or attempt_payload.get("launcherSha256") != gate_review_launcher_sha256()
        or attempt_payload.get("claudeExecutable") != pinned_claude
        or attempt_payload.get("containerRuntime") != pinned_container
        or attempt_payload.get("containerName") != container_name
        or attempt_payload.get("containerInvocationSha256") != expected_invocation_sha
        or attempt_payload.get("containerId") != container_id
        or attempt_payload.get("containerConfigSha256") != expected_config_sha
        or attempt_payload.get("authenticatedLiveness") != authenticated_liveness
        or attempt_payload.get("clockSkewPreflight") != clock_skew_preflight
        or not isinstance(attempt_payload.get("nonce"), str)
        or len(attempt_payload["nonce"]) != 64
        or not isinstance(attempt_payload.get("reservedAtUtc"), str)
        or receipt.get("exitCode") != 0
        or receipt.get("stdout") != binding(paths["stdout"])
        or receipt.get("stderr") != binding(paths["stderr"])
        or paths["stderr"].stat().st_size != 0
    ):
        raise ValueError(f"{mode} Fable review receipt is invalid")
    lines = [
        line.strip()
        for line in read_regular_nofollow(paths["stdout"])
        .decode("utf-8")
        .splitlines()
        if line.strip()
    ]
    if not lines or lines[-1] != "VERDICT: ACCEPT":
        raise ValueError(f"{mode} Fable review did not accept exactly")
    return receipt


def outcome_blind_inputs_hash(inputs: list[dict[str, str]]) -> str:
    return sha256_bytes(canonical_json(inputs))
