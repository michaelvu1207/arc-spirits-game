from __future__ import annotations

import ast
import contextlib
import inspect
import io
import json
import os
import selectors
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_local_custody as local_custody
import run_v35_p30_role as role_entrypoint
import v35_p30_authorized_execution as authorized_execution
from v35_p30_crypto import sha256_file


class _LineStream:
    def __init__(self, lines: list[bytes], descriptor: int) -> None:
        self._lines = iter(lines)
        self._descriptor = descriptor

    def readline(self) -> bytes:
        return next(self._lines, b"")

    def fileno(self) -> int:
        return self._descriptor


class _RemoteProcess:
    def __init__(self, stdout_lines: list[bytes]) -> None:
        self.stdout = _LineStream(stdout_lines, 101)
        self.stderr = _LineStream([], 102)
        self.returncode: int | None = None
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class _AlwaysReadySelector:
    def register(self, _fileobj: object, _events: int) -> None:
        return None

    def select(self, timeout: int | None = None) -> list[tuple[object, int]]:
        del timeout
        return [(object(), 1)]

    def close(self) -> None:
        return None


class P30TwoStageCustodyTests(unittest.TestCase):
    def test_partial_stdout_line_obeys_deadline_instead_of_blocking(self) -> None:
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        selector = selectors.DefaultSelector()
        stdout_buffer = bytearray()
        early_stderr = bytearray()
        try:
            os.set_blocking(stdout_read, False)
            os.set_blocking(stderr_read, False)
            selector.register(stdout_read, selectors.EVENT_READ)
            selector.register(stderr_read, selectors.EVENT_READ)
            os.write(stdout_write, b'{"schemaVersion":"partial')
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "handshake line timed out"):
                local_custody.read_bounded_remote_line(
                    selector,
                    stdout_fd=stdout_read,
                    stderr_fd=stderr_read,
                    timeout_seconds=0.05,
                    stdout_buffer=stdout_buffer,
                    early_stderr=early_stderr,
                )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1.0)
            self.assertEqual(stdout_buffer, b'{"schemaVersion":"partial')
            self.assertEqual(early_stderr, b"")
        finally:
            selector.close()
            for descriptor in (stdout_read, stdout_write, stderr_read, stderr_write):
                os.close(descriptor)

    def test_executor_prepare_drains_and_bounds_early_stderr(self) -> None:
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        selector = selectors.DefaultSelector()
        stdout_buffer = bytearray()
        early_stderr = bytearray()
        emitted = b"123456789"
        try:
            os.set_blocking(stdout_read, False)
            os.set_blocking(stderr_read, False)
            selector.register(stdout_read, selectors.EVENT_READ)
            selector.register(stderr_read, selectors.EVENT_READ)
            os.write(stderr_write, emitted)
            with (
                mock.patch.object(
                    local_custody, "MAXIMUM_EARLY_STDERR_BYTES", len(emitted) - 1
                ),
                self.assertRaisesRegex(RuntimeError, "excessive early stderr"),
            ):
                local_custody.read_bounded_remote_line(
                    selector,
                    stdout_fd=stdout_read,
                    stderr_fd=stderr_read,
                    timeout_seconds=1,
                    stdout_buffer=stdout_buffer,
                    early_stderr=early_stderr,
                )
            self.assertEqual(early_stderr, emitted)
            self.assertEqual(stdout_buffer, b"")
        finally:
            selector.close()
            for descriptor in (stdout_read, stdout_write, stderr_read, stderr_write):
                os.close(descriptor)

    def test_executor_key_and_signer_are_after_unsigned_draft_completion(self) -> None:
        # Protect the lower-level preparation primitive as well as the role
        # entrypoint ordering: preparation must not even reference a signer or
        # private-key reader.
        preparation_source = inspect.getsource(
            authorized_execution.prepare_execution_receipt
        )
        preparation_tree = ast.parse(preparation_source)
        preparation_names = {
            node.id for node in ast.walk(preparation_tree) if isinstance(node, ast.Name)
        }
        self.assertTrue(
            {
                "sign_payload",
                "receive_private_key",
                "executor_private_key_fd",
                "_private_key_from_fd",
            }.isdisjoint(preparation_names)
        )

        events: list[str] = []
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        protocol_path = root / "protocol.json"
        request_path = root / "ledger/requests/executor-request.json"
        output_path = root / "ledger/receipt.json"
        draft_path = output_path.with_name(output_path.name + ".unsigned.json")
        authorization_path = root / "ledger/authorization.json"
        draft_path.parent.mkdir(parents=True)
        draft_path.write_text('{"valid":true}\n')
        protocol = {
            "sourceContract": {"sha256": "b" * 64},
            "executionTrust": {},
        }
        request = {
            "verb": "execute",
            "expectedOutputPath": str(output_path),
            "subject": {"authorizationPath": str(authorization_path)},
        }
        authorization = {"ledger": {"receiptPath": str(output_path)}}
        binding = {"path": str(request_path), "sha256": "a" * 64}

        def prepare(*_args: object, **_kwargs: object) -> Path:
            events.append("prepare-started")
            self.assertNotIn("key-read", events)
            self.assertNotIn("signer-called", events)
            events.append("draft-complete")
            return draft_path

        @contextlib.contextmanager
        def receive_key():
            events.append("key-read")
            yield 91

        def seal(*_args: object, **_kwargs: object) -> Path:
            events.append("signer-called")
            return output_path

        def evidence_hash(path: Path) -> str:
            if path == draft_path:
                return "d" * 64
            if path == output_path:
                return "e" * 64
            return "f" * 64

        def read_object(path: Path, _label: str) -> dict:
            if path == draft_path:
                return {"valid": True}
            if path == authorization_path:
                return authorization
            return protocol

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
            mock.patch.object(role_entrypoint, "read_json_object", side_effect=read_object),
            mock.patch.object(role_entrypoint, "validate_protocol"),
            mock.patch.object(role_entrypoint, "validate_frozen_source"),
            mock.patch.object(
                role_entrypoint, "load_request", return_value=(request, binding)
            ),
            mock.patch.object(role_entrypoint, "next_action", return_value=request),
            mock.patch.object(role_entrypoint, "sha256", return_value="c" * 64),
            mock.patch.object(role_entrypoint, "sha256_file", side_effect=evidence_hash),
            mock.patch.object(role_entrypoint, "_prepare_execution", side_effect=prepare),
            mock.patch.object(role_entrypoint, "receive_private_key", receive_key),
            mock.patch.object(role_entrypoint, "_seal_execution", side_effect=seal),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            role_entrypoint.main.__wrapped__()

        self.assertEqual(
            events,
            ["prepare-started", "draft-complete", "key-read", "signer-called"],
        )

    def test_every_nonexecutor_role_prepares_and_commits_before_key(self) -> None:
        cases = (
            ("issuer", "issue-generation", "_issue_generation"),
            ("guardian", "attest-pair", "_attest_pair"),
            ("analysis-authorizer", "issue-analysis", "_issue_analysis"),
        )
        for expected_role, verb, handler_name in cases:
            with self.subTest(role=expected_role):
                temporary = tempfile.TemporaryDirectory()
                self.addCleanup(temporary.cleanup)
                root = Path(temporary.name).resolve()
                events: list[str] = []
                protocol_path = root / "protocol.json"
                request_path = root / "requests" / f"{expected_role}.json"
                output_path = root / f"{expected_role}.json"
                protocol = {
                    "sourceContract": {"sha256": "b" * 64},
                    "executionTrust": {},
                }
                request = {
                    "verb": verb,
                    "expectedOutputPath": str(output_path),
                }
                binding = {"path": str(request_path), "sha256": "a" * 64}

                def seal(key_fd: int) -> Path:
                    self.assertEqual(key_fd, 91)
                    events.append("signer-called")
                    return output_path

                prepared = role_entrypoint.PreparedSigningAction(
                    required_role=expected_role,
                    output=output_path,
                    commitment={
                        "schemaVersion": "test-unsigned-plan-v1",
                        "payload": expected_role,
                    },
                    seal_callback=seal,
                )

                def prepare(*_args: object, **_kwargs: object):
                    events.append("prepare-complete")
                    self.assertNotIn("key-read", events)
                    return prepared

                @contextlib.contextmanager
                def receive_key():
                    events.append("key-read")
                    yield 91

                argv = [
                    "run_v35_p30_role.py",
                    "--protocol",
                    str(protocol_path),
                    "--request",
                    str(request_path),
                    "--expected-role",
                    expected_role,
                ]
                stdout = io.StringIO()
                with (
                    mock.patch.object(sys, "argv", argv),
                    mock.patch.object(
                        role_entrypoint,
                        "read_json_object",
                        return_value=protocol,
                    ),
                    mock.patch.object(role_entrypoint, "validate_protocol"),
                    mock.patch.object(role_entrypoint, "validate_frozen_source"),
                    mock.patch.object(
                        role_entrypoint,
                        "load_request",
                        return_value=(request, binding),
                    ),
                    mock.patch.object(
                        role_entrypoint, "next_action", return_value=request
                    ),
                    mock.patch.object(
                        role_entrypoint, "sha256", return_value="c" * 64
                    ),
                    mock.patch.object(
                        role_entrypoint, "sha256_file", return_value="d" * 64
                    ),
                    mock.patch.object(
                        role_entrypoint, handler_name, side_effect=prepare
                    ),
                    mock.patch.object(
                        role_entrypoint, "receive_private_key", receive_key
                    ),
                    contextlib.redirect_stdout(stdout),
                ):
                    role_entrypoint.main.__wrapped__()

                messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
                self.assertEqual(
                    events, ["prepare-complete", "key-read", "signer-called"]
                )
                self.assertEqual(
                    messages[1],
                    {
                        "schemaVersion": role_entrypoint.SIGN_READY_SCHEMA,
                        "actionId": binding["sha256"],
                        "requiredRole": expected_role,
                        "expectedOutputPath": str(output_path),
                        "unsignedSigningPlan": {
                            "path": str(role_entrypoint.signing_plan_path(output_path)),
                            "sha256": sha256_file(
                                role_entrypoint.signing_plan_path(output_path)
                            ),
                        },
                        "attemptMarker": {
                            "path": str(
                                role_entrypoint.signing_attempt_path(output_path)
                            ),
                            "sha256": sha256_file(
                                role_entrypoint.signing_attempt_path(output_path)
                            ),
                        },
                    },
                )
                self.assertTrue(role_entrypoint.signing_plan_path(output_path).is_file())
                self.assertTrue(
                    role_entrypoint.signing_attempt_path(output_path).is_file()
                )

    def test_analysis_authorization_rebinds_after_review_without_mutating_draft(
        self,
    ) -> None:
        import v35_p30_analysis_review as analysis_review

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol_path = root / "protocol.json"
            draft_path = root / "analysis-authorization.draft.json"
            manifest_path = root / "analysis-manifest.json"
            review_path = root / "analysis-review.json"
            output_path = root / "analysis-authorization.json"
            protocol_path.write_text("{}")
            manifest_path.write_text("{}")
            binding = {"path": str(root / "request.json"), "sha256": "a" * 64}
            reviewed = {
                "kind": "analysis",
                "request": binding,
                "issuedAtUtc": "2026-07-15T10:00:00.000000Z",
                "notBeforeUtc": "2026-07-15T10:00:00.000000Z",
                "expiresAtUtc": "2026-07-16T10:00:00.000000Z",
                "immutableField": {"value": 7},
            }
            draft_path.write_text(json.dumps(reviewed, separators=(",", ":")))
            original_bytes = draft_path.read_bytes()
            review_finished = "2026-07-15T11:00:00.000000Z"
            rebound = dict(reviewed)
            rebound.update(
                {
                    "issuedAtUtc": "2026-07-15T11:01:00.000000Z",
                    "notBeforeUtc": "2026-07-15T11:01:00.000000Z",
                    "expiresAtUtc": "2026-07-16T11:01:00.000000Z",
                }
            )
            request = {
                "verb": "issue-analysis",
                "expectedOutputPath": str(output_path),
                "predecessorSha256": sha256_file(manifest_path),
                "subject": {
                    "manifest": {
                        "path": str(manifest_path),
                        "sha256": sha256_file(manifest_path),
                    },
                    "authorizationDraftPath": str(draft_path),
                    "reviewReceiptPath": str(review_path),
                },
            }
            protocol = {"executionTrust": {}}
            with (
                mock.patch.object(
                    role_entrypoint,
                    "analysis_authorization_path",
                    return_value=output_path,
                ),
                mock.patch.object(
                    role_entrypoint,
                    "analysis_authorization_draft_path",
                    return_value=draft_path,
                ),
                mock.patch.object(
                    role_entrypoint,
                    "analysis_manifest_path",
                    return_value=manifest_path,
                ),
                mock.patch.object(
                    role_entrypoint,
                    "analysis_review_receipt_path",
                    return_value=review_path,
                ),
                mock.patch.object(
                    role_entrypoint,
                    "role_public_key_path",
                    return_value=root / "guardian.pem",
                ),
                mock.patch.object(
                    analysis_review,
                    "validate_analysis_review_receipt",
                    return_value={"finishedAtUtc": review_finished},
                ),
                mock.patch.object(
                    role_entrypoint,
                    "rebind_reviewed_analysis_authorization_times",
                    return_value=rebound,
                ) as rebind,
                mock.patch.object(
                    role_entrypoint,
                    "validate_reviewed_analysis_authorization_rebinding",
                ) as validate_rebinding,
            ):
                prepared = role_entrypoint._issue_analysis(
                    protocol_path, protocol, request, binding
                )

            self.assertEqual(draft_path.read_bytes(), original_bytes)
            self.assertFalse(output_path.exists())
            self.assertEqual(prepared.output, output_path)
            self.assertEqual(prepared.required_role, "analysis-authorizer")
            rebind.assert_called_once()
            self.assertIsInstance(rebind.call_args.kwargs["now"], __import__("datetime").datetime)
            validate_rebinding.assert_called_once_with(
                reviewed,
                rebound,
                review_finished_at_utc=review_finished,
            )
            self.assertEqual(
                prepared.commitment["artifacts"][0]["unsignedPayloadSha256"],
                role_entrypoint.sha256_bytes(role_entrypoint.canonical_json(rebound)),
            )

    def test_existing_valid_unsigned_draft_never_reruns_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            ledger = Path(temporary).resolve()
            requests = ledger / "requests"
            requests.mkdir()
            protocol_path = ledger / "protocol.json"
            authorization_path = ledger / "authorization.json"
            request_path = requests / "executor-request.json"
            consumed_path = ledger / "consumed.json"
            receipt_path = ledger / "receipt.json"
            draft_path = authorized_execution.unsigned_receipt_path(receipt_path)
            protocol = {
                "executionTrust": {"campaignInstanceId": "1" * 64},
            }
            protocol_path.write_text(json.dumps(protocol))
            authorization_path.write_text("{}")
            draft_path.write_text("{}")
            authorization = {
                "protocol": {
                    "path": str(protocol_path),
                    "sha256": sha256_file(protocol_path),
                },
                "ledger": {
                    "root": str(ledger),
                    "consumedPath": str(consumed_path),
                    "receiptPath": str(receipt_path),
                },
            }
            request = {
                "schemaVersion": "arc-v35-p30-role-request-v1",
                "campaignInstanceId": "1" * 64,
                "protocol": authorization["protocol"],
                "role": "executor",
                "verb": "execute",
                "expectedOutputPath": str(receipt_path),
                "predecessorSha256": sha256_file(authorization_path),
                "requestNonce": "2" * 64,
            }
            request_path.write_text(json.dumps(request))
            request_binding = {
                "path": str(request_path),
                "sha256": sha256_file(request_path),
            }

            with (
                mock.patch.object(
                    authorized_execution,
                    "validate_authorization",
                    return_value=authorization,
                ),
                mock.patch.object(
                    authorized_execution, "validate_unsigned_receipt_draft"
                ) as validate_draft,
                mock.patch.object(
                    authorized_execution,
                    "_prepare_output_parents",
                    side_effect=AssertionError("candidate setup reran"),
                ) as prepare_outputs,
                mock.patch.object(
                    authorized_execution.subprocess,
                    "Popen",
                    side_effect=AssertionError("candidate process reran"),
                ) as popen,
                mock.patch.object(
                    authorized_execution,
                    "sign_payload",
                    side_effect=AssertionError("signer called during preparation"),
                ) as signer,
            ):
                observed = authorized_execution.prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=ledger / "issuer.pem",
                    analysis_authorizer_public_key_path=ledger / "analysis.pem",
                    execution_request_binding=request_binding,
                )

            self.assertEqual(observed, draft_path)
            validate_draft.assert_called_once()
            prepare_outputs.assert_not_called()
            popen.assert_not_called()
            signer.assert_not_called()

    def test_malformed_sign_ready_is_rejected_before_secret_process_starts(self) -> None:
        ready = {
            "schemaVersion": "arc-v35-p30-role-ready-v1",
            "actionId": "a" * 64,
            "protocolSha256": "b" * 64,
            "sourceContractSha256": "c" * 64,
            "requiredRole": "executor",
            "actionVerb": "execute",
            "launchPermitChallenge": None,
        }
        malformed_sign_ready = {
            "schemaVersion": "arc-v35-p30-executor-sign-ready-v1",
            "actionId": "d" * 64,
            "requiredRole": "executor",
            "unsignedDraft": {
                "path": "/ledger/receipt.json.unsigned.json",
                "sha256": "e" * 64,
            },
        }
        remote = _RemoteProcess(
            [
                json.dumps(ready).encode("utf-8") + b"\n",
                json.dumps(malformed_sign_ready).encode("utf-8") + b"\n",
            ]
        )
        popen_calls: list[list[str]] = []

        def popen(argv: list[str], **_kwargs: object) -> _RemoteProcess:
            popen_calls.append(argv)
            if argv and argv[0] == "ssh":
                return remote
            raise AssertionError("op-michaelagents started before SIGN_READY validation")

        argv = [
            "run_v35_p30_local_custody.py",
            "--protocol",
            "/frozen/protocol.json",
            "--request",
            "/ledger/requests/executor-request.json",
            "--role",
            "executor",
        ]
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(
                local_custody,
                "load_config",
                return_value={"executor": "op://MichaelAgents/executor/private-key"},
            ),
            mock.patch.object(
                local_custody.selectors,
                "DefaultSelector",
                return_value=_AlwaysReadySelector(),
            ),
            mock.patch.object(local_custody.os, "set_blocking"),
            mock.patch.object(
                local_custody,
                "read_bounded_remote_line",
                side_effect=[
                    json.dumps(ready).encode("utf-8"),
                    json.dumps(malformed_sign_ready).encode("utf-8"),
                ],
            ),
            mock.patch.object(local_custody.subprocess, "Popen", side_effect=popen),
        ):
            with self.assertRaisesRegex(
                ValueError, "executor sign-ready message is malformed"
            ):
                local_custody.main()

        self.assertEqual(len(popen_calls), 1)
        self.assertEqual(popen_calls[0][0], "ssh")
        self.assertTrue(remote.killed)

    def test_local_custody_accepts_only_the_durable_nonexecutor_reservation(self) -> None:
        message = {
            "schemaVersion": local_custody.ROLE_SIGN_READY_SCHEMA,
            "actionId": "a" * 64,
            "requiredRole": "issuer",
            "expectedOutputPath": "/ledger/authorization.json",
            "unsignedSigningPlan": {
                "path": "/ledger/authorization.json.unsigned-signing-plan.json",
                "sha256": "b" * 64,
            },
            "attemptMarker": {
                "path": "/ledger/signing-attempts/authorization.json.attempted.json",
                "sha256": "c" * 64,
            },
        }
        local_custody.validate_sign_ready(
            message, role="issuer", action_id="a" * 64
        )
        changed = json.loads(json.dumps(message))
        changed["attemptMarker"]["sha256"] = "not-a-hash"
        with self.assertRaisesRegex(ValueError, "sign-ready message is malformed"):
            local_custody.validate_sign_ready(
                changed, role="issuer", action_id="a" * 64
            )

    def test_malformed_nonexecutor_sign_ready_never_starts_secret_process(self) -> None:
        for expected_role in ("issuer", "guardian", "analysis-authorizer"):
            with self.subTest(role=expected_role):
                ready = {
                    "schemaVersion": "arc-v35-p30-role-ready-v1",
                    "actionId": "a" * 64,
                    "protocolSha256": "b" * 64,
                    "sourceContractSha256": "c" * 64,
                    "requiredRole": expected_role,
                    "actionVerb": {
                        "issuer": "issue-generation",
                        "guardian": "attest-pair",
                        "analysis-authorizer": "issue-analysis",
                    }[expected_role],
                    "launchPermitChallenge": None,
                }
                malformed = {
                    "schemaVersion": local_custody.ROLE_SIGN_READY_SCHEMA,
                    "actionId": "d" * 64,
                    "requiredRole": expected_role,
                    "expectedOutputPath": f"/ledger/{expected_role}.json",
                    "unsignedSigningPlan": {
                        "path": f"/ledger/{expected_role}.plan.json",
                        "sha256": "e" * 64,
                    },
                    "attemptMarker": {
                        "path": f"/ledger/{expected_role}.attempt.json",
                        "sha256": "f" * 64,
                    },
                }
                remote = _RemoteProcess([])
                popen_calls: list[list[str]] = []

                def popen(argv: list[str], **_kwargs: object) -> _RemoteProcess:
                    popen_calls.append(argv)
                    if argv and argv[0] == "ssh":
                        return remote
                    raise AssertionError(
                        "op-michaelagents started before role SIGN_READY validation"
                    )

                argv = [
                    "run_v35_p30_local_custody.py",
                    "--protocol",
                    "/frozen/protocol.json",
                    "--request",
                    f"/ledger/requests/{expected_role}.json",
                    "--role",
                    expected_role,
                ]
                with (
                    mock.patch.object(sys, "argv", argv),
                    mock.patch.object(
                        local_custody,
                        "load_config",
                        return_value={
                            expected_role: f"op://MichaelAgents/{expected_role}/key"
                        },
                    ),
                    mock.patch.object(
                        local_custody.selectors,
                        "DefaultSelector",
                        return_value=_AlwaysReadySelector(),
                    ),
                    mock.patch.object(local_custody.os, "set_blocking"),
                    mock.patch.object(
                        local_custody,
                        "read_bounded_remote_line",
                        side_effect=[
                            json.dumps(ready).encode("utf-8"),
                            json.dumps(malformed).encode("utf-8"),
                        ],
                    ),
                    mock.patch.object(
                        local_custody.subprocess, "Popen", side_effect=popen
                    ),
                    self.assertRaisesRegex(
                        ValueError, "role sign-ready message is malformed"
                    ),
                ):
                    local_custody.main()

                self.assertEqual(len(popen_calls), 1)
                self.assertEqual(popen_calls[0][0], "ssh")
                self.assertTrue(remote.killed)


if __name__ == "__main__":
    unittest.main()
