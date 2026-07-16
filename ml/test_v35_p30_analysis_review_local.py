from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import run_v35_p30_analysis_review_local as launcher
import v35_p30_analysis_review as review
from v35_p30_crypto import canonical_json, sha256_bytes, sha256_file


class P30LocalAnalysisReviewLauncherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_scp_hash_mismatch_fails_closed_and_removes_copy(self) -> None:
        target = self.root / "manifest.json"

        def fake_run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess:
            self.assertEqual(argv[0], "scp")
            Path(argv[-1]).write_bytes(b"tampered")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with mock.patch.object(launcher.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "scheduler-declared hash"):
                launcher.fetch_remote_file(
                    remote="simforge1",
                    remote_path=(
                        "/data/share8/michaelvuaprilexperimentation/"
                        "arc-v35-p30-ledger/" + "a" * 64 + "/analysis/input.json"
                    ),
                    target=target,
                    expected_sha256=sha256_bytes(b"expected"),
                    timeout=10,
                )
        self.assertFalse(target.exists())

    def test_container_contract_has_no_secret_and_nonaccept_closes_the_lane(self) -> None:
        capsule = self.root / "capsule"
        capsule.mkdir()
        claude_argv = [
            review.APPROVED_CLAUDE_EXECUTABLE["path"], "-p", "--model", "fable",
            "--effort", "high", "--tools", "Read", "--no-session-persistence",
            "VERDICT: ACCEPT",
        ]
        argv = review.expected_container_create_argv(
            capsule=capsule, container_name="arc-p30-review-0123456789abcdef",
            claude_argv=claude_argv,
        )
        joined = "\n".join(argv)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=0", argv)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN=", joined)
        self.assertIn("seccomp=builtin", argv)
        self.assertIn("no-new-privileges", argv)
        stdout, stderr = capsule / "stdout", capsule / "stderr"
        stdout.write_text("VERDICT: REJECT\n")
        stderr.write_bytes(b"")
        with self.assertRaisesRegex(RuntimeError, "consumed lane is closed"):
            launcher.require_exact_accept(
                stdout_path=stdout, stderr_path=stderr, exit_code=0
            )

    @unittest.skipUnless(
        Path("/usr/local/bin/docker").is_file(),
        "Docker is required for the real isolation smoke",
    )
    def test_real_container_is_read_only_capless_and_seccomp_filtered(self) -> None:
        capsule = self.root / "capsule"
        capsule.mkdir()
        report = self.root / "actual-report.json"
        report.write_text('{"secretOutcome":true}\n')
        completed = subprocess.run(
            [
                "/usr/local/bin/docker", "run", "--rm", "--pull", "never",
                "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--security-opt", "seccomp=builtin",
                "--mount", f"type=bind,src={capsule},dst=/review,readonly",
                "--entrypoint", "/bin/sh",
                review.APPROVED_REVIEW_CONTAINER["image"]["reference"], "-c",
                f"test ! -e {report}; ! touch /review/forbidden; "
                "grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status",
            ],
            capture_output=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(b"secretOutcome", completed.stdout)
        self.assertIn(b"NoNewPrivs:\t1", completed.stdout)
        self.assertIn(b"Seccomp:\t2", completed.stdout)
        self.assertIn(b"CapEff:\t0000000000000000", completed.stdout)

    def test_remote_attempt_failure_is_terminal_before_fable(self) -> None:
        remote_path = (
            "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger/"
            + "b" * 64
            + "/analysis/review/attempt.json"
        )
        completed = subprocess.CompletedProcess(["ssh"], 1, b"", b"exists")
        with mock.patch.object(launcher.subprocess, "run", return_value=completed) as run:
            with self.assertRaisesRegex(FileExistsError, "already consumed"):
                launcher.reserve_remote_attempt(
                    remote="simforge1",
                    remote_path=remote_path,
                    payload=b"{}\n",
                    timeout=10,
                )
        self.assertEqual(run.call_args.args[0][0], "ssh")

    def test_postprocess_marker_allows_only_byte_identical_non_fable_resume(self) -> None:
        attempt = self.root / "attempt.json"
        completion = self.root / "completion.json"
        unsigned = self.root / "unsigned.json"
        signed = self.root / "signed.json"
        for path, data in ((attempt, b"attempt\n"), (completion, b"completion\n"), (unsigned, b"unsigned\n")):
            path.write_bytes(data)
        marker_path = self.root / "postprocess.json"
        marker = launcher.create_postprocess_marker(
            path=marker_path, unsigned=unsigned, completion=completion,
            attempt=attempt, signed=signed,
            uploads=["/remote/stdout", "/remote/stderr", "/remote/receipt"],
            created_at="2026-07-16T00:00:00Z",
        )
        self.assertFalse(marker["fableRerunAllowed"])
        self.assertEqual(
            launcher.validate_postprocess_marker(marker, path=marker_path), marker
        )
        unsigned.write_bytes(b"changed\n")
        with self.assertRaisesRegex(ValueError, "binding changed"):
            launcher.validate_postprocess_marker(marker, path=marker_path)

    def test_local_streams_are_o_excl_and_verdict_must_be_exact(self) -> None:
        stdout, stderr = self.root / "stdout", self.root / "stderr"
        stdout.write_text("existing\n")
        with mock.patch.object(launcher.subprocess, "Popen") as popen:
            with self.assertRaises(FileExistsError):
                launcher.run_fable(
                    start_argv=["docker", "start"],
                    claude_auth=bytearray(b"token"),
                    cwd=self.root,
                    stdout_path=stdout,
                    stderr_path=stderr,
                    timeout=10,
                    environment={},
                )
        popen.assert_not_called()
        stdout.unlink()

        stdout.write_text("Review found blocker\nVERDICT: REJECT\n")
        stderr.write_bytes(b"")
        with self.assertRaisesRegex(RuntimeError, "consumed lane is closed"):
            launcher.require_exact_accept(
                stdout_path=stdout, stderr_path=stderr, exit_code=0
            )

    def _complete_receipt_fixture(self) -> tuple[dict, dict[str, Path], bytes]:
        capsule = self.root / "capsule"
        inputs, outputs = capsule / "inputs", capsule / "outputs"
        inputs.mkdir(parents=True)
        outputs.mkdir()
        remote_root = Path(
            "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger/"
            + "c" * 64
        )
        remote = {
            "manifest": remote_root / "analysis/input-manifest.signed.json",
            "draft": remote_root / "analysis/analysis-authorization.unsigned.json",
            "request": remote_root / "requests/final-analysis-fable-review-attestation.json",
            "attempt": remote_root / "analysis/review/attempt.json",
            "receipt": remote_root / "analysis/review/receipt.json",
            "stdout": remote_root / "analysis/review/fable.stdout",
            "stderr": remote_root / "analysis/review/fable.stderr",
            "public": remote_root / "trust/review-attester-public.pem",
        }
        private = Ed25519PrivateKey.generate()
        private_pem = private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        public_local = inputs / "review-attester-public.pem"
        public_local.write_bytes(
            private.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        repo_root = Path(launcher.__file__).resolve().parents[1]
        launcher_sha = sha256_file(repo_root / review.LOCAL_REVIEW_LAUNCHER_RELATIVE)
        source_lock = inputs / "source-lock.json"
        source_lock.write_bytes(
            canonical_json(
                {
                    "schemaVersion": "arc-v35-p30-source-lock-v1",
                    "files": {
                        "launcher": {
                            "path": review.LOCAL_REVIEW_LAUNCHER_RELATIVE,
                            "sha256": launcher_sha,
                            "gitBlobOid": "synthetic",
                        }
                    },
                }
            )
            + b"\n"
        )
        manifest_local = inputs / "manifest.signed.json"
        manifest_local.write_bytes(
            canonical_json(
                {
                    "schemaVersion": "arc-v35-p30-analysis-manifest-v1",
                    "issuedAtUtc": "2026-07-15T10:00:00.000000Z",
                }
            )
            + b"\n"
        )
        draft_local = inputs / "analysis-authorization.unsigned.json"
        draft_local.write_bytes(
            canonical_json(
                {
                    "issuedAtUtc": "2026-07-15T10:01:00.000000Z",
                    "sourceContract": {
                        "path": "/remote/source-lock.json",
                        "sha256": sha256_file(source_lock),
                    },
                }
            )
            + b"\n"
        )
        request_local = inputs / "review-attester-request.json"
        request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "c" * 64,
            "protocol": {"path": "/remote/protocol.json", "sha256": "e" * 64},
            "role": "review-attester",
            "verb": "attest-analysis-review",
            "subject": {
                "logicalId": "final-analysis-fable-review-attestation",
                "authorizationDraft": {
                    "path": str(remote["draft"]),
                    "sha256": sha256_file(draft_local),
                },
                "manifest": {
                    "path": str(remote["manifest"]),
                    "sha256": sha256_file(manifest_local),
                },
                "reviewAttemptPath": str(remote["attempt"]),
                "reviewStdoutPath": str(remote["stdout"]),
                "reviewStderrPath": str(remote["stderr"]),
                "reviewAttesterPublicKey": {
                    "path": str(remote["public"]),
                    "sha256": sha256_file(public_local),
                },
                "claudeExecutable": dict(review.APPROVED_CLAUDE_EXECUTABLE),
                "reviewRuntime": review.APPROVED_REVIEW_RUNTIME,
                "launcherSha256": launcher_sha,
            },
            "predecessorSha256": sha256_file(draft_local),
            "expectedOutputPath": str(remote["receipt"]),
            "requestNonce": "f" * 64,
        }
        request_local.write_bytes(canonical_json(request) + b"\n")
        argv = review.expected_argv(
            local_draft_path=review.CONTAINER_REVIEW_ROOT / "inputs/analysis-authorization.unsigned.json",
            draft_sha256=sha256_file(draft_local),
            local_manifest_path=review.CONTAINER_REVIEW_ROOT / "inputs/manifest.signed.json",
            manifest_sha256=sha256_file(manifest_local),
            local_request_path=review.CONTAINER_REVIEW_ROOT / "inputs/review-attester-request.json",
            request_sha256=sha256_file(request_local),
            remote_draft_path=str(remote["draft"]),
            remote_manifest_path=str(remote["manifest"]),
            claude_path=review.APPROVED_CLAUDE_EXECUTABLE["path"],
        )
        container_name = "arc-p30-review-0123456789abcdef"
        container_id = "1" * 64
        container_argv = review.expected_container_create_argv(
            capsule=capsule, container_name=container_name, claude_argv=argv
        )
        container_config = review.expected_container_config(
            capsule=capsule, container_name=container_name,
            container_id=container_id, claude_argv=argv,
        )
        liveness_name = "arc-p30-review-fedcba9876543210"
        liveness_id = "2" * 64
        liveness_argv = review.liveness_claude_argv()
        liveness_create = review.expected_container_create_argv(
            capsule=capsule, container_name=liveness_name, claude_argv=liveness_argv
        )
        liveness_config = review.expected_container_config(
            capsule=capsule, container_name=liveness_name,
            container_id=liveness_id, claude_argv=liveness_argv,
        )
        liveness_stdout, liveness_stderr = outputs / "liveness.stdout", outputs / "liveness.stderr"
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
            "startedAtUtc": "2026-07-15T10:01:10.000000Z",
            "finishedAtUtc": "2026-07-15T10:01:20.000000Z", "exitCode": 0,
            "stdout": {"path": str(liveness_stdout), "sha256": sha256_file(liveness_stdout), "bytes": liveness_stdout.stat().st_size},
            "stderr": {"path": str(liveness_stderr), "sha256": sha256_file(liveness_stderr), "bytes": 0},
        }
        clock_skew = {
            "schemaVersion": review.CLOCK_SKEW_SCHEMA, "valid": True,
            "localBeforeUtc": "2026-07-15T10:01:30.000000Z",
            "remoteUtc": "2026-07-15T10:01:31.000000Z",
            "localAfterUtc": "2026-07-15T10:01:32.000000Z",
            "roundTripMs": 2000, "absoluteSkewMs": 0,
        }
        request_binding = {"path": str(remote["request"]), "sha256": sha256_file(request_local)}
        attempt_local = inputs / "review-attempt.json"
        attempt = {
            "schemaVersion": review.ANALYSIS_REVIEW_ATTEMPT_SCHEMA,
            "valid": True,
            "immutable": True,
            "outcomesInspected": False,
            "promotionEligible": False,
            "request": request_binding,
            "authorizationDraft": {
                "path": str(remote["draft"]),
                "sha256": sha256_file(draft_local),
            },
            "manifest": {
                "path": str(remote["manifest"]),
                "sha256": sha256_file(manifest_local),
            },
            "attemptPath": str(remote["attempt"]),
            "receiptPath": str(remote["receipt"]),
            "stdoutPath": str(remote["stdout"]),
            "stderrPath": str(remote["stderr"]),
            "sourceLockSha256": sha256_file(source_lock),
            "launcherSha256": launcher_sha,
            "claudeExecutable": dict(review.APPROVED_CLAUDE_EXECUTABLE),
            "containerRuntime": review.APPROVED_REVIEW_CONTAINER,
            "containerName": container_name,
            "containerInvocationSha256": sha256_bytes(canonical_json(container_argv)),
            "containerId": container_id,
            "containerConfigSha256": sha256_bytes(canonical_json(container_config)),
            "authenticatedLiveness": authenticated_liveness,
            "clockSkewPreflight": clock_skew,
            "reservedAtUtc": "2026-07-15T10:02:00.000000Z",
        }
        attempt_local.write_bytes(canonical_json(attempt) + b"\n")
        stdout, stderr = outputs / "fable.stdout", outputs / "fable.stderr"
        stdout.write_text("Review complete\nVERDICT: ACCEPT\n")
        stderr.write_bytes(b"")
        completion_path = outputs / "review-completion.json"
        launcher.create_review_completion(
            path=completion_path, attempt_path=attempt_local, stdout_path=stdout,
            stderr_path=stderr, started="2026-07-15T10:03:00.000000Z",
            finished="2026-07-15T10:04:00.000000Z", exit_code=0,
            container_name=container_name,
        )
        receipt = {
            "schemaVersion": review.ANALYSIS_REVIEW_RECEIPT_SCHEMA,
            "valid": True,
            "immutable": True,
            "outcomesInspected": False,
            "promotionEligible": False,
            "targetDraftPath": str(remote["draft"]),
            "targetDraftSha256": sha256_file(draft_local),
            "manifestPath": str(remote["manifest"]),
            "manifestSha256": sha256_file(manifest_local),
            "reviewRequestPath": str(remote["request"]),
            "reviewRequestSha256": sha256_file(request_local),
            "reviewAttemptPath": str(remote["attempt"]),
            "reviewAttemptSha256": sha256_file(attempt_local),
            "localAttemptPath": str(attempt_local),
            "localAttemptSha256": sha256_file(attempt_local),
            "localTargetDraftPath": str(draft_local),
            "localTargetDraftSha256": sha256_file(draft_local),
            "localManifestPath": str(manifest_local),
            "localManifestSha256": sha256_file(manifest_local),
            "localReviewRequestPath": str(request_local),
            "localReviewRequestSha256": sha256_file(request_local),
            "sourceLockPath": "/remote/source-lock.json",
            "sourceLockSha256": sha256_file(source_lock),
            "localSourceLockPath": str(source_lock),
            "localSourceLockSha256": sha256_file(source_lock),
            "launcherRelativePath": review.LOCAL_REVIEW_LAUNCHER_RELATIVE,
            "launcherSha256": launcher_sha,
            "localRepoRoot": str(repo_root),
            "reviewAttesterPublicKeyPath": str(remote["public"]),
            "reviewAttesterPublicKeySha256": sha256_file(public_local),
            "localReviewAttesterPublicKeyPath": str(public_local),
            "localReviewAttesterPublicKeySha256": sha256_file(public_local),
            "model": "fable",
            "effort": "high",
            "tools": ["Read"],
            "noSessionPersistence": True,
            "claudeExecutable": dict(review.APPROVED_CLAUDE_EXECUTABLE),
            "argv": argv,
            "containerArgv": container_argv,
            "containerName": container_name,
            "containerInvocationSha256": sha256_bytes(canonical_json(container_argv)),
            "containerId": container_id,
            "containerConfig": container_config,
            "containerConfigSha256": sha256_bytes(canonical_json(container_config)),
            "startArgv": review.expected_container_start_argv(container_name),
            "cleanupArgv": review.expected_container_cleanup_argv(container_name),
            "cleanupVerified": True,
            "cwd": str(capsule),
            "containerCwd": str(review.CONTAINER_REVIEW_ROOT),
            "environment": {
                "clearInherited": True,
                "keys": list(review.SANITIZED_ENVIRONMENT_KEYS),
                "secretKeys": [],
                "authDelivery": review.CLAUDE_AUTH_DELIVERY,
                "home": str(capsule / "runtime-home"),
                "tmpdir": str(capsule / "tmp"),
            },
            "containerRuntime": review.APPROVED_REVIEW_CONTAINER,
            "startedAtUtc": "2026-07-15T10:03:00.000000Z",
            "finishedAtUtc": "2026-07-15T10:04:00.000000Z",
            "exitCode": 0,
            "stdoutPath": str(remote["stdout"]),
            "stdoutSha256": sha256_file(stdout),
            "localStdoutPath": str(stdout),
            "localStdoutSha256": sha256_file(stdout),
            "stderrPath": str(remote["stderr"]),
            "stderrSha256": sha256_file(stderr),
            "localStderrPath": str(stderr),
            "localStderrSha256": sha256_file(stderr),
            "verdict": "ACCEPT",
            "request": request_binding,
        }
        receipt = launcher.build_analysis_review_payload(
            status={
                "authorizationDraft": {"path": str(remote["draft"]), "sha256": sha256_file(draft_local)},
                "manifest": {"path": str(remote["manifest"]), "sha256": sha256_file(manifest_local)},
                "reviewAttestationRequest": request_binding,
                "reviewAttemptPath": str(remote["attempt"]),
                "reviewStdoutPath": str(remote["stdout"]),
                "reviewStderrPath": str(remote["stderr"]),
                "reviewAttesterPublicKey": {"path": str(remote["public"]), "sha256": sha256_file(public_local)},
            },
            repo_root=repo_root, capsule=capsule, manifest_local=manifest_local,
            draft_local=draft_local, request_local=request_local,
            source_lock_local=source_lock, review_attester_key_local=public_local,
            attempt_local=attempt_local, completion_path=completion_path,
            stdout_local=stdout, stderr_local=stderr,
            draft=json.loads(draft_local.read_text()), launcher_sha=launcher_sha,
            executable=dict(review.APPROVED_CLAUDE_EXECUTABLE), claude_argv=argv,
            container_argv=container_argv, container_name=container_name,
            container_invocation_sha256=sha256_bytes(canonical_json(container_argv)),
            container_id=container_id, container_config=container_config,
            container_config_sha256=sha256_bytes(canonical_json(container_config)),
            authenticated_liveness=authenticated_liveness,
            clock_skew_preflight=clock_skew,
            start_argv=review.expected_container_start_argv(container_name),
            cleanup_argv=review.expected_container_cleanup_argv(container_name),
            cleanup_verified=True, container_runtime=review.APPROVED_REVIEW_CONTAINER,
            started="2026-07-15T10:03:00.000000Z",
            finished="2026-07-15T10:04:00.000000Z", exit_code=0,
        )
        paths = {
            "draft": remote["draft"],
            "manifest": remote["manifest"],
            "public": public_local,
            "unsigned": outputs / "receipt.unsigned.json",
            "signed": outputs / "receipt.signed.json",
        }
        return receipt, paths, private_pem

    def test_complete_receipt_requires_the_local_only_review_attester(self) -> None:
        receipt, paths, private_pem = self._complete_receipt_fixture()
        self.assertIs(
            review.validate_local_analysis_review_payload(
                receipt,
                remote_draft_path=paths["draft"],
                remote_manifest_path=paths["manifest"],
                review_attester_public_key_path=paths["public"],
            ),
            receipt,
        )
        paths["unsigned"].write_bytes(canonical_json(receipt) + b"\n")
        read_fd, write_fd = os.pipe()
        os.write(write_fd, private_pem)
        os.close(write_fd)
        try:
            launcher.sign_receipt_from_stdin(
                unsigned_path=paths["unsigned"],
                signed_path=paths["signed"],
                review_attester_public_key_path=paths["public"],
                remote_draft_path=paths["draft"],
                remote_manifest_path=paths["manifest"],
                input_fd=read_fd,
            )
        finally:
            os.close(read_fd)
        signed = json.loads(paths["signed"].read_text())
        self.assertEqual(signed["signature"]["role"], "review-attester")
        review.validate_signed_local_analysis_review_payload(
            signed,
            remote_draft_path=paths["draft"],
            remote_manifest_path=paths["manifest"],
            review_attester_public_key_path=paths["public"],
        )

        forged = dict(signed)
        forged["signature"] = {**signed["signature"], "role": "guardian"}
        with self.assertRaisesRegex(ValueError, "signature (role|key identity)"):
            review.validate_signed_local_analysis_review_payload(
                forged,
                remote_draft_path=paths["draft"],
                remote_manifest_path=paths["manifest"],
                review_attester_public_key_path=paths["public"],
            )


if __name__ == "__main__":
    unittest.main()
