#!/usr/bin/env python3
"""Create the immutable P30 source lock from an authentic shallow Git database."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

from analyze_v35_p30_long_horizon import (
    GIT_CONTEXT_SCHEMA,
    REPO_ROOT,
    SOURCE_FILE_PATHS,
    SOURCE_LOCK_SCHEMA,
    git_object_inventory_sha256,
    git_output,
    git_tree_entries,
    is_git_commit,
    sha256,
    verify_git_context,
)


def build(implementation_commit: str, git_dir: Path) -> dict:
    base_commit = "28c494bddf0fc66d760ad783f24e9556034ce85d"
    git_dir = git_dir.resolve()
    if not is_git_commit(implementation_commit):
        raise ValueError("implementation commit must be a 40-character SHA-1")
    if git_dir == (REPO_ROOT / ".git").resolve():
        raise ValueError("P30 runtime Git context must not be the repository .git directory")
    if not (git_dir / "shallow").is_file():
        raise ValueError("P30 runtime Git context must be an authentic shallow database")
    subprocess.run(
        ["git", f"--git-dir={git_dir}", "fsck", "--full", "--strict"],
        check=True,
        capture_output=True,
        text=True,
    )
    if git_output(git_dir, "cat-file", "-t", implementation_commit).strip() != "commit":
        raise ValueError("implementation object is not a commit")
    if git_output(git_dir, "cat-file", "-t", base_commit).strip() != "commit":
        raise ValueError("implementation base object is not a commit")
    ancestry = subprocess.run(
        [
            "git",
            f"--git-dir={git_dir}",
            "merge-base",
            "--is-ancestor",
            base_commit,
            implementation_commit,
        ],
        capture_output=True,
    )
    if ancestry.returncode != 0:
        raise ValueError("implementation base is not an ancestor of the implementation")
    tree = git_output(git_dir, "rev-parse", f"{implementation_commit}^{{tree}}").strip()
    tree_entries = git_tree_entries(git_dir, implementation_commit)
    files = {}
    for label, relative in SOURCE_FILE_PATHS.items():
        source_path = REPO_ROOT / relative
        entry = tree_entries.get(relative)
        if not source_path.is_file() or entry is None or entry[1] != "blob":
            raise ValueError(f"registered source is absent from the implementation tree: {relative}")
        blob = git_output(git_dir, "cat-file", "blob", entry[2], binary=True)
        assert isinstance(blob, bytes)
        file_sha256 = sha256(source_path)
        if file_sha256 != hashlib.sha256(blob).hexdigest():
            raise ValueError(f"working source differs from implementation blob: {relative}")
        files[label] = {
            "path": relative,
            "sha256": file_sha256,
            "gitBlobOid": entry[2],
        }
    payload = {
        "schemaVersion": SOURCE_LOCK_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "implementationBaseCommit": base_commit,
        "implementationCommit": implementation_commit,
        "gitContext": {
            "schemaVersion": GIT_CONTEXT_SCHEMA,
            "gitDir": str(git_dir),
            "shallow": True,
            "objectFormat": "sha1",
            "baseCommit": base_commit,
            "implementationCommit": implementation_commit,
            "implementationTree": tree,
            "objectInventorySha256": git_object_inventory_sha256(git_dir),
            "registeredPaths": len(set(SOURCE_FILE_PATHS.values())),
        },
        "files": files,
    }
    verify_git_context(payload)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation-commit", required=True)
    parser.add_argument("--git-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    payload = json.dumps(
        build(args.implementation_commit, args.git_dir), indent=2, allow_nan=False
    ) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    print(str(args.out))


if __name__ == "__main__":
    main()
