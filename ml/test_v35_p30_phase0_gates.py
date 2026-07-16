from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_campaign as campaign
import run_v35_p30_cuda_determinism as cuda_determinism
import run_v35_p30_gate_review_local as gate_review_local
from issue_v35_p30_preflight_authorization import cuda_socket_root
import v35_p30_phase0 as phase0
import v35_p30_analysis_review as review
from v35_p30_crypto import canonical_json, sha256_bytes, sha256_file


class P30Phase0SchedulerGateTests(unittest.TestCase):
    def test_scheduler_and_validator_share_the_gate_review_request_binding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            campaign_id = "a" * 64
            protocol = {
                "executionTrust": {
                    "ledgerRoot": str(root / "ledger"),
                    "campaignInstanceId": campaign_id,
                    "reviewRuntime": review.APPROVED_REVIEW_RUNTIME,
                }
            }
            paths = phase0.gate_review_paths(protocol, "phase0-runtime")
            expected = (
                root
                / "ledger"
                / campaign_id
                / "requests"
                / "phase0-runtime-fable-review.json"
            )
            self.assertEqual(paths["request"], expected)
            expected.parent.mkdir(parents=True)
            expected.write_text("{}\n")
            public_key = root / "review-attester.pem"
            public_key.write_text("public\n")
            request = {
                "subject": {"logicalId": "phase0-runtime-fable-review"}
            }
            with (
                mock.patch.object(campaign, "emit_request", return_value=request),
                mock.patch.object(
                    campaign, "role_public_key_path", return_value=public_key
                ),
            ):
                status = campaign._review_required_status(
                    protocol_path=root / "protocol.json",
                    protocol=protocol,
                    mode="phase0-runtime",
                    inputs=[{"path": "/input", "sha256": "b" * 64}],
                )
            self.assertEqual(status["reviewRequest"], phase0.binding(expected))

    def test_phase0_action_precedes_preflight_start_and_generation(self) -> None:
        protocol_path = Path("/frozen/protocol.json")
        protocol = {"executionTrust": {"campaignInstanceId": "a" * 64}}
        expected = {"verb": "issue-preflight-execution"}
        with (
            mock.patch.object(campaign, "read_json_object", return_value=protocol),
            mock.patch.object(campaign, "validate_protocol"),
            mock.patch.object(campaign, "_phase0_next", return_value=expected),
            mock.patch.object(
                campaign,
                "ensure_preflight_start",
                side_effect=AssertionError("generation preflight started early"),
            ) as start,
            mock.patch.object(
                campaign,
                "_generation_next",
                side_effect=AssertionError("generation scheduler entered early"),
            ) as generation,
        ):
            self.assertEqual(campaign.next_action(protocol_path), expected)
        start.assert_not_called()
        generation.assert_not_called()

    def test_missing_full_review_blocks_after_generation_one_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol_path = root / "protocol.json"
            protocol_path.write_text("{}\n")
            preflight = root / "preflight.json"
            preflight.write_text("{}\n")
            protocol = {
                "plan": "plan.md",
                "sourceContract": {"artifact": "source.json", "sha256": "b" * 64},
                "executionTrust": {
                    "campaignInstanceId": "a" * 64,
                    "ledgerRoot": str(root / "ledger"),
                },
            }
            expected = {"status": "awaiting-full-campaign-fable-review"}
            generation_results = iter([None, None, None])
            with (
                mock.patch.object(campaign, "read_json_object", return_value=protocol),
                mock.patch.object(campaign, "validate_protocol"),
                mock.patch.object(campaign, "_phase0_next", return_value=None),
                mock.patch.object(campaign, "require_phase0_readiness"),
                mock.patch.object(campaign, "ensure_preflight_start"),
                mock.patch.object(
                    campaign, "_generation_next", side_effect=generation_results
                ),
                mock.patch.object(campaign, "preflight_path", return_value=preflight),
                mock.patch.object(campaign, "require_preflight"),
                mock.patch.object(
                    campaign,
                    "full_campaign_review_inputs",
                    return_value=[{"path": "/input", "sha256": "c" * 64}],
                ),
                mock.patch.object(
                    campaign,
                    "gate_review_paths",
                    return_value={"receipt": root / "missing-review.json"},
                ),
                mock.patch.object(
                    campaign, "_review_required_status", return_value=expected
                ),
                mock.patch.object(
                    campaign,
                    "_rolling_budget_guard",
                    side_effect=AssertionError("full campaign entered without review"),
                ) as rolling,
            ):
                self.assertEqual(campaign.next_action(protocol_path), expected)
            rolling.assert_not_called()


class P30CudaDeterminismOutputTests(unittest.TestCase):
    def test_cuda_socket_namespace_is_full_id_bound_and_below_linux_limit(self) -> None:
        campaign_id = "a" * 64
        root = cuda_socket_root(campaign_id)
        self.assertEqual(root, Path("/dev/shm/p") / campaign_id)
        for name in ("p30d-primary.sock", "p30d-replay.sock"):
            self.assertLessEqual(len(str(root / name).encode()), 107)

    def test_supervisor_precreated_empty_attempt_directory_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "primary"
            output.mkdir()
            cuda_determinism._prepare_attempt_output_dir(output)
            self.assertTrue(output.is_dir())
            self.assertEqual(list(output.iterdir()), [])

    def test_nonempty_attempt_directory_is_never_reused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "primary"
            output.mkdir()
            (output / "stale").write_text("stale\n")
            with self.assertRaisesRegex(FileExistsError, "not empty"):
                cuda_determinism._prepare_attempt_output_dir(output)

    def test_nondirectory_attempt_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "primary"
            output.write_text("not a directory\n")
            with self.assertRaisesRegex(ValueError, "plain directory"):
                cuda_determinism._prepare_attempt_output_dir(output)

    def test_symlink_attempt_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.mkdir()
            output = root / "primary"
            output.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "plain directory"):
                cuda_determinism._prepare_attempt_output_dir(output)


class P30GateReviewReceiptTests(unittest.TestCase):
    def test_fetch_lets_scp_create_then_seals_the_input_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "capsule" / "input.json"
            payload = b'{"safe":true}\n'

            def fake_scp(argv: list[str], **_: object) -> mock.Mock:
                self.assertEqual(Path(argv[-1]), target)
                self.assertFalse(target.exists())
                target.write_bytes(payload)
                return mock.Mock(stdout=b"", stderr=b"")

            with mock.patch.object(
                gate_review_local.subprocess, "run", side_effect=fake_scp
            ):
                gate_review_local.fetch(
                    remote="simforge1",
                    binding={
                        "path": "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger/input.json",
                        "sha256": phase0.sha256_bytes(payload),
                    },
                    target=target,
                    timeout=10,
                )
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(target.stat().st_mode & 0o777, 0o400)

    def test_validator_requires_the_protocol_pinned_claude_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            paths = {
                name: root / filename
                for name, filename in {
                    "request": "request.json",
                    "attempt": "attempt.json",
                    "stdout": "stdout",
                    "stderr": "stderr",
                    "receipt": "receipt.json",
                }.items()
            }
            for name in ("request", "attempt", "receipt"):
                paths[name].write_text("{}\n")
            paths["stdout"].write_text("review\nVERDICT: ACCEPT\n")
            paths["stderr"].write_bytes(b"")
            protocol_path = root / "protocol.json"
            protocol_path.write_text("{}\n")
            pinned = review.APPROVED_CLAUDE_EXECUTABLE
            protocol = {
                "sourceContract": {"sha256": "b" * 64},
                "executionTrust": {
                    "reviewRuntime": review.APPROVED_REVIEW_RUNTIME,
                },
            }
            inputs = [
                {"path": str(protocol_path), "sha256": sha256_file(protocol_path)},
                {"path": "/plan.json", "sha256": "c" * 64},
                {"path": "/source.json", "sha256": "b" * 64},
            ]
            request_value = {
                "role": "review-attester",
                "verb": "attest-gate-review",
                "subject": {
                    "logicalId": "phase0-runtime-fable-review",
                    "mode": "phase0-runtime",
                    "inputs": inputs,
                    "reviewRuntime": review.APPROVED_REVIEW_RUNTIME,
                    "launcherSha256": phase0.gate_review_launcher_sha256(),
                },
                "expectedOutputPath": str(paths["receipt"]),
            }
            paths["request"].write_bytes(canonical_json(request_value) + b"\n")
            container_name = "arc-p30-review-0123456789abcdef"
            container_id = "1" * 64
            prompt = phase0.gate_review_prompt(
                "phase0-runtime", [
                    "/review/inputs/input-00.json",
                    "/review/inputs/input-01.json",
                    "/review/inputs/input-02.json",
                ]
            )
            claude_argv = [
                pinned["path"], "-p", "--model", "fable", "--effort", "high",
                "--tools", "Read", "--no-session-persistence", prompt,
            ]
            create_argv = review.expected_container_create_argv(
                capsule=root, container_name=container_name, claude_argv=claude_argv
            )
            config = review.expected_container_config(
                capsule=root, container_name=container_name, container_id=container_id,
                claude_argv=claude_argv,
            )
            liveness_name = "arc-p30-review-fedcba9876543210"
            liveness_id = "3" * 64
            liveness_argv = review.liveness_claude_argv()
            liveness_create = review.expected_container_create_argv(
                capsule=root, container_name=liveness_name, claude_argv=liveness_argv
            )
            liveness_config = review.expected_container_config(
                capsule=root, container_name=liveness_name, container_id=liveness_id,
                claude_argv=liveness_argv,
            )
            liveness_stdout, liveness_stderr = root / "liveness.stdout", root / "liveness.stderr"
            liveness_stdout.write_bytes(review.REVIEW_LIVENESS_STDOUT)
            liveness_stderr.write_bytes(b"")
            authenticated_liveness = {
                "schemaVersion": review.REVIEW_LIVENESS_SCHEMA, "valid": True,
                "immutable": True, "outcomesInspected": False,
                "promotionEligible": False, "model": "fable", "effort": "high",
                "tools": ["Read"], "noSessionPersistence": True,
                "authDelivery": review.CLAUDE_AUTH_DELIVERY,
                "prompt": review.REVIEW_LIVENESS_PROMPT,
                "containerArgv": liveness_create, "containerName": liveness_name,
                "containerInvocationSha256": sha256_bytes(canonical_json(liveness_create)),
                "containerId": liveness_id, "containerConfig": liveness_config,
                "containerConfigSha256": sha256_bytes(canonical_json(liveness_config)),
                "startArgv": review.expected_container_start_argv(liveness_name),
                "cleanupArgv": review.expected_container_cleanup_argv(liveness_name),
                "cleanupVerified": True,
                "startedAtUtc": "2026-07-16T00:00:01Z",
                "finishedAtUtc": "2026-07-16T00:00:02Z", "exitCode": 0,
                "stdout": {"path": str(liveness_stdout), "sha256": sha256_file(liveness_stdout), "bytes": liveness_stdout.stat().st_size},
                "stderr": {"path": str(liveness_stderr), "sha256": sha256_file(liveness_stderr), "bytes": 0},
            }
            clock_skew = {
                "schemaVersion": review.CLOCK_SKEW_SCHEMA, "valid": True,
                "localBeforeUtc": "2026-07-16T00:00:00Z",
                "remoteUtc": "2026-07-16T00:00:01Z",
                "localAfterUtc": "2026-07-16T00:00:02Z",
                "roundTripMs": 2000, "absoluteSkewMs": 0,
            }
            attempt = {
                "schemaVersion": "arc-v35-p30-gate-review-attempt-v2",
                "valid": True, "immutable": True, "promotionEligible": False,
                "outcomesInspected": False, "mode": "phase0-runtime",
                "request": phase0.binding(paths["request"]),
                "inputsSha256": phase0.outcome_blind_inputs_hash(inputs),
                "launcherSha256": phase0.gate_review_launcher_sha256(),
                "claudeExecutable": pinned,
                "containerRuntime": review.APPROVED_REVIEW_CONTAINER,
                "containerName": container_name,
                "containerInvocationSha256": sha256_bytes(canonical_json(create_argv)),
                "containerId": container_id,
                "containerConfigSha256": sha256_bytes(canonical_json(config)),
                "authenticatedLiveness": authenticated_liveness,
                "clockSkewPreflight": clock_skew,
                "nonce": "2" * 64,
                "reservedAtUtc": "2026-07-16T00:00:00Z",
            }
            paths["attempt"].write_bytes(canonical_json(attempt) + b"\n")
            completion_path = root / "review-completion.json"
            gate_review_local.create_review_completion(
                path=completion_path, attempt_path=paths["attempt"],
                stdout_path=paths["stdout"], stderr_path=paths["stderr"],
                started="2026-07-16T00:00:03Z", finished="2026-07-16T00:01:00Z",
                exit_code=0, container_name=container_name,
            )
            payload = {
                "schemaVersion": phase0.REVIEW_RECEIPT_SCHEMA,
                "valid": True,
                "immutable": True,
                "promotionEligible": False,
                "outcomesInspected": False,
                "mode": "phase0-runtime",
                "model": "fable",
                "effort": "high",
                "tools": ["Read"],
                "noSessionPersistence": True,
                "verdict": "ACCEPT",
                "protocol": {
                    "path": str(protocol_path),
                    "sha256": sha256_file(protocol_path),
                },
                "sourceContractSha256": "b" * 64,
                "inputs": inputs,
                "request": phase0.binding(paths["request"]),
                "attempt": phase0.binding(paths["attempt"]),
                "launcherSha256": phase0.gate_review_launcher_sha256(),
                "claudeExecutable": pinned,
                "containerRuntime": review.APPROVED_REVIEW_CONTAINER,
                "containerArgv": create_argv,
                "containerName": container_name,
                "containerInvocationSha256": sha256_bytes(canonical_json(create_argv)),
                "containerId": container_id,
                "containerConfig": config,
                "containerConfigSha256": sha256_bytes(canonical_json(config)),
                "startArgv": review.expected_container_start_argv(container_name),
                "cleanupArgv": review.expected_container_cleanup_argv(container_name),
                "cleanupVerified": True,
                "argv": claude_argv,
                "cwd": str(root),
                "containerCwd": "/review",
                "environmentKeys": list(review.SANITIZED_ENVIRONMENT_KEYS),
                "authDelivery": review.CLAUDE_AUTH_DELIVERY,
                "startedAtUtc": "2026-07-16T00:00:00Z",
                "finishedAtUtc": "2026-07-16T00:01:00Z",
                "exitCode": 0,
                "stdout": phase0.binding(paths["stdout"]),
                "stderr": phase0.binding(paths["stderr"]),
                "signature": {},
            }
            status = {
                "inputs": inputs, "reviewRequest": phase0.binding(paths["request"]),
                "attemptPath": str(paths["attempt"]), "stdoutPath": str(paths["stdout"]),
                "stderrPath": str(paths["stderr"]), "receiptPath": str(paths["receipt"]),
            }
            payload = gate_review_local.build_gate_review_payload(
                status=status, mode="phase0-runtime", attempt_local=paths["attempt"],
                completion_path=completion_path, executable=pinned,
                container_runtime=review.APPROVED_REVIEW_CONTAINER,
                container_argv=create_argv, container_name=container_name,
                container_invocation_sha256=sha256_bytes(canonical_json(create_argv)),
                container_id=container_id, container_config=config,
                container_config_sha256=sha256_bytes(canonical_json(config)),
                authenticated_liveness=authenticated_liveness,
                clock_skew_preflight=clock_skew,
                start_argv=review.expected_container_start_argv(container_name),
                cleanup_argv=review.expected_container_cleanup_argv(container_name),
                cleanup_verified=True, claude_argv=claude_argv, capsule=root,
                environment={}, started="2026-07-16T00:00:03Z",
                finished="2026-07-16T00:01:00Z", exit_code=0,
                stdout=paths["stdout"], stderr=paths["stderr"],
            )
            payload["signature"] = {}
            unsigned_payload = dict(payload)
            del unsigned_payload["signature"]
            gate_review_local.validate_gate_unsigned_for_signing(unsigned_payload)
            paths["receipt"].write_bytes(canonical_json(payload) + b"\n")
            with mock.patch.object(phase0, "gate_review_paths", return_value=paths), mock.patch.object(
                phase0, "role_public_key_path", return_value=root / "review.pem"
            ), mock.patch.object(phase0, "verify_signed_payload", return_value=payload):
                observed = phase0.validate_gate_review_receipt(
                    protocol=protocol,
                    protocol_path=protocol_path,
                    mode="phase0-runtime",
                    required_inputs=inputs,
                )
                self.assertEqual(observed, payload)
                changed = dict(payload)
                changed["claudeExecutable"] = {**pinned, "sha256": "e" * 64}
                paths["receipt"].write_bytes(canonical_json(changed) + b"\n")
                with mock.patch.object(
                    phase0, "verify_signed_payload", return_value=changed
                ), self.assertRaisesRegex(ValueError, "review receipt is invalid"):
                    phase0.validate_gate_review_receipt(
                        protocol=protocol,
                        protocol_path=protocol_path,
                        mode="phase0-runtime",
                        required_inputs=inputs,
                    )
                changed_launcher = dict(payload)
                changed_launcher["launcherSha256"] = "e" * 64
                paths["receipt"].write_bytes(canonical_json(changed_launcher) + b"\n")
                with mock.patch.object(
                    phase0, "verify_signed_payload", return_value=changed_launcher
                ), self.assertRaisesRegex(ValueError, "review receipt is invalid"):
                    phase0.validate_gate_review_receipt(
                        protocol=protocol,
                        protocol_path=protocol_path,
                        mode="phase0-runtime",
                        required_inputs=inputs,
                    )


if __name__ == "__main__":
    unittest.main()
