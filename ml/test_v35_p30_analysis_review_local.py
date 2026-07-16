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

    def test_default_deny_sandbox_and_nonaccept_close_the_lane(self) -> None:
        capsule = self.root / "capsule"
        capsule.mkdir()
        profile = capsule / "sandbox.sb"
        profile.write_bytes(
            launcher.build_sandbox_profile(
                capsule=capsule,
                executable=Path(review.APPROVED_CLAUDE_EXECUTABLE["path"]),
            )
        )
        policy = profile.read_text()
        self.assertIn("(deny default)", policy)
        self.assertNotIn(str(Path.home() / ".claude"), policy)
        stdout, stderr = capsule / "stdout", capsule / "stderr"

        def fake_claude(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            self.assertEqual(argv[:3], ["/usr/bin/sandbox-exec", "-f", str(profile)])
            os.write(int(kwargs["stderr"]), b"sandbox: deny outcome read\n")
            return subprocess.CompletedProcess(argv, 1)

        with mock.patch.object(launcher.subprocess, "run", side_effect=fake_claude):
            _, _, code = launcher.run_fable(
                sandbox_argv=[
                    "/usr/bin/sandbox-exec",
                    "-f",
                    str(profile),
                    review.APPROVED_CLAUDE_EXECUTABLE["path"],
                ],
                cwd=capsule,
                stdout_path=stdout,
                stderr_path=stderr,
                timeout=10,
                environment={},
            )
        with self.assertRaisesRegex(RuntimeError, "consumed lane is closed"):
            launcher.require_exact_accept(
                stdout_path=stdout, stderr_path=stderr, exit_code=code
            )

    @unittest.skipUnless(
        Path("/usr/bin/sandbox-exec").is_file(),
        "sandbox-exec is required for the real denial smoke",
    )
    def test_real_sandbox_exec_denies_a_file_outside_the_capsule(self) -> None:
        capsule = self.root / "capsule"
        capsule.mkdir()
        report = self.root / "actual-report.json"
        report.write_text('{"secretOutcome":true}\n')
        profile = capsule / "real.sb"
        profile.write_bytes(
            launcher.build_sandbox_profile(capsule=capsule, executable=Path("/bin/cat"))
        )
        completed = subprocess.run(
            ["/usr/bin/sandbox-exec", "-f", str(profile), "/bin/cat", str(report)],
            capture_output=True,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertNotIn(b"secretOutcome", completed.stdout)

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

    def test_local_streams_are_o_excl_and_verdict_must_be_exact(self) -> None:
        stdout, stderr = self.root / "stdout", self.root / "stderr"
        stdout.write_text("existing\n")
        with mock.patch.object(launcher.subprocess, "run") as run:
            with self.assertRaises(FileExistsError):
                launcher.run_fable(
                    sandbox_argv=["sandbox-exec", "claude"],
                    cwd=self.root,
                    stdout_path=stdout,
                    stderr_path=stderr,
                    timeout=10,
                    environment={},
                )
        run.assert_not_called()
        stdout.unlink()

        def fake_claude(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            os.write(int(kwargs["stdout"]), b"Review found blocker\nVERDICT: REJECT\n")
            return subprocess.CompletedProcess(argv, 0)

        with mock.patch.object(launcher.subprocess, "run", side_effect=fake_claude):
            _, _, code = launcher.run_fable(
                sandbox_argv=["sandbox-exec", "claude"],
                cwd=self.root,
                stdout_path=stdout,
                stderr_path=stderr,
                timeout=10,
                environment={},
            )
        with self.assertRaisesRegex(RuntimeError, "consumed lane is closed"):
            launcher.require_exact_accept(
                stdout_path=stdout, stderr_path=stderr, exit_code=code
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
            },
            "predecessorSha256": sha256_file(draft_local),
            "expectedOutputPath": str(remote["receipt"]),
            "requestNonce": "f" * 64,
        }
        request_local.write_bytes(canonical_json(request) + b"\n")
        profile = capsule / "sandbox.sb"
        profile.write_bytes(
            launcher.build_sandbox_profile(
                capsule=capsule,
                executable=Path(review.APPROVED_CLAUDE_EXECUTABLE["path"]),
            )
        )
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
            "sandboxProfileSha256": sha256_file(profile),
            "reservedAtUtc": "2026-07-15T10:02:00.000000Z",
        }
        attempt_local.write_bytes(canonical_json(attempt) + b"\n")
        stdout, stderr = outputs / "fable.stdout", outputs / "fable.stderr"
        stdout.write_text("Review complete\nVERDICT: ACCEPT\n")
        stderr.write_bytes(b"")
        argv = review.expected_argv(
            local_draft_path=draft_local,
            draft_sha256=sha256_file(draft_local),
            local_manifest_path=manifest_local,
            manifest_sha256=sha256_file(manifest_local),
            local_request_path=request_local,
            request_sha256=sha256_file(request_local),
            remote_draft_path=str(remote["draft"]),
            remote_manifest_path=str(remote["manifest"]),
            claude_path=review.APPROVED_CLAUDE_EXECUTABLE["path"],
        )
        allowed_reads = sorted(
            {
                str(capsule),
                *review.sandbox_runtime_read_paths(
                    Path(review.APPROVED_CLAUDE_EXECUTABLE["path"])
                ),
            }
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
            "sandboxArgv": ["/usr/bin/sandbox-exec", "-f", str(profile), *argv],
            "cwd": str(capsule),
            "environment": {
                "clearInherited": True,
                "keys": list(review.SANITIZED_ENVIRONMENT_KEYS),
                "secretKeys": [review.CLAUDE_AUTH_ENVIRONMENT_KEY],
                "home": str(capsule / "runtime-home"),
                "tmpdir": str(capsule / "tmp"),
            },
            "sandbox": {
                "backend": "sandbox-exec",
                "backendPath": "/usr/bin/sandbox-exec",
                "profilePath": str(profile),
                "profileSha256": sha256_file(profile),
                "defaultDecision": "deny",
                "allowedReadPaths": allowed_reads,
                "allowedWritePaths": [str(capsule)],
                "network": ["outbound"],
                "filesystemSecretsAllowed": False,
            },
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
