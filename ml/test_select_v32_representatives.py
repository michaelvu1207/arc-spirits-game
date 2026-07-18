from __future__ import annotations

import math
import unittest

from select_v32_representatives import select_medoid


class SelectV32RepresentativesTest(unittest.TestCase):
    def test_selects_policy_with_smallest_mean_distance(self) -> None:
        selected, scores = select_medoid({"a-b": 0.4, "a-c": 0.6, "b-c": 0.1})
        self.assertEqual(selected, "b")
        self.assertEqual(scores, {"a": 0.5, "b": 0.25, "c": 0.35})

    def test_ties_break_a_then_b_then_c(self) -> None:
        selected, scores = select_medoid({"a-b": 1.0, "a-c": 1.0, "b-c": 1.0})
        self.assertEqual(selected, "a")
        self.assertEqual(scores, {"a": 1.0, "b": 1.0, "c": 1.0})

    def test_rejects_missing_or_invalid_distances(self) -> None:
        with self.assertRaises(ValueError):
            select_medoid({"a-b": 1.0, "a-c": 1.0})
        with self.assertRaises(ValueError):
            select_medoid({"a-b": -1.0, "a-c": 1.0, "b-c": 1.0})
        with self.assertRaises(ValueError):
            select_medoid({"a-b": math.nan, "a-c": 1.0, "b-c": 1.0})


if __name__ == "__main__":
    unittest.main()
