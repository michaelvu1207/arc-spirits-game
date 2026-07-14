#!/usr/bin/env python3
import unittest

from ml.analyze_v33_search import paired_vectors


class V33QualificationTests(unittest.TestCase):
    def test_candidate_minus_comparator_orientation(self) -> None:
        comparator = [
            {"seed": 1, "trueWin": False, "finalVP": 20, "post15VpPerRound": 0.5, "first30Round": None},
            {"seed": 2, "trueWin": True, "finalVP": 30, "post15VpPerRound": 1.0, "first30Round": 28},
        ]
        selected = [
            {"seed": 1, "trueWin": True, "finalVP": 30, "post15VpPerRound": 1.0, "first30Round": 25},
            {"seed": 2, "trueWin": True, "finalVP": 31, "post15VpPerRound": 1.1, "first30Round": 27},
        ]
        vectors = paired_vectors(comparator, selected)
        self.assertEqual(vectors["trueWin"].tolist(), [1, 0])
        self.assertEqual(vectors["censoredRound"].tolist(), [-6, -1])


if __name__ == "__main__":
    unittest.main()
