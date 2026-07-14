#!/usr/bin/env python3
"""Outcome-blind one-shot launcher for the V34 Phase 2 recovery amendment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence


AUTH_SCHEMA = "arc-v34-phase2-analysis-recovery-authorization-v2"
PRELAUNCH_SCHEMA = "arc-v34-phase2-analysis-recovery-prelaunch-v2"
RESERVATION_SCHEMA = "arc-v34-phase2-analysis-recovery-reservation-v2"
STARTED_SCHEMA = "arc-v34-phase2-analysis-recovery-attempt-started-v2"
EXEC_SCHEMA = "arc-v34-phase2-analysis-recovery-exec-confirmed-v2"
EXIT_SCHEMA = "arc-v34-phase2-analysis-recovery-exit-v2"
SELF_TEST_SCHEMA = "arc-v34-phase2-analysis-recovery-launcher-self-test-v2"

ALLOWED_GIT_ENV = {
    "GIT_DIR",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
}

ENV_FINGERPRINT_EXCLUDED = (
    "COLUMNS",
    "DBUS_SESSION_BUS_ADDRESS",
    "LINES",
    "OLDPWD",
    "SHLVL",
    "SSH_AUTH_SOCK",
    "SSH_CLIENT",
    "SSH_CONNECTION",
    "SSH_TTY",
    "TERM",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_ID",
    "_",
)

ENV_FINGERPRINT_SERIALIZATION = (
    "UTF-8 JSON array of [key,value] pairs; excluded keys removed; remaining "
    "keys sorted by Python Unicode code-point order; ensure_ascii=true; "
    "separators=(',',':'); one terminal newline; SHA-256"
)


class RecoveryLaunchError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def canonical_sha256(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RecoveryLaunchError(f"cannot load {label}: {path}") from exc
    if not isinstance(value, dict):
        raise RecoveryLaunchError(f"{label} must be a JSON object")
    return value


def require_exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise RecoveryLaunchError(
            f"{label} keys differ: missing={sorted(expected - actual)} extra={sorted(actual - expected)}"
        )


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def exclusive_json(path: Path, value: Mapping[str, Any], mode: int = 0o444) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = canonical_bytes(value)
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def environment_sha256(environment: Mapping[str, str]) -> str:
    return canonical_sha256([[key, environment[key]] for key in sorted(environment)])


def analysis_environment_sha256(environment: Mapping[str, str]) -> str:
    excluded = set(ENV_FINGERPRINT_EXCLUDED)
    return canonical_sha256([[key, environment[key]] for key in sorted(environment) if key not in excluded])


def resolve_bound_path(repo: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else repo / path


def validate_bound_files(repo: Path, files: Mapping[str, Any]) -> None:
    if not files:
        raise RecoveryLaunchError("authorization has no bound files")
    for label, record in files.items():
        if not isinstance(record, dict):
            raise RecoveryLaunchError(f"bound file {label} is not an object")
        require_exact_keys(record, {"path", "bytes", "sha256"}, f"bound file {label}")
        path = resolve_bound_path(repo, record["path"])
        if not path.is_file() or path.stat().st_size != record["bytes"]:
            raise RecoveryLaunchError(f"bound file missing or size changed: {label}")
        if sha256_file(path) != record["sha256"]:
            raise RecoveryLaunchError(f"bound file hash changed: {label}")


def command_sha256(executable: str, argv: Sequence[str], cwd: str) -> str:
    return canonical_sha256({"executable": executable, "argv": list(argv), "cwd": cwd})


def validate_authorization(path: Path) -> dict[str, Any]:
    value = load_json(path, "recovery authorization")
    if value.get("schemaVersion") != AUTH_SCHEMA or value.get("authorized") is not True:
        raise RecoveryLaunchError("recovery authorization is not open")
    if value.get("maximumCorrectedAnalyzerProcesses") != 1:
        raise RecoveryLaunchError("authorization does not bind exactly one corrected analyzer process")
    if value.get("noFurtherRetryAfterAttemptStarted") is not True:
        raise RecoveryLaunchError("authorization does not close retries after attempt start")
    command = value.get("command")
    paths = value.get("paths")
    git_environment = value.get("gitEnvironment")
    if not isinstance(command, dict) or not isinstance(paths, dict) or not isinstance(git_environment, dict):
        raise RecoveryLaunchError("authorization command, paths, or Git environment is invalid")
    fingerprint = value.get("environmentFingerprint")
    if fingerprint != {
        "excludedVariables": list(ENV_FINGERPRINT_EXCLUDED),
        "serialization": ENV_FINGERPRINT_SERIALIZATION,
        "fullEnvironmentPassedUnchangedExceptGitAdditions": True,
    }:
        raise RecoveryLaunchError("authorization environment fingerprint contract changed")
    require_exact_keys(command, {"executable", "argv", "cwd", "sha256"}, "authorization command")
    require_exact_keys(
        paths,
        {
            "analysisOutput",
            "stdout",
            "stderr",
            "reservation",
            "attemptStarted",
            "execConfirmed",
            "exitRecord",
            "gitDir",
        },
        "authorization paths",
    )
    if set(git_environment) != ALLOWED_GIT_ENV:
        raise RecoveryLaunchError("authorization Git environment allowlist changed")
    if git_environment != {
        "GIT_DIR": paths["gitDir"],
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }:
        raise RecoveryLaunchError("authorization Git environment values changed")
    if "GIT_WORK_TREE" in git_environment:
        raise RecoveryLaunchError("GIT_WORK_TREE is forbidden")
    executable = Path(command["executable"])
    cwd = Path(command["cwd"])
    argv = command["argv"]
    if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise RecoveryLaunchError("authorized executable is not an absolute executable file")
    if not cwd.is_absolute() or not cwd.is_dir() or not isinstance(argv, list) or not argv:
        raise RecoveryLaunchError("authorized cwd or argv is invalid")
    if command_sha256(str(executable), argv, str(cwd)) != command["sha256"]:
        raise RecoveryLaunchError("authorized command hash changed")
    out_indexes = [index for index, arg in enumerate(argv) if arg == "--out"]
    if len(out_indexes) != 1 or out_indexes[0] + 1 >= len(argv):
        raise RecoveryLaunchError("authorized argv does not contain one --out")
    expected_output = resolve_bound_path(cwd, argv[out_indexes[0] + 1]).resolve()
    if expected_output != Path(paths["analysisOutput"]).resolve():
        raise RecoveryLaunchError("analysis output path differs from authorized argv")
    if (cwd / ".git").exists() or (cwd / ".git").is_symlink():
        raise RecoveryLaunchError("authoritative root unexpectedly contains .git")
    validate_bound_files(cwd, value.get("boundFiles", {}))
    return value


def validate_reference(record: Any, path: Path, label: str) -> None:
    if not isinstance(record, dict):
        raise RecoveryLaunchError(f"{label} reference is missing")
    require_exact_keys(record, {"path", "bytes", "sha256"}, f"{label} reference")
    if Path(record["path"]).resolve() != path.resolve():
        raise RecoveryLaunchError(f"{label} path changed")
    if not path.is_file() or path.stat().st_size != record["bytes"] or sha256_file(path) != record["sha256"]:
        raise RecoveryLaunchError(f"{label} reference changed")


def validate_prelaunch(
    path: Path,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    child_environment: Mapping[str, str],
) -> dict[str, Any]:
    value = load_json(path, "prelaunch manifest")
    if value.get("schemaVersion") != PRELAUNCH_SCHEMA or value.get("passed") is not True:
        raise RecoveryLaunchError("prelaunch manifest did not pass")
    validate_reference(value.get("authorization"), authorization_path, "authorization")
    command = authorization["command"]
    if value.get("commandSha256") != command["sha256"]:
        raise RecoveryLaunchError("prelaunch command hash changed")
    if value.get("analysisRelevantEnvironmentSha256") != analysis_environment_sha256(child_environment):
        raise RecoveryLaunchError("prelaunch analysis-relevant environment hash changed")
    if value.get("excludedEnvironmentVariables") != list(ENV_FINGERPRINT_EXCLUDED):
        raise RecoveryLaunchError("prelaunch environment exclusion set changed")
    if value.get("allChecksPassed") is not True or value.get("outcomesInspected") is not False:
        raise RecoveryLaunchError("prelaunch checks or outcome-access attestation is invalid")
    return value


def validate_reservation(
    path: Path,
    authorization_path: Path,
    prelaunch_path: Path,
    authorization: Mapping[str, Any],
) -> dict[str, Any]:
    value = load_json(path, "reservation")
    if value.get("schemaVersion") != RESERVATION_SCHEMA or value.get("reserved") is not True:
        raise RecoveryLaunchError("one-shot reservation is not open")
    validate_reference(value.get("authorization"), authorization_path, "reservation authorization")
    validate_reference(value.get("prelaunch"), prelaunch_path, "reservation prelaunch")
    if value.get("commandSha256") != authorization["command"]["sha256"]:
        raise RecoveryLaunchError("reservation command hash changed")
    if value.get("maximumCorrectedAnalyzerProcesses") != 1:
        raise RecoveryLaunchError("reservation process count changed")
    return value


def process_snapshot(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    proc = Path("/proc") / str(process.pid)
    snapshot: dict[str, Any] = {
        "pid": process.pid,
        "procSnapshotAvailable": proc.exists(),
        "executable": None,
        "cmdlineSha256": None,
        "startTicks": None,
    }
    try:
        snapshot["executable"] = os.readlink(proc / "exe")
        cmdline = (proc / "cmdline").read_bytes()
        snapshot["cmdlineSha256"] = sha256_bytes(cmdline)
        fields = (proc / "stat").read_text().split()
        snapshot["startTicks"] = int(fields[21])
    except (FileNotFoundError, OSError, ValueError, IndexError):
        pass
    return snapshot


def write_failure_record(path: Path, authorization_sha: str, reason: str, stage: str) -> None:
    if path.exists():
        return
    exclusive_json(
        path,
        {
            "schemaVersion": EXIT_SCHEMA,
            "recordedAtUnixNs": time.time_ns(),
            "authorizationSha256": authorization_sha,
            "stage": stage,
            "exitCode": None,
            "succeeded": False,
            "laneAClosed": True,
            "failure": reason,
            "outcomesInspected": False,
        },
    )


def launch(authorization_path: Path, prelaunch_path: Path, reservation_path: Path) -> int:
    authorization_path = authorization_path.resolve()
    prelaunch_path = prelaunch_path.resolve()
    reservation_path = reservation_path.resolve()
    authorization = validate_authorization(authorization_path)
    paths = {key: Path(value) for key, value in authorization["paths"].items()}
    if reservation_path != paths["reservation"].resolve():
        raise RecoveryLaunchError("reservation CLI path differs from authorization")
    inherited_git = sorted(key for key in os.environ if key.startswith("GIT_"))
    if inherited_git:
        raise RecoveryLaunchError(f"inherited Git variables are forbidden: {inherited_git}")
    child_environment = dict(os.environ)
    child_environment.update(authorization["gitEnvironment"])
    validate_prelaunch(prelaunch_path, authorization_path, authorization, child_environment)
    validate_reservation(reservation_path, authorization_path, prelaunch_path, authorization)
    for label in ("attemptStarted", "stdout", "stderr", "execConfirmed", "exitRecord", "analysisOutput"):
        if paths[label].exists() or paths[label].is_symlink():
            raise RecoveryLaunchError(f"authorized one-shot path already exists: {label}")
    authorization_sha = sha256_file(authorization_path)
    prelaunch_sha = sha256_file(prelaunch_path)
    reservation_sha = sha256_file(reservation_path)
    started = {
        "schemaVersion": STARTED_SCHEMA,
        "startedAtUnixNs": time.time_ns(),
        "authorizationSha256": authorization_sha,
        "prelaunchSha256": prelaunch_sha,
        "reservationSha256": reservation_sha,
        "commandSha256": authorization["command"]["sha256"],
        "analysisRelevantEnvironmentSha256": analysis_environment_sha256(child_environment),
        "fullChildEnvironmentSha256": environment_sha256(child_environment),
        "excludedEnvironmentVariables": list(ENV_FINGERPRINT_EXCLUDED),
        "launcherPid": os.getpid(),
        "slotConsumed": True,
        "outcomesInspected": False,
    }
    exclusive_json(paths["attemptStarted"], started)
    stdout_descriptor: int | None = None
    stderr_descriptor: int | None = None
    process: subprocess.Popen[bytes] | None = None
    try:
        stdout_descriptor = os.open(paths["stdout"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        stderr_descriptor = os.open(paths["stderr"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        command = authorization["command"]
        process = subprocess.Popen(
            [command["executable"], *command["argv"]],
            cwd=command["cwd"],
            env=child_environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout_descriptor,
            stderr=stderr_descriptor,
            close_fds=True,
        )
        snapshot = process_snapshot(process)
        executable_expected = str(Path(command["executable"]).resolve())
        if snapshot["executable"] is not None and str(Path(snapshot["executable"]).resolve()) != executable_expected:
            raise RecoveryLaunchError("exec-confirmed executable differs from authorization")
        stdout_stat = os.fstat(stdout_descriptor)
        exec_record = {
            "schemaVersion": EXEC_SCHEMA,
            "confirmedAtUnixNs": time.time_ns(),
            "authorizationSha256": authorization_sha,
            "prelaunchSha256": prelaunch_sha,
            "reservationSha256": reservation_sha,
            "attemptStartedSha256": sha256_file(paths["attemptStarted"]),
            "commandSha256": command["sha256"],
            "analysisRelevantEnvironmentSha256": analysis_environment_sha256(child_environment),
            "fullChildEnvironmentSha256": environment_sha256(child_environment),
            "excludedEnvironmentVariables": list(ENV_FINGERPRINT_EXCLUDED),
            "stdoutDevice": stdout_stat.st_dev,
            "stdoutInode": stdout_stat.st_ino,
            "popenReturnedAfterExecHandshake": True,
            "process": snapshot,
            "outcomesInspected": False,
        }
        exclusive_json(paths["execConfirmed"], exec_record)
        exit_code = process.wait()
        os.fsync(stdout_descriptor)
        os.fsync(stderr_descriptor)
        os.fchmod(stdout_descriptor, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        os.fchmod(stderr_descriptor, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        fsync_directory(paths["stdout"].parent)
        exit_record = {
            "schemaVersion": EXIT_SCHEMA,
            "recordedAtUnixNs": time.time_ns(),
            "authorizationSha256": authorization_sha,
            "prelaunchSha256": prelaunch_sha,
            "reservationSha256": reservation_sha,
            "attemptStartedSha256": sha256_file(paths["attemptStarted"]),
            "execConfirmedSha256": sha256_file(paths["execConfirmed"]),
            "commandSha256": command["sha256"],
            "analysisRelevantEnvironmentSha256": analysis_environment_sha256(child_environment),
            "fullChildEnvironmentSha256": environment_sha256(child_environment),
            "excludedEnvironmentVariables": list(ENV_FINGERPRINT_EXCLUDED),
            "exitCode": exit_code,
            "succeeded": exit_code == 0,
            "laneAClosed": exit_code != 0,
            "stdoutBytes": os.fstat(stdout_descriptor).st_size,
            "stderrBytes": os.fstat(stderr_descriptor).st_size,
            "outputInspected": False,
        }
        exclusive_json(paths["exitRecord"], exit_record)
        return exit_code
    except BaseException as exc:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        write_failure_record(paths["exitRecord"], authorization_sha, f"{type(exc).__name__}: {exc}", "after-attempt-started")
        raise
    finally:
        if stdout_descriptor is not None:
            os.close(stdout_descriptor)
        if stderr_descriptor is not None:
            os.close(stderr_descriptor)


def self_test(directory: Path) -> int:
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    reservation = directory / "reservation.json"
    started = directory / "attempt-started.json"
    stdout_path = directory / "stdout"
    stderr_path = directory / "stderr"
    exec_path = directory / "exec-confirmed.json"
    exit_path = directory / "exit.json"
    exclusive_json(reservation, {"schemaVersion": RESERVATION_SCHEMA, "reserved": True})
    exclusive_json(started, {"schemaVersion": STARTED_SCHEMA, "slotConsumed": True})
    stdout_descriptor = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    stderr_descriptor = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdout.write('safe-self-test\\n'); sys.stderr.write('safe-self-test\\n')"],
            stdin=subprocess.DEVNULL,
            stdout=stdout_descriptor,
            stderr=stderr_descriptor,
            close_fds=True,
        )
        snapshot = process_snapshot(process)
        exclusive_json(
            exec_path,
            {
                "schemaVersion": EXEC_SCHEMA,
                "popenReturnedAfterExecHandshake": True,
                "process": snapshot,
                "outcomesInspected": False,
            },
        )
        exit_code = process.wait()
        os.fsync(stdout_descriptor)
        os.fsync(stderr_descriptor)
        exclusive_json(
            exit_path,
            {
                "schemaVersion": EXIT_SCHEMA,
                "exitCode": exit_code,
                "succeeded": exit_code == 0,
                "outputInspected": False,
            },
        )
    finally:
        os.close(stdout_descriptor)
        os.close(stderr_descriptor)
    result = {
        "schemaVersion": SELF_TEST_SCHEMA,
        "passed": exit_code == 0,
        "reservationExists": reservation.is_file(),
        "attemptStartedExists": started.is_file(),
        "stdoutCreatedExclusively": stdout_path.is_file(),
        "stderrCreatedExclusively": stderr_path.is_file(),
        "execConfirmedExists": exec_path.is_file(),
        "exitRecordExists": exit_path.is_file(),
        "outcomesInspected": False,
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if result["passed"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    launch_parser = subparsers.add_parser("launch")
    launch_parser.add_argument("--authorization", type=Path, required=True)
    launch_parser.add_argument("--prelaunch", type=Path, required=True)
    launch_parser.add_argument("--reservation", type=Path, required=True)
    self_test_parser = subparsers.add_parser("self-test")
    self_test_parser.add_argument("--directory", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        if args.command == "launch":
            status = launch(args.authorization, args.prelaunch, args.reservation)
        else:
            status = self_test(args.directory)
    except RecoveryLaunchError as exc:
        print(f"recovery launcher rejected: {exc}", file=sys.stderr)
        status = 2
    raise SystemExit(status)


if __name__ == "__main__":
    main()
