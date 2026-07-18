#!/usr/bin/env python3
"""Inventory declared Arc game-seed ranges for the V35 runtime lanes.

This deliberately parses only seed-bearing JSON fields from an explicit,
hash-pinned source list.  It never treats arbitrary integers or floating-point
values (for example checkpoint weights or metrics) as seeds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


EXPERIMENT = Path("ml/experiments/v35-weco-recursive-autoresearch")
DEFAULT_SPEC = EXPERIMENT / "runtime-seed-inventory-spec.json"


@dataclass(frozen=True, order=True)
class Interval:
    start: int
    end: int
    source: str
    pointer: str
    visibility: str = "declared"

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            raise ValueError(f"invalid interval {self.start}..{self.end}")

    def overlaps(self, other: "Interval") -> bool:
        return self.start <= other.end and other.start <= self.end


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pointer(parts: Iterable[str | int]) -> str:
    escaped = [str(part).replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def visibility_for(parts: tuple[str | int, ...]) -> str:
    joined = ".".join(str(part).lower() for part in parts)
    if "private" in joined:
        return "private-declaration"
    if "hidden" in joined:
        return "hidden-declaration"
    if "train" in joined or "teacher" in joined or "ppo" in joined:
        return "training"
    return "public-or-systems"


def _nearest_games(ancestors: tuple[dict[str, Any], ...]) -> int | None:
    for ancestor in reversed(ancestors):
        for key in ("gamesPerGeneration", "games", "gamesPerArm", "gamesPerCandidate"):
            value = ancestor.get(key)
            if isinstance(value, int) and value > 0:
                return value
    return None


def extract_semantic_ranges(document: Any, source: str) -> list[Interval]:
    """Extract only explicit game-seed schemas; do not scan scalar values."""

    found: list[Interval] = []

    def add(start: int, end: int, parts: tuple[str | int, ...]) -> None:
        found.append(
            Interval(
                start=start,
                end=end,
                source=source,
                pointer=pointer(parts),
                visibility=visibility_for(parts),
            )
        )

    def walk(value: Any, parts: tuple[str | int, ...], ancestors: tuple[dict[str, Any], ...]) -> None:
        if isinstance(value, dict):
            seed0 = value.get("seed0")
            seed_max = value.get("seedMax")
            games = value.get("games")
            if isinstance(seed0, int) and isinstance(seed_max, int):
                add(seed0, seed_max, parts + ("seed0..seedMax",))
            elif isinstance(seed0, int) and isinstance(games, int) and games > 0:
                add(seed0, seed0 + games - 1, parts + ("seed0+games",))

            public_seed0 = value.get("publicSeed0")
            if isinstance(public_seed0, int):
                public_games = next(
                    (
                        value[key]
                        for key in ("games", "gamesPerArm", "gamesPerCandidate")
                        if isinstance(value.get(key), int) and value[key] > 0
                    ),
                    None,
                )
                if public_games is not None:
                    add(public_seed0, public_seed0 + public_games - 1, parts + ("publicSeed0+games",))

            next_ancestors = ancestors + (value,)
            for key, child in value.items():
                # Arrays of generation start seeds are a declared schema only
                # when a games-per-generation value exists in this ancestry.
                if key.endswith("Seed0") and isinstance(child, list) and child and all(
                    isinstance(item, int) for item in child
                ):
                    count = _nearest_games(next_ancestors)
                    if count is not None:
                        for index, start in enumerate(child):
                            add(start, start + count - 1, parts + (key, index))
                    continue
                walk(child, parts + (key,), next_ancestors)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, parts + (index,), ancestors)

    walk(document, (), ())
    return found


def extract_replicate_schedule(document: dict[str, Any], source: str, root_key: str | None) -> list[Interval]:
    root = document if root_key is None else document[root_key]
    schedule = root["seedSchedule"]
    intervals: list[Interval] = []
    root_parts: tuple[str | int, ...] = () if root_key is None else (root_key,)
    for index, replicate in enumerate(root["replicates"]):
        for lane, base_key, stride_key, games_key in (
            ("train", "trainBase", "trainStride", "gamesPerGeneration"),
            ("eval", "evalBase", "evalStride", "evalGamesPerGeneration"),
        ):
            start = int(replicate[base_key])
            end = (
                start
                + (int(schedule["maxGeneration"]) - 1) * int(schedule[stride_key])
                + int(schedule[games_key])
                - 1
            )
            intervals.append(
                Interval(
                    start,
                    end,
                    source,
                    pointer(root_parts + ("replicates", index, lane, "derived-range")),
                    "training" if lane == "train" else "public-or-systems",
                )
            )
    return intervals


def extract_interval_array(document: Any, source: str, json_pointer: str) -> list[Interval]:
    """Extract start/end pairs only from an explicitly authorized array pointer."""

    if not json_pointer.startswith("/"):
        raise ValueError(f"interval array pointer must be absolute: {json_pointer}")
    value = document
    for encoded in json_pointer[1:].split("/"):
        token = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            value = value[int(token)]
        elif isinstance(value, dict):
            value = value[token]
        else:
            raise ValueError(f"interval array pointer does not resolve: {json_pointer}")
    if not isinstance(value, list):
        raise ValueError(f"interval array pointer is not a list: {json_pointer}")

    intervals: list[Interval] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not isinstance(item.get("start"), int) or not isinstance(item.get("end"), int):
            raise ValueError(f"invalid explicit interval at {json_pointer}/{index}")
        intervals.append(
            Interval(
                item["start"],
                item["end"],
                source,
                f"{json_pointer}/{index}/start..end",
                visibility_for(tuple(json_pointer.split("/")) + (index,)),
            )
        )
    return intervals


def deduplicate(intervals: Iterable[Interval]) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, int], dict[str, Any]] = {}
    for interval in intervals:
        key = (interval.start, interval.end)
        item = grouped.setdefault(
            key,
            {
                "start": interval.start,
                "end": interval.end,
                "count": interval.end - interval.start + 1,
                "visibilities": set(),
                "provenance": [],
            },
        )
        item["visibilities"].add(interval.visibility)
        proof = {"source": interval.source, "pointer": interval.pointer}
        if proof not in item["provenance"]:
            item["provenance"].append(proof)
    result: list[dict[str, Any]] = []
    for item in sorted(grouped.values(), key=lambda candidate: (candidate["start"], candidate["end"])):
        item["visibilities"] = sorted(item["visibilities"])
        item["provenance"] = sorted(item["provenance"], key=lambda proof: (proof["source"], proof["pointer"]))
        result.append(item)
    return result


def _interval_from_dict(item: dict[str, Any], source: str) -> Interval:
    return Interval(
        int(item["start"]),
        int(item["end"]),
        source,
        str(item.get("pointer", "/manual")),
        str(item.get("visibility", "declared")),
    )


def build_inventory(repo: Path, spec_path: Path) -> dict[str, Any]:
    spec_file = repo / spec_path
    spec = json.loads(spec_file.read_text())
    intervals: list[Interval] = []
    verified_sources: list[dict[str, Any]] = []
    source_errors: list[dict[str, str]] = []

    for source in spec["localSources"]:
        relative = Path(source["path"])
        path = repo / relative
        actual = sha256(path) if path.is_file() else None
        expected = source["sha256"]
        ok = actual == expected
        verification = {"id": source["id"], "path": str(relative), "sha256": actual, "hashVerified": ok}
        verified_sources.append(verification)
        if not ok:
            source_errors.append(
                {"id": source["id"], "error": "missing-or-hash-drift", "expected": expected, "actual": actual or "MISSING"}
            )
            continue
        expected_minimum = source.get("expectedMinimumRanges")
        if not isinstance(expected_minimum, int) or expected_minimum < 1:
            source_errors.append(
                {"id": source["id"], "error": "missing-or-invalid-expectedMinimumRanges"}
            )
            verification.update(
                {"rangeOccurrences": 0, "expectedMinimumRanges": expected_minimum, "coverageVerified": False}
            )
            continue
        document = json.loads(path.read_text())
        source_intervals = extract_semantic_ranges(document, str(relative))
        schedule_root = source.get("replicateScheduleRoot")
        if schedule_root is not None:
            source_intervals.extend(
                extract_replicate_schedule(
                    document,
                    str(relative),
                    None if schedule_root == "/" else str(schedule_root),
                )
            )
        for interval_pointer in source.get("intervalArrayPointers", []):
            source_intervals.extend(extract_interval_array(document, str(relative), interval_pointer))
        coverage_verified = len(source_intervals) >= expected_minimum
        verification.update(
            {
                "rangeOccurrences": len(source_intervals),
                "expectedMinimumRanges": expected_minimum,
                "coverageVerified": coverage_verified,
            }
        )
        if not coverage_verified:
            source_errors.append(
                {
                    "id": source["id"],
                    "error": "structured-range-coverage-below-minimum",
                    "expectedMinimum": str(expected_minimum),
                    "actual": str(len(source_intervals)),
                }
            )
        intervals.extend(source_intervals)

    for manual in spec["manualRanges"]:
        source_path = repo / manual["sourcePath"]
        actual = sha256(source_path) if source_path.is_file() else None
        if actual != manual["sourceSha256"]:
            source_errors.append(
                {
                    "id": manual["id"],
                    "error": "manual-source-missing-or-hash-drift",
                    "expected": manual["sourceSha256"],
                    "actual": actual or "MISSING",
                }
            )
            continue
        intervals.append(_interval_from_dict(manual, manual["sourcePath"]))

    declared = deduplicate(intervals)
    declared_intervals = [
        Interval(item["start"], item["end"], "inventory", "/declared") for item in declared
    ]
    proposed = [_interval_from_dict(item, "proposal") for item in spec["proposedPublicRanges"]]

    proposal_checks: list[dict[str, Any]] = []
    for proposal_spec, proposal in zip(spec["proposedPublicRanges"], proposed, strict=True):
        overlaps = [
            {"start": known.start, "end": known.end}
            for known in declared_intervals
            if proposal.overlaps(known)
        ]
        pairwise = [
            other_spec["id"]
            for other_spec, other in zip(spec["proposedPublicRanges"], proposed, strict=True)
            if other_spec["id"] != proposal_spec["id"] and proposal.overlaps(other)
        ]
        proposal_checks.append(
            {
                "id": proposal_spec["id"],
                "start": proposal.start,
                "end": proposal.end,
                "count": proposal.end - proposal.start + 1,
                "status": proposal_spec["status"],
                "disjointFromDeclaredStructuredRanges": not overlaps,
                "declaredOverlaps": overlaps,
                "disjointFromOtherProposals": not pairwise,
                "proposalOverlaps": pairwise,
            }
        )

    remote = spec["simforgeReadOnlySnapshot"]
    remote_files = []
    mirror_ok = True
    local_by_path = {item["path"]: item for item in verified_sources}
    for item in remote["files"]:
        local = local_by_path.get(item["path"])
        mirror_match = local is not None and local["sha256"] == item["sha256"]
        remote_files.append({**item, "matchesPinnedLocalSource": mirror_match})
        mirror_ok = mirror_ok and mirror_match

    semantic_overlaps: list[dict[str, Any]] = []
    for item in remote["semanticSweep"]["rangesAtOrAbove969050000"]:
        observed = _interval_from_dict(item, "simforge-semantic-sweep")
        for proposal_spec, proposal in zip(spec["proposedPublicRanges"], proposed, strict=True):
            if observed.overlaps(proposal):
                semantic_overlaps.append(
                    {
                        "proposal": proposal_spec["id"],
                        "remoteStart": observed.start,
                        "remoteEnd": observed.end,
                    }
                )
    semantic_ok = not remote["semanticSweep"]["parseErrors"] and not semantic_overlaps

    valid = (
        not source_errors
        and mirror_ok
        and semantic_ok
        and bool(spec["unprovableNamespaces"])
        and all(check["disjointFromDeclaredStructuredRanges"] for check in proposal_checks)
        and all(check["disjointFromOtherProposals"] for check in proposal_checks)
    )
    return {
        "schemaVersion": "arc-v35-runtime-seed-inventory-v1",
        "valid": valid,
        "claim": "disjoint-from-hash-pinned-structured-declarations-only",
        "globalCompletenessProven": False,
        "spec": {"path": str(spec_path), "sha256": sha256(spec_file)},
        "sourceVerification": verified_sources,
        "sourceErrors": source_errors,
        "simforgeReadOnlySnapshot": {
            **{key: value for key, value in remote.items() if key != "files"},
            "files": remote_files,
            "allMirrorsMatch": mirror_ok,
            "semanticSweepNoProposalOverlap": semantic_ok,
            "semanticSweepProposalOverlaps": semantic_overlaps,
        },
        "extractionPolicy": spec["extractionPolicy"],
        "declaredStructuredRanges": declared,
        "proposalChecks": proposal_checks,
        "unprovableNamespaces": spec["unprovableNamespaces"],
        "conclusion": {
            "parityRangeDisjoint": next(item for item in proposal_checks if item["id"] == "runtime-parity")[
                "disjointFromDeclaredStructuredRanges"
            ],
            "latencyRangeDisjoint": next(item for item in proposal_checks if item["id"] == "latency-precheck")[
                "disjointFromDeclaredStructuredRanges"
            ],
            "confirmationZoneDisjoint": next(
                item for item in proposal_checks if item["id"] == "provisional-confirmation-zone"
            )["disjointFromDeclaredStructuredRanges"],
            "absoluteLegacyDisjointnessClaimed": False,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = build_inventory(args.repo.resolve(), args.spec)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))
    if not result["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
