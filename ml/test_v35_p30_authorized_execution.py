from __future__ import annotations

import datetime as dt
import errno
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from v35_p30_authorized_execution import (
    AUTHORIZATION_SCHEMA,
    bubblewrap_command,
    normal_seal_attempt_path,
    prepare_execution_receipt,
    prepare_receipt_only_recovery_draft,
    recovery_seal_attempt_path,
    seal_receipt_only_recovery,
    seal_execution_receipt,
    validate_authorization,
    validate_nested_controller_mount_contract,
)
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    public_key_identity,
    read_regular_nofollow,
    sha256_bytes,
    sha256_file,
    sign_payload,
    validate_role_trust,
    verify_signed_payload,
)
from v35_p30_recovery import (
    ACTIONS,
    GUARDIAN_INCIDENT_SCHEMA,
    RECEIPT_ONLY,
    RECOVERY_LINK_SCHEMA,
    protected_bindings_sha256,
    recovery_execution_draft_path,
)


class AuthorizedExecutionTests(unittest.TestCase):
    def test_nested_controller_rejects_outer_nvidia_proc_submount(self) -> None:
        for entrypoint in (
            "ml/run_v35_p30_cuda_determinism.py",
            "ml/run_v35_p30_evaluation_attempt.py",
        ):
            with self.assertRaisesRegex(ValueError, "NVIDIA proc submount"):
                validate_nested_controller_mount_contract(
                    ["/venv/python", entrypoint],
                    ["/proc/driver/nvidia", "/usr"],
                )
            validate_nested_controller_mount_contract(
                ["/venv/python", entrypoint], ["/usr"]
            )

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.keys = {}
        for role in (
            "issuer",
            "executor",
            "guardian",
            "analysis-authorizer",
            "review-attester",
        ):
            private = self.root / f"{role}-private.pem"
            public = self.root / f"{role}-public.pem"
            subprocess.run(
                ["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(private)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)],
                check=True,
                capture_output=True,
            )
            self.keys[role] = (private, public)
        self.private, self.public = self.keys["issuer"]
        self.backend = self.root / "bwrap"
        self.backend.write_text(
            "#!/usr/bin/python3\n"
            "import os, sys\n"
            "index = sys.argv.index('--')\n"
            "os.execv(sys.argv[index + 1], sys.argv[index + 1:])\n"
        )
        self.backend.chmod(0o700)
        self.protocol = self.root / "protocol.json"
        self.source = self.root / "source.json"
        self.source.write_text("{}\n")
        campaign_instance = "f" * 64
        roles = {}
        policies = {
            "issuer": (["arc-v35-p30-execution-authorization-v1"], ["generation", "evaluation-primary", "evaluation-replay", "preflight"]),
            "executor": (["arc-v35-p30-authorized-execution-receipt-v1", "arc-v35-p30-executor-launch-permit-v1"], ["generation", "evaluation-primary", "evaluation-replay", "preflight", "analysis"]),
            "guardian": (["arc-v35-p30-outcome-blind-preflight-v1", "arc-v35-p30-final-generation-completeness-v1", "arc-v35-p30-evaluation-pair-integrity-v1", "arc-v35-p30-analysis-manifest-v1", "arc-v35-p30-phase0-readiness-v1", "arc-v35-p30-full-campaign-authorization-v1", "arc-v35-p30-recovery-incident-v1", "arc-v35-p30-logical-completion-v1"], []),
            "analysis-authorizer": (["arc-v35-p30-execution-authorization-v1"], ["analysis"]),
            "review-attester": (["arc-v35-p30-analysis-authorization-review-receipt-v2", "arc-v35-p30-gate-review-receipt-v1"], []),
        }
        for role, (_, public) in self.keys.items():
            key_id, public_der_sha256 = public_key_identity(public)
            schemas, kinds = policies[role]
            roles[role] = {
                "publicKeyPath": str(public),
                "publicKeyPemSha256": sha256_file(public),
                "publicKeyDerSha256": public_der_sha256,
                "keyId": key_id,
                "allowedArtifactSchemas": schemas,
                "allowedKinds": kinds,
            }
        base_ledger = self.root / "ledger"
        self.protocol.write_text(json.dumps({"executionTrust": {
            "schemaVersion": "arc-v35-p30-role-trust-v2",
            "algorithm": "Ed25519",
            "campaignInstanceId": campaign_instance,
            "roles": roles,
            "custody": {
                "provider": "1Password", "vault": "MichaelAgents",
                "secretGranularity": "one-item-per-role",
                "delivery": "encrypted-ssh-after-ready-to-sealed-memfd-cloexec",
                "schedulerPrivateKeyAccess": False,
                "maximumConcurrentPrivateKeyRoles": 1,
                "requirePrSetDumpableZero": True,
                "localOnlyRoles": ["review-attester"],
                "remoteDeliveryRoles": [
                    "issuer",
                    "executor",
                    "guardian",
                    "analysis-authorizer",
                ],
            },
            "ledgerRoot": str(base_ledger),
            "leasePath": str(self.root / "gpu7.lease"),
            "bubblewrapPath": str(self.backend),
            "bubblewrapSha256": sha256_file(self.backend),
            "reviewRuntime": {
                "attesterRole": "review-attester",
                "privateKeyRemoteDelivery": False,
                "attemptReservation": "remote-o-excl-before-fable",
                "claudeExecutable": {
                    "path": "/Users/maikyon/.local/share/claude/versions/2.1.211",
                    "sha256": "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
                    "version": "2.1.211 (Claude Code)",
                },
            },
        }}) + "\n")
        now = dt.datetime.now(dt.timezone.utc)
        ledger = base_ledger / campaign_instance
        writable = self.root / "output"
        writable.mkdir()
        token = "a" * 64
        self.authorization = {
            "schemaVersion": AUTHORIZATION_SCHEMA,
            "authorized": True,
            "immutable": True,
            "promotionEligible": False,
            "kind": "preflight",
            "tokenId": token,
            "campaignId": "test-campaign",
            "issuedAtUtc": (now - dt.timedelta(minutes=2)).isoformat().replace("+00:00", "Z"),
            "notBeforeUtc": (now - dt.timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
            "expiresAtUtc": (now + dt.timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
            "protocol": {"path": str(self.protocol), "sha256": __import__("hashlib").sha256(self.protocol.read_bytes()).hexdigest()},
            "sourceContract": {"path": str(self.source), "sha256": __import__("hashlib").sha256(self.source.read_bytes()).hexdigest()},
            "subject": {"name": "test"},
            "command": {"argv": ["/usr/bin/true"], "cwd": str(self.root), "env": {"CUDA_VISIBLE_DEVICES": "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0", "HOME": "/tmp", "PATH": "/usr/bin:/bin"}, "executableSha256": __import__("hashlib").sha256(Path("/usr/bin/true").read_bytes()).hexdigest()},
            "isolation": {
                "backend": "bubblewrap",
                "backendPath": str(self.backend),
                "backendSha256": __import__("hashlib").sha256(self.backend.read_bytes()).hexdigest(),
                "network": "none",
                "newPidNamespace": True,
                "newUserNamespace": True,
                "readOnlyPaths": ["/bin", "/usr"],
                "writablePaths": [str(writable)],
                "tmpfsPaths": ["/tmp"],
                "gpuMode": "exclusive-gpu7",
                "gpuUuid": "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0",
                "forbiddenGpuIndices": [4, 5, 6],
            },
            "outputs": {
                "exitCode": {"path": str(writable / "exit"), "required": True, "mustBeAbsentAtStart": True},
                "stderr": {"path": str(writable / "stderr"), "required": True, "mustBeAbsentAtStart": True},
                "stdout": {"path": str(writable / "stdout"), "required": True, "mustBeAbsentAtStart": True},
            },
            "ledger": {
                "root": str(ledger),
                "consumedPath": str(ledger / f"{token}.consumed.json"),
                "receiptPath": str(ledger / f"{token}.receipt.json"),
                "leasePath": str(self.root / "gpu7.lease"),
            },
            "predecessor": None,
        }
        self.authorization_path = self.root / "authorization.json"
        request_path = ledger / "requests/test-preflight-issuer.json"
        request_path.parent.mkdir(parents=True)
        request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": campaign_instance,
            "protocol": self.authorization["protocol"],
            "role": "issuer",
            "verb": "issue-preflight-execution",
            "subject": {"logicalId": "test-preflight-issuer"},
            "predecessorSha256": None,
            "expectedOutputPath": str(self.authorization_path),
            "requestNonce": "9" * 64,
        }
        request_path.write_bytes(canonical_json(request) + b"\n")
        self.authorization["request"] = {
            "path": str(request_path),
            "sha256": sha256_file(request_path),
        }
        self.launch_permit = self.root / "executor-launch-permit.json"
        self.launch_permit.write_text("fixture\n")
        permit_validator = mock.patch(
            "v35_p30_authorized_execution.validate_executor_launch_permit",
            return_value={},
        )
        permit_validator.start()
        self.addCleanup(permit_validator.stop)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def signed(self) -> dict:
        descriptor = os.open(self.private, os.O_RDONLY)
        try:
            return {**self.authorization, "signature": sign_payload(
                self.authorization, role="issuer", private_key_fd=descriptor,
                public_key_path=self.public
            )}
        finally:
            os.close(descriptor)

    def _make_recovery_eligible(self) -> None:
        self.authorization["kind"] = "generation"
        request_path = Path(self.authorization["request"]["path"])
        request = json.loads(read_regular_nofollow(request_path))
        request["verb"] = "issue-generation"
        request_path.write_bytes(canonical_json(request) + b"\n")
        self.authorization["request"]["sha256"] = sha256_file(request_path)

    def test_validates_and_builds_networkless_command(self) -> None:
        parsed = validate_authorization(
            self.signed(), issuer_public_key_path=self.public,
            analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
            authorization_path=self.authorization_path,
        )
        command = bubblewrap_command(parsed)
        self.assertIn("--unshare-net", command)
        self.assertIn("--clearenv", command)
        self.assertNotIn(str(self.root / "ledger"), command)
        self.assertEqual(command[-1], "/usr/bin/true")

    def test_role_trust_rejects_duplicate_public_keys(self) -> None:
        protocol = json.loads(self.protocol.read_text())
        issuer = protocol["executionTrust"]["roles"]["issuer"]
        executor = protocol["executionTrust"]["roles"]["executor"]
        for field in (
            "publicKeyPath",
            "publicKeyPemSha256",
            "publicKeyDerSha256",
            "keyId",
        ):
            executor[field] = issuer[field]
        with self.assertRaisesRegex(ValueError, "distinct"):
            validate_role_trust(
                protocol["executionTrust"], require_materialized=True
            )

    def test_tampering_and_ledger_inside_writable_are_rejected(self) -> None:
        signed = self.signed()
        signed["kind"] = "analysis"
        with self.assertRaisesRegex(ValueError, "key identity|payload hash"):
            validate_authorization(
                signed, issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                authorization_path=self.authorization_path,
            )
        self.authorization["ledger"]["root"] = str(self.root / "output" / "ledger")
        token = self.authorization["tokenId"]
        self.authorization["ledger"]["consumedPath"] = str(Path(self.authorization["ledger"]["root"]) / f"{token}.consumed.json")
        self.authorization["ledger"]["receiptPath"] = str(Path(self.authorization["ledger"]["root"]) / f"{token}.receipt.json")
        with self.assertRaisesRegex(ValueError, "ledger"):
            validate_authorization(
                self.signed(), issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                authorization_path=self.authorization_path,
            )

    def test_rejects_expired_and_preexisting_output_contract(self) -> None:
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        self.authorization["issuedAtUtc"] = past.isoformat().replace("+00:00", "Z")
        self.authorization["notBeforeUtc"] = past.isoformat().replace("+00:00", "Z")
        self.authorization["expiresAtUtc"] = (past + dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        with self.assertRaisesRegex(ValueError, "currently valid"):
            validate_authorization(
                self.signed(), issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                authorization_path=self.authorization_path,
            )

    def _write_authorization(self) -> tuple[Path, int, dict[str, str]]:
        signed = self.signed()
        path = self.authorization_path
        atomic_write_exclusive(path, canonical_json(signed) + b"\n")
        request_path = Path(self.authorization["ledger"]["root"]) / "requests/test-preflight-executor.json"
        request = {
            "schemaVersion": "arc-v35-p30-role-request-v1",
            "campaignInstanceId": "f" * 64,
            "protocol": self.authorization["protocol"],
            "role": "executor",
            "verb": "execute",
            "subject": {
                "logicalId": "test-preflight-executor",
                "authorizationPath": str(path),
            },
            "predecessorSha256": sha256_file(path),
            "expectedOutputPath": self.authorization["ledger"]["receiptPath"],
            "requestNonce": "8" * 64,
        }
        request_path.write_bytes(canonical_json(request) + b"\n")
        binding = {"path": str(request_path), "sha256": sha256_file(request_path)}
        return path, os.open(self.keys["executor"][0], os.O_RDONLY), binding

    def _prepare_valid_cpu_draft(self) -> tuple[Path, Path, int, dict[str, str]]:
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        authorization_path, descriptor, request_binding = self._write_authorization()
        draft_path = prepare_execution_receipt(
            authorization_path,
            issuer_public_key_path=self.public,
            analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
            execution_request_binding=request_binding,
            launch_permit_path=self.launch_permit,
        )
        return authorization_path, draft_path, descriptor, request_binding

    def _write_receipt_only_chain(
        self, recovery_draft_path: Path
    ) -> tuple[Path, Path]:
        recovery_draft = json.loads(read_regular_nofollow(recovery_draft_path))
        authorization = {
            key: value
            for key, value in json.loads(read_regular_nofollow(self.authorization_path)).items()
            if key != "signature"
        }
        now = dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="microseconds"
        ).replace("+00:00", "Z")
        incident = {
            "schemaVersion": GUARDIAN_INCIDENT_SCHEMA,
            "immutable": True,
            "outcomeBlind": True,
            "promotionEligible": False,
            "recoveryPermitted": True,
            "campaignId": recovery_draft["campaignId"],
            "kind": recovery_draft["kind"],
            "originalTokenId": recovery_draft["tokenId"],
            "recoveryClass": RECEIPT_ONLY,
            "diagnosticCode": recovery_draft["diagnosticCode"],
            "classifiedAtUtc": now,
            "attemptOrdinal": 1,
            "action": ACTIONS[RECEIPT_ONLY],
            "executionDraftSha256": sha256_bytes(canonical_json(recovery_draft)),
            "authorizationSha256": recovery_draft["authorization"]["sha256"],
            "consumedMarkerSha256": recovery_draft["consumedMarker"]["sha256"],
            "protectedBindingsSha256": protected_bindings_sha256(authorization),
            "candidateCodeMayRun": False,
            "seedMayBeReused": False,
            "secondRecoveryForbidden": True,
        }
        descriptor = os.open(self.keys["guardian"][0], os.O_RDONLY)
        try:
            incident["signature"] = sign_payload(
                incident,
                role="guardian",
                private_key_fd=descriptor,
                public_key_path=self.keys["guardian"][1],
            )
        finally:
            os.close(descriptor)
        incident_path = recovery_draft_path.with_name("guardian-incident.json")
        incident_path.write_bytes(canonical_json(incident) + b"\n")
        unsigned_incident = {key: value for key, value in incident.items() if key != "signature"}
        link = {
            "schemaVersion": RECOVERY_LINK_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "campaignId": authorization["campaignId"],
            "kind": authorization["kind"],
            "recoveryClass": RECEIPT_ONLY,
            "action": ACTIONS[RECEIPT_ONLY],
            "attemptOrdinal": 1,
            "originalTokenId": authorization["tokenId"],
            "recoveryTokenId": "b" * 64,
            "guardianIncidentPayloadSha256": sha256_bytes(
                canonical_json(unsigned_incident)
            ),
            "originalAuthorizationSha256": recovery_draft["authorization"]["sha256"],
            "replacementAuthorizationPayloadSha256": None,
            "protectedBindingsSha256": protected_bindings_sha256(authorization),
            "candidateCodeMayRun": False,
            "secondRecoveryForbidden": True,
        }
        link_path = recovery_draft_path.with_name("recovery-link.json")
        link_path.write_bytes(canonical_json(link) + b"\n")
        return incident_path, link_path

    def test_execute_prepares_fresh_output_parent_and_seals_success(self) -> None:
        fresh = self.root / "output" / "fresh" / "nested"
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        self.authorization["isolation"]["writablePaths"] = [str(fresh.parent)]
        for label in ("exitCode", "stderr", "stdout"):
            self.authorization["outputs"][label]["path"] = str(fresh / label)
        authorization_path, descriptor, request_binding = self._write_authorization()
        try:
            draft_path = prepare_execution_receipt(
                authorization_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                execution_request_binding=request_binding,
                launch_permit_path=self.launch_permit,
            )
            receipt_path = seal_execution_receipt(
                authorization_path,
                draft_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                executor_public_key_path=self.keys["executor"][1],
                executor_private_key_fd=descriptor,
                execution_request_binding=request_binding,
            )
        finally:
            os.close(descriptor)
        receipt = verify_signed_payload(
            json.loads(read_regular_nofollow(receipt_path)), expected_role="executor",
            public_key_path=self.keys["executor"][1]
        )
        self.assertTrue(receipt["valid"])
        self.assertTrue(fresh.is_dir())
        self.assertEqual(receipt["exitCode"], 0)

    def test_popen_failure_after_consumption_never_signs_invalid_receipt(self) -> None:
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        authorization_path, descriptor, request_binding = self._write_authorization()
        try:
            with mock.patch(
                "v35_p30_authorized_execution.subprocess.Popen",
                side_effect=OSError("injected launch failure"),
            ):
                draft_path = prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
                with self.assertRaisesRegex(RuntimeError, "guardian resolution"):
                    seal_execution_receipt(
                        authorization_path,
                        draft_path,
                        issuer_public_key_path=self.public,
                        analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                        executor_public_key_path=self.keys["executor"][1],
                        executor_private_key_fd=descriptor,
                        execution_request_binding=request_binding,
                    )
        finally:
            os.close(descriptor)
        receipt_path = Path(self.authorization["ledger"]["receiptPath"])
        self.assertFalse(receipt_path.exists())
        failed_draft = json.loads(read_regular_nofollow(draft_path))
        self.assertFalse(failed_draft["valid"])
        self.assertTrue(failed_draft["process"]["spawnCallEntered"])
        self.assertFalse(failed_draft["process"]["childStarted"])
        self.assertFalse(recovery_execution_draft_path(receipt_path).exists())
        self.assertTrue(Path(self.authorization["ledger"]["consumedPath"]).is_file())

    def test_pre_child_draft_exists_only_before_popen_and_with_no_outputs(self) -> None:
        self._make_recovery_eligible()
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        authorization_path, descriptor, request_binding = self._write_authorization()
        stdout_path = Path(self.authorization["outputs"]["stdout"]["path"])
        real_open = os.open

        def fail_only_stdout(path: object, flags: int, mode: int = 0o777) -> int:
            if Path(path) == stdout_path:
                raise OSError("injected output-open failure")
            return real_open(path, flags, mode)

        try:
            with mock.patch(
                "v35_p30_authorized_execution.os.open", side_effect=fail_only_stdout
            ), self.assertRaisesRegex(RuntimeError, "guardian PRE_CHILD"):
                prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
        finally:
            os.close(descriptor)
        receipt_path = Path(self.authorization["ledger"]["receiptPath"])
        recovery_path = recovery_execution_draft_path(receipt_path)
        recovery = json.loads(read_regular_nofollow(recovery_path))
        self.assertFalse(recovery["process"]["spawnCallEntered"])
        self.assertFalse(recovery["process"]["childStarted"])
        self.assertFalse(recovery["process"]["seedConsumed"])
        self.assertEqual(recovery["artifacts"], {})
        for output in self.authorization["outputs"].values():
            self.assertFalse(Path(output["path"]).exists())

    def test_lease_acquisition_failure_is_pre_child_and_releases_nothing(self) -> None:
        self._make_recovery_eligible()
        lease = Path(self.authorization["ledger"]["leasePath"])
        lease.mkdir()
        (lease / "unrelated-owner").write_text("occupied\n")
        authorization_path, descriptor, request_binding = self._write_authorization()
        try:
            with self.assertRaisesRegex(RuntimeError, "fail closed"):
                prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys[
                        "analysis-authorizer"
                    ][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
        finally:
            os.close(descriptor)
        receipt_path = Path(self.authorization["ledger"]["receiptPath"])
        self.assertFalse(recovery_execution_draft_path(receipt_path).exists())
        self.assertTrue((lease / "unrelated-owner").is_file())
        self.assertFalse(receipt_path.exists())

    def test_child_failure_is_terminally_sealed_in_unsigned_draft(self) -> None:
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        executable = Path("/usr/bin/false")
        self.authorization["command"]["argv"] = [str(executable)]
        self.authorization["command"]["executableSha256"] = sha256_file(executable)
        authorization_path, descriptor, request_binding = self._write_authorization()
        try:
            draft_path = prepare_execution_receipt(
                authorization_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys[
                    "analysis-authorizer"
                ][1],
                execution_request_binding=request_binding,
                launch_permit_path=self.launch_permit,
            )
        finally:
            os.close(descriptor)
        draft = json.loads(read_regular_nofollow(draft_path))
        self.assertFalse(draft["valid"])
        self.assertTrue(draft["process"]["spawnCallEntered"])
        self.assertTrue(draft["process"]["childStarted"])
        self.assertNotEqual(draft["exitCode"], 0)
        self.assertFalse(Path(self.authorization["ledger"]["receiptPath"]).exists())

    def test_signal_interruption_terminates_child_and_seals_draft(self) -> None:
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        authorization_path, descriptor, request_binding = self._write_authorization()

        class InterruptedChild:
            pid = 424242

            def wait(self) -> int:
                raise KeyboardInterrupt()

            def poll(self) -> int:
                return 143

        child = InterruptedChild()
        try:
            with (
                mock.patch(
                    "v35_p30_authorized_execution.subprocess.Popen",
                    return_value=child,
                ),
                mock.patch(
                    "v35_p30_authorized_execution.process_record",
                    return_value={"pid": child.pid, "available": True},
                ),
                mock.patch("v35_p30_authorized_execution._terminate_child") as terminate,
            ):
                draft_path = prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys[
                        "analysis-authorizer"
                    ][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
                terminate.assert_called_once_with(child)
        finally:
            os.close(descriptor)
        draft = json.loads(read_regular_nofollow(draft_path))
        self.assertFalse(draft["valid"])
        self.assertTrue(draft["process"]["childStarted"])

    def test_gpu_postcheck_failure_keeps_lease_and_fails_closed(self) -> None:
        authorization_path, descriptor, request_binding = self._write_authorization()
        empty = {
            "selected": {"memoryMiB": 0, "utilizationPercent": 0},
            "forbidden": [],
        }
        busy = {
            "selected": {"memoryMiB": 1, "utilizationPercent": 1},
            "forbidden": [],
        }
        try:
            with (
                mock.patch(
                    "v35_p30_authorized_execution.gpu_snapshot", return_value=empty
                ),
                mock.patch(
                    "v35_p30_authorized_execution._wait_for_gpu_empty",
                    return_value=(busy, False),
                ),
            ):
                draft_path = prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys[
                        "analysis-authorizer"
                    ][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
        finally:
            os.close(descriptor)
        draft = json.loads(read_regular_nofollow(draft_path))
        self.assertFalse(draft["valid"])
        self.assertFalse(draft["gpuEmptyAfter"])
        self.assertFalse(draft["leaseReleased"])
        self.assertTrue(Path(self.authorization["ledger"]["leasePath"]).is_dir())

    def test_enospc_during_draft_sealing_is_terminal(self) -> None:
        self.authorization["isolation"]["gpuMode"] = "none"
        self.authorization["isolation"]["gpuUuid"] = None
        authorization_path, descriptor, request_binding = self._write_authorization()
        receipt_path = Path(self.authorization["ledger"]["receiptPath"])
        draft_path = receipt_path.with_name(receipt_path.name + ".unsigned.json")
        real_write = atomic_write_exclusive

        def fail_draft(path: Path, payload: bytes, **kwargs: object) -> None:
            if Path(path) == draft_path:
                raise OSError(errno.ENOSPC, "injected no space")
            real_write(Path(path), payload, **kwargs)

        try:
            with (
                mock.patch(
                    "v35_p30_authorized_execution.atomic_write_exclusive",
                    side_effect=fail_draft,
                ),
                self.assertRaisesRegex(OSError, "injected no space"),
            ):
                prepare_execution_receipt(
                    authorization_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys[
                        "analysis-authorizer"
                    ][1],
                    execution_request_binding=request_binding,
                    launch_permit_path=self.launch_permit,
                )
        finally:
            os.close(descriptor)
        self.assertTrue(
            Path(self.authorization["ledger"]["consumedPath"]).is_file()
        )
        self.assertFalse(draft_path.exists())
        self.assertFalse(receipt_path.exists())

    def test_normal_seal_attempt_is_durable_before_private_key_use(self) -> None:
        authorization_path, draft_path, descriptor, request_binding = (
            self._prepare_valid_cpu_draft()
        )
        receipt_path = Path(self.authorization["ledger"]["receiptPath"])
        try:
            with mock.patch(
                "v35_p30_authorized_execution.sign_payload",
                side_effect=RuntimeError("injected signing failure"),
            ) as signer:
                with self.assertRaisesRegex(RuntimeError, "injected signing failure"):
                    seal_execution_receipt(
                        authorization_path,
                        draft_path,
                        issuer_public_key_path=self.public,
                        analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                        executor_public_key_path=self.keys["executor"][1],
                        executor_private_key_fd=descriptor,
                        execution_request_binding=request_binding,
                    )
                self.assertTrue(normal_seal_attempt_path(receipt_path).is_file())
                self.assertEqual(signer.call_count, 1)
            with mock.patch("v35_p30_authorized_execution.sign_payload") as signer:
                with self.assertRaisesRegex(RuntimeError, "guardian recovery"):
                    seal_execution_receipt(
                        authorization_path,
                        draft_path,
                        issuer_public_key_path=self.public,
                        analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                        executor_public_key_path=self.keys["executor"][1],
                        executor_private_key_fd=descriptor,
                        execution_request_binding=request_binding,
                    )
                signer.assert_not_called()
        finally:
            os.close(descriptor)

    def test_receipt_only_recovery_seals_without_candidate_path(self) -> None:
        self._make_recovery_eligible()
        authorization_path, draft_path, descriptor, request_binding = (
            self._prepare_valid_cpu_draft()
        )
        try:
            with mock.patch(
                "v35_p30_authorized_execution.sign_payload",
                side_effect=RuntimeError("injected signing failure"),
            ):
                with self.assertRaises(RuntimeError):
                    seal_execution_receipt(
                        authorization_path,
                        draft_path,
                        issuer_public_key_path=self.public,
                        analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                        executor_public_key_path=self.keys["executor"][1],
                        executor_private_key_fd=descriptor,
                        execution_request_binding=request_binding,
                    )
            recovery_draft = prepare_receipt_only_recovery_draft(
                authorization_path,
                draft_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                execution_request_binding=request_binding,
            )
            incident_path, link_path = self._write_receipt_only_chain(recovery_draft)
            with mock.patch(
                "v35_p30_authorized_execution.subprocess.Popen"
            ) as candidate_spawn:
                receipt_path = seal_receipt_only_recovery(
                    authorization_path,
                    draft_path,
                    recovery_draft,
                    incident_path,
                    link_path,
                    issuer_public_key_path=self.public,
                    analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                    guardian_public_key_path=self.keys["guardian"][1],
                    executor_public_key_path=self.keys["executor"][1],
                    executor_private_key_fd=descriptor,
                    execution_request_binding=request_binding,
                )
                candidate_spawn.assert_not_called()
            self.assertTrue(recovery_seal_attempt_path(receipt_path).is_file())
            verified = verify_signed_payload(
                json.loads(read_regular_nofollow(receipt_path)),
                expected_role="executor",
                public_key_path=self.keys["executor"][1],
            )
            self.assertTrue(verified["valid"])
        finally:
            os.close(descriptor)

    def test_receipt_only_recovery_attempt_cannot_be_retried(self) -> None:
        self._make_recovery_eligible()
        authorization_path, draft_path, descriptor, request_binding = (
            self._prepare_valid_cpu_draft()
        )
        try:
            with mock.patch(
                "v35_p30_authorized_execution.sign_payload",
                side_effect=RuntimeError("normal signing failure"),
            ):
                with self.assertRaises(RuntimeError):
                    seal_execution_receipt(
                        authorization_path,
                        draft_path,
                        issuer_public_key_path=self.public,
                        analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                        executor_public_key_path=self.keys["executor"][1],
                        executor_private_key_fd=descriptor,
                        execution_request_binding=request_binding,
                    )
            recovery_draft = prepare_receipt_only_recovery_draft(
                authorization_path,
                draft_path,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                execution_request_binding=request_binding,
            )
            incident_path, link_path = self._write_receipt_only_chain(recovery_draft)
            arguments = (
                authorization_path,
                draft_path,
                recovery_draft,
                incident_path,
                link_path,
            )
            keywords = {
                "issuer_public_key_path": self.public,
                "analysis_authorizer_public_key_path": self.keys[
                    "analysis-authorizer"
                ][1],
                "guardian_public_key_path": self.keys["guardian"][1],
                "executor_public_key_path": self.keys["executor"][1],
                "executor_private_key_fd": descriptor,
                "execution_request_binding": request_binding,
            }
            with mock.patch(
                "v35_p30_authorized_execution.sign_payload",
                side_effect=RuntimeError("recovery signing failure"),
            ):
                with self.assertRaisesRegex(RuntimeError, "recovery signing failure"):
                    seal_receipt_only_recovery(*arguments, **keywords)
            receipt_path = Path(self.authorization["ledger"]["receiptPath"])
            self.assertTrue(recovery_seal_attempt_path(receipt_path).is_file())
            with mock.patch("v35_p30_authorized_execution.sign_payload") as signer:
                with self.assertRaisesRegex(RuntimeError, "already attempted"):
                    seal_receipt_only_recovery(*arguments, **keywords)
                signer.assert_not_called()
        finally:
            os.close(descriptor)

    def test_analysis_receipt_only_recovery_is_rejected_before_outcome_draft_read(self) -> None:
        authorization_path = self.root / "analysis-authorization.json"
        authorization_path.write_text(json.dumps({"kind": "analysis"}) + "\n")
        missing_draft = self.root / "outcome-bearing-analysis-draft-must-not-be-read.json"
        with self.assertRaisesRegex(RuntimeError, "no recovery path"):
            prepare_receipt_only_recovery_draft(
                authorization_path,
                missing_draft,
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                execution_request_binding={"path": "/request", "sha256": "1" * 64},
            )
        with self.assertRaisesRegex(RuntimeError, "no recovery path"):
            seal_receipt_only_recovery(
                authorization_path,
                missing_draft,
                self.root / "recovery-draft.json",
                self.root / "incident.json",
                self.root / "link.json",
                issuer_public_key_path=self.public,
                analysis_authorizer_public_key_path=self.keys["analysis-authorizer"][1],
                guardian_public_key_path=self.keys["guardian"][1],
                executor_public_key_path=self.keys["executor"][1],
                executor_private_key_fd=-1,
                execution_request_binding={"path": "/request", "sha256": "1" * 64},
            )
        self.assertFalse(missing_draft.exists())


if __name__ == "__main__":
    unittest.main()
