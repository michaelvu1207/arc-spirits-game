"""Focused tests for zero-copy obs-v2 dataset merging."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from merge_v2_datasets import merge_datasets


def write_source(path: Path, *, seed0: int, games: int, schema_tag: int = 2) -> None:
    path.mkdir(parents=True)
    (path / "meta.json").write_text(json.dumps({
        "obs_dim": 7,
        "act_dim": 5,
        "obs_version": 2,
        "obs_v2": {"versionCode": schema_tag},
        "samples": games * 2,
        "games": games,
        "workers": 1,
    }))
    (path / "shard-0.jsonl").write_text("{}\n")
    with (path / "games-0.jsonl").open("w") as handle:
        for seed in range(seed0, seed0 + games):
            handle.write(json.dumps({"seed": seed}) + "\n")


def main() -> int:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_source(root / "a", seed0=100, games=2)
        write_source(root / "b", seed0=200, games=3)
        manifest = merge_datasets([root / "a", root / "b"], root / "merged")
        assert manifest["games"] == 5 and manifest["samples"] == 10
        assert manifest["seeds"] == {"count": 5, "min": 100, "max": 202}
        links = sorted((root / "merged").glob("shard-*.jsonl"))
        assert len(links) == 2 and all(link.is_symlink() for link in links)

        write_source(root / "bad", seed0=300, games=1, schema_tag=3)
        try:
            merge_datasets([root / "a", root / "bad"], root / "bad-merge")
        except ValueError as error:
            assert "schema mismatch" in str(error)
        else:
            raise AssertionError("schema mismatch was accepted")
    print("PASS V30 zero-copy dataset merge")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
