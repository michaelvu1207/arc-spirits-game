"""Focused tests for benchmark_infer_latency.py data and summary helpers."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import numpy as np

from benchmark_infer_latency import fixed_candidates, load_payloads, percentiles


def test_fixed_candidates_repeats_real_rows() -> None:
    source = np.asarray([[1, 2], [3, 4]], dtype=np.float32)
    got = fixed_candidates(source, 5)
    assert got.tolist() == [[1, 2], [3, 4], [1, 2], [3, 4], [1, 2]]
    assert got.flags.owndata


def test_load_payloads_has_exact_shape() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        with open(root / "shard-000.jsonl", "w") as handle:
            for index in range(8):
                handle.write(json.dumps({
                    "obsV2": [2.0, float(index), 7.0],
                    "cands": [[float(index), 0.0], [float(index), 1.0]],
                }) + "\n")
        payloads = load_payloads(
            root, clients=2, rows_per_request=4, candidates_per_row=3
        )
    assert len(payloads) == 2
    for obs, cands in payloads:
        assert obs.shape == (4, 3)
        assert len(cands) == 4
        assert all(candidate.shape == (3, 2) for candidate in cands)


def test_percentiles_are_finite_and_ordered() -> None:
    summary = percentiles([1.0, 2.0, 3.0, 4.0, 5.0])
    assert summary["min"] <= summary["p50"] <= summary["p95"] <= summary["p99"] <= summary["max"]
    assert summary["mean"] == 3.0


def main() -> int:
    tests = [
        test_fixed_candidates_repeats_real_rows,
        test_load_payloads_has_exact_shape,
        test_percentiles_are_finite_and_ordered,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
