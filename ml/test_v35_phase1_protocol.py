#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

from ml.audit_v35_generation import tree_commitment, validate_binding
from ml.inventory_v35_seeds import seed_intervals


REPO = Path(__file__).resolve().parents[1]
EXPERIMENT = REPO / "ml/experiments/v35-weco-recursive-autoresearch"
PROTOCOL_PATH = EXPERIMENT / "phase1-protocol.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class V35Phase1ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.protocol = json.loads(PROTOCOL_PATH.read_text())

    def test_fable_review_and_nonpromotion_are_bound(self) -> None:
        self.assertEqual(self.protocol["status"], "smoke-frozen")
        self.assertEqual(self.protocol["review"]["verdict"], "PASS")
        self.assertFalse(self.protocol["promotionEligible"])
        review = (REPO / self.protocol["review"]["artifact"]).read_text()
        self.assertIn("Verdict: **PASS**", review)

    def test_frozen_catalog_and_checkpoint_hashes(self) -> None:
        self.assertEqual(sha256(REPO / self.protocol["catalog"]["path"]), self.protocol["catalog"]["sha256"])
        self.assertEqual(
            sha256(REPO / self.protocol["initialPolicy"]["path"]),
            self.protocol["initialPolicy"]["sha256"],
        )
        self.assertEqual(
            sha256(REPO / self.protocol["initialPolicy"]["manifestPath"]),
            self.protocol["initialPolicy"]["manifestSha256"],
        )

    def test_registered_seed_intervals_are_disjoint(self) -> None:
        intervals = seed_intervals(self.protocol)
        self.assertEqual(len(intervals), 7)
        for index, left in enumerate(intervals):
            for right in intervals[index + 1 :]:
                self.assertTrue(
                    int(left["end"]) < int(right["start"])
                    or int(right["end"]) < int(left["start"]),
                    f"{left['id']} overlaps {right['id']}",
                )
        self.assertEqual(intervals[-1]["start"], 969_030_000)
        self.assertEqual(intervals[-1]["end"], 969_034_095)

    def test_all_nine_materialized_bindings_validate(self) -> None:
        materialized = json.loads((EXPERIMENT / "artifacts/phase1-materialized-configs.json").read_text())
        self.assertEqual(len(materialized["configs"]), 9)
        observed = set()
        for item in materialized["configs"]:
            root = REPO / item["root"]
            protocol, config, binding = validate_binding(root, PROTOCOL_PATH)
            self.assertEqual(protocol["experiment"], self.protocol["experiment"])
            self.assertEqual(sha256(root / "config.json"), item["configSha256"])
            self.assertEqual(sha256(root / "v35-binding.json"), item["bindingSha256"])
            self.assertEqual(config["soloMaxStatusLevel"], 2)
            self.assertFalse(binding["promotionEligible"])
            observed.add((binding["replicate"], binding["arm"]))
        self.assertEqual(len(observed), 9)

    def test_binding_audit_accepts_only_protocol_bound_reach30_schedule(self) -> None:
        import tempfile

        source_root = EXPERIMENT / "league/rep-a/control-uniform"
        protocol = json.loads(PROTOCOL_PATH.read_text())
        arm = next(item for item in protocol["arms"] if item["id"] == "control-uniform")
        arm["soloReach30Bands"] = [[8, 0.15], [18, 0.3], [30, 0.5]]
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            root = temp / "root"
            root.mkdir()
            protocol_path = temp / "protocol.json"
            protocol_path.write_text(json.dumps(protocol, indent=2) + "\n")
            config = json.loads((source_root / "config.json").read_text())
            config["train"]["extraArgs"].extend(
                ["--solo-reach30-bands", "8:0.15,18:0.3,30:0.5"]
            )
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config, indent=2) + "\n")
            binding = json.loads((source_root / "v35-binding.json").read_text())
            binding["protocolSha256"] = sha256(protocol_path)
            binding["configSha256"] = sha256(config_path)
            (root / "v35-binding.json").write_text(json.dumps(binding, indent=2) + "\n")
            _, validated_config, validated_binding = validate_binding(root, protocol_path)
            self.assertEqual(validated_binding["arm"], "control-uniform")
            self.assertIn("--solo-reach30-bands", validated_config["train"]["extraArgs"])

            config["train"]["extraArgs"][-1] = "8:0.15,18:0.3,30:0.4"
            config_path.write_text(json.dumps(config, indent=2) + "\n")
            binding["configSha256"] = sha256(config_path)
            (root / "v35-binding.json").write_text(json.dumps(binding, indent=2) + "\n")
            with self.assertRaisesRegex(ValueError, "reach30 coefficient bands changed"):
                validate_binding(root, protocol_path)

    def test_seed_inventory_passes_without_collision(self) -> None:
        inventory = json.loads((EXPERIMENT / "artifacts/phase1-seed-inventory.json").read_text())
        self.assertTrue(inventory["valid"])
        self.assertEqual(inventory["collisions"], [])
        self.assertGreater(inventory["filesScanned"], 20)

    def test_runtime_is_gpu7_only_and_compact(self) -> None:
        runtime = self.protocol["runtime"]
        self.assertEqual(runtime["physicalGpu"], 7)
        self.assertEqual(runtime["forbiddenGpus"], [4, 5, 6])
        self.assertEqual(runtime["maxConcurrentRoots"], 1)
        runner = (REPO / "scripts/run-v35-root.sh").read_text()
        self.assertIn("CUDA_VISIBLE_DEVICES=7", runner)
        self.assertIn('rm -rf "$data_root"', runner)
        self.assertIn("no automatic retry is authorized", runner)

    def test_generation_tree_commitment_changes_with_content(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            (root / "a").write_text("one")
            first = tree_commitment(root)
            (root / "a").write_text("two")
            second = tree_commitment(root)
            self.assertNotEqual(first["sha256"], second["sha256"])
            self.assertEqual(first["files"], 1)


if __name__ == "__main__":
    unittest.main()
