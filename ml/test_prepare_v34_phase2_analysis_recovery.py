from __future__ import annotations

import hashlib
from pathlib import Path
import tempfile
import unittest

from ml.prepare_v34_phase2_analysis_recovery import validate_embedded_file_record


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RecoveryPreflightBindingTests(unittest.TestCase):
    def test_embedded_record_binds_exact_supplied_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            target = repo / "authorization.json"
            target.write_bytes(b"authorized\n")
            validate_embedded_file_record(
                {"path": "authorization.json", "bytes": target.stat().st_size, "sha256": sha256(target)},
                target,
                repo,
                "authorization",
            )

    def test_embedded_record_rejects_different_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            target = repo / "authorization.json"
            other = repo / "other.json"
            target.write_bytes(b"same\n")
            other.write_bytes(b"same\n")
            with self.assertRaisesRegex(RuntimeError, "path does not bind"):
                validate_embedded_file_record(
                    {"path": "other.json", "bytes": other.stat().st_size, "sha256": sha256(other)},
                    target,
                    repo,
                    "authorization",
                )

    def test_embedded_record_rejects_changed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            target = repo / "inventory.tsv"
            target.write_bytes(b"before\n")
            record = {"path": "inventory.tsv", "bytes": target.stat().st_size, "sha256": sha256(target)}
            target.write_bytes(b"alterd\n")
            with self.assertRaisesRegex(RuntimeError, "hash changed"):
                validate_embedded_file_record(record, target, repo, "inventory")


if __name__ == "__main__":
    unittest.main()
