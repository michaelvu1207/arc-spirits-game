from __future__ import annotations

import unittest

from audit_v32_manipulation import ARMS, REPLICATES, evaluate_gates


def fixture() -> dict:
    models = {}
    for replicate in REPLICATES:
        models[replicate] = {}
        for arm in ARMS:
            models[replicate][arm] = {
                "kl": {
                    "overall": 0.001 if arm == "control-uniform" else 0.006,
                    "1-8": 0.001,
                    "9-18": 0.0015,
                    "19-30": 0.001 if arm == "control-uniform" else 0.002,
                },
                "reach30Signal": {
                    "standardizedResidualChosenLogpCovariance": (
                        0.01 if arm == "p30-credit025" else 0.0
                    )
                },
            }
    return models


class ManipulationGateTest(unittest.TestCase):
    def test_accepts_two_of_three_replicates(self) -> None:
        models = fixture()
        models["c"]["round-reweighted"]["kl"]["overall"] = 0.004
        models["c"]["p30-credit025"]["reach30Signal"][
            "standardizedResidualChosenLogpCovariance"
        ] = -0.01
        result = evaluate_gates(models, min_kl=0.005, ratio=1.25)
        self.assertTrue(result["passed"])

    def test_rejects_underdosed_treatment(self) -> None:
        models = fixture()
        for replicate in ("b", "c"):
            models[replicate]["p30-credit025"]["kl"]["overall"] = 0.004
        result = evaluate_gates(models, min_kl=0.005, ratio=1.25)
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["movement"]["p30-credit025"]["passed"])


if __name__ == "__main__":
    unittest.main()
