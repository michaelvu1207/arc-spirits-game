from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from analyze_v32_development import (
    REPORT_LABELS,
    REPLICATES,
    TREATMENTS,
    analyze_development,
    bootstrap_family,
    endpoint_label,
    sha256,
    validate_authorization,
    validate_freeze,
)


CATALOG_SHA = "c" * 64
SOURCE_SHA = "d" * 64


def make_report(label: str, seed0: int, games: int, wins: set[int], *, vp_bonus: float = 0) -> dict:
    obs = 1 if label == "v23" else 2
    rows = []
    guardians = ("A", "B")
    for index in range(games):
        win = index in wins
        rows.append(
            {
                "seed": seed0 + index,
                "guardian": guardians[index % len(guardians)],
                "trueWin": win,
                "stalled": False,
                "finalVP": (30 if win else 20) + vp_bonus,
                "first30Round": 25 if win else None,
                "post15VpPerRound": 1.0 + vp_bonus / 100,
            }
        )
    count = len(wins)
    return {
        "schemaVersion": "solo-heldout-v2",
        "sourceCommit": SOURCE_SHA,
        "catalogSha256": CATALOG_SHA,
        "weightsSha256": (f"{REPORT_LABELS.index(label) + 1:064x}"),
        "seed0": seed0,
        "games": games,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "decode": {
            "policyObsVersion": obs,
            **({"inferenceSocket": f"/dev/shm/{label}.sock"} if obs == 2 else {}),
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": 0.55,
        },
        "trueWins": count,
        "trueWinRate": count / games,
        "stalls": 0,
        "stallRate": 0,
        "perGame": rows,
    }


def fixture(games: int = 100) -> tuple[dict, dict, dict, dict]:
    seed0 = 949000000
    v23_wins = set(range(50))
    reports = {label: make_report(label, seed0, games, v23_wins) for label in REPORT_LABELS}
    for replicate in REPLICATES:
        reports[endpoint_label(replicate, "control-uniform")] = make_report(
            endpoint_label(replicate, "control-uniform"), seed0, games, set(range(50))
        )
        reports[endpoint_label(replicate, "round-reweighted")] = make_report(
            endpoint_label(replicate, "round-reweighted"), seed0, games, set(range(70)), vp_bonus=2
        )
        reports[endpoint_label(replicate, "p30-credit025")] = make_report(
            endpoint_label(replicate, "p30-credit025"), seed0, games, set(range(70)), vp_bonus=2
        )
    weights = {label: report["weightsSha256"] for label, report in reports.items()}
    obs = {label: (1 if label == "v23" else 2) for label in REPORT_LABELS}
    representatives = {
        treatment: {"selectedReplicate": "a"} for treatment in TREATMENTS
    }
    return reports, weights, obs, representatives


def run_analysis(reports: dict, weights: dict, obs: dict, representatives: dict) -> dict:
    return analyze_development(
        reports,
        seed0=949000000,
        games=100,
        catalog_sha256=CATALOG_SHA,
        source_contract_sha256=SOURCE_SHA,
        expected_weights=weights,
        expected_obs_versions=obs,
        representatives=representatives,
        frozen_integrity=True,
        bootstrap_samples=500,
        bootstrap_seed=320949,
    )


class AnalyzeV32DevelopmentTest(unittest.TestCase):
    def test_real_freezer_schema_is_accepted(self) -> None:
        policies = {
            label: {
                "weightsSha256": f"{index + 1:064x}",
                "policyObsVersion": 1 if label == "v23" else 2,
            }
            for index, label in enumerate(REPORT_LABELS)
        }
        roots = {
            label: {
                "history": {"rows": 8},
                "generationAudits": [{} for _ in range(8)],
                "endpoint": {
                    "checkpoint": {"sha256": policies[label]["weightsSha256"]},
                    "manifest": {"sha256": "e" * 64},
                },
            }
            for label in REPORT_LABELS
            if label.startswith("rep-")
        }
        representatives = {
            treatment: {
                "selectedReplicate": "a",
                "treatmentPolicyLabel": endpoint_label("a", treatment),
                "controlPolicyLabel": endpoint_label("a", "control-uniform"),
                "checkpointSha256": policies[endpoint_label("a", treatment)]["weightsSha256"],
                "matchedControlSha256": policies[endpoint_label("a", "control-uniform")]["weightsSha256"],
            }
            for treatment in TREATMENTS
        }
        manipulation_sha = "f" * 64
        freeze = {
            "schemaVersion": "arc-v32-development-freeze-v1",
            "valid": True,
            "immutable": True,
            "outcomeBlindEndpointSelection": True,
            "screenLock": {"verified": True},
            "endpointGeneration": 8,
            "manipulation": {
                "gen8": {"path": "gen8.json", "sha256": manipulation_sha, "passed": True},
                "selected": {"path": "gen8.json", "sha256": manipulation_sha},
            },
            "policies": policies,
            "roots": roots,
            "representatives": representatives,
        }
        self.assertEqual(validate_freeze(freeze), (policies, representatives))

        freeze_sha = "a" * 64
        source_sha = "b" * 64
        authorization = {
            "schemaVersion": "arc-v32-development-authorization-v1",
            "valid": True,
            "immutable": True,
            "freeze": {"sha256": freeze_sha},
            "sourceContractSha256": source_sha,
            "authorization": {
                "developmentSeedsOpen": True,
                "hiddenSeedsOpen": False,
                "authorizedSeedMin": 949000000,
                "authorizedSeedMax": 949004095,
                "sourceContractSha256": source_sha,
            },
        }
        validate_authorization(
            authorization,
            freeze_sha256=freeze_sha,
            source_contract_sha256=source_sha,
        )

    def test_equal_replicate_analysis_and_tie_rule_choose_round(self) -> None:
        reports, weights, obs, representatives = fixture()
        result = run_analysis(reports, weights, obs, representatives)
        self.assertEqual(result["winner"], "round-reweighted")
        self.assertTrue(result["bindingLatencyMayRun"])
        self.assertFalse(result["hiddenSeedsMayOpen"])
        self.assertEqual(result["bootstrap"]["families"]["treatmentVsMatchedControl"]["familySize"], 2)
        self.assertEqual(result["bootstrap"]["families"]["treatmentVsV23"]["intervalConfidence"], 0.975)
        self.assertAlmostEqual(
            result["mechanisms"]["round-reweighted"]["aggregate"]["causalVsMatchedControls"]["winRateDelta"],
            0.20,
        )

    def test_replicates_are_weighted_equally_not_pooled(self) -> None:
        reports, weights, obs, representatives = fixture()
        reports[endpoint_label("a", "round-reweighted")] = make_report(
            endpoint_label("a", "round-reweighted"), 949000000, 100, set(range(80)), vp_bonus=2
        )
        reports[endpoint_label("b", "round-reweighted")] = make_report(
            endpoint_label("b", "round-reweighted"), 949000000, 100, set(range(60)), vp_bonus=2
        )
        weights[endpoint_label("a", "round-reweighted")] = reports[endpoint_label("a", "round-reweighted")]["weightsSha256"]
        weights[endpoint_label("b", "round-reweighted")] = reports[endpoint_label("b", "round-reweighted")]["weightsSha256"]
        result = run_analysis(reports, weights, obs, representatives)
        effects = result["mechanisms"]["round-reweighted"]["aggregate"]["replicateCausalWinRateDeltas"]
        self.assertEqual(effects, {"a": 0.3, "b": 0.1, "c": 0.2})
        self.assertAlmostEqual(
            result["mechanisms"]["round-reweighted"]["aggregate"]["causalVsMatchedControls"]["winRateDelta"], 0.2
        )

    def test_guardian_regression_requires_followup_and_blocks_winner(self) -> None:
        reports, weights, obs, representatives = fixture()
        for label in (
            endpoint_label("a", "round-reweighted"),
            endpoint_label("b", "round-reweighted"),
            endpoint_label("c", "round-reweighted"),
        ):
            # Preserve the strong overall result, but move wins away from guardian A.
            wins = {index for index in range(100) if index % 2 == 1 or index < 40}
            reports[label] = make_report(label, 949000000, 100, wins, vp_bonus=2)
            weights[label] = reports[label]["weightsSha256"]
        result = run_analysis(reports, weights, obs, representatives)
        mechanism = result["mechanisms"]["round-reweighted"]
        self.assertTrue(mechanism["guardianFollowupRequired"])
        self.assertTrue(mechanism["aggregate"]["guardianFlags"])
        self.assertIsNone(result["winner"])
        self.assertEqual(result["decisionStatus"], "guardian-followup-required")

    def test_guardian_followup_changes_only_the_guardian_gate(self) -> None:
        reports, weights, obs, representatives = fixture()
        for label in (
            endpoint_label("a", "round-reweighted"),
            endpoint_label("b", "round-reweighted"),
            endpoint_label("c", "round-reweighted"),
        ):
            wins = {index for index in range(100) if index % 2 == 1 or index < 40}
            reports[label] = make_report(label, 949000000, 100, wins, vp_bonus=2)
            weights[label] = reports[label]["weightsSha256"]
        initial = run_analysis(reports, weights, obs, representatives)
        self.assertTrue(initial["guardianFollowupRequired"])

        followup = {
            label: make_report(label, 949100000, 8192, set(range(4096)))
            for label in REPORT_LABELS
        }
        for replicate in REPLICATES:
            for treatment in TREATMENTS:
                label = endpoint_label(replicate, treatment)
                followup[label] = make_report(
                    label, 949100000, 8192, set(range(5734)), vp_bonus=2
                )
        after = analyze_development(
            reports,
            seed0=949000000,
            games=100,
            catalog_sha256=CATALOG_SHA,
            source_contract_sha256=SOURCE_SHA,
            expected_weights=weights,
            expected_obs_versions=obs,
            representatives=representatives,
            frozen_integrity=True,
            guardian_followup_reports=followup,
            bootstrap_samples=500,
            bootstrap_seed=320949,
        )
        mechanism = after["mechanisms"]["round-reweighted"]
        self.assertTrue(mechanism["guardianFollowupApplied"])
        self.assertFalse(after["guardianFollowupRequired"])
        self.assertEqual(after["winner"], "round-reweighted")
        self.assertEqual(
            mechanism["aggregate"]["causalVsMatchedControls"]["winRateDelta"],
            initial["mechanisms"]["round-reweighted"]["aggregate"]["causalVsMatchedControls"]["winRateDelta"],
        )

    def test_representative_must_independently_pass_point_and_late_gates(self) -> None:
        reports, weights, obs, representatives = fixture()
        weak = endpoint_label("a", "round-reweighted")
        reports[weak] = make_report(weak, 949000000, 100, set(range(50)))
        weights[weak] = reports[weak]["weightsSha256"]
        result = run_analysis(reports, weights, obs, representatives)
        mechanism = result["mechanisms"]["round-reweighted"]
        self.assertFalse(mechanism["representative"]["gates"]["causalWinPoint"])
        self.assertFalse(mechanism["eligible"])

    def test_exact_decode_seed_and_outcome_validation_fail_closed(self) -> None:
        reports, weights, obs, representatives = fixture()
        reports["v30"]["decode"]["search"] = {"sims": 1}
        with self.assertRaisesRegex(ValueError, "decode contract"):
            run_analysis(reports, weights, obs, representatives)
        reports, weights, obs, representatives = fixture()
        reports["v30"]["perGame"][0]["seed"] += 1000
        with self.assertRaisesRegex(ValueError, "seed set"):
            run_analysis(reports, weights, obs, representatives)
        reports, weights, obs, representatives = fixture()
        reports["v30"]["perGame"][0]["trueWin"] = False
        with self.assertRaisesRegex(ValueError, "trueWin disagrees"):
            run_analysis(reports, weights, obs, representatives)

    def test_checkpoint_and_frozen_integrity_fail_closed(self) -> None:
        reports, weights, obs, representatives = fixture()
        weights["v30"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "provenance"):
            run_analysis(reports, weights, obs, representatives)
        reports, weights, obs, representatives = fixture()
        with self.assertRaisesRegex(ValueError, "integrity"):
            analyze_development(
                reports,
                seed0=949000000,
                games=100,
                catalog_sha256=CATALOG_SHA,
                source_contract_sha256=SOURCE_SHA,
                expected_weights=weights,
                expected_obs_versions=obs,
                representatives=representatives,
                frozen_integrity=False,
                bootstrap_samples=10,
            )

    def test_any_development_stall_fails_every_mechanism_gate(self) -> None:
        reports, weights, obs, representatives = fixture()
        row = reports["shared-critic"]["perGame"][0]
        row["stalled"] = True
        row["trueWin"] = False
        reports["shared-critic"]["stalls"] = 1
        reports["shared-critic"]["stallRate"] = 0.01
        reports["shared-critic"]["trueWins"] -= 1
        reports["shared-critic"]["trueWinRate"] -= 0.01
        result = run_analysis(reports, weights, obs, representatives)
        self.assertTrue(
            all(not mechanism["aggregate"]["gates"]["zeroStalls"] for mechanism in result["mechanisms"].values())
        )
        self.assertIsNone(result["winner"])

    def test_report_hash_detects_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps({"a": 1}) + "\n")
            frozen = sha256(path)
            path.write_text(json.dumps({"a": 2}) + "\n")
            self.assertNotEqual(sha256(path), frozen)

    def test_bootstrap_family_is_deterministic_and_uses_975_intervals(self) -> None:
        import numpy as np

        contrasts = {
            "round-reweighted": np.asarray([0.0, 1.0, 0.0, 1.0]),
            "p30-credit025": np.asarray([0.0, 0.0, 1.0, 1.0]),
        }
        first = bootstrap_family(contrasts, samples=200, seed=7)
        second = bootstrap_family(contrasts, samples=200, seed=7)
        self.assertEqual(first, second)
        self.assertEqual(first["round-reweighted"]["confidence"], 0.975)
        self.assertEqual(first["round-reweighted"]["familySize"], 2)


if __name__ == "__main__":
    unittest.main()
