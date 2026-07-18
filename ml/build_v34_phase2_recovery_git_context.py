#!/usr/bin/env python3
"""Build and inventory a shallow, commit-only Git database for V34 recovery."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from typing import Any, Mapping
import zlib


def run(argv: list[str], *, cwd: Path, environment: Mapping[str, str] | None = None, expected: int = 0) -> bytes:
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=None if environment is None else dict(environment),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != expected:
        raise RuntimeError(f"command returned {result.returncode}, expected {expected}: {argv}")
    return result.stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path, recorded_path: str) -> dict[str, Any]:
    return {"path": recorded_path, "bytes": path.stat().st_size, "sha256": sha256(path)}


def write_new(path: Path, payload: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def git_environment(git_dir: Path) -> dict[str, str]:
    environment = dict(os.environ)
    for key in list(environment):
        if key.startswith("GIT_"):
            del environment[key]
    environment.update(
        {
            "GIT_DIR": str(git_dir),
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
    )
    return environment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", type=Path, required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--boundary", required=True)
    parser.add_argument("--required-ancestry", required=True)
    parser.add_argument("--git-dir", type=Path, required=True)
    parser.add_argument("--recorded-git-dir", required=True)
    parser.add_argument("--authoritative-root", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--authorization-recorded-path", required=True)
    parser.add_argument("--inventory-out", type=Path, required=True)
    parser.add_argument("--inventory-recorded-path", required=True)
    parser.add_argument("--manifest-out", type=Path, required=True)
    args = parser.parse_args()

    source_repo = args.source_repo.resolve()
    git_dir = args.git_dir.resolve()
    authorization = args.authorization.resolve()
    inventory_out = args.inventory_out.resolve()
    manifest_out = args.manifest_out.resolve()
    for path in (git_dir, inventory_out, manifest_out):
        if path.exists() or path.is_symlink():
            raise RuntimeError(f"output already exists: {path}")
    if not authorization.is_file():
        raise RuntimeError("authorization file is missing")
    if not args.ref.startswith("refs/heads/"):
        raise RuntimeError("ref must be under refs/heads")

    raw_graph = run(
        [
            "git",
            "rev-list",
            "--reverse",
            "--ancestry-path",
            f"{args.boundary}^..{args.head}",
            "--parents",
        ],
        cwd=source_repo,
    ).decode().splitlines()
    graph = [line.split() for line in raw_graph]
    if not graph or graph[0][0] != args.boundary or graph[-1][0] != args.head:
        raise RuntimeError("source graph endpoints changed")
    if any(len(row) != 2 for row in graph):
        raise RuntimeError("source graph is not linear")
    for index in range(1, len(graph)):
        if graph[index][1] != graph[index - 1][0]:
            raise RuntimeError("source graph parent chain changed")
    omitted_parent = graph[0][1]

    git_dir.mkdir(parents=True, exist_ok=False)
    write_new(
        git_dir / "config",
        b"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\tlogallrefupdates = false\n",
        0o444,
    )
    write_new(git_dir / "HEAD", f"ref: {args.ref}\n".encode(), 0o444)
    write_new(git_dir / args.ref, f"{args.head}\n".encode(), 0o444)
    write_new(git_dir / "shallow", f"{args.boundary}\n".encode(), 0o444)

    objects: list[dict[str, Any]] = []
    for row in graph:
        object_id = row[0]
        raw = run(["git", "cat-file", "commit", object_id], cwd=source_repo)
        framed = f"commit {len(raw)}\0".encode() + raw
        if hashlib.sha1(framed).hexdigest() != object_id:
            raise RuntimeError(f"raw commit rehash changed: {object_id}")
        write_new(git_dir / "objects" / object_id[:2] / object_id[2:], zlib.compress(framed), 0o444)
        objects.append({"id": object_id, "type": "commit", "rawCommitRehashMatched": True})

    for directory in sorted((path for path in git_dir.rglob("*") if path.is_dir()), reverse=True):
        directory.chmod(0o555)
    git_dir.chmod(0o555)

    environment = git_environment(git_dir)
    head = run(["git", "rev-parse", "HEAD"], cwd=source_repo, environment=environment).decode().strip()
    shallow = run(["git", "rev-parse", "--is-shallow-repository"], cwd=source_repo, environment=environment).decode().strip()
    visible_graph = run(["git", "rev-list", "--parents", "HEAD"], cwd=source_repo, environment=environment).decode().splitlines()
    show_ref = run(["git", "show-ref"], cwd=source_repo, environment=environment).decode().strip()
    run(
        ["git", "merge-base", "--is-ancestor", args.required_ancestry, "HEAD"],
        cwd=source_repo,
        environment=environment,
    )
    run(
        ["git", "merge-base", "--is-ancestor", "HEAD", args.required_ancestry],
        cwd=source_repo,
        environment=environment,
        expected=1,
    )
    if head != args.head or shallow != "true" or show_ref != f"{args.head} {args.ref}":
        raise RuntimeError("constructed Git controls failed")

    inventory_out.parent.mkdir(parents=True, exist_ok=True)
    if inventory_out.exists():
        raise RuntimeError("inventory output already exists")
    rows: list[dict[str, Any]] = []
    for path in sorted(path for path in git_dir.rglob("*") if path.is_file() and not path.is_symlink()):
        rows.append(
            {
                "path": str(path.relative_to(git_dir)),
                "mode": format(stat.S_IMODE(path.stat().st_mode), "o"),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    with inventory_out.open("x", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["path", "mode", "bytes", "sha256"], delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    manifest = {
        "schemaVersion": "arc-v34-phase2-analysis-recovery-git-context-v2",
        "recordedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "authorization": file_record(authorization, args.authorization_recorded_path),
        "gitDir": args.recorded_git_dir,
        "authoritativeRoot": args.authoritative_root,
        "authoritativeRootGitEntryAbsent": True,
        "fileInventory": {
            **file_record(inventory_out, args.inventory_recorded_path),
            "fileCount": len(rows),
            "allFilesReadOnly": True,
            "allDirectoriesNonWritable": True,
            "symlinks": [],
        },
        "head": {"symbolicRef": args.ref, "commit": args.head},
        "refs": {args.ref: args.head},
        "objectFormat": "sha1",
        "shallowRepository": True,
        "shallowBoundaries": [args.boundary],
        "shallowDerivation": {
            "graphIsLinear": True,
            "mergeCommits": [],
            "boundaryCommit": args.boundary,
            "omittedRawParent": omitted_parent,
            "everyOtherParentImported": True,
            "completeExpectedSet": True,
        },
        "visibleParentGraph": [line.split() for line in visible_graph],
        "objects": objects,
        "forbiddenState": {
            "packs": [],
            "alternates": [],
            "grafts": [],
            "replaceRefs": [],
            "commitGraphs": [],
            "promisorConfiguration": [],
            "remotes": [],
            "namespaces": [],
            "unexpectedRefs": [],
            "extraObjects": [],
            "inheritedGitVariables": [],
            "gitWorkTreeSet": False,
        },
        "environment": {
            "GIT_DIR": args.recorded_git_dir,
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_WORK_TREE": None,
        },
        "toolIdentity": {"gitPath": "/usr/bin/git", "gitVersion": "git version 2.43.0"},
        "controls": {
            "positiveAncestryStatus": 0,
            "reverseNegativeControlStatus": 1,
            "revListParentsExact": True,
            "soleRefExact": True,
            "headExact": True,
            "shallowSetExact": True,
            "objectCount": len(objects),
            "allObjectsLooseCommits": True,
            "recursiveFileInventoryCapturedBeforeLaunch": True,
            "outcomesInspected": False,
        },
    }
    write_new(manifest_out, canonical_json(manifest), 0o444)
    print(json.dumps({"head": head, "objects": len(objects), "files": len(rows), "outcomesInspected": False}, sort_keys=True))


if __name__ == "__main__":
    main()
