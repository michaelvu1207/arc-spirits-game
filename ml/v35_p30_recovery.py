#!/usr/bin/env python3
"""Fail-closed, outcome-blind recovery contracts for the V35 P30 campaign.

This module intentionally implements only the two recovery classes that can be
proved from the outer execution supervisor's evidence:

* PRE_CHILD: the candidate never started and therefore consumed no game seed;
* RECEIPT_ONLY: candidate execution finished exactly once and only evidence
  sealing may be repeated.

The functions are validators, not a recovery scheduler.  In particular, they
do not issue authorizations, move artifacts, expose logs, or execute candidate
code.  Callers must validate the original and replacement execution
authorizations with ``validate_authorization`` before passing them here.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    read_regular_nofollow,
    regular_file_evidence,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)


EXECUTION_DRAFT_SCHEMA = "arc-v35-p30-recovery-execution-draft-v1"
GUARDIAN_INCIDENT_SCHEMA = "arc-v35-p30-recovery-incident-v1"
RECOVERY_LINK_SCHEMA = "arc-v35-p30-recovery-link-v1"
PROTECTED_BINDINGS_SCHEMA = "arc-v35-p30-recovery-protected-bindings-v1"

PRE_CHILD = "PRE_CHILD"
RECEIPT_ONLY = "RECEIPT_ONLY"
RECOVERY_CLASSES = frozenset({PRE_CHILD, RECEIPT_ONLY})

# These codes are deliberately narrow and carry no free-form diagnostic data.
# A code describes the supervisor boundary that failed; it must never encode a
# metric, score, candidate ranking, game result, or optimizer feedback.
PRE_CHILD_DIAGNOSTIC_CODES = frozenset(
    {
        "GPU7_PRECHECK_FAILED",
        "LEASE_ACQUISITION_FAILED",
        "OUTPUT_OPEN_FAILED",
        "PROCESS_SPAWN_FAILED",
        "SUPERVISOR_INTERRUPTED_PRE_CHILD",
    }
)
RECEIPT_ONLY_DIAGNOSTIC_CODES = frozenset(
    {
        "RECEIPT_PERSISTENCE_FAILED",
        "RECEIPT_SIGNATURE_FAILED",
    }
)
DIAGNOSTIC_CODES = {
    PRE_CHILD: PRE_CHILD_DIAGNOSTIC_CODES,
    RECEIPT_ONLY: RECEIPT_ONLY_DIAGNOSTIC_CODES,
}

PRE_CHILD_ACTION = "IDENTICAL_SEED_RERUN"
RECEIPT_ONLY_ACTION = "SEAL_SUPPLEMENTAL_RECEIPT"
ACTIONS = {
    PRE_CHILD: PRE_CHILD_ACTION,
    RECEIPT_ONLY: RECEIPT_ONLY_ACTION,
}

TOKEN_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SHA256_PATTERN = TOKEN_PATTERN
RECOVERY_ELIGIBLE_KINDS = (
    "generation",
    "evaluation-primary",
    "evaluation-replay",
)
ALLOWED_KINDS = frozenset(RECOVERY_ELIGIBLE_KINDS)
RECOVERY_DRAFT_SUFFIX = ".recovery-draft.json"


def require_recovery_eligible_kind(authorization: Mapping[str, Any]) -> str:
    kind = authorization.get("kind")
    if kind not in ALLOWED_KINDS:
        raise RuntimeError(
            f"P30 {kind!r} execution has no recovery path; the campaign lane is terminally closed"
        )
    return str(kind)


def _exact_keys(value: Any, expected: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} keys changed")
    return value


def _parse_utc(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{label} is not an ISO-8601 UTC instant")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{label} is not an ISO-8601 UTC instant") from exc
    if parsed.tzinfo != dt.timezone.utc:
        raise ValueError(f"{label} is not UTC")
    return parsed


def _unsigned(value: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(value)
    result.pop("signature", None)
    return result


def _sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise ValueError(f"{label} is not a lowercase SHA-256 digest")
    return value


def _token(value: Any, label: str) -> str:
    if not isinstance(value, str) or not TOKEN_PATTERN.fullmatch(value):
        raise ValueError(f"{label} is not a 256-bit lowercase token")
    return value


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is not canonical JSON-compatible data") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _file_binding(
    value: Any, label: str, *, expected_path: Path | None = None
) -> Mapping[str, Any]:
    binding = _exact_keys(value, {"path", "sha256"}, label)
    if not isinstance(binding["path"], str):
        raise ValueError(f"{label} path is not a string")
    path = Path(binding["path"])
    if not path.is_absolute():
        raise ValueError(f"{label} path is not absolute")
    digest = _sha256(binding["sha256"], f"{label} digest")
    if expected_path is not None and path != expected_path:
        raise ValueError(f"{label} path changed")
    if sha256_file(path) != digest:
        raise ValueError(f"{label} is missing or hash-invalid")
    return binding


def _normalize_token_bound(value: Any, token_id: str) -> Any:
    """Normalize only the exact old token inside otherwise immutable bindings."""

    if isinstance(value, str):
        return value.replace(token_id, "{RECOVERY_TOKEN}")
    if isinstance(value, list):
        return [_normalize_token_bound(item, token_id) for item in value]
    if isinstance(value, dict):
        return {
            key: _normalize_token_bound(item, token_id)
            for key, item in sorted(value.items())
        }
    return value


def recovery_execution_draft_path(receipt_path: Path) -> Path:
    return receipt_path.with_name(receipt_path.name + RECOVERY_DRAFT_SUFFIX)


def recovery_protected_bindings(authorization: Mapping[str, Any]) -> dict[str, Any]:
    """Return the immutable, token-normalized identity of one execution.

    Token normalization permits a fresh one-shot token and token-namespaced
    socket/output/ledger paths.  It does not permit any other command,
    isolation, output, source, protocol, seed, config, or checkpoint change.
    """

    payload = _unsigned(authorization)
    token_id = _token(payload.get("tokenId"), "authorization token")
    required = {
        "campaignId",
        "kind",
        "protocol",
        "sourceContract",
        "subject",
        "command",
        "isolation",
        "outputs",
        "ledger",
        "predecessor",
    }
    if not required.issubset(payload):
        raise ValueError("authorization lacks recovery-protected bindings")
    exact = {
        "schemaVersion": PROTECTED_BINDINGS_SCHEMA,
        "campaignId": payload["campaignId"],
        "kind": payload["kind"],
        "protocol": payload["protocol"],
        "sourceContract": payload["sourceContract"],
        "subject": payload["subject"],
        "predecessor": payload["predecessor"],
    }
    token_bound = {
        "command": payload["command"],
        "isolation": payload["isolation"],
        "outputs": payload["outputs"],
        "ledger": payload["ledger"],
    }
    if "{RECOVERY_TOKEN}" in json.dumps(
        {**exact, **token_bound}, sort_keys=True, ensure_ascii=False
    ):
        raise ValueError("authorization contains the reserved recovery-token sentinel")
    # Protocol/source/subject/predecessor are exact.  Only the structures that
    # legitimately carry a one-shot token namespace may be normalized.
    return {**exact, **_normalize_token_bound(token_bound, token_id)}


def protected_bindings_sha256(authorization: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json(recovery_protected_bindings(authorization)))


def _validate_authorization_binding(
    draft: Mapping[str, Any], authorization: Mapping[str, Any]
) -> tuple[dict[str, Any], str]:
    payload = _unsigned(authorization)
    binding = _file_binding(draft["authorization"], "original authorization")
    bound_path = Path(binding["path"])
    stored = _load_json(bound_path, "original authorization")
    if _unsigned(stored) != payload:
        raise ValueError("original authorization argument differs from its file")
    return payload, str(binding["sha256"])


def _validate_consumed_marker(
    binding_value: Any,
    *,
    token_id: str,
    authorization_path: str,
    authorization_sha256: str,
) -> tuple[dict[str, Any], str]:
    binding = _file_binding(binding_value, "consumed marker")
    marker = _load_json(Path(binding["path"]), "consumed marker")
    _exact_keys(
        marker,
        {
            "schemaVersion",
            "tokenId",
            "authorizationPath",
            "authorizationSha256",
            "consumedAtUtc",
            "consumerPid",
            "host",
            "bootId",
        },
        "consumed marker",
    )
    if (
        marker.get("schemaVersion") != "arc-v35-p30-consumed-token-v1"
        or marker.get("tokenId") != token_id
        or marker.get("authorizationPath") != authorization_path
        or marker.get("authorizationSha256") != authorization_sha256
        or type(marker.get("consumerPid")) is not int
        or marker["consumerPid"] <= 0
        or not isinstance(marker.get("host"), str)
        or not marker["host"]
        or not isinstance(marker.get("bootId"), str)
        or not marker["bootId"]
    ):
        raise ValueError("consumed marker identity changed")
    _parse_utc(marker["consumedAtUtc"], "consumed marker time")
    return marker, str(binding["sha256"])


def _validate_artifacts(
    artifacts_value: Any, authorization: Mapping[str, Any]
) -> tuple[dict[str, Mapping[str, Any]], list[str]]:
    outputs = authorization.get("outputs")
    if not isinstance(outputs, dict) or not outputs:
        raise ValueError("authorization output registry is empty")
    if not isinstance(artifacts_value, dict):
        raise ValueError("execution draft artifacts must be an object")
    if not set(artifacts_value).issubset(outputs):
        raise ValueError("execution draft contains an unauthorized artifact")
    observed: dict[str, Mapping[str, Any]] = {}
    missing: list[str] = []
    for label, output in sorted(outputs.items()):
        _exact_keys(
            output,
            {"path", "required", "mustBeAbsentAtStart"},
            f"authorized output {label}",
        )
        path = Path(output["path"])
        if not path.is_absolute() or type(output["required"]) is not bool:
            raise ValueError(f"authorized output {label} is malformed")
        try:
            evidence = regular_file_evidence(path)
        except (FileNotFoundError, OSError, ValueError):
            if output["required"]:
                missing.append(label)
            if label in artifacts_value:
                raise ValueError(f"artifact {label} is recorded but unavailable")
            continue
        if label not in artifacts_value:
            raise ValueError(f"existing authorized artifact {label} was omitted")
        record = _exact_keys(
            artifacts_value[label], {"path", "sha256", "bytes"}, f"artifact {label}"
        )
        if (
            record["path"] != str(path)
            or _sha256(record["sha256"], f"artifact {label} digest")
            != evidence["sha256"]
            or type(record["bytes"]) is not int
            or record["bytes"] < 0
            or record["bytes"] != evidence["bytes"]
        ):
            raise ValueError(f"artifact {label} evidence changed")
        observed[label] = record
    return observed, missing


def _draft_identity(
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    consumed_path: Path,
    recovery_class: str,
    diagnostic_code: str,
    started_at_utc: str,
    finished_at_utc: str,
    process: Mapping[str, Any],
    gpu: Mapping[str, Any],
    missing_required_outputs: list[str],
    artifacts: Mapping[str, Any],
    unsigned_receipt: Mapping[str, str] | None,
    normal_seal_attempt: Mapping[str, str] | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": EXECUTION_DRAFT_SCHEMA,
        "immutable": True,
        "promotionEligible": False,
        "outcomesExposed": False,
        "recoveryClass": recovery_class,
        "diagnosticCode": diagnostic_code,
        "kind": authorization["kind"],
        "tokenId": authorization["tokenId"],
        "campaignId": authorization["campaignId"],
        "authorization": {
            "path": str(authorization_path.resolve()),
            "sha256": sha256_file(authorization_path),
        },
        "consumedMarker": {
            "path": str(consumed_path.resolve()),
            "sha256": sha256_file(consumed_path),
        },
        "unsignedReceipt": None if unsigned_receipt is None else dict(unsigned_receipt),
        "normalSealAttempt": (
            None if normal_seal_attempt is None else dict(normal_seal_attempt)
        ),
        "startedAtUtc": started_at_utc,
        "finishedAtUtc": finished_at_utc,
        "subjectSha256": sha256_bytes(canonical_json(authorization["subject"])),
        "commandSha256": sha256_bytes(canonical_json(authorization["command"])),
        "isolationSha256": sha256_bytes(canonical_json(authorization["isolation"])),
        "process": dict(process),
        "gpu": dict(gpu),
        "missingRequiredOutputs": list(missing_required_outputs),
        "artifacts": dict(artifacts),
    }


def persist_pre_child_recovery_draft(
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    consumed_path: Path,
    diagnostic_code: str,
    started_at_utc: str,
    finished_at_utc: str,
    gpu_empty_after: bool,
    lease_released: bool,
) -> Path:
    """Persist the only canonical PRE_CHILD claim.

    This routine is intentionally unusable once ``Popen`` has been entered.
    Every authorized output must still be absent, so no result-bearing or even
    diagnostic output can be mistaken for proof that candidate code did not
    start.
    """

    require_recovery_eligible_kind(authorization)
    if diagnostic_code not in PRE_CHILD_DIAGNOSTIC_CODES:
        raise ValueError("PRE_CHILD diagnostic code is not allowlisted")
    outputs = authorization.get("outputs")
    if not isinstance(outputs, dict) or not outputs:
        raise ValueError("authorization output registry is empty")
    if any(os.path.lexists(entry["path"]) for entry in outputs.values()):
        raise RuntimeError("PRE_CHILD is ambiguous because an authorized output exists")
    required_missing = sorted(
        label for label, entry in outputs.items() if entry.get("required") is True
    )
    draft = _draft_identity(
        authorization_path=authorization_path,
        authorization=authorization,
        consumed_path=consumed_path,
        recovery_class=PRE_CHILD,
        diagnostic_code=diagnostic_code,
        started_at_utc=started_at_utc,
        finished_at_utc=finished_at_utc,
        process={
            "spawnCallEntered": False,
            "childStarted": False,
            "pid": None,
            "exitCode": 125,
            "noSupervisorChildRemaining": True,
            "seedConsumed": False,
        },
        gpu={
            "mode": authorization["isolation"]["gpuMode"],
            "emptyAfter": gpu_empty_after,
            "leaseReleased": lease_released,
        },
        missing_required_outputs=required_missing,
        artifacts={},
        unsigned_receipt=None,
        normal_seal_attempt=None,
    )
    validate_execution_draft(draft, authorization=authorization)
    path = recovery_execution_draft_path(Path(authorization["ledger"]["receiptPath"]))
    if path.exists():
        if _load_json(path, "PRE_CHILD recovery draft") != draft:
            raise RuntimeError("a different recovery draft already exists")
        return path
    atomic_write_exclusive(path, canonical_json(draft) + b"\n")
    return path


def persist_receipt_only_recovery_draft(
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    consumed_path: Path,
    unsigned_receipt_path: Path,
    unsigned_receipt: Mapping[str, Any],
    normal_seal_attempt_path: Path,
    diagnostic_code: str,
) -> Path:
    """Bind a completed unsigned receipt to its failed normal sealing attempt."""

    require_recovery_eligible_kind(authorization)
    if diagnostic_code not in RECEIPT_ONLY_DIAGNOSTIC_CODES:
        raise ValueError("RECEIPT_ONLY diagnostic code is not allowlisted")
    unsigned_binding = {
        "path": str(unsigned_receipt_path.resolve()),
        "sha256": sha256_file(unsigned_receipt_path),
    }
    seal_binding = {
        "path": str(normal_seal_attempt_path.resolve()),
        "sha256": sha256_file(normal_seal_attempt_path),
    }
    process_record = unsigned_receipt.get("process")
    pid = process_record.get("pid") if isinstance(process_record, dict) else None
    draft = _draft_identity(
        authorization_path=authorization_path,
        authorization=authorization,
        consumed_path=consumed_path,
        recovery_class=RECEIPT_ONLY,
        diagnostic_code=diagnostic_code,
        started_at_utc=str(unsigned_receipt.get("startedAtUtc")),
        finished_at_utc=str(unsigned_receipt.get("finishedAtUtc")),
        process={
            "spawnCallEntered": True,
            "childStarted": True,
            "pid": pid,
            "exitCode": unsigned_receipt.get("exitCode"),
            "noSupervisorChildRemaining": unsigned_receipt.get(
                "noSupervisorChildRemaining"
            ),
            "seedConsumed": True,
        },
        gpu={
            "mode": authorization["isolation"]["gpuMode"],
            "emptyAfter": unsigned_receipt.get("gpuEmptyAfter"),
            "leaseReleased": unsigned_receipt.get("leaseReleased"),
        },
        missing_required_outputs=list(
            unsigned_receipt.get("missingRequiredOutputs", [])
        ),
        artifacts=dict(unsigned_receipt.get("artifacts", {})),
        unsigned_receipt=unsigned_binding,
        normal_seal_attempt=seal_binding,
    )
    validate_execution_draft(draft, authorization=authorization)
    path = recovery_execution_draft_path(Path(authorization["ledger"]["receiptPath"]))
    if path.exists():
        if _load_json(path, "RECEIPT_ONLY recovery draft") != draft:
            raise RuntimeError("a different recovery draft already exists")
        return path
    atomic_write_exclusive(path, canonical_json(draft) + b"\n")
    return path


def _validate_execution_draft(
    draft: Mapping[str, Any],
    *,
    authorization: Mapping[str, Any],
    allow_sealed_pre_child_output_reuse: bool,
) -> dict[str, Any]:
    """Validate an unsigned executor draft against live immutable artifacts.

    The draft is deliberately unsigned: it is the object the executor intended
    to seal when receipt signing or persistence failed.  It becomes trusted
    only when a guardian validates it and signs ``GUARDIAN_INCIDENT_SCHEMA``.
    """

    require_recovery_eligible_kind(authorization)
    _exact_keys(
        draft,
        {
            "schemaVersion",
            "immutable",
            "promotionEligible",
            "outcomesExposed",
            "recoveryClass",
            "diagnosticCode",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "consumedMarker",
            "unsignedReceipt",
            "normalSealAttempt",
            "startedAtUtc",
            "finishedAtUtc",
            "subjectSha256",
            "commandSha256",
            "isolationSha256",
            "process",
            "gpu",
            "missingRequiredOutputs",
            "artifacts",
        },
        "execution recovery draft",
    )
    recovery_class = draft.get("recoveryClass")
    diagnostic_code = draft.get("diagnosticCode")
    if (
        draft.get("schemaVersion") != EXECUTION_DRAFT_SCHEMA
        or draft.get("immutable") is not True
        or draft.get("promotionEligible") is not False
        or draft.get("outcomesExposed") is not False
        or recovery_class not in RECOVERY_CLASSES
        or diagnostic_code not in DIAGNOSTIC_CODES.get(recovery_class, ())
        or draft.get("kind") not in ALLOWED_KINDS
        or not isinstance(draft.get("campaignId"), str)
        or not draft["campaignId"]
    ):
        raise ValueError("execution recovery draft identity changed")
    token_id = _token(draft.get("tokenId"), "execution draft token")
    auth_payload, authorization_digest = _validate_authorization_binding(
        draft, authorization
    )
    if (
        auth_payload.get("tokenId") != token_id
        or auth_payload.get("kind") != draft["kind"]
        or auth_payload.get("campaignId") != draft["campaignId"]
    ):
        raise ValueError("execution draft differs from its authorization")
    marker, _ = _validate_consumed_marker(
        draft["consumedMarker"],
        token_id=token_id,
        authorization_path=str(Path(draft["authorization"]["path"])),
        authorization_sha256=authorization_digest,
    )
    unsigned_receipt = draft["unsignedReceipt"]
    normal_seal_attempt = draft["normalSealAttempt"]
    if unsigned_receipt is not None:
        unsigned_receipt = _file_binding(unsigned_receipt, "unsigned receipt")
    if normal_seal_attempt is not None:
        normal_seal_attempt = _file_binding(
            normal_seal_attempt, "normal seal-attempt marker"
        )
    started = _parse_utc(draft["startedAtUtc"], "execution start time")
    finished = _parse_utc(draft["finishedAtUtc"], "execution finish time")
    if started != _parse_utc(marker["consumedAtUtc"], "consumed marker time"):
        raise ValueError("execution start differs from token consumption")
    if not started <= finished or finished - started > dt.timedelta(days=14):
        raise ValueError("execution recovery draft duration is invalid")
    expected_hashes = {
        "subjectSha256": sha256_bytes(canonical_json(auth_payload.get("subject"))),
        "commandSha256": sha256_bytes(canonical_json(auth_payload.get("command"))),
        "isolationSha256": sha256_bytes(canonical_json(auth_payload.get("isolation"))),
    }
    for field, expected in expected_hashes.items():
        if _sha256(draft.get(field), field) != expected:
            raise ValueError(f"execution draft {field} differs from authorization")
    process = _exact_keys(
        draft["process"],
        {
            "spawnCallEntered",
            "childStarted",
            "pid",
            "exitCode",
            "noSupervisorChildRemaining",
            "seedConsumed",
        },
        "execution draft process",
    )
    gpu = _exact_keys(
        draft["gpu"], {"mode", "emptyAfter", "leaseReleased"}, "execution draft GPU"
    )
    isolation = auth_payload.get("isolation")
    expected_gpu_mode = isolation.get("gpuMode") if isinstance(isolation, dict) else None
    if (
        gpu.get("mode") != expected_gpu_mode
        or gpu.get("emptyAfter") is not True
        or gpu.get("leaseReleased") is not True
        or process.get("noSupervisorChildRemaining") is not True
    ):
        raise ValueError("execution recovery cleanup is incomplete")
    if allow_sealed_pre_child_output_reuse:
        if recovery_class != PRE_CHILD or draft["artifacts"] != {}:
            raise ValueError("sealed output reuse is valid only for an empty PRE_CHILD draft")
        artifacts: dict[str, Any] = {}
        observed_missing = sorted(
            label
            for label, output in auth_payload["outputs"].items()
            if output["required"] is True
        )
    else:
        artifacts, observed_missing = _validate_artifacts(
            draft["artifacts"], auth_payload
        )
    if (
        not isinstance(draft["missingRequiredOutputs"], list)
        or draft["missingRequiredOutputs"] != sorted(set(draft["missingRequiredOutputs"]))
        or draft["missingRequiredOutputs"] != observed_missing
    ):
        raise ValueError("execution draft missing-output evidence changed")
    if recovery_class == PRE_CHILD:
        if process != {
            "spawnCallEntered": False,
            "childStarted": False,
            "pid": None,
            "exitCode": 125,
            "noSupervisorChildRemaining": True,
            "seedConsumed": False,
        }:
            raise ValueError("PRE_CHILD draft contains child or seed activity")
        required = sorted(
            label
            for label, output in auth_payload["outputs"].items()
            if output["required"] is True
        )
        if (
            artifacts
            or observed_missing != required
            or unsigned_receipt is not None
            or normal_seal_attempt is not None
            or (
                not allow_sealed_pre_child_output_reuse
                and any(
                    os.path.lexists(output["path"])
                    for output in auth_payload["outputs"].values()
                )
            )
        ):
            raise ValueError("PRE_CHILD must have no outputs or sealing evidence")
    else:
        if (
            process.get("spawnCallEntered") is not True
            or process.get("childStarted") is not True
            or type(process.get("pid")) is not int
            or process["pid"] <= 0
            or process.get("exitCode") != 0
            or process.get("seedConsumed") is not True
            or observed_missing
        ):
            raise ValueError("RECEIPT_ONLY draft is not a complete execution")
        required = {
            label
            for label, output in auth_payload["outputs"].items()
            if output["required"] is True
        }
        if not required.issubset(artifacts):
            raise ValueError("RECEIPT_ONLY draft lacks required artifacts")
        if "exitCode" in artifacts and read_regular_nofollow(
            Path(artifacts["exitCode"]["path"]), maximum_bytes=16
        ) != b"0\n":
            raise ValueError("RECEIPT_ONLY exit-code artifact changed")
        if unsigned_receipt is None or normal_seal_attempt is None:
            raise ValueError("RECEIPT_ONLY lacks normal sealing evidence")
    return dict(draft)


def validate_execution_draft(
    draft: Mapping[str, Any], *, authorization: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate a recovery draft while its original output namespace is untouched."""

    return _validate_execution_draft(
        draft,
        authorization=authorization,
        allow_sealed_pre_child_output_reuse=False,
    )


def validate_sealed_pre_child_draft(
    draft: Mapping[str, Any], *, authorization: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate a PRE_CHILD draft after a signed link authorized output reuse.

    The guardian incident signs the exact draft hash before the replacement may
    run.  This mode preserves every authorization, consumed-marker, process,
    cleanup, and missing-output assertion recorded in that draft, but does not
    incorrectly require the shared output paths to remain absent forever.
    """

    return _validate_execution_draft(
        draft,
        authorization=authorization,
        allow_sealed_pre_child_output_reuse=True,
    )


def validate_guardian_incident(
    signed_incident: Mapping[str, Any],
    *,
    guardian_public_key_path: Path,
    execution_draft: Mapping[str, Any],
    authorization: Mapping[str, Any],
    sealed_pre_child_output_reuse: bool = False,
) -> dict[str, Any]:
    """Verify a guardian's sole, metric-free recovery classification."""

    draft = (
        validate_sealed_pre_child_draft(
            execution_draft, authorization=authorization
        )
        if sealed_pre_child_output_reuse
        else validate_execution_draft(execution_draft, authorization=authorization)
    )
    incident = verify_signed_payload(
        signed_incident,
        expected_role="guardian",
        public_key_path=guardian_public_key_path,
    )
    _exact_keys(
        incident,
        {
            "schemaVersion",
            "immutable",
            "outcomeBlind",
            "promotionEligible",
            "recoveryPermitted",
            "campaignId",
            "kind",
            "originalTokenId",
            "recoveryClass",
            "diagnosticCode",
            "classifiedAtUtc",
            "attemptOrdinal",
            "action",
            "executionDraftSha256",
            "authorizationSha256",
            "consumedMarkerSha256",
            "protectedBindingsSha256",
            "candidateCodeMayRun",
            "seedMayBeReused",
            "secondRecoveryForbidden",
        },
        "guardian recovery incident",
    )
    recovery_class = draft["recoveryClass"]
    expected_action = ACTIONS[recovery_class]
    candidate_code_may_run = recovery_class == PRE_CHILD
    authorization_digest = str(draft["authorization"]["sha256"])
    consumed_digest = str(draft["consumedMarker"]["sha256"])
    if (
        incident.get("schemaVersion") != GUARDIAN_INCIDENT_SCHEMA
        or incident.get("immutable") is not True
        or incident.get("outcomeBlind") is not True
        or incident.get("promotionEligible") is not False
        or incident.get("recoveryPermitted") is not True
        or incident.get("campaignId") != draft["campaignId"]
        or incident.get("kind") != draft["kind"]
        or incident.get("originalTokenId") != draft["tokenId"]
        or incident.get("recoveryClass") != recovery_class
        or incident.get("diagnosticCode") != draft["diagnosticCode"]
        or incident.get("attemptOrdinal") != 1
        or incident.get("action") != expected_action
        or incident.get("executionDraftSha256")
        != sha256_bytes(canonical_json(draft))
        or incident.get("authorizationSha256") != authorization_digest
        or incident.get("consumedMarkerSha256") != consumed_digest
        or incident.get("protectedBindingsSha256")
        != protected_bindings_sha256(authorization)
        or incident.get("candidateCodeMayRun") is not candidate_code_may_run
        or incident.get("seedMayBeReused") is not candidate_code_may_run
        or incident.get("secondRecoveryForbidden") is not True
    ):
        raise ValueError("guardian recovery classification changed")
    classified = _parse_utc(incident["classifiedAtUtc"], "incident classification time")
    finished = _parse_utc(draft["finishedAtUtc"], "execution finish time")
    if not finished <= classified <= finished + dt.timedelta(hours=24):
        raise ValueError("guardian recovery classification time is invalid")
    return incident


def validate_recovery_link(
    link: Mapping[str, Any],
    *,
    guardian_incident: Mapping[str, Any],
    original_authorization: Mapping[str, Any],
    replacement_authorization: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Validate the deterministic link from one failure to its sole recovery.

    ``guardian_incident`` must be the already signature-verified unsigned value
    returned by :func:`validate_guardian_incident`.  PRE_CHILD links bind a
    separately issuer-validated replacement authorization.  RECEIPT_ONLY links
    reject any replacement authorization so candidate code cannot run twice.
    """

    _exact_keys(
        link,
        {
            "schemaVersion",
            "immutable",
            "promotionEligible",
            "campaignId",
            "kind",
            "recoveryClass",
            "action",
            "attemptOrdinal",
            "originalTokenId",
            "recoveryTokenId",
            "guardianIncidentPayloadSha256",
            "originalAuthorizationSha256",
            "replacementAuthorizationPayloadSha256",
            "protectedBindingsSha256",
            "candidateCodeMayRun",
            "secondRecoveryForbidden",
        },
        "recovery link",
    )
    incident = _unsigned(guardian_incident)
    _exact_keys(
        incident,
        {
            "schemaVersion",
            "immutable",
            "outcomeBlind",
            "promotionEligible",
            "recoveryPermitted",
            "campaignId",
            "kind",
            "originalTokenId",
            "recoveryClass",
            "diagnosticCode",
            "classifiedAtUtc",
            "attemptOrdinal",
            "action",
            "executionDraftSha256",
            "authorizationSha256",
            "consumedMarkerSha256",
            "protectedBindingsSha256",
            "candidateCodeMayRun",
            "seedMayBeReused",
            "secondRecoveryForbidden",
        },
        "validated guardian recovery incident",
    )
    recovery_class = incident.get("recoveryClass")
    if (
        incident.get("schemaVersion") != GUARDIAN_INCIDENT_SCHEMA
        or incident.get("immutable") is not True
        or incident.get("outcomeBlind") is not True
        or incident.get("promotionEligible") is not False
        or incident.get("recoveryPermitted") is not True
        or recovery_class not in RECOVERY_CLASSES
        or incident.get("diagnosticCode") not in DIAGNOSTIC_CODES.get(recovery_class, ())
        or incident.get("attemptOrdinal") != 1
        or incident.get("action") != ACTIONS.get(recovery_class)
        or incident.get("secondRecoveryForbidden") is not True
    ):
        raise ValueError("recovery link names an invalid guardian incident")
    original = _unsigned(original_authorization)
    original_token = _token(original.get("tokenId"), "original authorization token")
    recovery_token = _token(link.get("recoveryTokenId"), "recovery token")
    original_digest = _sha256(
        incident.get("authorizationSha256"), "incident authorization digest"
    )
    candidate_code_may_run = recovery_class == PRE_CHILD
    replacement_payload_digest: str | None = None
    if candidate_code_may_run:
        if replacement_authorization is None:
            raise ValueError("PRE_CHILD recovery lacks a replacement authorization")
        replacement = _unsigned(replacement_authorization)
        if replacement.get("tokenId") != recovery_token:
            raise ValueError("replacement authorization token differs from recovery link")
        if (
            replacement.get("campaignId") != original.get("campaignId")
            or replacement.get("kind") != original.get("kind")
            or protected_bindings_sha256(replacement_authorization)
            != protected_bindings_sha256(original_authorization)
        ):
            raise ValueError("replacement authorization changes protected bindings")
        replacement_payload_digest = sha256_bytes(canonical_json(replacement))
    elif replacement_authorization is not None:
        raise ValueError("RECEIPT_ONLY recovery may not authorize candidate execution")
    if (
        link.get("schemaVersion") != RECOVERY_LINK_SCHEMA
        or link.get("immutable") is not True
        or link.get("promotionEligible") is not False
        or link.get("campaignId") != original.get("campaignId")
        or link.get("kind") != original.get("kind")
        or link.get("recoveryClass") != recovery_class
        or link.get("action") != ACTIONS[recovery_class]
        or link.get("attemptOrdinal") != 1
        or link.get("originalTokenId") != original_token
        or recovery_token == original_token
        or link.get("guardianIncidentPayloadSha256")
        != sha256_bytes(canonical_json(incident))
        or link.get("originalAuthorizationSha256") != original_digest
        or link.get("replacementAuthorizationPayloadSha256")
        != replacement_payload_digest
        or link.get("protectedBindingsSha256")
        != protected_bindings_sha256(original_authorization)
        or link.get("candidateCodeMayRun") is not candidate_code_may_run
        or link.get("secondRecoveryForbidden") is not True
    ):
        raise ValueError("recovery link identity changed")
    return dict(link)
