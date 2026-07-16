#!/usr/bin/env python3
"""Frozen, outcome-blind readiness contracts for the P30 campaign."""

from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
from typing import Any, Mapping

from v35_p30_crypto import (
    canonical_json,
    public_key_identity,
    read_regular_nofollow,
    role_public_key_path,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)
from analyze_v35_p30_long_horizon import (
    ARMS,
    REPLICATES,
    endpoint_label,
    signed_inventory_merkle_root,
)
from v35_p30_authorized_execution import (
    ANALYSIS_CAPABILITY_FD,
    ANALYSIS_LAUNCH_EVIDENCE_SCHEMA,
    ANALYSIS_LAUNCH_INTENT_SCHEMA,
    CONSUMED_SCHEMA,
    NORMAL_SEAL_ATTEMPT_SCHEMA,
    RECEIPT_SCHEMA,
    analysis_launch_paths,
    normal_seal_attempt_path,
    unsigned_receipt_path,
    validate_authorization,
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
    "analyzer-rehearsal": "arc-v35-p30-analyzer-synthetic-rehearsal-v2",
    "cuda-determinism": "arc-v35-p30-cuda-determinism-preflight-v1",
}
ANALYZER_REHEARSAL_SCHEMA = PHASE0_REPORT_SCHEMAS["analyzer-rehearsal"]
ANALYZER_REHEARSAL_DOMAIN = "arc-v35-p30-analyzer-rehearsal-v2"
ANALYZER_REHEARSAL_RESULT_BASE = Path(
    "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-results"
)
ANALYZER_REHEARSAL_DIAGNOSTIC_CODES = (
    "SYNTHETIC_FULL_SHAPE_CHAIN_VERIFIED",
    "EXACT_PRODUCTION_ANALYZER_EXECUTED",
    "NONCANONICAL_54_LABEL_PERMUTATION",
    "EXACT_ANALYSIS_CAPABILITY_CONSUMED",
    "DISTINCT_PID_USER_NETWORK_NAMESPACES",
    "EMPTY_ANALYZER_STDOUT_STDERR",
    "ANALYSIS_RESULT_COMMITTED_NOT_INSPECTED",
    "EXECUTOR_RECEIPT_SIGNED_AND_SEALED",
    "ONE_SHOT_REENTRY_REJECTED",
    "EPHEMERAL_PRIVATE_KEYS_DELETED",
)
ANALYZER_REHEARSAL_COUNTS = {
    "endpointCount": 54,
    "generationExecutionReceiptCount": 432,
    "evaluationExecutionReceiptCount": 108,
    "pairIntegrityReceiptCount": 54,
    "finalBarrierCount": 1,
    "signedReceiptInventoryCount": 595,
    "uniqueExecutionTokenCount": 540,
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


def analyzer_rehearsal_campaign_id(protocol: Mapping[str, Any]) -> str:
    parent = protocol["executionTrust"]["campaignInstanceId"]
    if (
        not isinstance(parent, str)
        or len(parent) != 64
        or any(character not in "0123456789abcdef" for character in parent)
    ):
        raise ValueError("P30 parent campaign instance ID is malformed")
    return sha256_bytes(
        canonical_json(
            {
                "domain": ANALYZER_REHEARSAL_DOMAIN,
                "parentCampaignInstanceId": parent,
            }
        )
    )


def analyzer_rehearsal_ledger_root(protocol: Mapping[str, Any]) -> Path:
    root = Path(protocol["executionTrust"]["ledgerRoot"])
    if not root.is_absolute():
        raise ValueError("P30 ledger root must be absolute")
    return root / analyzer_rehearsal_campaign_id(protocol)


def analyzer_rehearsal_result_root(protocol: Mapping[str, Any]) -> Path:
    return ANALYZER_REHEARSAL_RESULT_BASE / analyzer_rehearsal_campaign_id(protocol)


def analyzer_rehearsal_protocol_path(protocol: Mapping[str, Any]) -> Path:
    return analyzer_rehearsal_ledger_root(protocol) / "synthetic-protocol.json"


def _exact_keys(value: Any, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} registry changed")


def _sha256_value(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} is not a SHA-256 digest")
    return value


def _validate_rehearsal_binding(
    value: Any,
    *,
    label: str,
    allowed_root: Path,
    exact_path: Path | None = None,
    expected_bytes: int | None = None,
) -> Path:
    _exact_keys(value, {"path", "sha256", "bytes"}, label)
    raw_path = Path(value["path"])
    if not raw_path.is_absolute():
        raise ValueError(f"{label} path is not absolute")
    if raw_path.is_symlink():
        raise ValueError(f"{label} is a symbolic link")
    path = raw_path.resolve()
    root = allowed_root.resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"{label} escaped its synthetic root")
    if exact_path is not None and path != exact_path.resolve():
        raise ValueError(f"{label} path changed")
    if not path.is_file():
        raise ValueError(f"{label} is not a regular file")
    size = path.stat().st_size
    if type(value["bytes"]) is not int or value["bytes"] != size:
        raise ValueError(f"{label} size commitment changed")
    if expected_bytes is not None and size != expected_bytes:
        raise ValueError(f"{label} is not exactly {expected_bytes} bytes")
    if _sha256_value(value["sha256"], f"{label} digest") != sha256_file(path):
        raise ValueError(f"{label} digest changed")
    return path


def validate_analyzer_rehearsal_report(
    *,
    report: Mapping[str, Any],
    protocol_path: Path,
    protocol: Mapping[str, Any],
) -> None:
    """Validate the metric-free v2 rehearsal evidence before guardian signing."""

    _exact_keys(
        report,
        {
            "schemaVersion",
            "valid",
            "immutable",
            "promotionEligible",
            "outcomesInspected",
            "syntheticDataOnly",
            "syntheticOutcomesAnalyzed",
            "analysisResultInspected",
            "metricsExposed",
            "parentCampaignInstanceId",
            "syntheticCampaignInstanceId",
            "protocol",
            "counts",
            "labelPermutation",
            "manifest",
            "analysisAuthorization",
            "execution",
            "streams",
            "analysisArtifact",
            "sealing",
            "source",
            "cleanup",
            "diagnosticCodes",
        },
        "P30 analyzer rehearsal report",
    )
    parent_id = protocol["executionTrust"]["campaignInstanceId"]
    synthetic_id = analyzer_rehearsal_campaign_id(protocol)
    if _read_object(protocol_path.resolve(), "P30 parent protocol") != dict(protocol):
        raise ValueError("P30 parent protocol binding changed")
    if (
        report["schemaVersion"] != ANALYZER_REHEARSAL_SCHEMA
        or report["valid"] is not True
        or report["immutable"] is not True
        or report["promotionEligible"] is not False
        or report["outcomesInspected"] is not False
        or report["syntheticDataOnly"] is not True
        or report["syntheticOutcomesAnalyzed"] is not True
        or report["analysisResultInspected"] is not False
        or report["metricsExposed"] is not False
        or report["parentCampaignInstanceId"] != parent_id
        or report["syntheticCampaignInstanceId"] != synthetic_id
        or report["diagnosticCodes"]
        != list(ANALYZER_REHEARSAL_DIAGNOSTIC_CODES)
    ):
        raise ValueError("P30 analyzer rehearsal v2 contract changed")

    counts = dict(ANALYZER_REHEARSAL_COUNTS)
    counts["gamesPerEndpoint"] = protocol["seedSchedule"]["commonPublicGames"]
    if report["counts"] != counts:
        raise ValueError("P30 analyzer rehearsal full-shape counts changed")

    permutation = report["labelPermutation"]
    _exact_keys(
        permutation,
        {
            "labelCount",
            "exactLabelSet",
            "nonCanonicalOrder",
            "canonicalLabelOrderSha256",
            "shuffledLabelOrderSha256",
        },
        "P30 analyzer rehearsal label permutation",
    )
    canonical_order = _sha256_value(
        permutation["canonicalLabelOrderSha256"], "canonical label order"
    )
    shuffled_order = _sha256_value(
        permutation["shuffledLabelOrderSha256"], "shuffled label order"
    )
    if (
        permutation["labelCount"] != 54
        or permutation["exactLabelSet"] is not True
        or permutation["nonCanonicalOrder"] is not True
        or canonical_order == shuffled_order
    ):
        raise ValueError("P30 analyzer rehearsal label permutation changed")

    ledger = analyzer_rehearsal_ledger_root(protocol)
    result_root = analyzer_rehearsal_result_root(protocol)
    protocol_binding = report["protocol"]
    _validate_rehearsal_binding(
        protocol_binding,
        label="P30 synthetic protocol",
        allowed_root=ledger,
        exact_path=analyzer_rehearsal_protocol_path(protocol),
    )
    synthetic_protocol = _read_object(
        Path(protocol_binding["path"]), "P30 synthetic protocol"
    )
    parent_copy = copy.deepcopy(dict(protocol))
    synthetic_copy = copy.deepcopy(synthetic_protocol)
    parent_trust = parent_copy.get("executionTrust")
    synthetic_trust = synthetic_copy.get("executionTrust")
    if (
        not isinstance(parent_trust, dict)
        or not isinstance(synthetic_trust, dict)
        or synthetic_trust.get("campaignInstanceId") != synthetic_id
        or synthetic_trust.get("ledgerRoot") != parent_trust.get("ledgerRoot")
    ):
        raise ValueError("P30 synthetic protocol trust root changed")
    parent_roles = parent_trust.pop("roles", None)
    synthetic_roles = synthetic_trust.pop("roles", None)
    parent_trust.pop("campaignInstanceId", None)
    synthetic_trust.pop("campaignInstanceId", None)
    if (
        parent_copy != synthetic_copy
        or not isinstance(parent_roles, dict)
        or not isinstance(synthetic_roles, dict)
        or set(synthetic_roles) != set(parent_roles)
    ):
        raise ValueError("P30 synthetic protocol changed outside ephemeral trust roles")
    for role, parent_role in parent_roles.items():
        synthetic_role = synthetic_roles[role]
        if (
            not isinstance(parent_role, dict)
            or not isinstance(synthetic_role, dict)
            or set(synthetic_role) != set(parent_role)
            or {
                key: value
                for key, value in synthetic_role.items()
                if key
                not in {
                    "publicKeyPath",
                    "publicKeyPemSha256",
                    "publicKeyDerSha256",
                    "keyId",
                }
            }
            != {
                key: value
                for key, value in parent_role.items()
                if key
                not in {
                    "publicKeyPath",
                    "publicKeyPemSha256",
                    "publicKeyDerSha256",
                    "keyId",
                }
            }
        ):
            raise ValueError("P30 synthetic protocol role policy changed")
        public_path = Path(str(synthetic_role.get("publicKeyPath", "")))
        key_id, der_sha256 = (
            public_key_identity(public_path)
            if public_path.is_file()
            else (None, None)
        )
        if (
            not public_path.is_absolute()
            or ledger.resolve() not in public_path.resolve().parents
            or not public_path.is_file()
            or synthetic_role.get("publicKeyPemSha256") != sha256_file(public_path)
            or synthetic_role.get("publicKeyDerSha256") != der_sha256
            or synthetic_role.get("keyId") != key_id
        ):
            raise ValueError("P30 synthetic protocol public key changed")

    manifest = report["manifest"]
    _exact_keys(
        manifest,
        {"binding", "schemaVersion", "receiptMerkleRoot"},
        "P30 synthetic manifest commitment",
    )
    if manifest["schemaVersion"] != "arc-v35-p30-analysis-manifest-v1":
        raise ValueError("P30 synthetic manifest schema changed")
    _sha256_value(manifest["receiptMerkleRoot"], "synthetic receipt Merkle root")
    manifest_path = _validate_rehearsal_binding(
        manifest["binding"],
        label="P30 synthetic manifest",
        allowed_root=ledger,
        exact_path=ledger / "analysis/input-manifest.signed.json",
    )
    manifest_payload = verify_signed_payload(
        _read_object(manifest_path, "P30 synthetic signed manifest"),
        expected_role="guardian",
        public_key_path=role_public_key_path(
            synthetic_protocol["executionTrust"], "guardian"
        ),
    )
    expected_manifest_counts = {
        "endpoints": 54,
        "generationReceipts": 432,
        "evaluationReceipts": 108,
        "pairIntegrityReceipts": 54,
        "signedReceipts": 595,
        "uniqueExecutionTokens": 540,
    }
    inventory = manifest_payload.get("signedReceiptInventory")
    reports = manifest_payload.get("reports")
    if (
        manifest_payload.get("schemaVersion")
        != "arc-v35-p30-analysis-manifest-v1"
        or manifest_payload.get("valid") is not True
        or manifest_payload.get("immutable") is not True
        or manifest_payload.get("promotionEligible") is not False
        or manifest_payload.get("outcomesInspected") is not False
        or manifest_payload.get("metricsIncluded") is not False
        or manifest_payload.get("campaignInstanceId") != synthetic_id
        or manifest_payload.get("protocol")
        != {
            "path": str(Path(protocol_binding["path"])),
            "sha256": protocol_binding["sha256"],
        }
        or manifest_payload.get("counts") != expected_manifest_counts
        or not isinstance(inventory, list)
        or len(inventory) != 595
        or [entry.get("ordinal") for entry in inventory] != list(range(595))
        or not isinstance(reports, list)
        or len(reports) != 54
    ):
        raise ValueError("P30 synthetic signed manifest changed")
    token_ids = [
        entry.get("tokenId")
        for entry in inventory
        if isinstance(entry, dict) and entry.get("tokenId") is not None
    ]
    canonical_labels = [
        endpoint_label(replicate, arm)
        for replicate in REPLICATES
        for arm in ARMS
    ]
    shuffled_labels = [
        entry.get("label") if isinstance(entry, dict) else None for entry in reports
    ]
    if (
        len(token_ids) != 540
        or len(set(token_ids)) != 540
        or any(_sha256_value(token, "synthetic inventory token") != token for token in token_ids)
        or signed_inventory_merkle_root(inventory)
        != manifest_payload.get("receiptMerkleRoot")
        or manifest_payload.get("receiptMerkleRoot")
        != manifest["receiptMerkleRoot"]
        or set(shuffled_labels) != set(canonical_labels)
        or shuffled_labels == canonical_labels
        or sha256_bytes(canonical_json(canonical_labels)) != canonical_order
        or sha256_bytes(canonical_json(shuffled_labels)) != shuffled_order
    ):
        raise ValueError("P30 synthetic manifest inventory or label order changed")

    authorization = report["analysisAuthorization"]
    _exact_keys(
        authorization, {"binding", "kind"}, "P30 synthetic analysis authorization"
    )
    if authorization["kind"] != "analysis":
        raise ValueError("P30 synthetic analysis authorization kind changed")
    authorization_path = _validate_rehearsal_binding(
        authorization["binding"],
        label="P30 synthetic analysis authorization",
        allowed_root=ledger,
        exact_path=ledger / "authorizations/final-analysis.json",
    )
    signed_authorization = _read_object(
        authorization_path, "P30 synthetic signed analysis authorization"
    )
    not_before_value = signed_authorization.get("notBeforeUtc")
    if not isinstance(not_before_value, str) or not not_before_value.endswith("Z"):
        raise ValueError("P30 synthetic analysis authorization time changed")
    authorization_moment = dt.datetime.fromisoformat(
        not_before_value[:-1] + "+00:00"
    )
    authorization_payload = validate_authorization(
        signed_authorization,
        issuer_public_key_path=role_public_key_path(
            synthetic_protocol["executionTrust"], "issuer"
        ),
        analysis_authorizer_public_key_path=role_public_key_path(
            synthetic_protocol["executionTrust"], "analysis-authorizer"
        ),
        authorization_path=authorization_path,
        now=authorization_moment,
    )
    if (
        authorization_payload.get("kind") != "analysis"
        or authorization_payload.get("protocol")
        != {
            "path": str(Path(protocol_binding["path"])),
            "sha256": protocol_binding["sha256"],
        }
        or authorization_payload.get("predecessor")
        != {"receiptPath": str(manifest_path), "sha256": sha256_file(manifest_path)}
    ):
        raise ValueError("P30 production analysis authorization validation changed")

    execution = report["execution"]
    _exact_keys(
        execution,
        {
            "kind",
            "tokenIdSha256",
            "consumedMarker",
            "launchIntent",
            "launchEvidence",
            "capabilityConsumed",
            "oneShotReentryRejected",
            "network",
            "newPidNamespace",
            "newUserNamespace",
            "newNetworkNamespace",
            "gpuMode",
            "exitCode",
        },
        "P30 synthetic analysis execution",
    )
    token = authorization_payload.get("tokenId")
    _sha256_value(token, "synthetic execution token")
    if (
        execution["kind"] != "analysis"
        or execution["capabilityConsumed"] is not True
        or execution["oneShotReentryRejected"] is not True
        or execution["network"] != "none"
        or execution["newPidNamespace"] is not True
        or execution["newUserNamespace"] is not True
        or execution["newNetworkNamespace"] is not True
        or execution["gpuMode"] != "none"
        or execution["exitCode"] != 0
        or execution["tokenIdSha256"] != sha256_bytes(token.encode())
    ):
        raise ValueError("P30 synthetic analysis execution evidence changed")
    authorization_ledger = authorization_payload.get("ledger", {})
    expected_consumed_path = Path(str(authorization_ledger.get("consumedPath", "")))
    expected_intent_path, expected_evidence_path = analysis_launch_paths(ledger, token)
    execution_exact_paths = {
        "consumedMarker": expected_consumed_path,
        "launchIntent": expected_intent_path,
        "launchEvidence": expected_evidence_path,
    }
    execution_paths: dict[str, Path] = {}
    for field, label in (
        ("consumedMarker", "consumed marker"),
        ("launchIntent", "launch intent"),
        ("launchEvidence", "launch evidence"),
    ):
        execution_paths[field] = _validate_rehearsal_binding(
            execution[field],
            label=f"P30 synthetic {label}",
            allowed_root=ledger,
            exact_path=execution_exact_paths[field],
        )

    consumed = _read_object(execution_paths["consumedMarker"], "P30 synthetic consumed marker")
    if (
        consumed.get("schemaVersion") != CONSUMED_SCHEMA
        or consumed.get("tokenId") != token
        or consumed.get("authorizationPath") != str(authorization_path)
        or consumed.get("authorizationSha256") != sha256_file(authorization_path)
    ):
        raise ValueError("P30 synthetic consumed-token evidence changed")
    expected_authorization_binding = {
        "path": str(authorization_path),
        "sha256": sha256_file(authorization_path),
    }
    expected_consumed_binding = {
        "path": str(execution_paths["consumedMarker"]),
        "sha256": sha256_file(execution_paths["consumedMarker"]),
    }
    intent = _read_object(execution_paths["launchIntent"], "P30 synthetic launch intent")
    evidence = _read_object(execution_paths["launchEvidence"], "P30 synthetic launch evidence")
    supervisor_namespaces = intent.get("supervisor", {}).get("namespaces")
    child_namespaces = evidence.get("child", {}).get("namespaces")
    if (
        intent.get("schemaVersion") != ANALYSIS_LAUNCH_INTENT_SCHEMA
        or intent.get("kind") != "analysis"
        or intent.get("tokenId") != token
        or intent.get("authorization") != expected_authorization_binding
        or intent.get("consumedMarker") != expected_consumed_binding
        or intent.get("capabilityFd") != ANALYSIS_CAPABILITY_FD
        or intent.get("launchEvidencePath") != str(execution_paths["launchEvidence"])
        or evidence.get("schemaVersion") != ANALYSIS_LAUNCH_EVIDENCE_SCHEMA
        or evidence.get("kind") != "analysis"
        or evidence.get("tokenId") != token
        or evidence.get("authorization") != expected_authorization_binding
        or evidence.get("consumedMarker") != expected_consumed_binding
        or evidence.get("launchIntent")
        != {
            "path": str(execution_paths["launchIntent"]),
            "sha256": sha256_file(execution_paths["launchIntent"]),
        }
        or evidence.get("capabilitySha256") != intent.get("capabilitySha256")
        or not isinstance(supervisor_namespaces, dict)
        or not isinstance(child_namespaces, dict)
        or set(supervisor_namespaces) != {"pid", "user", "network"}
        or set(child_namespaces) != {"pid", "user", "network"}
        or any(
            supervisor_namespaces[name] == child_namespaces[name]
            for name in ("pid", "user", "network")
        )
    ):
        raise ValueError("P30 synthetic analysis launch evidence changed")

    streams = report["streams"]
    _exact_keys(streams, {"stdout", "stderr"}, "P30 synthetic analyzer streams")
    stream_paths: dict[str, Path] = {}
    for name in ("stdout", "stderr"):
        stream_paths[name] = _validate_rehearsal_binding(
            streams[name],
            label=f"P30 synthetic analyzer {name}",
            allowed_root=ledger,
            expected_bytes=0,
        )

    analysis = report["analysisArtifact"]
    _exact_keys(
        analysis, {"binding", "contentExposed"}, "P30 synthetic analysis artifact"
    )
    if analysis["contentExposed"] is not False:
        raise ValueError("P30 synthetic analysis content was exposed")
    analysis_path = _validate_rehearsal_binding(
        analysis["binding"],
        label="P30 synthetic analysis result",
        allowed_root=result_root,
        exact_path=result_root / "analysis.json",
    )
    outputs = authorization_payload.get("outputs")
    if (
        not isinstance(outputs, dict)
        or set(outputs) != {"analysis", "exitCode", "stderr", "stdout"}
        or outputs["analysis"].get("path") != str(analysis_path)
        or outputs["stdout"].get("path") != str(stream_paths["stdout"])
        or outputs["stderr"].get("path") != str(stream_paths["stderr"])
        or authorization_payload.get("ledger", {}).get("consumedPath")
        != str(execution_paths["consumedMarker"])
    ):
        raise ValueError("P30 synthetic analysis outputs changed")

    sealing = report["sealing"]
    _exact_keys(
        sealing,
        {
            "unsignedReceipt",
            "normalSealAttempt",
            "signedReceipt",
            "signatureRole",
            "signatureValid",
            "valid",
        },
        "P30 synthetic analysis sealing",
    )
    if (
        sealing["signatureRole"] != "executor"
        or sealing["signatureValid"] is not True
        or sealing["valid"] is not True
    ):
        raise ValueError("P30 synthetic analysis seal changed")
    expected_signed_receipt_path = Path(
        str(authorization_payload.get("ledger", {}).get("receiptPath", ""))
    )
    sealing_exact_paths = {
        "unsignedReceipt": unsigned_receipt_path(expected_signed_receipt_path),
        "normalSealAttempt": normal_seal_attempt_path(expected_signed_receipt_path),
        "signedReceipt": expected_signed_receipt_path,
    }
    sealing_paths: dict[str, Path] = {}
    for field, label in (
        ("unsignedReceipt", "unsigned receipt"),
        ("normalSealAttempt", "normal seal attempt"),
        ("signedReceipt", "signed receipt"),
    ):
        sealing_paths[field] = _validate_rehearsal_binding(
            sealing[field],
            label=f"P30 synthetic {label}",
            allowed_root=ledger,
            exact_path=sealing_exact_paths[field],
        )

    if authorization_payload.get("ledger", {}).get("receiptPath") != str(
        sealing_paths["signedReceipt"]
    ):
        raise ValueError("P30 synthetic receipt path differs from its authorization")
    unsigned_receipt = _read_object(
        sealing_paths["unsignedReceipt"], "P30 synthetic unsigned receipt"
    )
    signed_receipt = verify_signed_payload(
        _read_object(sealing_paths["signedReceipt"], "P30 synthetic signed receipt"),
        expected_role="executor",
        public_key_path=role_public_key_path(
            synthetic_protocol["executionTrust"], "executor"
        ),
    )
    expected_artifacts = {
        "analysis": dict(analysis["binding"]),
        "stderr": dict(streams["stderr"]),
        "stdout": dict(streams["stdout"]),
    }
    receipt_artifacts = signed_receipt.get("artifacts")
    started_value = signed_receipt.get("startedAtUtc")
    try:
        started = dt.datetime.fromisoformat(str(started_value).replace("Z", "+00:00"))
        not_before = dt.datetime.fromisoformat(
            authorization_payload["notBeforeUtc"].replace("Z", "+00:00")
        )
        expires = dt.datetime.fromisoformat(
            authorization_payload["expiresAtUtc"].replace("Z", "+00:00")
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("P30 synthetic analysis execution time changed") from exc
    if (
        unsigned_receipt != signed_receipt
        or signed_receipt.get("schemaVersion") != RECEIPT_SCHEMA
        or signed_receipt.get("valid") is not True
        or signed_receipt.get("promotionEligible") is not False
        or signed_receipt.get("kind") != "analysis"
        or signed_receipt.get("tokenId") != token
        or signed_receipt.get("authorization") != expected_authorization_binding
        or signed_receipt.get("consumedMarker") != expected_consumed_binding
        or signed_receipt.get("exitCode") != 0
        or not not_before <= started < expires
        or not isinstance(receipt_artifacts, dict)
        or any(
            receipt_artifacts.get(label) != expected
            for label, expected in expected_artifacts.items()
        )
    ):
        raise ValueError("P30 synthetic executor-signed receipt changed")
    seal_marker = _read_object(
        sealing_paths["normalSealAttempt"], "P30 synthetic normal seal marker"
    )
    if (
        seal_marker.get("schemaVersion") != NORMAL_SEAL_ATTEMPT_SCHEMA
        or seal_marker.get("immutable") is not True
        or seal_marker.get("promotionEligible") is not False
        or seal_marker.get("kind") != "analysis"
        or seal_marker.get("tokenId") != token
        or seal_marker.get("authorization") != expected_authorization_binding
        or seal_marker.get("unsignedReceipt")
        != {
            "path": str(sealing_paths["unsignedReceipt"]),
            "sha256": sha256_file(sealing_paths["unsignedReceipt"]),
        }
        or seal_marker.get("attemptOrdinal") != 1
        or seal_marker.get("signingRole") != "executor"
    ):
        raise ValueError("P30 synthetic normal seal marker changed")

    source = report["source"]
    _exact_keys(
        source,
        {
            "rehearsal",
            "fixtureBuilder",
            "productionAnalyzer",
            "authorizedExecution",
        },
        "P30 analyzer rehearsal source",
    )
    source_root = Path(__file__).resolve().parent
    for field, filename in (
        ("rehearsal", "run_v35_p30_analyzer_rehearsal.py"),
        ("fixtureBuilder", "v35_p30_analyzer_rehearsal_fixture.py"),
        ("productionAnalyzer", "analyze_v35_p30_long_horizon.py"),
        ("authorizedExecution", "v35_p30_authorized_execution.py"),
    ):
        _validate_rehearsal_binding(
            source[field],
            label=f"P30 {field} source",
            allowed_root=source_root,
            exact_path=source_root / filename,
        )

    cleanup = report["cleanup"]
    _exact_keys(
        cleanup,
        {"ephemeralPrivateKeysDeleted", "privateKeyPaths"},
        "P30 analyzer rehearsal cleanup",
    )
    private_paths = cleanup["privateKeyPaths"]
    private_root = (
        phase0_output_root(protocol, "analyzer-rehearsal")
        / ".synthetic-analysis-private-keys"
    ).resolve()
    if (
        cleanup["ephemeralPrivateKeysDeleted"] is not True
        or not isinstance(private_paths, list)
        or private_paths
        != sorted(
            str(private_root / f"{role}.private.pem")
            for role in synthetic_roles
        )
        or not all(isinstance(value, str) and Path(value).is_absolute() for value in private_paths)
        or any(
            private_root not in Path(value).resolve().parents
            or Path(value).exists()
            for value in private_paths
        )
    ):
        raise ValueError("P30 analyzer rehearsal retained private keys")


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
