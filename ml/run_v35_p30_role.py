#!/usr/bin/env python3
"""Source-locked P30 role entrypoints; a private key exists for one action only."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from analyze_v35_p30_long_horizon import (
    ARMS,
    REPLICATES,
    REPO_ROOT,
    SOURCE_LOCK_SCHEMA,
    endpoint_label,
    read_json_object,
    sha256,
    validate_protocol,
    verify_git_context,
)
from issue_v35_p30_evaluation_authorization import build as build_evaluation_authorization
from issue_v35_p30_generation_authorization import build as build_generation_authorization
from issue_v35_p30_preflight_authorization import (
    build as build_preflight_authorization,
)
from issue_v35_p30_pair_integrity import build as build_pair_integrity
from issue_v35_p30_analysis_bundle import (
    build_manifest_payload,
    rebind_reviewed_analysis_authorization_times,
    validate_reviewed_analysis_authorization_rebinding,
)
from run_v35_p30_campaign import (
    DISK_FLOOR_BYTES,
    EVALUATION_RESERVE_BYTES,
    FINAL_BARRIER_SCHEMA,
    LOGICAL_COMPLETION_SCHEMA,
    PREFLIGHT_SCHEMA,
    ROLE_REQUEST_SCHEMA,
    analysis_authorization_draft_path,
    analysis_authorization_path,
    analysis_manifest_path,
    analysis_review_draft_receipt_path,
    analysis_review_receipt_path,
    analysis_review_stderr_path,
    analysis_review_stdout_path,
    disk_free,
    elapsed_seconds,
    evaluation_authorization_path,
    final_barrier_path,
    full_campaign_review_inputs,
    generation_authorization_path,
    ledger_for,
    nonexecutor_signing_attempt_path,
    next_action,
    pair_path,
    phase0_review_inputs,
    preflight_path,
    preflight_start_path,
    predecessor_for_generation,
    recovery_paths,
    recovery_request_logical_id,
    require_phase0_readiness,
    require_preflight,
    root_for,
    validate_recovery_state,
    validate_completed_execution,
    validate_stored_authorization,
)
from v35_p30_authorized_execution import (
    build_executor_launch_permit_payload,
    prepare_pre_child_recovery_execution,
    prepare_execution_receipt,
    persist_executor_launch_permit,
    seal_pre_child_recovery,
    seal_receipt_only_recovery,
    seal_execution_receipt,
    unsigned_receipt_path,
)
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    read_regular_nofollow,
    role_public_key_path,
    sha256_bytes,
    sha256_file,
    sign_payload,
    verify_signed_payload,
)
from v35_p30_recovery import (
    ACTIONS,
    GUARDIAN_INCIDENT_SCHEMA,
    PRE_CHILD,
    RECEIPT_ONLY,
    RECOVERY_ELIGIBLE_KINDS,
    RECOVERY_LINK_SCHEMA,
    protected_bindings_sha256,
    validate_execution_draft,
    validate_guardian_incident,
    validate_recovery_link,
)
from v35_p30_phase0 import (
    FULL_CAMPAIGN_AUTHORIZATION_SCHEMA,
    PHASE0_NAMES,
    PHASE0_READINESS_SCHEMA,
    PHASE0_REPORT_SCHEMAS,
    validate_analyzer_rehearsal_report,
    binding as phase0_binding,
    full_campaign_authorization_path,
    gate_review_paths,
    phase0_authorization_path,
    phase0_output_root,
    phase0_readiness_path,
    validate_gate_review_receipt,
)
from v35_p30_key_custody import (
    receive_private_key,
    receive_signed_launch_permit,
    serialized_role_action,
)


SIGN_READY_SCHEMA = "arc-v35-p30-role-sign-ready-v1"
SIGNING_PLAN_SCHEMA = "arc-v35-p30-unsigned-signing-plan-v1"
SIGNING_ATTEMPT_SCHEMA = "arc-v35-p30-signing-attempt-v1"


def signing_plan_path(output: Path) -> Path:
    return output.with_name(output.name + ".unsigned-signing-plan.json")


def signing_attempt_path(output: Path) -> Path:
    return nonexecutor_signing_attempt_path(output)


def _entry_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


@dataclass(frozen=True)
class SigningReservation:
    action_id: str
    required_role: str
    output: Path
    plan_path: Path
    plan_bytes: bytes
    marker_path: Path
    marker_bytes: bytes

    @property
    def plan_binding(self) -> dict[str, str]:
        return {
            "path": str(self.plan_path),
            "sha256": sha256_bytes(self.plan_bytes),
        }

    @property
    def marker_binding(self) -> dict[str, str]:
        return {
            "path": str(self.marker_path),
            "sha256": sha256_bytes(self.marker_bytes),
        }

    def validate(self) -> None:
        if read_regular_nofollow(self.plan_path) != self.plan_bytes:
            raise ValueError("durable unsigned signing plan changed")
        if read_regular_nofollow(self.marker_path) != self.marker_bytes:
            raise ValueError("durable signing attempt marker changed")
        if _entry_exists(self.output):
            raise RuntimeError("non-executor signing output appeared before sealing")


@dataclass(frozen=True)
class PreparedSigningAction:
    required_role: str
    output: Path
    commitment: dict[str, Any]
    seal_callback: Callable[[int], Path]

    @property
    def commitment_sha256(self) -> str:
        return sha256_bytes(canonical_json(self.commitment))

    def reserve(self, action_id: str) -> SigningReservation:
        if (
            len(action_id) != 64
            or any(character not in "0123456789abcdef" for character in action_id)
        ):
            raise ValueError("non-executor signing action ID is malformed")
        plan_path = signing_plan_path(self.output)
        marker_path = signing_attempt_path(self.output)
        if _entry_exists(marker_path):
            raise RuntimeError(
                "non-executor signing action was already attempted and is terminally closed"
            )
        plan_bytes = canonical_json(self.commitment) + b"\n"
        marker = {
            "schemaVersion": SIGNING_ATTEMPT_SCHEMA,
            "immutable": True,
            "attemptOrdinal": 1,
            "actionId": action_id,
            "requiredRole": self.required_role,
            "expectedOutputPath": str(self.output),
            "unsignedSigningPlan": {
                "path": str(plan_path),
                "sha256": sha256_bytes(plan_bytes),
            },
        }
        marker_bytes = canonical_json(marker) + b"\n"
        # The attempt is consumed first. Any crash or failure after this O_EXCL
        # write is terminal, even if the plan or final artifact is absent.
        atomic_write_exclusive(marker_path, marker_bytes, mode=0o400)
        if _entry_exists(plan_path):
            if read_regular_nofollow(plan_path) != plan_bytes:
                raise ValueError("persisted unsigned signing plan changed")
        else:
            atomic_write_exclusive(plan_path, plan_bytes, mode=0o400)
        reservation = SigningReservation(
            action_id,
            self.required_role,
            self.output,
            plan_path,
            plan_bytes,
            marker_path,
            marker_bytes,
        )
        reservation.validate()
        return reservation

    def seal(self, key_fd: int, reservation: SigningReservation) -> Path:
        if (
            reservation.action_id == ""
            or reservation.required_role != self.required_role
            or reservation.output != self.output
            or reservation.plan_bytes != canonical_json(self.commitment) + b"\n"
        ):
            raise ValueError("signing reservation does not match prepared action")
        reservation.validate()
        return self.seal_callback(key_fd)


def _prepared_artifacts(
    *,
    required_role: str,
    output: Path,
    protocol: dict[str, Any],
    artifacts: list[tuple[Path, dict[str, Any], str | None]],
) -> PreparedSigningAction:
    """Bind complete unsigned payloads before exposing any private key."""

    normalized_artifacts = [
        (path, json.loads(canonical_json(payload)), signing_role)
        for path, payload, signing_role in artifacts
    ]
    commitment = {
        "schemaVersion": SIGNING_PLAN_SCHEMA,
        "requiredRole": required_role,
        "expectedOutputPath": str(output),
        "artifacts": [
            {
                "path": str(path),
                "signingRole": signing_role,
                "unsignedPayload": payload,
                "unsignedPayloadSha256": sha256_bytes(canonical_json(payload)),
            }
            for path, payload, signing_role in normalized_artifacts
        ],
    }

    def seal(key_fd: int) -> Path:
        encoded: list[tuple[Path, bytes]] = []
        for path, original, signing_role in normalized_artifacts:
            payload = dict(original)
            if signing_role is not None:
                payload["signature"] = sign_payload(
                    payload,
                    role=signing_role,
                    private_key_fd=key_fd,
                    public_key_path=role_public_key_path(
                        protocol["executionTrust"], signing_role
                    ),
                )
            encoded.append((path, canonical_json(payload) + b"\n"))
        for path, payload_bytes in encoded:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_exclusive(path, payload_bytes)
        return output

    return PreparedSigningAction(required_role, output, commitment, seal)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _parse_utc(value: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("role evidence timestamp is malformed")
    return dt.datetime.fromisoformat(value[:-1] + "+00:00")


def _read_signed(path: Path, public_key: Path, role: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    return verify_signed_payload(
        value, expected_role=role, public_key_path=public_key
    )


def validate_frozen_source(protocol: dict[str, Any]) -> None:
    contract = protocol["sourceContract"]
    path = Path(contract["artifact"])
    if not path.is_absolute():
        path = REPO_ROOT / path
    if not path.is_file() or sha256_file(path) != contract["sha256"]:
        raise ValueError("P30 source lock is missing or hash-invalid")
    source_lock = read_json_object(path, "P30 source lock")
    if (
        source_lock.get("schemaVersion") != SOURCE_LOCK_SCHEMA
        or source_lock.get("authorized") is not True
        or source_lock.get("immutable") is not True
        or source_lock.get("promotionEligible") is not False
        or not isinstance(source_lock.get("files"), dict)
    ):
        raise ValueError("P30 source lock is not authorized and immutable")
    for label, entry in source_lock["files"].items():
        if (
            not isinstance(label, str)
            or not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "gitBlobOid"}
            or not isinstance(entry["path"], str)
        ):
            raise ValueError("P30 source-lock file registry is malformed")
        file_path = REPO_ROOT / entry["path"]
        if not file_path.is_file() or sha256_file(file_path) != entry["sha256"]:
            raise ValueError(f"P30 frozen source file changed: {label}")
    verify_git_context(source_lock)


def load_request(
    request_path: Path,
    *,
    protocol_path: Path,
    protocol: dict[str, Any],
    expected_role: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    request_path = request_path.resolve()
    if request_path.parent != ledger_for(protocol) / "requests":
        raise ValueError("P30 role request is outside the external request ledger")
    request = read_json_object(request_path, "P30 role request")
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
        raise ValueError("P30 role request keys changed")
    nonce = request.get("requestNonce")
    if (
        request.get("schemaVersion") != ROLE_REQUEST_SCHEMA
        or request.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
        or request.get("protocol")
        != {"path": str(protocol_path), "sha256": sha256(protocol_path)}
        or request.get("role") != expected_role
        or not isinstance(request.get("verb"), str)
        or not isinstance(request.get("subject"), dict)
        or not isinstance(request.get("expectedOutputPath"), str)
        or not isinstance(nonce, str)
        or len(nonce) != 64
        or any(character not in "0123456789abcdef" for character in nonce)
    ):
        raise ValueError("P30 role request identity changed")
    return request, {"path": str(request_path), "sha256": sha256_file(request_path)}


def _issue_generation(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    subject = request["subject"]
    root = Path(subject["root"]).resolve()
    generation = subject["generation"]
    replicate = subject["replicate"]
    arm = subject["arm"]
    if root != root_for(replicate, arm):
        raise ValueError("generation request root changed")
    predecessor = predecessor_for_generation(
        protocol_path, protocol, replicate, arm, generation
    )
    output = generation_authorization_path(
        ledger_for(protocol), replicate, arm, generation
    )
    if (
        request["verb"] != "issue-generation"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"]
        != (None if predecessor is None else sha256_file(predecessor))
    ):
        raise ValueError("generation request contract changed")
    issuer_public = role_public_key_path(protocol["executionTrust"], "issuer")
    payload = build_generation_authorization(
        protocol_path=protocol_path,
        root=root,
        generation=generation,
        public_key_path=issuer_public,
        predecessor_receipt=predecessor,
        request_binding=request_binding,
    )
    return _prepared_artifacts(
        required_role="issuer",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "issuer")],
    )


def _issue_preflight_execution(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    subject = request["subject"]
    name = subject.get("name")
    if name not in PHASE0_NAMES:
        raise ValueError("phase-zero preflight request name changed")
    output = phase0_authorization_path(protocol, name)
    root = phase0_output_root(protocol, name)
    if (
        request["verb"] != "issue-preflight-execution"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] is not None
        or subject.get("root") != str(root)
        or subject.get("replicate") != "phase0"
        or subject.get("arm") != name
    ):
        raise ValueError("phase-zero preflight request contract changed")
    payload = build_preflight_authorization(
        protocol_path=protocol_path,
        name=name,
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "issuer"
        ),
        request_binding=request_binding,
    )
    return _prepared_artifacts(
        required_role="issuer",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "issuer")],
    )


def _issue_evaluation(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    subject = request["subject"]
    replicate = subject["replicate"]
    arm = subject["arm"]
    evaluation_role = subject["evaluationRole"]
    root = Path(subject["root"]).resolve()
    if root != root_for(replicate, arm) or evaluation_role not in ("primary", "replay"):
        raise ValueError("evaluation request subject changed")
    label = endpoint_label(replicate, arm)
    ledger = ledger_for(protocol)
    if evaluation_role == "primary":
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
    prior = _read_signed(
        predecessor_authorization,
        role_public_key_path(protocol["executionTrust"], "issuer"),
        "issuer",
    )
    predecessor, _ = validate_completed_execution(
        authorization_path=predecessor_authorization,
        authorization=prior,
        protocol=protocol,
    )
    output = evaluation_authorization_path(ledger, label, evaluation_role)
    if (
        request["verb"] != "issue-evaluation"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] != sha256_file(predecessor)
    ):
        raise ValueError("evaluation request contract changed")
    issuer_public = role_public_key_path(protocol["executionTrust"], "issuer")
    payload = build_evaluation_authorization(
        protocol_path=protocol_path,
        root=root,
        role=evaluation_role,
        public_key_path=issuer_public,
        predecessor_receipt_path=predecessor,
        request_binding=request_binding,
    )
    return _prepared_artifacts(
        required_role="issuer",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "issuer")],
    )


def _issue_pre_child_recovery(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    """Prepare the sole issuer authorization allowed by a PRE_CHILD incident."""

    original_path, original = _load_original_recovery_authorization(
        protocol_path, protocol, request
    )
    paths = recovery_paths(original)
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=original_path,
        authorization=original,
    )
    token = request["subject"].get("recoveryTokenId")
    if (
        state.get("incident") is None
        or state["draft"].get("recoveryClass") != PRE_CHILD
        or "link" in state
        or request.get("verb") != "issue-recovery"
        or request.get("expectedOutputPath") != str(paths["replacementAuthorization"])
        or request.get("predecessorSha256")
        != sha256_file(paths["incidentAttestation"])
        or request["subject"].get("executionDraft")
        != {"path": str(paths["executionDraft"]), "sha256": sha256_file(paths["executionDraft"])}
        or request["subject"].get("guardianIncident")
        != {"path": str(paths["incident"]), "sha256": sha256_file(paths["incident"])}
        or request["subject"].get("incidentAttestation")
        != {
            "path": str(paths["incidentAttestation"]),
            "sha256": sha256_file(paths["incidentAttestation"]),
        }
        or request["subject"].get("recoveryClass") != PRE_CHILD
        or request["subject"].get("recoveryOrdinal") != 1
        or not isinstance(token, str)
        or len(token) != 64
        or token == original["tokenId"]
    ):
        raise ValueError("PRE_CHILD issuer recovery request changed")
    issuer_public = role_public_key_path(protocol["executionTrust"], "issuer")
    kind = original["kind"]
    if kind == "generation":
        predecessor = original.get("predecessor")
        payload = build_generation_authorization(
            protocol_path=protocol_path,
            root=Path(original["subject"]["root"]),
            generation=original["subject"]["generation"],
            public_key_path=issuer_public,
            predecessor_receipt=(
                None if predecessor is None else Path(predecessor["receiptPath"])
            ),
            request_binding=request_binding,
            token_id=token,
        )
    elif kind in ("evaluation-primary", "evaluation-replay"):
        payload = build_evaluation_authorization(
            protocol_path=protocol_path,
            root=Path(original["subject"]["root"]),
            role=original["subject"]["role"],
            public_key_path=issuer_public,
            predecessor_receipt_path=Path(original["predecessor"]["receiptPath"]),
            request_binding=request_binding,
            token_id=token,
        )
    else:
        raise ValueError("PRE_CHILD recovery is forbidden for this authorization kind")
    if protected_bindings_sha256(payload) != protected_bindings_sha256(original):
        raise ValueError("PRE_CHILD replacement changes protected bindings")
    return _prepared_artifacts(
        required_role="issuer",
        output=paths["replacementAuthorization"],
        protocol=protocol,
        artifacts=[(paths["replacementAuthorization"], payload, "issuer")],
    )


def _prepare_execution(
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
    launch_permit_path: Path | None,
) -> Path:
    authorization = Path(request["subject"]["authorizationPath"]).resolve()
    signed = read_json_object(authorization, "execution authorization")
    receipt = Path(signed["ledger"]["receiptPath"])
    if (
        request["verb"] != "execute"
        or request["predecessorSha256"] != sha256_file(authorization)
        or request["expectedOutputPath"] != str(receipt)
    ):
        raise ValueError("executor request contract changed")
    return prepare_execution_receipt(
        authorization,
        issuer_public_key_path=role_public_key_path(
            protocol["executionTrust"], "issuer"
        ),
        analysis_authorizer_public_key_path=role_public_key_path(
            protocol["executionTrust"], "analysis-authorizer"
        ),
        execution_request_binding=request_binding,
        launch_permit_path=launch_permit_path,
    )


def _seal_execution(
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
    draft_path: Path,
    key_fd: int,
) -> Path:
    authorization = Path(request["subject"]["authorizationPath"]).resolve()
    trust = protocol["executionTrust"]
    return seal_execution_receipt(
        authorization,
        draft_path,
        issuer_public_key_path=role_public_key_path(trust, "issuer"),
        analysis_authorizer_public_key_path=role_public_key_path(
            trust, "analysis-authorizer"
        ),
        executor_public_key_path=role_public_key_path(trust, "executor"),
        executor_private_key_fd=key_fd,
        execution_request_binding=request_binding,
    )


def _prepare_pre_child_execution(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
    launch_permit_path: Path | None,
) -> Path:
    original_path = Path(request["subject"]["originalAuthorizationPath"]).resolve()
    original_signed = read_json_object(original_path, "original PRE_CHILD authorization")
    original = verify_signed_payload(
        original_signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(protocol["executionTrust"], "issuer"),
    )
    paths = recovery_paths(original)
    recovery_authorization_path = Path(
        request["subject"]["authorizationPath"]
    ).resolve()
    trust = protocol["executionTrust"]
    return prepare_pre_child_recovery_execution(
        recovery_authorization_path,
        original_path,
        paths["executionDraft"],
        paths["incident"],
        paths["link"],
        paths["linkAttestation"],
        issuer_public_key_path=role_public_key_path(trust, "issuer"),
        analysis_authorizer_public_key_path=role_public_key_path(
            trust, "analysis-authorizer"
        ),
        guardian_public_key_path=role_public_key_path(trust, "guardian"),
        execution_request_binding=request_binding,
        launch_permit_path=launch_permit_path,
    )


def _seal_pre_child_execution(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
    draft_path: Path,
    key_fd: int,
) -> Path:
    original_path = Path(request["subject"]["originalAuthorizationPath"]).resolve()
    original_signed = read_json_object(original_path, "original PRE_CHILD authorization")
    original = verify_signed_payload(
        original_signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(protocol["executionTrust"], "issuer"),
    )
    paths = recovery_paths(original)
    trust = protocol["executionTrust"]
    return seal_pre_child_recovery(
        Path(request["subject"]["authorizationPath"]).resolve(),
        draft_path,
        original_path,
        paths["executionDraft"],
        paths["incident"],
        paths["link"],
        paths["linkAttestation"],
        issuer_public_key_path=role_public_key_path(trust, "issuer"),
        analysis_authorizer_public_key_path=role_public_key_path(
            trust, "analysis-authorizer"
        ),
        guardian_public_key_path=role_public_key_path(trust, "guardian"),
        executor_public_key_path=role_public_key_path(trust, "executor"),
        executor_private_key_fd=key_fd,
        execution_request_binding=request_binding,
    )


def _load_original_recovery_authorization(
    protocol_path: Path, protocol: dict[str, Any], request: dict[str, Any]
) -> tuple[Path, dict[str, Any]]:
    authorization_path = Path(request["subject"]["originalAuthorizationPath"]).resolve()
    signed = read_json_object(authorization_path, "original recovery authorization")
    if signed.get("kind") not in RECOVERY_ELIGIBLE_KINDS:
        raise ValueError("recovery is forbidden for this authorization kind")
    unsigned = verify_signed_payload(
        signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "issuer"
        ),
    )
    if (
        unsigned.get("protocol")
        != {"path": str(protocol_path), "sha256": sha256(protocol_path)}
        or unsigned.get("campaignId") != protocol["experiment"]
    ):
        raise ValueError("recovery request names an unrelated authorization")
    return authorization_path, unsigned


def _recovery_attestation_payload(
    *,
    protocol: dict[str, Any],
    request_binding: dict[str, str],
    authorization: dict[str, Any],
    recovery_class: str,
    phase: str,
    artifact_binding: dict[str, str],
) -> dict[str, Any]:
    payload = {
        "schemaVersion": LOGICAL_COMPLETION_SCHEMA,
        "phase": phase,
        "valid": True,
        "immutable": True,
        "outcomeBlind": True,
        "outcomesInspected": False,
        "promotionEligible": False,
        "campaignId": authorization["campaignId"],
        "kind": authorization["kind"],
        "originalTokenId": authorization["tokenId"],
        "recoveryClass": recovery_class,
        "attemptOrdinal": 1,
        "artifact": artifact_binding,
        "issuedAtUtc": utc_now(),
        "secondRecoveryForbidden": True,
        "request": request_binding,
    }
    return payload


def _attest_recovery_incident(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    authorization_path, authorization = _load_original_recovery_authorization(
        protocol_path, protocol, request
    )
    paths = recovery_paths(authorization)
    draft_path = paths["executionDraft"]
    draft = read_json_object(draft_path, "P30 recovery execution draft")
    validate_execution_draft(draft, authorization=authorization)
    if (
        request["verb"] != "attest-recovery-incident"
        or request["expectedOutputPath"] != str(paths["incidentAttestation"])
        or request["predecessorSha256"] != sha256_file(draft_path)
        or request["subject"].get("executionDraft")
        != {"path": str(draft_path), "sha256": sha256_file(draft_path)}
        or request["subject"].get("recoveryClass") != draft["recoveryClass"]
        or request["subject"].get("recoveryOrdinal") != 1
    ):
        raise ValueError("recovery incident guardian request changed")
    if paths["incident"].exists():
        signed_incident = read_json_object(paths["incident"], "signed recovery incident")
        validate_guardian_incident(
            signed_incident,
            guardian_public_key_path=role_public_key_path(
                protocol["executionTrust"], "guardian"
            ),
            execution_draft=draft,
            authorization=authorization,
        )
        attestation = _recovery_attestation_payload(
            protocol=protocol,
            request_binding=request_binding,
            authorization=authorization,
            recovery_class=draft["recoveryClass"],
            phase="incident",
            artifact_binding={
                "path": str(paths["incident"]),
                "sha256": sha256_file(paths["incident"]),
            },
        )
        return _prepared_artifacts(
            required_role="guardian",
            output=paths["incidentAttestation"],
            protocol=protocol,
            artifacts=[(paths["incidentAttestation"], attestation, "guardian")],
        )
    else:
        incident = {
            "schemaVersion": GUARDIAN_INCIDENT_SCHEMA,
            "immutable": True,
            "outcomeBlind": True,
            "promotionEligible": False,
            "recoveryPermitted": True,
            "campaignId": authorization["campaignId"],
            "kind": authorization["kind"],
            "originalTokenId": authorization["tokenId"],
            "recoveryClass": draft["recoveryClass"],
            "diagnosticCode": draft["diagnosticCode"],
            "classifiedAtUtc": utc_now(),
            "attemptOrdinal": 1,
            "action": ACTIONS[draft["recoveryClass"]],
            "executionDraftSha256": sha256_bytes(canonical_json(draft)),
            "authorizationSha256": draft["authorization"]["sha256"],
            "consumedMarkerSha256": draft["consumedMarker"]["sha256"],
            "protectedBindingsSha256": protected_bindings_sha256(authorization),
            "candidateCodeMayRun": draft["recoveryClass"] == PRE_CHILD,
            "seedMayBeReused": draft["recoveryClass"] == PRE_CHILD,
            "secondRecoveryForbidden": True,
        }
        attestation_template = _recovery_attestation_payload(
            protocol=protocol,
            request_binding=request_binding,
            authorization=authorization,
            recovery_class=draft["recoveryClass"],
            phase="incident",
            artifact_binding={
                "path": str(paths["incident"]),
                "sha256": "{SIGNED_INCIDENT_SHA256}",
            },
        )
        commitment = {
            "schemaVersion": SIGNING_PLAN_SCHEMA,
            "requiredRole": "guardian",
            "expectedOutputPath": str(paths["incidentAttestation"]),
            "artifacts": [
                {
                    "path": str(paths["incident"]),
                    "signingRole": "guardian",
                    "unsignedPayload": incident,
                    "unsignedPayloadSha256": sha256_bytes(canonical_json(incident)),
                },
                {
                    "path": str(paths["incidentAttestation"]),
                    "signingRole": "guardian",
                    "unsignedPayload": attestation_template,
                    "unsignedPayloadSha256": sha256_bytes(
                        canonical_json(attestation_template)
                    ),
                    "dependency": {
                        "kind": "sha256-of-signed-canonical-json-line",
                        "sourceArtifactPath": str(paths["incident"]),
                        "targetField": "artifact.sha256",
                        "placeholder": "{SIGNED_INCIDENT_SHA256}",
                    },
                },
            ],
        }

        def seal(key_fd: int) -> Path:
            signed_incident = dict(incident)
            signed_incident["signature"] = sign_payload(
                signed_incident,
                role="guardian",
                private_key_fd=key_fd,
                public_key_path=role_public_key_path(
                    protocol["executionTrust"], "guardian"
                ),
            )
            incident_bytes = canonical_json(signed_incident) + b"\n"
            attestation = dict(attestation_template)
            attestation["artifact"] = {
                "path": str(paths["incident"]),
                "sha256": sha256_bytes(incident_bytes),
            }
            attestation["signature"] = sign_payload(
                attestation,
                role="guardian",
                private_key_fd=key_fd,
                public_key_path=role_public_key_path(
                    protocol["executionTrust"], "guardian"
                ),
            )
            atomic_write_exclusive(paths["incident"], incident_bytes)
            atomic_write_exclusive(
                paths["incidentAttestation"], canonical_json(attestation) + b"\n"
            )
            return paths["incidentAttestation"]

        return PreparedSigningAction(
            "guardian", paths["incidentAttestation"], commitment, seal
        )


def _attest_recovery_link(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    authorization_path, original = _load_original_recovery_authorization(
        protocol_path, protocol, request
    )
    paths = recovery_paths(original)
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=original,
    )
    incident = state["incident"]
    recovery_class = state["draft"]["recoveryClass"]
    token = request["subject"].get("recoveryTokenId")
    replacement: dict[str, Any] | None = None
    replacement_payload_digest: str | None = None
    if recovery_class == PRE_CHILD:
        signed_replacement = read_json_object(
            paths["replacementAuthorization"], "PRE_CHILD replacement authorization"
        )
        replacement = verify_signed_payload(
            signed_replacement,
            expected_role="issuer",
            public_key_path=role_public_key_path(protocol["executionTrust"], "issuer"),
        )
        replacement_payload_digest = sha256_bytes(canonical_json(replacement))
    if (
        request["verb"] != "attest-recovery-link"
        or request["expectedOutputPath"] != str(paths["linkAttestation"])
        or request["predecessorSha256"] != sha256_file(paths["incidentAttestation"])
        or request["subject"].get("recoveryClass") != recovery_class
        or request["subject"].get("recoveryOrdinal") != 1
        or not isinstance(token, str)
        or len(token) != 64
        or token == original["tokenId"]
    ):
        raise ValueError("recovery link guardian request changed")
    link = {
        "schemaVersion": RECOVERY_LINK_SCHEMA,
        "immutable": True,
        "promotionEligible": False,
        "campaignId": original["campaignId"],
        "kind": original["kind"],
        "recoveryClass": recovery_class,
        "action": ACTIONS[recovery_class],
        "attemptOrdinal": 1,
        "originalTokenId": original["tokenId"],
        "recoveryTokenId": token,
        "guardianIncidentPayloadSha256": sha256_bytes(canonical_json(incident)),
        "originalAuthorizationSha256": state["draft"]["authorization"]["sha256"],
        "replacementAuthorizationPayloadSha256": replacement_payload_digest,
        "protectedBindingsSha256": protected_bindings_sha256(original),
        "candidateCodeMayRun": recovery_class == PRE_CHILD,
        "secondRecoveryForbidden": True,
    }
    validate_recovery_link(
        link,
        guardian_incident=incident,
        original_authorization=original,
        replacement_authorization=replacement,
    )
    if paths["link"].exists():
        if read_json_object(paths["link"], "P30 recovery link") != link:
            raise ValueError("stored P30 recovery link changed")
        link_binding = {
            "path": str(paths["link"]),
            "sha256": sha256_file(paths["link"]),
        }
        artifacts: list[tuple[Path, dict[str, Any], str | None]] = []
    else:
        link_binding = {
            "path": str(paths["link"]),
            "sha256": sha256_bytes(canonical_json(link) + b"\n"),
        }
        artifacts = [(paths["link"], link, None)]
    attestation = _recovery_attestation_payload(
        protocol=protocol,
        request_binding=request_binding,
        authorization=original,
        recovery_class=recovery_class,
        phase="link",
        artifact_binding=link_binding,
    )
    artifacts.append((paths["linkAttestation"], attestation, "guardian"))
    return _prepared_artifacts(
        required_role="guardian",
        output=paths["linkAttestation"],
        protocol=protocol,
        artifacts=artifacts,
    )


def _seal_recovery_receipt(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
    key_fd: int,
) -> Path:
    authorization_path = Path(request["subject"]["authorizationPath"]).resolve()
    signed = read_json_object(authorization_path, "receipt-only authorization")
    if signed.get("kind") not in RECOVERY_ELIGIBLE_KINDS:
        raise ValueError("receipt-only recovery is forbidden for this authorization kind")
    original = verify_signed_payload(
        signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "issuer"
        ),
    )
    paths = recovery_paths(original)
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=original,
    )
    receipt_path = Path(original["ledger"]["receiptPath"])
    draft_path = unsigned_receipt_path(receipt_path)
    normal_draft = read_json_object(draft_path, "receipt-only unsigned receipt")
    original_request_binding = normal_draft.get("executionRequest")
    if (
        state.get("link") is None
        or state["draft"]["recoveryClass"] != RECEIPT_ONLY
        or request["verb"] != "seal-recovery-receipt"
        or request["expectedOutputPath"] != str(receipt_path)
        or request["predecessorSha256"] != sha256_file(paths["linkAttestation"])
        or request["subject"].get("recoveryOrdinal") != 1
        or not isinstance(original_request_binding, dict)
    ):
        raise ValueError("receipt-only executor recovery request changed")
    trust = protocol["executionTrust"]
    return seal_receipt_only_recovery(
        authorization_path,
        draft_path,
        paths["executionDraft"],
        paths["incident"],
        paths["link"],
        issuer_public_key_path=role_public_key_path(trust, "issuer"),
        analysis_authorizer_public_key_path=role_public_key_path(
            trust, "analysis-authorizer"
        ),
        guardian_public_key_path=role_public_key_path(trust, "guardian"),
        executor_public_key_path=role_public_key_path(trust, "executor"),
        executor_private_key_fd=key_fd,
        execution_request_binding=original_request_binding,
    )


def _prepare_receipt_only_recovery_seal(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> Path:
    authorization_path = Path(request["subject"]["authorizationPath"]).resolve()
    signed = read_json_object(authorization_path, "receipt-only authorization")
    if signed.get("kind") not in RECOVERY_ELIGIBLE_KINDS:
        raise ValueError("receipt-only recovery is forbidden for this authorization kind")
    original = verify_signed_payload(
        signed,
        expected_role="issuer",
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "issuer"
        ),
    )
    paths = recovery_paths(original)
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=original,
    )
    receipt_path = Path(original["ledger"]["receiptPath"])
    draft_path = unsigned_receipt_path(receipt_path)
    draft = read_json_object(draft_path, "receipt-only unsigned receipt")
    if (
        state.get("link") is None
        or state["draft"]["recoveryClass"] != RECEIPT_ONLY
        or draft.get("valid") is not True
        or request["verb"] != "seal-recovery-receipt"
        or request["expectedOutputPath"] != str(receipt_path)
        or request["predecessorSha256"] != sha256_file(paths["linkAttestation"])
        or request["subject"].get("recoveryOrdinal") != 1
    ):
        raise ValueError("receipt-only executor recovery request changed")
    return draft_path


def _attest_recovery_completion(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    authorization_path, original = _load_original_recovery_authorization(
        protocol_path, protocol, request
    )
    paths = recovery_paths(original)
    state = validate_recovery_state(
        protocol_path=protocol_path,
        protocol=protocol,
        authorization_path=authorization_path,
        authorization=original,
    )
    recovery_class = state["draft"]["recoveryClass"]
    completed_path = (
        authorization_path
        if recovery_class == RECEIPT_ONLY
        else paths["replacementAuthorization"]
    )
    completed = (
        original if recovery_class == RECEIPT_ONLY else state["replacementAuthorization"]
    )
    if completed is None:
        raise ValueError("recovery completion lacks its execution authorization")
    receipt_path, _ = validate_completed_execution(
        authorization_path=completed_path,
        authorization=completed,
        protocol=protocol,
    )
    if (
        request["verb"] != "attest-recovery-completion"
        or request["expectedOutputPath"] != str(paths["completion"])
        or request["predecessorSha256"] != sha256_file(paths["linkAttestation"])
        or request["subject"].get("recoveryClass") != recovery_class
        or request["subject"].get("recoveryOrdinal") != 1
        or request["subject"].get("executionReceipt")
        != {"path": str(receipt_path), "sha256": sha256_file(receipt_path)}
    ):
        raise ValueError("recovery completion guardian request changed")
    payload = {
        "schemaVersion": LOGICAL_COMPLETION_SCHEMA,
        "phase": "completion",
        "valid": True,
        "immutable": True,
        "outcomeBlind": True,
        "outcomesInspected": False,
        "promotionEligible": False,
        "campaignId": original["campaignId"],
        "kind": original["kind"],
        "originalTokenId": original["tokenId"],
        "recoveryTokenId": state["link"]["recoveryTokenId"],
        "recoveryClass": recovery_class,
        "attemptOrdinal": 1,
        "incidentAttestation": {
            "path": str(paths["incidentAttestation"]),
            "sha256": sha256_file(paths["incidentAttestation"]),
        },
        "linkAttestation": {
            "path": str(paths["linkAttestation"]),
            "sha256": sha256_file(paths["linkAttestation"]),
        },
        "completedAuthorization": {
            "path": str(completed_path),
            "sha256": sha256_file(completed_path),
        },
        "executionReceipt": {
            "path": str(receipt_path),
            "sha256": sha256_file(receipt_path),
        },
        "completedAtUtc": utc_now(),
        "secondRecoveryForbidden": True,
        "request": request_binding,
    }
    return _prepared_artifacts(
        required_role="guardian",
        output=paths["completion"],
        protocol=protocol,
        artifacts=[(paths["completion"], payload, "guardian")],
    )


def _attest_preflight(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    output = preflight_path(protocol_path, protocol)
    start_path = preflight_start_path(protocol_path, protocol)
    start = read_json_object(start_path, "P30 preflight start")
    if (
        request["verb"] != "attest-preflight"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] is not None
        or start.get("outcomesInspected") is not False
    ):
        raise ValueError("preflight guardian request changed")
    receipts = []
    incremental = 0
    maximum_seconds = 0.0
    for arm in ARMS:
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
        receipt_path, receipt = validate_completed_execution(
            authorization_path=authorization_path,
            authorization=authorization,
            protocol=protocol,
        )
        receipts.append(
            {"arm": arm, "path": str(receipt_path), "sha256": sha256_file(receipt_path)}
        )
        maximum_seconds = max(maximum_seconds, elapsed_seconds(receipt))
        incremental += sum(
            int(receipt["artifacts"][label]["bytes"])
            for label, entry in authorization["outputs"].items()
            if entry["mustBeAbsentAtStart"]
        )
    training_projection = (
        incremental
        * len(REPLICATES)
        * protocol["seedSchedule"]["maxGeneration"]
        * 5
        // 4
    )
    projected = training_projection + EVALUATION_RESERVE_BYTES
    projected_compute = (
        maximum_seconds
        * len(REPLICATES)
        * len(ARMS)
        * protocol["seedSchedule"]["maxGeneration"]
    )
    final_free = disk_free(Path("/data/share8"))
    finished = utc_now()
    elapsed = (_parse_utc(finished) - _parse_utc(start["startedAtUtc"])).total_seconds()
    payload = {
        "schemaVersion": PREFLIGHT_SCHEMA,
        "valid": final_free - projected >= DISK_FLOOR_BYTES
        and projected_compute <= protocol["runtime"]["maxCampaignComputeSeconds"],
        "promotionEligible": False,
        "outcomesInspected": False,
        "protocolSha256": sha256(protocol_path),
        "startedAtUtc": start["startedAtUtc"],
        "finishedAtUtc": finished,
        "elapsedSeconds": elapsed,
        "initialFreeBytes": start["initialFreeBytes"],
        "finalFreeBytes": final_free,
        "threeRootIncrementalBytes": incremental,
        "projectedCampaignBytesConservative": projected,
        "projectedTrainingBytesWith25PercentSafety": training_projection,
        "evaluationReserveBytes": EVALUATION_RESERVE_BYTES,
        "diskFloorBytes": DISK_FLOOR_BYTES,
        "maximumObservedRootSeconds": maximum_seconds,
        "projectedCampaignComputeSeconds": projected_compute,
        "maxCampaignComputeSeconds": protocol["runtime"]["maxCampaignComputeSeconds"],
        "projectedFinalFreeBytes": final_free - projected,
        "receipts": receipts,
        "diagnosticCodes": [
            "THREE_MATCHED_ARMS_GEN1_COMPLETE",
            "DISK_PROJECTION_COMPLETE",
        ],
        "request": request_binding,
    }
    if payload["valid"] is not True:
        raise RuntimeError("guardian preflight projection failed before signing")
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _attest_phase0_readiness(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    output = phase0_readiness_path(protocol)
    if (
        request["verb"] != "attest-phase0-readiness"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] is not None
    ):
        raise ValueError("phase-zero readiness request changed")
    inputs = phase0_review_inputs(protocol_path, protocol)
    reports: dict[str, dict[str, Any]] = {}
    for name in PHASE0_NAMES:
        report_path = phase0_output_root(protocol, name) / "report.json"
        report = read_json_object(report_path, f"P30 {name} report")
        if (
            report.get("schemaVersion") != PHASE0_REPORT_SCHEMAS[name]
            or report.get("valid") is not True
            or report.get("promotionEligible") is not False
            or report.get("outcomesInspected") is not False
        ):
            raise ValueError(f"P30 {name} Phase 0 report is invalid")
        reports[name] = report
    fault_checks = reports["fault-injection"].get("checks")
    if (
        not isinstance(fault_checks, list)
        or len(fault_checks) != 11
        or not all(
            isinstance(check, dict) and check.get("passed") is True
            for check in fault_checks
        )
    ):
        raise ValueError("P30 CPU fault matrix is incomplete")
    validate_analyzer_rehearsal_report(
        report=reports["analyzer-rehearsal"],
        protocol_path=protocol_path,
        protocol=protocol,
    )
    cuda = reports["cuda-determinism"]
    if (
        cuda.get("games") != protocol["seedSchedule"]["commonPublicGames"]
        or cuda.get("workers") != protocol["training"]["workers"]
        or cuda.get("freshServerSocketsDistinct") is not True
        or cuda.get("diagnosticCodes")
        != [
            "FRESH_CUDA_SERVERS",
            "EXACT_PER_GAME_MATCH",
            "EXACT_REPLAY_HASH_MATCH",
            "PRODUCTION_BATCH_AND_CONCURRENCY_MATCH",
        ]
    ):
        raise ValueError("P30 exact CUDA determinism evidence changed")
    primary = read_json_object(
        phase0_output_root(protocol, "cuda-determinism")
        / "primary/report.json",
        "P30 CUDA primary report",
    )
    replay = read_json_object(
        phase0_output_root(protocol, "cuda-determinism")
        / "replay/report.json",
        "P30 CUDA replay report",
    )
    primary_games = primary.get("perGame")
    primary_replays = primary.get("replayHashes")
    if (
        not isinstance(primary_games, list)
        or len(primary_games) != cuda["games"]
        or primary_games != replay.get("perGame")
        or not isinstance(primary_replays, list)
        or primary_replays != replay.get("replayHashes")
        or sha256_bytes(canonical_json(primary_games)) != cuda.get("perGameSha256")
        or sha256_bytes(canonical_json(primary_replays))
        != cuda.get("replayHashesSha256")
    ):
        raise ValueError("P30 guardian CUDA replay comparison failed")
    review_path = gate_review_paths(protocol, "phase0-runtime")["receipt"]
    validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="phase0-runtime",
        required_inputs=inputs,
    )
    payload = {
        "schemaVersion": PHASE0_READINESS_SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "protocolSha256": sha256(protocol_path),
        "sourceContractSha256": protocol["sourceContract"]["sha256"],
        "preflightEvidence": inputs[3:],
        "runtimeReview": phase0_binding(review_path),
        "diagnosticCodes": [
            "CPU_FAULT_MATRIX_PASS",
            "ANALYZER_REHEARSAL_PASS",
            "CUDA_PRIMARY_REPLAY_EXACT",
            "INDEPENDENT_RUNTIME_AUDIT_ACCEPT",
        ],
        "request": request_binding,
    }
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _authorize_full_campaign(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    output = full_campaign_authorization_path(protocol)
    preflight = preflight_path(protocol_path, protocol)
    if (
        request["verb"] != "authorize-full-campaign"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] != sha256_file(preflight)
    ):
        raise ValueError("full-campaign authorization request changed")
    require_phase0_readiness(protocol_path, protocol)
    require_preflight(protocol_path, protocol)
    inputs = full_campaign_review_inputs(protocol_path, protocol)
    review_path = gate_review_paths(protocol, "full-campaign")["receipt"]
    validate_gate_review_receipt(
        protocol=protocol,
        protocol_path=protocol_path,
        mode="full-campaign",
        required_inputs=inputs,
    )
    payload = {
        "schemaVersion": FULL_CAMPAIGN_AUTHORIZATION_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "protocolSha256": sha256(protocol_path),
        "phase0Readiness": phase0_binding(phase0_readiness_path(protocol)),
        "generationOnePreflight": phase0_binding(preflight),
        "review": phase0_binding(review_path),
        "diagnosticCodes": [
            "PHASE0_READINESS_VALID",
            "GENERATION_ONE_PREFLIGHT_VALID",
            "FULL_CAMPAIGN_FABLE_ACCEPT",
        ],
        "request": request_binding,
    }
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _attest_final_barrier(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    output = final_barrier_path(protocol)
    if (
        request["verb"] != "attest-final-barrier"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] is not None
    ):
        raise ValueError("final-barrier guardian request changed")
    endpoints = []
    maximum = protocol["seedSchedule"]["maxGeneration"]
    for replicate in REPLICATES:
        for arm in ARMS:
            authorization_path = generation_authorization_path(
                ledger_for(protocol), replicate, arm, maximum
            )
            predecessor = predecessor_for_generation(
                protocol_path, protocol, replicate, arm, maximum
            )
            authorization = validate_stored_authorization(
                authorization_path=authorization_path,
                protocol_path=protocol_path,
                kind="generation",
                root=root_for(replicate, arm),
                replicate=replicate,
                arm=arm,
                generation=maximum,
                predecessor=predecessor,
            )
            receipt_path, _ = validate_completed_execution(
                authorization_path=authorization_path,
                authorization=authorization,
                protocol=protocol,
            )
            root = root_for(replicate, arm)
            endpoints.append(
                {
                    "label": endpoint_label(replicate, arm),
                    "finalReceipt": {
                        "path": str(receipt_path),
                        "sha256": sha256_file(receipt_path),
                    },
                    "finalAuditSha256": sha256_file(
                        root / "artifacts" / f"gen{maximum}-audit.json"
                    ),
                    "finalCheckpointSha256": sha256_file(
                        root / "checkpoints" / f"main-0-gen{maximum}.pt"
                    ),
                }
            )
    payload = {
        "schemaVersion": FINAL_BARRIER_SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "issuedAtUtc": utc_now(),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "endpointCount": len(endpoints),
        "endpoints": endpoints,
        "diagnosticCodes": ["ALL_FINAL_GENERATION_CHAINS_COMPLETE"],
        "request": request_binding,
    }
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _attest_pair(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    subject = request["subject"]
    primary = Path(subject["primaryReceipt"]).resolve()
    replay = Path(subject["replayReceipt"]).resolve()
    output = pair_path(protocol, subject["replicate"], subject["arm"])
    if (
        request["verb"] != "attest-pair"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] != sha256_file(replay)
    ):
        raise ValueError("pair guardian request changed")
    payload = build_pair_integrity(
        protocol_path=protocol_path,
        public_key_path=role_public_key_path(protocol["executionTrust"], "executor"),
        primary_receipt_path=primary,
        replay_receipt_path=replay,
    )
    if (
        payload["replicate"] != subject["replicate"]
        or payload["arm"] != subject["arm"]
    ):
        raise ValueError("pair guardian subject changed")
    payload["request"] = request_binding
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _attest_analysis_manifest(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    output = analysis_manifest_path(protocol)
    predecessor = pair_path(protocol, REPLICATES[-1], ARMS[-1])
    expected_barrier = {
        "path": str(final_barrier_path(protocol)),
        "sha256": sha256_file(final_barrier_path(protocol)),
    }
    if (
        request["verb"] != "attest-analysis-manifest"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] != sha256_file(predecessor)
        or request["subject"].get("finalGenerationBarrier") != expected_barrier
    ):
        raise ValueError("analysis-manifest guardian request changed")
    payload = build_manifest_payload(
        protocol_path=protocol_path,
        request_binding=request_binding,
    )
    return _prepared_artifacts(
        required_role="guardian",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "guardian")],
    )


def _issue_analysis(
    protocol_path: Path,
    protocol: dict[str, Any],
    request: dict[str, Any],
    request_binding: dict[str, str],
) -> PreparedSigningAction:
    from v35_p30_analysis_review import validate_analysis_review_receipt

    output = analysis_authorization_path(protocol)
    draft_path = analysis_authorization_draft_path(protocol)
    manifest_path = analysis_manifest_path(protocol)
    review_path = analysis_review_receipt_path(protocol)
    if (
        request["verb"] != "issue-analysis"
        or request["expectedOutputPath"] != str(output)
        or request["predecessorSha256"] != sha256_file(manifest_path)
        or request["subject"].get("manifest")
        != {"path": str(manifest_path), "sha256": sha256_file(manifest_path)}
        or request["subject"].get("authorizationDraftPath") != str(draft_path)
        or request["subject"].get("reviewReceiptPath") != str(review_path)
    ):
        raise ValueError("analysis-authorizer request changed")
    review = validate_analysis_review_receipt(
        review_path,
        draft_path=draft_path,
        manifest_path=manifest_path,
        review_attester_public_key_path=role_public_key_path(
            protocol["executionTrust"], "review-attester"
        ),
    )
    reviewed = read_json_object(draft_path, "reviewed analysis authorization draft")
    if reviewed.get("request") != request_binding or reviewed.get("kind") != "analysis":
        raise ValueError("reviewed analysis authorization draft changed")
    payload = rebind_reviewed_analysis_authorization_times(
        reviewed,
        review_finished_at_utc=review["finishedAtUtc"],
        now=dt.datetime.now(dt.timezone.utc),
    )
    validate_reviewed_analysis_authorization_rebinding(
        reviewed,
        payload,
        review_finished_at_utc=review["finishedAtUtc"],
    )
    return _prepared_artifacts(
        required_role="analysis-authorizer",
        output=output,
        protocol=protocol,
        artifacts=[(output, payload, "analysis-authorizer")],
    )


@serialized_role_action
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument(
        "--expected-role",
        choices=("issuer", "executor", "guardian", "analysis-authorizer"),
        required=True,
    )
    args = parser.parse_args()
    protocol_path = args.protocol.resolve()
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_frozen_source(protocol)
    request, binding = load_request(
        args.request,
        protocol_path=protocol_path,
        protocol=protocol,
        expected_role=args.expected_role,
    )
    if canonical_json(next_action(protocol_path)) != canonical_json(request):
        raise ValueError("P30 role request is not the scheduler's exact next action")
    verb = request["verb"]
    role_for_verb = {
        "issue-generation": "issuer",
        "issue-preflight-execution": "issuer",
        "issue-evaluation": "issuer",
        "issue-recovery": "issuer",
        "execute": "executor",
        "execute-recovery": "executor",
        "seal-recovery-receipt": "executor",
        "attest-recovery-incident": "guardian",
        "attest-recovery-link": "guardian",
        "attest-recovery-completion": "guardian",
        "attest-preflight": "guardian",
        "attest-phase0-readiness": "guardian",
        "authorize-full-campaign": "guardian",
        "attest-final-barrier": "guardian",
        "attest-pair": "guardian",
        "attest-analysis-manifest": "guardian",
        "issue-analysis": "analysis-authorizer",
    }
    if role_for_verb.get(verb) != args.expected_role:
        raise ValueError("P30 role request verb is not allowed for this key")
    action_id = binding["sha256"]
    if args.expected_role != "executor":
        requested_output = Path(request["expectedOutputPath"])
        if _entry_exists(signing_attempt_path(requested_output)):
            raise RuntimeError(
                "non-executor signing action was already attempted and is terminally closed"
            )
    launch_permit_challenge: dict[str, Any] | None = None
    if verb in {"execute", "execute-recovery"}:
        authorization_path = Path(request["subject"]["authorizationPath"]).resolve()
        signed_authorization = read_json_object(
            authorization_path, "executor launch-permit authorization"
        )
        existing_draft = unsigned_receipt_path(
            Path(signed_authorization["ledger"]["receiptPath"])
        )
        if not existing_draft.exists():
            launch_permit_challenge = build_executor_launch_permit_payload(
                protocol_path=protocol_path,
                protocol=protocol,
                request=request,
                request_binding=binding,
                authorization_path=authorization_path,
            )
    print(
        json.dumps(
            {
                "schemaVersion": "arc-v35-p30-role-ready-v1",
                "actionId": action_id,
                "protocolSha256": sha256(protocol_path),
                "sourceContractSha256": protocol["sourceContract"]["sha256"],
                "requiredRole": args.expected_role,
                "actionVerb": verb,
                "launchPermitChallenge": launch_permit_challenge,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    launch_permit_path: Path | None = None
    if launch_permit_challenge is not None:
        signed_permit = receive_signed_launch_permit()
        launch_permit_path = persist_executor_launch_permit(
            signed_permit,
            expected_payload=launch_permit_challenge,
            protocol=protocol,
        )
    if verb == "execute":
        draft_path = _prepare_execution(
            protocol, request, binding, launch_permit_path
        )
        draft = read_json_object(draft_path, "unsigned execution receipt")
        if draft.get("valid") is not True:
            raise RuntimeError(
                "unsigned execution failure requires guardian recovery or campaign closure"
            )
        print(
            json.dumps(
                {
                    "schemaVersion": "arc-v35-p30-executor-sign-ready-v1",
                    "actionId": action_id,
                    "requiredRole": "executor",
                    "unsignedDraft": {
                        "path": str(draft_path),
                        "sha256": sha256_file(draft_path),
                    },
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        with receive_private_key() as key_fd:
            output = _seal_execution(
                protocol, request, binding, draft_path, key_fd
            )
    elif verb == "execute-recovery":
        draft_path = _prepare_pre_child_execution(
            protocol_path, protocol, request, binding, launch_permit_path
        )
        draft = read_json_object(draft_path, "PRE_CHILD unsigned execution receipt")
        if draft.get("valid") is not True:
            raise RuntimeError("PRE_CHILD recovery execution is terminally invalid")
        print(
            json.dumps(
                {
                    "schemaVersion": "arc-v35-p30-executor-sign-ready-v1",
                    "actionId": action_id,
                    "requiredRole": "executor",
                    "unsignedDraft": {
                        "path": str(draft_path),
                        "sha256": sha256_file(draft_path),
                    },
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        with receive_private_key() as key_fd:
            output = _seal_pre_child_execution(
                protocol_path,
                protocol,
                request,
                binding,
                draft_path,
                key_fd,
            )
    elif verb == "seal-recovery-receipt":
        draft_path = _prepare_receipt_only_recovery_seal(
            protocol_path, protocol, request, binding
        )
        print(
            json.dumps(
                {
                    "schemaVersion": "arc-v35-p30-executor-sign-ready-v1",
                    "actionId": action_id,
                    "requiredRole": "executor",
                    "unsignedDraft": {
                        "path": str(draft_path),
                        "sha256": sha256_file(draft_path),
                    },
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        with receive_private_key() as key_fd:
            output = _seal_recovery_receipt(
                protocol_path, protocol, request, binding, key_fd
            )
    else:
        if verb == "issue-generation":
            prepared = _issue_generation(protocol_path, protocol, request, binding)
        elif verb == "issue-preflight-execution":
            prepared = _issue_preflight_execution(
                protocol_path, protocol, request, binding
            )
        elif verb == "issue-evaluation":
            prepared = _issue_evaluation(protocol_path, protocol, request, binding)
        elif verb == "issue-recovery":
            prepared = _issue_pre_child_recovery(
                protocol_path, protocol, request, binding
            )
        elif verb == "issue-analysis":
            prepared = _issue_analysis(protocol_path, protocol, request, binding)
        elif verb == "attest-preflight":
            prepared = _attest_preflight(protocol_path, protocol, request, binding)
        elif verb == "attest-phase0-readiness":
            prepared = _attest_phase0_readiness(
                protocol_path, protocol, request, binding
            )
        elif verb == "authorize-full-campaign":
            prepared = _authorize_full_campaign(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-final-barrier":
            prepared = _attest_final_barrier(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-analysis-manifest":
            prepared = _attest_analysis_manifest(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-recovery-incident":
            prepared = _attest_recovery_incident(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-recovery-link":
            prepared = _attest_recovery_link(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-recovery-completion":
            prepared = _attest_recovery_completion(
                protocol_path, protocol, request, binding
            )
        elif verb == "attest-pair":
            prepared = _attest_pair(protocol_path, protocol, request, binding)
        else:
            raise ValueError("P30 role verb has no implementation")
        expected_output = Path(request["expectedOutputPath"])
        if (
            prepared.required_role != args.expected_role
            or prepared.output != expected_output
        ):
            raise RuntimeError("P30 prepared signing action changed its role or output")
        reservation = prepared.reserve(action_id)
        print(
            json.dumps(
                {
                    "schemaVersion": SIGN_READY_SCHEMA,
                    "actionId": action_id,
                    "requiredRole": args.expected_role,
                    "expectedOutputPath": str(prepared.output),
                    "unsignedSigningPlan": reservation.plan_binding,
                    "attemptMarker": reservation.marker_binding,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        with receive_private_key() as key_fd:
            output = prepared.seal(key_fd, reservation)
    if output != Path(request["expectedOutputPath"]):
        raise RuntimeError("P30 role action produced an unexpected artifact path")
    print(
        json.dumps(
            {
                "schemaVersion": "arc-v35-p30-role-result-v1",
                "actionId": action_id,
                "artifact": {"path": str(output), "sha256": sha256_file(output)},
                "stateAdvanced": True,
                "promotionEligible": False,
                "outcomesInspected": False,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
