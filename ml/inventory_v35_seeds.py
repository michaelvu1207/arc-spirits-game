#!/usr/bin/env python3
"""Fail closed if V35 Phase 1's registered seed ranges appear in prior seed-bearing inputs."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Iterable


INTEGER = re.compile(r"(?<![\d.])([0-9]{9})(?![\d.])")
EXPERIMENT = Path("ml/experiments/v35-weco-recursive-autoresearch")
ALLOWED = {
    EXPERIMENT / "phase1-training-plan.md",
    EXPERIMENT / "phase1-protocol.json",
    EXPERIMENT / "artifacts/phase1-materialized-configs.json",
}


def seed_intervals(protocol: dict[str, Any]) -> list[dict[str, int | str]]:
    schedule = protocol["seedSchedule"]
    intervals: list[dict[str, int | str]] = []
    for replicate in protocol["replicates"]:
        intervals.extend(
            [
                {
                    "id": f"{replicate['id']}:train",
                    "start": int(replicate["trainBase"]),
                    "end": int(replicate["trainBase"])
                    + (int(schedule["maxGeneration"]) - 1) * int(schedule["trainStride"])
                    + int(schedule["gamesPerGeneration"])
                    - 1,
                },
                {
                    "id": f"{replicate['id']}:eval",
                    "start": int(replicate["evalBase"]),
                    "end": int(replicate["evalBase"])
                    + (int(schedule["maxGeneration"]) - 1) * int(schedule["evalStride"])
                    + int(schedule["evalGamesPerGeneration"])
                    - 1,
                },
            ]
        )
    intervals.append(
        {
            "id": "development",
            "start": int(schedule["developmentBase"]),
            "end": int(schedule["developmentBase"]) + int(schedule["developmentGames"]) - 1,
        }
    )
    return intervals


def registered_files(repo: Path) -> Iterable[Path]:
    patterns = (
        "ml/experiments/**/protocol.json",
        "ml/league/configs/*.json",
        "scripts/*.mjs",
        "scripts/*.sh",
        "ml/*.py",
    )
    files: set[Path] = set()
    for pattern in patterns:
        files.update(path for path in repo.glob(pattern) if path.is_file())
    v35 = repo / EXPERIMENT
    for relative in (
        "plan.md",
        "phase1-training-plan.md",
        "phase1-protocol.json",
        "artifacts/phase1-materialized-configs.json",
    ):
        path = v35 / relative
        if path.is_file():
            files.add(path)
    files.update((v35 / "league").glob("rep-*/*/config.json"))
    files.update((v35 / "league").glob("rep-*/*/v35-binding.json"))
    return sorted(files)


def values_in_ranges(text: str, intervals: list[dict[str, int | str]]) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    for match in INTEGER.finditer(text):
        value = int(match.group(1))
        for interval in intervals:
            if int(interval["start"]) <= value <= int(interval["end"]):
                hits.append((value, str(interval["id"])))
    return hits


def run(repo: Path, protocol_path: Path) -> dict[str, Any]:
    protocol = json.loads((repo / protocol_path).read_text())
    intervals = seed_intervals(protocol)
    allowed_hits: list[dict[str, Any]] = []
    collisions: list[dict[str, Any]] = []
    scanned = 0
    for path in registered_files(repo):
        scanned += 1
        relative = path.relative_to(repo)
        text = path.read_text(errors="strict")
        for value, interval in values_in_ranges(text, intervals):
            hit = {"path": str(relative), "value": value, "interval": interval}
            if relative in ALLOWED or str(relative).startswith(str(EXPERIMENT / "league")):
                allowed_hits.append(hit)
            else:
                collisions.append(hit)
    return {
        "schemaVersion": "arc-v35-seed-inventory-v1",
        "valid": not collisions,
        "protocol": str(protocol_path),
        "intervals": intervals,
        "filesScanned": scanned,
        "allowedRegistrationHits": allowed_hits,
        "collisions": collisions,
        "scope": [
            "experiment protocol files",
            "league configs",
            "top-level ML Python launch/audit sources",
            "top-level scripts",
            "V35 plans, materialized configs, and root bindings",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument(
        "--protocol",
        type=Path,
        default=EXPERIMENT / "phase1-protocol.json",
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.repo.resolve(), args.protocol)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))
    if not result["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
