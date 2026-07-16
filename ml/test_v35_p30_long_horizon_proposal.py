#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
PROPOSAL = REPO / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon"
PROTOCOL = PROPOSAL / "protocol.proposed.json"
PREPARER = REPO / "scripts/prepare-v35-p30-long-horizon-proposal.mjs"
CALIBRATOR = REPO / "ml/calibrate_v35_p30_power.py"
POWER = PROPOSAL / "power-calibration.proposed.json"


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
                "commandReceipt": {"path": None, "sha256": None},
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
        self.assertEqual(protocol["sourceRegistry"]["files"], 538)
        self.assertEqual(
            protocol["sourceRegistry"]["sha256"],
            sha256(REPO / protocol["sourceRegistry"]["path"]),
        )
        registry = json.loads((REPO / protocol["sourceRegistry"]["path"]).read_text())
        self.assertEqual(len(registry["files"]), protocol["sourceRegistry"]["files"])
        for required in (
            "ml/sign_v35_p30_launch_permit_local.py",
            "ml/test_v35_p30_launch_permit.py",
            "ml/test_v35_p30_durable_nonexecutor_signing.py",
            "ml/run_v35_p30_analysis_review_local.py",
            "ml/test_v35_p30_analysis_review_local.py",
        ):
            self.assertIn(required, registry["files"])
        trust = protocol["executionTrust"]
        self.assertEqual(
            set(trust["roles"]),
            {"issuer", "executor", "guardian", "analysis-authorizer", "review-attester"},
        )
        self.assertEqual(trust["custody"]["localOnlyRoles"], ["review-attester"])
        self.assertNotIn(
            "arc-v35-p30-analysis-authorization-review-receipt-v2",
            trust["roles"]["guardian"]["allowedArtifactSchemas"],
        )
        self.assertEqual(protocol["analysis"]["expectedGuardianCount"], 10)
        self.assertTrue(protocol["analysis"]["requireOutcomeBlindInputAuthorization"])
        self.assertTrue(protocol["powerCalibration"]["adequateForPrimaryEfficacy"])
        self.assertFalse(protocol["powerCalibration"]["fullSelectorPowerClaimed"])
        self.assertEqual(protocol["powerCalibration"]["sha256"], sha256(POWER))
        confirmation = protocol["confirmationGates"]
        confirmation_path = REPO / confirmation["path"]
        self.assertTrue(confirmation["frozenBeforeP30Outcomes"])
        self.assertEqual(confirmation["sha256"], sha256(confirmation_path))
        gates = json.loads(confirmation_path.read_text())
        self.assertEqual(gates["freshPublicSolo"]["endpoints"]["round30WinRate"]["minimumWins"], 6631)
        self.assertEqual(gates["multiplayer"]["minimumOverallEloDeltaLower95"], 50)
        self.assertEqual(gates["michael"], {
            "games": 40,
            "minimumBotWins": 28,
            "tiesCountAsNonWins": True,
            "firstPlayerAndOrderAlternated": True,
            "immutableReplaysRequired": True,
            "procedureRequiresSeparatePreGameFableAcceptance": True,
        })
        self.assertEqual(protocol["runtime"]["physicalGpu"], 7)
        self.assertEqual(protocol["runtime"]["forbiddenGpus"], [4, 5, 6])

    def test_power_calibration_is_reproducible_and_adequate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / "power.json"
            subprocess.run(
                [str(REPO / "ml/.venv/bin/python"), str(CALIBRATOR), "--out", str(out)],
                cwd=REPO,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(out.read_bytes(), POWER.read_bytes())
            power = json.loads(out.read_text())
            self.assertTrue(power["simulation"]["adequateForPrimaryEfficacy"])
            self.assertGreaterEqual(
                power["simulation"][
                    "bonferroniJointPrimaryEligibilityPowerSimultaneousMonteCarloLower95"
                ],
                0.8,
            )
            self.assertEqual(
                power["simulation"]["endpointMonteCarloBound"]["endpointAlpha"],
                0.05 / 3,
            )
            self.assertFalse(power["scope"]["fullSelectorPowerClaimed"])
            self.assertEqual(power["test"]["replicates"], 18)
            self.assertEqual(power["test"]["enumerations"], 262144)
            self.assertGreater(
                power["planningAlternative"]["standardDeviationSensitivity"]["factor"],
                4.4,
            )
            self.assertEqual(
                power["test"]["primaryEligibilityGates"],
                {
                    "minimumTrueWinPointGain": 0.03,
                    "minimumPositiveReplicates": 13,
                    "replicateFloor": -0.01,
                    "maximumReplicatesBelowFloor": 2,
                },
            )
            sensitivity = power["simulation"]["smallerEffectSensitivity"]
            self.assertEqual(set(sensitivity), {"0.75", "0.5"})
            self.assertEqual(sensitivity["0.75"]["samples"], 5000)
            self.assertFalse(sensitivity["0.75"]["powerClaimed"])
            self.assertLess(
                sensitivity["0.75"][
                    "bonferroniJointPrimaryEligibilityPowerPointLowerBound"
                ],
                0.1,
            )
            self.assertEqual(
                sensitivity["0.5"][
                    "bonferroniJointPrimaryEligibilityPowerPointLowerBound"
                ],
                0.0,
            )

    def test_materializer_emits_fifty_four_non_runnable_paired_configs(self) -> None:
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
            self.assertEqual(len(manifest["configs"]), 54)
            self.assertEqual(len(manifest["seedIntervals"]), 37)
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
            for replicate in "abcdefghijklmnopqr":
                rows = [observed[f"{replicate}/{arm}"] for arm in ("control-zero", "uniform-040", "late-scheduled")]
                self.assertEqual(len({row["trainBase"] for row in rows}), 1)
                self.assertEqual(len({row["evalBase"] for row in rows}), 1)
                self.assertEqual(rows[0]["scalar"], "0")
                self.assertEqual(rows[1]["scalar"], "0.4")
                self.assertEqual(rows[2]["scalar"], "0")
                self.assertEqual(rows[2]["schedule"], "8:0.15,18:0.3,30:0.5")

    def test_materializer_rejects_bounded_unprovable_namespace_collision(self) -> None:
        protocol = json.loads(PROTOCOL.read_text())
        inventory_path = REPO / protocol["seedEvidence"]["inventoryPath"]
        inventory = json.loads(inventory_path.read_text())
        private_vault = next(
            namespace
            for namespace in inventory["unprovableNamespaces"]
            if namespace["id"] == "v35-private-seed-vault"
        )
        self.assertEqual(private_vault["bounds"], {"start": 970000000, "end": 989999999})

        with tempfile.TemporaryDirectory() as temporary:
            isolated_repo = Path(temporary) / "repo"
            files = (
                PREPARER.relative_to(REPO),
                PROTOCOL.relative_to(REPO),
                (REPO / protocol["powerCalibration"]["path"]).relative_to(REPO),
                (REPO / protocol["confirmationGates"]["path"]).relative_to(REPO),
                (REPO / protocol["sourceRegistry"]["path"]).relative_to(REPO),
                inventory_path.relative_to(REPO),
                (REPO / protocol["catalog"]["path"]).relative_to(REPO),
                Path("ml/league/configs/fair-v35-late-credit-base.json"),
            )
            for relative in files:
                destination = isolated_repo / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(REPO / relative, destination)

            isolated_protocol_path = isolated_repo / PROTOCOL.relative_to(REPO)
            isolated_protocol = json.loads(isolated_protocol_path.read_text())
            isolated_protocol["replicates"][-1]["trainBase"] = private_vault["bounds"]["start"] + 100000
            isolated_protocol_path.write_text(json.dumps(isolated_protocol, indent=2) + "\n")

            result = subprocess.run(
                [
                    "node",
                    str(isolated_repo / PREPARER.relative_to(REPO)),
                    "--out-root",
                    str(isolated_repo / "out"),
                ],
                cwd=isolated_repo,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "proposal seed overlap r:train and unprovable "
                "v35-private-seed-vault 970000000..989999999",
                result.stderr,
            )
            self.assertFalse((isolated_repo / "out" / "materialization.proposed.json").exists())

    def test_materializer_source_has_no_launch_or_runnable_config_write(self) -> None:
        source = PREPARER.read_text()
        self.assertNotIn("config.json', configBytes", source)
        self.assertNotIn("run-league", source)
        self.assertNotIn("CUDA_VISIBLE_DEVICES", source)
        self.assertNotIn("authorized: true", source)
        self.assertIn("config.proposed.json", source)


if __name__ == "__main__":
    unittest.main()
