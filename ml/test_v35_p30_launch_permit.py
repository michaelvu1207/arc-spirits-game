from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import sign_v35_p30_launch_permit_local as local_signer
import v35_p30_authorized_execution as execution
from v35_p30_crypto import canonical_json, public_key_identity, sha256_file


class ExecutorLaunchPermitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.ledger = self.root / "ledger" / ("c" * 64)
        (self.ledger / "requests").mkdir(parents=True)
        private = Ed25519PrivateKey.generate()
        self.private_key = private
        self.public_path = self.root / "executor-public.pem"
        self.public_path.write_bytes(
            private.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        key_id, der_hash = public_key_identity(self.public_path)
        self.protocol_path = self.root / "protocol.json"
        self.protocol = {
            "executionTrust": {
                "campaignInstanceId": "c" * 64,
                "ledgerRoot": str(self.root / "ledger"),
                "roles": {
                    "executor": {
                        "publicKeyPath": str(self.public_path),
                        "keyId": key_id,
                        "publicKeyDerSha256": der_hash,
                    }
                },
            },
            "sourceContract": {
                "schemaVersion": "arc-v35-p30-source-lock-v1",
                "artifact": str(self.root / "source-lock.json"),
                "sha256": "d" * 64,
            },
        }
        self.protocol_path.write_bytes(canonical_json(self.protocol) + b"\n")
        self.authorization_path = self.ledger / "authorization.json"
        self.receipt_path = self.ledger / ("e" * 64 + ".receipt.json")
        self.authorization = {
            "kind": "generation",
            "tokenId": "e" * 64,
            "sourceContract": {
                "path": str(self.root / "source-lock.json"),
                "sha256": "d" * 64,
            },
            "protocol": {
                "path": str(self.protocol_path),
                "sha256": sha256_file(self.protocol_path),
            },
            "ledger": {
                "root": str(self.ledger),
                "consumedPath": str(self.ledger / ("e" * 64 + ".consumed.json")),
                "receiptPath": str(self.receipt_path),
                "leasePath": str(self.root / "lease"),
            },
        }
        self.authorization_path.write_bytes(canonical_json(self.authorization) + b"\n")
        self.request_path = self.ledger / "requests" / "execute.json"
        self.request = {
            "role": "executor",
            "verb": "execute",
            "expectedOutputPath": str(self.receipt_path),
        }
        self.request_path.write_bytes(canonical_json(self.request) + b"\n")
        self.binding = {
            "path": str(self.request_path),
            "sha256": sha256_file(self.request_path),
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _challenge(self) -> dict:
        identity = {
            "pid": 101,
            "startTicks": 202,
            "uid": 303,
            "gid": 404,
            "host": "simforge-test",
            "bootId": "b" * 32,
        }
        with mock.patch.object(
            execution, "executor_process_identity", return_value=identity
        ):
            return execution.build_executor_launch_permit_payload(
                protocol_path=self.protocol_path,
                protocol=self.protocol,
                request=self.request,
                request_binding=self.binding,
                authorization_path=self.authorization_path,
            )

    def test_signed_permit_is_process_bound_and_o_excl(self) -> None:
        challenge = self._challenge()
        signed = local_signer.sign(challenge, self.private_key)
        permit_path = execution.persist_executor_launch_permit(
            signed, expected_payload=challenge, protocol=self.protocol
        )
        with (
            mock.patch.object(execution, "validate_frozen_working_source"),
            mock.patch.object(
                execution,
                "executor_process_identity",
                return_value=challenge["executorProcess"],
            ),
        ):
            observed = execution.validate_executor_launch_permit(
                permit_path,
                authorization_path=self.authorization_path,
                authorization=self.authorization,
                protocol=self.protocol,
                execution_request_binding=self.binding,
                expected_request_verb="execute",
            )
        self.assertEqual(observed, challenge)
        with self.assertRaises(FileExistsError):
            execution.persist_executor_launch_permit(
                signed, expected_payload=challenge, protocol=self.protocol
            )
        stale_identity = dict(challenge["executorProcess"])
        stale_identity["pid"] += 1
        with (
            mock.patch.object(
                execution, "executor_process_identity", return_value=stale_identity
            ),
            mock.patch.object(execution, "validate_frozen_working_source"),
            self.assertRaisesRegex(ValueError, "forged, replayed, or stale"),
        ):
            execution.validate_executor_launch_permit(
                permit_path,
                authorization_path=self.authorization_path,
                authorization=self.authorization,
                protocol=self.protocol,
                execution_request_binding=self.binding,
                expected_request_verb="execute",
            )

    def test_direct_prepare_without_permit_fails_before_consumption_or_popen(self) -> None:
        full_request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "c" * 64,
            "protocol": self.authorization["protocol"],
            "role": "executor",
            "verb": "execute",
            "subject": {"authorizationPath": str(self.authorization_path)},
            "predecessorSha256": sha256_file(self.authorization_path),
            "expectedOutputPath": str(self.receipt_path),
            "requestNonce": "a" * 64,
        }
        self.request_path.write_bytes(canonical_json(full_request) + b"\n")
        self.binding["sha256"] = sha256_file(self.request_path)
        with (
            mock.patch.object(
                execution, "validate_authorization", return_value=self.authorization
            ),
            mock.patch.object(execution.subprocess, "Popen") as popen,
            self.assertRaisesRegex(RuntimeError, "launch permit is required"),
        ):
            execution.prepare_execution_receipt(
                self.authorization_path,
                issuer_public_key_path=self.public_path,
                analysis_authorizer_public_key_path=self.public_path,
                execution_request_binding=self.binding,
            )
        self.assertFalse(Path(self.authorization["ledger"]["consumedPath"]).exists())
        popen.assert_not_called()

    def test_analysis_intent_binds_permit_hash_without_key_material(self) -> None:
        permit = self.ledger / "permit.json"
        permit.write_text("permit\n")
        consumed = self.ledger / "consumed.json"
        consumed.write_text("consumed\n")
        with mock.patch.object(
            execution,
            "_supervisor_namespace_evidence",
            return_value={
                "pid": 1,
                "uid": 1,
                "gid": 1,
                "bootId": "boot",
                "startTicks": 1,
                "namespaces": {"pid": "p", "user": "u", "network": "n"},
            },
        ):
            intent = execution._analysis_launch_intent(
                authorization_path=self.authorization_path,
                authorization={
                    "tokenId": "e" * 64,
                    "campaignId": "campaign",
                },
                consumed_path=consumed,
                capability_sha256="f" * 64,
                intent_path=self.ledger / "intent.json",
                evidence_path=self.ledger / "evidence.json",
                launch_permit_path=permit,
            )
        self.assertEqual(
            intent["launchPermit"],
            {"path": str(permit), "sha256": sha256_file(permit)},
        )


if __name__ == "__main__":
    unittest.main()
