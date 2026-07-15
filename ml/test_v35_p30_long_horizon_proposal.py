#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
PROPOSAL = REPO / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon"
PROTOCOL = PROPOSAL / "protocol.proposed.json"
PREPARER = REPO / "scripts/prepare-v35-p30-long-horizon-proposal.mjs"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class V35P30LongHorizonProposalTests(unittest.TestCase):
    def test_protocol_is_review_pending_and_non_executable(self) -> None:
        protocol = json.loads(PROTOCOL.read_text())
        self.assertEqual(protocol["status"], "proposed-review-pending")
        self.assertFalse(protocol["authorized"])
        self.assertFalse(protocol["promotionEligible"])
        self.assertEqual(
            protocol["review"],
            {
                "requiredModel": "Claude Fable",
                "requiredEffort": "high",
                "artifact": None,
                "sha256": None,
                "verdict": None,
            },
        )
        self.assertEqual(
            protocol["initialPolicy"]["sha256"],
            "c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91",
        )
        self.assertEqual(
            protocol["sourceContract"],
            {
                "schemaVersion": "arc-v35-p30-source-lock-v1",
                "artifact": None,
                "sha256": None,
            },
        )
        self.assertEqual(protocol["analysis"]["expectedGuardianCount"], 10)
        self.assertTrue(protocol["analysis"]["requireOutcomeBlindInputAuthorization"])
        self.assertEqual(protocol["runtime"]["physicalGpu"], 7)
        self.assertEqual(protocol["runtime"]["forbiddenGpus"], [4, 5, 6])

    def test_materializer_emits_nine_non_runnable_paired_configs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output_root = Path(temporary) / "proposal"
            subprocess.run(
                ["node", str(PREPARER), "--out-root", str(output_root)],
                cwd=REPO,
                check=True,
                capture_output=True,
                text=True,
            )
            manifest_path = output_root / "materialization.proposed.json"
            manifest = json.loads(manifest_path.read_text())
            self.assertFalse(manifest["authorized"])
            self.assertEqual(len(manifest["configs"]), 9)
            self.assertEqual(len(manifest["seedIntervals"]), 7)
            self.assertEqual(manifest["protocolSha256"], sha256(PROTOCOL))

            observed: dict[str, dict[str, list[str] | int]] = {}
            for item in manifest["configs"]:
                config_path = REPO / item["configProposed"]
                binding_path = REPO / item["bindingProposed"]
                config = json.loads(config_path.read_text())
                binding = json.loads(binding_path.read_text())
                self.assertEqual(sha256(config_path), item["configProposedSha256"])
                self.assertEqual(sha256(binding_path), item["bindingProposedSha256"])
                self.assertFalse(binding["authorized"])
                self.assertFalse(binding["promotionEligible"])
                self.assertFalse((config_path.parent / "config.json").exists())
                self.assertFalse((config_path.parent / "state.json").exists())
                args = config["train"]["extraArgs"]
                scalar_at = len(args) - 1 - list(reversed(args)).index("--solo-reach30-coef")
                schedule = args[args.index("--solo-reach30-bands") + 1] if "--solo-reach30-bands" in args else None
                observed[f'{item["replicate"]}/{item["arm"]}'] = {
                    "trainBase": config["seedSchedule"]["trainBase"],
                    "evalBase": config["seedSchedule"]["evalBase"],
                    "scalar": args[scalar_at + 1],
                    "schedule": schedule,
                }
            for replicate in ("a", "b", "c"):
                rows = [observed[f"{replicate}/{arm}"] for arm in ("control-zero", "uniform-040", "late-scheduled")]
                self.assertEqual(len({row["trainBase"] for row in rows}), 1)
                self.assertEqual(len({row["evalBase"] for row in rows}), 1)
                self.assertEqual(rows[0]["scalar"], "0")
                self.assertEqual(rows[1]["scalar"], "0.4")
                self.assertEqual(rows[2]["scalar"], "0")
                self.assertEqual(rows[2]["schedule"], "8:0.15,18:0.3,30:0.5")

    def test_materializer_source_has_no_launch_or_runnable_config_write(self) -> None:
        source = PREPARER.read_text()
        self.assertNotIn("config.json', configBytes", source)
        self.assertNotIn("run-league", source)
        self.assertNotIn("CUDA_VISIBLE_DEVICES", source)
        self.assertNotIn("authorized: true", source)
        self.assertIn("config.proposed.json", source)


if __name__ == "__main__":
    unittest.main()
