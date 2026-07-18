#!/usr/bin/env python3
"""Compare seeded V1 actor-pool trajectories across inference backends.

The actor pool shards decisions across worker-owned JSONL files, so filesystem
order and worker assignment are deliberately ignored. Decision rows are keyed by
``(gameId, stepIdx)`` and game summaries by ``seed``. Timing and checkpoint-path
labels in game summaries are non-semantic and ignored; every other serialized
field is checked.

Inference outputs are compared with explicit absolute tolerances. All other
trajectory/state/action fields are exact. The report includes PPO initial-ratio
statistics for structurally identical rows carrying ``logpOld``.

Example:
  python scripts/compare_v1_trajectories.py \
    --local /tmp/parity/local --socket /tmp/parity/socket-1 \
    --socket-repeat /tmp/parity/socket-2 --out /tmp/parity/report
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


NUMERIC_FIELDS = ("logpOld", "vPred", "reach30Pred", "placementProbs")
GAME_IGNORED_FIELDS = frozenset(("wallMs", "weightsOrProfiles"))


@dataclass
class SourceData:
    label: str
    root: Path
    rows: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    games: dict[int, dict[str, Any]] = field(default_factory=dict)
    duplicates: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    shard_files: list[str] = field(default_factory=list)
    game_files: list[str] = field(default_factory=list)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _value_summary(value: Any) -> Any:
    """Keep scalar diagnostics readable without copying whole observations into reports."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str) and len(value) <= 160:
        return value
    encoded = _canonical_json(value).encode()
    summary: dict[str, Any] = {
        "type": type(value).__name__,
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }
    if isinstance(value, (list, dict, str)):
        summary["length"] = len(value)
    return summary


def _first_difference(left: Any, right: Any, path: str = "") -> tuple[str, Any, Any]:
    if type(left) is not type(right):
        # JSON numbers may legitimately parse as int on one side and float on the
        # other. Python equality already treats 1 and 1.0 as equal.
        if isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right:
            return "", left, right
        return path, left, right
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            child = f"{path}.{key}" if path else str(key)
            if key not in left:
                return child, "<missing>", right[key]
            if key not in right:
                return child, left[key], "<missing>"
            if left[key] != right[key]:
                return _first_difference(left[key], right[key], child)
    elif isinstance(left, list):
        if len(left) != len(right):
            return f"{path}.length", len(left), len(right)
        for index, (lv, rv) in enumerate(zip(left, right)):
            if lv != rv:
                return _first_difference(lv, rv, f"{path}[{index}]")
    elif left != right:
        return path, left, right
    return "", left, right


def _read_jsonl_files(
    source: SourceData,
    pattern: str,
    key_name: str,
) -> tuple[dict[Any, dict[str, Any]], list[str]]:
    # Direct actor-pool runs write at root; league generation roots nest the same
    # shard names under m-<matchup>/. Recursive discovery supports both layouts.
    files = sorted(source.root.rglob(pattern))
    names = [str(path.resolve()) for path in files]
    records: dict[Any, dict[str, Any]] = {}
    origins: dict[Any, tuple[str, int]] = {}
    if not files:
        source.errors.append(f"{source.root}: no files matching {pattern}")
        return records, names

    for path in files:
        with path.open(encoding="utf-8") as handle:
            for line_number, raw in enumerate(handle, 1):
                if not raw.strip():
                    continue
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError as exc:
                    source.errors.append(f"{path}:{line_number}: invalid JSON: {exc}")
                    continue
                if not isinstance(row, dict):
                    source.errors.append(f"{path}:{line_number}: JSONL row is not an object")
                    continue
                if key_name == "trajectory":
                    game_id, step_idx = row.get("gameId"), row.get("stepIdx")
                    if not isinstance(game_id, str) or not game_id:
                        source.errors.append(f"{path}:{line_number}: missing/invalid gameId")
                        continue
                    if isinstance(step_idx, bool) or not isinstance(step_idx, int) or step_idx < 0:
                        source.errors.append(f"{path}:{line_number}: missing/invalid stepIdx")
                        continue
                    key: Any = (game_id, step_idx)
                else:
                    seed = row.get("seed")
                    if isinstance(seed, bool) or not isinstance(seed, int):
                        source.errors.append(f"{path}:{line_number}: missing/invalid seed")
                        continue
                    key = seed
                if key in records:
                    first_file, first_line = origins[key]
                    source.duplicates.append(
                        {
                            "kind": key_name,
                            "key": list(key) if isinstance(key, tuple) else key,
                            "first": {"file": first_file, "line": first_line},
                            "duplicate": {"file": str(path.resolve()), "line": line_number},
                        }
                    )
                    continue
                records[key] = row
                origins[key] = (str(path.resolve()), line_number)
    return records, names


def load_source(root: str | Path, label: str) -> SourceData:
    source = SourceData(label=label, root=Path(root).resolve())
    if not source.root.is_dir():
        source.errors.append(f"{source.root}: directory does not exist")
        return source
    source.rows, source.shard_files = _read_jsonl_files(
        source, "shard-*.jsonl", "trajectory"
    )
    source.games, source.game_files = _read_jsonl_files(source, "games-*.jsonl", "game")
    if source.shard_files and not source.rows:
        source.errors.append(f"{source.root}: no valid trajectory rows")
    if source.game_files and not source.games:
        source.errors.append(f"{source.root}: no valid game summaries")
    return source


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    lower = math.floor(pos)
    upper = math.ceil(pos)
    if lower == upper:
        return ordered[lower]
    frac = pos - lower
    return ordered[lower] * (1 - frac) + ordered[upper] * frac


def _valid_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _numeric_pairs(left: Any, right: Any) -> tuple[list[tuple[float, float]], str | None]:
    if isinstance(left, list) or isinstance(right, list):
        if not isinstance(left, list) or not isinstance(right, list):
            return [], "scalar/vector shape mismatch"
        if len(left) != len(right):
            return [], f"vector length {len(left)} != {len(right)}"
        pairs: list[tuple[float, float]] = []
        for index, (lv, rv) in enumerate(zip(left, right)):
            if not _valid_number(lv) or not _valid_number(rv):
                return [], f"non-finite/non-numeric vector element at {index}"
            pairs.append((float(lv), float(rv)))
        return pairs, None
    if not _valid_number(left) or not _valid_number(right):
        return [], "non-finite/non-numeric scalar"
    return [(float(left), float(right))], None


class DivergenceSink:
    """Retain the first useful divergence for each game/summary/input key."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.records: list[dict[str, Any]] = []
        self._seen: set[str] = set()
        self.truncated = False

    def add(self, group: str, record: dict[str, Any]) -> None:
        if group in self._seen:
            return
        if len(self.records) >= self.limit:
            self.truncated = True
            return
        self._seen.add(group)
        self.records.append(record)


def _source_diagnostics(source: SourceData) -> dict[str, Any]:
    return {
        "root": str(source.root),
        "trajectoryRows": len(source.rows),
        "gameSummaries": len(source.games),
        "shardFiles": source.shard_files,
        "gameFiles": source.game_files,
        "duplicates": source.duplicates,
        "errors": source.errors,
    }


def compare_sources(
    left: SourceData,
    right: SourceData,
    name: str,
    tolerances: dict[str, float],
    sink: DivergenceSink,
) -> dict[str, Any]:
    exact_field_mismatches = 0
    rows_with_exact_mismatch = 0
    chosen_action_mismatches = 0
    candidate_surface_mismatches = 0
    observation_mismatches = 0
    numeric: dict[str, dict[str, Any]] = {
        field: {
            "tolerance": tolerances[field],
            "valuesCompared": 0,
            "rowsCompared": 0,
            "missingOrInvalidRows": 0,
            "mismatchedValues": 0,
            "rowsOutsideTolerance": 0,
            "absoluteDifferences": [],
        }
        for field in NUMERIC_FIELDS
    }
    ratio_values: list[float] = []
    ratio_abs_from_one: list[float] = []
    ratio_excluded_structural = 0

    left_keys, right_keys = set(left.rows), set(right.rows)
    missing_in_right = sorted(left_keys - right_keys)
    missing_in_left = sorted(right_keys - left_keys)
    for game_id, step_idx in missing_in_right:
        sink.add(
            f"{name}:row:{game_id}",
            {
                "comparison": name,
                "kind": "missingTrajectoryRow",
                "gameId": game_id,
                "stepIdx": step_idx,
                "missingFrom": right.label,
            },
        )
    for game_id, step_idx in missing_in_left:
        sink.add(
            f"{name}:row:{game_id}",
            {
                "comparison": name,
                "kind": "missingTrajectoryRow",
                "gameId": game_id,
                "stepIdx": step_idx,
                "missingFrom": left.label,
            },
        )

    for game_id, step_idx in sorted(left_keys & right_keys):
        lrow, rrow = left.rows[(game_id, step_idx)], right.rows[(game_id, step_idx)]
        exact_keys = sorted(
            (set(lrow) | set(rrow)) - set(NUMERIC_FIELDS) - {"gameId", "stepIdx"}
        )
        row_exact = True
        for field_name in exact_keys:
            lpresent, rpresent = field_name in lrow, field_name in rrow
            if not lpresent or not rpresent or lrow[field_name] != rrow[field_name]:
                exact_field_mismatches += 1
                row_exact = False
                if field_name == "chosen":
                    chosen_action_mismatches += 1
                elif field_name == "cands":
                    candidate_surface_mismatches += 1
                elif field_name in ("obs", "obsV2"):
                    observation_mismatches += 1
                if not lpresent or not rpresent:
                    diff_path = field_name
                    lv = lrow.get(field_name, "<missing>")
                    rv = rrow.get(field_name, "<missing>")
                else:
                    nested_path, lv, rv = _first_difference(lrow[field_name], rrow[field_name])
                    diff_path = f"{field_name}.{nested_path}" if nested_path else field_name
                sink.add(
                    f"{name}:row:{game_id}",
                    {
                        "comparison": name,
                        "kind": "exactFieldMismatch",
                        "gameId": game_id,
                        "stepIdx": step_idx,
                        "field": field_name,
                        "differencePath": diff_path,
                        left.label: _value_summary(lv),
                        right.label: _value_summary(rv),
                    },
                )
        if not row_exact:
            rows_with_exact_mismatch += 1

        for field_name in NUMERIC_FIELDS:
            stat = numeric[field_name]
            lpresent, rpresent = field_name in lrow, field_name in rrow
            if not lpresent and not rpresent:
                continue
            if not lpresent or not rpresent:
                stat["missingOrInvalidRows"] += 1
                sink.add(
                    f"{name}:row:{game_id}",
                    {
                        "comparison": name,
                        "kind": "numericFieldPresenceMismatch",
                        "gameId": game_id,
                        "stepIdx": step_idx,
                        "field": field_name,
                        "missingFrom": left.label if not lpresent else right.label,
                    },
                )
                continue
            pairs, error = _numeric_pairs(lrow[field_name], rrow[field_name])
            if error:
                stat["missingOrInvalidRows"] += 1
                sink.add(
                    f"{name}:row:{game_id}",
                    {
                        "comparison": name,
                        "kind": "invalidNumericField",
                        "gameId": game_id,
                        "stepIdx": step_idx,
                        "field": field_name,
                        "error": error,
                    },
                )
                continue
            stat["rowsCompared"] += 1
            row_outside = False
            max_pair: tuple[float, float, float] | None = None
            for lv, rv in pairs:
                diff = abs(rv - lv)
                stat["valuesCompared"] += 1
                stat["absoluteDifferences"].append(diff)
                if max_pair is None or diff > max_pair[2]:
                    max_pair = (lv, rv, diff)
                if not math.isclose(lv, rv, rel_tol=0.0, abs_tol=tolerances[field_name]):
                    stat["mismatchedValues"] += 1
                    row_outside = True
            if row_outside:
                stat["rowsOutsideTolerance"] += 1
                assert max_pair is not None
                sink.add(
                    f"{name}:row:{game_id}",
                    {
                        "comparison": name,
                        "kind": "numericToleranceExceeded",
                        "gameId": game_id,
                        "stepIdx": step_idx,
                        "field": field_name,
                        "tolerance": tolerances[field_name],
                        left.label: max_pair[0],
                        right.label: max_pair[1],
                        "absoluteDifference": max_pair[2],
                    },
                )

        if "logpOld" in lrow and "logpOld" in rrow:
            if row_exact and _valid_number(lrow["logpOld"]) and _valid_number(rrow["logpOld"]):
                delta = float(rrow["logpOld"]) - float(lrow["logpOld"])
                ratio = math.exp(delta) if delta < 709 else math.inf
                ratio_values.append(ratio)
                ratio_abs_from_one.append(abs(ratio - 1))
            else:
                ratio_excluded_structural += 1

    game_left_keys, game_right_keys = set(left.games), set(right.games)
    missing_games_right = sorted(game_left_keys - game_right_keys)
    missing_games_left = sorted(game_right_keys - game_left_keys)
    for seed in missing_games_right:
        sink.add(
            f"{name}:game:{seed}",
            {
                "comparison": name,
                "kind": "missingGameSummary",
                "seed": seed,
                "missingFrom": right.label,
            },
        )
    for seed in missing_games_left:
        sink.add(
            f"{name}:game:{seed}",
            {
                "comparison": name,
                "kind": "missingGameSummary",
                "seed": seed,
                "missingFrom": left.label,
            },
        )
    game_mismatches = 0
    for seed in sorted(game_left_keys & game_right_keys):
        lgame = {k: v for k, v in left.games[seed].items() if k not in GAME_IGNORED_FIELDS}
        rgame = {k: v for k, v in right.games[seed].items() if k not in GAME_IGNORED_FIELDS}
        if lgame != rgame:
            game_mismatches += 1
            path, lv, rv = _first_difference(lgame, rgame)
            sink.add(
                f"{name}:game:{seed}",
                {
                    "comparison": name,
                    "kind": "gameSummaryMismatch",
                    "seed": seed,
                    "differencePath": path,
                    left.label: _value_summary(lv),
                    right.label: _value_summary(rv),
                },
            )

    numeric_report: dict[str, Any] = {}
    numeric_failures = 0
    for field_name, stat in numeric.items():
        diffs = stat.pop("absoluteDifferences")
        numeric_failures += stat["missingOrInvalidRows"] + stat["mismatchedValues"]
        numeric_report[field_name] = {
            **stat,
            "maxAbsoluteDifference": max(diffs) if diffs else None,
            "p50AbsoluteDifference": _quantile(diffs, 0.50),
            "p99AbsoluteDifference": _quantile(diffs, 0.99),
        }

    duplicate_count = len(left.duplicates) + len(right.duplicates)
    input_error_count = len(left.errors) + len(right.errors)
    passed = not any(
        (
            missing_in_right,
            missing_in_left,
            missing_games_right,
            missing_games_left,
            exact_field_mismatches,
            numeric_failures,
            game_mismatches,
            duplicate_count,
            input_error_count,
        )
    )
    return {
        "name": name,
        "left": left.label,
        "right": right.label,
        "passed": passed,
        "trajectory": {
            "leftRows": len(left.rows),
            "rightRows": len(right.rows),
            "commonRows": len(left_keys & right_keys),
            "missingFromRight": len(missing_in_right),
            "missingFromLeft": len(missing_in_left),
            "rowsWithExactMismatch": rows_with_exact_mismatch,
            "exactFieldMismatches": exact_field_mismatches,
            "chosenActionMismatches": chosen_action_mismatches,
            "candidateSurfaceMismatches": candidate_surface_mismatches,
            "observationMismatches": observation_mismatches,
        },
        "numeric": numeric_report,
        "ppoRatio": {
            "rows": len(ratio_values),
            "excludedBecauseStructureDiffered": ratio_excluded_structural,
            "min": min(ratio_values) if ratio_values else None,
            "p50": _quantile(ratio_values, 0.50),
            "p90": _quantile(ratio_values, 0.90),
            "p99": _quantile(ratio_values, 0.99),
            "max": max(ratio_values) if ratio_values else None,
            "maxAbsoluteDistanceFromOne": max(ratio_abs_from_one)
            if ratio_abs_from_one
            else None,
        },
        "games": {
            "leftSummaries": len(left.games),
            "rightSummaries": len(right.games),
            "commonSummaries": len(game_left_keys & game_right_keys),
            "missingFromRight": len(missing_games_right),
            "missingFromLeft": len(missing_games_left),
            "semanticMismatches": game_mismatches,
            "ignoredFields": sorted(GAME_IGNORED_FIELDS),
        },
        "input": {
            "duplicates": duplicate_count,
            "errors": input_error_count,
        },
    }


def run_comparison(
    local_dir: str | Path,
    socket_dir: str | Path,
    out_dir: str | Path,
    socket_repeat_dir: str | Path | None = None,
    tolerances: dict[str, float] | None = None,
    max_divergences: int = 1000,
) -> dict[str, Any]:
    tolerances = tolerances or {
        "logpOld": 5e-4,
        "vPred": 1e-4,
        "reach30Pred": 1e-4,
        "placementProbs": 1e-4,
    }
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    sources = {
        "local": load_source(local_dir, "local"),
        "socket": load_source(socket_dir, "socket"),
    }
    if socket_repeat_dir is not None:
        sources["socketRepeat"] = load_source(socket_repeat_dir, "socketRepeat")

    sink = DivergenceSink(max_divergences)
    for source in sources.values():
        for duplicate in source.duplicates:
            key = duplicate["key"]
            sink.add(
                f"input:{source.label}:{key}",
                {
                    "comparison": "input",
                    "source": source.label,
                    **duplicate,
                    "duplicateKind": duplicate["kind"],
                    "kind": "duplicate",
                },
            )
        for index, error in enumerate(source.errors):
            sink.add(
                f"input:{source.label}:error:{index}",
                {"comparison": "input", "source": source.label, "kind": "inputError", "error": error},
            )

    comparisons = [
        compare_sources(
            sources["local"], sources["socket"], "local_vs_socket", tolerances, sink
        )
    ]
    if "socketRepeat" in sources:
        # A repeated socket backend under an identical checkpoint/configuration is
        # a determinism gate, not a cross-backend numerical comparison.
        repeat_tolerances = {field: 0.0 for field in NUMERIC_FIELDS}
        comparisons.append(
            compare_sources(
                sources["socket"],
                sources["socketRepeat"],
                "socket_vs_socket_repeat",
                repeat_tolerances,
                sink,
            )
        )

    passed = all(comparison["passed"] for comparison in comparisons)
    report = {
        "format": "arc-v1-trajectory-parity-v1",
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "passed": passed,
        "tolerances": tolerances,
        "sources": {label: _source_diagnostics(source) for label, source in sources.items()},
        "comparisons": comparisons,
        "firstDivergencesWritten": len(sink.records),
        "firstDivergencesTruncated": sink.truncated,
    }
    (out / "parity.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    with (out / "first-divergences.jsonl").open("w", encoding="utf-8") as handle:
        for divergence in sink.records:
            handle.write(json.dumps(divergence, separators=(",", ":")) + "\n")
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", required=True, help="in-process actor-pool output directory")
    parser.add_argument("--socket", required=True, help="socket actor-pool output directory")
    parser.add_argument("--socket-repeat", help="optional second socket run for repeatability")
    parser.add_argument("--out", required=True, help="directory for parity.json and divergences")
    parser.add_argument("--logp-atol", type=float, default=5e-4)
    parser.add_argument("--value-atol", type=float, default=1e-4)
    parser.add_argument("--reach30-atol", type=float, default=1e-4)
    parser.add_argument("--placement-atol", type=float, default=1e-4)
    parser.add_argument("--max-divergences", type=int, default=1000)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    tolerances = {
        "logpOld": args.logp_atol,
        "vPred": args.value_atol,
        "reach30Pred": args.reach30_atol,
        "placementProbs": args.placement_atol,
    }
    if any(not math.isfinite(value) or value < 0 for value in tolerances.values()):
        raise SystemExit("all tolerances must be finite and non-negative")
    if args.max_divergences < 1:
        raise SystemExit("--max-divergences must be positive")
    report = run_comparison(
        args.local,
        args.socket,
        args.out,
        socket_repeat_dir=args.socket_repeat,
        tolerances=tolerances,
        max_divergences=args.max_divergences,
    )
    result = "PASS" if report["passed"] else "FAIL"
    print(
        f"{result}: {len(report['comparisons'])} comparison(s); "
        f"wrote {Path(args.out).resolve() / 'parity.json'} and "
        f"{Path(args.out).resolve() / 'first-divergences.jsonl'}"
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
