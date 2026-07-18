#!/usr/bin/env python3
"""Create the outcome-blind immediate-prelaunch manifest for V34 recovery."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import resource
import shutil
import stat
import subprocess
import sys
import time
from typing import Any, Iterable, Mapping

try:
    from .run_v34_phase2_analysis_recovery import (
        ENV_FINGERPRINT_EXCLUDED,
        ENV_FINGERPRINT_SERIALIZATION,
        PRELAUNCH_SCHEMA,
        REVISION1_GIT_DIR,
        REVISION1_HEAD,
        analysis_environment_sha256,
        environment_sha256,
        exclusive_json,
        fsync_directory,
        sha256_file,
        validate_authorization,
    )
except ImportError:
    from run_v34_phase2_analysis_recovery import (
        ENV_FINGERPRINT_EXCLUDED,
        ENV_FINGERPRINT_SERIALIZATION,
        PRELAUNCH_SCHEMA,
        REVISION1_GIT_DIR,
        REVISION1_HEAD,
        analysis_environment_sha256,
        environment_sha256,
        exclusive_json,
        fsync_directory,
        sha256_file,
        validate_authorization,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def file_record(path: Path) -> dict[str, Any]:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def validate_embedded_file_record(record: Any, expected: Path, repo: Path, label: str) -> None:
    require(isinstance(record, dict), f"{label} record is missing")
    require({"path", "bytes", "sha256"}.issubset(record), f"{label} record is incomplete")
    path = Path(record["path"])
    path = path if path.is_absolute() else repo / path
    require(path.resolve() == expected.resolve(), f"{label} path does not bind the supplied file")
    require(expected.is_file(), f"{label} file is missing")
    require(expected.stat().st_size == record["bytes"], f"{label} size changed")
    require(sha256_file(expected) == record["sha256"], f"{label} hash changed")


def run(
    argv: list[str],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    expected: int = 0,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=dict(environment),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    require(result.returncode == expected, f"command status changed: {argv[0]} expected {expected} got {result.returncode}")
    return result


def validate_inventory(git_dir: Path, inventory_path: Path) -> dict[str, Any]:
    with inventory_path.open(newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))
    expected_paths = {row["path"] for row in rows}
    actual_paths = {
        str(path.relative_to(git_dir))
        for path in git_dir.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    require(actual_paths == expected_paths, "Git-context file inventory changed")
    for row in rows:
        path = git_dir / row["path"]
        require(not path.is_symlink(), f"Git-context symlink found: {row['path']}")
        require(path.stat().st_size == int(row["bytes"]), f"Git-context size changed: {row['path']}")
        mode = format(stat.S_IMODE(path.stat().st_mode), "o")
        require(mode == row["mode"], f"Git-context mode changed: {row['path']}")
        require(sha256_file(path) == row["sha256"], f"Git-context hash changed: {row['path']}")
    writable = [str(path) for path in git_dir.rglob("*") if stat.S_IMODE(path.stat().st_mode) & 0o222]
    require(not writable, "Git context is writable")
    symlinks = [str(path) for path in git_dir.rglob("*") if path.is_symlink()]
    require(not symlinks, "Git context contains symlinks")
    return {"files": len(rows), "allHashesExact": True, "readOnly": True, "symlinks": []}


def walk_file_records(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        if {"path", "bytes", "sha256"}.issubset(value):
            yield value
        for child in value.values():
            yield from walk_file_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_file_records(child)


def validate_completion_inputs(repo: Path, authorization: Mapping[str, Any]) -> dict[str, Any]:
    labels = [
        "completionRaw",
        "completionP025",
        "completionP050",
        "completionP075",
        "completionP100",
        "completionHeuristicS4H2",
        "completionHeuristicS8H3",
    ]
    require(all(label in authorization["boundFiles"] for label in labels), "authorization no longer binds seven completion manifests")
    records = 0
    unique_paths: set[Path] = set()
    for label in labels:
        completion = repo / authorization["boundFiles"][label]["path"]
        value = json.loads(completion.read_text())
        for record in walk_file_records(value):
            path = Path(record["path"])
            path = path if path.is_absolute() else repo / path
            path = path.resolve()
            if path in unique_paths:
                continue
            require(path.is_file() and os.access(path, os.R_OK), f"completion input is not readable: {path}")
            require(path.stat().st_size == record["bytes"], f"completion input size changed: {path}")
            require(sha256_file(path) == record["sha256"], f"completion input hash changed: {path}")
            unique_paths.add(path)
            records += 1
    return {"completionManifests": 7, "uniqueReferencedFiles": records, "allReadableAndHashExact": True}


def atomic_write_probe(directory: Path, name: str) -> None:
    path = directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, b"outcome-blind-writability-probe\n")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    path.unlink()
    fsync_directory(directory)


def tool_identity(argv: list[str], cwd: Path, environment: Mapping[str, str]) -> dict[str, Any]:
    path = shutil.which(argv[0], path=environment.get("PATH"))
    require(path is not None, f"tool not found: {argv[0]}")
    result = run(argv, cwd=cwd, environment=environment)
    return {"path": str(Path(path).resolve()), "version": result.stdout.decode().strip()}


def create_manifest(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repo.resolve()
    authorization_path = args.authorization.resolve()
    git_context_path = args.git_context.resolve()
    git_inventory_path = args.git_inventory.resolve()
    out = args.out.resolve()
    self_test_dir = args.self_test_dir.resolve()
    require(not out.exists() and not out.is_symlink(), "prelaunch manifest already exists")
    require(not self_test_dir.exists(), "launcher self-test directory already exists")
    inherited_git = sorted(key for key in os.environ if key.startswith("GIT_"))
    require(not inherited_git, f"inherited Git variables found: {inherited_git}")
    authorization = validate_authorization(authorization_path)
    git_context = json.loads(git_context_path.read_text())
    validate_embedded_file_record(git_context.get("authorization"), authorization_path, repo, "Git-context authorization")
    validate_embedded_file_record(git_context.get("fileInventory"), git_inventory_path, repo, "Git-context inventory")
    git_dir = Path(authorization["paths"]["gitDir"])
    require(git_context.get("gitDir") == str(git_dir), "Git-context manifest path changed")
    require(str(git_dir) != REVISION1_GIT_DIR, "revision-1 Git database cannot be reused")
    require(not (repo / ".git").exists() and not (repo / ".git").is_symlink(), "authoritative root contains .git")
    child_environment = dict(os.environ)
    child_environment.update(authorization["gitEnvironment"])
    require("GIT_WORK_TREE" not in child_environment, "GIT_WORK_TREE is set")

    inventory = validate_inventory(git_dir, git_inventory_path)
    git = ["git", "-C", str(repo)]
    head = run([*git, "rev-parse", "HEAD"], cwd=repo, environment=child_environment).stdout.decode().strip()
    expected_head = git_context["head"]["commit"]
    expected_ref = git_context["head"]["symbolicRef"]
    require(expected_head != REVISION1_HEAD, "revision-1 Git-context HEAD cannot be reused")
    require(head == expected_head, "Git-context HEAD changed")
    shallow = run([*git, "rev-parse", "--is-shallow-repository"], cwd=repo, environment=child_environment).stdout.decode().strip()
    require(shallow == "true", "Git context is not shallow")
    parent_graph = run([*git, "rev-list", "--parents", "HEAD"], cwd=repo, environment=child_environment).stdout.decode().splitlines()
    expected_graph = [" ".join(row) for row in git_context["visibleParentGraph"]]
    require(parent_graph == expected_graph, "Git parent graph changed")
    run(
        [*git, "merge-base", "--is-ancestor", authorization["requiredAncestryCommit"], "HEAD"],
        cwd=repo,
        environment=child_environment,
    )
    run(
        [*git, "merge-base", "--is-ancestor", "HEAD", authorization["requiredAncestryCommit"]],
        cwd=repo,
        environment=child_environment,
        expected=1,
    )
    show_ref = run([*git, "show-ref"], cwd=repo, environment=child_environment).stdout.decode().strip()
    require(show_ref == f"{head} {expected_ref}", "Git refs changed")
    for record in git_context["objects"]:
        object_id = record["id"]
        object_type = run([*git, "cat-file", "-t", object_id], cwd=repo, environment=child_environment).stdout.decode().strip()
        require(object_type == "commit", f"unexpected Git object type: {object_id}")
        raw = run([*git, "cat-file", "commit", object_id], cwd=repo, environment=child_environment).stdout
        rehashed = subprocess.run(
            ["git", "hash-object", "-t", "commit", "--stdin"],
            cwd=repo,
            env=child_environment,
            input=raw,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        require(rehashed.returncode == 0 and rehashed.stdout.decode().strip() == object_id, f"raw commit rehash changed: {object_id}")

    completion_inputs = validate_completion_inputs(repo, authorization)
    analyzer_import = run(
        [
            authorization["command"]["executable"],
            "-B",
            "-c",
            "import sys; sys.path.insert(0, 'ml'); import analyze_v34_phase2",
        ],
        cwd=repo,
        environment=os.environ,
    )
    require(not analyzer_import.stdout and not analyzer_import.stderr, "analyzer import emitted output")
    run(["node", "scripts/verify-v34-strength-chain.mjs", "phase2"], cwd=repo, environment=os.environ)
    run(["node", "scripts/verify-v34-guardian-chain.mjs", "tooling"], cwd=repo, environment=os.environ)
    run(
        [authorization["command"]["executable"], "-B", "-m", "unittest", "ml.test_run_v34_phase2_analysis_recovery"],
        cwd=repo,
        environment=os.environ,
    )
    self_test = run(
        [
            authorization["command"]["executable"],
            "-B",
            "ml/run_v34_phase2_analysis_recovery.py",
            "self-test",
            "--directory",
            str(self_test_dir),
        ],
        cwd=repo,
        environment=os.environ,
    )
    self_test_value = json.loads(self_test.stdout)
    require(self_test_value.get("passed") is True and self_test_value.get("outcomesInspected") is False, "launcher self-test failed")

    paths = {key: Path(value) for key, value in authorization["paths"].items()}
    for label in (
        "analysisOutput",
        "prelaunch",
        "stdout",
        "stderr",
        "reservation",
        "attemptStarted",
        "execConfirmed",
        "exitRecord",
    ):
        require(not paths[label].exists() and not paths[label].is_symlink(), f"one-shot path exists before reservation: {label}")
    require(out == paths["prelaunch"].resolve(), "prelaunch output path differs from authorization")
    original_stdout = repo / "ml/experiments/v34-latency-first-expert-iteration/artifacts/phase2-analysis.stdout"
    require(original_stdout.is_file() and original_stdout.stat().st_size == 0, "attempt-1 stdout changed")
    artifact_dir = paths["analysisOutput"].parent
    atomic_write_probe(artifact_dir, f".v34-prelaunch-write-{os.getpid()}")
    atomic_write_probe(Path("/tmp"), f".v34-prelaunch-write-{os.getpid()}")
    persistent = shutil.disk_usage(artifact_dir)
    scratch = shutil.disk_usage("/tmp")
    require(persistent.free >= 1_000_000_000, "persistent disk headroom below 1 GB")
    require(scratch.free >= 1_000_000_000, "scratch disk headroom below 1 GB")
    meminfo: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, raw = line.split(":", 1)
        meminfo[key] = int(raw.strip().split()[0]) * 1024
    require(meminfo["MemAvailable"] >= 2_000_000_000, "available RAM below 2 GB")
    fd_soft, fd_hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    require(fd_soft >= 1024, "file descriptor limit below 1024")

    strength_lock = json.loads((repo / authorization["boundFiles"]["strengthToolingLock"]["path"]).read_text())
    guardian_lock = json.loads((repo / authorization["boundFiles"]["guardianToolingLock"]["path"]).read_text())
    require(strength_lock["authorization"]["phase2ExecutionOpen"] is True, "Phase 2 execution unexpectedly closed")
    require(all(value is False for key, value in strength_lock["authorization"].items() if key != "phase2ExecutionOpen"), "later strength flags opened")
    require(all(value is False for value in guardian_lock["authorization"].values()), "guardian or later flags opened")

    git_identity = tool_identity(["git", "--version"], repo, child_environment)
    node_identity = tool_identity(["node", "--version"], repo, os.environ)
    python_version = run([authorization["command"]["executable"], "--version"], cwd=repo, environment=os.environ)
    numpy_version = run(
        [authorization["command"]["executable"], "-c", "import numpy; print(numpy.__version__)"],
        cwd=repo,
        environment=os.environ,
    )
    checks = {
        "authorizationBoundFilesExact": True,
        "gitContext": inventory,
        "head": head,
        "shallow": True,
        "parentGraphExact": True,
        "positiveAncestryStatus": 0,
        "reverseNegativeControlStatus": 1,
        "objectCount": len(git_context["objects"]),
        "allObjectsLooseCommitsAndRehashExact": True,
        "completionInputs": completion_inputs,
        "analyzerImportPassed": True,
        "strengthChainPassed": True,
        "guardianToolingChainPassed": True,
        "launcherUnitTestsPassed": True,
        "launcherSelfTest": self_test_value,
        "allOneShotPathsAbsent": True,
        "attempt1StdoutStillZeroBytes": True,
        "laterAuthorizationFlagsClosed": True,
        "outputDirectoryAtomicWriteProbePassed": True,
        "tmpAtomicWriteProbePassed": True,
        "persistentFreeBytes": persistent.free,
        "scratchFreeBytes": scratch.free,
        "availableRamBytes": meminfo["MemAvailable"],
        "fileDescriptorSoftLimit": fd_soft,
        "fileDescriptorHardLimit": fd_hard,
    }
    manifest = {
        "schemaVersion": PRELAUNCH_SCHEMA,
        "recordedAtUnixNs": time.time_ns(),
        "passed": True,
        "allChecksPassed": True,
        "authorization": file_record(authorization_path),
        "gitContext": file_record(git_context_path),
        "gitInventory": file_record(git_inventory_path),
        "preflightGenerator": file_record(Path(__file__).resolve()),
        "commandSha256": authorization["command"]["sha256"],
        "analysisRelevantEnvironmentSha256": analysis_environment_sha256(child_environment),
        "fullChildEnvironmentSha256": environment_sha256(child_environment),
        "excludedEnvironmentVariables": list(ENV_FINGERPRINT_EXCLUDED),
        "environment": {
            "path": os.environ.get("PATH"),
            "inheritedVariableCount": len(os.environ),
            "inheritedGitVariables": [],
            "gitAdditions": authorization["gitEnvironment"],
            "gitWorkTree": None,
            "fingerprintExcludedVariables": list(ENV_FINGERPRINT_EXCLUDED),
            "fingerprintSerialization": ENV_FINGERPRINT_SERIALIZATION,
        },
        "toolIdentity": {
            "git": git_identity,
            "node": node_identity,
            "pythonPath": str(Path(authorization["command"]["executable"]).resolve()),
            "pythonVersion": python_version.stdout.decode().strip(),
            "numpyVersion": numpy_version.stdout.decode().strip(),
        },
        "checks": checks,
        "outcomesInspected": False,
    }
    exclusive_json(out, manifest)
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--git-context", type=Path, required=True)
    parser.add_argument("--git-inventory", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--self-test-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    manifest = create_manifest(parse_args())
    print(
        json.dumps(
            {
                "schemaVersion": manifest["schemaVersion"],
                "passed": manifest["passed"],
                "analysisRelevantEnvironmentSha256": manifest["analysisRelevantEnvironmentSha256"],
                "fullChildEnvironmentSha256": manifest["fullChildEnvironmentSha256"],
                "outcomesInspected": manifest["outcomesInspected"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
