from __future__ import annotations

import os
import unittest
from pathlib import Path

from run_v35_p30_evaluation_attempt import isolated_command


class P30EvaluationIsolationTests(unittest.TestCase):
    def test_short_socket_namespace_stays_below_linux_limit(self) -> None:
        socket_path = Path("/dev/shm/a35") / ("a" * 64) / "s"
        self.assertLessEqual(len(os.fsencode(socket_path)), 107)

    def test_candidate_cannot_write_trusted_output_and_evaluator_has_no_gpu_bind(self) -> None:
        backend = Path("/usr/bin/bwrap")
        output = Path("/tmp/arc-p30-trusted-output")
        socket_dir = Path("/dev/shm/a35") / ("b" * 64)
        candidate = isolated_command(
            backend=backend,
            argv=["/usr/bin/true"],
            env={"PATH": "/usr/bin:/bin"},
            output_dir=output,
            socket_dir=socket_dir,
            candidate=True,
        )
        evaluator = isolated_command(
            backend=backend,
            argv=["/usr/bin/true"],
            env={"PATH": "/usr/bin:/bin", "CUDA_VISIBLE_DEVICES": ""},
            output_dir=output,
            socket_dir=socket_dir,
            candidate=False,
        )
        self.assertNotIn(str(output), candidate)
        self.assertIn(str(output), evaluator)
        self.assertNotIn("/dev/nvidia7", evaluator)
        self.assertIn("--ro-bind", evaluator)
        self.assertIn(str(socket_dir), evaluator)


if __name__ == "__main__":
    unittest.main()
