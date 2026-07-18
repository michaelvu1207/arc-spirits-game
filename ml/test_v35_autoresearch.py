#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import sys
import tempfile
import unittest
from pathlib import Path

from ml.autoresearch.v35.core import (
    ArtifactSigner,
    Budget,
    DEFAULT_CANDIDATE,
    SeedVault,
    holm_bonferroni,
    paired_bootstrap_lcb,
    paired_sign_test_p,
    required_games,
    spearman_rank_correlation,
    validate_candidate,
)
from ml.autoresearch.v35.evaluator import (
    EvaluationRequest,
    GateThresholds,
    PrivateBroker,
    ScoreWeights,
    SyntheticBackend,
    TrustedEvaluator,
    late_game_score,
)
from ml.autoresearch.v35.sandbox import CandidateSandbox
from ml.autoresearch.v35.search import SearchRunner
from ml.autoresearch.v35.pilot import load_authorization as load_public_pilot_authorization


class CandidateSchemaTests(unittest.TestCase):
    def test_default_and_mutual_exclusions(self) -> None:
        candidate = validate_candidate(DEFAULT_CANDIDATE)
        self.assertEqual(candidate.planner_mode, "none")
        invalid = copy.deepcopy(DEFAULT_CANDIDATE)
        invalid["planner"]["searchSims"] = 4
        with self.assertRaisesRegex(ValueError, "none planner"):
            validate_candidate(invalid)

    def test_candidate_cannot_control_evaluator_score(self) -> None:
        invalid = copy.deepcopy(DEFAULT_CANDIDATE)
        invalid["lateGameScore"] = {"terminalWeight": 0.0}
        with self.assertRaisesRegex(ValueError, "keys must be exactly"):
            validate_candidate(invalid)

    def test_rejects_non_finite_and_unknown_fields(self) -> None:
        for bad in (float("nan"), float("inf"), -1.0, 9.0):
            invalid = copy.deepcopy(DEFAULT_CANDIDATE)
            invalid["policy"]["temperature"] = bad
            with self.assertRaises(ValueError):
                validate_candidate(invalid)
        invalid = copy.deepcopy(DEFAULT_CANDIDATE)
        invalid["privateSeed"] = 1
        with self.assertRaises(ValueError):
            validate_candidate(invalid)

    def test_score_weights_are_terminal_dominant(self) -> None:
        ScoreWeights()
        with self.assertRaises(ValueError):
            ScoreWeights(terminal=0.4, vp_growth=0.4, engine_growth=0.2)

    def test_engine_hoarding_cannot_beat_terminal_conversion(self) -> None:
        def row(*, win: bool, engine: float, vp_rate: float) -> dict[str, object]:
            return {
                "trueWin": win,
                "stalled": False,
                "finalVP": 30 if win else 12,
                "post15VpPerRound": vp_rate,
                "finalAttackDice": engine,
                "finalSpirits": engine,
                "finalMaxBarrier": engine,
            }

        converting = [row(win=True, engine=3, vp_rate=1.5) for _ in range(32)]
        hoarding = [row(win=False, engine=8, vp_rate=0.0) for _ in range(32)]
        convert_score, _, _ = late_game_score(ScoreWeights(), converting)
        hoard_score, _, _ = late_game_score(ScoreWeights(), hoarding)
        self.assertGreater(convert_score, hoard_score)


class IntegrityTests(unittest.TestCase):
    def test_seed_vault_permissions_and_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "seed.key"
            vault = SeedVault.open_or_create(path)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            first = vault.family("private", "campaign-a", 100_000)
            second = vault.family("private", "campaign-a", 100_000)
            self.assertEqual(first, second)
            self.assertGreaterEqual(first["seed0"], 970_000_000)
            self.assertLessEqual(first["seed0"] + first["games"] - 1, 989_999_999)
            self.assertNotEqual(first["commitment"], vault.family("private", "campaign-b", 100_000)["commitment"])

    def test_signed_chain_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            signer = ArtifactSigner.open_or_create(Path(temp) / "sign.key")
            first = signer.sign({"candidate": "a"})
            second = signer.sign({"candidate": "b"}, first["entrySha256"])
            self.assertTrue(signer.verify(first))
            self.assertTrue(signer.verify(second))
            tampered = copy.deepcopy(second)
            tampered["payload"]["candidate"] = "winner"
            self.assertFalse(signer.verify(tampered))

    def test_budget_is_fail_before_mutate(self) -> None:
        budget = Budget(max_evaluations=1, max_games=4, max_private_queries=1)
        budget.charge(games=4, cpu_seconds=1, gpu_seconds=0, wall_seconds=1)
        before = budget.snapshot()
        with self.assertRaisesRegex(RuntimeError, "budget_exhausted"):
            budget.charge(games=1, cpu_seconds=0, gpu_seconds=0, wall_seconds=0)
        self.assertEqual(before, budget.snapshot())


class EvaluatorTests(unittest.TestCase):
    def _fixture(self, temp: Path, evaluations: int = 20) -> tuple[TrustedEvaluator, SeedVault]:
        signer = ArtifactSigner.open_or_create(temp / "sign.key")
        vault = SeedVault.open_or_create(temp / "seed.key")
        evaluator = TrustedEvaluator(
            backend=SyntheticBackend(),
            signer=signer,
            budget=Budget(max_evaluations=evaluations, max_games=evaluations * 64),
            immutable_manifest={"schemaVersion": "test-manifest-v1"},
            thresholds=GateThresholds(require_complete_task_mix=False),
        )
        return evaluator, vault

    def test_deterministic_signed_synthetic_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            evaluator, vault = self._fixture(temp)
            family = vault.family("private", "determinism", 32)
            request = EvaluationRequest(
                validate_candidate(DEFAULT_CANDIDATE),
                "public",
                "determinism",
                32,
                family["seed0"],
                family["commitment"],
            )
            first = evaluator.evaluate(request)
            second = evaluator.evaluate(request)
            self.assertEqual(first.arc_fitness, second.arc_fitness)
            self.assertEqual(first.endpoints, second.endpoints)
            self.assertEqual(second.signed_entry["previousEntrySha256"], first.signed_entry["entrySha256"])

    def test_private_broker_hides_scalar_and_caps_queries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            evaluator, vault = self._fixture(temp, evaluations=2)
            family = vault.family("private", "private", 16)
            request = EvaluationRequest(
                validate_candidate(DEFAULT_CANDIDATE),
                "private",
                "private",
                16,
                family["seed0"],
                family["commitment"],
            )
            broker = PrivateBroker(evaluator, max_queries=1)
            internal, feedback = broker.query(request)
            self.assertIsInstance(internal.arc_fitness, float)
            self.assertNotIn("arc_fitness", feedback)
            self.assertEqual(set(feedback), {"schemaVersion", "accepted", "diagnosticCodes"})
            with self.assertRaisesRegex(RuntimeError, "private_query_cap_reached"):
                broker.query(request)

    def test_search_arms_use_exact_equal_evaluation_counts(self) -> None:
        for index, method in enumerate(("random", "evolutionary", "tpe", "aide")):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as temp_name:
                temp = Path(temp_name)
                evaluator, vault = self._fixture(temp, evaluations=8)
                family = vault.family("private", "equal-cost", 32)
                runner = SearchRunner(
                    evaluator=evaluator,
                    seed0=family["seed0"],
                    seed_commitment=family["commitment"],
                    games_per_step=32,
                    campaign="equal-cost",
                    random_seed=35_000 + index,
                )
                state = runner.run(method, 8)
                self.assertEqual(len(state.observations), 8)
                self.assertEqual(evaluator.budget.evaluations, 8)
                self.assertEqual(evaluator.budget.games, 256)
                self.assertEqual(len(state.ledger_entries), 8)
                self.assertEqual(
                    state.ledger_entries[0]["previousEntrySha256"], "0" * 64
                )
                for previous, current in zip(
                    state.ledger_entries, state.ledger_entries[1:]
                ):
                    self.assertEqual(
                        current["previousEntrySha256"], previous["entrySha256"]
                    )
                self.assertTrue(state.best.accepted)
                if method == "aide":
                    self.assertGreaterEqual(len({item.lineage for item in state.observations}), 4)

    def test_inference_surface_keeps_training_fields_frozen(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            evaluator, vault = self._fixture(temp, evaluations=12)
            family = vault.family("private", "inference-surface", 16)
            runner = SearchRunner(
                evaluator=evaluator,
                seed0=family["seed0"],
                seed_commitment=family["commitment"],
                games_per_step=16,
                campaign="inference-surface",
                random_seed=35_901,
                search_surface="inference",
            )
            state = runner.run("aide", 12)
            default = validate_candidate(DEFAULT_CANDIDATE)
            for observation in state.observations:
                candidate = observation.candidate
                self.assertEqual(candidate.solo_share, default.solo_share)
                self.assertEqual(candidate.snapshot_share, default.snapshot_share)
                self.assertEqual(candidate.multiplayer_share, default.multiplayer_share)
                self.assertEqual(candidate.terminal_loss_weight, default.terminal_loss_weight)
                self.assertEqual(candidate.engine_loss_weight, default.engine_loss_weight)
                self.assertEqual(candidate.reach30_loss_weight, default.reach30_loss_weight)
                self.assertEqual(candidate.entropy_weight, default.entropy_weight)


class StatisticsTests(unittest.TestCase):
    def test_corrections_and_power(self) -> None:
        self.assertEqual(holm_bonferroni([0.001, 0.02, 0.2]), [True, True, False])
        self.assertGreater(required_games(0.2, 0.05), 100)
        self.assertEqual(spearman_rank_correlation([1, 2, 3], [2, 4, 8]), 1.0)
        self.assertGreater(paired_bootstrap_lcb([2, 3, 4], [1, 1, 1], samples=1000), 0)
        self.assertLess(paired_sign_test_p([2] * 8, [1] * 8), 0.05)


class PublicPilotAuthorizationTests(unittest.TestCase):
    def test_frozen_authorization_and_fail_closed_mutations(self) -> None:
        root = Path(__file__).resolve().parents[1]
        authorization_path = (
            root
            / "ml/experiments/v35-weco-recursive-autoresearch/artifacts/"
            "public-config-pilot-authorization.json"
        )
        authorization = load_public_pilot_authorization(authorization_path, root)
        self.assertEqual(authorization["totalProposals"], 20)
        self.assertFalse(authorization["privateAccess"])
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            for mutation in ("private", "hash"):
                changed = copy.deepcopy(authorization)
                if mutation == "private":
                    changed["privateAccess"] = True
                else:
                    changed["trustedFiles"]["ml/catalog.json"] = "0" * 64
                path = temp / f"{mutation}.json"
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    load_public_pilot_authorization(path, root)


@unittest.skipUnless(platform.system() == "Darwin", "macOS Seatbelt smoke")
class SandboxTests(unittest.TestCase):
    def test_private_read_and_network_are_denied(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            candidate = root / "candidate"
            private = root / "private"
            candidate.mkdir()
            private.mkdir()
            secret = private / "seed.key"
            secret.write_text("DO_NOT_LEAK")
            script = candidate / "attack.py"
            script.write_text(
                "import pathlib, socket\n"
                "blocked=0\n"
                f"try:\n pathlib.Path({str(secret)!r}).read_text()\n"
                "except Exception:\n blocked += 1\n"
                "try:\n socket.create_connection(('1.1.1.1', 53), timeout=.2)\n"
                "except Exception:\n blocked += 1\n"
                "print('BLOCKED' if blocked == 2 else 'ESCAPED')\n"
            )
            sandbox = CandidateSandbox(
                readable_roots=[candidate],
                forbidden_roots=[private],
                timeout_seconds=3,
            )
            result = sandbox.run([str(Path(sys.executable).resolve()), str(script)], cwd=candidate)
            self.assertEqual(result.return_code, 0)
            self.assertEqual(result.stdout_sha256, hashlib.sha256(b"BLOCKED\n").hexdigest())

    def test_timeout_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            script = root / "hang.py"
            script.write_text("while True: pass\n")
            sandbox = CandidateSandbox(
                readable_roots=[root],
                forbidden_roots=[root / "private"],
                timeout_seconds=0.1,
            )
            result = sandbox.run([str(Path(sys.executable).resolve()), str(script)], cwd=root)
            self.assertTrue(result.timed_out)
            self.assertEqual(result.return_code, 124)


if __name__ == "__main__":
    unittest.main()
