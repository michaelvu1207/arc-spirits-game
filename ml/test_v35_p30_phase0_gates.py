from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_campaign as campaign
import run_v35_p30_cuda_determinism as cuda_determinism
import v35_p30_phase0 as phase0
from v35_p30_crypto import sha256_file


class P30Phase0SchedulerGateTests(unittest.TestCase):
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
            pinned = {
                "path": "/pinned/claude",
                "sha256": "a" * 64,
                "version": "2.1.211 (Claude Code)",
            }
            protocol = {
                "sourceContract": {"sha256": "b" * 64},
                "executionTrust": {
                    "reviewRuntime": {"claudeExecutable": pinned},
                },
            }
            inputs = [{"path": "/input", "sha256": "c" * 64}]
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
                "claudeExecutable": pinned,
                "sandboxProfileSha256": "d" * 64,
                "argv": [
                    "/usr/bin/sandbox-exec",
                    "-f",
                    "/capsule/sandbox.sb",
                    pinned["path"],
                    "-p",
                    "--model",
                    "fable",
                    "--effort",
                    "high",
                    "--tools",
                    "Read",
                    "--no-session-persistence",
                    "review prompt",
                ],
                "environmentKeys": sorted(
                    {
                        "HOME",
                        "LANG",
                        "LC_ALL",
                        "NO_COLOR",
                        "PATH",
                        "TMPDIR",
                        "XDG_CACHE_HOME",
                        "XDG_CONFIG_HOME",
                        "XDG_DATA_HOME",
                    }
                ),
                "startedAtUtc": "2026-07-16T00:00:00Z",
                "finishedAtUtc": "2026-07-16T00:01:00Z",
                "exitCode": 0,
                "stdout": phase0.binding(paths["stdout"]),
                "stderr": phase0.binding(paths["stderr"]),
                "signature": {},
            }
            with (
                mock.patch.object(phase0, "gate_review_paths", return_value=paths),
                mock.patch.object(phase0, "_read_object", return_value=payload),
                mock.patch.object(
                    phase0, "role_public_key_path", return_value=root / "review.pem"
                ),
                mock.patch.object(
                    phase0, "verify_signed_payload", return_value=payload
                ),
            ):
                observed = phase0.validate_gate_review_receipt(
                    protocol=protocol,
                    protocol_path=protocol_path,
                    mode="phase0-runtime",
                    required_inputs=inputs,
                )
                self.assertEqual(observed, payload)
                changed = dict(payload)
                changed["claudeExecutable"] = {**pinned, "sha256": "e" * 64}
                with (
                    mock.patch.object(phase0, "_read_object", return_value=changed),
                    mock.patch.object(
                        phase0, "verify_signed_payload", return_value=changed
                    ),
                    self.assertRaisesRegex(ValueError, "review receipt is invalid"),
                ):
                    phase0.validate_gate_review_receipt(
                        protocol=protocol,
                        protocol_path=protocol_path,
                        mode="phase0-runtime",
                        required_inputs=inputs,
                    )


if __name__ == "__main__":
    unittest.main()
