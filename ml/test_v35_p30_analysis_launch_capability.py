from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import analyze_v35_p30_long_horizon as analyzer
import v35_p30_authorized_execution as executor
from v35_p30_crypto import canonical_json, sha256_file


class AnalysisLaunchCapabilityTests(unittest.TestCase):
    def _boundary_fixture(self, root: Path) -> tuple[Path, Path, Path, dict, dict]:
        token = "a" * 64
        ledger_base = root / "ledger-base"
        campaign = "f" * 64
        ledger = ledger_base / campaign
        ledger.mkdir(parents=True)
        protocol_path = root / "protocol.json"
        protocol = {
            "executionTrust": {
                "ledgerRoot": str(ledger_base),
                "campaignInstanceId": campaign,
            }
        }
        protocol_path.write_bytes(canonical_json(protocol) + b"\n")
        authorization_path = root / "authorization.json"
        executable_hash = "e" * 64
        authorization = {
            "schemaVersion": "arc-v35-p30-execution-authorization-v1",
            "kind": "analysis",
            "tokenId": token,
            "campaignId": "campaign",
            "protocol": {
                "path": str(protocol_path.resolve()),
                "sha256": sha256_file(protocol_path),
            },
            "command": {"executableSha256": executable_hash},
            "isolation": {
                "network": "none",
                "newPidNamespace": True,
                "newUserNamespace": True,
            },
            "ledger": {
                "root": str(ledger),
                "consumedPath": str(ledger / f"{token}.consumed.json"),
                "receiptPath": str(ledger / f"{token}.receipt.json"),
                "leasePath": str(root / "lease"),
            },
        }
        authorization_path.write_bytes(canonical_json({**authorization, "signature": {}}) + b"\n")
        consumed_path = Path(authorization["ledger"]["consumedPath"])
        consumed = {
            "schemaVersion": "arc-v35-p30-consumed-token-v1",
            "tokenId": token,
            "authorizationPath": str(authorization_path.resolve()),
            "authorizationSha256": sha256_file(authorization_path),
            "consumedAtUtc": "2026-07-15T00:00:00Z",
            "consumerPid": 100,
            "host": "test",
            "bootId": "boot",
        }
        consumed_path.write_bytes(canonical_json(consumed) + b"\n")
        launch_permit_path = ledger / "launch-permits" / ("b" * 64 + ".json")
        launch_permit_path.parent.mkdir()
        launch_permit_path.write_bytes(b'{"synthetic":"process-bound-permit"}\n')
        intent_path, evidence_path = executor.analysis_launch_paths(ledger, token)
        supervisor_namespaces = {
            "pid": "pid:[1]",
            "user": "user:[1]",
            "network": "net:[1]",
        }
        capability_hash = hashlib.sha256(b"x" * 32).hexdigest()
        intent = {
            "schemaVersion": executor.ANALYSIS_LAUNCH_INTENT_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "kind": "analysis",
            "tokenId": token,
            "campaignId": "campaign",
            "authorization": {
                "path": str(authorization_path.resolve()),
                "sha256": sha256_file(authorization_path),
            },
            "consumedMarker": {
                "path": str(consumed_path),
                "sha256": sha256_file(consumed_path),
            },
            "launchPermit": {
                "path": str(launch_permit_path),
                "sha256": sha256_file(launch_permit_path),
            },
            "capabilitySha256": capability_hash,
            "capabilityFd": executor.ANALYSIS_CAPABILITY_FD,
            "capabilityTransport": executor.ANALYSIS_CAPABILITY_TRANSPORT,
            "capabilityPath": executor.ANALYSIS_CAPABILITY_PATH,
            "supervisor": {
                "pid": 100,
                "uid": 501,
                "gid": 20,
                "bootId": "boot",
                "startTicks": 10,
                "namespaces": supervisor_namespaces,
            },
            "launchEvidencePath": str(evidence_path),
            "createdAtUtc": "2026-07-15T00:00:00Z",
        }
        intent_path.write_bytes(canonical_json(intent) + b"\n")
        runtime_namespaces = {
            "pid": "pid:[2]",
            "user": "user:[2]",
            "network": "net:[2]",
        }
        evidence = {
            "schemaVersion": executor.ANALYSIS_LAUNCH_EVIDENCE_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "kind": "analysis",
            "tokenId": token,
            "campaignId": "campaign",
            "authorization": intent["authorization"],
            "consumedMarker": intent["consumedMarker"],
            "launchPermit": intent["launchPermit"],
            "launchIntent": {
                "path": str(intent_path),
                "sha256": sha256_file(intent_path),
            },
            "capabilitySha256": capability_hash,
            "capabilityTransport": executor.ANALYSIS_CAPABILITY_TRANSPORT,
            "capabilityPath": executor.ANALYSIS_CAPABILITY_PATH,
            "supervisor": intent["supervisor"],
            "child": {
                "launcherPid": 200,
                "hostPid": 201,
                "namespacePid": 7,
                "namespacePidChain": [201, 7],
                "uid": 501,
                "gid": 20,
                "startTicks": 20,
                "namespaces": runtime_namespaces,
                "executableSha256": executable_hash,
            },
            "committedAtUtc": "2026-07-15T00:00:01Z",
        }
        evidence_path.write_bytes(canonical_json(evidence) + b"\n")
        return protocol_path, authorization_path, evidence_path, authorization, evidence

    def test_successful_boundary_requires_capability_and_three_distinct_namespaces(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            protocol, authorization_path, _, authorization, evidence = self._boundary_fixture(
                Path(temporary).resolve()
            )
            with (
                mock.patch.object(analyzer, "validate_role_trust"),
                mock.patch.object(analyzer, "role_public_key_path", return_value=Path("/key")),
                mock.patch.object(
                    analyzer, "verify_signed_payload", return_value=authorization
                ),
                mock.patch.object(analyzer, "_consume_analysis_capability") as capability,
                mock.patch.object(
                    analyzer,
                    "_analysis_runtime_namespaces",
                    return_value=evidence["child"]["namespaces"],
                ),
                mock.patch.object(
                    analyzer, "_analysis_runtime_start_ticks", return_value=20
                ),
                mock.patch.object(executor, "host_boot_id", return_value="boot"),
                mock.patch.object(analyzer.os, "getpid", return_value=7),
                mock.patch.object(analyzer.os, "getuid", return_value=501),
                mock.patch.object(analyzer.os, "getgid", return_value=20),
                mock.patch.object(
                    analyzer, "secure_sha256_file", return_value="e" * 64
                ),
            ):
                loaded_protocol, loaded_authorization = (
                    analyzer.validate_analysis_launch_boundary(
                        protocol, authorization_path, evidence_wait_seconds=0
                    )
                )
            self.assertEqual(loaded_protocol["executionTrust"]["campaignInstanceId"], "f" * 64)
            self.assertEqual(loaded_authorization, authorization)
            capability.assert_called_once_with(
                executor.ANALYSIS_CAPABILITY_FD,
                capability_path=Path(executor.ANALYSIS_CAPABILITY_PATH),
                expected_sha256=evidence["capabilitySha256"],
                expected_bytes=executor.ANALYSIS_CAPABILITY_BYTES,
            )

    def test_direct_cli_without_inherited_fd_fails_before_manifest_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol, authorization_path, _, authorization, _ = self._boundary_fixture(root)
            manifest = root / "must-not-be-read-manifest.json"
            original_reader = analyzer.read_json_object
            observed: list[Path] = []

            def tracked_reader(path: Path, label: str) -> dict:
                observed.append(Path(path))
                return original_reader(path, label)

            with (
                mock.patch.object(analyzer, "validate_role_trust"),
                mock.patch.object(analyzer, "role_public_key_path", return_value=Path("/key")),
                mock.patch.object(
                    analyzer, "verify_signed_payload", return_value=authorization
                ),
                mock.patch.object(
                    analyzer,
                    "_consume_analysis_capability",
                    side_effect=RuntimeError(
                        "analysis launch capability FD is missing; direct CLI execution is forbidden"
                    ),
                ),
                mock.patch.object(executor, "host_boot_id", return_value="boot"),
                mock.patch.object(analyzer, "read_json_object", side_effect=tracked_reader),
            ):
                with self.assertRaisesRegex(RuntimeError, "direct CLI"):
                    analyzer.load_inputs(protocol, manifest, authorization_path)
            self.assertNotIn(manifest, observed)

    def test_capability_hash_tamper_closes_and_rejects_fd(self) -> None:
        secret = b"s" * executor.ANALYSIS_CAPABILITY_BYTES
        metadata = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600,
            st_size=len(secret),
            st_dev=1,
            st_ino=2,
        )
        calls = 0

        def fstat(descriptor: int) -> types.SimpleNamespace:
            nonlocal calls
            calls += 1
            if descriptor == executor.ANALYSIS_CAPABILITY_FD and calls == 1:
                raise OSError(errno.EBADF, "closed")
            return metadata

        with (
            mock.patch.object(analyzer.os, "fstat", side_effect=fstat),
            mock.patch.object(analyzer.os, "lstat", return_value=metadata),
            mock.patch.object(
                analyzer.os, "statvfs", return_value=types.SimpleNamespace(f_flag=os.ST_RDONLY)
            ),
            mock.patch.object(analyzer.os, "open", return_value=10),
            mock.patch.object(analyzer.os, "dup2"),
            mock.patch.object(analyzer.os, "listdir", return_value=[str(executor.ANALYSIS_CAPABILITY_FD)]),
            mock.patch.object(analyzer.os, "pread", return_value=secret),
            mock.patch.object(analyzer.os, "close") as close,
        ):
            with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                analyzer._consume_analysis_capability(
                    executor.ANALYSIS_CAPABILITY_FD,
                    capability_path=Path(executor.ANALYSIS_CAPABILITY_PATH),
                    expected_sha256="0" * 64,
                    expected_bytes=len(secret),
                )
            close.assert_has_calls([mock.call(10), mock.call(executor.ANALYSIS_CAPABILITY_FD)])

    def test_duplicate_capability_fd_is_rejected_and_closed(self) -> None:
        secret = b"s" * executor.ANALYSIS_CAPABILITY_BYTES
        metadata = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600,
            st_size=len(secret),
            st_dev=1,
            st_ino=2,
        )
        calls = 0

        def fstat(descriptor: int) -> types.SimpleNamespace:
            nonlocal calls
            calls += 1
            if descriptor == executor.ANALYSIS_CAPABILITY_FD and calls == 1:
                raise OSError(errno.EBADF, "closed")
            return metadata

        with (
            mock.patch.object(analyzer.os, "fstat", side_effect=fstat),
            mock.patch.object(analyzer.os, "lstat", return_value=metadata),
            mock.patch.object(
                analyzer.os, "statvfs", return_value=types.SimpleNamespace(f_flag=os.ST_RDONLY)
            ),
            mock.patch.object(analyzer.os, "open", return_value=10),
            mock.patch.object(analyzer.os, "dup2"),
            mock.patch.object(
                analyzer.os,
                "listdir",
                return_value=[str(executor.ANALYSIS_CAPABILITY_FD), "199"],
            ),
            mock.patch.object(analyzer.os, "close") as close,
        ):
            with self.assertRaisesRegex(RuntimeError, "duplicated"):
                analyzer._consume_analysis_capability(
                    executor.ANALYSIS_CAPABILITY_FD,
                    capability_path=Path(executor.ANALYSIS_CAPABILITY_PATH),
                    expected_sha256=hashlib.sha256(secret).hexdigest(),
                    expected_bytes=len(secret),
                )
            close.assert_has_calls([mock.call(10), mock.call(executor.ANALYSIS_CAPABILITY_FD)])

    def test_writable_capability_mount_is_rejected_before_open(self) -> None:
        metadata = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o400,
            st_size=executor.ANALYSIS_CAPABILITY_BYTES,
            st_dev=1,
            st_ino=2,
        )
        with (
            mock.patch.object(
                analyzer.os,
                "fstat",
                side_effect=OSError(errno.EBADF, "closed"),
            ),
            mock.patch.object(analyzer.os, "lstat", return_value=metadata),
            mock.patch.object(
                analyzer.os, "statvfs", return_value=types.SimpleNamespace(f_flag=0)
            ),
            mock.patch.object(analyzer.os, "open") as opened,
        ):
            with self.assertRaisesRegex(RuntimeError, "mount is writable"):
                analyzer._consume_analysis_capability(
                    executor.ANALYSIS_CAPABILITY_FD,
                    capability_path=Path(executor.ANALYSIS_CAPABILITY_PATH),
                    expected_sha256="0" * 64,
                    expected_bytes=executor.ANALYSIS_CAPABILITY_BYTES,
                )
            opened.assert_not_called()

    def test_preopened_reserved_fd_is_rejected_before_path_access(self) -> None:
        metadata = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o400,
            st_size=executor.ANALYSIS_CAPABILITY_BYTES,
            st_dev=1,
            st_ino=2,
        )
        with (
            mock.patch.object(analyzer.os, "fstat", return_value=metadata),
            mock.patch.object(analyzer.os, "lstat") as lstat,
        ):
            with self.assertRaisesRegex(RuntimeError, "already open"):
                analyzer._consume_analysis_capability(
                    executor.ANALYSIS_CAPABILITY_FD,
                    capability_path=Path(executor.ANALYSIS_CAPABILITY_PATH),
                    expected_sha256="0" * 64,
                    expected_bytes=executor.ANALYSIS_CAPABILITY_BYTES,
                )
            lstat.assert_not_called()

    def test_launch_boundary_rejects_capability_transport_tamper(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            protocol, authorization_path, evidence_path, authorization, _ = (
                self._boundary_fixture(root)
            )
            token = authorization["tokenId"]
            ledger = Path(authorization["ledger"]["root"])
            intent_path, _ = executor.analysis_launch_paths(ledger, token)
            intent = json.loads(intent_path.read_text())
            intent["capabilityTransport"] = "sync-fd"
            intent_path.write_bytes(canonical_json(intent) + b"\n")
            evidence = json.loads(evidence_path.read_text())
            evidence["launchIntent"]["sha256"] = sha256_file(intent_path)
            evidence_path.write_bytes(canonical_json(evidence) + b"\n")
            with (
                mock.patch.object(analyzer, "validate_role_trust"),
                mock.patch.object(analyzer, "role_public_key_path", return_value=Path("/key")),
                mock.patch.object(
                    analyzer, "verify_signed_payload", return_value=authorization
                ),
                mock.patch.object(executor, "host_boot_id", return_value="boot"),
                mock.patch.object(analyzer, "_consume_analysis_capability") as consume,
            ):
                with self.assertRaisesRegex(ValueError, "launch intent changed"):
                    analyzer.validate_analysis_launch_boundary(
                        protocol, authorization_path, evidence_wait_seconds=0
                    )
            consume.assert_not_called()

    def test_bubblewrap_receives_only_fixed_fd_number_not_secret(self) -> None:
        secret = b"do-not-expose-this-analysis-secret"
        authorization = {
            "kind": "analysis",
            "isolation": {
                "backendPath": "/usr/bin/bwrap",
                "readOnlyPaths": [],
                "writablePaths": [],
                "tmpfsPaths": [],
                "gpuMode": "none",
            },
            "command": {"env": {}, "cwd": "/repo", "argv": ["/python", "analyze.py"]},
        }
        command = executor.bubblewrap_command(
            authorization, analysis_capability_fd=executor.ANALYSIS_CAPABILITY_FD
        )
        encoded = canonical_json(command)
        self.assertIn(b"--ro-bind-data", encoded)
        self.assertIn(executor.ANALYSIS_CAPABILITY_PATH.encode(), encoded)
        self.assertNotIn(b"--sync-fd", encoded)
        self.assertNotIn(b"--keep-fd", encoded)
        self.assertIn(str(executor.ANALYSIS_CAPABILITY_FD).encode(), encoded)
        self.assertNotIn(secret, encoded)

    def test_launch_intent_commits_hash_without_secret_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            authorization_path = root / "authorization.json"
            consumed_path = root / "consumed.json"
            authorization_path.write_text("{}\n")
            consumed_path.write_text("{}\n")
            launch_permit_path = root / "launch-permit.json"
            launch_permit_path.write_text("{}\n")
            secret = b"capability-must-never-be-persisted"
            digest = hashlib.sha256(secret).hexdigest()
            with mock.patch.object(
                executor,
                "_supervisor_namespace_evidence",
                return_value={
                    "pid": 1,
                    "uid": 1,
                    "gid": 1,
                    "bootId": "boot",
                    "startTicks": 1,
                    "namespaces": {
                        "pid": "pid:[1]",
                        "user": "user:[1]",
                        "network": "net:[1]",
                    },
                },
            ):
                intent = executor._analysis_launch_intent(
                    authorization_path=authorization_path,
                    authorization={
                        "kind": "analysis",
                        "tokenId": "a" * 64,
                        "campaignId": "campaign",
                    },
                    consumed_path=consumed_path,
                    capability_sha256=digest,
                    intent_path=root / "intent.json",
                    evidence_path=root / "evidence.json",
                    launch_permit_path=launch_permit_path,
                )
            encoded = canonical_json(intent)
            self.assertEqual(intent["capabilitySha256"], digest)
            self.assertEqual(
                intent["capabilityTransport"], executor.ANALYSIS_CAPABILITY_TRANSPORT
            )
            self.assertEqual(intent["capabilityPath"], executor.ANALYSIS_CAPABILITY_PATH)
            self.assertNotIn(secret, encoded)


if __name__ == "__main__":
    unittest.main()
