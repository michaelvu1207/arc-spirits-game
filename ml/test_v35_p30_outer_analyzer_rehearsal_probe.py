from __future__ import annotations

import ast
import unittest
from pathlib import Path

import run_v35_p30_outer_analyzer_rehearsal_probe as probe


REPO = Path(__file__).resolve().parents[1]


class OuterAnalyzerRehearsalProbeTests(unittest.TestCase):
    def test_probe_uses_only_production_outer_execution_primitives(self) -> None:
        source = (
            REPO / "ml/run_v35_p30_outer_analyzer_rehearsal_probe.py"
        ).read_text()
        tree = ast.parse(source)
        names = {
            node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
        }
        self.assertIn("build_preflight_authorization", names)
        self.assertIn("build_executor_launch_permit_payload", names)
        self.assertIn("persist_executor_launch_permit", names)
        self.assertIn("prepare_execution_receipt", names)
        self.assertIn("seal_execution_receipt", names)
        self.assertNotIn("subprocess", names)
        self.assertNotIn("bubblewrap_command", names)

    def test_probe_is_synthetic_metric_free_and_no_gpu(self) -> None:
        source = (
            REPO / "ml/run_v35_p30_outer_analyzer_rehearsal_probe.py"
        ).read_text()
        self.assertIn('"syntheticDataOnly": True', source)
        self.assertIn('"analysisResultInspected": False', source)
        self.assertIn('"metricsExposed": False', source)
        self.assertIn('"gpuMode": "none"', source)
        self.assertNotIn("cuda-determinism", source)
        self.assertNotIn("analysis.json\").read", source)

    def test_probe_deletes_keys_before_outer_child_launch(self) -> None:
        source = (
            REPO / "ml/run_v35_p30_outer_analyzer_rehearsal_probe.py"
        ).read_text()
        delete = source.index("_delete_private_material(keys, private_root)")
        launch = source.index("draft = prepare_execution_receipt(")
        self.assertLess(delete, launch)

    def test_probe_id_is_full_sha256_identity(self) -> None:
        self.assertEqual(probe._require_probe_id("a" * 64), "a" * 64)
        for invalid in ("a" * 63, "a" * 65, "g" * 64):
            with self.assertRaises(ValueError):
                probe._require_probe_id(invalid)


if __name__ == "__main__":
    unittest.main()
