import unittest

import numpy as np

from analyze_v35_phase1 import GAMES, bootstrap_interval, label


class AnalyzeV35Phase1Tests(unittest.TestCase):
    def test_labels_are_unambiguous(self) -> None:
        self.assertEqual(label("a", "late-reweighted"), "rep-a-late-reweighted")

    def test_bootstrap_interval_is_deterministic(self) -> None:
        values = np.zeros(GAMES, dtype=np.float64)
        values[: GAMES // 2] = 1.0
        first = bootstrap_interval(values, 123)
        second = bootstrap_interval(values, 123)
        self.assertEqual(first, second)
        self.assertLess(first["lower"], 0.5)
        self.assertGreater(first["upper"], 0.5)

    def test_bootstrap_rejects_wrong_shape(self) -> None:
        with self.assertRaises(ValueError):
            bootstrap_interval(np.zeros(10, dtype=np.float64), 123)


if __name__ == "__main__":
    unittest.main()
