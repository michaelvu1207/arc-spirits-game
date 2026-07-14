"""Create a provenance-checked, zero-copy merged obs-v2 training dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any


SCHEMA_KEYS = ("obs_dim", "act_dim", "obs_version", "obs_v2")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_summary(source: Path) -> dict[str, Any]:
    meta_path = source / "meta.json"
    if not meta_path.is_file():
        raise FileNotFoundError(meta_path)
    meta = json.loads(meta_path.read_text())
    shards = sorted(source.glob("shard-*.jsonl"))
    games_files = sorted(source.glob("games-*.jsonl"))
    if not shards or not games_files:
        raise ValueError(f"{source}: expected shard and game summary files")
    seeds: set[int] = set()
    for path in games_files:
        with path.open() as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                if "seed" not in row:
                    raise ValueError(f"{path}:{line_number}: missing seed")
                seed = int(row["seed"])
                if seed in seeds:
                    raise ValueError(f"{source}: duplicate game seed {seed}")
                seeds.add(seed)
    expected_games = int(meta["games"])
    if len(seeds) != expected_games:
        raise ValueError(
            f"{source}: meta games={expected_games}, summaries contain {len(seeds)} seeds"
        )
    return {
        "path": source.resolve(),
        "meta": meta,
        "metaSha256": sha256(meta_path),
        "shards": shards,
        "shardSha256": [sha256(path) for path in shards],
        "seeds": seeds,
    }


def merge_datasets(sources: list[Path], out: Path) -> dict[str, Any]:
    if len(sources) < 2:
        raise ValueError("merge requires at least two source datasets")
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f"refusing to overwrite non-empty merge directory: {out}")
    summaries = [source_summary(source) for source in sources]
    reference = summaries[0]["meta"]
    for summary in summaries[1:]:
        for key in SCHEMA_KEYS:
            if summary["meta"].get(key) != reference.get(key):
                raise ValueError(
                    f"dataset schema mismatch for {key}: "
                    f"{summaries[0]['path']} vs {summary['path']}"
                )
    all_seeds: set[int] = set()
    for summary in summaries:
        overlap = all_seeds & summary["seeds"]
        if overlap:
            raise ValueError(f"source game seeds overlap: {sorted(overlap)[:10]}")
        all_seeds.update(summary["seeds"])

    out.mkdir(parents=True, exist_ok=True)
    linked: list[dict[str, Any]] = []
    for source_index, summary in enumerate(summaries):
        for shard_index, shard in enumerate(summary["shards"]):
            destination = out / f"shard-{source_index:02d}-{shard_index:03d}.jsonl"
            destination.symlink_to(os.path.relpath(shard.resolve(), out.resolve()))
            linked.append({
                "path": destination.name,
                "source": str(shard.resolve()),
                "sha256": summary["shardSha256"][shard_index],
            })

    merged_meta = dict(reference)
    merged_meta["samples"] = sum(int(summary["meta"]["samples"]) for summary in summaries)
    merged_meta["games"] = sum(int(summary["meta"]["games"]) for summary in summaries)
    merged_meta["workers"] = sum(int(summary["meta"].get("workers", 0)) for summary in summaries)
    merged_meta["merge"] = {
        "schemaVersion": "arc-v2-symlink-merge-v1",
        "sources": [str(summary["path"]) for summary in summaries],
    }
    (out / "meta.json").write_text(json.dumps(merged_meta, indent=2) + "\n")
    manifest = {
        "schemaVersion": "arc-v2-symlink-merge-v1",
        "out": str(out.resolve()),
        "games": merged_meta["games"],
        "samples": merged_meta["samples"],
        "seeds": {
            "count": len(all_seeds),
            "min": min(all_seeds),
            "max": max(all_seeds),
        },
        "sources": [
            {
                "path": str(summary["path"]),
                "metaSha256": summary["metaSha256"],
                "games": int(summary["meta"]["games"]),
                "samples": int(summary["meta"]["samples"]),
                "seedMin": min(summary["seeds"]),
                "seedMax": max(summary["seeds"]),
            }
            for summary in summaries
        ],
        "linkedShards": linked,
    }
    (out / "merge-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, action="append", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = merge_datasets(args.source, args.out)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
