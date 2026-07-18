from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from freeze_v32_development import (
    choose_endpoint,
    sha256,
    validate_diagnostic_report,
    validate_generation,
    validate_latency_smoke,
    write_freeze,
)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


def manipulation(generation: int, passed: bool, *, outcomes: bool = False) -> dict:
    return {
        "schemaVersion": "arc-v32-manipulation-audit-v1",
        "valid": True,
        "generation": generation,
        "performanceOutcomesInspected": outcomes,
        "endpointRule": "generation 8 unless movement fails, then all roots continue unchanged to generation 12",
        "models": {},
        "manipulation": {"passed": passed},
        "disposition": "eligible-endpoint" if passed else "inconclusive-underdosed",
    }


class EndpointSelectionTest(unittest.TestCase):
    def test_generation_8_pass_is_the_only_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_json(experiment / "artifacts/manipulation-gen8.json", manipulation(8, True))
            endpoint, audits = choose_endpoint(experiment)
            self.assertEqual(endpoint, 8)
            self.assertEqual(len(audits), 1)

    def test_generation_12_requires_valid_outcome_blind_gen8_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_json(experiment / "artifacts/manipulation-gen8.json", manipulation(8, False))
            write_json(experiment / "artifacts/manipulation-gen12.json", manipulation(12, True))
            endpoint, audits = choose_endpoint(experiment)
            self.assertEqual(endpoint, 12)
            self.assertEqual([audit[1]["generation"] for audit in audits], [8, 12])

            write_json(experiment / "artifacts/manipulation-gen8.json", manipulation(8, False, outcomes=True))
            with self.assertRaisesRegex(ValueError, "outcome inspection"):
                choose_endpoint(experiment)

    def test_failed_generation_12_never_opens_development(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_json(experiment / "artifacts/manipulation-gen8.json", manipulation(8, False))
            write_json(experiment / "artifacts/manipulation-gen12.json", manipulation(12, False))
            with self.assertRaisesRegex(ValueError, "did not pass"):
                choose_endpoint(experiment)


class GenerationIntegrityTest(unittest.TestCase):
    def make_generation(self, base: Path) -> tuple[Path, Path, dict, dict]:
        repo = base
        root = repo / "ml/experiments/v32-onpolicy-solo/league/rep-a/control-uniform"
        previous = repo / "ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
        checkpoint = root / "checkpoints/main-0-gen1.pt"
        manifest = root / "checkpoints/main-0-gen1.manifest.json"
        previous.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        previous.write_bytes(b"previous")
        checkpoint.write_bytes(b"endpoint")
        write_json(manifest, {
            "format": "arc-entity-scorer-v2",
            "obs_version": 2,
            "obs_flat_len": 3419,
            "act_dim": 104,
            "d_model": 128,
            "layers": 3,
            "heads": 4,
        })
        config = {
            "gamesPerGen": 1024,
            "evalGames": 256,
            "train": {"epochs": 2},
            "v2": {"dModel": 128, "layers": 3, "heads": 4},
            "seedSchedule": {"trainBase": 946100000, "trainStride": 2048, "evalBase": 946700000, "evalStride": 8192},
        }
        gates = {
            "maxBehaviorLogpReconstructionError": 0.001,
            "maxBehaviorReach30Ece": 0.1,
            "exactOptimizerStepsPerEpoch": 196,
            "maxApproxKl": 0.02,
            "maxClipFraction": 0.2,
        }
        audit = {
            "schemaVersion": "arc-v32-generation-audit-v1",
            "valid": True,
            "root": str(root),
            "generation": 1,
            "trainingSeeds": {"min": 946100000, "max": 946101023, "count": 1024},
            "evaluationSeeds": {"min": 946700000, "max": 946700255, "count": 256},
            "games": 1024,
            "stalls": 0,
            "evaluationStalls": 0,
            "rows": 120000,
            "policyRows": 80000,
            "roundCounts": {"1-8": 1, "9-18": 1, "19-30": 1},
            "policyRoundCounts": {"1-8": 1, "9-18": 1, "19-30": 1},
            "behaviorCheckpointSha256": sha256(previous),
            "behaviorLogpMaxAbsError": 0.00001,
            "behaviorReach30Calibration": {"ece": 0.02},
            "epochMetrics": [
                {"optimizerSteps": 196, "approxKl": 0.01, "roundWeightedKl": 0.01, "clipFraction": 0.1, "roundWeightedClipFraction": 0.1},
                {"optimizerSteps": 196, "approxKl": 0.01, "roundWeightedKl": 0.01, "clipFraction": 0.1, "roundWeightedClipFraction": 0.1},
            ],
            "checkpointSha256": sha256(checkpoint),
            "manifestSha256": sha256(manifest),
        }
        write_json(root / "artifacts/gen1-audit.json", audit)
        return root, previous, config, gates

    def test_accepts_exact_lineage_and_rejects_stalls_or_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            root, previous, config, gates = self.make_generation(repo)
            record, checkpoint = validate_generation(repo, root, config, 1, previous, "catalog", gates)
            self.assertEqual(record["stalls"], 0)
            self.assertEqual(checkpoint.name, "main-0-gen1.pt")

            audit_path = root / "artifacts/gen1-audit.json"
            audit = json.loads(audit_path.read_text())
            audit["stalls"] = 1
            write_json(audit_path, audit)
            with self.assertRaisesRegex(ValueError, "stall"):
                validate_generation(repo, root, config, 1, previous, "catalog", gates)


class PredevelopmentGateTest(unittest.TestCase):
    def test_diagnostic_checks_integrity_but_not_strength(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            freeze = {
                "developmentContract": {"maxRounds": 30, "maxStatusLevel": 2},
                "policies": {"v30": {"weightsSha256": "a" * 64}},
                "catalog": {"sha256": "b" * 64},
                "authorization": {"sourceContractSha256": "c" * 64},
            }
            report = {
                "schemaVersion": "solo-heldout-v2",
                "seed0": 951920000,
                "games": 256,
                "maxRounds": 30,
                "maxStatusLevel": 2,
                "weightsSha256": "a" * 64,
                "catalogSha256": "b" * 64,
                "sourceCommit": "c" * 64,
                "decode": {"policyObsVersion": 2, "inferenceSocket": "/dev/shm/test.sock", "learnMonsterRewardChoices": False, "sample": True, "temperature": 0.55},
                "stalls": 0,
                # Deliberately all losses: system diagnostics cannot impose a strength gate.
                "trueWins": 0,
                "perGame": [{"seed": 951920000 + index, "trueWin": False, "stalled": False} for index in range(256)],
            }
            path = repo / "report.json"
            write_json(path, report)
            self.assertEqual(validate_diagnostic_report(repo, freeze, path)["trueWins"], 0)

    def test_latency_smoke_is_exact_shape_but_p95_is_nonbinding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            weights = repo / "shared.pt"
            weights.write_bytes(b"shared")
            freeze = {"policies": {"shared-critic": {"weightsSha256": sha256(weights)}}}
            report = {
                "schemaVersion": "arc-infer-latency-v1",
                "server": {"format": "arc-entity-scorer-v2", "obs_dim": 3419, "act_dim": 104, "weights": str(weights)},
                "protocol": {"wire": "binary", "rowsPerRequest": 32, "candidatesPerRow": 30, "clients": 8, "warmupRequestsPerClient": 20, "measuredRequestsPerClient": 200, "requestBytes": 1},
                "measurement": {"requests": 1600, "rows": 51200, "requestLatencyMs": {"min": 1, "p50": 2, "p95": 999, "p99": 1000, "max": 1001, "mean": 3}},
            }
            path = repo / "latency.json"
            write_json(path, report)
            self.assertEqual(validate_latency_smoke(repo, freeze, path)["measurement"]["requestLatencyMs"]["p95"], 999)


class ImmutableWriteTest(unittest.TestCase):
    def test_write_once_manifest_and_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "freeze.json"
            write_freeze(path, {"valid": True})
            self.assertTrue(path.with_suffix(".json.sha256").is_file())
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                write_freeze(path, {"valid": True})


if __name__ == "__main__":
    unittest.main()
