from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import audit_v35_p30_generation as subject
import audit_v32_generation as core_subject
from audit_v32_generation import parse_malformed_counts, validate_reach30_credit


class P30GenerationAuditTests(unittest.TestCase):
    def test_core_audit_main_never_overwrites_an_existing_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "audit.json"
            output.write_text("existing\n")
            argv = [
                "audit_v32_generation.py",
                "--root",
                str(root),
                "--gen",
                "1",
                "--out",
                str(output),
            ]
            with (
                mock.patch("sys.argv", argv),
                mock.patch.object(core_subject, "audit", return_value={"valid": True}),
                self.assertRaises(FileExistsError),
            ):
                core_subject.main()
            self.assertEqual(output.read_text(), "existing\n")

    def fixture(self, root: Path) -> tuple[Path, Path, dict]:
        experiment = root / "experiment"
        lane = root / "root"
        experiment.mkdir()
        (lane / "checkpoints").mkdir(parents=True)
        (lane / "data" / "gen1" / "main-0").mkdir(parents=True)
        (lane / "data" / "gen1" / "main-0" / "row.jsonl").write_text("{}\n")
        (lane / "config.json").write_text("{}\n")
        (lane / "v35-binding.json").write_text(
            json.dumps({"replicate": "a", "arm": "control-zero"}) + "\n"
        )
        checkpoint = lane / "checkpoints" / "main-0-gen1.pt"
        manifest = checkpoint.with_suffix(".manifest.json")
        checkpoint.write_bytes(b"checkpoint")
        manifest.write_text("{}\n")
        protocol = {
            "experiment": "p30-test",
            "implementationBaseCommit": "1" * 40,
            "initialPolicy": {"sha256": "5" * 64},
            "seedSchedule": {
                "maxGeneration": 1,
                "gamesPerGeneration": 1,
                "evalGamesPerGeneration": 1,
            },
            "catalog": {"sha256": "2" * 64},
            "trustGates": {
                "maxApproxKl": 0.02,
                "maxOrdinaryClipFraction": 0.2,
                "maxWeightedClipFraction": 0.2,
                "maxBehaviorReach30Ece": 0.1,
                "maxBehaviorLogpReconstructionError": 0.001,
                "behaviorReach30BrierNoWorseThanConstant": True,
                "stalls": 0,
                "malformedEpisodes": 0,
                "malformedRows": 0,
            },
            "training": {"optimizerStepsPerEpoch": 196, "batchSize": 512},
            "runtime": {"gpuUuid": "GPU-test"},
            "sourceContract": {"artifact": str(experiment / "source-lock.json")},
        }
        protocol_path = experiment / "protocol.json"
        protocol_path.write_text(json.dumps(protocol) + "\n")
        environment = {
            "schemaVersion": "arc-v35-p30-generation-environment-v1",
            "root": str(lane.resolve()),
            "generation": 1,
            "authorizationTokenId": "a" * 64,
            "gpuLine": "7,GPU-test,0,0",
            "cudaAvailable": True,
            "visibleDeviceCount": 1,
            "visibleDeviceName": "test GPU",
            "determinism": {
                "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
                "CUDA_VISIBLE_DEVICES": "GPU-test",
                "PYTHONHASHSEED": "0",
                "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
            },
            "protocol": {"path": str(protocol_path.resolve()), "sha256": subject.sha256(protocol_path)},
            "sourceContract": {
                "path": str((experiment / "source-lock.json").resolve()),
                "sha256": "4" * 64,
            },
        }
        (lane / "artifacts").mkdir()
        (lane / "artifacts" / "gen1-environment.json").write_text(
            json.dumps(environment) + "\n"
        )
        return lane, protocol_path, protocol

    def core_result(self, lane: Path) -> dict:
        checkpoint = lane / "checkpoints" / "main-0-gen1.pt"
        manifest = checkpoint.with_suffix(".manifest.json")
        return {
            "schemaVersion": "arc-v32-generation-audit-v1",
            "valid": True,
            "generation": 1,
            "stalls": 0,
            "evaluationStalls": 0,
            "malformedEpisodes": 0,
            "malformedRows": 0,
            "behaviorCheckpointSha256": "5" * 64,
            "behaviorReach30Calibration": {
                "brier": 0.1,
                "constant_brier": 0.2,
                "rows": 4.0,
            },
            "checkpointSha256": subject.sha256(checkpoint),
            "manifestSha256": subject.sha256(manifest),
        }

    def run_audit(self, lane: Path, protocol_path: Path, core: dict) -> dict:
        patches = (
            mock.patch.object(subject, "validate_protocol"),
            mock.patch.object(subject, "validate_initial_policy_artifacts"),
            mock.patch.object(subject, "validate_root_materialization"),
            mock.patch.object(subject, "validate_policy_manifest"),
            mock.patch.object(subject, "source_identity", return_value=("3" * 40, "4" * 64)),
            mock.patch("audit_v32_generation.audit", return_value=core),
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            return subject.audit(lane, 1, protocol_path)

    def test_audit_binds_trusted_source_and_raw_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lane, protocol_path, _ = self.fixture(Path(temporary))
            result = self.run_audit(lane, protocol_path, self.core_result(lane))
        self.assertEqual(result["schemaVersion"], "arc-v35-generation-audit-v1")
        self.assertEqual(result["trustedCoreAuditSchema"], "arc-v32-generation-audit-v1")
        self.assertEqual(result["sourceCommit"], "3" * 40)
        self.assertEqual(result["sourceContractSha256"], "4" * 64)
        self.assertEqual(result["replicate"], "a")
        self.assertEqual(result["arm"], "control-zero")
        self.assertEqual(result["rawGenerationCommitment"]["files"], 1)
        self.assertIsNone(result["previousAuditSha256"])
        self.assertEqual(result["auditChain"], [])
        self.assertFalse(result["promotionEligible"])

    def test_brier_worse_than_constant_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lane, protocol_path, _ = self.fixture(Path(temporary))
            core = self.core_result(lane)
            core["behaviorReach30Calibration"]["brier"] = 0.3
            with self.assertRaisesRegex(ValueError, "Brier gate failed"):
                self.run_audit(lane, protocol_path, core)

    def test_behavior_checkpoint_chain_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lane, protocol_path, _ = self.fixture(Path(temporary))
            core = self.core_result(lane)
            core["behaviorCheckpointSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "behavior-checkpoint chain changed"):
                self.run_audit(lane, protocol_path, core)

    def test_nonprospective_or_wrong_gpu_environment_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lane, protocol_path, _ = self.fixture(Path(temporary))
            environment_path = lane / "artifacts" / "gen1-environment.json"
            environment = json.loads(environment_path.read_text())
            environment["gpuLine"] = "7,GPU-test,10,1"
            environment_path.write_text(json.dumps(environment) + "\n")
            with self.assertRaisesRegex(ValueError, "environment manifest is invalid"):
                self.run_audit(lane, protocol_path, self.core_result(lane))

    def test_generation_outside_protocol_fails_before_core(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lane, protocol_path, _ = self.fixture(Path(temporary))
            with (
                mock.patch.object(subject, "validate_protocol"),
                mock.patch.object(subject, "validate_initial_policy_artifacts"),
                mock.patch.object(subject, "validate_root_materialization"),
                mock.patch("audit_v32_generation.audit") as core,
                self.assertRaisesRegex(ValueError, "outside the P30 seed schedule"),
            ):
                subject.audit(lane, 2, protocol_path)
            core.assert_not_called()

    def test_source_identity_requires_hash_bound_authorized_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "auditor.py"
            source.write_text("# frozen\n")
            lock = base / "source-lock.json"
            lock.write_text(
                json.dumps(
                    {
                        "schemaVersion": subject.SOURCE_LOCK_SCHEMA,
                        "authorized": True,
                        "immutable": True,
                        "promotionEligible": False,
                        "implementationBaseCommit": "1" * 40,
                        "implementationCommit": "3" * 40,
                        "files": {
                            "auditor": {
                                "path": "auditor.py",
                                "sha256": subject.sha256(source),
                                "gitBlobOid": "6" * 40,
                            }
                        },
                        "gitContext": {
                            "schemaVersion": "arc-v35-p30-git-context-v1"
                        },
                    }
                )
                + "\n"
            )
            protocol = {
                "implementationBaseCommit": "1" * 40,
                "sourceContract": {"artifact": str(lock), "sha256": subject.sha256(lock)},
            }
            with (
                mock.patch.object(subject, "REPO_ROOT", base),
                mock.patch.object(subject, "SOURCE_FILE_PATHS", {"auditor": "auditor.py"}),
                mock.patch.object(subject, "verify_git_context"),
            ):
                self.assertEqual(
                    subject.source_identity(protocol, base / "protocol.json"),
                    ("3" * 40, subject.sha256(lock)),
                )
                protocol["sourceContract"]["sha256"] = "0" * 64
                with self.assertRaisesRegex(ValueError, "hash-invalid"):
                    subject.source_identity(protocol, base / "protocol.json")

    def test_tree_commitment_rejects_empty_and_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "empty"):
                subject.tree_commitment(root)
            (root / "a").write_text("first")
            (root / "nested").mkdir()
            (root / "nested" / "b").write_text("second")
            first = subject.tree_commitment(root)
            second = subject.tree_commitment(root)
            self.assertEqual(first, second)
            self.assertEqual(first["files"], 2)

    def test_scheduled_reach30_credit_is_a_treatment(self) -> None:
        credit = {
            "soloReach30Coef": 0.0,
            "reach30Horizon": "30",
            "soloReach30Applied": 12,
            "soloReach30RealizedDose": 4.5,
            "soloReach30AppliedByBand": {"1-8": 2, "9-18": 4, "19-30": 6},
            "soloReach30DoseByBand": {"1-8": 0.3, "9-18": 1.2, "19-30": 3.0},
        }
        scalar, bands = validate_reach30_credit(
            [
                "--solo-reach30-coef",
                "0",
                "--solo-reach30-bands",
                "8:0.15,18:0.3,30:0.5",
            ],
            credit,
        )
        self.assertEqual(scalar, 0.0)
        self.assertEqual(bands, [[8, 0.15], [18, 0.3], [30, 0.5]])

    def test_scheduled_reach30_credit_requires_applied_rows(self) -> None:
        credit = {
            "soloReach30Coef": 0.0,
            "reach30Horizon": "30",
            "soloReach30Applied": 0,
            "soloReach30RealizedDose": 0.0,
            "soloReach30AppliedByBand": {"1-8": 0, "9-18": 0, "19-30": 0},
            "soloReach30DoseByBand": {"1-8": 0.0, "9-18": 0.0, "19-30": 0.0},
        }
        with self.assertRaisesRegex(ValueError, "no applied strategic rows"):
            validate_reach30_credit(
                [
                    "--solo-reach30-coef",
                    "0",
                    "--solo-reach30-bands",
                    "8:0.15,18:0.3,30:0.5",
                ],
                credit,
            )

    def test_realized_reach30_dose_must_match_the_frozen_schedule(self) -> None:
        credit = {
            "soloReach30Coef": 0.0,
            "reach30Horizon": "30",
            "soloReach30Applied": 12,
            "soloReach30RealizedDose": 4.6,
            "soloReach30AppliedByBand": {"1-8": 2, "9-18": 4, "19-30": 6},
            "soloReach30DoseByBand": {"1-8": 0.3, "9-18": 1.2, "19-30": 3.1},
        }
        with self.assertRaisesRegex(ValueError, "differs from the frozen schedule"):
            validate_reach30_credit(
                [
                    "--solo-reach30-coef",
                    "0",
                    "--solo-reach30-bands",
                    "8:0.15,18:0.3,30:0.5",
                ],
                credit,
            )

    def test_scalar_and_scheduled_reach30_credit_cannot_mix(self) -> None:
        credit = {
            "soloReach30Coef": 0.4,
            "reach30Horizon": "30",
            "soloReach30Applied": 12,
        }
        with self.assertRaisesRegex(ValueError, "both enabled"):
            validate_reach30_credit(
                [
                    "--solo-reach30-coef",
                    "0.4",
                    "--solo-reach30-bands",
                    "8:0.15,18:0.3,30:0.5",
                ],
                credit,
            )

    def test_malformed_counts_do_not_accept_ten_as_zero(self) -> None:
        valid = (
            "Loaded 100 PPO steps, 1 strategic row, 0 malformed episode(s) rejected, "
            "0 malformed option episode(s), 0 malformed row(s), 0 non-trajectory row(s), "
            "0 missing 'obsV2'"
        )
        self.assertEqual(parse_malformed_counts(valid), (0, 0))
        with self.assertRaisesRegex(ValueError, "10 malformed episodes"):
            parse_malformed_counts(valid.replace("0 malformed episode(s)", "10 malformed episode(s)"))
        with self.assertRaisesRegex(ValueError, "10 malformed rows"):
            parse_malformed_counts(valid.replace("0 malformed row(s)", "10 malformed row(s)"))


if __name__ == "__main__":
    unittest.main()
