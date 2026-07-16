from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import issue_v35_p30_analysis_bundle as bundle
import run_v35_p30_campaign as campaign
import run_v35_p30_role as role
from v35_p30_crypto import sha256_file


class P30AnalysisManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.protocol_path = self.root / "protocol.json"
        self.protocol_path.write_text("{}\n")
        self.source_contract = self.root / "source-contract.json"
        self.source_contract.write_text("{}\n")
        self.ledger = self.root / "ledger"
        self.instance = "a" * 64
        self.protocol = {
            "experiment": "p30-synthetic",
            "executionTrust": {"campaignInstanceId": self.instance},
            "seedSchedule": {
                "maxGeneration": 8,
                "commonPublicGames": 8192,
            },
            "sourceContract": {
                "artifact": str(self.source_contract),
                "sha256": sha256_file(self.source_contract),
            },
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write(self, relative: str, contents: bytes = b"synthetic\n") -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        return path

    def _build_manifest(self, *, duplicate_token: bool = False) -> dict:
        barrier_path = self._write("ledger/barriers/final.json")
        receipt_number = 0
        evaluation_receipts: dict[tuple[str, str, str], Path] = {}

        def generation_authorization_path(
            _ledger: Path, replicate: str, arm: str, generation: int
        ) -> Path:
            return self.root / "authorizations" / f"{replicate}-{arm}-g{generation}.json"

        def evaluation_authorization_path(
            _ledger: Path, label: str, evaluation_role: str
        ) -> Path:
            return self.root / "authorizations" / f"{label}-{evaluation_role}.json"

        def pair_path(_protocol: dict, replicate: str, arm: str) -> Path:
            return self._write(f"pairs/{replicate}-{arm}.json")

        def stored_authorization(**kwargs: object) -> dict:
            return dict(kwargs)

        def completed_execution(
            *, authorization_path: Path, authorization: dict, protocol: dict
        ) -> tuple[Path, dict]:
            del authorization_path, protocol
            nonlocal receipt_number
            receipt_number += 1
            receipt_path = self._write(f"receipts/{receipt_number:03d}.json")
            token_number = 1 if duplicate_token and receipt_number == 2 else receipt_number
            token = f"{token_number:064x}"
            evaluation_role = authorization.get("role")
            if evaluation_role is not None:
                evaluation_receipts[
                    (
                        str(authorization["replicate"]),
                        str(authorization["arm"]),
                        str(evaluation_role),
                    )
                ] = receipt_path
            return receipt_path, {
                "tokenId": token,
                "subject": {"root": str(authorization["root"])},
                "artifacts": {},
            }

        def read_signed(path: Path, _public: Path, _role: str, _label: str) -> dict:
            if path == barrier_path:
                return {
                    "schemaVersion": bundle.FINAL_BARRIER_SCHEMA,
                    "valid": True,
                    "promotionEligible": False,
                    "outcomesInspected": False,
                    "endpointCount": 54,
                    "request": {"path": "barrier-request", "sha256": "b" * 64},
                }
            replicate, arm = path.stem.split("-", 1)
            primary = evaluation_receipts[(replicate, arm, "primary")]
            replay = evaluation_receipts[(replicate, arm, "replay")]
            return {
                "schemaVersion": bundle.PAIR_SCHEMA,
                "valid": True,
                "promotionEligible": False,
                "replicate": replicate,
                "arm": arm,
                "primaryReceipt": {
                    "path": str(primary),
                    "sha256": sha256_file(primary),
                },
                "replayReceipt": {
                    "path": str(replay),
                    "sha256": sha256_file(replay),
                },
                "games": 8192,
                "malformedEpisodes": 0,
                "request": {"path": "pair-request", "sha256": "c" * 64},
            }

        fixed_now = dt.datetime(2026, 7, 15, 12, 0, tzinfo=dt.timezone.utc)
        patches = (
            mock.patch.object(bundle, "read_json_object", return_value=self.protocol),
            mock.patch.object(bundle, "validate_protocol"),
            mock.patch.object(bundle, "validate_initial_policy_artifacts"),
            mock.patch.object(
                bundle,
                "source_identity",
                return_value=("deadbeef", sha256_file(self.source_contract)),
            ),
            mock.patch.object(bundle, "resolve_artifact", return_value=self.source_contract),
            mock.patch.object(bundle, "ledger_for", return_value=self.ledger),
            mock.patch.object(
                bundle,
                "role_public_key_path",
                return_value=self.root / "guardian.pem",
            ),
            mock.patch.object(bundle, "final_barrier_path", return_value=barrier_path),
            mock.patch.object(bundle, "_read_signed", side_effect=read_signed),
            mock.patch.object(bundle, "validate_role_request_binding"),
            mock.patch.object(
                bundle,
                "generation_authorization_path",
                side_effect=generation_authorization_path,
            ),
            mock.patch.object(
                bundle,
                "evaluation_authorization_path",
                side_effect=evaluation_authorization_path,
            ),
            mock.patch.object(bundle, "pair_path", side_effect=pair_path),
            mock.patch.object(bundle, "predecessor_for_generation", return_value=None),
            mock.patch.object(
                bundle,
                "validate_stored_authorization",
                side_effect=stored_authorization,
            ),
            mock.patch.object(
                bundle,
                "validate_completed_execution",
                side_effect=completed_execution,
            ),
            mock.patch.object(
                bundle,
                "root_for",
                side_effect=lambda replicate, arm: self.root / "league" / replicate / arm,
            ),
            mock.patch.object(
                bundle,
                "_report_entry",
                side_effect=lambda **kwargs: {
                    "label": f"{kwargs['replicate']}-{kwargs['arm']}",
                    "reportArtifactOnly": True,
                },
            ),
        )
        with ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            return bundle.build_manifest_payload(
                protocol_path=self.protocol_path,
                request_binding={"path": "/ledger/request.json", "sha256": "d" * 64},
                now=fixed_now,
            )

    def test_guardian_manifest_has_exact_metric_free_fields_and_complete_counts(self) -> None:
        manifest = self._build_manifest()
        self.assertEqual(
            set(manifest),
            {
                "schemaVersion",
                "valid",
                "immutable",
                "promotionEligible",
                "outcomesInspected",
                "metricsIncluded",
                "issuedAtUtc",
                "campaignInstanceId",
                "protocol",
                "sourceContract",
                "finalGenerationBarrier",
                "counts",
                "signedReceiptInventory",
                "receiptMerkleRoot",
                "reports",
                "request",
            },
        )
        self.assertEqual(
            manifest["counts"],
            {
                "endpoints": 54,
                "generationReceipts": 432,
                "evaluationReceipts": 108,
                "pairIntegrityReceipts": 54,
                "signedReceipts": 595,
                "uniqueExecutionTokens": 540,
            },
        )
        self.assertEqual(len(manifest["signedReceiptInventory"]), 595)
        tokens = [
            entry["tokenId"]
            for entry in manifest["signedReceiptInventory"]
            if entry["tokenId"] is not None
        ]
        self.assertEqual(len(tokens), 540)
        self.assertEqual(len(set(tokens)), 540)
        self.assertEqual(len(manifest["reports"]), 54)
        self.assertFalse(manifest["metricsIncluded"])
        self.assertFalse(manifest["outcomesInspected"])
        serialized = json.dumps(manifest).lower()
        for forbidden in ("winrate", "win_rate", "late-game-score", "victorypoints"):
            self.assertNotIn(forbidden, serialized)

    def test_duplicate_execution_token_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate execution token"):
            self._build_manifest(duplicate_token=True)

    def test_report_entries_hash_invalid_json_without_parsing_it(self) -> None:
        root = self.root / "league-root"
        root.mkdir()
        report = self._write("reports/primary.json", b"{not valid json")
        replay_report = self._write("reports/replay.json", b"also not json")
        primary_legacy = self._write("reports/primary-receipt.json")
        replay_legacy = self._write("reports/replay-receipt.json")
        final_generation_receipt = self._write("receipts/final-generation.json")
        primary_execution_receipt = self._write("receipts/primary.json")
        replay_execution_receipt = self._write("receipts/replay.json")
        pair_receipt = self._write("pairs/a-control-zero.json")
        binding = self._write("league-root/v35-binding.json")
        config = self._write("league-root/config.json")
        checkpoint = self._write("league-root/checkpoints/main-0-gen8.pt")
        checkpoint_manifest = self._write(
            "league-root/checkpoints/main-0-gen8.manifest.json"
        )
        audit = self._write("league-root/artifacts/gen8-audit.json")

        def receipt_artifacts(prefix: str, report_path: Path, legacy: Path) -> dict:
            artifacts = {
                "legacyReceipt": {"path": str(legacy)},
                "report": {"path": str(report_path)},
            }
            for key in (
                "evaluatorExitCode",
                "evaluatorStdout",
                "evaluatorStderr",
                "serverStdout",
            ):
                path = self._write(f"logs/{prefix}-{key}")
                artifacts[key] = {"path": str(path), "sha256": sha256_file(path)}
            return artifacts

        primary = {
            "subject": {"root": str(root)},
            "artifacts": receipt_artifacts("primary", report, primary_legacy),
        }
        replay = {
            "subject": {"root": str(root)},
            "artifacts": receipt_artifacts("replay", replay_report, replay_legacy),
        }
        protocol = {"seedSchedule": {"maxGeneration": 8}}
        with mock.patch.object(bundle, "root_for", return_value=root), mock.patch.object(
            bundle.json,
            "loads",
            side_effect=AssertionError("report JSON must not be parsed"),
        ):
            entry = bundle._report_entry(
                protocol=protocol,
                protocol_path=self.protocol_path,
                replicate="a",
                arm="control-zero",
                final_generation_receipt_path=final_generation_receipt,
                primary_receipt_path=primary_execution_receipt,
                primary_receipt=primary,
                replay_receipt_path=replay_execution_receipt,
                replay_receipt=replay,
                pair_receipt_path=pair_receipt,
            )
        self.assertEqual(entry["sha256"], sha256_file(report))
        self.assertEqual(entry["replayReportSha256"], sha256_file(replay_report))
        self.assertEqual(entry["weightsSha256"], sha256_file(checkpoint))
        self.assertEqual(entry["checkpointManifestSha256"], sha256_file(checkpoint_manifest))
        self.assertEqual(entry["generationAuditSha256"], sha256_file(audit))
        self.assertEqual(entry["configSha256"], sha256_file(config))
        self.assertEqual(entry["bindingSha256"], sha256_file(binding))
        self.assertEqual(
            set(entry),
            {
                "label",
                "replicate",
                "arm",
                "path",
                "sha256",
                "weightsSha256",
                "generationAuditPath",
                "generationAuditSha256",
                "generationExecutionReceiptPath",
                "generationExecutionReceiptSha256",
                "checkpointPath",
                "checkpointManifestPath",
                "checkpointManifestSha256",
                "configPath",
                "configSha256",
                "bindingPath",
                "bindingSha256",
                "exitCodePath",
                "exitCodeSha256",
                "evaluatorStdoutPath",
                "evaluatorStdoutSha256",
                "evaluatorStderrPath",
                "evaluatorStderrSha256",
                "serverLogPath",
                "serverLogSha256",
                "primaryReceiptPath",
                "primaryReceiptSha256",
                "primaryExecutionReceiptPath",
                "primaryExecutionReceiptSha256",
                "replayReportPath",
                "replayReportSha256",
                "replayExitCodePath",
                "replayExitCodeSha256",
                "replayEvaluatorStdoutPath",
                "replayEvaluatorStdoutSha256",
                "replayEvaluatorStderrPath",
                "replayEvaluatorStderrSha256",
                "replayServerLogPath",
                "replayServerLogSha256",
                "replayReceiptPath",
                "replayReceiptSha256",
                "replayExecutionReceiptPath",
                "replayExecutionReceiptSha256",
                "pairIntegrityPath",
                "pairIntegritySha256",
            },
        )
        forbidden = {"wins", "losses", "winRate", "lateGameScore", "score", "metrics"}
        self.assertTrue(forbidden.isdisjoint(entry))

    def test_scheduler_and_guardian_role_use_the_same_manifest_schema_and_path(self) -> None:
        protocol = {
            "executionTrust": {
                "campaignInstanceId": self.instance,
                "ledgerRoot": str(self.ledger),
            }
        }
        output = campaign.analysis_manifest_path(protocol)
        barrier = campaign.final_barrier_path(protocol)
        predecessor = campaign.pair_path(protocol, bundle.REPLICATES[-1], bundle.ARMS[-1])
        barrier.parent.mkdir(parents=True, exist_ok=True)
        barrier.write_bytes(b"barrier\n")
        predecessor.parent.mkdir(parents=True, exist_ok=True)
        predecessor.write_bytes(b"pair\n")
        request = {
            "verb": "attest-analysis-manifest",
            "expectedOutputPath": str(output),
            "predecessorSha256": sha256_file(predecessor),
            "subject": {
                "finalGenerationBarrier": {
                    "path": str(barrier),
                    "sha256": sha256_file(barrier),
                }
            },
        }
        binding = {"path": "/ledger/request.json", "sha256": "e" * 64}
        unsigned = {
            "schemaVersion": bundle.ANALYSIS_MANIFEST_SCHEMA,
            "valid": True,
            "request": binding,
        }
        with mock.patch.object(
            role, "build_manifest_payload", return_value=unsigned
        ), mock.patch.object(
            role,
            "sign_payload",
            return_value={"schemaVersion": "synthetic-signature"},
        ), mock.patch.object(
            role,
            "role_public_key_path",
            return_value=self.root / "guardian.pem",
        ):
            prepared = role._attest_analysis_manifest(
                self.protocol_path, protocol, request, binding
            )
            self.assertFalse(output.exists())
            reservation = prepared.reserve(binding["sha256"])
            produced = prepared.seal(-1, reservation)
        stored = json.loads(produced.read_text())
        self.assertEqual(produced, output)
        self.assertEqual(bundle.ANALYSIS_MANIFEST_SCHEMA, campaign.ANALYSIS_MANIFEST_SCHEMA)
        self.assertEqual(stored["schemaVersion"], campaign.ANALYSIS_MANIFEST_SCHEMA)
        self.assertEqual(stored["request"], binding)

    def test_final_analysis_authorization_rebinds_only_post_review_ttl(self) -> None:
        draft = {
            "kind": "analysis",
            "tokenId": "1" * 64,
            "issuedAtUtc": "2026-07-15T10:00:00.000000Z",
            "notBeforeUtc": "2026-07-15T10:00:00.000000Z",
            "expiresAtUtc": "2026-07-16T10:00:00.000000Z",
            "subject": {"inputManifestSha256": "2" * 64},
        }
        issued = dt.datetime(2026, 7, 15, 12, 0, tzinfo=dt.timezone.utc)
        final = bundle.rebind_reviewed_analysis_authorization_times(
            draft,
            review_finished_at_utc="2026-07-15T11:59:59.000000Z",
            now=issued,
        )
        bundle.validate_reviewed_analysis_authorization_rebinding(
            draft,
            final,
            review_finished_at_utc="2026-07-15T11:59:59.000000Z",
        )
        self.assertEqual(final["issuedAtUtc"], "2026-07-15T12:00:00.000000Z")
        self.assertEqual(final["notBeforeUtc"], final["issuedAtUtc"])
        self.assertEqual(final["expiresAtUtc"], "2026-07-16T12:00:00.000000Z")
        self.assertEqual(final["subject"], draft["subject"])
        self.assertEqual(draft["issuedAtUtc"], "2026-07-15T10:00:00.000000Z")
        skew_safe = bundle.rebind_reviewed_analysis_authorization_times(
            draft,
            review_finished_at_utc="2026-07-15T12:00:00.000000Z",
            now=dt.datetime(2026, 7, 15, 11, 59, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(skew_safe["issuedAtUtc"], "2026-07-15T12:00:00.000001Z")

    def test_final_analysis_authorization_rebinding_fails_closed(self) -> None:
        draft = {
            "kind": "analysis",
            "tokenId": "1" * 64,
            "issuedAtUtc": "2026-07-15T10:00:00.000000Z",
            "notBeforeUtc": "2026-07-15T10:00:00.000000Z",
            "expiresAtUtc": "2026-07-16T10:00:00.000000Z",
            "subject": {"inputManifestSha256": "2" * 64},
        }
        final = bundle.rebind_reviewed_analysis_authorization_times(
            draft,
            review_finished_at_utc="2026-07-15T11:00:00.000000Z",
            now=dt.datetime(2026, 7, 15, 12, 0, tzinfo=dt.timezone.utc),
        )
        tampered = dict(final)
        tampered["tokenId"] = "3" * 64
        with self.assertRaisesRegex(ValueError, "beyond its three TTL fields"):
            bundle.validate_reviewed_analysis_authorization_rebinding(
                draft,
                tampered,
                review_finished_at_utc="2026-07-15T11:00:00.000000Z",
            )
        with self.assertRaisesRegex(ValueError, "post-review"):
            bundle.validate_reviewed_analysis_authorization_rebinding(
                draft,
                final,
                review_finished_at_utc="2026-07-15T12:00:00.000001Z",
            )


if __name__ == "__main__":
    unittest.main()
