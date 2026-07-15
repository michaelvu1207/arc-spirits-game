import math
import unittest

from select_v35_representatives import select_medoid, validate_endpoint


class SelectV35RepresentativesTests(unittest.TestCase):
    def test_select_medoid_and_tie_break(self) -> None:
        selected, scores = select_medoid({"a-b": 0.4, "a-c": 0.6, "b-c": 0.1})
        self.assertEqual(selected, "b")
        self.assertEqual(scores, {"a": 0.5, "b": 0.25, "c": 0.35})
        selected, _ = select_medoid({"a-b": 1.0, "a-c": 1.0, "b-c": 1.0})
        self.assertEqual(selected, "a")

    def test_select_medoid_rejects_invalid_distance(self) -> None:
        with self.assertRaises(ValueError):
            select_medoid({"a-b": -1.0, "a-c": 1.0, "b-c": 1.0})
        with self.assertRaises(ValueError):
            select_medoid({"a-b": math.nan, "a-c": 1.0, "b-c": 1.0})

    def test_endpoint_and_manipulation_must_match(self) -> None:
        roots = []
        models = {}
        arms = ("control-uniform", "late-reweighted", "p30-credit025")
        for replicate in ("a", "b", "c"):
            models[replicate] = {}
            for arm_index, arm in enumerate(arms):
                value = f"{ord(replicate) + arm_index:064x}"[-64:]
                roots.append({"replicate": replicate, "arm": arm, "checkpointSha256": value})
                models[replicate][arm] = {"sha256": value}
        endpoint = {
            "schemaVersion": "arc-v35-phase1-endpoint-v1",
            "valid": True,
            "endpoint": 8,
            "performanceOutcomesInspected": False,
            "roots": roots,
        }
        manipulation = {
            "schemaVersion": "arc-v35-manipulation-audit-v1",
            "valid": True,
            "generation": 8,
            "performanceOutcomesInspected": False,
            "manipulation": {"passed": True},
            "models": models,
        }
        expected = validate_endpoint(endpoint, manipulation, 8)
        self.assertEqual(set(expected), {"late-reweighted", "p30-credit025"})
        manipulation["models"]["c"]["p30-credit025"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            validate_endpoint(endpoint, manipulation, 8)


if __name__ == "__main__":
    unittest.main()
