from __future__ import annotations

import copy
import datetime as dt
import json
import os
import platform
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_campaign as campaign
from test_v35_p30_authorized_execution import AuthorizedExecutionTests
from v35_p30_authorized_execution import (
    CONSUMED_SCHEMA,
    host_boot_id,
    pre_child_recovery_attempt_path,
    prepare_execution_receipt,
    prepare_pre_child_recovery_execution,
    seal_pre_child_recovery,
)
from v35_p30_crypto import canonical_json, sha256_bytes, sha256_file, sign_payload
from v35_p30_recovery import (
    ACTIONS,
    GUARDIAN_INCIDENT_SCHEMA,
    PRE_CHILD,
    RECOVERY_LINK_SCHEMA,
    protected_bindings_sha256,
    recovery_execution_draft_path,
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


class PreChildRecoveryEndToEndTests(AuthorizedExecutionTests):
    def setUp(self) -> None:
        super().setUp()
        protocol = json.loads(self.protocol.read_text())
        schemas = protocol["executionTrust"]["roles"]["executor"][
            "allowedArtifactSchemas"
        ]
        if "arc-v35-p30-executor-launch-permit-v1" not in schemas:
            schemas.append("arc-v35-p30-executor-launch-permit-v1")
        self.protocol.write_text(json.dumps(protocol) + "\n")
        self.authorization["protocol"]["sha256"] = sha256_file(self.protocol)
        self.launch_permit = self.root / "test-launch-permit.json"

    def _sign(self, payload: dict, role: str) -> dict:
        descriptor = os.open(self.keys[role][0], os.O_RDONLY)
        try:
            return {
                **payload,
                "signature": sign_payload(
                    payload,
                    role=role,
                    private_key_fd=descriptor,
                    public_key_path=self.keys[role][1],
                ),
            }
        finally:
            os.close(descriptor)

    def _write_json(self, path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical_json(payload) + b"\n")

    def _chain(self) -> dict[str, object]:
        self.authorization["kind"] = "generation"
        self.authorization["subject"] = {
            "root": str(self.root / "league"),
            "replicate": "a",
            "arm": "baseline",
            "generation": 1,
            "protocolSha256": sha256_file(self.protocol),
        }
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        issuer_request_path = Path(self.authorization["request"]["path"])
        issuer_request = json.loads(issuer_request_path.read_text())
        issuer_request["verb"] = "issue-generation"
        issuer_request["protocol"] = self.authorization["protocol"]
        self._write_json(issuer_request_path, issuer_request)
        self.authorization["request"]["sha256"] = sha256_file(issuer_request_path)
        original_path, executor_descriptor, normal_execution_binding = (
            self._write_authorization()
        )
        os.close(executor_descriptor)
        stdout_path = Path(self.authorization["outputs"]["stdout"]["path"])
        real_open = os.open

        def fail_stdout(path: object, flags: int, mode: int = 0o777) -> int:
            if Path(path) == stdout_path:
                raise OSError("objective PRE_CHILD injection")
            return real_open(path, flags, mode)

        with (
            mock.patch(
                "v35_p30_authorized_execution.os.open", side_effect=fail_stdout
            ),
            mock.patch(
                "v35_p30_authorized_execution.validate_executor_launch_permit"
            ),
            self.assertRaisesRegex(RuntimeError, "guardian PRE_CHILD"),
        ):
            prepare_execution_receipt(
                original_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                execution_request_binding=normal_execution_binding,
                launch_permit_path=self.launch_permit,
            )
        original_signed = json.loads(original_path.read_text())
        original = {key: value for key, value in original_signed.items() if key != "signature"}
        original_receipt = Path(original["ledger"]["receiptPath"])
        recovery_draft_path = recovery_execution_draft_path(original_receipt)
        recovery_draft = json.loads(recovery_draft_path.read_text())
        recovery_root = Path(original["ledger"]["root"]) / "recovery" / original["tokenId"]
        incident_path = recovery_root / "incident.signed.json"
        incident = {
            "schemaVersion": GUARDIAN_INCIDENT_SCHEMA,
            "immutable": True,
            "outcomeBlind": True,
            "promotionEligible": False,
            "recoveryPermitted": True,
            "campaignId": original["campaignId"],
            "kind": original["kind"],
            "originalTokenId": original["tokenId"],
            "recoveryClass": PRE_CHILD,
            "diagnosticCode": recovery_draft["diagnosticCode"],
            "classifiedAtUtc": utc_now(),
            "attemptOrdinal": 1,
            "action": ACTIONS[PRE_CHILD],
            "executionDraftSha256": sha256_bytes(canonical_json(recovery_draft)),
            "authorizationSha256": recovery_draft["authorization"]["sha256"],
            "consumedMarkerSha256": recovery_draft["consumedMarker"]["sha256"],
            "protectedBindingsSha256": protected_bindings_sha256(original),
            "candidateCodeMayRun": True,
            "seedMayBeReused": True,
            "secondRecoveryForbidden": True,
        }
        incident_signed = self._sign(incident, "guardian")
        self._write_json(incident_path, incident_signed)
        incident_binding = {"path": str(incident_path), "sha256": sha256_file(incident_path)}
        incident_attestation_path = recovery_root / "incident-attestation.signed.json"
        incident_request_path = Path(original["ledger"]["root"]) / "requests/recovery-incident.json"
        incident_request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": original["protocol"],
            "role": "guardian",
            "verb": "attest-recovery-incident",
            "subject": {"logicalId": "recovery-incident"},
            "predecessorSha256": sha256_file(recovery_draft_path),
            "expectedOutputPath": str(incident_attestation_path),
            "requestNonce": "5" * 64,
        }
        self._write_json(incident_request_path, incident_request)
        incident_request_binding = {
            "path": str(incident_request_path),
            "sha256": sha256_file(incident_request_path),
        }
        incident_attestation = self._sign(
            {
                "schemaVersion": "arc-v35-p30-logical-completion-v1",
                "phase": "incident",
                "valid": True,
                "immutable": True,
                "outcomeBlind": True,
                "outcomesInspected": False,
                "promotionEligible": False,
                "campaignId": original["campaignId"],
                "kind": original["kind"],
                "originalTokenId": original["tokenId"],
                "recoveryClass": PRE_CHILD,
                "attemptOrdinal": 1,
                "artifact": incident_binding,
                "issuedAtUtc": utc_now(),
                "secondRecoveryForbidden": True,
                "request": incident_request_binding,
            },
            "guardian",
        )
        self._write_json(incident_attestation_path, incident_attestation)

        recovery_token = "b" * 64
        replacement_path = recovery_root / "replacement-authorization.signed.json"
        issue_request_path = Path(original["ledger"]["root"]) / "requests/recovery-issue.json"
        issue_subject = {
            "logicalId": "recovery-issue",
            "originalAuthorizationPath": str(original_path),
            "executionDraft": {
                "path": str(recovery_draft_path),
                "sha256": sha256_file(recovery_draft_path),
            },
            "guardianIncident": incident_binding,
            "incidentAttestation": {
                "path": str(incident_attestation_path),
                "sha256": sha256_file(incident_attestation_path),
            },
            "recoveryClass": PRE_CHILD,
            "recoveryOrdinal": 1,
            "recoveryTokenId": recovery_token,
        }
        issue_request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": original["protocol"],
            "role": "issuer",
            "verb": "issue-recovery",
            "subject": issue_subject,
            "predecessorSha256": sha256_file(incident_attestation_path),
            "expectedOutputPath": str(replacement_path),
            "requestNonce": "7" * 64,
        }
        self._write_json(issue_request_path, issue_request)
        replacement = copy.deepcopy(original)
        replacement["tokenId"] = recovery_token
        now = dt.datetime.now(dt.timezone.utc)
        replacement["issuedAtUtc"] = (now - dt.timedelta(seconds=1)).isoformat().replace(
            "+00:00", "Z"
        )
        replacement["notBeforeUtc"] = replacement["issuedAtUtc"]
        replacement["expiresAtUtc"] = (now + dt.timedelta(minutes=30)).isoformat().replace(
            "+00:00", "Z"
        )
        replacement["ledger"]["consumedPath"] = str(
            Path(original["ledger"]["root"]) / f"{recovery_token}.consumed.json"
        )
        replacement["ledger"]["receiptPath"] = str(
            Path(original["ledger"]["root"]) / f"{recovery_token}.receipt.json"
        )
        replacement["request"] = {
            "path": str(issue_request_path),
            "sha256": sha256_file(issue_request_path),
        }
        self.assertEqual(
            protected_bindings_sha256(replacement), protected_bindings_sha256(original)
        )
        self._write_json(replacement_path, self._sign(replacement, "issuer"))

        link_path = recovery_root / "link.json"
        link = {
            "schemaVersion": RECOVERY_LINK_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "campaignId": original["campaignId"],
            "kind": original["kind"],
            "recoveryClass": PRE_CHILD,
            "action": ACTIONS[PRE_CHILD],
            "attemptOrdinal": 1,
            "originalTokenId": original["tokenId"],
            "recoveryTokenId": recovery_token,
            "guardianIncidentPayloadSha256": sha256_bytes(canonical_json(incident)),
            "originalAuthorizationSha256": recovery_draft["authorization"]["sha256"],
            "replacementAuthorizationPayloadSha256": sha256_bytes(
                canonical_json(replacement)
            ),
            "protectedBindingsSha256": protected_bindings_sha256(original),
            "candidateCodeMayRun": True,
            "secondRecoveryForbidden": True,
        }
        self._write_json(link_path, link)
        link_binding = {"path": str(link_path), "sha256": sha256_file(link_path)}
        link_attestation_path = recovery_root / "link-attestation.signed.json"
        link_request_path = Path(original["ledger"]["root"]) / "requests/recovery-link.json"
        link_request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": original["protocol"],
            "role": "guardian",
            "verb": "attest-recovery-link",
            "subject": {"logicalId": "recovery-link"},
            "predecessorSha256": sha256_file(incident_attestation_path),
            "expectedOutputPath": str(link_attestation_path),
            "requestNonce": "4" * 64,
        }
        self._write_json(link_request_path, link_request)
        link_request_binding = {
            "path": str(link_request_path),
            "sha256": sha256_file(link_request_path),
        }
        link_attestation = self._sign(
            {
                "schemaVersion": "arc-v35-p30-logical-completion-v1",
                "phase": "link",
                "valid": True,
                "immutable": True,
                "outcomeBlind": True,
                "outcomesInspected": False,
                "promotionEligible": False,
                "campaignId": original["campaignId"],
                "kind": original["kind"],
                "originalTokenId": original["tokenId"],
                "recoveryClass": PRE_CHILD,
                "attemptOrdinal": 1,
                "artifact": link_binding,
                "issuedAtUtc": utc_now(),
                "secondRecoveryForbidden": True,
                "request": link_request_binding,
            },
            "guardian",
        )
        self._write_json(link_attestation_path, link_attestation)

        execute_request_path = Path(original["ledger"]["root"]) / "requests/recovery-execute.json"
        execute_request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": original["protocol"],
            "role": "executor",
            "verb": "execute-recovery",
            "subject": {
                "logicalId": "recovery-execute",
                "authorizationPath": str(replacement_path),
                "originalAuthorizationPath": str(original_path),
                "executionDraft": issue_subject["executionDraft"],
                "guardianIncident": incident_binding,
                "recoveryLink": link_binding,
                "linkAttestation": {
                    "path": str(link_attestation_path),
                    "sha256": sha256_file(link_attestation_path),
                },
                "recoveryOrdinal": 1,
                "recoveryTokenId": recovery_token,
            },
            "predecessorSha256": sha256_file(link_attestation_path),
            "expectedOutputPath": replacement["ledger"]["receiptPath"],
            "requestNonce": "6" * 64,
        }
        self._write_json(execute_request_path, execute_request)
        return {
            "originalPath": original_path,
            "replacementPath": replacement_path,
            "replacement": replacement,
            "draftPath": recovery_draft_path,
            "incidentPath": incident_path,
            "linkPath": link_path,
            "linkAttestationPath": link_attestation_path,
            "executionBinding": {
                "path": str(execute_request_path),
                "sha256": sha256_file(execute_request_path),
            },
            "original": original,
            "recoveryRoot": recovery_root,
        }

    def _prepare_keywords(self, chain: dict[str, object]) -> dict[str, object]:
        return {
            "issuer_public_key_path": self.public,
            "analysis_authorizer_public_key_path": self.keys["analysis-authorizer"][1],
            "guardian_public_key_path": self.keys["guardian"][1],
            "execution_request_binding": chain["executionBinding"],
        }

    def _write_completion(
        self, chain: dict[str, object], receipt_path: Path
    ) -> Path:
        original = chain["original"]
        replacement_path = chain["replacementPath"]
        recovery_root = chain["recoveryRoot"]
        incident_attestation_path = recovery_root / "incident-attestation.signed.json"
        link_attestation_path = chain["linkAttestationPath"]
        completion_path = recovery_root / "completion.signed.json"
        request_path = Path(original["ledger"]["root"]) / "requests/recovery-completion.json"
        request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": original["protocol"],
            "role": "guardian",
            "verb": "attest-recovery-completion",
            "subject": {"logicalId": "recovery-completion"},
            "predecessorSha256": sha256_file(link_attestation_path),
            "expectedOutputPath": str(completion_path),
            "requestNonce": "3" * 64,
        }
        self._write_json(request_path, request)
        payload = {
            "schemaVersion": "arc-v35-p30-logical-completion-v1",
            "phase": "completion",
            "valid": True,
            "immutable": True,
            "outcomeBlind": True,
            "outcomesInspected": False,
            "promotionEligible": False,
            "campaignId": original["campaignId"],
            "kind": original["kind"],
            "originalTokenId": original["tokenId"],
            "recoveryTokenId": chain["replacement"]["tokenId"],
            "recoveryClass": PRE_CHILD,
            "attemptOrdinal": 1,
            "incidentAttestation": {
                "path": str(incident_attestation_path),
                "sha256": sha256_file(incident_attestation_path),
            },
            "linkAttestation": {
                "path": str(link_attestation_path),
                "sha256": sha256_file(link_attestation_path),
            },
            "completedAuthorization": {
                "path": str(replacement_path),
                "sha256": sha256_file(replacement_path),
            },
            "executionReceipt": {
                "path": str(receipt_path),
                "sha256": sha256_file(receipt_path),
            },
            "completedAtUtc": utc_now(),
            "secondRecoveryForbidden": True,
            "request": {"path": str(request_path), "sha256": sha256_file(request_path)},
        }
        self._write_json(completion_path, self._sign(payload, "guardian"))
        return completion_path

    def test_full_pre_child_recovery_executes_and_seals_once(self) -> None:
        chain = self._chain()
        arguments = (
            chain["replacementPath"],
            chain["originalPath"],
            chain["draftPath"],
            chain["incidentPath"],
            chain["linkPath"],
            chain["linkAttestationPath"],
        )
        with mock.patch(
            "v35_p30_authorized_execution.validate_executor_launch_permit"
        ):
            draft_path = prepare_pre_child_recovery_execution(
                *arguments,
                **self._prepare_keywords(chain),
                launch_permit_path=self.launch_permit,
            )
        descriptor = os.open(self.keys["executor"][0], os.O_RDONLY)
        try:
            receipt_path = seal_pre_child_recovery(
                chain["replacementPath"],
                draft_path,
                chain["originalPath"],
                chain["draftPath"],
                chain["incidentPath"],
                chain["linkPath"],
                chain["linkAttestationPath"],
                **self._prepare_keywords(chain),
                executor_public_key_path=self.keys["executor"][1],
                executor_private_key_fd=descriptor,
            )
        finally:
            os.close(descriptor)
        self.assertTrue(receipt_path.is_file())
        self.assertTrue(pre_child_recovery_attempt_path(receipt_path).is_file())
        self._write_completion(chain, receipt_path)
        protocol = json.loads(self.protocol.read_text())
        recovered_path, recovered_receipt = campaign.validate_completed_execution(
            authorization_path=chain["originalPath"],
            authorization=chain["original"],
            protocol=protocol,
        )
        self.assertEqual(recovered_path, receipt_path)
        self.assertTrue(recovered_receipt["valid"])
        with (
            mock.patch.object(
                campaign,
                "generation_authorization_path",
                return_value=chain["originalPath"],
            ),
            mock.patch.object(
                campaign,
                "root_for",
                return_value=Path(chain["original"]["subject"]["root"]),
            ),
            mock.patch.object(
                campaign,
                "validate_stored_authorization",
                return_value=chain["original"],
            ),
        ):
            predecessor = campaign.predecessor_for_generation(
                self.protocol, protocol, "a", "baseline", 2
            )
        self.assertEqual(predecessor, receipt_path)
        attempt_path = pre_child_recovery_attempt_path(receipt_path)
        attempt = json.loads(attempt_path.read_text())
        tampered_attempt = copy.deepcopy(attempt)
        tampered_attempt["recoveryLink"]["sha256"] = "0" * 64
        self._write_json(attempt_path, tampered_attempt)
        with self.assertRaisesRegex(ValueError, "attempt marker changed"):
            campaign.validate_completed_execution(
                authorization_path=chain["originalPath"],
                authorization=chain["original"],
                protocol=protocol,
            )
        self._write_json(attempt_path, attempt)
        with (
            mock.patch("v35_p30_authorized_execution.subprocess.Popen") as spawn,
            self.assertRaisesRegex(RuntimeError, "already attempted"),
        ):
            prepare_pre_child_recovery_execution(
                *arguments,
                **self._prepare_keywords(chain),
                launch_permit_path=self.launch_permit,
            )
        spawn.assert_not_called()

    def test_popen_ambiguity_is_terminal_and_never_creates_nested_recovery(self) -> None:
        chain = self._chain()
        arguments = (
            chain["replacementPath"],
            chain["originalPath"],
            chain["draftPath"],
            chain["incidentPath"],
            chain["linkPath"],
            chain["linkAttestationPath"],
        )
        with (
            mock.patch(
                "v35_p30_authorized_execution.subprocess.Popen",
                side_effect=OSError("ambiguous Popen failure"),
            ),
            mock.patch(
                "v35_p30_authorized_execution.validate_executor_launch_permit"
            ),
            self.assertRaisesRegex(RuntimeError, "cannot be retried"),
        ):
            prepare_pre_child_recovery_execution(
                *arguments,
                **self._prepare_keywords(chain),
                launch_permit_path=self.launch_permit,
            )
        replacement_receipt = Path(chain["replacement"]["ledger"]["receiptPath"])
        self.assertTrue(pre_child_recovery_attempt_path(replacement_receipt).is_file())
        self.assertFalse(recovery_execution_draft_path(replacement_receipt).exists())
        with mock.patch("v35_p30_authorized_execution.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "already attempted"):
                prepare_pre_child_recovery_execution(
                    *arguments,
                    **self._prepare_keywords(chain),
                    launch_permit_path=self.launch_permit,
                )
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
