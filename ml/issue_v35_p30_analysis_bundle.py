#!/usr/bin/env python3
"""Pure builders for the role-separated, sealed P30 analysis boundary."""

from __future__ import annotations

import datetime as dt
import copy
import hashlib
import json
import secrets
from pathlib import Path
from typing import Any, Mapping

from analyze_v35_p30_long_horizon import (
    ARMS,
    REPLICATES,
    REPO_ROOT,
    endpoint_label,
    read_json_object,
    resolve_artifact,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
)
from audit_v35_p30_generation import source_identity
from run_v35_p30_campaign import (
    FINAL_BARRIER_SCHEMA,
    PAIR_SCHEMA,
    evaluation_authorization_path,
    final_barrier_path,
    generation_authorization_path,
    ledger_for,
    pair_path,
    predecessor_for_generation,
    root_for,
    validate_completed_execution,
    validate_role_request_binding,
    validate_stored_authorization,
)
from v35_p30_authorized_execution import AUTHORIZATION_SCHEMA
from v35_p30_crypto import (
    canonical_json,
    read_regular_nofollow,
    role_public_key_path,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)


ANALYSIS_MANIFEST_SCHEMA = "arc-v35-p30-analysis-manifest-v1"
ANALYSIS_REVIEW_RECEIPT_SCHEMA = (
    "arc-v35-p30-analysis-authorization-review-receipt-v2"
)


def utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def rebind_reviewed_analysis_authorization_times(
    reviewed_draft: Mapping[str, Any],
    *,
    review_finished_at_utc: str,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Freshen only the final authorization TTL after the signed Fable review."""

    if reviewed_draft.get("kind") != "analysis":
        raise ValueError("only an analysis authorization draft may be time-rebound")
    if not isinstance(review_finished_at_utc, str) or not review_finished_at_utc.endswith("Z"):
        raise ValueError("analysis review finish time is malformed")
    try:
        review_finished = dt.datetime.fromisoformat(
            review_finished_at_utc[:-1] + "+00:00"
        )
    except ValueError as exc:
        raise ValueError("analysis review finish time is malformed") from exc
    observed = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    moment = max(observed, review_finished + dt.timedelta(microseconds=1))
    final = copy.deepcopy(dict(reviewed_draft))
    final["issuedAtUtc"] = utc(moment)
    final["notBeforeUtc"] = utc(moment)
    final["expiresAtUtc"] = utc(moment + dt.timedelta(hours=24))
    return final


def validate_reviewed_analysis_authorization_rebinding(
    reviewed_draft: Mapping[str, Any],
    final_authorization: Mapping[str, Any],
    *,
    review_finished_at_utc: str,
) -> None:
    if reviewed_draft.get("kind") != "analysis" or final_authorization.get("kind") != "analysis":
        raise ValueError("analysis authorization time rebinding kind changed")
    normalized = copy.deepcopy(dict(final_authorization))
    for field in ("issuedAtUtc", "notBeforeUtc", "expiresAtUtc"):
        normalized[field] = reviewed_draft.get(field)
    if canonical_json(normalized) != canonical_json(dict(reviewed_draft)):
        raise ValueError("final analysis authorization changed beyond its three TTL fields")
    timestamp_fields = ("issuedAtUtc", "notBeforeUtc", "expiresAtUtc")
    if not all(
        isinstance(final_authorization.get(field), str)
        and final_authorization[field].endswith("Z")
        for field in timestamp_fields
    ) or not isinstance(review_finished_at_utc, str) or not review_finished_at_utc.endswith("Z"):
        raise ValueError("final analysis authorization TTL is not post-review and exact")
    try:
        issued, not_before, expires = (
            dt.datetime.fromisoformat(final_authorization[field][:-1] + "+00:00")
            for field in timestamp_fields
        )
        review_finished = dt.datetime.fromisoformat(
            review_finished_at_utc[:-1] + "+00:00"
        )
    except ValueError as exc:
        raise ValueError(
            "final analysis authorization TTL is not post-review and exact"
        ) from exc
    if (
        issued != not_before
        or issued <= review_finished
        or expires - issued != dt.timedelta(hours=24)
    ):
        raise ValueError("final analysis authorization TTL is not post-review and exact")


def _read_signed(path: Path, public_key: Path, role: str, label: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return verify_signed_payload(value, expected_role=role, public_key_path=public_key)


def _inventory_merkle_root(inventory: list[dict[str, Any]]) -> str:
    if not inventory:
        raise ValueError("analysis receipt inventory is empty")
    level = [hashlib.sha256(canonical_json(entry)).digest() for entry in inventory]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [
            hashlib.sha256(level[index] + level[index + 1]).digest()
            for index in range(0, len(level), 2)
        ]
    return level[0].hex()


def _inventory_entry(
    *, ordinal: int, kind: str, label: str, path: Path, token_id: str | None
) -> dict[str, Any]:
    return {
        "ordinal": ordinal,
        "kind": kind,
        "label": label,
        "path": str(path.resolve()),
        "sha256": sha256_file(path.resolve()),
        "tokenId": token_id,
    }


def _report_entry(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    replicate: str,
    arm: str,
    final_generation_receipt_path: Path,
    primary_receipt_path: Path,
    primary_receipt: Mapping[str, Any],
    replay_receipt_path: Path,
    replay_receipt: Mapping[str, Any],
    pair_receipt_path: Path,
) -> dict[str, Any]:
    label = endpoint_label(replicate, arm)
    primary_artifacts = primary_receipt["artifacts"]
    replay_artifacts = replay_receipt["artifacts"]
    root = root_for(replicate, arm).resolve()
    if (
        primary_receipt.get("subject", {}).get("root") != str(root)
        or replay_receipt.get("subject", {}).get("root") != str(root)
    ):
        raise ValueError(f"{label}: evaluation receipt root changed")
    binding_path = root / "v35-binding.json"
    config_path = root / "config.json"
    generation = protocol["seedSchedule"]["maxGeneration"]
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    checkpoint_manifest = checkpoint.with_suffix(".manifest.json")
    audit = root / "artifacts" / f"gen{generation}-audit.json"
    primary_legacy = Path(primary_artifacts["legacyReceipt"]["path"]).resolve()
    replay_legacy = Path(replay_artifacts["legacyReceipt"]["path"]).resolve()
    report = Path(primary_artifacts["report"]["path"]).resolve()
    replay_report = Path(replay_artifacts["report"]["path"]).resolve()
    return {
        "label": label,
        "replicate": replicate,
        "arm": arm,
        "path": str(report),
        "sha256": sha256_file(report),
        "weightsSha256": sha256_file(checkpoint),
        "generationAuditPath": str(audit),
        "generationAuditSha256": sha256_file(audit),
        "generationExecutionReceiptPath": str(final_generation_receipt_path),
        "generationExecutionReceiptSha256": sha256_file(final_generation_receipt_path),
        "checkpointPath": str(checkpoint),
        "checkpointManifestPath": str(checkpoint_manifest),
        "checkpointManifestSha256": sha256_file(checkpoint_manifest),
        "configPath": str(config_path),
        "configSha256": sha256_file(config_path),
        "bindingPath": str(binding_path),
        "bindingSha256": sha256_file(binding_path),
        "exitCodePath": primary_artifacts["evaluatorExitCode"]["path"],
        "exitCodeSha256": primary_artifacts["evaluatorExitCode"]["sha256"],
        "evaluatorStdoutPath": primary_artifacts["evaluatorStdout"]["path"],
        "evaluatorStdoutSha256": primary_artifacts["evaluatorStdout"]["sha256"],
        "evaluatorStderrPath": primary_artifacts["evaluatorStderr"]["path"],
        "evaluatorStderrSha256": primary_artifacts["evaluatorStderr"]["sha256"],
        "serverLogPath": primary_artifacts["serverStdout"]["path"],
        "serverLogSha256": primary_artifacts["serverStdout"]["sha256"],
        "primaryReceiptPath": str(primary_legacy),
        "primaryReceiptSha256": sha256_file(primary_legacy),
        "primaryExecutionReceiptPath": str(primary_receipt_path),
        "primaryExecutionReceiptSha256": sha256_file(primary_receipt_path),
        "replayReportPath": str(replay_report),
        "replayReportSha256": sha256_file(replay_report),
        "replayExitCodePath": replay_artifacts["evaluatorExitCode"]["path"],
        "replayExitCodeSha256": replay_artifacts["evaluatorExitCode"]["sha256"],
        "replayEvaluatorStdoutPath": replay_artifacts["evaluatorStdout"]["path"],
        "replayEvaluatorStdoutSha256": replay_artifacts["evaluatorStdout"]["sha256"],
        "replayEvaluatorStderrPath": replay_artifacts["evaluatorStderr"]["path"],
        "replayEvaluatorStderrSha256": replay_artifacts["evaluatorStderr"]["sha256"],
        "replayServerLogPath": replay_artifacts["serverStdout"]["path"],
        "replayServerLogSha256": replay_artifacts["serverStdout"]["sha256"],
        "replayReceiptPath": str(replay_legacy),
        "replayReceiptSha256": sha256_file(replay_legacy),
        "replayExecutionReceiptPath": str(replay_receipt_path),
        "replayExecutionReceiptSha256": sha256_file(replay_receipt_path),
        "pairIntegrityPath": str(pair_receipt_path),
        "pairIntegritySha256": sha256_file(pair_receipt_path),
    }


def build_manifest_payload(
    *,
    protocol_path: Path,
    request_binding: Mapping[str, str],
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Build a metric-free guardian payload without parsing any report JSON."""

    protocol_path = protocol_path.resolve()
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    source_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    source_contract_path = resolve_artifact(
        protocol["sourceContract"]["artifact"],
        anchor=REPO_ROOT,
        label="P30 source contract",
    )
    ledger = ledger_for(protocol)
    guardian_public = role_public_key_path(protocol["executionTrust"], "guardian")
    barrier_path = final_barrier_path(protocol)
    barrier = _read_signed(
        barrier_path, guardian_public, "guardian", "final generation barrier"
    )
    if (
        barrier.get("schemaVersion") != FINAL_BARRIER_SCHEMA
        or barrier.get("valid") is not True
        or barrier.get("promotionEligible") is not False
        or barrier.get("outcomesInspected") is not False
        or barrier.get("endpointCount") != len(REPLICATES) * len(ARMS)
    ):
        raise ValueError("final generation barrier is invalid")
    validate_role_request_binding(
        barrier.get("request"),
        protocol_path=protocol_path,
        protocol=protocol,
        role="guardian",
        verb="attest-final-barrier",
        predecessor=None,
        expected_output=barrier_path,
    )
    inventory = [
        _inventory_entry(
            ordinal=0,
            kind="final-generation-barrier",
            label="final-generation-barrier",
            path=barrier_path,
            token_id=None,
        )
    ]
    reports: list[dict[str, Any]] = []
    seen_tokens: set[str] = set()
    ordinal = 1
    maximum = protocol["seedSchedule"]["maxGeneration"]
    for replicate in REPLICATES:
        for arm in ARMS:
            label = endpoint_label(replicate, arm)
            final_generation_receipt_path: Path | None = None
            for generation in range(1, maximum + 1):
                authorization_path = generation_authorization_path(
                    ledger, replicate, arm, generation
                )
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
                receipt_path, receipt = validate_completed_execution(
                    authorization_path=authorization_path,
                    authorization=authorization,
                    protocol=protocol,
                )
                token = receipt["tokenId"]
                if token in seen_tokens:
                    raise ValueError("analysis manifest found a duplicate execution token")
                seen_tokens.add(token)
                inventory.append(
                    _inventory_entry(
                        ordinal=ordinal,
                        kind="generation",
                        label=f"{label}-gen{generation}",
                        path=receipt_path,
                        token_id=token,
                    )
                )
                ordinal += 1
                final_generation_receipt_path = receipt_path
            evaluation_receipts: dict[str, tuple[Path, dict[str, Any]]] = {}
            predecessor = final_generation_receipt_path
            assert predecessor is not None
            for evaluation_role in ("primary", "replay"):
                authorization_path = evaluation_authorization_path(
                    ledger, label, evaluation_role
                )
                authorization = validate_stored_authorization(
                    authorization_path=authorization_path,
                    protocol_path=protocol_path,
                    kind=f"evaluation-{evaluation_role}",
                    root=root_for(replicate, arm),
                    replicate=replicate,
                    arm=arm,
                    role=evaluation_role,
                    predecessor=predecessor,
                )
                receipt_path, receipt = validate_completed_execution(
                    authorization_path=authorization_path,
                    authorization=authorization,
                    protocol=protocol,
                )
                token = receipt["tokenId"]
                if token in seen_tokens:
                    raise ValueError("analysis manifest found a duplicate execution token")
                seen_tokens.add(token)
                inventory.append(
                    _inventory_entry(
                        ordinal=ordinal,
                        kind=f"evaluation-{evaluation_role}",
                        label=f"{label}-{evaluation_role}",
                        path=receipt_path,
                        token_id=token,
                    )
                )
                ordinal += 1
                evaluation_receipts[evaluation_role] = (receipt_path, receipt)
                predecessor = receipt_path
            pair_receipt_path = pair_path(protocol, replicate, arm)
            pair = _read_signed(
                pair_receipt_path, guardian_public, "guardian", f"{label} pair receipt"
            )
            primary_path, primary = evaluation_receipts["primary"]
            replay_path, replay = evaluation_receipts["replay"]
            if (
                pair.get("schemaVersion") != PAIR_SCHEMA
                or pair.get("valid") is not True
                or pair.get("promotionEligible") is not False
                or pair.get("replicate") != replicate
                or pair.get("arm") != arm
                or pair.get("primaryReceipt")
                != {"path": str(primary_path), "sha256": sha256_file(primary_path)}
                or pair.get("replayReceipt")
                != {"path": str(replay_path), "sha256": sha256_file(replay_path)}
                or pair.get("games") != protocol["seedSchedule"]["commonPublicGames"]
                or pair.get("malformedEpisodes") != 0
            ):
                raise ValueError(f"{label}: pair receipt changed")
            validate_role_request_binding(
                pair.get("request"),
                protocol_path=protocol_path,
                protocol=protocol,
                role="guardian",
                verb="attest-pair",
                predecessor=replay_path,
                expected_output=pair_receipt_path,
            )
            inventory.append(
                _inventory_entry(
                    ordinal=ordinal,
                    kind="evaluation-pair",
                    label=f"{label}-pair",
                    path=pair_receipt_path,
                    token_id=None,
                )
            )
            ordinal += 1
            reports.append(
                _report_entry(
                    protocol=protocol,
                    protocol_path=protocol_path,
                    replicate=replicate,
                    arm=arm,
                    final_generation_receipt_path=final_generation_receipt_path,
                    primary_receipt_path=primary_path,
                    primary_receipt=primary,
                    replay_receipt_path=replay_path,
                    replay_receipt=replay,
                    pair_receipt_path=pair_receipt_path,
                )
            )
    if len(inventory) != 595 or len(seen_tokens) != 540 or ordinal != 595:
        raise ValueError("analysis manifest completeness totals changed")
    return {
        "schemaVersion": ANALYSIS_MANIFEST_SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "metricsIncluded": False,
        "issuedAtUtc": utc(now or dt.datetime.now(dt.timezone.utc)),
        "campaignInstanceId": protocol["executionTrust"]["campaignInstanceId"],
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "sourceContract": {
            "path": str(source_contract_path),
            "sha256": source_contract_sha256,
        },
        "finalGenerationBarrier": {
            "path": str(barrier_path),
            "sha256": sha256_file(barrier_path),
        },
        "counts": {
            "endpoints": 54,
            "generationReceipts": 432,
            "evaluationReceipts": 108,
            "pairIntegrityReceipts": 54,
            "signedReceipts": 595,
            "uniqueExecutionTokens": 540,
        },
        "signedReceiptInventory": inventory,
        "receiptMerkleRoot": _inventory_merkle_root(inventory),
        "reports": reports,
        "request": dict(request_binding),
    }


def build_analysis_authorization_payload(
    *,
    protocol_path: Path,
    manifest_path: Path,
    request_binding: Mapping[str, str],
    authorization_draft_path: Path,
    review_receipt_path: Path,
    analysis_out: Path,
    token_id: str | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    manifest_path = manifest_path.resolve()
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    source_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    source_contract_path = resolve_artifact(
        protocol["sourceContract"]["artifact"],
        anchor=REPO_ROOT,
        label="P30 source contract",
    )
    manifest = _read_signed(
        manifest_path,
        role_public_key_path(protocol["executionTrust"], "guardian"),
        "guardian",
        "P30 analysis manifest",
    )
    if (
        manifest.get("schemaVersion") != ANALYSIS_MANIFEST_SCHEMA
        or manifest.get("valid") is not True
        or manifest.get("metricsIncluded") is not False
        or manifest.get("outcomesInspected") is not False
        or manifest.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
    ):
        raise ValueError("signed P30 analysis manifest changed")
    ledger = ledger_for(protocol)
    result_root = analysis_out.resolve().parent
    expected_result_root = (
        Path("/data/share8/michaelvuaprilexperimentation/arc-v35-p30-results")
        / protocol["executionTrust"]["campaignInstanceId"]
    )
    if result_root != expected_result_root:
        raise ValueError("analysis result root changed")
    token = token_id or secrets.token_hex(32)
    moment = now or dt.datetime.now(dt.timezone.utc)
    executable = (REPO_ROOT / "ml/.venv/bin/python").resolve()
    supervisor_root = ledger / "supervisor" / token
    return {
        "schemaVersion": AUTHORIZATION_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "kind": "analysis",
        "tokenId": token,
        "campaignId": protocol["experiment"],
        "issuedAtUtc": utc(moment),
        "notBeforeUtc": utc(moment),
        "expiresAtUtc": utc(moment + dt.timedelta(hours=24)),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "sourceContract": {
            "path": str(source_contract_path),
            "sha256": source_contract_sha256,
        },
        "subject": {
            "inputManifestPath": str(manifest_path),
            "inputManifestSha256": sha256_file(manifest_path),
            "receiptMerkleRoot": manifest["receiptMerkleRoot"],
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "outcomesInspected": False,
            "privateEvaluationAuthorized": False,
            "counts": manifest["counts"],
            "authorizationDraftPath": str(authorization_draft_path.resolve()),
            "reviewReceiptPath": str(review_receipt_path.resolve()),
        },
        "command": {
            "argv": [
                str(executable),
                "ml/analyze_v35_p30_long_horizon.py",
                "--protocol",
                str(protocol_path),
                "--manifest",
                str(manifest_path),
                "--authorization",
                str((ledger / "authorizations/final-analysis.json").resolve()),
                "--out",
                str(analysis_out.resolve()),
                "--quiet",
            ],
            "cwd": str(REPO_ROOT),
            "env": {
                "HOME": "/tmp",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PYTHONHASHSEED": "0",
                "PYTHONPATH": "ml",
            },
            "executableSha256": sha256_file(executable),
        },
        "isolation": {
            "backend": "bubblewrap",
            "backendPath": protocol["executionTrust"]["bubblewrapPath"],
            "backendSha256": protocol["executionTrust"]["bubblewrapSha256"],
            "network": "none",
            "newPidNamespace": True,
            "newUserNamespace": True,
            "readOnlyPaths": sorted(
                str(path)
                for path in (
                    Path("/bin"),
                    Path("/etc"),
                    Path("/lib"),
                    Path("/lib64"),
                    Path("/usr"),
                    REPO_ROOT,
                    ledger,
                )
                if path.exists()
            ),
            "writablePaths": [str(result_root)],
            "tmpfsPaths": ["/tmp"],
            "gpuMode": "none",
            "gpuUuid": None,
            "forbiddenGpuIndices": [4, 5, 6],
        },
        "outputs": {
            "analysis": {
                "path": str(analysis_out.resolve()),
                "required": True,
                "mustBeAbsentAtStart": True,
                "childWritable": True,
            },
            "exitCode": {
                "path": str(supervisor_root / "analysis.exit-code"),
                "required": True,
                "mustBeAbsentAtStart": True,
                "childWritable": False,
            },
            "stderr": {
                "path": str(supervisor_root / "analysis.stderr"),
                "required": True,
                "mustBeAbsentAtStart": True,
                "childWritable": False,
            },
            "stdout": {
                "path": str(supervisor_root / "analysis.stdout"),
                "required": True,
                "mustBeAbsentAtStart": True,
                "childWritable": False,
            },
        },
        "ledger": {
            "root": str(ledger),
            "consumedPath": str(ledger / f"{token}.consumed.json"),
            "receiptPath": str(ledger / f"{token}.receipt.json"),
            "leasePath": protocol["executionTrust"]["leasePath"],
        },
        "predecessor": {
            "receiptPath": str(manifest_path),
            "sha256": sha256_file(manifest_path),
        },
        "request": dict(request_binding),
    }


def main() -> None:
    raise SystemExit(
        "direct analysis-bundle CLI is disabled; use role-separated custody actions"
    )


if __name__ == "__main__":
    main()
