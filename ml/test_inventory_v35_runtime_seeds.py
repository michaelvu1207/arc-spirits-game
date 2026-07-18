#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from ml.inventory_v35_runtime_seeds import (
    DEFAULT_SPEC,
    Interval,
    build_inventory,
    extract_interval_array,
    extract_semantic_ranges,
)


REPO = Path(__file__).resolve().parents[1]


class V35RuntimeSeedInventoryTests(unittest.TestCase):
    def test_semantic_extractor_ignores_weights_metrics_and_non_game_rng(self) -> None:
        document = {
            "weights": [969_060_001, 969_070_000, 0.969060001],
            "metrics": {"score": 969_061_000, "randomSeed": 969_060_002},
            "realGameRange": {"seed0": 123_000_000, "seedMax": 123_000_003},
        }
        ranges = extract_semantic_ranges(document, "synthetic.json")
        self.assertEqual([(item.start, item.end) for item in ranges], [(123_000_000, 123_000_003)])

    def test_generation_seed_arrays_require_an_explicit_game_count(self) -> None:
        document = {
            "registered": {
                "generationSeed0": [100_000_000, 100_010_000],
                "gamesPerGeneration": 4,
            },
            "notRegistered": {"generationSeed0": [200_000_000]},
        }
        ranges = extract_semantic_ranges(document, "synthetic.json")
        self.assertEqual(
            [(item.start, item.end) for item in ranges],
            [(100_000_000, 100_000_003), (100_010_000, 100_010_003)],
        )

    def test_start_end_ranges_require_an_explicit_array_pointer(self) -> None:
        document = {
            "intervals": [{"id": "one", "start": 300_000_000, "end": 300_000_003}],
            "unrelated": [{"start": 969_060_000, "end": 969_060_063}],
        }
        self.assertEqual(extract_semantic_ranges(document, "synthetic.json"), [])
        ranges = extract_interval_array(document, "synthetic.json", "/intervals")
        self.assertEqual([(item.start, item.end) for item in ranges], [(300_000_000, 300_000_003)])

    def test_interval_overlap_is_closed_and_inclusive(self) -> None:
        left = Interval(10, 20, "a", "/a")
        self.assertTrue(left.overlaps(Interval(20, 30, "b", "/b")))
        self.assertFalse(left.overlaps(Interval(21, 30, "b", "/b")))

    def test_source_coverage_minimum_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            source = root / "source.json"
            source.write_text(json.dumps({"range": {"seed0": 100, "seedMax": 103}}))
            source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            spec = {
                "localSources": [
                    {
                        "id": "undercovered",
                        "path": "source.json",
                        "sha256": source_hash,
                        "expectedMinimumRanges": 2,
                    }
                ],
                "manualRanges": [],
                "proposedPublicRanges": [
                    {"id": "runtime-parity", "start": 200, "end": 203, "status": "test"},
                    {"id": "latency-precheck", "start": 300, "end": 303, "status": "test"},
                    {"id": "provisional-confirmation-zone", "start": 400, "end": 499, "status": "test"},
                ],
                "simforgeReadOnlySnapshot": {
                    "files": [{"path": "source.json", "sha256": source_hash}],
                    "semanticSweep": {"parseErrors": [], "rangesAtOrAbove969050000": []},
                },
                "extractionPolicy": {},
                "unprovableNamespaces": [{"id": "test-unknown"}],
            }
            (root / "spec.json").write_text(json.dumps(spec))
            inventory = build_inventory(root, Path("spec.json"))
            self.assertFalse(inventory["valid"])
            self.assertEqual(inventory["sourceErrors"][0]["error"], "structured-range-coverage-below-minimum")

    def test_repo_inventory_verifies_sources_and_proposals(self) -> None:
        inventory = build_inventory(REPO, DEFAULT_SPEC)
        self.assertTrue(inventory["valid"])
        self.assertFalse(inventory["globalCompletenessProven"])
        self.assertEqual(inventory["sourceErrors"], [])
        self.assertTrue(inventory["simforgeReadOnlySnapshot"]["allMirrorsMatch"])
        for source in inventory["sourceVerification"]:
            self.assertTrue(source["coverageVerified"], source["id"])
            self.assertGreaterEqual(source["rangeOccurrences"], source["expectedMinimumRanges"])
        phase1_inventory = next(
            source for source in inventory["sourceVerification"] if source["id"] == "v35-phase1-seed-inventory"
        )
        self.assertEqual(phase1_inventory["rangeOccurrences"], 7)
        self.assertEqual(phase1_inventory["expectedMinimumRanges"], 7)
        checks = {item["id"]: item for item in inventory["proposalChecks"]}
        self.assertEqual((checks["runtime-parity"]["start"], checks["runtime-parity"]["end"]), (969_060_000, 969_060_063))
        self.assertEqual((checks["latency-precheck"]["start"], checks["latency-precheck"]["end"]), (969_061_000, 969_061_255))
        self.assertEqual(
            (checks["provisional-confirmation-zone"]["start"], checks["provisional-confirmation-zone"]["end"]),
            (969_070_000, 969_999_999),
        )
        for check in checks.values():
            self.assertTrue(check["disjointFromDeclaredStructuredRanges"])
            self.assertTrue(check["disjointFromOtherProposals"])
        known = {(item["start"], item["end"]) for item in inventory["declaredStructuredRanges"]}
        self.assertIn((969_040_000, 969_040_255), known)
        self.assertIn((962_000_000, 962_000_511), known)
        self.assertGreaterEqual(len(inventory["unprovableNamespaces"]), 4)


if __name__ == "__main__":
    unittest.main()
