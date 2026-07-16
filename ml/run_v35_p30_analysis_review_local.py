#!/usr/bin/env python3
"""Exactly-once, source-locked local launcher for the final P30 Fable gate.

No report/replay/outcome is copied locally.  Before Fable starts, a request-bound
attempt is durably created with O_EXCL on SimForge.  A model-launch or review
failure closes the lane; signing/upload may resume only from immutable captured
bytes without rerunning Fable.  Fable runs as an unprivileged process in a digest-pinned, read-only
Linux container with only the metric-free capsule mounted read-only.  OAuth is
delivered on inherited stdin, never through container configuration or disk.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import secrets
import shlex
import stat
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Mapping, Sequence

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from run_v35_p30_local_custody import DEFAULT_CONFIG, load_config
from v35_p30_analysis_review import (
    ANALYSIS_REVIEW_ATTEMPT_SCHEMA,
    ANALYSIS_REVIEW_RECEIPT_SCHEMA,
    APPROVED_CLAUDE_EXECUTABLE,
    APPROVED_REVIEW_CONTAINER,
    APPROVED_REVIEW_RUNTIME,
    CLAUDE_AUTH_DELIVERY,
    CLOCK_SKEW_SCHEMA,
    CONTAINER_REVIEW_ROOT,
    LOCAL_REVIEW_LAUNCHER_RELATIVE,
    REVIEW_LIVENESS_PROMPT,
    REVIEW_LIVENESS_SCHEMA,
    REVIEW_LIVENESS_STDOUT,
    SANITIZED_ENVIRONMENT_KEYS,
    expected_container_cleanup_argv,
    expected_container_config,
    expected_container_create_argv,
    expected_container_start_argv,
    expected_argv,
    liveness_claude_argv,
    validate_authenticated_liveness,
    validate_clock_skew_preflight,
    validate_local_analysis_review_payload,
    validate_signed_local_analysis_review_payload,
)
from v35_p30_crypto import (
    SIGNATURE_SCHEMA,
    atomic_write_exclusive,
    canonical_json,
    public_key_identity,
    read_regular_nofollow,
    sha256_bytes,
    sha256_file,
)


REMOTE = "simforge1"
REMOTE_REPO = "/data/share8/michaelvuaprilexperimentation/arc-bot"
REMOTE_LEDGER_PREFIX = Path("/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger")
MAXIMUM_INPUT_BYTES = 64 * 1024 * 1024
MAXIMUM_SECRET_BYTES = 1024 * 1024
SAFE_REMOTE_PATH = re.compile(r"^/[A-Za-z0-9._/-]+$")
REVIEW_COMPLETION_SCHEMA = "arc-v35-p30-local-review-completion-v1"
POSTPROCESS_MARKER_SCHEMA = "arc-v35-p30-local-review-postprocess-v1"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(read_regular_nofollow(path, maximum_bytes=MAXIMUM_INPUT_BYTES))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is not canonical JSON input") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _validate_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise ValueError(f"{label} is not SHA-256")
    return value


def _validate_remote_path(value: Any, label: str, *, under_ledger: bool = True) -> Path:
    if not isinstance(value, str) or not SAFE_REMOTE_PATH.fullmatch(value):
        raise ValueError(f"{label} is not a safe absolute remote path")
    path = Path(value)
    if ".." in path.parts:
        raise ValueError(f"{label} contains traversal")
    if under_ledger and REMOTE_LEDGER_PREFIX not in path.parents:
        raise ValueError(f"{label} is outside the P30 ledger")
    return path


def validate_scheduler_status(
    value: Mapping[str, Any], *, expected_status: str = "analysis-review-required"
) -> dict[str, Any]:
    expected = {
        "schemaVersion", "status", "manifest", "authorizationDraft",
        "reviewReceiptPath", "reviewAttemptPath", "reviewStdoutPath",
        "reviewStderrPath", "reviewAttestationRequest", "reviewAttesterPublicKey",
        "claudeExecutable", "reviewRuntime", "launcherSha256",
        "outcomesInspected", "promotionEligible",
    }
    if expected_status == "analysis-review-postprocess-required":
        expected.add("reviewAttemptSha256")
    if set(value) != expected:
        raise ValueError("remote P30 analysis-review scheduler status keys changed")
    if (
        value.get("schemaVersion") != "arc-v35-p30-campaign-status-v1"
        or value.get("status") != expected_status
        or value.get("outcomesInspected") is not False
        or value.get("promotionEligible") is not False
    ):
        raise ValueError("remote scheduler is not at the sealed analysis-review gate")
    for field in (
        "manifest", "authorizationDraft", "reviewAttestationRequest", "reviewAttesterPublicKey"
    ):
        binding = value.get(field)
        if not isinstance(binding, dict) or set(binding) != {"path", "sha256"}:
            raise ValueError(f"scheduler {field} binding changed")
        _validate_remote_path(
            binding["path"], field, under_ledger=field != "reviewAttesterPublicKey"
        )
        _validate_sha256(binding["sha256"], field)
    for field in ("reviewReceiptPath", "reviewAttemptPath", "reviewStdoutPath", "reviewStderrPath"):
        _validate_remote_path(value[field], field)
    if value.get("claudeExecutable") != APPROVED_CLAUDE_EXECUTABLE:
        raise ValueError("scheduler Claude executable pin changed")
    if (
        value.get("reviewRuntime") != APPROVED_REVIEW_RUNTIME
        or value.get("launcherSha256")
        != sha256_file(Path(__file__).resolve().parents[1] / LOCAL_REVIEW_LAUNCHER_RELATIVE)
    ):
        raise ValueError("scheduler review runtime or launcher pin changed")
    if expected_status == "analysis-review-postprocess-required":
        _validate_sha256(value.get("reviewAttemptSha256"), "review attempt")
    parents = {Path(value[field]).parent for field in (
        "reviewReceiptPath", "reviewAttemptPath", "reviewStdoutPath", "reviewStderrPath"
    )}
    if len(parents) != 1:
        raise ValueError("scheduler review artifacts do not share one ledger directory")
    return dict(value)


def scheduler_status(
    *, remote: str, remote_repo: str, remote_protocol: str, timeout: int,
    expected_status: str = "analysis-review-required",
) -> dict[str, Any]:
    if remote != REMOTE or remote_repo != REMOTE_REPO:
        raise ValueError("P30 local review remote identity changed")
    _validate_remote_path(remote_protocol, "remote protocol", under_ledger=False)
    argv = ["ml/.venv/bin/python", "ml/run_v35_p30_campaign.py", "--protocol", remote_protocol]
    command = f"cd {shlex.quote(remote_repo)} && exec {shlex.join(argv)}"
    completed = subprocess.run(
        ["ssh", "-T", "-o", "LogLevel=ERROR", remote, command],
        check=True, capture_output=True, timeout=timeout,
    )
    if completed.stderr:
        raise RuntimeError("remote P30 scheduler emitted stderr")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("remote P30 scheduler emitted unexpected output")
    return validate_scheduler_status(json.loads(lines[0]), expected_status=expected_status)


def remote_clock_preflight(*, remote: str, timeout: int) -> dict[str, Any]:
    before = dt.datetime.now(dt.timezone.utc)
    completed = subprocess.run(
        [
            "ssh", "-T", "-o", "LogLevel=ERROR", remote,
            "python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec=\"microseconds\").replace(\"+00:00\",\"Z\"))'",
        ],
        capture_output=True, timeout=timeout, check=True,
    )
    after = dt.datetime.now(dt.timezone.utc)
    lines = [line.decode("ascii") for line in completed.stdout.splitlines() if line.strip()]
    if completed.stderr or len(lines) != 1:
        raise ValueError("P30 remote clock probe changed")
    remote_time = dt.datetime.fromisoformat(lines[0].replace("Z", "+00:00"))
    midpoint = before + (after - before) / 2
    value = {
        "schemaVersion": CLOCK_SKEW_SCHEMA, "valid": True,
        "localBeforeUtc": before.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "remoteUtc": remote_time.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "localAfterUtc": after.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "roundTripMs": round((after - before).total_seconds() * 1000),
        "absoluteSkewMs": round(abs((remote_time - midpoint).total_seconds()) * 1000),
    }
    validate_clock_skew_preflight(value)
    return value


def _mkdir_exclusive(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.mkdir(path, 0o700)
    metadata = path.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ValueError("P30 analysis review capsule is not private")


def _copy_local_exclusive(source: Path, target: Path) -> None:
    atomic_write_exclusive(target, read_regular_nofollow(source), mode=0o400)


def fetch_remote_file(*, remote: str, remote_path: str, target: Path, expected_sha256: str, timeout: int) -> None:
    _validate_remote_path(remote_path, "P30 review input")
    if target.exists():
        raise FileExistsError(f"P30 review local input already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        ["scp", "-q", f"{remote}:{remote_path}", str(target)],
        check=True, capture_output=True, timeout=timeout,
    )
    if completed.stdout or completed.stderr:
        target.unlink(missing_ok=True)
        raise RuntimeError("P30 review scp emitted unexpected output")
    os.chmod(target, 0o400)
    if sha256_file(target) != expected_sha256:
        target.unlink(missing_ok=True)
        raise ValueError("P30 review input differs from scheduler-declared hash")


def validate_source_lock(source_lock_path: Path, *, repo_root: Path) -> dict[str, Any]:
    source_lock = read_json(source_lock_path, "local P30 source lock")
    if (
        source_lock.get("schemaVersion") != "arc-v35-p30-source-lock-v1"
        or source_lock.get("authorized") is not True
        or source_lock.get("immutable") is not True
        or source_lock.get("promotionEligible") is not False
        or not isinstance(source_lock.get("files"), dict)
    ):
        raise ValueError("local P30 source lock is not authorized and immutable")
    required = {
        LOCAL_REVIEW_LAUNCHER_RELATIVE,
        "ml/v35_p30_analysis_review.py",
        "ml/v35_p30_crypto.py",
        "ml/run_v35_p30_local_custody.py",
        "ml/docker/p30-fable-reviewer.Dockerfile",
        "ml/docker/p30-fable-reviewer.lock.json",
    }
    entries = {
        str(entry["path"]): entry
        for entry in source_lock["files"].values()
        if isinstance(entry, dict) and entry.get("path") in required
    }
    if set(entries) != required:
        raise ValueError("local P30 source lock omits the review launcher closure")
    for relative, entry in entries.items():
        expected = _validate_sha256(entry.get("sha256"), f"source lock {relative}")
        path = repo_root / relative
        if not path.is_file() or sha256_file(path) != expected:
            raise ValueError(f"source-locked P30 review file changed: {relative}")
    return source_lock


def validate_metric_free_manifest_envelope(manifest: Mapping[str, Any]) -> None:
    if (
        manifest.get("schemaVersion") != "arc-v35-p30-analysis-manifest-v1"
        or manifest.get("valid") is not True
        or manifest.get("immutable") is not True
        or manifest.get("promotionEligible") is not False
        or manifest.get("outcomesInspected") is not False
        or manifest.get("metricsIncluded") is not False
        or not isinstance(manifest.get("reports"), list)
    ):
        raise ValueError("scheduler manifest is not the metric-free signed artifact")
    signature = manifest.get("signature")
    if not isinstance(signature, dict) or signature.get("role") != "guardian":
        raise ValueError("metric-free manifest signature envelope changed")
    unsigned = dict(manifest)
    del unsigned["signature"]
    if signature.get("payloadSha256") != sha256_bytes(canonical_json(unsigned)):
        raise ValueError("metric-free manifest signature binding changed")
    forbidden = {
        "wins", "losses", "winRate", "trueWinRate", "lateGameScore",
        "victoryPoints", "selectedArm", "score", "scores", "elo", "vp",
        "vpTotal", "round30Wins", "postRound15Vp", "selection", "ranking",
    }
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            if forbidden & set(value):
                raise ValueError("metric-free manifest contains outcome metrics")
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(unsigned)


def validate_downloaded_inputs(
    *, status: Mapping[str, Any], manifest_path: Path, draft_path: Path,
    request_path: Path, source_lock_path: Path, review_attester_public_key_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest = read_json(manifest_path, "local metric-free manifest copy")
    draft = read_json(draft_path, "local analysis authorization draft copy")
    request = read_json(request_path, "local review-attester request copy")
    validate_metric_free_manifest_envelope(manifest)
    if any(
        sha256_file(path) != status[field]["sha256"]
        for path, field in ((manifest_path, "manifest"), (draft_path, "authorizationDraft"), (request_path, "reviewAttestationRequest"))
    ):
        raise ValueError("downloaded P30 review input hash changed")
    if sha256_file(review_attester_public_key_path) != status["reviewAttesterPublicKey"]["sha256"]:
        raise ValueError("local review-attester public key differs from scheduler trust root")
    subject = draft.get("subject")
    isolation = draft.get("isolation")
    source = draft.get("sourceContract")
    if (
        draft.get("schemaVersion") != "arc-v35-p30-execution-authorization-v1"
        or draft.get("authorized") is not True or draft.get("kind") != "analysis"
        or not isinstance(subject, dict)
        or subject.get("inputManifestPath") != status["manifest"]["path"]
        or subject.get("inputManifestSha256") != status["manifest"]["sha256"]
        or subject.get("outcomesInspected") is not False
        or not isinstance(isolation, dict) or isolation.get("network") != "none"
        or isolation.get("gpuMode") != "none" or isolation.get("gpuUuid") is not None
        or not isinstance(source, dict) or source.get("sha256") != sha256_file(source_lock_path)
    ):
        raise ValueError("analysis authorization draft is not the frozen one-shot target")
    request_subject = request.get("subject")
    if (
        not isinstance(request_subject, dict)
        or request.get("role") != "review-attester" or request.get("verb") != "attest-analysis-review"
        or request.get("expectedOutputPath") != status["reviewReceiptPath"]
        or request_subject.get("authorizationDraft") != status["authorizationDraft"]
        or request_subject.get("manifest") != status["manifest"]
        or request_subject.get("reviewAttemptPath") != status["reviewAttemptPath"]
        or request_subject.get("reviewStdoutPath") != status["reviewStdoutPath"]
        or request_subject.get("reviewStderrPath") != status["reviewStderrPath"]
        or request_subject.get("reviewAttesterPublicKey") != status["reviewAttesterPublicKey"]
        or request_subject.get("claudeExecutable") != status["claudeExecutable"]
        or request_subject.get("reviewRuntime") != status["reviewRuntime"]
        or request_subject.get("launcherSha256") != status["launcherSha256"]
    ):
        raise ValueError("review-attester request does not bind the local review")
    return manifest, draft, request


def resolve_review_container(*, environment: Mapping[str, str]) -> dict[str, Any]:
    """Verify the exact local engine, image, user, and Claude binary before reservation."""

    approved = APPROVED_REVIEW_CONTAINER
    engine = approved["engine"]
    requested = Path(engine["path"])
    resolved = requested.resolve()
    if (
        str(resolved) != engine["resolvedPath"]
        or not resolved.is_file()
        or not os.access(resolved, os.X_OK)
        or sha256_file(resolved) != engine["sha256"]
    ):
        raise ValueError("frozen P30 Docker engine changed")
    version = subprocess.run(
        [str(requested), "--version"], stdin=subprocess.DEVNULL,
        capture_output=True, timeout=30, env=dict(environment), check=True,
    )
    if version.stderr or version.stdout.decode("utf-8").strip() != engine["version"]:
        raise ValueError("frozen P30 Docker engine version changed")
    daemon_result = subprocess.run(
        [str(requested), "info", "--format", "{{json .}}"],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
        env=dict(environment), check=True,
    )
    daemon_value = json.loads(daemon_result.stdout)
    daemon = approved["daemon"]
    if (
        daemon_result.stderr
        or daemon_value.get("ID") != daemon["id"]
        or daemon_value.get("ServerVersion") != daemon["serverVersion"]
        or daemon_value.get("OperatingSystem") != daemon["operatingSystem"]
        or daemon_value.get("Architecture") != daemon["architecture"]
        or daemon_value.get("DockerRootDir") != daemon["rootDirectory"]
        or daemon_value.get("SecurityOptions") != daemon["securityOptions"]
    ):
        raise ValueError("frozen P30 Docker daemon changed")
    image = approved["image"]
    inspected = subprocess.run(
        [str(requested), "image", "inspect", image["reference"]],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
        env=dict(environment), check=True,
    )
    values = json.loads(inspected.stdout)
    if (
        inspected.stderr
        or not isinstance(values, list)
        or len(values) != 1
        or values[0].get("Id") != image["imageId"]
        or values[0].get("Architecture") != "arm64"
        or values[0].get("Os") != "linux"
        or values[0].get("Config", {}).get("User") != image["user"]
    ):
        raise ValueError("frozen P30 reviewer image changed")
    probe = subprocess.run(
        [
            str(requested), "run", "--rm", "--pull", "never", "--network", "none",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--security-opt", "seccomp=builtin",
            "--pids-limit", "32", "--memory", "256m", "--cpus", "1",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
            "--entrypoint", "/bin/sh", image["reference"], "-c",
            "sha256sum /usr/local/bin/claude; /usr/local/bin/claude --version; id -u; id -g",
        ],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
        env=dict(environment), check=True,
    )
    lines = probe.stdout.decode("utf-8").splitlines()
    if (
        probe.stderr
        or lines != [
            f'{APPROVED_CLAUDE_EXECUTABLE["sha256"]}  {APPROVED_CLAUDE_EXECUTABLE["path"]}',
            APPROVED_CLAUDE_EXECUTABLE["version"],
            "10001",
            "10001",
        ]
    ):
        raise ValueError("frozen P30 reviewer payload changed")
    return json.loads(json.dumps(approved))


def read_secret_fd(descriptor: int, label: str, *, single_line: bool = False) -> bytearray:
    metadata = os.fstat(descriptor)
    if os.isatty(descriptor) or not (stat.S_ISFIFO(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)):
        raise ValueError(f"{label} must arrive through a pipe or socket")
    secret = bytearray()
    while len(secret) <= MAXIMUM_SECRET_BYTES:
        chunk = os.read(descriptor, min(65536, MAXIMUM_SECRET_BYTES + 1 - len(secret)))
        if not chunk: break
        secret.extend(chunk)
    while secret and secret[-1] in b"\r\n": secret.pop()
    if (
        not secret
        or len(secret) > MAXIMUM_SECRET_BYTES
        or b"\x00" in secret
        or (single_line and (b"\n" in secret or b"\r" in secret))
    ):
        secret[:] = b"\0" * len(secret)
        raise ValueError(f"{label} is empty or oversized")
    return secret


def sanitized_environment(*, capsule: Path) -> dict[str, str]:
    home = capsule / "runtime-home"
    tmp = capsule / "tmp"
    docker_config = home / "docker-config"
    for path in (home, tmp, docker_config):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = {
        "DOCKER_CONFIG": str(docker_config),
        "DOCKER_HOST": "unix:///var/run/docker.sock",
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": str(tmp),
    }
    if tuple(sorted(result)) != tuple(sorted(SANITIZED_ENVIRONMENT_KEYS)):
        raise RuntimeError("P30 sanitized environment construction changed")
    return result


def _normalized_container_inspect(value: Mapping[str, Any]) -> dict[str, Any]:
    config = value.get("Config", {})
    host = value.get("HostConfig", {})
    state = value.get("State", {})
    return {
        "Id": value.get("Id"), "Name": value.get("Name"),
        "Image": value.get("Image"), "Platform": value.get("Platform"),
        "State": {key: state.get(key) for key in (
            "Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead",
            "Pid", "ExitCode", "Error", "StartedAt", "FinishedAt",
        )},
        "Config": {key: (sorted(config.get(key) or []) if key == "Env" else config.get(key)) for key in (
            "Hostname", "User", "Env", "Cmd", "Image", "WorkingDir",
            "Entrypoint", "Labels",
        )},
        "HostConfig": {key: host.get(key) for key in (
            "Binds", "LogConfig", "NetworkMode", "CapAdd", "CapDrop", "Privileged",
            "ReadonlyRootfs", "SecurityOpt", "PidsLimit", "Memory", "NanoCpus",
            "AutoRemove", "Tmpfs", "Mounts",
        )},
        "Mounts": value.get("Mounts"),
    }


def prepare_review_container(
    *, create_argv: Sequence[str], capsule: Path, container_name: str,
    claude_argv: list[str], environment: Mapping[str, str],
) -> tuple[str, dict[str, Any], str]:
    """Create and inspect a stopped reviewer before the remote one-shot reservation."""

    created = subprocess.run(
        list(create_argv), stdin=subprocess.DEVNULL, capture_output=True,
        timeout=120, env=dict(environment),
    )
    container_id = created.stdout.decode("utf-8").strip()
    if (
        created.returncode != 0 or created.stderr
        or not re.fullmatch(r"[0-9a-f]{64}", container_id)
    ):
        raise RuntimeError("frozen P30 reviewer container could not be created")
    try:
        inspected = subprocess.run(
            [APPROVED_REVIEW_CONTAINER["engine"]["path"], "container", "inspect", container_name],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
            env=dict(environment), check=True,
        )
        values = json.loads(inspected.stdout)
        if inspected.stderr or not isinstance(values, list) or len(values) != 1:
            raise ValueError("P30 reviewer inspect output changed")
        normalized = _normalized_container_inspect(values[0])
        expected = expected_container_config(
            capsule=capsule, container_name=container_name,
            container_id=container_id, claude_argv=claude_argv,
        )
        if normalized != expected:
            raise ValueError("P30 reviewer effective container configuration changed")
        return container_id, normalized, sha256_bytes(canonical_json(normalized))
    except BaseException:
        remove_review_container(
            container_name=container_name, environment=environment, require_present=True
        )
        raise


def remove_review_container(
    *, container_name: str, environment: Mapping[str, str], require_present: bool
) -> None:
    cleanup = subprocess.run(
        expected_container_cleanup_argv(container_name), stdin=subprocess.DEVNULL,
        capture_output=True, timeout=60, env=dict(environment),
    )
    if require_present and (
        cleanup.returncode != 0
        or cleanup.stderr
        or cleanup.stdout.decode("utf-8").strip() != container_name
    ):
        raise RuntimeError("P30 reviewer container cleanup failed")
    absent = subprocess.run(
        [APPROVED_REVIEW_CONTAINER["engine"]["path"], "container", "inspect", container_name],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=30, env=dict(environment),
    )
    if absent.returncode == 0:
        raise RuntimeError("P30 reviewer container still exists after cleanup")


def reserve_remote_attempt(*, remote: str, remote_path: str, payload: bytes, timeout: int) -> None:
    path = _validate_remote_path(remote_path, "P30 review attempt")
    encoded = base64.b64encode(payload).decode("ascii")
    script = (
        "import base64,os,sys; p=sys.argv[1]; d=base64.b64decode(sys.argv[2],validate=True); "
        "os.makedirs(os.path.dirname(p),exist_ok=True); "
        "f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400); "
        "os.write(f,d); os.fsync(f); os.close(f); "
        "q=os.open(os.path.dirname(p),os.O_RDONLY); os.fsync(q); os.close(q)"
    )
    completed = subprocess.run(
        ["ssh", "-T", "-o", "LogLevel=ERROR", remote, shlex.join(["python3", "-c", script, str(path), encoded])],
        capture_output=True, timeout=timeout,
    )
    if completed.returncode != 0 or completed.stdout or completed.stderr:
        raise FileExistsError("P30 analysis review attempt is already consumed or could not be reserved")


def _open_exclusive_stream(path: Path) -> int:
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)


def run_fable(
    *, start_argv: Sequence[str], claude_auth: bytearray,
    cwd: Path, stdout_path: Path, stderr_path: Path, timeout: int,
    environment: Mapping[str, str],
) -> tuple[str, str, int]:
    stdout_fd = _open_exclusive_stream(stdout_path)
    try: stderr_fd = _open_exclusive_stream(stderr_path)
    except BaseException:
        os.close(stdout_fd); stdout_path.unlink(missing_ok=True); raise
    read_fd, write_fd = os.pipe()
    started = utc_now()
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            list(start_argv), cwd=cwd, stdin=read_fd, stdout=stdout_fd,
            stderr=stderr_fd, env=dict(environment), close_fds=True,
        )
        os.close(read_fd)
        read_fd = -1
        written = 0
        while written < len(claude_auth):
            count = os.write(write_fd, memoryview(claude_auth)[written:])
            if count <= 0:
                raise RuntimeError("P30 reviewer OAuth descriptor short write")
            written += count
        os.close(write_fd)
        write_fd = -1
        try:
            exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=30)
            raise
    except BaseException:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=30)
        raise
    finally:
        if read_fd >= 0: os.close(read_fd)
        if write_fd >= 0: os.close(write_fd)
        os.close(stdout_fd); os.close(stderr_fd)
    return started, utc_now(), exit_code


def authenticated_liveness_preflight(
    *, capsule: Path, outputs: Path, claude_auth: bytearray,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    """Prove fd-0 OAuth and the live Fable API before consuming a remote attempt."""

    claude_argv = liveness_claude_argv()
    name = f"arc-p30-review-{secrets.token_hex(8)}"
    create = expected_container_create_argv(
        capsule=capsule, container_name=name, claude_argv=claude_argv
    )
    start = expected_container_start_argv(name)
    cleanup = expected_container_cleanup_argv(name)
    stdout = outputs / "liveness.stdout"
    stderr = outputs / "liveness.stderr"
    created = False
    try:
        identifier, config, config_sha = prepare_review_container(
            create_argv=create, capsule=capsule, container_name=name,
            claude_argv=claude_argv, environment=environment,
        )
        created = True
        try:
            started, finished, code = run_fable(
                start_argv=start, claude_auth=claude_auth, cwd=capsule,
                stdout_path=stdout, stderr_path=stderr, timeout=600,
                environment=environment,
            )
        finally:
            remove_review_container(
                container_name=name, environment=environment, require_present=True
            )
            created = False
    finally:
        if created:
            remove_review_container(
                container_name=name, environment=environment, require_present=False
            )
    if (
        code != 0
        or read_regular_nofollow(stdout) != REVIEW_LIVENESS_STDOUT
        or read_regular_nofollow(stderr) != b""
    ):
        raise RuntimeError("authenticated P30 reviewer liveness failed before reservation")
    evidence = {
        "schemaVersion": REVIEW_LIVENESS_SCHEMA, "valid": True, "immutable": True,
        "outcomesInspected": False, "promotionEligible": False,
        "model": "fable", "effort": "high", "tools": ["Read"],
        "noSessionPersistence": True, "authDelivery": CLAUDE_AUTH_DELIVERY,
        "prompt": REVIEW_LIVENESS_PROMPT, "containerArgv": create,
        "containerName": name,
        "containerInvocationSha256": sha256_bytes(canonical_json(create)),
        "containerId": identifier, "containerConfig": config,
        "containerConfigSha256": config_sha, "startArgv": start,
        "cleanupArgv": cleanup, "cleanupVerified": True,
        "startedAtUtc": started, "finishedAtUtc": finished, "exitCode": code,
        "stdout": {"path": str(stdout), "sha256": sha256_file(stdout), "bytes": stdout.stat().st_size},
        "stderr": {"path": str(stderr), "sha256": sha256_file(stderr), "bytes": stderr.stat().st_size},
    }
    validate_authenticated_liveness(evidence, capsule=capsule, verify_local_files=True)
    return evidence


def require_exact_accept(*, stdout_path: Path, stderr_path: Path, exit_code: int) -> None:
    stdout = read_regular_nofollow(stdout_path)
    stderr = read_regular_nofollow(stderr_path)
    nonempty = [line.strip() for line in stdout.decode("utf-8").splitlines() if line.strip()]
    if exit_code != 0 or stderr or not nonempty or nonempty[-1] != "VERDICT: ACCEPT":
        raise RuntimeError("local P30 Fable review did not pass exactly; the consumed lane is closed")


def create_review_completion(
    *, path: Path, attempt_path: Path, stdout_path: Path, stderr_path: Path,
    started: str, finished: str, exit_code: int, container_name: str,
) -> dict[str, Any]:
    value = {
        "schemaVersion": REVIEW_COMPLETION_SCHEMA, "valid": True,
        "immutable": True, "outcomesInspected": False, "promotionEligible": False,
        "attemptSha256": sha256_file(attempt_path), "startedAtUtc": started,
        "finishedAtUtc": finished, "exitCode": exit_code,
        "containerName": container_name, "cleanupVerified": True,
        "stdout": {"path": str(stdout_path), "sha256": sha256_file(stdout_path), "bytes": stdout_path.stat().st_size},
        "stderr": {"path": str(stderr_path), "sha256": sha256_file(stderr_path), "bytes": stderr_path.stat().st_size},
    }
    atomic_write_exclusive(path, canonical_json(value) + b"\n", mode=0o400)
    return validate_review_completion(
        value, attempt_path=attempt_path, stdout_path=stdout_path,
        stderr_path=stderr_path, container_name=container_name,
    )


def validate_review_completion(
    value: Mapping[str, Any], *, attempt_path: Path, stdout_path: Path,
    stderr_path: Path, container_name: str,
) -> dict[str, Any]:
    expected = {
        "schemaVersion", "valid", "immutable", "outcomesInspected",
        "promotionEligible", "attemptSha256", "startedAtUtc", "finishedAtUtc",
        "exitCode", "containerName", "cleanupVerified", "stdout", "stderr",
    }
    if set(value) != expected:
        raise ValueError("P30 local review completion schema changed")
    stdout = value.get("stdout")
    stderr = value.get("stderr")
    if (
        value.get("schemaVersion") != REVIEW_COMPLETION_SCHEMA
        or value.get("valid") is not True or value.get("immutable") is not True
        or value.get("outcomesInspected") is not False
        or value.get("promotionEligible") is not False
        or value.get("attemptSha256") != sha256_file(attempt_path)
        or value.get("containerName") != container_name
        or value.get("cleanupVerified") is not True
        or value.get("exitCode") != 0
        or stdout != {"path": str(stdout_path), "sha256": sha256_file(stdout_path), "bytes": stdout_path.stat().st_size}
        or stderr != {"path": str(stderr_path), "sha256": sha256_file(stderr_path), "bytes": stderr_path.stat().st_size}
        or stderr_path.stat().st_size != 0
    ):
        raise ValueError("P30 local review completion changed")
    return dict(value)


def create_postprocess_marker(
    *, path: Path, unsigned: Path, completion: Path, attempt: Path,
    signed: Path, uploads: Sequence[str], created_at: str,
) -> dict[str, Any]:
    value = {
        "schemaVersion": POSTPROCESS_MARKER_SCHEMA, "valid": True,
        "immutable": True, "fableRerunAllowed": False,
        "unsigned": {"path": str(unsigned), "sha256": sha256_file(unsigned)},
        "completion": {"path": str(completion), "sha256": sha256_file(completion)},
        "attempt": {"path": str(attempt), "sha256": sha256_file(attempt)},
        "signedPath": str(signed), "uploadTargets": list(uploads),
        "createdAtUtc": created_at,
    }
    atomic_write_exclusive(path, canonical_json(value) + b"\n", mode=0o400)
    return validate_postprocess_marker(value, path=path)


def validate_postprocess_marker(value: Mapping[str, Any], *, path: Path) -> dict[str, Any]:
    expected = {
        "schemaVersion", "valid", "immutable", "fableRerunAllowed", "unsigned",
        "completion", "attempt", "signedPath", "uploadTargets", "createdAtUtc",
    }
    if set(value) != expected or value.get("schemaVersion") != POSTPROCESS_MARKER_SCHEMA:
        raise ValueError("P30 postprocess marker schema changed")
    for key in ("unsigned", "completion", "attempt"):
        binding = value.get(key)
        if (
            not isinstance(binding, dict) or set(binding) != {"path", "sha256"}
            or sha256_file(Path(binding["path"])) != binding["sha256"]
        ):
            raise ValueError("P30 postprocess marker binding changed")
    if (
        value.get("valid") is not True or value.get("immutable") is not True
        or value.get("fableRerunAllowed") is not False
        or not Path(value.get("signedPath", "")).is_absolute()
        or not isinstance(value.get("uploadTargets"), list)
        or len(value["uploadTargets"]) != 3
        or len(set(value["uploadTargets"])) != 3
        or not isinstance(value.get("createdAtUtc"), str)
        or not path.is_file()
    ):
        raise ValueError("P30 postprocess marker changed")
    return dict(value)


def upload_review_evidence(*, remote: str, files: Sequence[tuple[Path, str]], timeout: int) -> None:
    if len(files) != 3 or len({target for _, target in files}) != 3:
        raise ValueError("P30 review upload must contain exactly three distinct files")
    nonce = uuid.uuid4().hex
    staged: list[tuple[str, str, str]] = []
    try:
        for local, target in files:
            target_path = _validate_remote_path(target, "P30 review upload target")
            stage = str(target_path.parent / f".upload-{nonce}-{target_path.name}")
            completed = subprocess.run(
                ["scp", "-q", str(local), f"{remote}:{stage}"], check=True,
                capture_output=True, timeout=timeout,
            )
            if completed.stdout or completed.stderr:
                raise RuntimeError("P30 review evidence staging emitted output")
            staged.append((stage, target, sha256_file(local)))
        script = """
import hashlib,json,os,stat,sys
items=json.loads(sys.argv[1]); created=[]
try:
    for stage,target,expected in items:
        st=os.lstat(stage)
        if not stat.S_ISREG(st.st_mode): raise ValueError('stage is not regular')
        h=hashlib.sha256()
        with open(stage,'rb') as f:
            for block in iter(lambda:f.read(1048576),b''): h.update(block)
        if h.hexdigest()!=expected: raise ValueError('stage hash mismatch')
        if os.path.lexists(target):
            target_st=os.lstat(target)
            if not stat.S_ISREG(target_st.st_mode): raise ValueError('existing target is not regular')
            target_h=hashlib.sha256()
            with open(target,'rb') as f:
                for block in iter(lambda:f.read(1048576),b''): target_h.update(block)
            if target_h.hexdigest()!=expected: raise ValueError('existing target hash mismatch')
        else:
            os.link(stage,target); created.append(target)
    for stage,_,_ in items: os.unlink(stage)
except BaseException:
    for target in created:
        try: os.unlink(target)
        except FileNotFoundError: pass
    raise
""".strip()
        completed = subprocess.run(
            ["ssh", "-T", "-o", "LogLevel=ERROR", remote, shlex.join(["python3", "-c", script, json.dumps(staged)])],
            check=True, capture_output=True, timeout=timeout,
        )
        if completed.stdout or completed.stderr:
            raise RuntimeError("P30 review evidence commit emitted output")
    finally:
        if staged:
            cleanup = "import json,os,sys; [(os.unlink(p) if os.path.lexists(p) else None) for p,_,_ in json.loads(sys.argv[1])]"
            subprocess.run(
                ["ssh", "-T", "-o", "LogLevel=ERROR", remote, shlex.join(["python3", "-c", cleanup, json.dumps(staged)])],
                capture_output=True, timeout=timeout,
            )


def sign_receipt_from_stdin(
    *, unsigned_path: Path, signed_path: Path, review_attester_public_key_path: Path,
    remote_draft_path: Path, remote_manifest_path: Path, input_fd: int = 0,
) -> None:
    payload = read_json(unsigned_path, "unsigned local review receipt")
    validate_local_analysis_review_payload(
        payload, remote_draft_path=remote_draft_path,
        remote_manifest_path=remote_manifest_path,
        review_attester_public_key_path=review_attester_public_key_path,
    )
    secret = read_secret_fd(input_fd, "review-attester signing key")
    try:
        key = serialization.load_pem_private_key(bytes(secret), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("review-attester signing key is not Ed25519")
        public = serialization.load_pem_public_key(read_regular_nofollow(review_attester_public_key_path))
        if key.public_key().public_bytes_raw() != public.public_bytes_raw():
            raise ValueError("review-attester signing key differs from trust root")
        encoded = canonical_json(payload)
        key_id, public_sha = public_key_identity(review_attester_public_key_path)
        signed = dict(payload)
        signed["signature"] = {
            "schemaVersion": SIGNATURE_SCHEMA, "algorithm": "Ed25519", "role": "review-attester",
            "keyId": key_id, "publicKeyDerSha256": public_sha,
            "payloadSha256": sha256_bytes(encoded),
            "valueBase64": base64.b64encode(key.sign(encoded)).decode("ascii"),
        }
        atomic_write_exclusive(signed_path, canonical_json(signed) + b"\n", mode=0o400)
    finally:
        secret[:] = b"\0" * len(secret)


def run_local_review_attester_signer(
    *, unsigned_path: Path, signed_path: Path, review_attester_public_key_path: Path,
    remote_draft_path: Path, remote_manifest_path: Path, custody_config: Path,
    op_michaelagents: Path, timeout: int,
) -> None:
    reference = load_config(custody_config)["review-attester"]
    read_fd, write_fd = os.pipe()
    signer_argv = [
        sys.executable, str(Path(__file__).resolve()), "--sign-only",
        "--unsigned-receipt", str(unsigned_path), "--signed-receipt", str(signed_path),
        "--review-attester-public-key", str(review_attester_public_key_path),
        "--remote-draft-path", str(remote_draft_path),
        "--remote-manifest-path", str(remote_manifest_path),
    ]
    signer = subprocess.Popen(signer_argv, stdin=read_fd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    os.close(read_fd)
    op = subprocess.Popen(
        [str(op_michaelagents), "read", reference], stdout=write_fd,
        stderr=subprocess.DEVNULL, close_fds=True,
    )
    os.close(write_fd)
    try:
        if op.wait(timeout=timeout) != 0 or signer.wait(timeout=timeout) != 0:
            raise RuntimeError("local review-attester receipt signing failed; the consumed lane is closed")
    except BaseException:
        if op.poll() is None: op.kill()
        if signer.poll() is None: signer.kill()
        raise


def build_analysis_review_payload(
    *, status: dict[str, Any], repo_root: Path, capsule: Path,
    manifest_local: Path, draft_local: Path, request_local: Path,
    source_lock_local: Path, review_attester_key_local: Path,
    attempt_local: Path, completion_path: Path, stdout_local: Path,
    stderr_local: Path, draft: dict[str, Any], launcher_sha: str,
    executable: dict[str, str], claude_argv: list[str],
    container_argv: list[str], container_name: str,
    container_invocation_sha256: str, container_id: str,
    container_config: dict[str, Any], container_config_sha256: str,
    authenticated_liveness: dict[str, Any], clock_skew_preflight: dict[str, Any],
    start_argv: list[str],
    cleanup_argv: list[str], cleanup_verified: bool,
    container_runtime: dict[str, Any], started: str, finished: str,
    exit_code: int,
) -> dict[str, Any]:
    source_binding = draft["sourceContract"]
    return {
        "schemaVersion": ANALYSIS_REVIEW_RECEIPT_SCHEMA, "valid": True, "immutable": True,
        "outcomesInspected": False, "promotionEligible": False,
        "targetDraftPath": status["authorizationDraft"]["path"],
        "targetDraftSha256": status["authorizationDraft"]["sha256"],
        "manifestPath": status["manifest"]["path"], "manifestSha256": status["manifest"]["sha256"],
        "reviewRequestPath": status["reviewAttestationRequest"]["path"],
        "reviewRequestSha256": status["reviewAttestationRequest"]["sha256"],
        "reviewAttemptPath": status["reviewAttemptPath"], "reviewAttemptSha256": sha256_file(attempt_local),
        "localAttemptPath": str(attempt_local), "localAttemptSha256": sha256_file(attempt_local),
        "localCompletionPath": str(completion_path), "localCompletionSha256": sha256_file(completion_path),
        "localTargetDraftPath": str(draft_local), "localTargetDraftSha256": sha256_file(draft_local),
        "localManifestPath": str(manifest_local), "localManifestSha256": sha256_file(manifest_local),
        "localReviewRequestPath": str(request_local), "localReviewRequestSha256": sha256_file(request_local),
        "sourceLockPath": source_binding["path"], "sourceLockSha256": source_binding["sha256"],
        "localSourceLockPath": str(source_lock_local), "localSourceLockSha256": sha256_file(source_lock_local),
        "launcherRelativePath": LOCAL_REVIEW_LAUNCHER_RELATIVE, "launcherSha256": launcher_sha,
        "localRepoRoot": str(repo_root),
        "reviewAttesterPublicKeyPath": status["reviewAttesterPublicKey"]["path"],
        "reviewAttesterPublicKeySha256": status["reviewAttesterPublicKey"]["sha256"],
        "localReviewAttesterPublicKeyPath": str(review_attester_key_local),
        "localReviewAttesterPublicKeySha256": sha256_file(review_attester_key_local),
        "model": "fable", "effort": "high", "tools": ["Read"], "noSessionPersistence": True,
        "claudeExecutable": executable, "argv": claude_argv,
        "containerArgv": container_argv, "containerName": container_name,
        "containerInvocationSha256": container_invocation_sha256,
        "containerId": container_id, "containerConfig": container_config,
        "containerConfigSha256": container_config_sha256,
        "authenticatedLiveness": authenticated_liveness,
        "clockSkewPreflight": clock_skew_preflight,
        "startArgv": start_argv, "cleanupArgv": cleanup_argv,
        "cleanupVerified": cleanup_verified, "cwd": str(capsule),
        "containerCwd": str(CONTAINER_REVIEW_ROOT),
        "environment": {
            "clearInherited": True, "keys": list(SANITIZED_ENVIRONMENT_KEYS),
            "secretKeys": [], "authDelivery": CLAUDE_AUTH_DELIVERY,
            "home": str(capsule / "runtime-home"), "tmpdir": str(capsule / "tmp"),
        },
        "containerRuntime": container_runtime,
        "startedAtUtc": started, "finishedAtUtc": finished, "exitCode": exit_code,
        "stdoutPath": status["reviewStdoutPath"], "stdoutSha256": sha256_file(stdout_local),
        "localStdoutPath": str(stdout_local), "localStdoutSha256": sha256_file(stdout_local),
        "stderrPath": status["reviewStderrPath"], "stderrSha256": sha256_file(stderr_local),
        "localStderrPath": str(stderr_local), "localStderrSha256": sha256_file(stderr_local),
        "verdict": "ACCEPT", "request": dict(status["reviewAttestationRequest"]),
    }


def resume_analysis_postprocess(args: argparse.Namespace) -> Path:
    """Resume only immutable receipt construction/signing/upload; never rerun Fable."""

    repo_root = Path(__file__).resolve().parents[1]
    status = scheduler_status(
        remote=args.remote, remote_repo=args.remote_repo,
        remote_protocol=args.remote_protocol, timeout=args.transfer_timeout_seconds,
        expected_status="analysis-review-postprocess-required",
    )
    capsule = args.capsule_root.resolve()
    inputs, outputs = capsule / "inputs", capsule / "outputs"
    manifest = inputs / "manifest.signed.json"
    draft_path = inputs / "analysis-authorization.unsigned.json"
    request = inputs / "guardian-review-request.json"
    source_lock = inputs / "source-lock.json"
    public = inputs / "review-attester-public.pem"
    attempt_path = inputs / "review-attempt.json"
    completion_path = outputs / "review-completion.json"
    stdout, stderr = outputs / "fable.stdout", outputs / "fable.stderr"
    unsigned, signed = outputs / "review-receipt.unsigned.json", outputs / "review-receipt.signed.json"
    marker_path = outputs / "postprocess-marker.json"
    validate_source_lock(args.local_source_lock.resolve(), repo_root=repo_root)
    draft = validate_downloaded_inputs(
        status=status, manifest_path=manifest, draft_path=draft_path,
        request_path=request, source_lock_path=source_lock,
        review_attester_public_key_path=public,
    )[1]
    attempt = read_json(attempt_path, "local analysis review attempt")
    if (
        sha256_file(attempt_path) != status["reviewAttemptSha256"]
        or attempt.get("launcherSha256") != status["launcherSha256"]
    ):
        raise ValueError("P30 analysis review resume attempt changed")
    completion = validate_review_completion(
        read_json(completion_path, "local analysis review completion"),
        attempt_path=attempt_path, stdout_path=stdout, stderr_path=stderr,
        container_name=attempt["containerName"],
    )
    require_exact_accept(stdout_path=stdout, stderr_path=stderr, exit_code=completion["exitCode"])
    executable = dict(attempt["claudeExecutable"])
    claude_argv = expected_argv(
        local_draft_path=CONTAINER_REVIEW_ROOT / "inputs/analysis-authorization.unsigned.json",
        draft_sha256=status["authorizationDraft"]["sha256"],
        local_manifest_path=CONTAINER_REVIEW_ROOT / "inputs/manifest.signed.json",
        manifest_sha256=status["manifest"]["sha256"],
        local_request_path=CONTAINER_REVIEW_ROOT / "inputs/guardian-review-request.json",
        request_sha256=status["reviewAttestationRequest"]["sha256"],
        remote_draft_path=status["authorizationDraft"]["path"],
        remote_manifest_path=status["manifest"]["path"],
        claude_path=executable["path"],
    )
    container_argv = expected_container_create_argv(
        capsule=capsule, container_name=attempt["containerName"], claude_argv=claude_argv
    )
    container_config = expected_container_config(
        capsule=capsule, container_name=attempt["containerName"],
        container_id=attempt["containerId"], claude_argv=claude_argv,
    )
    payload = build_analysis_review_payload(
        status=status, repo_root=repo_root, capsule=capsule, manifest_local=manifest,
        draft_local=draft_path, request_local=request, source_lock_local=source_lock,
        review_attester_key_local=public, attempt_local=attempt_path,
        completion_path=completion_path, stdout_local=stdout, stderr_local=stderr,
        draft=draft, launcher_sha=attempt["launcherSha256"], executable=executable,
        claude_argv=claude_argv, container_argv=container_argv,
        container_name=attempt["containerName"],
        container_invocation_sha256=attempt["containerInvocationSha256"],
        container_id=attempt["containerId"], container_config=container_config,
        container_config_sha256=attempt["containerConfigSha256"],
        authenticated_liveness=attempt["authenticatedLiveness"],
        clock_skew_preflight=attempt["clockSkewPreflight"],
        start_argv=expected_container_start_argv(attempt["containerName"]),
        cleanup_argv=expected_container_cleanup_argv(attempt["containerName"]),
        cleanup_verified=True, container_runtime=attempt["containerRuntime"],
        started=completion["startedAtUtc"], finished=completion["finishedAtUtc"],
        exit_code=completion["exitCode"],
    )
    if unsigned.exists():
        if read_json(unsigned, "existing unsigned review receipt") != payload:
            raise ValueError("P30 analysis review existing unsigned payload changed")
    else:
        atomic_write_exclusive(unsigned, canonical_json(payload) + b"\n", mode=0o400)
    validate_local_analysis_review_payload(
        payload, remote_draft_path=Path(status["authorizationDraft"]["path"]),
        remote_manifest_path=Path(status["manifest"]["path"]),
        review_attester_public_key_path=public,
    )
    if marker_path.exists():
        marker = validate_postprocess_marker(read_json(marker_path, "postprocess marker"), path=marker_path)
        if marker["unsigned"]["sha256"] != sha256_file(unsigned):
            raise ValueError("P30 analysis postprocess marker changed")
    else:
        create_postprocess_marker(
            path=marker_path, unsigned=unsigned, completion=completion_path,
            attempt=attempt_path, signed=signed,
            uploads=[status["reviewStdoutPath"], status["reviewStderrPath"], status["reviewReceiptPath"]],
            created_at=utc_now(),
        )
    if signed.exists():
        validate_signed_local_analysis_review_payload(
            read_json(signed, "existing signed review receipt"),
            remote_draft_path=Path(status["authorizationDraft"]["path"]),
            remote_manifest_path=Path(status["manifest"]["path"]),
            review_attester_public_key_path=public,
        )
    else:
        run_local_review_attester_signer(
            unsigned_path=unsigned, signed_path=signed,
            review_attester_public_key_path=public,
            remote_draft_path=Path(status["authorizationDraft"]["path"]),
            remote_manifest_path=Path(status["manifest"]["path"]),
            custody_config=args.custody_config.resolve(),
            op_michaelagents=args.op_michaelagents.resolve(),
            timeout=args.transfer_timeout_seconds,
        )
    upload_review_evidence(
        remote=args.remote,
        files=((stdout, status["reviewStdoutPath"]), (stderr, status["reviewStderrPath"]), (signed, status["reviewReceiptPath"])),
        timeout=args.transfer_timeout_seconds,
    )
    return signed


def launch(args: argparse.Namespace) -> Path:
    repo_root = Path(__file__).resolve().parents[1]
    source_lock_path = args.local_source_lock.resolve()
    validate_source_lock(source_lock_path, repo_root=repo_root)
    review_attester_public_key = args.review_attester_public_key.resolve()
    status = scheduler_status(
        remote=args.remote, remote_repo=args.remote_repo,
        remote_protocol=args.remote_protocol, timeout=args.transfer_timeout_seconds,
    )
    if sha256_file(review_attester_public_key) != status["reviewAttesterPublicKey"]["sha256"]:
        raise ValueError("local review-attester public key differs from remote frozen trust")
    capsule = args.capsule_root.resolve()
    if capsule == repo_root or repo_root in capsule.parents:
        raise ValueError("P30 analysis review capsule must be outside the repository")
    _mkdir_exclusive(capsule)
    inputs, outputs = capsule / "inputs", capsule / "outputs"
    inputs.mkdir(mode=0o700); outputs.mkdir(mode=0o700)
    manifest_local = inputs / "manifest.signed.json"
    draft_local = inputs / "analysis-authorization.unsigned.json"
    request_local = inputs / "guardian-review-request.json"
    source_lock_local = inputs / "source-lock.json"
    review_attester_key_local = inputs / "review-attester-public.pem"
    for binding, target in (
        (status["manifest"], manifest_local),
        (status["authorizationDraft"], draft_local),
        (status["reviewAttestationRequest"], request_local),
    ):
        fetch_remote_file(
            remote=args.remote, remote_path=binding["path"], target=target,
            expected_sha256=binding["sha256"], timeout=args.transfer_timeout_seconds,
        )
    _copy_local_exclusive(source_lock_path, source_lock_local)
    _copy_local_exclusive(review_attester_public_key, review_attester_key_local)
    manifest, draft, _ = validate_downloaded_inputs(
        status=status, manifest_path=manifest_local, draft_path=draft_local,
        request_path=request_local, source_lock_path=source_lock_local,
        review_attester_public_key_path=review_attester_key_local,
    )
    del manifest
    environment = sanitized_environment(capsule=capsule)
    container_runtime = resolve_review_container(environment=environment)
    executable = dict(container_runtime["image"]["claudeExecutable"])
    if executable != status["claudeExecutable"]:
        raise ValueError("container Claude executable differs from the frozen scheduler pin")
    claude_argv = expected_argv(
        local_draft_path=CONTAINER_REVIEW_ROOT / "inputs/analysis-authorization.unsigned.json",
        draft_sha256=status["authorizationDraft"]["sha256"],
        local_manifest_path=CONTAINER_REVIEW_ROOT / "inputs/manifest.signed.json",
        manifest_sha256=status["manifest"]["sha256"],
        local_request_path=CONTAINER_REVIEW_ROOT / "inputs/guardian-review-request.json",
        request_sha256=status["reviewAttestationRequest"]["sha256"],
        remote_draft_path=status["authorizationDraft"]["path"],
        remote_manifest_path=status["manifest"]["path"],
        claude_path=executable["path"],
    )
    container_name = f"arc-p30-review-{secrets.token_hex(8)}"
    container_argv = expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=claude_argv
    )
    container_invocation_sha256 = sha256_bytes(canonical_json(container_argv))
    start_argv = expected_container_start_argv(container_name)
    cleanup_argv = expected_container_cleanup_argv(container_name)
    stdout_local, stderr_local = outputs / "fable.stdout", outputs / "fable.stderr"
    if any(path.exists() or path.is_symlink() for path in (stdout_local, stderr_local)):
        raise FileExistsError("P30 review output stream already exists")
    launcher_sha = sha256_file(repo_root / LOCAL_REVIEW_LAUNCHER_RELATIVE)
    attempt_local = inputs / "review-attempt.json"
    auth = read_secret_fd(args.claude_auth_fd, "Claude OAuth token", single_line=True)
    container_created = False
    try:
        authenticated_liveness = authenticated_liveness_preflight(
            capsule=capsule, outputs=outputs, claude_auth=auth,
            environment=environment,
        )
        clock_skew_preflight = remote_clock_preflight(
            remote=args.remote, timeout=args.transfer_timeout_seconds
        )
        container_id, container_config, container_config_sha256 = prepare_review_container(
            create_argv=container_argv, capsule=capsule, container_name=container_name,
            claude_argv=claude_argv, environment=environment,
        )
        container_created = True
        attempt = {
            "schemaVersion": ANALYSIS_REVIEW_ATTEMPT_SCHEMA, "valid": True, "immutable": True,
            "outcomesInspected": False, "promotionEligible": False,
            "request": dict(status["reviewAttestationRequest"]),
            "authorizationDraft": dict(status["authorizationDraft"]),
            "manifest": dict(status["manifest"]), "attemptPath": status["reviewAttemptPath"],
            "receiptPath": status["reviewReceiptPath"], "stdoutPath": status["reviewStdoutPath"],
            "stderrPath": status["reviewStderrPath"],
            "sourceLockSha256": sha256_file(source_lock_local), "launcherSha256": launcher_sha,
            "claudeExecutable": executable, "containerRuntime": container_runtime,
            "containerName": container_name,
            "containerInvocationSha256": container_invocation_sha256,
            "containerId": container_id,
            "containerConfigSha256": container_config_sha256,
            "authenticatedLiveness": authenticated_liveness,
            "clockSkewPreflight": clock_skew_preflight,
            "reservedAtUtc": utc_now(),
        }
        atomic_write_exclusive(attempt_local, canonical_json(attempt) + b"\n", mode=0o400)
        # This is the final non-Fable preflight. Secret retrieval, environment
        # construction, input validation, and container hashing
        # have already succeeded. Once this remote O_EXCL reservation lands,
        # a model/review failure is terminal. Post-review signing/upload may
        # resume only from the immutable completion, streams, and attempt bytes.
        reserve_remote_attempt(
            remote=args.remote,
            remote_path=status["reviewAttemptPath"],
            payload=read_regular_nofollow(attempt_local),
            timeout=args.transfer_timeout_seconds,
        )
        try:
            started, finished, exit_code = run_fable(
                start_argv=start_argv, claude_auth=auth, cwd=capsule,
                stdout_path=stdout_local, stderr_path=stderr_local,
                timeout=args.review_timeout_seconds, environment=environment,
            )
        finally:
            remove_review_container(
                container_name=container_name, environment=environment,
                require_present=True,
            )
            container_created = False
        cleanup_verified = True
    finally:
        if container_created:
            remove_review_container(
                container_name=container_name, environment=environment,
                require_present=False,
            )
        auth[:] = b"\0" * len(auth)
    completion = create_review_completion(
        path=outputs / "review-completion.json", attempt_path=attempt_local,
        stdout_path=stdout_local, stderr_path=stderr_local, started=started,
        finished=finished, exit_code=exit_code, container_name=container_name,
    )
    require_exact_accept(stdout_path=stdout_local, stderr_path=stderr_local, exit_code=exit_code)
    unsigned_local = outputs / "review-receipt.unsigned.json"
    signed_local = outputs / "review-receipt.signed.json"
    receipt = build_analysis_review_payload(
        status=status, repo_root=repo_root, capsule=capsule,
        manifest_local=manifest_local, draft_local=draft_local,
        request_local=request_local, source_lock_local=source_lock_local,
        review_attester_key_local=review_attester_key_local,
        attempt_local=attempt_local, completion_path=outputs / "review-completion.json",
        stdout_local=stdout_local, stderr_local=stderr_local, draft=draft,
        launcher_sha=launcher_sha, executable=executable, claude_argv=claude_argv,
        container_argv=container_argv, container_name=container_name,
        container_invocation_sha256=container_invocation_sha256,
        container_id=container_id, container_config=container_config,
        container_config_sha256=container_config_sha256,
        authenticated_liveness=authenticated_liveness,
        clock_skew_preflight=clock_skew_preflight,
        start_argv=start_argv, cleanup_argv=cleanup_argv,
        cleanup_verified=cleanup_verified, container_runtime=container_runtime,
        started=started, finished=finished, exit_code=exit_code,
    )
    atomic_write_exclusive(unsigned_local, canonical_json(receipt) + b"\n", mode=0o400)
    validate_local_analysis_review_payload(
        receipt, remote_draft_path=Path(status["authorizationDraft"]["path"]),
        remote_manifest_path=Path(status["manifest"]["path"]),
        review_attester_public_key_path=review_attester_key_local,
    )
    create_postprocess_marker(
        path=outputs / "postprocess-marker.json", unsigned=unsigned_local,
        completion=outputs / "review-completion.json", attempt=attempt_local,
        signed=signed_local,
        uploads=[status["reviewStdoutPath"], status["reviewStderrPath"], status["reviewReceiptPath"]],
        created_at=utc_now(),
    )
    run_local_review_attester_signer(
        unsigned_path=unsigned_local, signed_path=signed_local,
        review_attester_public_key_path=review_attester_key_local,
        remote_draft_path=Path(status["authorizationDraft"]["path"]),
        remote_manifest_path=Path(status["manifest"]["path"]),
        custody_config=args.custody_config.resolve(), op_michaelagents=args.op_michaelagents.resolve(),
        timeout=args.transfer_timeout_seconds,
    )
    signed = read_json(signed_local, "signed local review receipt")
    validate_signed_local_analysis_review_payload(
        signed, remote_draft_path=Path(status["authorizationDraft"]["path"]),
        remote_manifest_path=Path(status["manifest"]["path"]),
        review_attester_public_key_path=review_attester_key_local,
    )
    upload_review_evidence(
        remote=args.remote,
        files=((stdout_local, status["reviewStdoutPath"]), (stderr_local, status["reviewStderrPath"]), (signed_local, status["reviewReceiptPath"])),
        timeout=args.transfer_timeout_seconds,
    )
    return signed_local


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sign-only", action="store_true")
    parser.add_argument("--resume-post-review", action="store_true")
    parser.add_argument("--unsigned-receipt", type=Path)
    parser.add_argument("--signed-receipt", type=Path)
    parser.add_argument("--remote-draft-path", type=Path)
    parser.add_argument("--remote-manifest-path", type=Path)
    parser.add_argument("--remote", default=REMOTE)
    parser.add_argument("--remote-repo", default=REMOTE_REPO)
    parser.add_argument("--remote-protocol")
    parser.add_argument("--local-source-lock", type=Path)
    parser.add_argument("--review-attester-public-key", type=Path, required=True)
    parser.add_argument("--custody-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--op-michaelagents", type=Path, default=Path.home() / "bin/op-michaelagents")
    parser.add_argument("--capsule-root", type=Path)
    parser.add_argument("--claude-auth-fd", type=int, default=3)
    parser.add_argument("--review-timeout-seconds", type=int, default=7200)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=600)
    args = parser.parse_args()
    if args.sign_only:
        required = (args.unsigned_receipt, args.signed_receipt, args.remote_draft_path, args.remote_manifest_path)
        if any(value is None for value in required):
            raise ValueError("P30 local sign-only arguments are incomplete")
        sign_receipt_from_stdin(
            unsigned_path=args.unsigned_receipt, signed_path=args.signed_receipt,
            review_attester_public_key_path=args.review_attester_public_key,
            remote_draft_path=args.remote_draft_path,
            remote_manifest_path=args.remote_manifest_path,
        )
        return
    if not args.remote_protocol or args.local_source_lock is None or args.capsule_root is None:
        raise ValueError("P30 local review launch arguments are incomplete")
    if args.resume_post_review:
        print(str(resume_analysis_postprocess(args)))
        return
    print(str(launch(args)))


if __name__ == "__main__":
    main()
