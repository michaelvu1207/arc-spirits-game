from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from audit_v32_validation_replay import audit


class ValidationReplayAuditTest(unittest.TestCase):
    def fixture(
        self,
        root: Path,
        *,
        telemetry: bool,
        chosen: int = 1,
        logp_old: float = -0.5,
        v_pred: float = 0.25,
    ) -> None:
        root.mkdir()
        row = {
            "gameId": "10-1p-Red",
            "stepIdx": 0,
            "obsV2": [1.0, 2.0],
            "cands": [[0.0], [1.0]],
            "chosen": chosen,
            "logpOld": logp_old,
            "vPred": v_pred,
        }
        if telemetry:
            row["reach30Pred"] = 0.75
            row["placementProbs"] = [0.1, 0.2, 0.3, 0.4]
        (root / "shard-0.jsonl").write_text(json.dumps(row) + "\n")
        summary = {"seed": 10, "rounds": 30, "finalVP": 28, "wallMs": 1 if telemetry else 2}
        (root / "games-0.jsonl").write_text(json.dumps(summary) + "\n")
        meta = {
            "obs_dim": 199,
            "act_dim": 104,
            "samples": 1,
            "games": 1,
            "workers": 1,
            "obs_version": 2,
            "obs_v2": {"flatLength": 2},
        }
        (root / "meta.json").write_text(json.dumps(meta) + "\n")

    def test_accepts_telemetry_only_replay(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root / "before", telemetry=False)
            self.fixture(root / "after", telemetry=True, logp_old=-0.500001, v_pred=0.250001)
            result = audit(root / "before", root / "after")
            self.assertTrue(result["valid"])
            self.assertEqual(result["afterTelemetry"]["reach30PredCount"], 1)
            self.assertGreater(
                result["trajectory"]["boundedFp32InferenceDrift"]["logpOld"]["maxAbsDiff"],
                0,
            )

    def test_rejects_action_change(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root / "before", telemetry=False)
            self.fixture(root / "after", telemetry=True, chosen=0)
            with self.assertRaisesRegex(ValueError, "trajectory changed"):
                audit(root / "before", root / "after")

    def test_rejects_excess_fp32_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root / "before", telemetry=False)
            self.fixture(root / "after", telemetry=True, logp_old=-0.51)
            with self.assertRaisesRegex(ValueError, "logpOld drift"):
                audit(root / "before", root / "after")


if __name__ == "__main__":
    unittest.main()
