from __future__ import annotations

import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_role as role
import run_v35_p30_campaign as campaign


class P30DurableNonexecutorSigningTests(unittest.TestCase):
    def _prepared(
        self, root: Path, *, output_name: str = "authorization.json"
    ) -> tuple[role.PreparedSigningAction, Path, dict]:
        output = root / output_name
        payload = {
            "schemaVersion": "test-unsigned-authorization-v1",
            "kind": "generation",
            "nested": {"immutable": True, "values": [1, 2, 3]},
        }
        prepared = role._prepared_artifacts(
            required_role="issuer",
            output=output,
            protocol={"executionTrust": {}},
            artifacts=[(output, payload, "issuer")],
        )
        return prepared, output, payload

    def test_complete_plan_and_attempt_are_durable_before_signing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            prepared, output, payload = self._prepared(root)
            action_id = "a" * 64
            signer_events: list[str] = []

            reservation = prepared.reserve(action_id)
            self.assertFalse(output.exists())
            self.assertEqual(
                stat.S_IMODE(reservation.plan_path.stat().st_mode), 0o400
            )
            self.assertEqual(
                stat.S_IMODE(reservation.marker_path.stat().st_mode), 0o400
            )
            persisted_plan = json.loads(reservation.plan_path.read_text())
            self.assertEqual(persisted_plan, prepared.commitment)
            self.assertEqual(
                persisted_plan["artifacts"][0]["unsignedPayload"], payload
            )
            persisted_marker = json.loads(reservation.marker_path.read_text())
            self.assertEqual(persisted_marker["actionId"], action_id)
            self.assertEqual(
                persisted_marker["unsignedSigningPlan"], reservation.plan_binding
            )

            def sign(*_args: object, **_kwargs: object) -> dict:
                self.assertTrue(reservation.plan_path.is_file())
                self.assertTrue(reservation.marker_path.is_file())
                reservation.validate()
                signer_events.append("signed")
                return {"schemaVersion": "synthetic-signature-v1"}

            with (
                mock.patch.object(role, "sign_payload", side_effect=sign),
                mock.patch.object(
                    role, "role_public_key_path", return_value=root / "issuer.pem"
                ),
            ):
                produced = prepared.seal(71, reservation)

            self.assertEqual(produced, output)
            self.assertEqual(signer_events, ["signed"])
            self.assertTrue(output.is_file())

    def test_seal_rejects_changed_plan_or_marker_before_signing(self) -> None:
        for evidence in ("plan", "marker"):
            with self.subTest(evidence=evidence), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                prepared, _, _ = self._prepared(root, output_name=f"{evidence}.json")
                reservation = prepared.reserve("b" * 64)
                path = (
                    reservation.plan_path
                    if evidence == "plan"
                    else reservation.marker_path
                )
                os.chmod(path, 0o600)
                path.write_bytes(b"{}\n")
                with (
                    mock.patch.object(role, "sign_payload") as signer,
                    self.assertRaisesRegex(ValueError, f"{evidence}.*changed"),
                ):
                    prepared.seal(72, reservation)
                signer.assert_not_called()

    def test_existing_attempt_closes_action_before_payload_recomputation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol_path = root / "protocol.json"
            request_path = root / "requests" / "issuer.json"
            output = root / "authorization.json"
            request = {
                "verb": "issue-generation",
                "expectedOutputPath": str(output),
            }
            binding = {"path": str(request_path), "sha256": "c" * 64}
            attempt = role.signing_attempt_path(output)
            attempt.parent.mkdir(parents=True, exist_ok=True)
            attempt.write_bytes(b"consumed\n")
            protocol = {
                "sourceContract": {"sha256": "d" * 64},
                "executionTrust": {},
            }
            argv = [
                "run_v35_p30_role.py",
                "--protocol",
                str(protocol_path),
                "--request",
                str(request_path),
                "--expected-role",
                "issuer",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(role, "read_json_object", return_value=protocol),
                mock.patch.object(role, "validate_protocol"),
                mock.patch.object(role, "validate_frozen_source"),
                mock.patch.object(
                    role, "load_request", return_value=(request, binding)
                ),
                mock.patch.object(role, "next_action", return_value=request),
                mock.patch.object(
                    role,
                    "_issue_generation",
                    side_effect=AssertionError("unsigned payload was recomputed"),
                ) as prepare,
                mock.patch.object(
                    role,
                    "receive_private_key",
                    side_effect=AssertionError("private key was requested"),
                ) as receive_key,
                contextlib.redirect_stdout(io.StringIO()) as stdout,
                self.assertRaisesRegex(RuntimeError, "terminally closed"),
            ):
                role.main.__wrapped__()

            prepare.assert_not_called()
            receive_key.assert_not_called()
            self.assertEqual(stdout.getvalue(), "")

    def test_failed_plan_persistence_consumes_attempt_without_key_use(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            prepared, output, _ = self._prepared(root)
            real_write = role.atomic_write_exclusive

            def fail_plan(path: Path, payload: bytes, *, mode: int = 0o600) -> None:
                if path == role.signing_plan_path(output):
                    raise OSError("synthetic plan persistence failure")
                real_write(path, payload, mode=mode)

            with (
                mock.patch.object(
                    role, "atomic_write_exclusive", side_effect=fail_plan
                ),
                self.assertRaisesRegex(OSError, "plan persistence failure"),
            ):
                prepared.reserve("e" * 64)

            self.assertTrue(role.signing_attempt_path(output).is_file())
            self.assertFalse(role.signing_plan_path(output).exists())
            with self.assertRaisesRegex(RuntimeError, "terminally closed"):
                prepared.reserve("e" * 64)

    def test_scheduler_treats_orphaned_attempt_as_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol_path = root / "protocol.json"
            output = root / "authorization.json"
            marker = campaign.nonexecutor_signing_attempt_path(output)
            marker.write_bytes(b"consumed\n")
            protocol = {
                "executionTrust": {"campaignInstanceId": "f" * 64},
                "ledger": {"root": str(root / "ledger")},
            }
            with (
                mock.patch.object(campaign, "ledger_for", return_value=root / "ledger"),
                self.assertRaisesRegex(RuntimeError, "terminally closed"),
            ):
                campaign.emit_request(
                    protocol_path=protocol_path,
                    protocol=protocol,
                    role="issuer",
                    verb="issue-generation",
                    subject={"logicalId": "rep-a-generation-1"},
                    predecessor=None,
                    expected_output=output,
                )


if __name__ == "__main__":
    unittest.main()
