#!/usr/bin/env python3
"""Run an exact, synthetic, one-shot P30 analyzer rehearsal."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from analyze_v35_p30_long_horizon import read_json_object
from v35_p30_analyzer_rehearsal_fixture import (
    REPO_ROOT,
    binding,
    build_fixture,
    make_request,
    sign_payload,
    write_json,
)
from v35_p30_authorized_execution import (
    analysis_launch_paths,
    build_executor_launch_permit_payload,
    normal_seal_attempt_path,
    persist_executor_launch_permit,
    prepare_execution_receipt,
    seal_execution_receipt,
    unsigned_receipt_path,
)
from v35_p30_crypto import (
    canonical_json,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)
from v35_p30_phase0 import (
    ANALYZER_REHEARSAL_COUNTS,
    ANALYZER_REHEARSAL_DIAGNOSTIC_CODES,
    ANALYZER_REHEARSAL_SCHEMA,
    validate_analyzer_rehearsal_report,
)


def evidence_binding(path: Path) -> dict[str, object]:
    return {
        "path": str(path.resolve()),
        "sha256": sha256_file(path.resolve()),
        "bytes": path.stat().st_size,
    }


def run(protocol_path: Path, output: Path) -> None:
    parent_protocol_path = protocol_path.resolve()
    output = output.resolve()
    if output.exists():
        raise FileExistsError(output)
    private_root = output.parent / ".synthetic-analysis-private-keys"
    private_root.mkdir(parents=True, exist_ok=False)
    fixture = build_fixture(
        parent_protocol_path=parent_protocol_path,
        private_key_root=private_root,
    )
    protocol = fixture["protocol"]
    synthetic_protocol_path = fixture["protocolPath"]
    ledger = fixture["ledger"]
    authorization_path = fixture["authorization"]
    authorization = fixture["authorizationPayload"]
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    private_key_paths = sorted(
        str(private.resolve()) for private, _public in fixture["keys"].values()
    )
    execution_request = make_request(
        ledger,
        name="execute-final-analysis",
        protocol_path=synthetic_protocol_path,
        campaign_id=fixture["syntheticCampaignInstanceId"],
        role="executor",
        verb="execute",
        subject={
            "logicalId": "synthetic-final-analysis",
            "authorizationPath": str(authorization_path.resolve()),
        },
        predecessor=authorization_path,
        output=receipt_path,
    )
    request_value = read_json_object(
        Path(execution_request["path"]), "synthetic analysis executor request"
    )
    permit_payload = build_executor_launch_permit_payload(
        protocol_path=synthetic_protocol_path,
        protocol=protocol,
        request=request_value,
        request_binding=execution_request,
        authorization_path=authorization_path,
    )
    executor_private, executor_public = fixture["keys"]["executor"]
    signing_fd = os.open(
        executor_private, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    )
    try:
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
        # No analysis child can read a private key: the keys live outside the
        # analyzer's read-only ledger mount and are unlinked before launch.
        for private, _public in fixture["keys"].values():
            private.unlink()
        private_root.rmdir()
        draft = prepare_execution_receipt(
            authorization_path,
            issuer_public_key_path=fixture["keys"]["issuer"][1],
            analysis_authorizer_public_key_path=fixture["keys"]["analysis-authorizer"][1],
            execution_request_binding=execution_request,
            launch_permit_path=launch_permit,
        )
        sealed = seal_execution_receipt(
            authorization_path,
            draft,
            issuer_public_key_path=fixture["keys"]["issuer"][1],
            analysis_authorizer_public_key_path=fixture["keys"]["analysis-authorizer"][1],
            executor_public_key_path=executor_public,
            executor_private_key_fd=signing_fd,
            execution_request_binding=execution_request,
        )
    finally:
        os.close(signing_fd)
    one_shot_rejected = False
    try:
        prepare_execution_receipt(
            authorization_path,
            issuer_public_key_path=fixture["keys"]["issuer"][1],
            analysis_authorizer_public_key_path=fixture["keys"]["analysis-authorizer"][1],
            execution_request_binding=execution_request,
            launch_permit_path=launch_permit,
        )
    except FileExistsError:
        one_shot_rejected = True
    if not one_shot_rejected:
        raise RuntimeError("synthetic one-shot analysis was re-enterable")
    signed_receipt = read_json_object(sealed, "synthetic signed analysis receipt")
    receipt = verify_signed_payload(
        signed_receipt,
        expected_role="executor",
        public_key_path=executor_public,
    )
    stdout_path = Path(authorization["outputs"]["stdout"]["path"])
    stderr_path = Path(authorization["outputs"]["stderr"]["path"])
    consumed_path = Path(authorization["ledger"]["consumedPath"])
    launch_intent, launch_evidence = analysis_launch_paths(
        ledger, fixture["token"]
    )
    if (
        receipt.get("valid") is not True
        or receipt.get("exitCode") != 0
        or stdout_path.stat().st_size != 0
        or stderr_path.stat().st_size != 0
        or not fixture["analysisOut"].is_file()
    ):
        raise RuntimeError("exact synthetic analyzer execution failed")
    manifest_value = verify_signed_payload(
        read_json_object(fixture["manifest"], "synthetic manifest"),
        expected_role="guardian",
        public_key_path=fixture["keys"]["guardian"][1],
    )
    counts = dict(ANALYZER_REHEARSAL_COUNTS)
    counts["gamesPerEndpoint"] = protocol["seedSchedule"]["commonPublicGames"]
    report = {
        "schemaVersion": ANALYZER_REHEARSAL_SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "syntheticDataOnly": True,
        "syntheticOutcomesAnalyzed": True,
        "analysisResultInspected": False,
        "metricsExposed": False,
        "parentCampaignInstanceId": fixture["parentProtocol"]["executionTrust"]["campaignInstanceId"],
        "syntheticCampaignInstanceId": fixture["syntheticCampaignInstanceId"],
        "protocol": evidence_binding(synthetic_protocol_path),
        "counts": counts,
        "labelPermutation": {
            "labelCount": 54,
            "exactLabelSet": set(fixture["canonicalLabels"]) == set(fixture["shuffledLabels"]),
            "nonCanonicalOrder": fixture["canonicalLabels"] != fixture["shuffledLabels"],
            "canonicalLabelOrderSha256": sha256_bytes(canonical_json(fixture["canonicalLabels"])),
            "shuffledLabelOrderSha256": sha256_bytes(canonical_json(fixture["shuffledLabels"])),
        },
        "manifest": {
            "binding": evidence_binding(fixture["manifest"]),
            "schemaVersion": manifest_value["schemaVersion"],
            "receiptMerkleRoot": manifest_value["receiptMerkleRoot"],
        },
        "analysisAuthorization": {
            "binding": evidence_binding(authorization_path),
            "kind": "analysis",
        },
        "execution": {
            "kind": "analysis",
            "tokenIdSha256": sha256_bytes(fixture["token"].encode()),
            "consumedMarker": evidence_binding(consumed_path),
            "launchIntent": evidence_binding(launch_intent),
            "launchEvidence": evidence_binding(launch_evidence),
            "capabilityConsumed": True,
            "oneShotReentryRejected": True,
            "network": "none",
            "newPidNamespace": True,
            "newUserNamespace": True,
            "newNetworkNamespace": True,
            "gpuMode": "none",
            "exitCode": 0,
        },
        "streams": {
            "stdout": evidence_binding(stdout_path),
            "stderr": evidence_binding(stderr_path),
        },
        "analysisArtifact": {
            "binding": evidence_binding(fixture["analysisOut"]),
            "contentExposed": False,
        },
        "sealing": {
            "unsignedReceipt": evidence_binding(unsigned_receipt_path(receipt_path)),
            "normalSealAttempt": evidence_binding(normal_seal_attempt_path(receipt_path)),
            "signedReceipt": evidence_binding(sealed),
            "signatureRole": "executor",
            "signatureValid": True,
            "valid": True,
        },
        "source": {
            "rehearsal": evidence_binding(Path(__file__)),
            "fixtureBuilder": evidence_binding(REPO_ROOT / "ml/v35_p30_analyzer_rehearsal_fixture.py"),
            "productionAnalyzer": evidence_binding(REPO_ROOT / "ml/analyze_v35_p30_long_horizon.py"),
            "authorizedExecution": evidence_binding(REPO_ROOT / "ml/v35_p30_authorized_execution.py"),
        },
        "cleanup": {
            "ephemeralPrivateKeysDeleted": True,
            "privateKeyPaths": private_key_paths,
        },
        "diagnosticCodes": list(ANALYZER_REHEARSAL_DIAGNOSTIC_CODES),
    }
    validate_analyzer_rehearsal_report(
        report=report,
        protocol_path=parent_protocol_path,
        protocol=fixture["parentProtocol"],
    )
    write_json(output, report)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args.protocol, args.out)


if __name__ == "__main__":
    main()
