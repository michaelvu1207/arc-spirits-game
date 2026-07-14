#!/usr/bin/env python3
"""Prove V32's telemetry-only validation replay did not change actor behavior."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


TELEMETRY_FIELDS = ("placementProbs", "reach30Pred")
META_INVARIANTS = ("obs_dim", "act_dim", "samples", "games", "workers", "obs_version", "obs_v2")


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def aggregate_fingerprints(values: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for key in sorted(values):
        digest.update(key.encode())
        digest.update(b"\0")
        digest.update(canonical(values[key]))
        digest.update(b"\n")
    return digest.hexdigest()


def trajectory_fingerprints(root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    paths = sorted(root.glob("shard-*.jsonl"))
    if not paths:
        raise ValueError(f"no trajectory shards below {root}")
    digests: dict[str, hashlib._Hash] = {}
    counts: dict[str, int] = {}
    next_steps: dict[str, int] = {}
    reach_count = 0
    reach_min = math.inf
    reach_max = -math.inf
    reach_sum = 0.0
    placement_count = 0
    rows = 0
    for path in paths:
        with path.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                game_id = str(row.get("gameId", ""))
                step = int(row.get("stepIdx", -1))
                if not game_id or step < 0:
                    raise ValueError(f"{path}:{line_number}: missing gameId/stepIdx")
                expected_step = next_steps.get(game_id, 0)
                if step != expected_step:
                    raise ValueError(
                        f"{path}:{line_number}: {game_id} step {step} != expected {expected_step}"
                    )
                next_steps[game_id] = step + 1
                reach = row.pop("reach30Pred", None)
                placement = row.pop("placementProbs", None)
                if reach is not None:
                    reach = float(reach)
                    if not math.isfinite(reach) or not 0 <= reach <= 1:
                        raise ValueError(f"{path}:{line_number}: invalid reach30Pred {reach}")
                    reach_count += 1
                    reach_min = min(reach_min, reach)
                    reach_max = max(reach_max, reach)
                    reach_sum += reach
                if placement is not None:
                    if (
                        not isinstance(placement, list)
                        or len(placement) != 4
                        or any(not math.isfinite(float(value)) or float(value) < 0 for value in placement)
                        or not math.isclose(sum(float(value) for value in placement), 1.0, abs_tol=1e-5)
                    ):
                        raise ValueError(f"{path}:{line_number}: invalid placementProbs")
                    placement_count += 1
                digest = digests.setdefault(game_id, hashlib.sha256())
                digest.update(canonical(row))
                digest.update(b"\n")
                counts[game_id] = counts.get(game_id, 0) + 1
                rows += 1
    fingerprints = {
        game_id: {"rows": counts[game_id], "sha256": digest.hexdigest()}
        for game_id, digest in digests.items()
    }
    telemetry = {
        "rows": rows,
        "games": len(fingerprints),
        "reach30PredCount": reach_count,
        "reach30PredMin": None if reach_count == 0 else reach_min,
        "reach30PredMax": None if reach_count == 0 else reach_max,
        "reach30PredMean": None if reach_count == 0 else reach_sum / reach_count,
        "placementProbsCount": placement_count,
    }
    return fingerprints, telemetry


def summary_fingerprints(root: Path) -> dict[str, dict[str, Any]]:
    paths = sorted(root.glob("games-*.jsonl"))
    if not paths:
        raise ValueError(f"no game summaries below {root}")
    values: dict[str, dict[str, Any]] = {}
    for path in paths:
        with path.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                seed = str(row.get("seed", ""))
                if not seed or seed in values:
                    raise ValueError(f"{path}:{line_number}: missing/duplicate seed {seed}")
                row.pop("wallMs", None)
                values[seed] = {"sha256": hashlib.sha256(canonical(row)).hexdigest()}
    return values


def meta_invariants(root: Path) -> dict[str, Any]:
    meta = json.loads((root / "meta.json").read_text())
    return {key: meta.get(key) for key in META_INVARIANTS}


def compare_maps(label: str, before: dict[str, Any], after: dict[str, Any]) -> None:
    if before.keys() != after.keys():
        raise ValueError(
            f"{label} keys changed: missing={sorted(before.keys() - after.keys())[:10]} "
            f"extra={sorted(after.keys() - before.keys())[:10]}"
        )
    mismatches = [key for key in before if before[key] != after[key]]
    if mismatches:
        raise ValueError(f"{label} changed for {mismatches[:10]}")


def audit(before_root: Path, after_root: Path) -> dict[str, Any]:
    before_rows, before_telemetry = trajectory_fingerprints(before_root)
    after_rows, after_telemetry = trajectory_fingerprints(after_root)
    compare_maps("trajectory", before_rows, after_rows)
    before_summaries = summary_fingerprints(before_root)
    after_summaries = summary_fingerprints(after_root)
    compare_maps("game summary", before_summaries, after_summaries)
    before_meta = meta_invariants(before_root)
    after_meta = meta_invariants(after_root)
    if before_meta != after_meta:
        raise ValueError(f"metadata invariants changed: before={before_meta} after={after_meta}")
    if before_telemetry["reach30PredCount"] != 0:
        raise ValueError(f"failed replay unexpectedly had reach30Pred: {before_telemetry}")
    if after_telemetry["reach30PredCount"] != after_telemetry["rows"]:
        raise ValueError(f"repaired replay lacks reach30Pred rows: {after_telemetry}")
    return {
        "schemaVersion": "arc-v32-validation-replay-audit-v1",
        "valid": True,
        "before": str(before_root.resolve()),
        "after": str(after_root.resolve()),
        "metaInvariants": after_meta,
        "trajectory": {
            "games": len(after_rows),
            "rows": after_telemetry["rows"],
            "behaviorProjectionSha256": aggregate_fingerprints(after_rows),
            "exactAfterDroppingOnly": list(TELEMETRY_FIELDS),
        },
        "summaries": {
            "games": len(after_summaries),
            "outcomeProjectionSha256": aggregate_fingerprints(after_summaries),
            "exactAfterDroppingOnly": ["wallMs"],
        },
        "beforeTelemetry": before_telemetry,
        "afterTelemetry": after_telemetry,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.before, args.after)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
