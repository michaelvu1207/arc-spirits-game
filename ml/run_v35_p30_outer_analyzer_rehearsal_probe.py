#!/usr/bin/env python3
"""Run the exact P30 analyzer rehearsal through its production outer sandbox.

This is a disposable, synthetic-only host probe.  It uses the production
preflight issuer, executor launch permit, bubblewrap supervisor, receipt seal,
and nested analyzer rehearsal without touching a production campaign identity.
"""

from __future__ import annotations

import argparse
import copy
import os
from pathlib import Path
from typing import Any, Mapping

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    read_json_object,
    validate_initial_policy_artifacts,
    validate_protocol,
)
from issue_v35_p30_preflight_authorization import build as build_preflight_authorization
from v35_p30_analyzer_rehearsal_fixture import (
    ROLE_POLICIES,
    binding,
    generate_keypair,
    make_request,
    sign_payload,
    sign_to,
    trust_roles,
    write_bytes,
    write_json,
)
from v35_p30_authorized_execution import (
    build_executor_launch_permit_payload,
    normal_seal_attempt_path,
    persist_executor_launch_permit,
    prepare_execution_receipt,
    seal_execution_receipt,
    unsigned_receipt_path,
)
from v35_p30_crypto import canonical_json, sha256_bytes, sha256_file, verify_signed_payload
from v35_p30_phase0 import (
    ANALYZER_REHEARSAL_SCHEMA,
    analyzer_rehearsal_campaign_id,
    analyzer_rehearsal_ledger_root,
    analyzer_rehearsal_result_root,
    artifact_root,
    ledger_for,
    phase0_authorization_path,
    phase0_output_root,
    validate_analyzer_rehearsal_report,
)


OUTER_PROBE_SCHEMA = "arc-v35-p30-outer-analyzer-rehearsal-probe-v1"
OUTER_PROBE_DIAGNOSTIC_CODES = (
    "EXACT_PRODUCTION_PREFLIGHT_ISSUER_USED",
    "EXACT_OUTER_BUBBLEWRAP_EXECUTED",
    "OUTER_NVIDIA_PROC_SUBMOUNT_ABSENT",
    "NESTED_ANALYZER_REHEARSAL_VALIDATED",
    "OUTER_EXECUTOR_RECEIPT_SIGNED_AND_SEALED",
    "OUTER_ONE_SHOT_REENTRY_REJECTED",
    "OUTER_STDOUT_STDERR_EMPTY",
    "NO_GPU_AUTHORIZED_OR_USED",
    "SYNTHETIC_ANALYSIS_RESULT_COMMITTED_NOT_INSPECTED",
    "ALL_EPHEMERAL_PRIVATE_KEYS_DELETED",
)


def evidence(path: Path) -> dict[str, Any]:
    path = path.resolve()
    return {
        "path": str(path),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
    }


def _require_probe_id(value: str) -> str:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError("outer analyzer probe ID is malformed")
    return value


def _require_staging_root(path: Path, probe_id: str) -> Path:
    path = path.absolute()
    repo = REPO_ROOT.resolve()
    if path.name != probe_id or repo not in path.parent.resolve().parents:
        raise ValueError("outer analyzer probe staging root must be a unique repository child")
    if path.exists():
        raise FileExistsError(path)
    return path


def _delete_private_material(
    keys: Mapping[str, tuple[Path, Path]], private_root: Path
) -> None:
    for private, _public in keys.values():
        private.unlink(missing_ok=True)
    for residue in private_root.glob("*") if private_root.exists() else ():
        residue.unlink(missing_ok=True)
    if private_root.exists():
        private_root.rmdir()


def _build_disposable_protocol(
    *, parent_path: Path, probe_id: str, staging_root: Path, private_root: Path
) -> tuple[Path, dict[str, Any], dict[str, tuple[Path, Path]]]:
    parent_path = parent_path.resolve()
    parent = read_json_object(parent_path, "P30 outer-probe parent protocol")
    validate_protocol(parent, require_authorized=True)
    validate_initial_policy_artifacts(parent, protocol_path=parent_path)
    staging_root.mkdir(parents=True, exist_ok=False)
    public_root = staging_root / "public"
    public_root.mkdir()
    private_root.mkdir(parents=True, exist_ok=False)
    keys: dict[str, tuple[Path, Path]] = {}
    for role in ROLE_POLICIES:
        private, generated_public = generate_keypair(private_root, role)
        public = public_root / f"{role}.pem"
        write_bytes(public, generated_public.read_bytes())
        generated_public.unlink()
        keys[role] = (private, public)
    protocol = copy.deepcopy(parent)
    protocol["executionTrust"]["campaignInstanceId"] = probe_id
    protocol["executionTrust"]["roles"] = trust_roles(keys)
    protocol_path = staging_root / "protocol.json"
    write_json(protocol_path, protocol)
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    return protocol_path, protocol, keys


def _assert_fresh_roots(protocol: Mapping[str, Any]) -> None:
    roots = (
        ledger_for(protocol),
        artifact_root(protocol),
        analyzer_rehearsal_ledger_root(protocol),
        analyzer_rehearsal_result_root(protocol),
    )
    if len({str(path.resolve()) for path in roots}) != len(roots):
        raise ValueError("outer analyzer probe roots overlap")
    for root in roots:
        if root.exists():
            raise FileExistsError(root)


def run(parent_protocol_path: Path, probe_id: str, staging_root: Path) -> Path:
    probe_id = _require_probe_id(probe_id)
    staging_root = _require_staging_root(staging_root, probe_id)
    output = staging_root / "outer-probe-report.json"
    private_root = Path("/tmp") / f"arc-v35-p30-outer-analyzer-probe-{probe_id}"
    if private_root.exists():
        raise FileExistsError(private_root)
    keys: dict[str, tuple[Path, Path]] = {}
    signing_fd: int | None = None
    try:
        protocol_path, protocol, keys = _build_disposable_protocol(
            parent_path=parent_protocol_path,
            probe_id=probe_id,
            staging_root=staging_root,
            private_root=private_root,
        )
        _assert_fresh_roots(protocol)
        ledger = ledger_for(protocol)
        for directory in (
            ledger / "authorizations",
            ledger / "launch-permits",
            ledger / "requests",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        name = "analyzer-rehearsal"
        phase_root = phase0_output_root(protocol, name)
        authorization_path = phase0_authorization_path(protocol, name)
        issuer_request = make_request(
            ledger,
            name="outer-analyzer-rehearsal-issuer",
            protocol_path=protocol_path,
            campaign_id=probe_id,
            role="issuer",
            verb="issue-preflight-execution",
            subject={
                "logicalId": "outer-analyzer-rehearsal-issuer",
                "name": name,
                "root": str(phase_root),
                "replicate": "phase0",
                "arm": name,
            },
            predecessor=None,
            output=authorization_path,
        )
        authorization_payload = build_preflight_authorization(
            protocol_path=protocol_path,
            name=name,
            public_key_path=keys["issuer"][1],
            request_binding=issuer_request,
            token_id=sha256_bytes(
                canonical_json(
                    {
                        "domain": "arc-v35-p30-outer-analyzer-probe-token-v1",
                        "probeId": probe_id,
                    }
                )
            ),
        )
        if "/proc/driver/nvidia" in authorization_payload["isolation"]["readOnlyPaths"]:
            raise RuntimeError("outer analyzer authorization retained NVIDIA proc submount")
        sign_to(
            authorization_path,
            authorization_payload,
            role="issuer",
            keys=keys,
        )
        receipt_path = Path(authorization_payload["ledger"]["receiptPath"])
        execution_request = make_request(
            ledger,
            name="outer-analyzer-rehearsal-executor",
            protocol_path=protocol_path,
            campaign_id=probe_id,
            role="executor",
            verb="execute",
            subject={
                "logicalId": "outer-analyzer-rehearsal-executor",
                "authorizationPath": str(authorization_path),
            },
            predecessor=authorization_path,
            output=receipt_path,
        )
        request_value = read_json_object(
            Path(execution_request["path"]), "outer analyzer executor request"
        )
        permit_payload = build_executor_launch_permit_payload(
            protocol_path=protocol_path,
            protocol=protocol,
            request=request_value,
            request_binding=execution_request,
            authorization_path=authorization_path,
        )
        executor_private, executor_public = keys["executor"]
        signing_fd = os.open(
            executor_private, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        )
        permit_fd = os.dup(signing_fd)
        try:
            signed_permit = dict(permit_payload)
            signed_permit["signature"] = sign_payload(
                signed_permit,
                role="executor",
                private_key_fd=permit_fd,
                public_key_path=executor_public,
            )
        finally:
            os.close(permit_fd)
        launch_permit = persist_executor_launch_permit(
            signed_permit,
            expected_payload=permit_payload,
            protocol=protocol,
        )
        private_paths = sorted(str(private.resolve()) for private, _public in keys.values())
        _delete_private_material(keys, private_root)
        draft = prepare_execution_receipt(
            authorization_path,
            issuer_public_key_path=keys["issuer"][1],
            analysis_authorizer_public_key_path=keys["analysis-authorizer"][1],
            execution_request_binding=execution_request,
            launch_permit_path=launch_permit,
        )
        sealed = seal_execution_receipt(
            authorization_path,
            draft,
            issuer_public_key_path=keys["issuer"][1],
            analysis_authorizer_public_key_path=keys["analysis-authorizer"][1],
            executor_public_key_path=executor_public,
            executor_private_key_fd=signing_fd,
            execution_request_binding=execution_request,
        )
        os.close(signing_fd)
        signing_fd = None
        one_shot_rejected = False
        try:
            prepare_execution_receipt(
                authorization_path,
                issuer_public_key_path=keys["issuer"][1],
                analysis_authorizer_public_key_path=keys["analysis-authorizer"][1],
                execution_request_binding=execution_request,
                launch_permit_path=launch_permit,
            )
        except FileExistsError:
            one_shot_rejected = True
        if not one_shot_rejected:
            raise RuntimeError("outer analyzer rehearsal was re-enterable")
        signed_receipt = read_json_object(sealed, "outer analyzer signed receipt")
        receipt = verify_signed_payload(
            signed_receipt,
            expected_role="executor",
            public_key_path=executor_public,
        )
        inner_report_path = Path(authorization_payload["outputs"]["report"]["path"])
        inner_report = read_json_object(inner_report_path, "nested analyzer rehearsal report")
        validate_analyzer_rehearsal_report(
            report=inner_report,
            protocol_path=protocol_path,
            protocol=protocol,
        )
        stdout_path = Path(authorization_payload["outputs"]["stdout"]["path"])
        stderr_path = Path(authorization_payload["outputs"]["stderr"]["path"])
        if (
            receipt.get("valid") is not True
            or receipt.get("exitCode") != 0
            or receipt.get("gpuBefore") is not None
            or receipt.get("gpuAfter") is not None
            or receipt.get("gpuEmptyAfter") is not True
            or receipt.get("leaseReleased") is not True
            or receipt.get("isolation", {}).get("gpuMode") != "none"
            or "/proc/driver/nvidia"
            in receipt.get("isolation", {}).get("readOnlyPaths", [])
            or stdout_path.stat().st_size != 0
            or stderr_path.stat().st_size != 0
            or any(Path(path).exists() for path in private_paths)
            or private_root.exists()
        ):
            raise RuntimeError("outer analyzer rehearsal evidence is invalid")
        report = {
            "schemaVersion": OUTER_PROBE_SCHEMA,
            "valid": True,
            "immutable": True,
            "promotionEligible": False,
            "outcomesInspected": False,
            "syntheticDataOnly": True,
            "analysisResultInspected": False,
            "metricsExposed": False,
            "probeId": probe_id,
            "parentCampaignInstanceId": read_json_object(
                parent_protocol_path.resolve(), "outer probe parent protocol"
            )["executionTrust"]["campaignInstanceId"],
            "syntheticCampaignInstanceId": analyzer_rehearsal_campaign_id(protocol),
            "protocol": evidence(protocol_path),
            "authorization": {
                "binding": evidence(authorization_path),
                "exactProductionIssuer": True,
                "name": name,
                "nvidiaProcSubmountAbsent": True,
            },
            "execution": {
                "binding": evidence(sealed),
                "unsignedReceipt": evidence(unsigned_receipt_path(receipt_path)),
                "normalSealAttempt": evidence(normal_seal_attempt_path(receipt_path)),
                "consumedMarker": evidence(
                    Path(authorization_payload["ledger"]["consumedPath"])
                ),
                "launchPermit": evidence(launch_permit),
                "exactProductionExecutor": True,
                "oneShotReentryRejected": True,
                "gpuMode": "none",
                "gpuUsed": False,
                "exitCode": 0,
            },
            "streams": {
                "stdout": evidence(stdout_path),
                "stderr": evidence(stderr_path),
            },
            "nestedRehearsal": {
                "binding": evidence(inner_report_path),
                "schemaVersion": ANALYZER_REHEARSAL_SCHEMA,
                "valid": True,
                "analysisResultInspected": False,
                "metricsExposed": False,
            },
            "roots": {
                "outerLedger": str(ledger.resolve()),
                "outerArtifacts": str(artifact_root(protocol).resolve()),
                "syntheticLedger": str(analyzer_rehearsal_ledger_root(protocol).resolve()),
                "syntheticResults": str(analyzer_rehearsal_result_root(protocol).resolve()),
            },
            "source": {
                "probeRunner": evidence(Path(__file__)),
                "preflightIssuer": evidence(
                    REPO_ROOT / "ml/issue_v35_p30_preflight_authorization.py"
                ),
                "authorizedExecution": evidence(
                    REPO_ROOT / "ml/v35_p30_authorized_execution.py"
                ),
                "rehearsal": evidence(
                    REPO_ROOT / "ml/run_v35_p30_analyzer_rehearsal.py"
                ),
                "productionAnalyzer": evidence(
                    REPO_ROOT / "ml/analyze_v35_p30_long_horizon.py"
                ),
            },
            "cleanup": {
                "ephemeralPrivateKeysDeleted": True,
                "privateKeyPaths": private_paths,
            },
            "diagnosticCodes": list(OUTER_PROBE_DIAGNOSTIC_CODES),
        }
        write_json(output, report)
        return output
    finally:
        if signing_fd is not None:
            os.close(signing_fd)
        _delete_private_material(keys, private_root)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-protocol", type=Path, required=True)
    parser.add_argument("--probe-id", required=True)
    parser.add_argument("--staging-root", type=Path, required=True)
    args = parser.parse_args()
    run(args.parent_protocol, args.probe_id, args.staging_root)


if __name__ == "__main__":
    main()
