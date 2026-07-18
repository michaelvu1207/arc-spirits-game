from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_v35_p30_campaign as campaign
import run_v35_p30_cuda_determinism as cuda_determinism
import run_v35_p30_gate_review_local as gate_review_local
import issue_v35_p30_preflight_authorization as preflight_authorization
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


class P30AnalyzerRehearsalV2GateTests(unittest.TestCase):
    def _binding(self, path: Path) -> dict[str, object]:
        return {
            "path": str(path.resolve()),
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }

    def _fixture(self, root: Path) -> tuple[dict, Path, dict]:
        parent_id = "a" * 64
        role_names = (
            "analysis-authorizer",
            "executor",
            "guardian",
            "issuer",
            "review-attester",
        )
        parent_roles = {
            role: {
                "publicKeyPath": str(root / "parent-keys" / f"{role}.pem"),
                "publicKeyPemSha256": "5" * 64,
                "publicKeyDerSha256": "6" * 64,
                "keyId": "ed25519:" + "6" * 24,
                "allowedArtifactSchemas": [role],
                "allowedKinds": [],
            }
            for role in role_names
        }
        protocol = {
            "executionTrust": {
                "campaignInstanceId": parent_id,
                "ledgerRoot": str(root / "ledger"),
                "roles": parent_roles,
            },
            "seedSchedule": {"commonPublicGames": 4096},
        }
        protocol_path = root / "parent-protocol.json"
        protocol_path.write_text(json.dumps(protocol) + "\n")
        synthetic_id = phase0.analyzer_rehearsal_campaign_id(protocol)
        ledger = phase0.analyzer_rehearsal_ledger_root(protocol)
        result_root = root / "results" / synthetic_id
        with mock.patch.object(
            phase0, "ANALYZER_REHEARSAL_RESULT_BASE", root / "results"
        ):
            self.assertEqual(
                phase0.analyzer_rehearsal_result_root(protocol), result_root
            )
        paths = {
            "protocol": phase0.analyzer_rehearsal_protocol_path(protocol),
            "manifest": ledger / "analysis/input-manifest.signed.json",
            "authorization": ledger / "authorizations/final-analysis.json",
            "consumed": ledger / f"{'8' * 64}.consumed.json",
            "intent": ledger / f"{'8' * 64}.analysis-launch-intent.json",
            "evidence": ledger / f"{'8' * 64}.analysis-launch.json",
            "stdout": ledger / "supervisor" / ("8" * 64) / "analysis.stdout",
            "stderr": ledger / "supervisor" / ("8" * 64) / "analysis.stderr",
            "unsigned": ledger / f"{'8' * 64}.receipt.json.unsigned.json",
            "seal": ledger / f"{'8' * 64}.receipt.json.normal-seal-attempt.json",
            "signed": ledger / f"{'8' * 64}.receipt.json",
            "analysis": result_root / "analysis.json",
        }
        for path in paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
        synthetic_roles = copy.deepcopy(parent_roles)
        for role, entry in synthetic_roles.items():
            public_path = ledger / "keys" / f"{role}.public.pem"
            public_path.parent.mkdir(parents=True, exist_ok=True)
            public_path.write_text("synthetic public key\n")
            entry.update(
                {
                    "publicKeyPath": str(public_path),
                    "publicKeyPemSha256": sha256_file(public_path),
                    "publicKeyDerSha256": "7" * 64,
                    "keyId": "ed25519:" + "7" * 24,
                }
            )
        synthetic_protocol = copy.deepcopy(protocol)
        synthetic_protocol["executionTrust"]["campaignInstanceId"] = synthetic_id
        synthetic_protocol["executionTrust"]["roles"] = synthetic_roles
        paths["protocol"].write_text(
            json.dumps(synthetic_protocol) + "\n"
        )
        for name, path in paths.items():
            if name not in {"protocol", "stdout", "stderr"}:
                path.write_text(f"{name}\n")
        paths["stdout"].write_bytes(b"")
        paths["stderr"].write_bytes(b"")
        source_root = Path(phase0.__file__).resolve().parent
        canonical_labels = [
            phase0.endpoint_label(replicate, arm)
            for replicate in phase0.REPLICATES
            for arm in phase0.ARMS
        ]
        shuffled_labels = canonical_labels[1:] + canonical_labels[:1]
        inventory = [
            {
                "ordinal": ordinal,
                "kind": "synthetic",
                "label": f"receipt-{ordinal}",
                "path": str(ledger / f"receipt-{ordinal}.json"),
                "sha256": f"{ordinal:064x}"[-64:],
                "tokenId": (
                    sha256_bytes(f"token-{ordinal}".encode())
                    if ordinal < 540
                    else None
                ),
            }
            for ordinal in range(595)
        ]
        receipt_root = phase0.signed_inventory_merkle_root(inventory)
        report = {
            "schemaVersion": phase0.ANALYZER_REHEARSAL_SCHEMA,
            "valid": True,
            "immutable": True,
            "promotionEligible": False,
            "outcomesInspected": False,
            "syntheticDataOnly": True,
            "syntheticOutcomesAnalyzed": True,
            "analysisResultInspected": False,
            "metricsExposed": False,
            "parentCampaignInstanceId": parent_id,
            "syntheticCampaignInstanceId": synthetic_id,
            "protocol": self._binding(paths["protocol"]),
            "counts": {
                **phase0.ANALYZER_REHEARSAL_COUNTS,
                "gamesPerEndpoint": 4096,
            },
            "labelPermutation": {
                "labelCount": 54,
                "exactLabelSet": True,
                "nonCanonicalOrder": True,
                "canonicalLabelOrderSha256": sha256_bytes(
                    canonical_json(canonical_labels)
                ),
                "shuffledLabelOrderSha256": sha256_bytes(
                    canonical_json(shuffled_labels)
                ),
            },
            "manifest": {
                "binding": self._binding(paths["manifest"]),
                "schemaVersion": "arc-v35-p30-analysis-manifest-v1",
                "receiptMerkleRoot": receipt_root,
            },
            "analysisAuthorization": {
                "binding": self._binding(paths["authorization"]),
                "kind": "analysis",
            },
            "execution": {
                "kind": "analysis",
                "tokenIdSha256": sha256_bytes(("8" * 64).encode()),
                "consumedMarker": self._binding(paths["consumed"]),
                "launchIntent": self._binding(paths["intent"]),
                "launchEvidence": self._binding(paths["evidence"]),
                "capabilityConsumed": True,
                "oneShotReentryRejected": True,
                "network": "none",
                "newPidNamespace": True,
                "newUserNamespace": True,
                "newNetworkNamespace": True,
                "gpuMode": "none",
                "exitCode": 0,
            },
            "streams": {
                "stdout": self._binding(paths["stdout"]),
                "stderr": self._binding(paths["stderr"]),
            },
            "analysisArtifact": {
                "binding": self._binding(paths["analysis"]),
                "contentExposed": False,
            },
            "sealing": {
                "unsignedReceipt": self._binding(paths["unsigned"]),
                "normalSealAttempt": self._binding(paths["seal"]),
                "signedReceipt": self._binding(paths["signed"]),
                "signatureRole": "executor",
                "signatureValid": True,
                "valid": True,
            },
            "source": {
                "rehearsal": self._binding(
                    source_root / "run_v35_p30_analyzer_rehearsal.py"
                ),
                "fixtureBuilder": self._binding(
                    source_root / "v35_p30_analyzer_rehearsal_fixture.py"
                ),
                "productionAnalyzer": self._binding(
                    source_root / "analyze_v35_p30_long_horizon.py"
                ),
                "authorizedExecution": self._binding(
                    source_root / "v35_p30_authorized_execution.py"
                ),
            },
            "cleanup": {
                "ephemeralPrivateKeysDeleted": True,
                "privateKeyPaths": sorted(
                    str(
                        phase0.phase0_output_root(protocol, "analyzer-rehearsal")
                        / ".synthetic-analysis-private-keys"
                        / f"{role}.private.pem"
                    )
                    for role in role_names
                ),
            },
            "diagnosticCodes": list(
                phase0.ANALYZER_REHEARSAL_DIAGNOSTIC_CODES
            ),
        }
        return protocol, protocol_path, report

    def _validate(self, protocol: dict, protocol_path: Path, report: dict) -> None:
        result_base = protocol_path.parent / "results"
        synthetic_protocol_path = Path(report["protocol"]["path"])
        synthetic_protocol = json.loads(synthetic_protocol_path.read_text())
        ledger = phase0.analyzer_rehearsal_ledger_root(protocol)
        token = "8" * 64
        manifest_path = Path(report["manifest"]["binding"]["path"])
        authorization_path = Path(
            report["analysisAuthorization"]["binding"]["path"]
        )
        canonical_labels = [
            phase0.endpoint_label(replicate, arm)
            for replicate in phase0.REPLICATES
            for arm in phase0.ARMS
        ]
        shuffled_labels = canonical_labels[1:] + canonical_labels[:1]
        inventory = [
            {
                "ordinal": ordinal,
                "kind": "synthetic",
                "label": f"receipt-{ordinal}",
                "path": str(ledger / f"receipt-{ordinal}.json"),
                "sha256": f"{ordinal:064x}"[-64:],
                "tokenId": (
                    sha256_bytes(f"token-{ordinal}".encode())
                    if ordinal < 540
                    else None
                ),
            }
            for ordinal in range(595)
        ]
        manifest_payload = {
            "schemaVersion": "arc-v35-p30-analysis-manifest-v1",
            "valid": True,
            "immutable": True,
            "promotionEligible": False,
            "outcomesInspected": False,
            "metricsIncluded": False,
            "campaignInstanceId": report["syntheticCampaignInstanceId"],
            "protocol": {
                "path": str(synthetic_protocol_path),
                "sha256": report["protocol"]["sha256"],
            },
            "counts": {
                "endpoints": 54,
                "generationReceipts": 432,
                "evaluationReceipts": 108,
                "pairIntegrityReceipts": 54,
                "signedReceipts": 595,
                "uniqueExecutionTokens": 540,
            },
            "signedReceiptInventory": inventory,
            "receiptMerkleRoot": phase0.signed_inventory_merkle_root(inventory),
            "reports": [{"label": label} for label in shuffled_labels],
        }
        started = "2026-07-16T12:00:01.000000Z"
        authorization_payload = {
            "kind": "analysis",
            "tokenId": token,
            "notBeforeUtc": "2026-07-16T12:00:00.000000Z",
            "expiresAtUtc": "2026-07-16T13:00:00.000000Z",
            "protocol": {
                "path": str(synthetic_protocol_path),
                "sha256": report["protocol"]["sha256"],
            },
            "predecessor": {
                "receiptPath": str(manifest_path),
                "sha256": sha256_file(manifest_path),
            },
            "outputs": {
                "analysis": {"path": report["analysisArtifact"]["binding"]["path"]},
                "exitCode": {"path": str(ledger / "analysis.exit-code")},
                "stderr": {"path": report["streams"]["stderr"]["path"]},
                "stdout": {"path": report["streams"]["stdout"]["path"]},
            },
            "ledger": {
                "consumedPath": report["execution"]["consumedMarker"]["path"],
                "receiptPath": report["sealing"]["signedReceipt"]["path"],
            },
        }
        authorization_binding = {
            "path": str(authorization_path),
            "sha256": sha256_file(authorization_path),
        }
        consumed_path = Path(report["execution"]["consumedMarker"]["path"])
        consumed_binding = {
            "path": str(consumed_path),
            "sha256": sha256_file(consumed_path),
        }
        intent_path = Path(report["execution"]["launchIntent"]["path"])
        evidence_path = Path(report["execution"]["launchEvidence"]["path"])
        intent_payload = {
            "schemaVersion": phase0.ANALYSIS_LAUNCH_INTENT_SCHEMA,
            "kind": "analysis",
            "tokenId": token,
            "authorization": authorization_binding,
            "consumedMarker": consumed_binding,
            "capabilityFd": phase0.ANALYSIS_CAPABILITY_FD,
            "capabilitySha256": "9" * 64,
            "capabilityTransport": phase0.ANALYSIS_CAPABILITY_TRANSPORT,
            "capabilityPath": phase0.ANALYSIS_CAPABILITY_PATH,
            "launchEvidencePath": str(evidence_path),
            "supervisor": {
                "namespaces": {"pid": "pid:[1]", "user": "user:[1]", "network": "net:[1]"}
            },
        }
        evidence_payload = {
            "schemaVersion": phase0.ANALYSIS_LAUNCH_EVIDENCE_SCHEMA,
            "kind": "analysis",
            "tokenId": token,
            "authorization": authorization_binding,
            "consumedMarker": consumed_binding,
            "launchIntent": {
                "path": str(intent_path),
                "sha256": sha256_file(intent_path),
            },
            "capabilitySha256": "9" * 64,
            "capabilityTransport": phase0.ANALYSIS_CAPABILITY_TRANSPORT,
            "capabilityPath": phase0.ANALYSIS_CAPABILITY_PATH,
            "child": {
                "namespaces": {"pid": "pid:[2]", "user": "user:[2]", "network": "net:[2]"}
            },
        }
        receipt_payload = {
            "schemaVersion": phase0.RECEIPT_SCHEMA,
            "valid": True,
            "promotionEligible": False,
            "kind": "analysis",
            "tokenId": token,
            "authorization": authorization_binding,
            "consumedMarker": consumed_binding,
            "startedAtUtc": started,
            "exitCode": 0,
            "artifacts": {
                "analysis": report["analysisArtifact"]["binding"],
                "stderr": report["streams"]["stderr"],
                "stdout": report["streams"]["stdout"],
            },
        }
        seal_payload = {
            "schemaVersion": phase0.NORMAL_SEAL_ATTEMPT_SCHEMA,
            "immutable": True,
            "promotionEligible": False,
            "kind": "analysis",
            "tokenId": token,
            "authorization": authorization_binding,
            "unsignedReceipt": {
                "path": report["sealing"]["unsignedReceipt"]["path"],
                "sha256": report["sealing"]["unsignedReceipt"]["sha256"],
            },
            "attemptOrdinal": 1,
            "signingRole": "executor",
        }
        object_by_path = {
            protocol_path: protocol,
            synthetic_protocol_path: synthetic_protocol,
            manifest_path: manifest_payload,
            authorization_path: authorization_payload,
            consumed_path: {
                "schemaVersion": phase0.CONSUMED_SCHEMA,
                "tokenId": token,
                "authorizationPath": str(authorization_path),
                "authorizationSha256": sha256_file(authorization_path),
            },
            intent_path: intent_payload,
            evidence_path: evidence_payload,
            Path(report["sealing"]["unsignedReceipt"]["path"]): receipt_payload,
            Path(report["sealing"]["signedReceipt"]["path"]): receipt_payload,
            Path(report["sealing"]["normalSealAttempt"]["path"]): seal_payload,
        }
        object_by_path = {
            path.resolve(): value for path, value in object_by_path.items()
        }

        def fake_read(path: Path, _label: str) -> dict:
            return copy.deepcopy(object_by_path[Path(path).resolve()])

        public_path = next(
            iter(synthetic_protocol["executionTrust"]["roles"].values())
        )["publicKeyPath"]
        with mock.patch.object(
            phase0, "ANALYZER_REHEARSAL_RESULT_BASE", result_base
        ), mock.patch.object(
            phase0, "_read_object", side_effect=fake_read
        ), mock.patch.object(
            phase0, "verify_signed_payload", side_effect=lambda value, **_: value
        ), mock.patch.object(
            phase0, "validate_authorization", return_value=authorization_payload
        ), mock.patch.object(
            phase0, "role_public_key_path", return_value=Path(public_path)
        ), mock.patch.object(
            phase0,
            "public_key_identity",
            return_value=("ed25519:" + "7" * 24, "7" * 64),
        ):
            phase0.validate_analyzer_rehearsal_report(
                report=report,
                protocol_path=protocol_path,
                protocol=protocol,
            )

    def test_strict_v2_commitment_report_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            protocol, protocol_path, report = self._fixture(Path(temporary))
            self._validate(protocol, protocol_path, report)

    def test_v1_test_id_evidence_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            protocol, protocol_path, _ = self._fixture(Path(temporary))
            report = {
                "schemaVersion": "arc-v35-p30-analyzer-synthetic-rehearsal-v1",
                "valid": True,
                "promotionEligible": False,
                "outcomesInspected": False,
                "testId": "unit-test-only",
            }
            with self.assertRaisesRegex(ValueError, "registry changed"):
                phase0.validate_analyzer_rehearsal_report(
                    report=report,
                    protocol_path=protocol_path,
                    protocol=protocol,
                )

    def test_count_diagnostic_boolean_and_binding_tampering_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            protocol, protocol_path, report = self._fixture(Path(temporary))
            mutations = {
                "count": lambda value: value["counts"].__setitem__(
                    "endpointCount", 53
                ),
                "diagnostic": lambda value: value["diagnosticCodes"].pop(),
                "boolean": lambda value: value.__setitem__(
                    "analysisResultInspected", True
                ),
                "label commitment": lambda value: value["labelPermutation"].__setitem__(
                    "shuffledLabelOrderSha256", "0" * 64
                ),
                "namespace boolean": lambda value: value["execution"].__setitem__(
                    "newNetworkNamespace", False
                ),
                "one shot boolean": lambda value: value["execution"].__setitem__(
                    "oneShotReentryRejected", False
                ),
                "signature boolean": lambda value: value["sealing"].__setitem__(
                    "signatureValid", False
                ),
                "cleanup boolean": lambda value: value["cleanup"].__setitem__(
                    "ephemeralPrivateKeysDeleted", False
                ),
                "protocol binding": lambda value: value["protocol"].__setitem__(
                    "sha256", "0" * 64
                ),
                "manifest binding": lambda value: value["manifest"][
                    "binding"
                ].__setitem__("sha256", "0" * 64),
                "authorization binding": lambda value: value[
                    "analysisAuthorization"
                ]["binding"].__setitem__("sha256", "0" * 64),
                "consumed binding": lambda value: value["execution"][
                    "consumedMarker"
                ].__setitem__("sha256", "0" * 64),
                "intent binding": lambda value: value["execution"][
                    "launchIntent"
                ].__setitem__("sha256", "0" * 64),
                "evidence binding": lambda value: value["execution"][
                    "launchEvidence"
                ].__setitem__("sha256", "0" * 64),
                "stream binding": lambda value: value["streams"][
                    "stdout"
                ].__setitem__("sha256", "0" * 64),
                "stderr binding": lambda value: value["streams"][
                    "stderr"
                ].__setitem__("sha256", "0" * 64),
                "analysis binding": lambda value: value["analysisArtifact"][
                    "binding"
                ].__setitem__("sha256", "0" * 64),
                "unsigned binding": lambda value: value["sealing"][
                    "unsignedReceipt"
                ].__setitem__("sha256", "0" * 64),
                "seal binding": lambda value: value["sealing"][
                    "normalSealAttempt"
                ].__setitem__("sha256", "0" * 64),
                "signed binding": lambda value: value["sealing"][
                    "signedReceipt"
                ].__setitem__("sha256", "0" * 64),
                "rehearsal source binding": lambda value: value["source"][
                    "rehearsal"
                ].__setitem__("sha256", "0" * 64),
                "fixture source binding": lambda value: value["source"][
                    "fixtureBuilder"
                ].__setitem__("sha256", "0" * 64),
                "analyzer source binding": lambda value: value["source"][
                    "productionAnalyzer"
                ].__setitem__("sha256", "0" * 64),
                "executor source binding": lambda value: value["source"][
                    "authorizedExecution"
                ].__setitem__("sha256", "0" * 64),
            }
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    changed = copy.deepcopy(report)
                    mutate(changed)
                    with self.assertRaises(ValueError):
                        self._validate(protocol, protocol_path, changed)

    def test_preflight_authorizes_only_exact_synthetic_writable_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            git_dir = root / "git"
            git_dir.mkdir()
            source_lock = root / "source-lock.json"
            source_lock.write_text(
                json.dumps({"gitContext": {"gitDir": str(git_dir)}}) + "\n"
            )
            protocol_path = root / "protocol.json"
            protocol = {
                "experiment": "p30-test",
                "sourceContract": {"artifact": str(source_lock)},
                "executionTrust": {
                    "campaignInstanceId": "a" * 64,
                    "ledgerRoot": str(root / "ledger"),
                },
            }
            protocol_path.write_text(json.dumps(protocol) + "\n")
            trust = {
                **protocol["executionTrust"],
                "bubblewrapPath": "/usr/bin/bwrap",
                "bubblewrapSha256": "b" * 64,
                "leasePath": str(root / "lease"),
            }
            real_exists = Path.exists

            def exists_with_synthetic_nvidia(path: Path) -> bool:
                if path == Path("/proc/driver/nvidia"):
                    return True
                return real_exists(path)

            with (
                mock.patch.object(
                    preflight_authorization,
                    "read_json_object",
                    side_effect=lambda path, _label: (
                        protocol if Path(path) == protocol_path else json.loads(source_lock.read_text())
                    ),
                ),
                mock.patch.object(preflight_authorization, "validate_protocol"),
                mock.patch.object(
                    preflight_authorization, "validate_initial_policy_artifacts"
                ),
                mock.patch.object(
                    preflight_authorization,
                    "source_identity",
                    return_value=("c" * 40, "d" * 64),
                ),
                mock.patch.object(
                    preflight_authorization, "validate_trust", return_value=trust
                ),
                mock.patch.object(
                    preflight_authorization,
                    "executable_sha256",
                    return_value="e" * 64,
                ),
                mock.patch.object(
                    preflight_authorization,
                    "artifact_root",
                    return_value=root / "artifacts" / ("a" * 64),
                ),
                mock.patch.object(
                    preflight_authorization,
                    "phase0_output_root",
                    return_value=root / "artifacts" / ("a" * 64) / "phase0/analyzer-rehearsal",
                ),
                mock.patch.object(
                    Path,
                    "exists",
                    exists_with_synthetic_nvidia,
                ),
            ):
                authorization = preflight_authorization.build(
                    protocol_path=protocol_path,
                    name="analyzer-rehearsal",
                    public_key_path=root / "issuer.pem",
                    request_binding={"path": "/request", "sha256": "f" * 64},
                    token_id="1" * 64,
                )
                fault_authorization = preflight_authorization.build(
                    protocol_path=protocol_path,
                    name="fault-injection",
                    public_key_path=root / "issuer.pem",
                    request_binding={"path": "/request", "sha256": "f" * 64},
                    token_id="2" * 64,
                )
                cuda_authorization = preflight_authorization.build(
                    protocol_path=protocol_path,
                    name="cuda-determinism",
                    public_key_path=root / "issuer.pem",
                    request_binding={"path": "/request", "sha256": "f" * 64},
                    token_id="3" * 64,
                )
            self.assertEqual(
                authorization["command"]["argv"][2:4],
                ["--protocol", str(protocol_path)],
            )
            self.assertEqual(
                authorization["isolation"]["writablePaths"],
                sorted(
                    [
                        str(root / "artifacts" / ("a" * 64) / "phase0/analyzer-rehearsal"),
                        str(phase0.analyzer_rehearsal_ledger_root(protocol)),
                        str(phase0.analyzer_rehearsal_result_root(protocol)),
                    ]
                ),
            )
            self.assertNotIn(
                "/proc/driver/nvidia",
                authorization["isolation"]["readOnlyPaths"],
            )
            self.assertIn(
                "/proc/driver/nvidia",
                fault_authorization["isolation"]["readOnlyPaths"],
            )
            self.assertNotIn(
                "/proc/driver/nvidia",
                cuda_authorization["isolation"]["readOnlyPaths"],
            )


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
