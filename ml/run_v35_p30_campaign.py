#!/usr/bin/env python3
"""Keyless, outcome-blind next-action scheduler for the sealed P30 campaign."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import secrets
import shutil
import stat
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import (
    ARMS,
    REPLICATES,
    REPO_ROOT,
    endpoint_label,
    read_json_object,
    sha256,
    validate_protocol,
)
from v35_p30_authorized_execution import (
    AUTHORIZATION_SCHEMA,
    RECEIPT_SCHEMA,
    normal_seal_attempt_path,
    pre_child_recovery_attempt_path,
    prepare_receipt_only_recovery_draft,
    recovery_seal_attempt_path,
    unsigned_receipt_path,
    validate_authorization,
    validate_pre_child_recovery_attempt,
    validate_unsigned_receipt_draft,
)
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    read_regular_nofollow,
    role_public_key_path,
    sha256_file,
    verify_signed_payload,
)
from v35_p30_recovery import (
    PRE_CHILD,
    RECEIPT_ONLY,
    RECOVERY_ELIGIBLE_KINDS,
    recovery_execution_draft_path,
    protected_bindings_sha256,
    validate_execution_draft,
    validate_guardian_incident,
    validate_recovery_link,
    validate_sealed_pre_child_draft,
)
from v35_p30_phase0 import (
    FULL_CAMPAIGN_AUTHORIZATION_SCHEMA,
    PHASE0_NAMES,
    PHASE0_READINESS_SCHEMA,
    PHASE0_REPORT_SCHEMAS,
    binding as phase0_binding,
    full_campaign_authorization_path,
    gate_review_launcher_sha256,
    gate_review_paths,
    phase0_authorization_path,
    phase0_output_root,
    phase0_readiness_path,
    validate_gate_review_receipt,
)


PREFLIGHT_SCHEMA = "arc-v35-p30-outcome-blind-preflight-v1"
PREFLIGHT_START_SCHEMA = "arc-v35-p30-preflight-start-v1"
FINAL_BARRIER_SCHEMA = "arc-v35-p30-final-generation-completeness-v1"
PAIR_SCHEMA = "arc-v35-p30-evaluation-pair-integrity-v1"
ANALYSIS_MANIFEST_SCHEMA = "arc-v35-p30-analysis-manifest-v1"
ROLE_REQUEST_SCHEMA = "arc-v35-p30-role-request-v1"
LOGICAL_COMPLETION_SCHEMA = "arc-v35-p30-logical-completion-v1"
DISK_FLOOR_BYTES = 6 * 1024**3
EVALUATION_RESERVE_BYTES = 512 * 1024**2
STORAGE_RESERVATION_SCHEMA = "arc-v35-p30-storage-reservation-v1"
EXPERIMENT_RELATIVE = Path(
    "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon"
)


def elapsed_seconds(receipt: dict[str, Any]) -> float:
    def parse(value: Any) -> dt.datetime:
        if not isinstance(value, str) or not value.endswith("Z"):
            raise ValueError("execution receipt timestamp is malformed")
        return dt.datetime.fromisoformat(value[:-1] + "+00:00")

    value = (
        parse(receipt.get("finishedAtUtc")) - parse(receipt.get("startedAtUtc"))
    ).total_seconds()
    if value <= 0:
        raise ValueError("execution receipt has non-positive duration")
    return value


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def disk_free(path: Path) -> int:
    return shutil.disk_usage(path).free


def storage_reservation_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "reservations/projected-output.fallocate"


def storage_reservation_bytes(protocol: dict[str, Any]) -> int:
    path = storage_reservation_path(protocol)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return 0
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ValueError("P30 storage reservation is not a regular file")
    allocated = int(metadata.st_blocks) * 512
    if allocated < metadata.st_size:
        raise ValueError("P30 storage reservation became sparse")
    return allocated


def set_storage_reservation(protocol: dict[str, Any], desired_bytes: int) -> int:
    """Reserve real shared-storage blocks before the next campaign action.

    The caller releases exactly one projected action allocation by lowering
    ``desired_bytes``.  ``posix_fallocate`` prevents another tenant from taking
    blocks already committed to later P30 artifacts.
    """

    if type(desired_bytes) is not int or desired_bytes < 0:
        raise ValueError("P30 storage reservation size is malformed")
    path = storage_reservation_path(protocol)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError("P30 storage reservation permissions changed")
        current = metadata.st_size
        if desired_bytes > current:
            os.posix_fallocate(descriptor, current, desired_bytes - current)
        elif desired_bytes < current:
            os.ftruncate(descriptor, desired_bytes)
        os.fsync(descriptor)
        final = os.fstat(descriptor)
        if final.st_size != desired_bytes or int(final.st_blocks) * 512 < desired_bytes:
            raise RuntimeError("P30 storage reservation was not physically allocated")
    finally:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return storage_reservation_bytes(protocol)


def root_for(replicate: str, arm: str) -> Path:
    return REPO_ROOT / EXPERIMENT_RELATIVE / "league" / f"rep-{replicate}" / arm


def ledger_for(protocol: dict[str, Any]) -> Path:
    trust = protocol["executionTrust"]
    instance = trust.get("campaignInstanceId")
    if (
        not isinstance(instance, str)
        or len(instance) != 64
        or any(character not in "0123456789abcdef" for character in instance)
    ):
        raise ValueError("P30 campaign instance is not frozen")
    return Path(trust["ledgerRoot"]) / instance


def generation_authorization_path(
    ledger: Path, replicate: str, arm: str, generation: int
) -> Path:
    return ledger / "authorizations" / f"{endpoint_label(replicate, arm)}-gen{generation}.json"


def evaluation_authorization_path(ledger: Path, label: str, role: str) -> Path:
    return ledger / "authorizations" / f"{label}-evaluation-{role}.json"


def preflight_path(protocol_path: Path, protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "preflights" / f"{sha256(protocol_path)[:24]}.json"


def preflight_start_path(protocol_path: Path, protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "preflights" / f"{sha256(protocol_path)[:24]}.start.json"


def ensure_preflight_start(protocol_path: Path, protocol: dict[str, Any]) -> Path:
    path = preflight_start_path(protocol_path, protocol)
    if path.exists():
        value = read_json_object(path, "P30 preflight start")
        if (
            value.get("schemaVersion") != PREFLIGHT_START_SCHEMA
            or value.get("protocolSha256") != sha256(protocol_path)
            or type(value.get("initialFreeBytes")) is not int
            or value["initialFreeBytes"] < 8 * 1024**3
            or not isinstance(value.get("startedAtUtc"), str)
        ):
            raise ValueError("P30 preflight start record is invalid")
        return path
    initial_free = disk_free(Path("/data/share8"))
    if initial_free < 8 * 1024**3:
        raise ValueError("P30 preflight requires at least 8 GiB of /data/share8 headroom")
    payload = {
        "schemaVersion": PREFLIGHT_START_SCHEMA,
        "protocolSha256": sha256(protocol_path),
        "startedAtUtc": utc_now(),
        "initialFreeBytes": initial_free,
        "outcomesInspected": False,
        "promotionEligible": False,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_exclusive(path, canonical_json(payload) + b"\n")
    return path


def phase0_review_inputs(
    protocol_path: Path, protocol: dict[str, Any]
) -> list[dict[str, str]]:
    inputs = [
        phase0_binding(protocol_path),
        phase0_binding(REPO_ROOT / protocol["plan"]),
        phase0_binding(
            REPO_ROOT / protocol["sourceContract"]["artifact"]
            if not Path(protocol["sourceContract"]["artifact"]).is_absolute()
            else Path(protocol["sourceContract"]["artifact"])
        ),
    ]
    for name in PHASE0_NAMES:
        authorization_path = phase0_authorization_path(protocol, name)
        authorization = validate_stored_authorization(
            authorization_path=authorization_path,
            protocol_path=protocol_path,
            kind="preflight",
            root=phase0_output_root(protocol, name),
            replicate="phase0",
            arm=name,
        )
        receipt_path, _ = validate_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
        inputs.extend(
            (
                phase0_binding(receipt_path),
                phase0_binding(phase0_output_root(protocol, name) / "report.json"),
            )
        )
    return inputs


def full_campaign_review_inputs(
    protocol_path: Path, protocol: dict[str, Any]
) -> list[dict[str, str]]:
    source_path = Path(protocol["sourceContract"]["artifact"])
    if not source_path.is_absolute():
        source_path = REPO_ROOT / source_path
    return [
        phase0_binding(protocol_path),
        phase0_binding(REPO_ROOT / protocol["plan"]),
        phase0_binding(source_path),
        phase0_binding(phase0_readiness_path(protocol)),
        phase0_binding(preflight_path(protocol_path, protocol)),
    ]


def _review_required_status(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    mode: str,
    inputs: list[dict[str, str]],
) -> dict[str, Any]:
    paths = gate_review_paths(protocol, mode)
    request = emit_request(
        protocol_path=protocol_path,
        protocol=protocol,
        role="review-attester",
        verb="attest-gate-review",
        subject={
            "logicalId": f"{mode}-fable-review",
            "mode": mode,
            "inputs": inputs,
            "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
            "launcherSha256": gate_review_launcher_sha256(),
        },
        predecessor=None,
        expected_output=paths["receipt"],
    )
    return {
        "schemaVersion": "arc-v35-p30-gate-review-required-v1",
        "status": f"awaiting-{mode}-fable-review",
        "mode": mode,
        "outcomesInspected": False,
        "promotionEligible": False,
        "inputs": inputs,
        "reviewRequest": phase0_binding(
            _request_path(protocol, request["subject"]["logicalId"])
        ),
        "attemptPath": str(paths["attempt"]),
        "stdoutPath": str(paths["stdout"]),
        "stderrPath": str(paths["stderr"]),
        "receiptPath": str(paths["receipt"]),
        "reviewAttesterPublicKey": phase0_binding(
            role_public_key_path(protocol["executionTrust"], "review-attester")
        ),
        "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
        "launcherSha256": gate_review_launcher_sha256(),
    }


def require_phase0_readiness(
    protocol_path: Path, protocol: dict[str, Any]
) -> dict[str, Any]:
    path = phase0_readiness_path(protocol)
    signed = read_signed(
        path,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    inputs = phase0_review_inputs(protocol_path, protocol)
    review = validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="phase0-runtime",
        required_inputs=inputs,
    )
    if (
        signed.get("schemaVersion") != PHASE0_READINESS_SCHEMA
        or signed.get("valid") is not True
        or signed.get("immutable") is not True
        or signed.get("promotionEligible") is not False
        or signed.get("outcomesInspected") is not False
        or signed.get("protocolSha256") != sha256(protocol_path)
        or signed.get("sourceContractSha256")
        != protocol["sourceContract"]["sha256"]
        or signed.get("preflightEvidence") != inputs[3:]
        or signed.get("runtimeReview")
        != phase0_binding(gate_review_paths(protocol, "phase0-runtime")["receipt"])
        or signed.get("diagnosticCodes")
        != [
            "CPU_FAULT_MATRIX_PASS",
            "ANALYZER_REHEARSAL_PASS",
            "CUDA_PRIMARY_REPLAY_EXACT",
            "INDEPENDENT_RUNTIME_AUDIT_ACCEPT",
        ]
    ):
        raise ValueError("P30 Phase 0 readiness is invalid")
    validate_role_request_binding(
        signed.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-phase0-readiness",
        predecessor=None,
        expected_output=path,
    )
    if review.get("verdict") != "ACCEPT":
        raise ValueError("P30 Phase 0 runtime review did not accept")
    return signed


def require_full_campaign_authorization(
    protocol_path: Path, protocol: dict[str, Any]
) -> dict[str, Any]:
    path = full_campaign_authorization_path(protocol)
    signed = read_signed(
        path,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    inputs = full_campaign_review_inputs(protocol_path, protocol)
    validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="full-campaign",
        required_inputs=inputs,
    )
    if (
        signed.get("schemaVersion") != FULL_CAMPAIGN_AUTHORIZATION_SCHEMA
        or signed.get("authorized") is not True
        or signed.get("immutable") is not True
        or signed.get("promotionEligible") is not False
        or signed.get("outcomesInspected") is not False
        or signed.get("protocolSha256") != sha256(protocol_path)
        or signed.get("phase0Readiness")
        != phase0_binding(phase0_readiness_path(protocol))
        or signed.get("generationOnePreflight")
        != phase0_binding(preflight_path(protocol_path, protocol))
        or signed.get("review")
        != phase0_binding(gate_review_paths(protocol, "full-campaign")["receipt"])
        or signed.get("diagnosticCodes")
        != [
            "PHASE0_READINESS_VALID",
            "GENERATION_ONE_PREFLIGHT_VALID",
            "FULL_CAMPAIGN_FABLE_ACCEPT",
        ]
    ):
        raise ValueError("P30 full-campaign authorization is invalid")
    validate_role_request_binding(
        signed.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="authorize-full-campaign",
        predecessor=preflight_path(protocol_path, protocol),
        expected_output=path,
    )
    return signed


def final_barrier_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "barriers/final-generation-complete.json"


def pair_path(protocol: dict[str, Any], replicate: str, arm: str) -> Path:
    return ledger_for(protocol) / "pairs" / f"{endpoint_label(replicate, arm)}.json"


def analysis_manifest_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "analysis/input-manifest.signed.json"


def analysis_authorization_draft_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "analysis/analysis-authorization.unsigned.json"


def analysis_review_receipt_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "analysis/review/fable-analysis-authorization.receipt.json"


def analysis_review_attempt_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "analysis/review/fable-analysis-authorization.attempt.json"


def analysis_review_draft_receipt_path(protocol: dict[str, Any]) -> Path:
    return (
        ledger_for(protocol)
        / "analysis/review/fable-analysis-authorization.receipt.unsigned.json"
    )


def analysis_review_stdout_path(protocol: dict[str, Any]) -> Path:
    return (
        ledger_for(protocol)
        / "analysis/review/fable-analysis-authorization.stdout"
    )


def analysis_review_stderr_path(protocol: dict[str, Any]) -> Path:
    return (
        ledger_for(protocol)
        / "analysis/review/fable-analysis-authorization.stderr"
    )


def analysis_authorization_path(protocol: dict[str, Any]) -> Path:
    return ledger_for(protocol) / "authorizations/final-analysis.json"


def analysis_result_path(protocol: dict[str, Any]) -> Path:
    return (
        Path("/data/share8/michaelvuaprilexperimentation/arc-v35-p30-results")
        / protocol["executionTrust"]["campaignInstanceId"]
        / "analysis.json"
    )


def recovery_root(authorization: dict[str, Any]) -> Path:
    return Path(authorization["ledger"]["root"]) / "recovery" / authorization["tokenId"]


def recovery_paths(authorization: dict[str, Any]) -> dict[str, Path]:
    root = recovery_root(authorization)
    receipt = Path(authorization["ledger"]["receiptPath"])
    return {
        "root": root,
        "normalSealAttempt": normal_seal_attempt_path(receipt),
        "executionDraft": recovery_execution_draft_path(receipt),
        "incident": root / "incident.signed.json",
        "incidentAttestation": root / "incident-attestation.signed.json",
        "replacementAuthorization": root / "replacement-authorization.signed.json",
        "link": root / "link.json",
        "linkAttestation": root / "link-attestation.signed.json",
        "recoveryAttempt": recovery_seal_attempt_path(receipt),
        "completion": root / "completion.signed.json",
    }


def recovery_request_logical_id(token_id: str, phase: str) -> str:
    return f"recovery-{token_id}-{phase}"


def _binding(path: Path) -> dict[str, str]:
    return {"path": str(path), "sha256": sha256_file(path)}


def _read_normal_draft(
    authorization_path: Path, authorization: dict[str, Any]
) -> tuple[Path, dict[str, Any], dict[str, str]]:
    receipt = Path(authorization["ledger"]["receiptPath"])
    draft_path = unsigned_receipt_path(receipt)
    draft = read_json_object(draft_path, "P30 unsigned execution receipt")
    request_binding = draft.get("executionRequest")
    if not isinstance(request_binding, dict) or set(request_binding) != {"path", "sha256"}:
        raise ValueError("unsigned execution receipt lacks its exact execution request")
    validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=authorization_path.resolve(),
        authorization=authorization,
        execution_request_binding=request_binding,
    )
    return draft_path, draft, request_binding


def ensure_recovery_execution_draft(
    *,
    protocol: dict[str, Any],
    authorization_path: Path,
    authorization: dict[str, Any],
) -> tuple[Path, dict[str, Any]] | None:
    """Materialize only an objectively provable recovery class.

    A complete unsigned receipt becomes RECEIPT_ONLY only after the durable
    normal-seal-attempt marker exists.  An invalid unsigned receipt is accepted
    only when it proves PRE_CHILD.  Every other failure closes the campaign.
    """

    frozen_kinds = protocol.get("recoveryPolicy", {}).get("eligibleKinds")
    if frozen_kinds != list(RECOVERY_ELIGIBLE_KINDS):
        raise ValueError("P30 recovery-eligible kinds differ from the frozen protocol")
    paths = recovery_paths(authorization)
    kind = authorization.get("kind")
    if kind not in RECOVERY_ELIGIBLE_KINDS:
        receipt = Path(authorization["ledger"]["receiptPath"])
        normal_draft = unsigned_receipt_path(receipt)
        consumed = Path(authorization["ledger"]["consumedPath"])
        recovery_state = (normal_draft, consumed, *paths.values())
        if any(os.path.lexists(path) for path in recovery_state):
            raise RuntimeError(
                f"P30 {kind!r} execution has unsealed state but no recovery path; "
                "the campaign lane is terminally closed"
            )
        return None
    output = paths["executionDraft"]
    if output.exists():
        value = read_json_object(output, "P30 recovery execution draft")
        validate_execution_draft(value, authorization=authorization)
        return output, value
    receipt = Path(authorization["ledger"]["receiptPath"])
    normal_path = unsigned_receipt_path(receipt)
    if not normal_path.exists():
        if Path(authorization["ledger"]["consumedPath"]).exists():
            raise RuntimeError(
                "P30 token was consumed without a canonical recovery draft; campaign is terminally closed"
            )
        return None
    normal_path, normal, request_binding = _read_normal_draft(
        authorization_path, authorization
    )
    if normal["valid"] is not True:
        raise RuntimeError(
            "P30 invalid execution entered Popen or produced an unsigned receipt; "
            "PRE_CHILD cannot be inferred and the campaign is terminally closed"
        )
    if not paths["normalSealAttempt"].exists():
        return None
    output = prepare_receipt_only_recovery_draft(
        authorization_path,
        normal_path,
        issuer_public_key_path=role_public_key_path(
            read_json_object(Path(authorization["protocol"]["path"]), "P30 protocol")[
                "executionTrust"
            ],
            "issuer",
        ),
        analysis_authorizer_public_key_path=role_public_key_path(
            read_json_object(Path(authorization["protocol"]["path"]), "P30 protocol")[
                "executionTrust"
            ],
            "analysis-authorizer",
        ),
        execution_request_binding=request_binding,
    )
    payload = read_json_object(output, "P30 RECEIPT_ONLY recovery draft")
    validate_execution_draft(payload, authorization=authorization)
    return output, payload


def read_signed(path: Path, public_key: Path, expected_role: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    return verify_signed_payload(
        value, expected_role=expected_role, public_key_path=public_key
    )


def validate_role_request_binding(
    binding: Any,
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    role: str,
    verb: str,
    predecessor: Path | None,
    expected_output: Path,
) -> dict[str, Any]:
    if not isinstance(binding, dict) or set(binding) != {"path", "sha256"}:
        raise ValueError("artifact lacks an exact role-request binding")
    path = Path(binding["path"])
    if (
        not path.is_absolute()
        or path.parent != ledger_for(protocol) / "requests"
        or sha256_file(path) != binding["sha256"]
    ):
        raise ValueError("artifact role-request binding is missing or hash-invalid")
    request = read_json_object(path, "artifact role request")
    if set(request) != {
        "schemaVersion",
        "campaignInstanceId",
        "protocol",
        "role",
        "verb",
        "subject",
        "predecessorSha256",
        "expectedOutputPath",
        "requestNonce",
    }:
        raise ValueError("artifact role-request keys changed")
    nonce = request.get("requestNonce")
    if (
        request.get("schemaVersion") != ROLE_REQUEST_SCHEMA
        or request.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
        or request.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or request.get("role") != role
        or request.get("verb") != verb
        or not isinstance(request.get("subject"), dict)
        or request.get("predecessorSha256")
        != (None if predecessor is None else sha256_file(predecessor))
        or request.get("expectedOutputPath") != str(expected_output)
        or not isinstance(nonce, str)
        or len(nonce) != 64
        or any(character not in "0123456789abcdef" for character in nonce)
    ):
        raise ValueError("artifact role request changed")
    return request


def _read_recovery_attestation(
    path: Path,
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    phase: str,
    verb: str,
    predecessor: Path,
    artifact: Path,
    authorization: dict[str, Any],
) -> dict[str, Any]:
    value = read_signed(
        path,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    if (
        set(value)
        != {
            "schemaVersion",
            "phase",
            "valid",
            "immutable",
            "outcomeBlind",
            "outcomesInspected",
            "promotionEligible",
            "campaignId",
            "kind",
            "originalTokenId",
            "recoveryClass",
            "attemptOrdinal",
            "artifact",
            "issuedAtUtc",
            "secondRecoveryForbidden",
            "request",
        }
        or value.get("schemaVersion") != LOGICAL_COMPLETION_SCHEMA
        or value.get("phase") != phase
        or value.get("valid") is not True
        or value.get("immutable") is not True
        or value.get("outcomeBlind") is not True
        or value.get("outcomesInspected") is not False
        or value.get("promotionEligible") is not False
        or value.get("campaignId") != authorization["campaignId"]
        or value.get("kind") != authorization["kind"]
        or value.get("originalTokenId") != authorization["tokenId"]
        or value.get("recoveryClass") not in (PRE_CHILD, RECEIPT_ONLY)
        or value.get("attemptOrdinal") != 1
        or value.get("artifact") != _binding(artifact)
        or value.get("secondRecoveryForbidden") is not True
    ):
        raise ValueError(f"P30 recovery {phase} attestation changed")
    validate_role_request_binding(
        value["request"],
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb=verb,
        predecessor=predecessor,
        expected_output=path,
    )
    return value


def _validate_sealed_pre_child_replacement(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    original_authorization_path: Path,
    original: dict[str, Any],
    paths: dict[str, Path],
) -> dict[str, Any]:
    """Validate the issuer replacement after its shared outputs may exist."""

    signed = read_json_object(
        paths["replacementAuthorization"], "sealed PRE_CHILD replacement authorization"
    )
    replacement = verify_signed_payload(
        signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(protocol["executionTrust"], "issuer"),
    )
    token = replacement.get("tokenId")
    if (
        replacement.get("schemaVersion") != AUTHORIZATION_SCHEMA
        or replacement.get("authorized") is not True
        or replacement.get("immutable") is not True
        or replacement.get("promotionEligible") is not False
        or replacement.get("kind") != original["kind"]
        or replacement.get("campaignId") != original["campaignId"]
        or not isinstance(token, str)
        or len(token) != 64
        or token == original["tokenId"]
        or protected_bindings_sha256(replacement)
        != protected_bindings_sha256(original)
    ):
        raise ValueError("sealed PRE_CHILD replacement authorization changed")
    request = validate_role_request_binding(
        replacement.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="issuer",
        verb="issue-recovery",
        predecessor=paths["incidentAttestation"],
        expected_output=paths["replacementAuthorization"],
    )
    subject = request.get("subject")
    if (
        not isinstance(subject, dict)
        or subject.get("originalAuthorizationPath")
        != str(original_authorization_path)
        or subject.get("executionDraft") != _binding(paths["executionDraft"])
        or subject.get("guardianIncident") != _binding(paths["incident"])
        or subject.get("incidentAttestation")
        != _binding(paths["incidentAttestation"])
        or subject.get("recoveryClass") != PRE_CHILD
        or subject.get("recoveryOrdinal") != 1
        or subject.get("recoveryTokenId") != token
    ):
        raise ValueError("sealed PRE_CHILD issuer request changed")
    return replacement


def validate_recovery_state(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    authorization_path: Path,
    authorization: dict[str, Any],
) -> dict[str, Any]:
    """Validate the immutable recovery prefix without advancing it."""

    paths = recovery_paths(authorization)
    draft = read_json_object(paths["executionDraft"], "P30 recovery execution draft")
    sealed_replacement: dict[str, Any] | None = None
    sealed_attempt_path: Path | None = None
    if (
        draft.get("recoveryClass") == PRE_CHILD
        and paths["linkAttestation"].exists()
        and paths["replacementAuthorization"].exists()
    ):
        signed_replacement = read_json_object(
            paths["replacementAuthorization"], "PRE_CHILD replacement authorization"
        )
        unsigned_replacement = verify_signed_payload(
            signed_replacement,
            expected_role="issuer",
            public_key_path=role_public_key_path(protocol["executionTrust"], "issuer"),
        )
        sealed_attempt_path = pre_child_recovery_attempt_path(
            Path(unsigned_replacement["ledger"]["receiptPath"])
        )
        if sealed_attempt_path.exists():
            _read_recovery_attestation(
                paths["linkAttestation"],
                protocol_path=protocol_path,
                protocol=protocol,
                phase="link",
                verb="attest-recovery-link",
                predecessor=paths["incidentAttestation"],
                artifact=paths["link"],
                authorization=authorization,
            )
            sealed_replacement = _validate_sealed_pre_child_replacement(
                protocol_path=protocol_path,
                protocol=protocol,
                original_authorization_path=authorization_path,
                original=authorization,
                paths=paths,
            )
    if sealed_replacement is None:
        validate_execution_draft(draft, authorization=authorization)
    else:
        validate_sealed_pre_child_draft(draft, authorization=authorization)
    state: dict[str, Any] = {"paths": paths, "draft": draft}
    if not paths["incidentAttestation"].exists():
        return state
    _read_recovery_attestation(
        paths["incidentAttestation"],
        protocol_path=protocol_path,
        protocol=protocol,
        phase="incident",
        verb="attest-recovery-incident",
        predecessor=paths["executionDraft"],
        artifact=paths["incident"],
        authorization=authorization,
    )
    signed_incident = read_json_object(paths["incident"], "signed recovery incident")
    incident = validate_guardian_incident(
        signed_incident,
        guardian_public_key_path=role_public_key_path(
            protocol["executionTrust"], "guardian"
        ),
        execution_draft=draft,
        authorization=authorization,
        sealed_pre_child_output_reuse=sealed_replacement is not None,
    )
    state["incident"] = incident
    state["incidentSigned"] = signed_incident
    if not paths["linkAttestation"].exists():
        return state
    replacement: dict[str, Any] | None = None
    if draft["recoveryClass"] == PRE_CHILD:
        replacement = sealed_replacement or validate_stored_authorization(
                authorization_path=paths["replacementAuthorization"],
                protocol_path=protocol_path,
                kind=authorization["kind"],
                root=Path(authorization["subject"]["root"]),
                replicate=authorization["subject"]["replicate"],
                arm=authorization["subject"]["arm"],
                generation=authorization["subject"].get("generation"),
                role=authorization["subject"].get("role"),
                predecessor=None
                if authorization.get("predecessor") is None
                else Path(authorization["predecessor"]["receiptPath"]),
            )
    if sealed_replacement is None:
        _read_recovery_attestation(
            paths["linkAttestation"],
            protocol_path=protocol_path,
            protocol=protocol,
            phase="link",
            verb="attest-recovery-link",
            predecessor=paths["incidentAttestation"],
            artifact=paths["link"],
            authorization=authorization,
        )
    link = read_json_object(paths["link"], "P30 recovery link")
    validate_recovery_link(
        link,
        guardian_incident=incident,
        original_authorization=authorization,
        replacement_authorization=replacement,
    )
    if sealed_replacement is not None:
        assert sealed_attempt_path is not None
        attempt = validate_pre_child_recovery_attempt(
            sealed_attempt_path,
            recovery_authorization_path=paths["replacementAuthorization"],
            recovery_authorization=sealed_replacement,
            original_authorization_path=authorization_path,
            recovery_draft_path=paths["executionDraft"],
            guardian_incident_path=paths["incident"],
            recovery_link_path=paths["link"],
            link_attestation_path=paths["linkAttestation"],
        )
        state["recoveryAttempt"] = attempt
    state["link"] = link
    state["replacementAuthorization"] = replacement
    return state


def _recovery_completion_receipt(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    authorization_path: Path,
    authorization: dict[str, Any],
) -> tuple[Path, dict[str, Any]] | None:
    paths = recovery_paths(authorization)
    if not paths["completion"].exists():
        return None
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
    )
    if "link" not in state:
        raise ValueError("P30 recovery completion precedes its signed recovery link")
    value = read_signed(
        paths["completion"],
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    expected_authorization_path = (
        authorization_path
        if state["draft"]["recoveryClass"] == RECEIPT_ONLY
        else paths["replacementAuthorization"]
    )
    completed_authorization = (
        authorization
        if state["draft"]["recoveryClass"] == RECEIPT_ONLY
        else state["replacementAuthorization"]
    )
    assert completed_authorization is not None
    receipt_path = Path(completed_authorization["ledger"]["receiptPath"])
    if (
        set(value)
        != {
            "schemaVersion",
            "phase",
            "valid",
            "immutable",
            "outcomeBlind",
            "outcomesInspected",
            "promotionEligible",
            "campaignId",
            "kind",
            "originalTokenId",
            "recoveryTokenId",
            "recoveryClass",
            "attemptOrdinal",
            "incidentAttestation",
            "linkAttestation",
            "completedAuthorization",
            "executionReceipt",
            "completedAtUtc",
            "secondRecoveryForbidden",
            "request",
        }
        or value.get("schemaVersion") != LOGICAL_COMPLETION_SCHEMA
        or value.get("phase") != "completion"
        or value.get("valid") is not True
        or value.get("immutable") is not True
        or value.get("outcomeBlind") is not True
        or value.get("outcomesInspected") is not False
        or value.get("promotionEligible") is not False
        or value.get("campaignId") != authorization["campaignId"]
        or value.get("kind") != authorization["kind"]
        or value.get("originalTokenId") != authorization["tokenId"]
        or value.get("recoveryTokenId") != state["link"]["recoveryTokenId"]
        or value.get("recoveryClass") != state["draft"]["recoveryClass"]
        or value.get("attemptOrdinal") != 1
        or value.get("incidentAttestation") != _binding(paths["incidentAttestation"])
        or value.get("linkAttestation") != _binding(paths["linkAttestation"])
        or value.get("completedAuthorization") != _binding(expected_authorization_path)
        or value.get("executionReceipt") != _binding(receipt_path)
        or value.get("secondRecoveryForbidden") is not True
    ):
        raise ValueError("P30 signed recovery completion changed")
    validate_role_request_binding(
        value["request"],
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-recovery-completion",
        predecessor=paths["linkAttestation"],
        expected_output=paths["completion"],
    )
    # Validate the executor receipt against the authorization that actually ran.
    receipt = _validate_direct_completed_execution(
        authorization_path=expected_authorization_path,
        authorization=completed_authorization,
        protocol=protocol,
    )
    return receipt


def _authorization_validation_moment(authorization: dict[str, Any]) -> dt.datetime:
    value = authorization.get("notBeforeUtc")
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("stored authorization has no valid not-before instant")
    return dt.datetime.fromisoformat(value[:-1] + "+00:00") + dt.timedelta(
        microseconds=1
    )


def validate_stored_authorization(
    *,
    authorization_path: Path,
    protocol_path: Path,
    kind: str,
    root: Path,
    replicate: str,
    arm: str,
    generation: int | None = None,
    role: str | None = None,
    predecessor: Path | None = None,
) -> dict[str, Any]:
    protocol = read_json_object(protocol_path, "P30 protocol")
    trust = protocol["executionTrust"]
    issuer_public = role_public_key_path(trust, "issuer")
    analysis_public = role_public_key_path(trust, "analysis-authorizer")
    signed = json.loads(read_regular_nofollow(authorization_path).decode("utf-8"))
    expected_signer_role = "analysis-authorizer" if kind == "analysis" else "issuer"
    expected_signer_key = (
        analysis_public if kind == "analysis" else issuer_public
    )
    unsigned = verify_signed_payload(
        signed, expected_role=expected_signer_role, public_key_path=expected_signer_key
    )
    authorization = validate_authorization(
        signed,
        issuer_public_key_path=issuer_public,
        analysis_authorizer_public_key_path=analysis_public,
        authorization_path=authorization_path.resolve(),
        now=_authorization_validation_moment(unsigned),
    )
    subject = authorization.get("subject")
    expected_predecessor = (
        None
        if predecessor is None
        else {
            "receiptPath": str(predecessor.resolve()),
            "sha256": sha256_file(predecessor),
        }
    )
    if (
        authorization.get("schemaVersion") != AUTHORIZATION_SCHEMA
        or authorization.get("kind") != kind
        or authorization.get("campaignId") != protocol["experiment"]
        or authorization.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or not isinstance(subject, dict)
        or authorization.get("predecessor") != expected_predecessor
    ):
        raise ValueError("stored execution authorization does not match the requested role")
    if kind != "analysis" and (
        subject.get("root") != str(root.resolve())
        or subject.get("replicate") != replicate
        or subject.get("arm") != arm
        or subject.get("protocolSha256") != sha256(protocol_path)
        or (generation is not None and subject.get("generation") != generation)
        or (role is not None and subject.get("role") != role)
    ):
        raise ValueError("stored execution authorization subject changed")
    return authorization


def _validate_direct_completed_execution(
    *, authorization_path: Path, authorization: dict[str, Any], protocol: dict[str, Any]
) -> tuple[Path, dict[str, Any]]:
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    receipt = read_signed(
        receipt_path,
        role_public_key_path(protocol["executionTrust"], "executor"),
        "executor",
    )
    artifacts = receipt.get("artifacts")
    expected_outputs = authorization["outputs"]
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("promotionEligible") is not False
        or receipt.get("kind") != authorization["kind"]
        or receipt.get("tokenId") != authorization["tokenId"]
        or receipt.get("campaignId") != authorization["campaignId"]
        or receipt.get("subject") != authorization["subject"]
        or receipt.get("command") != authorization["command"]
        or receipt.get("predecessor") != authorization["predecessor"]
        or receipt.get("authorization")
        != {
            "path": str(authorization_path.resolve()),
            "sha256": sha256_file(authorization_path),
        }
        or receipt.get("exitCode") != 0
        or receipt.get("noSupervisorChildRemaining") is not True
        or receipt.get("gpuEmptyAfter") is not True
        or receipt.get("leaseReleased") is not True
        or receipt.get("missingRequiredOutputs") != []
        or not isinstance(artifacts, dict)
        or set(artifacts) != set(expected_outputs)
    ):
        raise ValueError("stored execution receipt does not match its authorization")
    authorization_request = read_json_object(
        Path(authorization["request"]["path"]), "execution authorization request"
    )
    recovery_execution = authorization_request.get("verb") == "issue-recovery"
    execution_request_binding = receipt.get("executionRequest")
    execution_request_path = Path(
        execution_request_binding.get("path", "")
        if isinstance(execution_request_binding, dict)
        else ""
    )
    execution_request = (
        read_json_object(execution_request_path, "execution role request")
        if execution_request_path.is_absolute()
        else {}
    )
    predecessor_path = authorization_path
    if recovery_execution:
        link_binding = execution_request.get("subject", {}).get("linkAttestation")
        if not isinstance(link_binding, dict) or set(link_binding) != {"path", "sha256"}:
            raise ValueError("PRE_CHILD execution request lacks its link attestation")
        predecessor_path = Path(link_binding["path"])
        if sha256_file(predecessor_path) != link_binding["sha256"]:
            raise ValueError("PRE_CHILD link attestation is missing or hash-invalid")
    request = validate_role_request_binding(
        execution_request_binding,
        protocol_path=Path(authorization["protocol"]["path"]),
        protocol=protocol,
        role="executor",
        verb="execute-recovery" if recovery_execution else "execute",
        predecessor=predecessor_path,
        expected_output=receipt_path,
    )
    if request.get("subject", {}).get("authorizationPath") != str(
        authorization_path.resolve()
    ):
        raise ValueError("execution role request names a different authorization")
    if recovery_execution and (
        request.get("subject", {}).get("recoveryOrdinal") != 1
        or request.get("subject", {}).get("recoveryTokenId")
        != authorization["tokenId"]
    ):
        raise ValueError("PRE_CHILD execution request changed its sole recovery")
    consumed = receipt.get("consumedMarker")
    if not isinstance(consumed, dict) or set(consumed) != {"path", "sha256"}:
        raise ValueError("stored execution receipt lacks exact consumed-token evidence")
    consumed_path = Path(consumed["path"])
    if not consumed_path.is_file() or sha256_file(consumed_path) != consumed["sha256"]:
        raise ValueError("stored consumed-token evidence is missing or hash-invalid")
    for label, entry in artifacts.items():
        path = Path(entry.get("path", ""))
        if (
            not path.is_file()
            or sha256_file(path) != entry.get("sha256")
            or path.stat().st_size != entry.get("bytes")
        ):
            raise ValueError(f"stored execution artifact differs: {label}")
    return receipt_path, receipt


def validate_completed_execution(
    *, authorization_path: Path, authorization: dict[str, Any], protocol: dict[str, Any]
) -> tuple[Path, dict[str, Any]]:
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    if receipt_path.exists():
        return _validate_direct_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
    protocol_path = Path(authorization["protocol"]["path"])
    recovered = _recovery_completion_receipt(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
    )
    if recovered is None:
        raise FileNotFoundError("logical execution has no receipt or signed recovery completion")
    return recovered


def predecessor_for_generation(
    protocol_path: Path,
    protocol: dict[str, Any],
    replicate: str,
    arm: str,
    generation: int,
) -> Path | None:
    if generation == 1:
        return None
    prior_path = generation_authorization_path(
        ledger_for(protocol), replicate, arm, generation - 1
    )
    if not prior_path.is_file():
        raise ValueError("prior generation authorization is missing")
    prior_predecessor = predecessor_for_generation(
        protocol_path, protocol, replicate, arm, generation - 1
    )
    prior = validate_stored_authorization(
        authorization_path=prior_path,
        protocol_path=protocol_path,
        kind="generation",
        root=root_for(replicate, arm),
        replicate=replicate,
        arm=arm,
        generation=generation - 1,
        predecessor=prior_predecessor,
    )
    receipt_path, _ = validate_completed_execution(
        authorization_path=prior_path, authorization=prior, protocol=protocol
    )
    return receipt_path


def require_preflight(
    protocol_path: Path, protocol: dict[str, Any]
) -> dict[str, Any]:
    receipt = read_signed(
        preflight_path(protocol_path, protocol),
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    expected_keys = {
        "schemaVersion",
        "valid",
        "promotionEligible",
        "outcomesInspected",
        "protocolSha256",
        "startedAtUtc",
        "finishedAtUtc",
        "elapsedSeconds",
        "initialFreeBytes",
        "finalFreeBytes",
        "threeRootIncrementalBytes",
        "projectedCampaignBytesConservative",
        "projectedTrainingBytesWith25PercentSafety",
        "evaluationReserveBytes",
        "diskFloorBytes",
        "projectedFinalFreeBytes",
        "maximumObservedRootSeconds",
        "projectedCampaignComputeSeconds",
        "maxCampaignComputeSeconds",
        "receipts",
        "diagnosticCodes",
        "request",
    }
    if (
        set(receipt) != expected_keys
        or receipt.get("schemaVersion") != PREFLIGHT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("outcomesInspected") is not False
        or receipt.get("promotionEligible") is not False
        or receipt.get("protocolSha256") != sha256(protocol_path)
        or receipt.get("diskFloorBytes") != DISK_FLOOR_BYTES
        or receipt.get("evaluationReserveBytes") != EVALUATION_RESERVE_BYTES
        or receipt.get("maxCampaignComputeSeconds")
        != protocol["runtime"]["maxCampaignComputeSeconds"]
        or receipt.get("projectedCampaignComputeSeconds", float("inf"))
        > protocol["runtime"]["maxCampaignComputeSeconds"]
        or receipt.get("projectedFinalFreeBytes", 0) < DISK_FLOOR_BYTES
        or receipt.get("diagnosticCodes")
        != ["THREE_MATCHED_ARMS_GEN1_COMPLETE", "DISK_PROJECTION_COMPLETE"]
    ):
        raise ValueError("full campaign lacks a passing guardian preflight")
    validate_role_request_binding(
        receipt["request"],
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-preflight",
        predecessor=None,
        expected_output=preflight_path(protocol_path, protocol),
    )
    embedded = receipt.get("receipts")
    if not isinstance(embedded, list) or len(embedded) != len(ARMS):
        raise ValueError("preflight does not bind all three matched generation receipts")
    for arm, binding in zip(ARMS, embedded, strict=True):
        authorization_path = generation_authorization_path(
            ledger_for(protocol), "a", arm, 1
        )
        authorization = validate_stored_authorization(
            authorization_path=authorization_path,
            protocol_path=protocol_path,
            kind="generation",
            root=root_for("a", arm),
            replicate="a",
            arm=arm,
            generation=1,
        )
        completed, _ = validate_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
        if binding != {
            "arm": arm,
            "path": str(completed),
            "sha256": sha256_file(completed),
        }:
            raise ValueError("preflight embedded receipt binding changed")
    available = disk_free(Path("/data/share8")) + storage_reservation_bytes(protocol)
    if available - receipt["projectedCampaignBytesConservative"] < DISK_FLOOR_BYTES:
        raise ValueError("current disk headroom no longer satisfies the signed projection")
    return receipt


def _request_path(protocol: dict[str, Any], logical_id: str) -> Path:
    return ledger_for(protocol) / "requests" / f"{logical_id}.json"


def nonexecutor_signing_attempt_path(expected_output: Path) -> Path:
    return expected_output.with_name(expected_output.name + ".signing-attempt.json")


def _entry_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def emit_request(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    role: str,
    verb: str,
    subject: dict[str, Any],
    predecessor: Path | None,
    expected_output: Path,
) -> dict[str, Any]:
    if (
        role != "executor"
        and not _entry_exists(expected_output)
        and _entry_exists(nonexecutor_signing_attempt_path(expected_output))
    ):
        raise RuntimeError(
            "P30 non-executor signing action already attempted once; "
            "campaign is terminally closed"
        )
    logical_id = subject["logicalId"]
    path = _request_path(protocol, logical_id)
    core = {
        "schemaVersion": ROLE_REQUEST_SCHEMA,
        "campaignInstanceId": protocol["executionTrust"]["campaignInstanceId"],
        "protocol": {
            "path": str(protocol_path),
            "sha256": sha256(protocol_path),
        },
        "role": role,
        "verb": verb,
        "subject": subject,
        "predecessorSha256": None
        if predecessor is None
        else sha256_file(predecessor),
        "expectedOutputPath": str(expected_output),
    }
    if path.exists():
        value = read_json_object(path, "P30 role request")
        if {key: value.get(key) for key in core} != core:
            raise ValueError("stored role request differs from the next action")
        nonce = value.get("requestNonce")
        if (
            not isinstance(nonce, str)
            or len(nonce) != 64
            or any(character not in "0123456789abcdef" for character in nonce)
        ):
            raise ValueError("stored role request nonce is malformed")
        return value
    value = {**core, "requestNonce": secrets.token_hex(32)}
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_exclusive(path, canonical_json(value) + b"\n")
    return value


def _recovery_token_from_incident_request(
    protocol: dict[str, Any], authorization: dict[str, Any]
) -> str:
    request = read_json_object(
        _request_path(
            protocol,
            recovery_request_logical_id(authorization["tokenId"], "incident"),
        ),
        "P30 recovery incident request",
    )
    token = request.get("subject", {}).get("recoveryTokenId")
    if (
        not isinstance(token, str)
        or len(token) != 64
        or any(character not in "0123456789abcdef" for character in token)
        or token == authorization["tokenId"]
    ):
        raise ValueError("P30 recovery token changed")
    return token


def next_execution_action(
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    authorization_path: Path,
    authorization: dict[str, Any],
    normal_subject: dict[str, Any],
) -> dict[str, Any] | None:
    """Advance one execution through either normal or single-recovery flow."""

    receipt_path = Path(authorization["ledger"]["receiptPath"])
    paths = recovery_paths(authorization)
    if receipt_path.exists() and not paths["executionDraft"].exists():
        _validate_direct_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
        return None
    if paths["completion"].exists():
        validate_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
        return None
    materialized = ensure_recovery_execution_draft(
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
    )
    if materialized is None:
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="executor",
            verb="execute",
            subject=normal_subject,
            predecessor=authorization_path,
            expected_output=receipt_path,
        )
    draft_path, draft = materialized
    if not paths["incidentAttestation"].exists():
        incident_logical = recovery_request_logical_id(
            authorization["tokenId"], "incident"
        )
        incident_request_path = _request_path(protocol, incident_logical)
        recovery_token = (
            read_json_object(incident_request_path, "P30 recovery incident request")
            .get("subject", {})
            .get("recoveryTokenId")
            if incident_request_path.exists()
            else secrets.token_hex(32)
        )
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-recovery-incident",
            subject={
                "logicalId": incident_logical,
                "originalAuthorizationPath": str(authorization_path),
                "executionDraft": _binding(draft_path),
                "recoveryClass": draft["recoveryClass"],
                "recoveryOrdinal": 1,
                "recoveryTokenId": recovery_token,
            },
            predecessor=draft_path,
            expected_output=paths["incidentAttestation"],
        )
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
    )
    incident = state["incident"]
    recovery_token = _recovery_token_from_incident_request(protocol, authorization)
    replacement: dict[str, Any] | None = None
    if draft["recoveryClass"] == PRE_CHILD:
        if not paths["replacementAuthorization"].exists():
            return emit_request(
                protocol_path=protocol_path,
                protocol=protocol,
                role="issuer",
                verb="issue-recovery",
                subject={
                    "logicalId": recovery_request_logical_id(
                        authorization["tokenId"], "issue"
                    ),
                    "originalAuthorizationPath": str(authorization_path),
                    "executionDraft": _binding(paths["executionDraft"]),
                    "guardianIncident": _binding(paths["incident"]),
                    "incidentAttestation": _binding(paths["incidentAttestation"]),
                    "recoveryClass": PRE_CHILD,
                    "recoveryOrdinal": 1,
                    "recoveryTokenId": recovery_token,
                },
                predecessor=paths["incidentAttestation"],
                expected_output=paths["replacementAuthorization"],
            )
        replacement = validate_stored_authorization(
            authorization_path=paths["replacementAuthorization"],
            protocol_path=protocol_path,
            kind=authorization["kind"],
            root=Path(authorization["subject"]["root"]),
            replicate=authorization["subject"]["replicate"],
            arm=authorization["subject"]["arm"],
            generation=authorization["subject"].get("generation"),
            role=authorization["subject"].get("role"),
            predecessor=(
                None
                if authorization.get("predecessor") is None
                else Path(authorization["predecessor"]["receiptPath"])
            ),
        )
        if replacement["tokenId"] != recovery_token:
            raise ValueError("PRE_CHILD replacement token changed")
    if not paths["linkAttestation"].exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-recovery-link",
            subject={
                "logicalId": recovery_request_logical_id(
                    authorization["tokenId"], "link"
                ),
                "originalAuthorizationPath": str(authorization_path),
                "incidentAttestation": _binding(paths["incidentAttestation"]),
                "replacementAuthorization": None
                if replacement is None
                else _binding(paths["replacementAuthorization"]),
                "recoveryClass": draft["recoveryClass"],
                "recoveryOrdinal": 1,
                "recoveryTokenId": recovery_token,
            },
            predecessor=paths["incidentAttestation"],
            expected_output=paths["linkAttestation"],
        )
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
    )
    if draft["recoveryClass"] == PRE_CHILD:
        replacement = state.get("replacementAuthorization")
        if not isinstance(replacement, dict):
            raise ValueError("PRE_CHILD link lacks its replacement authorization")
        completed_authorization_path = paths["replacementAuthorization"]
        completed_receipt_path = Path(replacement["ledger"]["receiptPath"])
        attempt_path = pre_child_recovery_attempt_path(completed_receipt_path)
        if attempt_path.exists() and not completed_receipt_path.exists():
            raise RuntimeError(
                "P30 PRE_CHILD replacement already attempted once; campaign is terminally closed"
            )
        if not completed_receipt_path.exists():
            return emit_request(
                protocol_path=protocol_path,
                protocol=protocol,
                role="executor",
                verb="execute-recovery",
                subject={
                    "logicalId": recovery_request_logical_id(
                        authorization["tokenId"], "execute"
                    ),
                    "authorizationPath": str(completed_authorization_path),
                    "originalAuthorizationPath": str(authorization_path),
                    "executionDraft": _binding(paths["executionDraft"]),
                    "guardianIncident": _binding(paths["incident"]),
                    "recoveryLink": _binding(paths["link"]),
                    "linkAttestation": _binding(paths["linkAttestation"]),
                    "recoveryOrdinal": 1,
                    "recoveryTokenId": recovery_token,
                },
                predecessor=paths["linkAttestation"],
                expected_output=completed_receipt_path,
            )
        _validate_direct_completed_execution(
            authorization_path=completed_authorization_path,
            authorization=replacement,
            protocol=protocol,
        )
    else:
        completed_authorization_path = authorization_path
        completed_receipt_path = receipt_path
        if paths["recoveryAttempt"].exists() and not receipt_path.exists():
            raise RuntimeError(
                "P30 receipt-only sealing already failed once; campaign is terminally closed"
            )
    if not completed_receipt_path.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="executor",
            verb="seal-recovery-receipt",
            subject={
                "logicalId": recovery_request_logical_id(
                    authorization["tokenId"], "seal-receipt"
                ),
                "authorizationPath": str(authorization_path),
                "incidentAttestation": _binding(paths["incidentAttestation"]),
                "linkAttestation": _binding(paths["linkAttestation"]),
                "recoveryOrdinal": 1,
            },
            predecessor=paths["linkAttestation"],
            expected_output=completed_receipt_path,
        )
    if not paths["completion"].exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-recovery-completion",
            subject={
                "logicalId": recovery_request_logical_id(
                    authorization["tokenId"], "completion"
                ),
                "originalAuthorizationPath": str(authorization_path),
                "incidentAttestation": _binding(paths["incidentAttestation"]),
                "linkAttestation": _binding(paths["linkAttestation"]),
                "executionReceipt": _binding(completed_receipt_path),
                "recoveryClass": draft["recoveryClass"],
                "recoveryOrdinal": 1,
                "recoveryTokenId": recovery_token,
            },
            predecessor=paths["linkAttestation"],
            expected_output=paths["completion"],
        )
    validate_completed_execution(
        authorization_path=authorization_path,
        authorization=authorization,
        protocol=protocol,
    )
    return None


def prepare_analysis_authorization_draft(
    protocol_path: Path, protocol: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    from issue_v35_p30_analysis_bundle import build_analysis_authorization_payload

    manifest_path = analysis_manifest_path(protocol)
    draft_path = analysis_authorization_draft_path(protocol)
    review_path = analysis_review_receipt_path(protocol)
    output_path = analysis_authorization_path(protocol)
    analysis_out = analysis_result_path(protocol)
    request = emit_request(
        protocol_path=protocol_path,
        protocol=protocol,
        role="analysis-authorizer",
        verb="issue-analysis",
        subject={
            "logicalId": "final-analysis-authorization",
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256_file(manifest_path),
            },
            "authorizationDraftPath": str(draft_path),
            "reviewReceiptPath": str(review_path),
            "analysisOut": str(analysis_out),
        },
        predecessor=manifest_path,
        expected_output=output_path,
    )
    request_path = _request_path(protocol, request["subject"]["logicalId"])
    request_binding = {"path": str(request_path), "sha256": sha256_file(request_path)}
    if draft_path.exists():
        draft = read_json_object(draft_path, "P30 analysis authorization draft")
        issued = draft.get("issuedAtUtc")
        if not isinstance(issued, str) or not issued.endswith("Z"):
            raise ValueError("P30 analysis authorization draft issue time changed")
        moment = dt.datetime.fromisoformat(issued[:-1] + "+00:00")
        expected = build_analysis_authorization_payload(
            protocol_path=protocol_path,
            manifest_path=manifest_path,
            request_binding=request_binding,
            authorization_draft_path=draft_path,
            review_receipt_path=review_path,
            analysis_out=analysis_out,
            token_id=draft.get("tokenId"),
            now=moment,
        )
        if canonical_json(draft) != canonical_json(expected):
            raise ValueError("stored analysis authorization draft is not reproducible")
        return request, draft
    draft = build_analysis_authorization_payload(
        protocol_path=protocol_path,
        manifest_path=manifest_path,
        request_binding=request_binding,
        authorization_draft_path=draft_path,
        review_receipt_path=review_path,
        analysis_out=analysis_out,
    )
    draft_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_exclusive(draft_path, canonical_json(draft) + b"\n")
    return request, draft


def _generation_next(
    protocol_path: Path,
    protocol: dict[str, Any],
    replicate: str,
    arm: str,
    generation: int,
) -> dict[str, Any] | None:
    ledger = ledger_for(protocol)
    authorization_path = generation_authorization_path(
        ledger, replicate, arm, generation
    )
    predecessor = predecessor_for_generation(
        protocol_path, protocol, replicate, arm, generation
    )
    subject = {
        "logicalId": f"{endpoint_label(replicate, arm)}-gen{generation}-issuer",
        "replicate": replicate,
        "arm": arm,
        "generation": generation,
        "root": str(root_for(replicate, arm)),
    }
    if not authorization_path.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="issuer",
            verb="issue-generation",
            subject=subject,
            predecessor=predecessor,
            expected_output=authorization_path,
        )
    authorization = validate_stored_authorization(
        authorization_path=authorization_path,
        protocol_path=protocol_path,
        kind="generation",
        root=root_for(replicate, arm),
        replicate=replicate,
        arm=arm,
        generation=generation,
        predecessor=predecessor,
    )
    return next_execution_action(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
        normal_subject={
            **subject,
            "logicalId": f"{endpoint_label(replicate, arm)}-gen{generation}-executor",
            "authorizationPath": str(authorization_path),
        },
    )


def _evaluation_next(
    protocol_path: Path,
    protocol: dict[str, Any],
    replicate: str,
    arm: str,
    role: str,
) -> dict[str, Any] | None:
    ledger = ledger_for(protocol)
    label = endpoint_label(replicate, arm)
    authorization_path = evaluation_authorization_path(ledger, label, role)
    if role == "primary":
        predecessor_authorization = generation_authorization_path(
            ledger,
            replicate,
            arm,
            protocol["seedSchedule"]["maxGeneration"],
        )
    else:
        predecessor_authorization = evaluation_authorization_path(
            ledger, label, "primary"
        )
    predecessor_value = read_signed(
        predecessor_authorization,
        role_public_key_path(protocol["executionTrust"], "issuer"),
        "issuer",
    )
    predecessor, _ = validate_completed_execution(
        authorization_path=predecessor_authorization,
        authorization=predecessor_value,
        protocol=protocol,
    )
    logical = f"{label}-evaluation-{role}"
    subject = {
        "logicalId": f"{logical}-issuer",
        "replicate": replicate,
        "arm": arm,
        "evaluationRole": role,
        "root": str(root_for(replicate, arm)),
    }
    if not authorization_path.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="issuer",
            verb="issue-evaluation",
            subject=subject,
            predecessor=predecessor,
            expected_output=authorization_path,
        )
    authorization = validate_stored_authorization(
        authorization_path=authorization_path,
        protocol_path=protocol_path,
        kind=f"evaluation-{role}",
        root=root_for(replicate, arm),
        replicate=replicate,
        arm=arm,
        role=role,
        predecessor=predecessor,
    )
    return next_execution_action(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
        normal_subject={
            **subject,
            "logicalId": f"{logical}-executor",
            "authorizationPath": str(authorization_path),
        },
    )


def _rolling_budget_guard(protocol_path: Path, protocol: dict[str, Any]) -> None:
    if not preflight_path(protocol_path, protocol).exists():
        return
    preflight = require_preflight(protocol_path, protocol)
    completed = 0
    retained_max = max(1, preflight["threeRootIncrementalBytes"] // len(ARMS))
    duration_max = float(preflight["maximumObservedRootSeconds"])
    accumulated = 0.0
    total = len(REPLICATES) * len(ARMS) * protocol["seedSchedule"]["maxGeneration"]
    for generation in range(1, protocol["seedSchedule"]["maxGeneration"] + 1):
        for replicate in REPLICATES:
            for arm in ARMS:
                authorization_path = generation_authorization_path(
                    ledger_for(protocol), replicate, arm, generation
                )
                if not authorization_path.exists():
                    continue
                predecessor = predecessor_for_generation(
                    protocol_path, protocol, replicate, arm, generation
                )
                authorization = validate_stored_authorization(
                    authorization_path=authorization_path,
                    protocol_path=protocol_path,
                    kind="generation",
                    root=root_for(replicate, arm),
                    replicate=replicate,
                    arm=arm,
                    generation=generation,
                    predecessor=predecessor,
                )
                receipt_path = Path(authorization["ledger"]["receiptPath"])
                if (
                    not receipt_path.exists()
                    and not recovery_paths(authorization)["completion"].exists()
                ):
                    continue
                _, receipt = validate_completed_execution(
                    authorization_path=authorization_path,
                    authorization=authorization,
                    protocol=protocol,
                )
                completed += 1
                retained = sum(
                    int(receipt["artifacts"][label]["bytes"])
                    for label, output in authorization["outputs"].items()
                    if output["mustBeAbsentAtStart"]
                )
                retained_max = max(retained_max, retained)
                duration = elapsed_seconds(receipt)
                duration_max = max(duration_max, duration)
                accumulated += duration
    remaining = total - completed
    frozen_remaining = (
        preflight["projectedTrainingBytesWith25PercentSafety"] * remaining // total
    )
    observed_remaining = retained_max * remaining * 5 // 4
    projected_remaining = max(frozen_remaining, observed_remaining)
    required = (
        DISK_FLOOR_BYTES
        + EVALUATION_RESERVE_BYTES
        + projected_remaining
    )
    available = disk_free(Path("/data/share8")) + storage_reservation_bytes(protocol)
    if available < required:
        raise RuntimeError("P30 campaign stopped at its rolling disk projection")
    # Keep the evaluation reserve plus all actions *after* the next action
    # physically allocated. The difference releases one 25%-buffered action
    # budget without exposing outcome metrics or relying on other tenants.
    after_next = max(0, remaining - 1)
    frozen_after_next = (
        preflight["projectedTrainingBytesWith25PercentSafety"]
        * after_next
        // total
    )
    observed_after_next = retained_max * after_next * 5 // 4
    set_storage_reservation(
        protocol,
        EVALUATION_RESERVE_BYTES
        + max(frozen_after_next, observed_after_next),
    )
    projected_compute = accumulated + duration_max * remaining
    if projected_compute > protocol["runtime"]["maxCampaignComputeSeconds"]:
        raise RuntimeError("P30 campaign stopped at its rolling compute budget")


def _phase0_next(
    protocol_path: Path, protocol: dict[str, Any]
) -> dict[str, Any] | None:
    for name in PHASE0_NAMES:
        authorization_path = phase0_authorization_path(protocol, name)
        root = phase0_output_root(protocol, name)
        subject = {
            "logicalId": f"phase0-{name}-issuer",
            "name": name,
            "root": str(root),
            "replicate": "phase0",
            "arm": name,
        }
        if not authorization_path.exists():
            return emit_request(
                protocol_path=protocol_path,
                protocol=protocol,
                role="issuer",
                verb="issue-preflight-execution",
                subject=subject,
                predecessor=None,
                expected_output=authorization_path,
            )
        authorization = validate_stored_authorization(
            authorization_path=authorization_path,
            protocol_path=protocol_path,
            kind="preflight",
            root=root,
            replicate="phase0",
            arm=name,
        )
        action = next_execution_action(
            protocol_path=protocol_path,
            protocol=protocol,
            authorization_path=authorization_path,
            authorization=authorization,
            normal_subject={
                **subject,
                "logicalId": f"phase0-{name}-executor",
                "authorizationPath": str(authorization_path),
            },
        )
        if action is not None:
            return action
    inputs = phase0_review_inputs(protocol_path, protocol)
    review_path = gate_review_paths(protocol, "phase0-runtime")["receipt"]
    if not review_path.exists():
        return _review_required_status(
            protocol_path=protocol_path,
            protocol=protocol,
            mode="phase0-runtime",
            inputs=inputs,
        )
    validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="phase0-runtime",
        required_inputs=inputs,
    )
    readiness = phase0_readiness_path(protocol)
    if not readiness.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-phase0-readiness",
            subject={"logicalId": "phase0-readiness"},
            predecessor=None,
            expected_output=readiness,
        )
    require_phase0_readiness(protocol_path, protocol)
    return None


def next_action(protocol_path: Path) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    phase0_action = _phase0_next(protocol_path, protocol)
    if phase0_action is not None:
        return phase0_action
    require_phase0_readiness(protocol_path, protocol)
    ensure_preflight_start(protocol_path, protocol)
    # The signed three-arm generation-one preflight is the only route into the
    # remaining campaign.
    for arm in ARMS:
        action = _generation_next(protocol_path, protocol, "a", arm, 1)
        if action is not None:
            return action
    preflight = preflight_path(protocol_path, protocol)
    if not preflight.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-preflight",
            subject={"logicalId": "matched-generation-one-preflight"},
            predecessor=None,
            expected_output=preflight,
        )
    require_preflight(protocol_path, protocol)
    full_review_inputs = full_campaign_review_inputs(protocol_path, protocol)
    full_review = gate_review_paths(protocol, "full-campaign")["receipt"]
    if not full_review.exists():
        return _review_required_status(
            protocol_path=protocol_path,
            protocol=protocol,
            mode="full-campaign",
            inputs=full_review_inputs,
        )
    validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="full-campaign",
        required_inputs=full_review_inputs,
    )
    full_authorization = full_campaign_authorization_path(protocol)
    if not full_authorization.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="authorize-full-campaign",
            subject={"logicalId": "full-campaign-authorization"},
            predecessor=preflight,
            expected_output=full_authorization,
        )
    require_full_campaign_authorization(protocol_path, protocol)
    _rolling_budget_guard(protocol_path, protocol)
    for generation in range(1, protocol["seedSchedule"]["maxGeneration"] + 1):
        for replicate in REPLICATES:
            for arm in ARMS:
                action = _generation_next(
                    protocol_path, protocol, replicate, arm, generation
                )
                if action is not None:
                    return action
    barrier = final_barrier_path(protocol)
    if not barrier.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-final-barrier",
            subject={"logicalId": "all-final-generation-chains"},
            predecessor=None,
            expected_output=barrier,
        )
    barrier_value = read_signed(
        barrier,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    if (
        barrier_value.get("schemaVersion") != FINAL_BARRIER_SCHEMA
        or barrier_value.get("valid") is not True
        or barrier_value.get("outcomesInspected") is not False
        or barrier_value.get("endpointCount") != len(REPLICATES) * len(ARMS)
    ):
        raise ValueError("final-generation completeness barrier is invalid")
    validate_role_request_binding(
        barrier_value.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-final-barrier",
        predecessor=None,
        expected_output=barrier,
    )
    for replicate in REPLICATES:
        for arm in ARMS:
            for role in ("primary", "replay"):
                action = _evaluation_next(
                    protocol_path, protocol, replicate, arm, role
                )
                if action is not None:
                    return action
            output = pair_path(protocol, replicate, arm)
            if not output.exists():
                label = endpoint_label(replicate, arm)
                primary_authorization = read_signed(
                    evaluation_authorization_path(
                        ledger_for(protocol), label, "primary"
                    ),
                    role_public_key_path(protocol["executionTrust"], "issuer"),
                    "issuer",
                )
                replay_authorization = read_signed(
                    evaluation_authorization_path(
                        ledger_for(protocol), label, "replay"
                    ),
                    role_public_key_path(protocol["executionTrust"], "issuer"),
                    "issuer",
                )
                primary_receipt, _ = validate_completed_execution(
                    authorization_path=evaluation_authorization_path(
                        ledger_for(protocol), label, "primary"
                    ),
                    authorization=primary_authorization,
                    protocol=protocol,
                )
                replay_receipt, _ = validate_completed_execution(
                    authorization_path=evaluation_authorization_path(
                        ledger_for(protocol), label, "replay"
                    ),
                    authorization=replay_authorization,
                    protocol=protocol,
                )
                return emit_request(
                    protocol_path=protocol_path,
                    protocol=protocol,
                    role="guardian",
                    verb="attest-pair",
                    subject={
                        "logicalId": f"{label}-pair",
                        "replicate": replicate,
                        "arm": arm,
                        "primaryReceipt": str(primary_receipt),
                        "replayReceipt": str(replay_receipt),
                    },
                    predecessor=replay_receipt,
                    expected_output=output,
                )
            pair = read_signed(
                output,
                role_public_key_path(protocol["executionTrust"], "guardian"),
                "guardian",
            )
            if (
                pair.get("schemaVersion") != PAIR_SCHEMA
                or pair.get("valid") is not True
                or pair.get("replicate") != replicate
                or pair.get("arm") != arm
            ):
                raise ValueError("stored pair-integrity receipt is invalid")
            replay_authorization = read_signed(
                evaluation_authorization_path(
                    ledger_for(protocol), endpoint_label(replicate, arm), "replay"
                ),
                role_public_key_path(protocol["executionTrust"], "issuer"),
                "issuer",
            )
            replay_receipt, _ = validate_completed_execution(
                authorization_path=evaluation_authorization_path(
                    ledger_for(protocol), endpoint_label(replicate, arm), "replay"
                ),
                authorization=replay_authorization,
                protocol=protocol,
            )
            validate_role_request_binding(
                pair.get("request"),
                protocol_path=protocol_path,
                protocol=protocol,
                role="guardian",
                verb="attest-pair",
                predecessor=replay_receipt,
                expected_output=output,
            )
    # All training/evaluation artifacts are now durable; release the shared
    # storage reservation before constructing the metric-free analysis manifest.
    set_storage_reservation(protocol, 0)
    last_pair = pair_path(protocol, REPLICATES[-1], ARMS[-1])
    manifest_path = analysis_manifest_path(protocol)
    if not manifest_path.exists():
        return emit_request(
            protocol_path=protocol_path,
            protocol=protocol,
            role="guardian",
            verb="attest-analysis-manifest",
            subject={
                "logicalId": "final-analysis-manifest",
                "finalGenerationBarrier": {
                    "path": str(barrier),
                    "sha256": sha256_file(barrier),
                },
            },
            predecessor=last_pair,
            expected_output=manifest_path,
        )
    manifest = read_signed(
        manifest_path,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
    )
    if (
        manifest.get("schemaVersion") != ANALYSIS_MANIFEST_SCHEMA
        or manifest.get("valid") is not True
        or manifest.get("immutable") is not True
        or manifest.get("promotionEligible") is not False
        or manifest.get("outcomesInspected") is not False
        or manifest.get("metricsIncluded") is not False
        or manifest.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
        or manifest.get("counts")
        != {
            "endpoints": 54,
            "generationReceipts": 432,
            "evaluationReceipts": 108,
            "pairIntegrityReceipts": 54,
            "signedReceipts": 595,
            "uniqueExecutionTokens": 540,
        }
    ):
        raise ValueError("signed analysis manifest is invalid")
    validate_role_request_binding(
        manifest.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-analysis-manifest",
        predecessor=last_pair,
        expected_output=manifest_path,
    )
    request, draft = prepare_analysis_authorization_draft(protocol_path, protocol)
    draft_path = analysis_authorization_draft_path(protocol)
    review_path = analysis_review_receipt_path(protocol)
    review_attempt_path = analysis_review_attempt_path(protocol)
    review_stdout_path = analysis_review_stdout_path(protocol)
    review_stderr_path = analysis_review_stderr_path(protocol)
    authorization_path = analysis_authorization_path(protocol)
    review_attester_public_key_path = role_public_key_path(
        protocol["executionTrust"], "review-attester"
    )
    review_attester_public_key_binding = {
        "path": str(review_attester_public_key_path),
        "sha256": sha256_file(review_attester_public_key_path),
    }
    from v35_p30_analysis_review import (
        APPROVED_CLAUDE_EXECUTABLE,
        APPROVED_REVIEW_CONTAINER,
        LOCAL_REVIEW_LAUNCHER_RELATIVE,
    )
    if (
        protocol["executionTrust"]["reviewRuntime"]["claudeExecutable"]
        != APPROVED_CLAUDE_EXECUTABLE
        or protocol["executionTrust"]["reviewRuntime"]["container"]
        != APPROVED_REVIEW_CONTAINER
    ):
        raise ValueError("protocol local Fable runtime pin changed")
    analysis_launcher_sha = sha256_file(REPO_ROOT / LOCAL_REVIEW_LAUNCHER_RELATIVE)
    review_attestation_request = emit_request(
        protocol_path=protocol_path,
        protocol=protocol,
        role="review-attester",
        verb="attest-analysis-review",
        subject={
            "logicalId": "final-analysis-fable-review-attestation",
            "authorizationDraft": {
                "path": str(draft_path),
                "sha256": sha256_file(draft_path),
            },
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256_file(manifest_path),
            },
            "reviewAttemptPath": str(review_attempt_path),
            "reviewStdoutPath": str(review_stdout_path),
            "reviewStderrPath": str(review_stderr_path),
            "reviewAttesterPublicKey": review_attester_public_key_binding,
            "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
            "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
            "launcherSha256": analysis_launcher_sha,
        },
        predecessor=draft_path,
        expected_output=review_path,
    )
    review_attestation_request_path = _request_path(
        protocol, review_attestation_request["subject"]["logicalId"]
    )
    review_attestation_binding = {
        "path": str(review_attestation_request_path),
        "sha256": sha256_file(review_attestation_request_path),
    }
    if not review_path.exists() and not review_attempt_path.exists():
        return {
            "schemaVersion": "arc-v35-p30-campaign-status-v1",
            "status": "analysis-review-required",
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256_file(manifest_path),
            },
            "authorizationDraft": {
                "path": str(draft_path),
                "sha256": sha256_file(draft_path),
            },
            "reviewReceiptPath": str(review_path),
            "reviewAttemptPath": str(review_attempt_path),
            "reviewStdoutPath": str(review_stdout_path),
            "reviewStderrPath": str(review_stderr_path),
            "reviewAttestationRequest": review_attestation_binding,
            "reviewAttesterPublicKey": review_attester_public_key_binding,
            "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
            "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
            "launcherSha256": analysis_launcher_sha,
            "outcomesInspected": False,
            "promotionEligible": False,
        }
    if not review_path.exists():
        return {
            "schemaVersion": "arc-v35-p30-campaign-status-v1",
            "status": "analysis-review-postprocess-required",
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256_file(manifest_path),
            },
            "authorizationDraft": {
                "path": str(draft_path),
                "sha256": sha256_file(draft_path),
            },
            "reviewReceiptPath": str(review_path),
            "reviewAttemptPath": str(review_attempt_path),
            "reviewStdoutPath": str(review_stdout_path),
            "reviewStderrPath": str(review_stderr_path),
            "reviewAttestationRequest": review_attestation_binding,
            "reviewAttesterPublicKey": review_attester_public_key_binding,
            "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
            "reviewRuntime": protocol["executionTrust"]["reviewRuntime"],
            "launcherSha256": analysis_launcher_sha,
            "reviewAttemptSha256": sha256_file(review_attempt_path),
            "outcomesInspected": False,
            "promotionEligible": False,
        }
    from v35_p30_analysis_review import validate_analysis_review_receipt

    signed_review = validate_analysis_review_receipt(
        review_path,
        draft_path=draft_path,
        manifest_path=manifest_path,
        review_attester_public_key_path=review_attester_public_key_path,
    )
    if signed_review.get("request") != review_attestation_binding:
        raise ValueError("locally signed analysis Fable review lacks its request binding")
    validate_role_request_binding(
        signed_review["request"],
        protocol_path=protocol_path,
        protocol=protocol,
        role="review-attester",
        verb="attest-analysis-review",
        predecessor=draft_path,
        expected_output=review_path,
    )
    if not authorization_path.exists():
        return request
    authorization = validate_stored_authorization(
        authorization_path=authorization_path,
        protocol_path=protocol_path,
        kind="analysis",
        root=REPO_ROOT,
        replicate="analysis",
        arm="analysis",
        predecessor=manifest_path,
    )
    from issue_v35_p30_analysis_bundle import (
        validate_reviewed_analysis_authorization_rebinding,
    )

    validate_reviewed_analysis_authorization_rebinding(
        draft,
        authorization,
        review_finished_at_utc=signed_review["finishedAtUtc"],
    )
    action = next_execution_action(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=authorization,
        normal_subject={
            "logicalId": "final-analysis-executor",
            "authorizationPath": str(authorization_path),
        },
    )
    if action is not None:
        return action
    receipt_path, _ = validate_completed_execution(
        authorization_path=authorization_path,
        authorization=authorization,
        protocol=protocol,
    )
    return {
        "schemaVersion": "arc-v35-p30-campaign-status-v1",
        "status": "analysis-complete-sealed-uninspected",
        "manifest": {"path": str(manifest_path), "sha256": sha256_file(manifest_path)},
        "authorization": {
            "path": str(authorization_path),
            "sha256": sha256_file(authorization_path),
        },
        "executionReceipt": {
            "path": str(receipt_path),
            "sha256": sha256_file(receipt_path),
        },
        "outcomesInspected": False,
        "promotionEligible": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(next_action(args.protocol), separators=(",", ":")))


if __name__ == "__main__":
    main()
