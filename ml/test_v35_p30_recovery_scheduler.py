from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_campaign as campaign
import run_v35_p30_role as role_entrypoint
from v35_p30_recovery import PRE_CHILD, RECEIPT_ONLY, RECOVERY_ELIGIBLE_KINDS


class RecoverySchedulerTests(unittest.TestCase):
    @staticmethod
    def recovery_protocol() -> dict:
        return {"recoveryPolicy": {"eligibleKinds": list(RECOVERY_ELIGIBLE_KINDS)}}

    def authorization(self, root: Path, *, kind: str = "generation") -> dict:
        token = "a" * 64
        ledger = root / "ledger"
        return {
            "kind": kind,
            "tokenId": token,
            "campaignId": "campaign",
            "protocol": {"path": str(root / "protocol.json"), "sha256": "1" * 64},
            "subject": {
                "root": str(root / "league"),
                "replicate": "a",
                "arm": "baseline",
                "generation": 1,
            },
            "ledger": {
                "root": str(ledger),
                "consumedPath": str(ledger / f"{token}.consumed.json"),
                "receiptPath": str(ledger / f"{token}.receipt.json"),
            },
            "predecessor": None,
        }

    def test_invalid_normal_unsigned_receipt_is_never_inferred_pre_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root)
            receipt = Path(authorization["ledger"]["receiptPath"])
            receipt.parent.mkdir(parents=True)
            unsigned = campaign.unsigned_receipt_path(receipt)
            unsigned.write_text("{}")
            with (
                mock.patch.object(
                    campaign,
                    "_read_normal_draft",
                    return_value=(
                        unsigned,
                        {"valid": False},
                        {"path": "/request", "sha256": "2" * 64},
                    ),
                ),
                self.assertRaisesRegex(RuntimeError, "PRE_CHILD cannot be inferred"),
            ):
                campaign.ensure_recovery_execution_draft(
                    protocol=self.recovery_protocol(),
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                )

    def test_only_executor_persisted_pre_child_draft_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root)
            recovery = campaign.recovery_paths(authorization)["executionDraft"]
            recovery.parent.mkdir(parents=True)
            recovery.write_text("{}")
            with (
                mock.patch.object(campaign, "read_json_object", return_value={}),
                mock.patch.object(campaign, "validate_execution_draft") as validate,
            ):
                result = campaign.ensure_recovery_execution_draft(
                    protocol=self.recovery_protocol(),
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                )
            self.assertEqual(result, (recovery, {}))
            validate.assert_called_once_with({}, authorization=authorization)

    def test_receipt_only_is_derived_only_through_executor_primitive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root)
            paths = campaign.recovery_paths(authorization)
            receipt = Path(authorization["ledger"]["receiptPath"])
            receipt.parent.mkdir(parents=True)
            unsigned = campaign.unsigned_receipt_path(receipt)
            unsigned.write_text("{}")
            paths["normalSealAttempt"].write_text("{}")
            recovery = paths["executionDraft"]
            def prepare_recovery(*_args: object, **_kwargs: object) -> Path:
                recovery.write_text("{}")
                return recovery
            with (
                mock.patch.object(
                    campaign,
                    "_read_normal_draft",
                    return_value=(
                        unsigned,
                        {"valid": True},
                        {"path": "/request", "sha256": "2" * 64},
                    ),
                ),
                mock.patch.object(
                    campaign,
                    "prepare_receipt_only_recovery_draft",
                    side_effect=prepare_recovery,
                ) as prepare,
                mock.patch.object(
                    campaign,
                    "read_json_object",
                    side_effect=lambda path, _label: (
                        {"executionTrust": {}}
                        if path == Path(authorization["protocol"]["path"])
                        else {}
                    ),
                ),
                mock.patch.object(campaign, "validate_execution_draft"),
                mock.patch.object(campaign, "role_public_key_path", return_value=root / "key"),
            ):
                result = campaign.ensure_recovery_execution_draft(
                    protocol=self.recovery_protocol(),
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                )
            self.assertEqual(result, (recovery, {}))
            prepare.assert_called_once()

    def test_analysis_unsealed_state_is_terminal_and_never_materializes_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root, kind="analysis")
            receipt = Path(authorization["ledger"]["receiptPath"])
            receipt.parent.mkdir(parents=True)
            campaign.unsigned_receipt_path(receipt).write_text("{}")
            campaign.normal_seal_attempt_path(receipt).write_text("{}")
            with (
                mock.patch.object(campaign, "prepare_receipt_only_recovery_draft") as prepare,
                self.assertRaisesRegex(RuntimeError, "no recovery path"),
            ):
                campaign.ensure_recovery_execution_draft(
                    protocol=self.recovery_protocol(),
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                )
            prepare.assert_not_called()

    def test_analysis_without_execution_state_can_only_take_the_initial_action(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root, kind="analysis")
            self.assertIsNone(
                campaign.ensure_recovery_execution_draft(
                    protocol=self.recovery_protocol(),
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                )
            )

    def test_role_runner_rejects_analysis_before_any_recovery_signature_validation(self) -> None:
        protocol_path = Path("/frozen/protocol.json")
        protocol = {"executionTrust": {}}
        original_request = {
            "subject": {"originalAuthorizationPath": "/ledger/analysis.authorization.json"}
        }
        seal_request = {
            "subject": {"authorizationPath": "/ledger/analysis.authorization.json"}
        }
        with (
            mock.patch.object(
                role_entrypoint,
                "read_json_object",
                return_value={"kind": "analysis"},
            ),
            mock.patch.object(role_entrypoint, "verify_signed_payload") as verify,
        ):
            with self.assertRaisesRegex(ValueError, "forbidden"):
                role_entrypoint._load_original_recovery_authorization(
                    protocol_path, protocol, original_request
                )
            with self.assertRaisesRegex(ValueError, "forbidden"):
                role_entrypoint._prepare_receipt_only_recovery_seal(
                    protocol_path, protocol, seal_request, {}
                )
            with self.assertRaisesRegex(ValueError, "forbidden"):
                role_entrypoint._seal_recovery_receipt(
                    protocol_path, protocol, seal_request, {}, -1
                )
            verify.assert_not_called()

    def test_second_receipt_only_seal_failure_terminally_closes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root)
            paths = campaign.recovery_paths(authorization)
            for label in (
                "executionDraft",
                "incidentAttestation",
                "linkAttestation",
                "recoveryAttempt",
            ):
                paths[label].parent.mkdir(parents=True, exist_ok=True)
                paths[label].write_text("{}")
            draft = {"recoveryClass": RECEIPT_ONLY}
            state = {"draft": draft, "incident": {}, "link": {}}
            with (
                mock.patch.object(
                    campaign,
                    "ensure_recovery_execution_draft",
                    return_value=(paths["executionDraft"], draft),
                ),
                mock.patch.object(campaign, "validate_recovery_state", return_value=state),
                mock.patch.object(
                    campaign, "_recovery_token_from_incident_request", return_value="b" * 64
                ),
                mock.patch.object(campaign, "emit_request") as emit,
                self.assertRaisesRegex(RuntimeError, "already failed once"),
            ):
                campaign.next_execution_action(
                    protocol_path=root / "protocol.json",
                    protocol={"executionTrust": {"campaignInstanceId": "c" * 64}},
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                    normal_subject={"logicalId": "normal"},
                )
            emit.assert_not_called()

    def test_pre_child_link_emits_only_dedicated_recovery_execute(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization = self.authorization(root)
            paths = campaign.recovery_paths(authorization)
            for label in (
                "executionDraft",
                "incident",
                "incidentAttestation",
                "replacementAuthorization",
                "link",
                "linkAttestation",
            ):
                paths[label].parent.mkdir(parents=True, exist_ok=True)
                paths[label].write_text("{}")
            draft = {"recoveryClass": PRE_CHILD}
            replacement = {
                **authorization,
                "tokenId": "b" * 64,
                "ledger": {
                    **authorization["ledger"],
                    "receiptPath": str(root / "ledger" / "replacement.receipt.json"),
                },
            }
            state = {
                "draft": draft,
                "incident": {},
                "link": {},
                "replacementAuthorization": replacement,
            }
            with (
                mock.patch.object(
                    campaign,
                    "ensure_recovery_execution_draft",
                    return_value=(paths["executionDraft"], draft),
                ),
                mock.patch.object(campaign, "validate_recovery_state", return_value=state),
                mock.patch.object(
                    campaign, "_recovery_token_from_incident_request", return_value="b" * 64
                ),
                mock.patch.object(
                    campaign, "validate_stored_authorization", return_value=replacement
                ),
                mock.patch.object(
                    campaign, "emit_request", return_value={"verb": "execute-recovery"}
                ) as emit,
            ):
                result = campaign.next_execution_action(
                    protocol_path=root / "protocol.json",
                    protocol={"executionTrust": {"campaignInstanceId": "c" * 64}},
                    authorization_path=root / "authorization.json",
                    authorization=authorization,
                    normal_subject={"logicalId": "normal"},
                )
            self.assertEqual(result, {"verb": "execute-recovery"})
            self.assertEqual(emit.call_args.kwargs["verb"], "execute-recovery")
            self.assertEqual(
                emit.call_args.kwargs["predecessor"], paths["linkAttestation"]
            )


class StorageReservationTests(unittest.TestCase):
    @unittest.skipUnless(
        hasattr(os, "posix_fallocate"),
        "the real reservation smoke runs on the Linux SimForge host",
    )
    def test_real_blocks_are_reserved_shrunk_and_released(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol = {
                "executionTrust": {
                    "campaignInstanceId": "d" * 64,
                    "ledgerRoot": str(root / "ledger"),
                }
            }
            allocated = campaign.set_storage_reservation(protocol, 1024 * 1024)
            self.assertGreaterEqual(allocated, 1024 * 1024)
            path = campaign.storage_reservation_path(protocol)
            self.assertEqual(path.stat().st_size, 1024 * 1024)
            allocated = campaign.set_storage_reservation(protocol, 512 * 1024)
            self.assertGreaterEqual(allocated, 512 * 1024)
            self.assertEqual(path.stat().st_size, 512 * 1024)
            self.assertEqual(campaign.set_storage_reservation(protocol, 0), 0)
            self.assertEqual(path.stat().st_size, 0)


class ReceiptOnlyRoleOrderingTests(unittest.TestCase):
    def test_recovery_seal_sign_ready_precedes_key_and_signer(self) -> None:
        events: list[str] = []
        protocol_path = Path("/frozen/protocol.json")
        request_path = Path("/ledger/requests/recovery.json")
        draft_path = Path("/ledger/receipt.json.unsigned.json")
        output_path = Path("/ledger/receipt.json")
        protocol = {"sourceContract": {"sha256": "b" * 64}}
        request = {
            "verb": "seal-recovery-receipt",
            "expectedOutputPath": str(output_path),
        }
        binding = {"path": str(request_path), "sha256": "a" * 64}

        def prepare(*_args: object, **_kwargs: object) -> Path:
            events.append("recovery-validated")
            return draft_path

        @contextlib.contextmanager
        def receive_key():
            events.append("key-read")
            yield 91

        def seal(*_args: object, **_kwargs: object) -> Path:
            events.append("recovery-signed")
            return output_path

        argv = [
            "run_v35_p30_role.py",
            "--protocol",
            str(protocol_path),
            "--request",
            str(request_path),
            "--expected-role",
            "executor",
        ]
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(role_entrypoint, "read_json_object", return_value=protocol),
            mock.patch.object(role_entrypoint, "validate_protocol"),
            mock.patch.object(role_entrypoint, "validate_frozen_source"),
            mock.patch.object(role_entrypoint, "load_request", return_value=(request, binding)),
            mock.patch.object(role_entrypoint, "next_action", return_value=request),
            mock.patch.object(role_entrypoint, "sha256", return_value="c" * 64),
            mock.patch.object(role_entrypoint, "sha256_file", return_value="d" * 64),
            mock.patch.object(
                role_entrypoint,
                "_prepare_receipt_only_recovery_seal",
                side_effect=prepare,
            ),
            mock.patch.object(role_entrypoint, "receive_private_key", receive_key),
            mock.patch.object(role_entrypoint, "_seal_recovery_receipt", side_effect=seal),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            role_entrypoint.main.__wrapped__()
        self.assertEqual(events, ["recovery-validated", "key-read", "recovery-signed"])


if __name__ == "__main__":
    unittest.main()
