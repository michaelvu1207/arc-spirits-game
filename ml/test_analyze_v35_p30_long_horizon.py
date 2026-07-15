#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ml.analyze_v35_p30_long_horizon import (
    ARMS,
    CONTROL,
    REPLICATES,
    TREATMENTS,
    analyze_indexed,
    endpoint_label,
    holm_adjust,
    load_inputs,
    paired_replicate_t,
    validate_report,
    validate_protocol,
)


REPO = Path(__file__).resolve().parents[1]
PROTOCOL_PATH = REPO / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/protocol.proposed.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def row(seed: int, guardian: str, strength: int) -> dict:
    final_vp = 28 + seed % 4 + strength
    won = final_vp >= 30
    return {
        "seed": seed,
        "guardian": guardian,
        "trueWin": won,
        "stalled": False,
        "finalVP": final_vp,
        "first30Round": 24 - strength if won else None,
        "post15VpPerRound": 1.2 + 0.2 * strength,
        "finalAttackDice": 8 + strength,
        "finalSpirits": 8 + strength,
        "finalMaxBarrier": 8 + strength,
        "cycle": {
            "decisions": 10,
            "productiveDecisions": 8,
            "optionalYieldDecisions": 2,
            "locationInteractions": 4,
            "summons": 2,
            "awakens": 1,
            "combats": 2,
            "rewards": 2,
            "pvpAttacks": 0,
            "first15Round": 14 - strength,
            "first30Round": 24 - strength if won else None,
            "post15VpPerRound": 1.2 + 0.2 * strength,
            "finalAttackDice": 8 + strength,
            "finalSpirits": 8 + strength,
            "finalMaxBarrier": 8 + strength,
            "vpAfterRound": {"15": 15, "30": final_vp},
        },
    }


class V35P30AnalyzerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = json.loads(PROTOCOL_PATH.read_text())
        self.protocol["analysis"]["bootstrap"]["draws"] = 2000
        self.indexed = {}
        self.reports = {}
        guardians = tuple(f"G{index}" for index in range(10))
        for replicate_index, replicate in enumerate(REPLICATES):
            for arm in ARMS:
                treatment_strength = 0 if arm == CONTROL else (2 if arm == "uniform-040" else 1)
                rows = {
                    seed: row(seed, guardians[seed % len(guardians)], treatment_strength)
                    for seed in range(64)
                }
                label = endpoint_label(replicate, arm)
                self.indexed[label] = rows
                self.reports[label] = {
                    "stalls": 0,
                    "performance": {
                        "gameWallMsP95": 1000 + 10 * replicate_index + treatment_strength,
                    },
                }

    def test_live_proposal_is_rejected_before_any_report_can_be_read(self) -> None:
        proposal = json.loads(PROTOCOL_PATH.read_text())
        with self.assertRaisesRegex(ValueError, "not Fable-accepted and authorized"):
            validate_protocol(proposal, require_authorized=True)
        validate_protocol(proposal, require_authorized=False)
        missing = REPO / "this-file-must-not-exist.json"
        with self.assertRaisesRegex(ValueError, "not Fable-accepted and authorized"):
            load_inputs(PROTOCOL_PATH, missing, missing)

    def test_holm_adjustment_is_monotone_and_family_bounded(self) -> None:
        adjusted = holm_adjust({"a": 0.001, "b": 0.01, "c": 0.04})
        self.assertEqual(adjusted, {"a": 0.003, "b": 0.02, "c": 0.04})

    def test_decision_inference_uses_training_replicates_not_game_rows(self) -> None:
        import numpy as np

        null = np.asarray([[0.1] * 64, [0.0] * 64, [-0.1] * 64])
        summary = paired_replicate_t(null)
        self.assertAlmostEqual(summary["point"], 0.0)
        self.assertAlmostEqual(summary["oneSidedP"], 0.5)
        self.assertEqual(summary["degreesOfFreedom"], 2)

    def test_strong_treatments_select_larger_uniform_effect_deterministically(self) -> None:
        first = analyze_indexed(self.indexed, self.reports, self.protocol)
        second = analyze_indexed(self.indexed, self.reports, self.protocol)
        self.assertEqual(first, second)
        self.assertEqual(first["selectedTreatment"], "uniform-040")
        self.assertTrue(first["comparisons"]["uniform-040"]["passed"])
        self.assertTrue(first["comparisons"]["late-scheduled"]["passed"])
        self.assertFalse(first["promotionEligible"])
        self.assertTrue(first["freshPublicConfirmationRequired"])

    def test_guardian_regression_rejects_otherwise_strong_treatment(self) -> None:
        harmed = copy.deepcopy(self.indexed)
        for replicate in REPLICATES:
            rows = harmed[endpoint_label(replicate, "late-scheduled")]
            for seed, game in rows.items():
                if game["guardian"] == "G0":
                    game.update(
                        {
                            "trueWin": False,
                            "finalVP": 20,
                            "first30Round": None,
                            "post15VpPerRound": 0.0,
                        }
                    )
        result = analyze_indexed(harmed, self.reports, self.protocol)
        comparison = result["comparisons"]["late-scheduled"]
        self.assertFalse(comparison["gates"]["guardianWorstCase"])
        self.assertFalse(comparison["passed"])

    def test_extra_or_relabelled_endpoint_is_rejected(self) -> None:
        relabelled = dict(self.indexed)
        relabelled["rep-a-impostor"] = relabelled.pop(endpoint_label("a", CONTROL))
        with self.assertRaisesRegex(ValueError, "exact nine"):
            analyze_indexed(relabelled, self.reports, self.protocol)

    def test_control_stall_and_latency_regression_fail_closed(self) -> None:
        reports = copy.deepcopy(self.reports)
        reports[endpoint_label("a", CONTROL)]["stalls"] = 1
        reports[endpoint_label("b", "uniform-040")]["performance"]["gameWallMsP95"] = 70000
        result = analyze_indexed(self.indexed, reports, self.protocol)
        self.assertFalse(result["comparisons"]["uniform-040"]["gates"]["stalls"])
        self.assertFalse(result["comparisons"]["uniform-040"]["gates"]["latencyAbsolute"])
        self.assertFalse(result["comparisons"]["uniform-040"]["passed"])

    def _synthetic_report(self) -> tuple[dict, tuple[str, ...], str, str]:
        protocol = copy.deepcopy(self.protocol)
        protocol["seedSchedule"]["commonPublicBase"] = 1000
        protocol["seedSchedule"]["commonPublicGames"] = 10
        guardians = tuple(f"G{index}" for index in range(10))
        source = "a" * 64
        weights = "b" * 64
        rows = [row(seed, guardians[seed % 10], 0) for seed in range(1000, 1010)]
        true_wins = sum(game["trueWin"] for game in rows)
        reach15 = sum(game["cycle"]["first15Round"] is not None for game in rows)
        report = {
            "schemaVersion": "solo-heldout-v2",
            "sourceCommit": source,
            "weightsSha256": weights,
            "catalogSha256": protocol["catalog"]["sha256"],
            "seed0": 1000,
            "games": 10,
            "maxRounds": 30,
            "maxStatusLevel": 2,
            "inference": {
                "format": "arc-entity-scorer-v2",
                "obsDim": 3419,
                "actDim": 104,
                "weightsPath": "/tmp/checkpoint.pt",
                "weightsSha256": weights,
                "wire": "binary",
            },
            "decode": {
                "policyObsVersion": 2,
                "inferenceSocket": "/tmp/infer.sock",
                "learnMonsterRewardChoices": False,
                "sample": True,
                "temperature": 0.55,
            },
            "performance": {
                "wallSeconds": 1.0,
                "gamesPerSecond": 10.0,
                "workers": 24,
                "gameWallMsP50": 100.0,
                "gameWallMsP95": 120.0,
            },
            "perGame": rows,
            "trueWins": true_wins,
            "trueWinRate": true_wins / 10,
            "stalls": 0,
            "stallRate": 0.0,
            "reach15Rate": reach15 / 10,
            "replayHashes": [
                {"seed": game["seed"], "replayTraceSha256": f"{game['seed']:064x}"}
                for game in rows
            ],
        }
        return report, guardians, source, weights

    def test_report_reconciles_inference_cycle_guardian_and_replay(self) -> None:
        report, guardians, source, weights = self._synthetic_report()
        protocol = copy.deepcopy(self.protocol)
        protocol["seedSchedule"]["commonPublicBase"] = 1000
        protocol["seedSchedule"]["commonPublicGames"] = 10
        indexed = validate_report(
            report,
            label="fixture",
            protocol=protocol,
            source_commit=source,
            weights_sha256=weights,
            guardian_names=guardians,
        )
        self.assertEqual(len(indexed), 10)
        for mutation, error in (
            (("inference", "wire", "json"), "inference handshake"),
            (("perGame", 0, "post15VpPerRound", 99.0), "objective telemetry"),
            (("perGame", 0, "guardian", "wrong"), "absolute-balanced"),
        ):
            changed = copy.deepcopy(report)
            target = changed
            for key in mutation[:-2]:
                target = target[key]
            target[mutation[-2]] = mutation[-1]
            with self.assertRaisesRegex(ValueError, error):
                validate_report(
                    changed,
                    label="fixture",
                    protocol=protocol,
                    source_commit=source,
                    weights_sha256=weights,
                    guardian_names=guardians,
                )

    def test_load_inputs_verifies_complete_outcome_blind_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            review = root / "fable-review.md"
            review.write_text("VERDICT: ACCEPT\n")
            source_paths = {
                "packageLock": REPO / "package-lock.json",
                "mlRequirements": REPO / "ml/requirements.txt",
                "runRoot": REPO / "scripts/run-v35-root.sh",
                "leagueRunner": REPO / "scripts/run-league.mjs",
                "leagueManager": REPO / "src/lib/play/ml/league/manager.ts",
                "trainer": REPO / "ml/train.py",
                "ppo": REPO / "ml/ppo.py",
                "evaluator": REPO / "scripts/evaluate-solo-checkpoint.mjs",
                "inferenceServer": REPO / "ml/infer_server.py",
                "actorPool": REPO / "src/lib/play/ml/actorPool.ts",
                "guardianSchedule": REPO / "src/lib/play/ml/evalSchedule.ts",
                "generationAuditor": REPO / "ml/audit_v35_generation.py",
                "analyzer": REPO / "ml/analyze_v35_p30_long_horizon.py",
                "analyzerTests": Path(__file__).resolve(),
            }
            source_lock = root / "source-lock.json"
            source_lock.write_text(
                json.dumps(
                    {
                        "schemaVersion": "arc-v35-p30-source-lock-v1",
                        "authorized": True,
                        "immutable": True,
                        "promotionEligible": False,
                        "implementationCommit": "a" * 40,
                        "files": {
                            label: {"path": str(path), "sha256": sha256(path)}
                            for label, path in source_paths.items()
                        },
                    },
                    indent=2,
                )
                + "\n"
            )
            protocol = copy.deepcopy(self.protocol)
            protocol.update({"status": "authorized", "authorized": True})
            protocol["review"].update(
                {"artifact": str(review), "sha256": sha256(review), "verdict": "ACCEPT"}
            )
            protocol["sourceContract"].update(
                {"artifact": str(source_lock), "sha256": sha256(source_lock)}
            )
            protocol["seedSchedule"]["commonPublicBase"] = 1000
            protocol["seedSchedule"]["commonPublicGames"] = 10
            protocol["analysis"]["commonPublicGames"] = 10
            protocol_path = root / "protocol.json"
            protocol_path.write_text(json.dumps(protocol, indent=2) + "\n")
            protocol_hash = sha256(protocol_path)
            report_entries = []
            for replicate in REPLICATES:
                replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
                for arm in ARMS:
                    label = endpoint_label(replicate, arm)
                    endpoint = root / label
                    endpoint.mkdir()
                    checkpoint = endpoint / "gen8.pt"
                    checkpoint.write_bytes(label.encode())
                    checkpoint_manifest = endpoint / "gen8.manifest.json"
                    checkpoint_manifest.write_text("{}\n")
                    config = endpoint / "config.json"
                    config.write_text(json.dumps({"label": label}) + "\n")
                    binding = endpoint / "binding.json"
                    binding.write_text(json.dumps({"label": label}) + "\n")
                    weights_hash = sha256(checkpoint)
                    report, _, _, _ = self._synthetic_report()
                    catalog = json.loads((REPO / protocol["catalog"]["path"]).read_text())
                    catalog_guardians = [guardian["name"] for guardian in catalog["guardians"]]
                    for game in report["perGame"]:
                        game["guardian"] = catalog_guardians[game["seed"] % len(catalog_guardians)]
                    report["sourceCommit"] = sha256(source_lock)
                    report["weightsSha256"] = weights_hash
                    report["inference"]["weightsSha256"] = weights_hash
                    report["inference"]["weightsPath"] = str(checkpoint)
                    report_path = endpoint / "report.json"
                    report_path.write_text(json.dumps(report, indent=2) + "\n")
                    audit = endpoint / "gen8-audit.json"
                    generation_offset = protocol["seedSchedule"]["maxGeneration"] - 1
                    train_min = replicate_contract["trainBase"] + generation_offset * protocol["seedSchedule"]["trainStride"]
                    eval_min = replicate_contract["evalBase"] + generation_offset * protocol["seedSchedule"]["evalStride"]
                    audit.write_text(
                        json.dumps(
                            {
                                "schemaVersion": "arc-v35-generation-audit-v1",
                                "valid": True,
                                "generation": 8,
                                "replicate": replicate,
                                "arm": arm,
                                "checkpointSha256": weights_hash,
                                "manifestSha256": sha256(checkpoint_manifest),
                                "protocolSha256": protocol_hash,
                                "configSha256": sha256(config),
                                "bindingSha256": sha256(binding),
                                "catalogSha256": protocol["catalog"]["sha256"],
                                "promotionEligible": False,
                                "games": 1024,
                                "stalls": 0,
                                "evaluationStalls": 0,
                                "trainingSeeds": {"min": train_min, "max": train_min + 1023, "count": 1024},
                                "evaluationSeeds": {"min": eval_min, "max": eval_min + 255, "count": 256},
                                "rows": 100,
                                "policyRows": 90,
                                "rawGenerationCommitment": {"sha256": "c" * 64, "files": 2, "bytes": 10},
                            },
                            indent=2,
                        )
                        + "\n"
                    )
                    exit_code = endpoint / "exit-code"
                    exit_code.write_text("0\n")
                    stdout = endpoint / "evaluator.stdout"
                    stdout.write_bytes(report_path.read_bytes())
                    stderr = endpoint / "evaluator.stderr"
                    stderr.write_bytes(b"")
                    server_log = endpoint / "server.log"
                    server_log.write_text("ready\n")
                    replay_report = endpoint / "replay-report.json"
                    replay_report.write_bytes(report_path.read_bytes())
                    replay_exit_code = endpoint / "replay-exit-code"
                    replay_exit_code.write_text("0\n")
                    replay_stdout = endpoint / "replay-evaluator.stdout"
                    replay_stdout.write_bytes(replay_report.read_bytes())
                    replay_stderr = endpoint / "replay-evaluator.stderr"
                    replay_stderr.write_bytes(b"")
                    replay_server_log = endpoint / "replay-server.log"
                    replay_server_log.write_text("ready\n")
                    report_entries.append(
                        {
                            "label": label,
                            "replicate": replicate,
                            "arm": arm,
                            "path": str(report_path),
                            "sha256": sha256(report_path),
                            "weightsSha256": weights_hash,
                            "generationAuditPath": str(audit),
                            "generationAuditSha256": sha256(audit),
                            "checkpointPath": str(checkpoint),
                            "checkpointManifestPath": str(checkpoint_manifest),
                            "checkpointManifestSha256": sha256(checkpoint_manifest),
                            "configPath": str(config),
                            "configSha256": sha256(config),
                            "bindingPath": str(binding),
                            "bindingSha256": sha256(binding),
                            "exitCodePath": str(exit_code),
                            "exitCodeSha256": sha256(exit_code),
                            "evaluatorStdoutPath": str(stdout),
                            "evaluatorStdoutSha256": sha256(stdout),
                            "evaluatorStderrPath": str(stderr),
                            "evaluatorStderrSha256": sha256(stderr),
                            "serverLogPath": str(server_log),
                            "serverLogSha256": sha256(server_log),
                            "replayReportPath": str(replay_report),
                            "replayReportSha256": sha256(replay_report),
                            "replayExitCodePath": str(replay_exit_code),
                            "replayExitCodeSha256": sha256(replay_exit_code),
                            "replayEvaluatorStdoutPath": str(replay_stdout),
                            "replayEvaluatorStdoutSha256": sha256(replay_stdout),
                            "replayEvaluatorStderrPath": str(replay_stderr),
                            "replayEvaluatorStderrSha256": sha256(replay_stderr),
                            "replayServerLogPath": str(replay_server_log),
                            "replayServerLogSha256": sha256(replay_server_log),
                        }
                    )
            manifest_path = root / "input-manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "arc-v35-p30-development-input-v1",
                        "valid": True,
                        "immutable": True,
                        "outcomesInspected": False,
                        "protocolSha256": protocol_hash,
                        "sourceCommit": sha256(source_lock),
                        "replayIntegrityVerified": True,
                        "reports": report_entries,
                    },
                    indent=2,
                )
                + "\n"
            )
            authorization_path = root / "analysis-authorization.json"
            authorization_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "arc-v35-p30-analysis-authorization-v1",
                        "authorized": True,
                        "immutable": True,
                        "outcomesInspected": False,
                        "promotionEligible": False,
                        "privateEvaluationAuthorized": False,
                        "protocolSha256": protocol_hash,
                        "inputManifestPath": str(manifest_path),
                        "inputManifestSha256": sha256(manifest_path),
                        "sourceContractSha256": sha256(source_lock),
                        "files": {
                            "analyzer": {
                                "path": str(source_paths["analyzer"]),
                                "sha256": sha256(source_paths["analyzer"]),
                            },
                            "analyzerTests": {
                                "path": str(source_paths["analyzerTests"]),
                                "sha256": sha256(source_paths["analyzerTests"]),
                            },
                        },
                    },
                    indent=2,
                )
                + "\n"
            )
            with mock.patch("ml.analyze_v35_p30_long_horizon.validate_protocol"):
                loaded_protocol, indexed, reports = load_inputs(
                    protocol_path, manifest_path, authorization_path
                )
            self.assertEqual(loaded_protocol["status"], "authorized")
            self.assertEqual(len(indexed), 9)
            self.assertEqual(len(reports), 9)


if __name__ == "__main__":
    unittest.main()
