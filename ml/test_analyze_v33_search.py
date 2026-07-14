#!/usr/bin/env python3
import unittest

import numpy as np

from ml.analyze_v33_search import gate_contrast, guardian_deltas, paired_bootstrap, paired_vectors


class V33AnalysisTests(unittest.TestCase):
    def rows(self, wins: list[int], vp_offset: int = 0) -> list[dict]:
        return [
            {
                "seed": 100 + i,
                "guardian": "A" if i % 2 == 0 else "B",
                "trueWin": bool(win),
                "finalVP": 20 + vp_offset + i,
                "post15VpPerRound": 0.5 + vp_offset * 0.01,
                "first30Round": 25 if win else None,
            }
            for i, win in enumerate(wins)
        ]

    def test_paired_vectors_use_failure_round_31(self) -> None:
        raw = self.rows([0, 1, 0, 1])
        arm = self.rows([1, 1, 0, 1], vp_offset=1)
        vectors = paired_vectors(raw, arm)
        self.assertEqual(vectors["trueWin"].tolist(), [1, 0, 0, 0])
        self.assertEqual(vectors["finalVP"].tolist(), [1, 1, 1, 1])
        self.assertEqual(vectors["censoredRound"].tolist(), [-6, 0, 0, 0])

    def test_bootstrap_is_reproducible_and_cluster_shared(self) -> None:
        contrasts = {
            "a": {"trueWin": np.asarray([1.0, 0, -1, 1]), "finalVP": np.asarray([2.0, 1, 0, 3])},
            "b": {"trueWin": np.asarray([0.0, 1, 0, 1]), "finalVP": np.asarray([1.0, 2, 1, 2])},
        }
        one = paired_bootstrap(contrasts, draws=500, rng_seed=33, interval_confidence=0.9833)
        two = paired_bootstrap(contrasts, draws=500, rng_seed=33, interval_confidence=0.9833)
        self.assertEqual(one, two)
        self.assertAlmostEqual(one["a"]["trueWin"]["mean"], 0.25)

    def test_guardian_trigger_only_after_non_guardian_pass(self) -> None:
        interval = {
            "trueWin": {"mean": 0.1, "lower": 0.01, "upper": 0.2},
            "finalVP": {"mean": 1, "lower": -1, "upper": 3},
            "post15": {"mean": 0.1, "lower": -0.1, "upper": 0.3},
            "censoredRound": {"mean": -1, "lower": -3, "upper": 1},
        }
        gate = gate_contrast(interval, {"A": 2, "B": -6}, {"single": 900, "eight": 1900}, stalls=0)
        self.assertTrue(gate["nonGuardianPass"])
        self.assertTrue(gate["guardianConfirmationRequired"])
        self.assertFalse(gate["eligible"])
        gate = gate_contrast(interval, {"A": 2, "B": -4}, {"single": 1001, "eight": 1900}, stalls=0)
        self.assertFalse(gate["nonGuardianPass"])
        self.assertFalse(gate["guardianConfirmationRequired"])

    def test_guardian_deltas_are_paired_by_identity(self) -> None:
        raw = self.rows([0, 1, 0, 1])
        arm = self.rows([1, 1, 0, 0])
        self.assertEqual(guardian_deltas(raw, arm), {"A": 50.0, "B": -50.0})


if __name__ == "__main__":
    unittest.main()
