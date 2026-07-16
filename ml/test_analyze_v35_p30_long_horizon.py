#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ml.analyze_v35_p30_long_horizon import (
    ARMS,
    CONTROL,
    EVALUATION_RECEIPT_SCHEMA,
    FABLE_RECEIPT_SCHEMA,
    REPLICATES,
    SOURCE_FILE_PATHS,
    TREATMENTS,
    analyze_indexed,
    endpoint_label,
    final_fable_review_prompt,
    holm_adjust,
    load_inputs,
    manifest_receipt_merkle_root,
    paired_replicate_sign_flip,
    sign_flip_matrix,
    validate_fable_receipt,
    validate_root_materialization,
    validate_report,
    validate_protocol,
)
from ml.v35_p30_authorized_execution import AUTHORIZATION_SCHEMA
from ml.v35_p30_crypto import (
    canonical_json,
    executable_sha256,
    public_key_identity,
    sha256_file,
    sign_payload,
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
                    "_verifiedMalformedEpisodes": 0,
                    "performance": {
                        "gameWallMsP95": 1000 + 10 * replicate_index + treatment_strength,
                    },
                }

    def test_live_proposal_is_rejected_before_any_report_can_be_read(self) -> None:
        proposal = json.loads(PROTOCOL_PATH.read_text())
        with self.assertRaisesRegex(
            ValueError,
            "trust root is not materialized|execution trust root is not frozen|not Fable-accepted and authorized",
        ):
            validate_protocol(proposal, require_authorized=True)
        validate_protocol(proposal, require_authorized=False)
        missing = REPO / "this-file-must-not-exist.json"
        with self.assertRaisesRegex(
            ValueError,
            "trust root is not materialized|execution trust root is not frozen|not Fable-accepted and authorized",
        ):
            load_inputs(PROTOCOL_PATH, missing, missing)

    def test_fable_receipt_binds_plan_bytes_across_different_host_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            review = root / "review.md"
            stderr = root / "review.stderr"
            receipt_path = root / "review.receipt.json"
            review.write_text("VERDICT: ACCEPT\n")
            stderr.write_bytes(b"")
            local_cwd = Path("/different/review-host/arc-spirits-game")
            plan_relative = self.protocol["plan"]
            plan_path = REPO / plan_relative
            receipt = {
                "schemaVersion": FABLE_RECEIPT_SCHEMA,
                "valid": True,
                "model": "fable",
                "effort": "high",
                "tools": ["Read"],
                "noSessionPersistence": True,
                "argv": [
                    "claude",
                    "-p",
                    "--model",
                    "fable",
                    "--effort",
                    "high",
                    "--tools",
                    "Read",
                    "--no-session-persistence",
                    final_fable_review_prompt(local_cwd / plan_relative),
                ],
                "cwd": str(local_cwd),
                "plan": {"path": plan_relative, "sha256": sha256(plan_path)},
                "startedAtUtc": "2026-07-16T00:00:00Z",
                "finishedAtUtc": "2026-07-16T00:00:01Z",
                "exitCode": 0,
                "stdoutPath": str(review),
                "stdoutSha256": sha256(review),
                "stderrPath": str(stderr),
                "stderrSha256": sha256(stderr),
            }
            receipt_path.write_text(json.dumps(receipt) + "\n")
            protocol = copy.deepcopy(self.protocol)
            protocol["review"]["commandReceipt"] = {
                "path": str(receipt_path),
                "sha256": sha256(receipt_path),
            }
            validate_fable_receipt(
                protocol, protocol_path=PROTOCOL_PATH, review_path=review
            )
            receipt["plan"]["sha256"] = "0" * 64
            receipt_path.write_text(json.dumps(receipt) + "\n")
            protocol["review"]["commandReceipt"]["sha256"] = sha256(receipt_path)
            with self.assertRaisesRegex(ValueError, "reviewed P30 plan"):
                validate_fable_receipt(
                    protocol, protocol_path=PROTOCOL_PATH, review_path=review
                )

    def test_holm_adjustment_is_monotone_and_family_bounded(self) -> None:
        adjusted = holm_adjust({"a": 0.001, "b": 0.01, "c": 0.04})
        self.assertEqual(adjusted, {"a": 0.003, "b": 0.02, "c": 0.04})

    def test_decision_inference_uses_training_replicates_not_game_rows(self) -> None:
        import numpy as np

        null_points = tuple(
            value
            for magnitude in (0.1, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02)
            for value in (magnitude, -magnitude)
        )
        null = np.asarray([[value] * 64 for value in null_points])
        summary = paired_replicate_sign_flip(null)
        self.assertAlmostEqual(summary["point"], 0.0)
        self.assertGreaterEqual(summary["oneSidedP"], 0.5)
        self.assertEqual(summary["enumerations"], 262144)

    def test_sign_flip_counts_identity_and_cancellation_ties_conservatively(self) -> None:
        import numpy as np

        from v35_p30_statistics import conservative_sign_flip_tolerance

        replicate_points = np.asarray([1e16, 1.0, -1e16, -1.0] + [0.0] * 14)
        values = np.repeat(replicate_points[:, None], 4, axis=1)
        point = float(replicate_points.mean())
        permuted = sign_flip_matrix() @ replicate_points / len(replicate_points)
        tolerance = conservative_sign_flip_tolerance(replicate_points)
        self.assertGreaterEqual(permuted[-1], point - tolerance)
        summary = paired_replicate_sign_flip(values)
        self.assertEqual(
            summary["extremeEnumerations"],
            int(np.count_nonzero(permuted >= point - tolerance)),
        )
        self.assertGreaterEqual(summary["oneSidedP"], 0.5)

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
        with self.assertRaisesRegex(ValueError, "exact fifty-four"):
            analyze_indexed(relabelled, self.reports, self.protocol)

    def test_control_stall_and_latency_regression_fail_closed(self) -> None:
        reports = copy.deepcopy(self.reports)
        reports[endpoint_label("a", CONTROL)]["stalls"] = 1
        reports[endpoint_label("b", "uniform-040")]["performance"]["gameWallMsP95"] = 70000
        result = analyze_indexed(self.indexed, reports, self.protocol)
        self.assertFalse(result["comparisons"]["uniform-040"]["gates"]["stalls"])
        self.assertFalse(result["comparisons"]["uniform-040"]["gates"]["latencyAbsolute"])
        self.assertFalse(result["comparisons"]["uniform-040"]["passed"])

    def test_malformed_episode_gate_comes_from_verified_receipts(self) -> None:
        reports = copy.deepcopy(self.reports)
        reports[endpoint_label("a", "uniform-040")]["_verifiedMalformedEpisodes"] = 1
        result = analyze_indexed(self.indexed, reports, self.protocol)
        self.assertFalse(result["comparisons"]["uniform-040"]["gates"]["malformedEpisodes"])
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
            "executionIdentity": {
                "experiment": self.protocol["experiment"],
                "replicate": "a",
                "arm": "control-zero",
                "configSha256": "c" * 64,
                "bindingSha256": "b" * 64,
                "root": "/fixture/root",
            },
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
            replicate="a",
            arm="control-zero",
            config_sha256="c" * 64,
            binding_sha256="b" * 64,
            root_identity="/fixture/root",
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
                    replicate="a",
                    arm="control-zero",
                    config_sha256="c" * 64,
                    binding_sha256="b" * 64,
                    root_identity="/fixture/root",
                )

    def test_load_inputs_verifies_complete_outcome_blind_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            keys = {}
            for signing_role in (
                "issuer",
                "executor",
                "guardian",
                "analysis-authorizer",
                "review-attester",
            ):
                private = root / f"{signing_role}-private.pem"
                public = root / f"{signing_role}-public.pem"
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
                keys[signing_role] = (private, public)
            private_key, public_key = keys["analysis-authorizer"]
            protocol_path = root / "protocol.json"
            review = root / "fable-review.md"
            review.write_text("VERDICT: ACCEPT\n")
            review_stderr = root / "fable-review.stderr"
            review_stderr.write_bytes(b"")
            review_receipt = root / "fable-review-receipt.json"
            plan_path = REPO / self.protocol["plan"]
            prompt = final_fable_review_prompt(plan_path)
            review_receipt.write_text(
                json.dumps(
                    {
                        "schemaVersion": FABLE_RECEIPT_SCHEMA,
                        "valid": True,
                        "model": "fable",
                        "effort": "high",
                        "tools": ["Read"],
                        "noSessionPersistence": True,
                        "argv": [
                            "claude",
                            "-p",
                            "--model",
                            "fable",
                            "--effort",
                            "high",
                            "--tools",
                            "Read",
                            "--no-session-persistence",
                            prompt,
                        ],
                        "cwd": str(REPO),
                        "plan": {
                            "path": self.protocol["plan"],
                            "sha256": sha256(plan_path),
                        },
                        "startedAtUtc": "2026-07-15T00:00:00Z",
                        "finishedAtUtc": "2026-07-15T00:00:01Z",
                        "exitCode": 0,
                        "stdoutPath": str(review),
                        "stdoutSha256": sha256(review),
                        "stderrPath": str(review_stderr),
                        "stderrSha256": sha256(review_stderr),
                    },
                    indent=2,
                )
                + "\n"
            )
            source_files = {
                label: {
                    "path": relative,
                    "sha256": sha256(REPO / relative),
                    "gitBlobOid": "f" * 40,
                }
                for label, relative in SOURCE_FILE_PATHS.items()
            }
            source_lock = root / "source-lock.json"
            source_lock.write_text(
                json.dumps(
                    {
                        "schemaVersion": "arc-v35-p30-source-lock-v1",
                        "authorized": True,
                        "immutable": True,
                        "promotionEligible": False,
                        "implementationBaseCommit": self.protocol["implementationBaseCommit"],
                        "implementationCommit": "a" * 40,
                        "gitContext": {
                            "schemaVersion": "arc-v35-p30-git-context-v1"
                        },
                        "files": source_files,
                    },
                    indent=2,
                )
                + "\n"
            )
            protocol = copy.deepcopy(self.protocol)
            protocol.update({"status": "authorized", "authorized": True})
            protocol["executionTrust"]["campaignInstanceId"] = "4" * 64
            protocol["executionTrust"]["ledgerRoot"] = str(root / "sealed-ledger")
            protocol["executionTrust"]["bubblewrapSha256"] = "3" * 64
            for signing_role, (_, public) in keys.items():
                key_id, public_der_sha256 = public_key_identity(public)
                protocol["executionTrust"]["roles"][signing_role].update(
                    {
                        "publicKeyPath": str(public),
                        "publicKeyPemSha256": sha256_file(public),
                        "publicKeyDerSha256": public_der_sha256,
                        "keyId": key_id,
                    }
                )
            protocol["review"].update(
                {
                    "artifact": str(review),
                    "sha256": sha256(review),
                    "verdict": "ACCEPT",
                    "commandReceipt": {
                        "path": str(review_receipt),
                        "sha256": sha256(review_receipt),
                    },
                }
            )
            protocol["sourceContract"].update(
                {"artifact": str(source_lock), "sha256": sha256(source_lock)}
            )
            initial_checkpoint = root / "initial.pt"
            initial_checkpoint.write_bytes(b"initial-policy")
            initial_manifest = root / "initial.manifest.json"
            policy_manifest = {
                "format": "arc-entity-scorer-v2",
                "obs_version": 2,
                "obs_flat_len": 3419,
                "act_dim": 104,
                "d_model": 128,
                "layers": 3,
                "heads": 4,
                "params": 1,
                "reach30_horizons": [20, 25, 30],
                "reach30_trained": True,
            }
            initial_manifest.write_text(json.dumps(policy_manifest, indent=2) + "\n")
            protocol["initialPolicy"].update(
                {
                    "path": str(initial_checkpoint),
                    "manifestPath": str(initial_manifest),
                    "sha256": sha256(initial_checkpoint),
                    "manifestSha256": sha256(initial_manifest),
                }
            )
            protocol["seedSchedule"]["commonPublicBase"] = 1000
            protocol["seedSchedule"]["commonPublicGames"] = 10
            protocol["analysis"]["commonPublicGames"] = 10
            protocol_path.write_text(json.dumps(protocol, indent=2) + "\n")
            protocol_hash = sha256(protocol_path)
            source_commit = "a" * 40
            base_config = json.loads(
                (REPO / "ml/league/configs/fair-v35-late-credit-base.json").read_text()
            )

            def write_receipt(
                *,
                receipt_path: Path,
                role: str,
                label: str,
                replicate: str,
                arm: str,
                checkpoint: Path,
                weights_hash: str,
                report_path: Path,
                stdout: Path,
                stderr: Path,
                exit_code: Path,
                server_log: Path,
                socket: str,
                config_sha256: str,
                binding_sha256: str,
                root_identity: str,
            ) -> None:
                argv = [
                    "/usr/bin/node",
                    "scripts/evaluate-solo-checkpoint.mjs",
                    "--weights",
                    str(checkpoint.resolve()),
                    "--infer-socket",
                    socket,
                    "--policy-obs-version",
                    "2",
                    "--catalog",
                    str((REPO / protocol["catalog"]["path"]).resolve()),
                    "--source-commit",
                    source_commit,
                    "--experiment",
                    protocol["experiment"],
                    "--replicate",
                    replicate,
                    "--arm",
                    arm,
                    "--config-sha256",
                    config_sha256,
                    "--binding-sha256",
                    binding_sha256,
                    "--root-identity",
                    root_identity,
                    "--games",
                    "10",
                    "--workers",
                    "24",
                    "--seed0",
                    "1000",
                    "--max-rounds",
                    "30",
                    "--max-status-level",
                    "2",
                    "--sample",
                    "--temperature",
                    "0.55",
                    "--include-games",
                    "--include-replay-hashes",
                    "--quiet",
                    "--out",
                    str(report_path.resolve()),
                ]
                receipt_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": EVALUATION_RECEIPT_SCHEMA,
                            "valid": True,
                            "attemptId": f"{label}:{role}:attempt-{'1' if role == 'primary' else '2'}",
                            "role": role,
                            "label": label,
                            "replicate": replicate,
                            "arm": arm,
                            "malformedEpisodes": 0,
                            "startedAtUtc": "2026-07-15T00:00:00Z",
                            "finishedAtUtc": "2026-07-15T00:00:01Z",
                            "execution": {
                                "cwd": str(REPO),
                                "argv": argv,
                                "env": {"CUDA_VISIBLE_DEVICES": ""},
                                "inferenceSocket": socket,
                            },
                            "contract": {
                                "sourceCommit": source_commit,
                                "catalogSha256": protocol["catalog"]["sha256"],
                                "checkpointSha256": weights_hash,
                                "seed0": 1000,
                                "games": 10,
                                "maxRounds": 30,
                                "maxStatusLevel": 2,
                                "workers": 24,
                                "policyObsVersion": 2,
                                "sample": True,
                                "temperature": 0.55,
                                "includeGames": True,
                                "includeReplayHashes": True,
                                "configSha256": config_sha256,
                                "bindingSha256": binding_sha256,
                                "root": root_identity,
                            },
                            "artifacts": {
                                name: {"path": str(path.resolve()), "sha256": digest}
                                for name, path, digest in (
                                    ("checkpoint", checkpoint, weights_hash),
                                    ("report", report_path, sha256(report_path)),
                                    ("stdout", stdout, sha256(stdout)),
                                    ("stderr", stderr, sha256(stderr)),
                                    ("exitCode", exit_code, sha256(exit_code)),
                                    ("serverLog", server_log, sha256(server_log)),
                                )
                            },
                        },
                        indent=2,
                    )
                    + "\n"
                )

            report_entries = []
            for replicate in REPLICATES:
                replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
                for arm in ARMS:
                    label = endpoint_label(replicate, arm)
                    endpoint = root / label
                    endpoint.mkdir()
                    (endpoint / "checkpoints").mkdir()
                    (endpoint / "artifacts").mkdir()
                    checkpoint = endpoint / "checkpoints" / "main-0-gen8.pt"
                    checkpoint.write_bytes(label.encode())
                    checkpoint_manifest = endpoint / "checkpoints" / "main-0-gen8.manifest.json"
                    checkpoint_manifest.write_text(json.dumps(policy_manifest, indent=2) + "\n")
                    config = endpoint / "config.json"
                    config_value = copy.deepcopy(base_config)
                    config_value.update(
                        {
                            "seedBase": replicate_contract["trainBase"],
                            "seedSchedule": {
                                "trainBase": replicate_contract["trainBase"],
                                "trainStride": protocol["seedSchedule"]["trainStride"],
                                "evalBase": replicate_contract["evalBase"],
                                "evalStride": protocol["seedSchedule"]["evalStride"],
                                "maxGeneration": protocol["seedSchedule"]["maxGeneration"],
                            },
                            "initFrom": protocol["initialPolicy"]["path"],
                            "laneInit": {"main-0": protocol["initialPolicy"]["path"]},
                            "paths": {
                                "root": (
                                    "ml/experiments/v35-weco-recursive-autoresearch/"
                                    f"p30-long-horizon/league/rep-{replicate}/{arm}"
                                )
                            },
                        }
                    )
                    extra = config_value["train"]["extraArgs"]
                    scalar_at = extra.index("--solo-reach30-coef")
                    arm_contract = next(item for item in protocol["arms"] if item["id"] == arm)
                    extra[scalar_at + 1] = f"{float(arm_contract['soloReach30Coef']):g}"
                    if arm_contract["soloReach30Bands"] is not None:
                        extra.extend(
                            [
                                "--solo-reach30-bands",
                                ",".join(
                                    f"{upper}:{coefficient}"
                                    for upper, coefficient in arm_contract["soloReach30Bands"]
                                ),
                            ]
                        )
                    config.write_text(json.dumps(config_value, indent=2) + "\n")
                    binding = endpoint / "binding.json"
                    binding.write_text(
                        json.dumps(
                            {
                                "schemaVersion": "arc-v35-root-binding-v1",
                                "experiment": protocol["experiment"],
                                "replicate": replicate,
                                "arm": arm,
                                "protocolPath": str(protocol_path),
                                "protocolSha256": protocol_hash,
                                "configSha256": sha256(config),
                                "catalogSha256": protocol["catalog"]["sha256"],
                                "initialPolicySha256": protocol["initialPolicy"]["sha256"],
                                "promotionEligible": False,
                            },
                            indent=2,
                        )
                        + "\n"
                    )
                    weights_hash = sha256(checkpoint)
                    report, _, _, _ = self._synthetic_report()
                    catalog = json.loads((REPO / protocol["catalog"]["path"]).read_text())
                    catalog_guardians = [guardian["name"] for guardian in catalog["guardians"]]
                    for game in report["perGame"]:
                        game["guardian"] = catalog_guardians[game["seed"] % len(catalog_guardians)]
                    report["sourceCommit"] = source_commit
                    report["weightsSha256"] = weights_hash
                    report["inference"]["weightsSha256"] = weights_hash
                    report["inference"]["weightsPath"] = str(checkpoint)
                    config_hash = sha256(config)
                    binding_hash = sha256(binding)
                    root_identity = str(endpoint.resolve())
                    report["executionIdentity"] = {
                        "experiment": protocol["experiment"],
                        "replicate": replicate,
                        "arm": arm,
                        "configSha256": config_hash,
                        "bindingSha256": binding_hash,
                        "root": root_identity,
                    }
                    primary_socket = str(endpoint / "primary.sock")
                    report["decode"]["inferenceSocket"] = primary_socket
                    report_path = endpoint / "report.json"
                    report_path.write_text(json.dumps(report, indent=2) + "\n")
                    audit = endpoint / "artifacts" / "gen8-audit.json"
                    generation_offset = protocol["seedSchedule"]["maxGeneration"] - 1
                    train_min = replicate_contract["trainBase"] + generation_offset * protocol["seedSchedule"]["trainStride"]
                    eval_min = replicate_contract["evalBase"] + generation_offset * protocol["seedSchedule"]["evalStride"]
                    audit_chain = []
                    previous_audit_hash = None
                    for prior_generation in range(1, 8):
                        prior_path = endpoint / "artifacts" / f"gen{prior_generation}-audit.json"
                        prior_checkpoint_hash = f"{prior_generation:064x}"
                        prior_value = {
                            "schemaVersion": "arc-v35-generation-audit-v1",
                            "valid": True,
                            "generation": prior_generation,
                            "root": root_identity,
                            "protocolSha256": protocol_hash,
                            "sourceCommit": source_commit,
                            "sourceContractSha256": sha256(source_lock),
                            "checkpointSha256": prior_checkpoint_hash,
                            "previousAuditSha256": previous_audit_hash,
                            "auditChain": copy.deepcopy(audit_chain),
                        }
                        prior_path.write_text(json.dumps(prior_value, indent=2) + "\n")
                        previous_audit_hash = sha256(prior_path)
                        audit_chain.append(
                            {
                                "generation": prior_generation,
                                "path": str(prior_path),
                                "sha256": previous_audit_hash,
                                "checkpointSha256": prior_checkpoint_hash,
                            }
                        )
                    scheduled_bands = arm_contract["soloReach30Bands"]
                    treatment_enabled = arm_contract["soloReach30Coef"] > 0 or bool(scheduled_bands)
                    audit.write_text(
                        json.dumps(
                            {
                                "schemaVersion": "arc-v35-generation-audit-v1",
                                "valid": True,
                                "generation": 8,
                                "root": root_identity,
                                "replicate": replicate,
                                "arm": arm,
                                "checkpointSha256": weights_hash,
                                "manifestSha256": sha256(checkpoint_manifest),
                                "protocolSha256": protocol_hash,
                                "configSha256": config_hash,
                                "bindingSha256": binding_hash,
                                "catalogSha256": protocol["catalog"]["sha256"],
                                "sourceCommit": source_commit,
                                "sourceContractSha256": sha256(source_lock),
                                "environmentSha256": "e" * 64,
                                "authorizationTokenId": "a" * 64,
                                "previousAuditSha256": previous_audit_hash,
                                "auditChain": audit_chain,
                                "promotionEligible": False,
                                "trustedCoreAuditSchema": "arc-v32-generation-audit-v1",
                                "games": 1024,
                                "stalls": 0,
                                "evaluationStalls": 0,
                                "malformedEpisodes": 0,
                                "malformedRows": 0,
                                "trainingSeeds": {"min": train_min, "max": train_min + 1023, "count": 1024},
                                "evaluationSeeds": {"min": eval_min, "max": eval_min + 255, "count": 256},
                                "rows": 100,
                                "policyRows": 90,
                                "behaviorLogpMaxAbsError": 0.0001,
                                "behaviorReach30Calibration": {
                                    "ece": 0.05,
                                    "brier": 0.1,
                                    "constant_brier": 0.2,
                                    "rows": 100.0,
                                },
                                "epochMetrics": [
                                    {
                                        "epoch": epoch,
                                        "approxKl": 0.01,
                                        "clipFraction": 0.1,
                                        "roundWeightedKl": 0.01,
                                        "roundWeightedClipFraction": 0.1,
                                        "optimizerSteps": 196,
                                    }
                                    for epoch in (1, 2)
                                ],
                                "soloReach30Bands": scheduled_bands,
                                "soloReach30Credit": {
                                    "soloReach30Coef": arm_contract["soloReach30Coef"],
                                    "reach30Horizon": "30",
                                    "soloReach30Applied": 10 if treatment_enabled else 0,
                                },
                                "rawGenerationCommitment": {"sha256": "c" * 64, "files": 2, "bytes": 10},
                            },
                            indent=2,
                        )
                        + "\n"
                    )
                    exit_code = endpoint / "exit-code"
                    exit_code.write_text("0\n")
                    stdout = endpoint / "evaluator.stdout"
                    stdout.write_bytes(b"")
                    stderr = endpoint / "evaluator.stderr"
                    stderr.write_bytes(b"")
                    server_log = endpoint / "server.log"
                    server_log.write_text("ready\n")
                    replay_report = endpoint / "replay-report.json"
                    replay_value = copy.deepcopy(report)
                    replay_socket = str(endpoint / "replay.sock")
                    replay_value["decode"]["inferenceSocket"] = replay_socket
                    replay_report.write_text(json.dumps(replay_value, indent=2) + "\n")
                    replay_exit_code = endpoint / "replay-exit-code"
                    replay_exit_code.write_text("0\n")
                    replay_stdout = endpoint / "replay-evaluator.stdout"
                    replay_stdout.write_bytes(b"")
                    replay_stderr = endpoint / "replay-evaluator.stderr"
                    replay_stderr.write_bytes(b"")
                    replay_server_log = endpoint / "replay-server.log"
                    replay_server_log.write_text("ready\n")
                    primary_receipt = endpoint / "primary-receipt.json"
                    write_receipt(
                        receipt_path=primary_receipt,
                        role="primary",
                        label=label,
                        replicate=replicate,
                        arm=arm,
                        checkpoint=checkpoint,
                        weights_hash=weights_hash,
                        report_path=report_path,
                        stdout=stdout,
                        stderr=stderr,
                        exit_code=exit_code,
                        server_log=server_log,
                        socket=primary_socket,
                        config_sha256=config_hash,
                        binding_sha256=binding_hash,
                        root_identity=root_identity,
                    )
                    replay_receipt = endpoint / "replay-receipt.json"
                    write_receipt(
                        receipt_path=replay_receipt,
                        role="replay",
                        label=label,
                        replicate=replicate,
                        arm=arm,
                        checkpoint=checkpoint,
                        weights_hash=weights_hash,
                        report_path=replay_report,
                        stdout=replay_stdout,
                        stderr=replay_stderr,
                        exit_code=replay_exit_code,
                        server_log=replay_server_log,
                        socket=replay_socket,
                        config_sha256=config_hash,
                        binding_sha256=binding_hash,
                        root_identity=root_identity,
                    )
                    primary_execution_receipt = endpoint / "primary-execution-receipt.json"
                    primary_execution_receipt.write_text(f"{label}:primary-signed\n")
                    replay_execution_receipt = endpoint / "replay-execution-receipt.json"
                    replay_execution_receipt.write_text(f"{label}:replay-signed\n")
                    pair_integrity = endpoint / "pair-integrity.json"
                    pair_integrity.write_text(f"{label}:pair-signed\n")
                    generation_execution_receipt = endpoint / "generation-execution-receipt.json"
                    generation_execution_receipt.write_text(f"{label}:generation-signed\n")
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
                            "generationExecutionReceiptPath": str(generation_execution_receipt),
                            "generationExecutionReceiptSha256": sha256(generation_execution_receipt),
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
                            "primaryReceiptPath": str(primary_receipt),
                            "primaryReceiptSha256": sha256(primary_receipt),
                            "primaryExecutionReceiptPath": str(primary_execution_receipt),
                            "primaryExecutionReceiptSha256": sha256(primary_execution_receipt),
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
                            "replayReceiptPath": str(replay_receipt),
                            "replayReceiptSha256": sha256(replay_receipt),
                            "replayExecutionReceiptPath": str(replay_execution_receipt),
                            "replayExecutionReceiptSha256": sha256(replay_execution_receipt),
                            "pairIntegrityPath": str(pair_integrity),
                            "pairIntegritySha256": sha256(pair_integrity),
                        }
                    )
            manifest_path = root / "input-manifest.json"
            manifest = {
                "schemaVersion": "arc-v35-p30-analysis-manifest-v1",
                "valid": True,
                "immutable": True,
                "promotionEligible": False,
                "outcomesInspected": False,
                "metricsIncluded": False,
                "issuedAtUtc": "2026-07-15T00:00:00Z",
                "campaignInstanceId": protocol["executionTrust"]["campaignInstanceId"],
                "protocol": {"path": str(protocol_path.resolve()), "sha256": protocol_hash},
                "sourceContract": {
                    "path": str(source_lock.resolve()),
                    "sha256": sha256(source_lock),
                },
                "finalGenerationBarrier": {
                    "path": str((root / "final-generation-barrier.json").resolve()),
                    "sha256": "f" * 64,
                },
                "receiptMerkleRoot": manifest_receipt_merkle_root(report_entries),
                "counts": {
                    "endpoints": 54,
                    "generationReceipts": 432,
                    "evaluationReceipts": 108,
                    "pairIntegrityReceipts": 54,
                    "signedReceipts": 595,
                    "uniqueExecutionTokens": 540,
                },
                "signedReceiptInventory": [],
                "reports": report_entries,
                "request": {},
            }

            def write_signed_manifest(destination: Path, payload: dict) -> None:
                value = copy.deepcopy(payload)
                descriptor = os.open(keys["guardian"][0], os.O_RDONLY)
                try:
                    value["signature"] = sign_payload(
                        value,
                        role="guardian",
                        private_key_fd=descriptor,
                        public_key_path=keys["guardian"][1],
                    )
                finally:
                    os.close(descriptor)
                destination.write_bytes(canonical_json(value) + b"\n")

            write_signed_manifest(manifest_path, manifest)

            def write_analysis_authorization(
                bound_manifest_path: Path, destination: Path, token: str
            ) -> None:
                executable = REPO / "ml/.venv/bin/python"
                analysis_out = root / f"{destination.stem}.analysis.json"
                ledger = root / "ledger"
                ledger.mkdir(exist_ok=True)
                sealed_ledger = (
                    Path(protocol["executionTrust"]["ledgerRoot"])
                    / protocol["executionTrust"]["campaignInstanceId"]
                )
                draft_path = sealed_ledger / "analysis/analysis-authorization.unsigned.json"
                review_path = (
                    sealed_ledger
                    / "analysis/review/fable-analysis-authorization.receipt.json"
                )
                review_draft_receipt_path = (
                    sealed_ledger
                    / "analysis/review/fable-analysis-authorization.receipt.unsigned.json"
                )
                draft_path.parent.mkdir(parents=True, exist_ok=True)
                review_path.parent.mkdir(parents=True, exist_ok=True)
                review_draft_receipt_path.write_text(
                    json.dumps(
                        {
                            "startedAtUtc": "2026-07-15T00:00:02Z",
                            "finishedAtUtc": "2026-07-15T00:00:03Z",
                            "stdoutPath": str(root / "analysis-review.stdout"),
                            "stderrPath": str(root / "analysis-review.stderr"),
                            "request": {},
                        }
                    )
                    + "\n"
                )
                authorization = {
                    "schemaVersion": AUTHORIZATION_SCHEMA,
                    "authorized": True,
                    "immutable": True,
                    "promotionEligible": False,
                    "kind": "analysis",
                    "tokenId": token,
                    "campaignId": protocol["experiment"],
                    "issuedAtUtc": "2026-07-15T00:00:00Z",
                    "notBeforeUtc": "2026-07-15T00:00:00Z",
                    "expiresAtUtc": "2026-07-16T00:00:00Z",
                    "protocol": {"path": str(protocol_path.resolve()), "sha256": protocol_hash},
                    "sourceContract": {
                        "path": str(source_lock.resolve()),
                        "sha256": sha256(source_lock),
                    },
                    "subject": {
                        "inputManifestPath": str(bound_manifest_path.resolve()),
                        "inputManifestSha256": sha256(bound_manifest_path),
                        "receiptMerkleRoot": json.loads(bound_manifest_path.read_text())["receiptMerkleRoot"],
                        "sourceCommit": source_commit,
                        "sourceContractSha256": sha256(source_lock),
                        "outcomesInspected": False,
                        "privateEvaluationAuthorized": False,
                        "counts": json.loads(bound_manifest_path.read_text())["counts"],
                        "authorizationDraftPath": str(draft_path),
                        "reviewReceiptPath": str(review_path),
                    },
                    "command": {
                        "argv": [
                            str(executable),
                            "ml/analyze_v35_p30_long_horizon.py",
                            "--protocol",
                            str(protocol_path.resolve()),
                            "--manifest",
                            str(bound_manifest_path.resolve()),
                            "--authorization",
                            str(destination.resolve()),
                            "--out",
                            str(analysis_out.resolve()),
                            "--quiet",
                        ],
                        "cwd": str(REPO),
                        "env": {
                            "HOME": "/tmp",
                            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                            "PYTHONHASHSEED": "0",
                            "PYTHONPATH": "ml",
                        },
                        "executableSha256": executable_sha256(executable),
                    },
                    "isolation": {},
                    "outputs": {
                        "analysis": {"path": str(analysis_out.resolve()), "required": True, "mustBeAbsentAtStart": True},
                        "exitCode": {"path": str(root / f"{token}.exit"), "required": True, "mustBeAbsentAtStart": True},
                        "stderr": {"path": str(root / f"{token}.stderr"), "required": True, "mustBeAbsentAtStart": True},
                        "stdout": {"path": str(root / f"{token}.stdout"), "required": True, "mustBeAbsentAtStart": True},
                    },
                    "ledger": {
                        "root": str(ledger),
                        "consumedPath": str(ledger / f"{token}.consumed.json"),
                        "receiptPath": str(ledger / f"{token}.receipt.json"),
                        "leasePath": str(root / "gpu7.lease"),
                    },
                    "predecessor": {
                        "receiptPath": str(bound_manifest_path.resolve()),
                        "sha256": sha256(bound_manifest_path),
                    },
                    "request": {},
                }
                draft_path.write_bytes(canonical_json(authorization) + b"\n")
                authorization["issuedAtUtc"] = "2026-07-15T00:00:04Z"
                authorization["notBeforeUtc"] = "2026-07-15T00:00:04Z"
                authorization["expiresAtUtc"] = "2026-07-16T00:00:04Z"
                descriptor = os.open(private_key, os.O_RDONLY)
                try:
                    authorization["signature"] = sign_payload(
                        authorization,
                        role="analysis-authorizer",
                        private_key_fd=descriptor,
                        public_key_path=public_key,
                    )
                finally:
                    os.close(descriptor)
                destination.write_bytes(canonical_json(authorization) + b"\n")
                consumed = {
                    "schemaVersion": "arc-v35-p30-consumed-token-v1",
                    "tokenId": token,
                    "authorizationPath": str(destination.resolve()),
                    "authorizationSha256": sha256(destination),
                    "consumedAtUtc": "2026-07-15T00:00:05Z",
                    "consumerPid": 1,
                    "host": "test",
                    "bootId": "test",
                }
                Path(authorization["ledger"]["consumedPath"]).write_text(
                    json.dumps(consumed) + "\n"
                )

            authorization_path = root / "analysis-authorization.json"
            write_analysis_authorization(manifest_path, authorization_path, "d" * 64)
            def fake_signed_execution(**kwargs):
                if kwargs["role"] == "replay":
                    primary_path = kwargs["receipt_path"].parent / "primary-execution-receipt.json"
                    return {
                        "predecessor": {
                            "receiptPath": str(primary_path.resolve()),
                            "sha256": sha256(primary_path),
                        }
                    }
                return {"predecessor": None}

            with (
                mock.patch(
                    "ml.analyze_v35_p30_long_horizon.validate_analysis_launch_boundary",
                    return_value=(json.loads(protocol_path.read_text()), {}),
                ),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_protocol"),
                mock.patch("ml.analyze_v35_p30_long_horizon.verify_git_context"),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_role_request_binding"),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_signed_receipt_inventory"),
                mock.patch(
                    "v35_p30_analysis_review.validate_analysis_review_receipt",
                    return_value={
                        "startedAtUtc": "2026-07-15T00:00:02Z",
                        "finishedAtUtc": "2026-07-15T00:00:03Z",
                        "stdoutPath": str(root / "analysis-review.stdout"),
                        "stderrPath": str(root / "analysis-review.stderr"),
                        "request": {},
                    },
                ),
                mock.patch(
                    "v35_p30_authorized_execution.validate_authorization",
                    side_effect=lambda signed, **_kwargs: {
                        key: value for key, value in signed.items() if key != "signature"
                    },
                ),
                mock.patch(
                    "issue_v35_p30_analysis_bundle.build_analysis_authorization_payload",
                    side_effect=lambda **kwargs: {
                        key: value
                        for key, value in json.loads(authorization_path.read_text()).items()
                        if key != "signature"
                    },
                ),
                mock.patch(
                    "ml.analyze_v35_p30_long_horizon.validate_authorized_evaluation_execution",
                    side_effect=fake_signed_execution,
                ),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_pair_integrity_receipt"),
                mock.patch(
                    "ml.analyze_v35_p30_long_horizon.validate_generation_execution_receipt_chain"
                ),
            ):
                loaded_protocol, indexed, reports = load_inputs(
                    protocol_path, manifest_path, authorization_path
                )
            self.assertEqual(loaded_protocol["status"], "authorized")
            self.assertEqual(len(indexed), 54)
            self.assertEqual(len(reports), 54)

            duplicate_manifest = json.loads(manifest_path.read_text())
            first = duplicate_manifest["reports"][0]
            first["replayReceiptPath"] = first["primaryReceiptPath"]
            first["replayReceiptSha256"] = first["primaryReceiptSha256"]
            duplicate_manifest["receiptMerkleRoot"] = manifest_receipt_merkle_root(
                duplicate_manifest["reports"]
            )
            duplicate_manifest_path = root / "duplicate-receipt-manifest.json"
            duplicate_manifest.pop("signature", None)
            write_signed_manifest(duplicate_manifest_path, duplicate_manifest)
            duplicate_authorization_path = root / "duplicate-receipt-authorization.json"
            write_analysis_authorization(
                duplicate_manifest_path, duplicate_authorization_path, "e" * 64
            )
            with (
                mock.patch(
                    "ml.analyze_v35_p30_long_horizon.validate_analysis_launch_boundary",
                    return_value=(json.loads(protocol_path.read_text()), {}),
                ),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_protocol"),
                mock.patch("ml.analyze_v35_p30_long_horizon.verify_git_context"),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_role_request_binding"),
                mock.patch("ml.analyze_v35_p30_long_horizon.validate_signed_receipt_inventory"),
                mock.patch(
                    "v35_p30_analysis_review.validate_analysis_review_receipt",
                    return_value={
                        "startedAtUtc": "2026-07-15T00:00:02Z",
                        "finishedAtUtc": "2026-07-15T00:00:03Z",
                        "stdoutPath": str(root / "analysis-review.stdout"),
                        "stderrPath": str(root / "analysis-review.stderr"),
                        "request": {},
                    },
                ),
                mock.patch(
                    "v35_p30_authorized_execution.validate_authorization",
                    side_effect=lambda signed, **_kwargs: {
                        key: value for key, value in signed.items() if key != "signature"
                    },
                ),
                mock.patch(
                    "issue_v35_p30_analysis_bundle.build_analysis_authorization_payload",
                    side_effect=lambda **kwargs: {
                        key: value
                        for key, value in json.loads(
                            duplicate_authorization_path.read_text()
                        ).items()
                        if key != "signature"
                    },
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError, "identity-bearing artifact hash is reused|distinct artifact paths"
                ):
                    load_inputs(
                        protocol_path,
                        duplicate_manifest_path,
                        duplicate_authorization_path,
                    )

            first_original = report_entries[0]
            first_config_path = Path(first_original["configPath"])
            first_binding_path = Path(first_original["bindingPath"])
            relabelled_config = json.loads(first_config_path.read_text())
            extra = relabelled_config["train"]["extraArgs"]
            extra[extra.index("--solo-reach30-coef") + 1] = "999"
            first_config_path.write_text(json.dumps(relabelled_config, indent=2) + "\n")
            relabelled_binding = json.loads(first_binding_path.read_text())
            relabelled_binding["configSha256"] = sha256(first_config_path)
            first_binding_path.write_text(json.dumps(relabelled_binding, indent=2) + "\n")
            with self.assertRaisesRegex(ValueError, "exact frozen materialization"):
                validate_root_materialization(
                    config_path=first_config_path,
                    binding_path=first_binding_path,
                    protocol=protocol,
                    protocol_path=protocol_path,
                    replicate=first_original["replicate"],
                    arm=first_original["arm"],
                )

            wrong_model_receipt = json.loads(review_receipt.read_text())
            wrong_model_receipt["model"] = "opus"
            review_receipt.write_text(json.dumps(wrong_model_receipt, indent=2) + "\n")
            wrong_model_protocol = copy.deepcopy(protocol)
            wrong_model_protocol["review"]["commandReceipt"]["sha256"] = sha256(
                review_receipt
            )
            with self.assertRaisesRegex(ValueError, "mandatory high-effort review"):
                validate_fable_receipt(
                    wrong_model_protocol,
                    protocol_path=protocol_path,
                    review_path=review,
                )


if __name__ == "__main__":
    unittest.main()
