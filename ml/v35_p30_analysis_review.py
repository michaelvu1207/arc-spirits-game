#!/usr/bin/env python3
"""Fail-closed contract for the isolated local P30 Fable analysis review.

The review is performed on the Mac, after a request-bound O_EXCL reservation is
durable on SimForge.  The local launcher, not a remote role process, obtains the
dedicated review-attester key for one short signing operation and signs the
complete provenance receipt.  SimForge only verifies that signature and the
frozen contract.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Mapping

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    exact_keys,
    is_sha256,
    read_json_object,
    resolve_artifact,
    sha256,
    utc_instant,
)
from v35_p30_crypto import (
    canonical_json,
    read_regular_nofollow,
    sha256_bytes,
    verify_signed_payload,
)


ANALYSIS_REVIEW_RECEIPT_SCHEMA = (
    "arc-v35-p30-analysis-authorization-review-receipt-v3"
)
ANALYSIS_REVIEW_ATTEMPT_SCHEMA = "arc-v35-p30-analysis-review-attempt-v2"
LOCAL_REVIEW_LAUNCHER_RELATIVE = "ml/run_v35_p30_analysis_review_local.py"
CLAUDE_AUTH_DELIVERY = "oauth-token-file-descriptor-stdin-fd0"
SANITIZED_ENVIRONMENT_KEYS = (
    "DOCKER_CONFIG",
    "DOCKER_HOST",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TMPDIR",
)
VERSION_PATTERN = re.compile(r"^[^\r\n]{1,256}$")
APPROVED_CLAUDE_EXECUTABLE = {
    "path": "/usr/local/bin/claude",
    "sha256": "1fff7e8f947c07b19d10b1fbf714b7e547e9536253b9b58230d8adbc4624f867",
    "version": "2.1.211 (Claude Code)",
}
APPROVED_REVIEW_CONTAINER = {
    "backend": "docker",
    "engine": {
        "path": "/usr/local/bin/docker",
        "resolvedPath": "/Applications/Docker.app/Contents/Resources/bin/docker",
        "sha256": "cac12f15213d5806f1ffcbc6c159da969e8bf606bf81eafcea89b4c79d7945fd",
        "version": "Docker version 27.4.0, build bde2b89",
    },
    "daemon": {
        "id": "ef5c7268-c120-4369-8259-7faed4906a28",
        "serverVersion": "27.4.0",
        "operatingSystem": "Docker Desktop",
        "architecture": "aarch64",
        "rootDirectory": "/var/lib/docker",
        "securityOptions": ["name=seccomp,profile=unconfined", "name=cgroupns"],
    },
    "image": {
        "reference": (
            "arc-p30-fable@sha256:"
            "6c754e87b7f24678161673b3f3201038eb83c99ec8fd8682b4f952171d6ea01c"
        ),
        "imageId": (
            "sha256:6c754e87b7f24678161673b3f3201038eb83c99ec8fd8682b4f952171d6ea01c"
        ),
        "platform": "linux/arm64",
        "user": "10001:10001",
        "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
    },
    "authDelivery": CLAUDE_AUTH_DELIVERY,
    "rootFilesystem": "read-only",
    "capsuleMount": "read-only:/review",
    "capabilities": [],
    "noNewPrivileges": True,
    "network": "default-bridge-icc-enabled",
    "seccomp": "builtin-enforced",
    "logDriver": "none",
}
APPROVED_REVIEW_RUNTIME = {
    "attesterRole": "review-attester",
    "privateKeyRemoteDelivery": False,
    "attemptReservation": "remote-o-excl-before-fable",
    "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
    "container": APPROVED_REVIEW_CONTAINER,
}
CONTAINER_REVIEW_ROOT = Path("/review")
CONTAINER_NAME_PATTERN = re.compile(r"^arc-p30-review-[0-9a-f]{16}$")
REVIEW_LIVENESS_SCHEMA = "arc-v35-p30-authenticated-review-liveness-v1"
REVIEW_LIVENESS_PROMPT = "Reply with exactly P30_REVIEW_LIVENESS_OK"
REVIEW_LIVENESS_STDOUT = b"P30_REVIEW_LIVENESS_OK\n"
CLOCK_SKEW_SCHEMA = "arc-v35-p30-review-clock-skew-v1"


def review_prompt(
    *,
    local_draft_path: Path,
    draft_sha256: str,
    local_manifest_path: Path,
    manifest_sha256: str,
    local_request_path: Path,
    request_sha256: str,
    remote_draft_path: str,
    remote_manifest_path: str,
) -> str:
    return (
        f"Review the isolated local copy of the exact P30 analysis authorization "
        f"draft at {local_draft_path.resolve()} with SHA-256 {draft_sha256}, the "
        f"metric-free signed manifest copy at {local_manifest_path.resolve()} with "
        f"SHA-256 {manifest_sha256}, and the local review-attester request copy at "
        f"{local_request_path.resolve()} with SHA-256 {request_sha256}. Their remote "
        f"targets are {remote_draft_path} and {remote_manifest_path}. Do not attempt "
        "to read any report, replay, league, result, ledger, checkpoint, repository, "
        "home-directory secret, or other path named by the manifest. Verify only "
        "that the authorization permits exactly one networkless CPU-only analysis, "
        "binds the frozen source and metric-free manifest, uses a one-shot external "
        "ledger, and exposes no early outcome or promotion path. Identify any "
        "security, fairness, integrity, or exactly-once blocker. End the final "
        "nonempty line with exactly VERDICT: ACCEPT only if no launch blocker remains."
    )


def expected_argv(
    *,
    local_draft_path: Path,
    draft_sha256: str,
    local_manifest_path: Path,
    manifest_sha256: str,
    local_request_path: Path,
    request_sha256: str,
    remote_draft_path: str,
    remote_manifest_path: str,
    claude_path: str,
) -> list[str]:
    if not Path(claude_path).is_absolute():
        raise ValueError("P30 review Claude executable is not absolute")
    return [
        claude_path,
        "-p",
        "--model",
        "fable",
        "--effort",
        "high",
        "--tools",
        "Read",
        "--no-session-persistence",
        review_prompt(
            local_draft_path=local_draft_path,
            draft_sha256=draft_sha256,
            local_manifest_path=local_manifest_path,
            manifest_sha256=manifest_sha256,
            local_request_path=local_request_path,
            request_sha256=request_sha256,
            remote_draft_path=remote_draft_path,
            remote_manifest_path=remote_manifest_path,
        ),
    ]


def expected_container_create_argv(
    *, capsule: Path, container_name: str, claude_argv: list[str]
) -> list[str]:
    """Return the complete secret-free, digest-pinned Docker invocation."""

    capsule = capsule.resolve()
    if not capsule.is_absolute() or any(character in str(capsule) for character in ",\r\n"):
        raise ValueError("P30 review capsule cannot be represented by a Docker mount")
    if not isinstance(container_name, str) or CONTAINER_NAME_PATTERN.fullmatch(container_name) is None:
        raise ValueError("P30 review container name changed")
    if not claude_argv or claude_argv[0] != APPROVED_CLAUDE_EXECUTABLE["path"]:
        raise ValueError("P30 review Claude argv changed")
    runtime = APPROVED_REVIEW_CONTAINER
    return [
        runtime["engine"]["path"],
        "create",
        "-i",
        "--pull",
        "never",
        "--platform",
        runtime["image"]["platform"],
        "--name",
        container_name,
        "--hostname",
        "p30-review",
        "--network",
        "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--security-opt",
        "seccomp=builtin",
        "--pids-limit",
        "128",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--log-driver",
        "none",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--tmpfs",
        "/home/reviewer:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700",
        "--mount",
        f"type=bind,src={capsule},dst=/review,readonly",
        "--workdir",
        "/review",
        "--env",
        "HOME=/home/reviewer",
        "--env",
        "LANG=C.UTF-8",
        "--env",
        "LC_ALL=C.UTF-8",
        "--env",
        "NO_COLOR=1",
        "--env",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=0",
        "--entrypoint",
        APPROVED_CLAUDE_EXECUTABLE["path"],
        runtime["image"]["reference"],
        *claude_argv[1:],
    ]


def expected_container_config(
    *, capsule: Path, container_name: str, container_id: str, claude_argv: list[str]
) -> dict[str, Any]:
    """Return the exact normalized Docker inspect payload allowed before reservation."""

    capsule = capsule.resolve()
    if not re.fullmatch(r"[0-9a-f]{64}", container_id):
        raise ValueError("P30 review container ID changed")
    expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=claude_argv
    )
    image = APPROVED_REVIEW_CONTAINER["image"]
    return {
        "Id": container_id,
        "Name": f"/{container_name}",
        "Image": image["imageId"],
        "Platform": "linux",
        "State": {
            "Status": "created", "Running": False, "Paused": False,
            "Restarting": False, "OOMKilled": False, "Dead": False,
            "Pid": 0, "ExitCode": 0, "Error": "",
            "StartedAt": "0001-01-01T00:00:00Z",
            "FinishedAt": "0001-01-01T00:00:00Z",
        },
        "Config": {
            "Hostname": "p30-review",
            "User": image["user"],
            "Env": sorted([
                "HOME=/home/reviewer",
                "LANG=C.UTF-8",
                "LC_ALL=C.UTF-8",
                "NO_COLOR=1",
                "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=0",
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "NODE_VERSION=22.17.1",
                "YARN_VERSION=1.22.22",
            ]),
            "Cmd": claude_argv[1:],
            "Image": image["reference"],
            "WorkingDir": str(CONTAINER_REVIEW_ROOT),
            "Entrypoint": [APPROVED_CLAUDE_EXECUTABLE["path"]],
            "Labels": {},
        },
        "HostConfig": {
            "Binds": None,
            "LogConfig": {"Type": "none", "Config": {}},
            "NetworkMode": "bridge",
            "CapAdd": None,
            "CapDrop": ["ALL"],
            "Privileged": False,
            "ReadonlyRootfs": True,
            "SecurityOpt": ["no-new-privileges", "seccomp=builtin"],
            "PidsLimit": 128,
            "Memory": 1073741824,
            "NanoCpus": 2000000000,
            "AutoRemove": False,
            "Tmpfs": {
                "/home/reviewer": "rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700",
                "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777",
            },
            "Mounts": [
                {
                    "Type": "bind", "Source": str(capsule),
                    "Target": str(CONTAINER_REVIEW_ROOT), "ReadOnly": True,
                }
            ],
        },
        "Mounts": [
            {
                "Type": "bind", "Source": str(capsule),
                "Destination": str(CONTAINER_REVIEW_ROOT), "Mode": "",
                "RW": False, "Propagation": "rprivate",
            }
        ],
    }


def expected_container_start_argv(container_name: str) -> list[str]:
    if not isinstance(container_name, str) or CONTAINER_NAME_PATTERN.fullmatch(container_name) is None:
        raise ValueError("P30 review container name changed")
    return [APPROVED_REVIEW_CONTAINER["engine"]["path"], "start", "-ai", container_name]


def expected_container_cleanup_argv(container_name: str) -> list[str]:
    if not isinstance(container_name, str) or CONTAINER_NAME_PATTERN.fullmatch(container_name) is None:
        raise ValueError("P30 review container name changed")
    return [APPROVED_REVIEW_CONTAINER["engine"]["path"], "rm", "-f", container_name]


def liveness_claude_argv() -> list[str]:
    return [
        APPROVED_CLAUDE_EXECUTABLE["path"], "-p", "--model", "fable",
        "--effort", "high", "--tools", "Read", "--no-session-persistence",
        REVIEW_LIVENESS_PROMPT,
    ]


def validate_authenticated_liveness(
    evidence: Mapping[str, Any], *, capsule: Path, verify_local_files: bool
) -> None:
    exact_keys(
        evidence,
        {
            "schemaVersion", "valid", "immutable", "outcomesInspected",
            "promotionEligible", "model", "effort", "tools",
            "noSessionPersistence", "authDelivery", "prompt",
            "containerArgv", "containerName", "containerInvocationSha256",
            "containerId", "containerConfig", "containerConfigSha256",
            "startArgv", "cleanupArgv", "cleanupVerified", "startedAtUtc",
            "finishedAtUtc", "exitCode", "stdout", "stderr",
        },
        "P30 authenticated reviewer liveness",
    )
    capsule = capsule.resolve()
    name = evidence.get("containerName")
    identifier = evidence.get("containerId")
    argv = liveness_claude_argv()
    create = expected_container_create_argv(
        capsule=capsule, container_name=name, claude_argv=argv
    )
    config = expected_container_config(
        capsule=capsule, container_name=name, container_id=identifier,
        claude_argv=argv,
    )
    stdout = evidence.get("stdout")
    stderr = evidence.get("stderr")
    exact_keys(stdout, {"path", "sha256", "bytes"}, "P30 liveness stdout")
    exact_keys(stderr, {"path", "sha256", "bytes"}, "P30 liveness stderr")
    if (
        evidence.get("schemaVersion") != REVIEW_LIVENESS_SCHEMA
        or evidence.get("valid") is not True
        or evidence.get("immutable") is not True
        or evidence.get("outcomesInspected") is not False
        or evidence.get("promotionEligible") is not False
        or evidence.get("model") != "fable"
        or evidence.get("effort") != "high"
        or evidence.get("tools") != ["Read"]
        or evidence.get("noSessionPersistence") is not True
        or evidence.get("authDelivery") != CLAUDE_AUTH_DELIVERY
        or evidence.get("prompt") != REVIEW_LIVENESS_PROMPT
        or evidence.get("containerArgv") != create
        or evidence.get("containerInvocationSha256")
        != sha256_bytes(canonical_json(create))
        or evidence.get("containerConfig") != config
        or evidence.get("containerConfigSha256")
        != sha256_bytes(canonical_json(config))
        or evidence.get("startArgv") != expected_container_start_argv(name)
        or evidence.get("cleanupArgv") != expected_container_cleanup_argv(name)
        or evidence.get("cleanupVerified") is not True
        or evidence.get("exitCode") != 0
        or stdout.get("bytes") != len(REVIEW_LIVENESS_STDOUT)
        or stdout.get("sha256") != sha256_bytes(REVIEW_LIVENESS_STDOUT)
        or stderr.get("bytes") != 0
        or stderr.get("sha256") != sha256_bytes(b"")
    ):
        raise ValueError("P30 authenticated reviewer liveness changed")
    started = utc_instant(evidence["startedAtUtc"], "P30 liveness start")
    finished = utc_instant(evidence["finishedAtUtc"], "P30 liveness finish")
    if finished <= started:
        raise ValueError("P30 authenticated reviewer liveness duration changed")
    if verify_local_files:
        stdout_path = Path(stdout["path"])
        stderr_path = Path(stderr["path"])
        if (
            capsule not in stdout_path.resolve().parents
            or capsule not in stderr_path.resolve().parents
            or read_regular_nofollow(stdout_path) != REVIEW_LIVENESS_STDOUT
            or read_regular_nofollow(stderr_path) != b""
        ):
            raise ValueError("P30 authenticated reviewer liveness files changed")


def validate_clock_skew_preflight(value: Mapping[str, Any]) -> None:
    exact_keys(
        value,
        {"schemaVersion", "valid", "localBeforeUtc", "remoteUtc", "localAfterUtc", "roundTripMs", "absoluteSkewMs"},
        "P30 review clock-skew preflight",
    )
    before = utc_instant(value["localBeforeUtc"], "P30 clock local-before")
    remote = utc_instant(value["remoteUtc"], "P30 clock remote")
    after = utc_instant(value["localAfterUtc"], "P30 clock local-after")
    if (
        value.get("schemaVersion") != CLOCK_SKEW_SCHEMA
        or value.get("valid") is not True
        or after < before
        or not isinstance(value.get("roundTripMs"), int)
        or not isinstance(value.get("absoluteSkewMs"), int)
        or value["roundTripMs"] < 0 or value["roundTripMs"] > 30000
        or value["absoluteSkewMs"] < 0 or value["absoluteSkewMs"] > 30000
    ):
        raise ValueError("P30 review clock-skew preflight changed")
    midpoint = before + (after - before) / 2
    observed = round(abs((remote - midpoint).total_seconds()) * 1000)
    if abs(observed - value["absoluteSkewMs"]) > 2:
        raise ValueError("P30 review clock-skew calculation changed")


def _source_file_entry(source_lock: Mapping[str, Any], relative: str) -> Mapping[str, Any]:
    files = source_lock.get("files")
    if not isinstance(files, dict):
        raise ValueError("P30 analysis review source lock has no file registry")
    matches = [
        entry
        for entry in files.values()
        if isinstance(entry, dict) and entry.get("path") == relative
    ]
    if len(matches) != 1 or not is_sha256(matches[0].get("sha256")):
        raise ValueError(f"P30 analysis review source lock does not bind {relative}")
    return matches[0]


def _validate_remote_review_request(
    request: Mapping[str, Any],
    *,
    request_path: Path,
    draft_path: Path,
    draft_sha256: str,
    manifest_path: Path,
    manifest_sha256: str,
    attempt_path: Path,
    review_receipt_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    review_attester_public_key_path: Path,
    review_attester_public_key_sha256: str,
) -> None:
    exact_keys(
        request,
        {
            "schemaVersion",
            "campaignInstanceId",
            "protocol",
            "role",
            "verb",
            "subject",
            "predecessorSha256",
            "expectedOutputPath",
            "requestNonce",
        },
        "P30 local analysis review-attester request",
    )
    subject = request.get("subject")
    exact_keys(
        subject,
        {
            "logicalId",
            "authorizationDraft",
            "manifest",
            "reviewAttemptPath",
            "reviewStdoutPath",
            "reviewStderrPath",
            "reviewAttesterPublicKey",
            "claudeExecutable",
            "reviewRuntime",
            "launcherSha256",
        },
        "P30 local analysis review-attester request subject",
    )
    if (
        request.get("schemaVersion") != "arc-v35-p30-role-request-v1"
        or request.get("role") != "review-attester"
        or request.get("verb") != "attest-analysis-review"
        or subject.get("logicalId") != "final-analysis-fable-review-attestation"
        or subject.get("authorizationDraft")
        != {"path": str(draft_path), "sha256": draft_sha256}
        or subject.get("manifest")
        != {"path": str(manifest_path), "sha256": manifest_sha256}
        or subject.get("reviewAttemptPath") != str(attempt_path)
        or subject.get("reviewStdoutPath") != str(stdout_path)
        or subject.get("reviewStderrPath") != str(stderr_path)
        or subject.get("reviewAttesterPublicKey")
        != {
            "path": str(review_attester_public_key_path),
            "sha256": review_attester_public_key_sha256,
        }
        or subject.get("claudeExecutable") != APPROVED_CLAUDE_EXECUTABLE
        or subject.get("reviewRuntime") != APPROVED_REVIEW_RUNTIME
        or not is_sha256(subject.get("launcherSha256"))
        or request.get("predecessorSha256") != draft_sha256
        or request.get("expectedOutputPath") != str(review_receipt_path)
        or not is_sha256(request.get("requestNonce"))
        or request_path.parent.name != "requests"
    ):
        raise ValueError("P30 local analysis review-attester request changed")


def validate_analysis_review_attempt_payload(
    attempt: Mapping[str, Any],
    *,
    attempt_path: Path,
    request_binding: Mapping[str, str],
    draft_binding: Mapping[str, str],
    manifest_binding: Mapping[str, str],
    receipt_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    source_lock_sha256: str,
    launcher_sha256: str,
    claude_executable: Mapping[str, str],
    container_runtime: Mapping[str, Any],
    container_name: str,
    container_invocation_sha256: str,
    container_id: str,
    container_config_sha256: str,
    authenticated_liveness: Mapping[str, Any],
    clock_skew_preflight: Mapping[str, Any],
) -> None:
    exact_keys(
        attempt,
        {
            "schemaVersion",
            "valid",
            "immutable",
            "outcomesInspected",
            "promotionEligible",
            "request",
            "authorizationDraft",
            "manifest",
            "attemptPath",
            "receiptPath",
            "stdoutPath",
            "stderrPath",
            "sourceLockSha256",
            "launcherSha256",
            "claudeExecutable",
            "containerRuntime",
            "containerName",
            "containerInvocationSha256",
            "containerId",
            "containerConfigSha256",
            "authenticatedLiveness",
            "clockSkewPreflight",
            "reservedAtUtc",
        },
        "P30 analysis review attempt reservation",
    )
    if (
        attempt.get("schemaVersion") != ANALYSIS_REVIEW_ATTEMPT_SCHEMA
        or attempt.get("valid") is not True
        or attempt.get("immutable") is not True
        or attempt.get("outcomesInspected") is not False
        or attempt.get("promotionEligible") is not False
        or attempt.get("request") != request_binding
        or attempt.get("authorizationDraft") != draft_binding
        or attempt.get("manifest") != manifest_binding
        or attempt.get("attemptPath") != str(attempt_path)
        or attempt.get("receiptPath") != str(receipt_path)
        or attempt.get("stdoutPath") != str(stdout_path)
        or attempt.get("stderrPath") != str(stderr_path)
        or attempt.get("sourceLockSha256") != source_lock_sha256
        or attempt.get("launcherSha256") != launcher_sha256
        or attempt.get("claudeExecutable") != dict(claude_executable)
        or attempt.get("containerRuntime") != dict(container_runtime)
        or attempt.get("containerName") != container_name
        or not isinstance(container_name, str)
        or CONTAINER_NAME_PATTERN.fullmatch(container_name) is None
        or attempt.get("containerInvocationSha256") != container_invocation_sha256
        or not is_sha256(container_invocation_sha256)
        or attempt.get("containerId") != container_id
        or not re.fullmatch(r"[0-9a-f]{64}", container_id)
        or attempt.get("containerConfigSha256") != container_config_sha256
        or not is_sha256(container_config_sha256)
        or attempt.get("authenticatedLiveness") != dict(authenticated_liveness)
        or attempt.get("clockSkewPreflight") != dict(clock_skew_preflight)
        or not isinstance(attempt.get("reservedAtUtc"), str)
    ):
        raise ValueError("P30 analysis review attempt reservation changed")
    utc_instant(attempt["reservedAtUtc"], "analysis review attempt reservation")


def _validate_analysis_review_payload(
    receipt: dict[str, Any],
    *,
    draft_path: Path,
    manifest_path: Path,
    review_attester_public_key_path: Path,
    verify_local_files: bool,
) -> dict[str, Any]:
    draft_path = draft_path.resolve()
    manifest_path = manifest_path.resolve()
    exact_keys(
        receipt,
        {
            "schemaVersion", "valid", "immutable", "outcomesInspected",
            "promotionEligible", "targetDraftPath", "targetDraftSha256",
            "manifestPath", "manifestSha256", "reviewRequestPath",
            "reviewRequestSha256", "reviewAttemptPath", "reviewAttemptSha256",
            "localAttemptPath", "localAttemptSha256", "localCompletionPath",
            "localCompletionSha256", "localTargetDraftPath",
            "localTargetDraftSha256", "localManifestPath", "localManifestSha256",
            "localReviewRequestPath", "localReviewRequestSha256", "sourceLockPath",
            "sourceLockSha256", "localSourceLockPath", "localSourceLockSha256",
            "launcherRelativePath", "launcherSha256", "localRepoRoot",
            "reviewAttesterPublicKeyPath", "reviewAttesterPublicKeySha256",
            "localReviewAttesterPublicKeyPath", "localReviewAttesterPublicKeySha256",
            "model", "effort", "tools", "noSessionPersistence", "claudeExecutable",
            "argv", "containerArgv", "containerName", "containerInvocationSha256",
            "containerId", "containerConfig", "containerConfigSha256", "startArgv",
            "cleanupArgv", "cleanupVerified", "authenticatedLiveness",
            "clockSkewPreflight", "cwd",
            "containerCwd", "environment",
            "containerRuntime",
            "startedAtUtc", "finishedAtUtc", "exitCode", "stdoutPath",
            "stdoutSha256", "localStdoutPath", "localStdoutSha256", "stderrPath",
            "stderrSha256", "localStderrPath", "localStderrSha256", "verdict",
            "request",
        },
        "P30 analysis Fable review receipt",
    )
    request_path = Path(receipt["reviewRequestPath"])
    attempt_path = Path(receipt["reviewAttemptPath"])
    stdout_path = Path(receipt["stdoutPath"])
    stderr_path = Path(receipt["stderrPath"])
    local_draft = Path(receipt["localTargetDraftPath"])
    local_manifest = Path(receipt["localManifestPath"])
    local_request = Path(receipt["localReviewRequestPath"])
    local_attempt = Path(receipt["localAttemptPath"])
    local_completion = Path(receipt["localCompletionPath"])
    local_stdout = Path(receipt["localStdoutPath"])
    local_stderr = Path(receipt["localStderrPath"])
    local_source_lock = Path(receipt["localSourceLockPath"])
    local_review_attester_key = Path(receipt["localReviewAttesterPublicKeyPath"])
    local_repo_root = Path(receipt["localRepoRoot"])
    draft_hash = sha256(local_draft if verify_local_files else draft_path)
    manifest_hash = sha256(local_manifest if verify_local_files else manifest_path)
    executable = receipt.get("claudeExecutable")
    exact_keys(executable, {"path", "sha256", "version"}, "Claude executable binding")
    if (
        not Path(executable["path"]).is_absolute()
        or not is_sha256(executable.get("sha256"))
        or not isinstance(executable.get("version"), str)
        or VERSION_PATTERN.fullmatch(executable["version"]) is None
        or dict(executable) != APPROVED_CLAUDE_EXECUTABLE
    ):
        raise ValueError("P30 review Claude executable binding changed")
    capsule = Path(receipt["cwd"])
    try:
        container_draft = CONTAINER_REVIEW_ROOT / local_draft.relative_to(capsule)
        container_manifest = CONTAINER_REVIEW_ROOT / local_manifest.relative_to(capsule)
        container_request = CONTAINER_REVIEW_ROOT / local_request.relative_to(capsule)
    except ValueError as exc:
        raise ValueError("P30 analysis review inputs escaped the capsule") from exc
    claude_argv = expected_argv(
        local_draft_path=container_draft,
        draft_sha256=draft_hash,
        local_manifest_path=container_manifest,
        manifest_sha256=manifest_hash,
        local_request_path=container_request,
        request_sha256=receipt["reviewRequestSha256"],
        remote_draft_path=str(draft_path),
        remote_manifest_path=str(manifest_path),
        claude_path=executable["path"],
    )
    environment = receipt.get("environment")
    exact_keys(
        environment,
        {"clearInherited", "keys", "secretKeys", "home", "tmpdir", "authDelivery"},
        "P30 analysis Fable environment",
    )
    if (
        environment.get("clearInherited") is not True
        or environment.get("keys") != list(SANITIZED_ENVIRONMENT_KEYS)
        or environment.get("secretKeys") != []
        or environment.get("authDelivery") != CLAUDE_AUTH_DELIVERY
        or environment.get("home") != str(capsule / "runtime-home")
        or environment.get("tmpdir") != str(capsule / "tmp")
    ):
        raise ValueError("P30 analysis Fable environment changed")
    container_runtime = receipt.get("containerRuntime")
    container_name = receipt.get("containerName")
    container_id = receipt.get("containerId")
    container_argv = expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=claude_argv
    )
    container_invocation_sha256 = sha256_bytes(canonical_json(container_argv))
    container_config = expected_container_config(
        capsule=capsule, container_name=container_name, container_id=container_id,
        claude_argv=claude_argv,
    )
    container_config_sha256 = sha256_bytes(canonical_json(container_config))
    authenticated_liveness = receipt.get("authenticatedLiveness")
    validate_authenticated_liveness(
        authenticated_liveness, capsule=capsule, verify_local_files=verify_local_files
    )
    clock_skew_preflight = receipt.get("clockSkewPreflight")
    validate_clock_skew_preflight(clock_skew_preflight)
    if (
        receipt.get("schemaVersion") != ANALYSIS_REVIEW_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("immutable") is not True
        or receipt.get("outcomesInspected") is not False
        or receipt.get("promotionEligible") is not False
        or receipt.get("targetDraftPath") != str(draft_path)
        or receipt.get("targetDraftSha256") != draft_hash
        or receipt.get("manifestPath") != str(manifest_path)
        or receipt.get("manifestSha256") != manifest_hash
        or receipt.get("localTargetDraftSha256") != draft_hash
        or receipt.get("localManifestSha256") != manifest_hash
        or receipt.get("localReviewRequestSha256") != receipt.get("reviewRequestSha256")
        or receipt.get("localAttemptSha256") != receipt.get("reviewAttemptSha256")
        or not is_sha256(receipt.get("localCompletionSha256"))
        or receipt.get("localSourceLockSha256") != receipt.get("sourceLockSha256")
        or receipt.get("localReviewAttesterPublicKeySha256")
        != receipt.get("reviewAttesterPublicKeySha256")
        or receipt.get("launcherRelativePath") != LOCAL_REVIEW_LAUNCHER_RELATIVE
        or not is_sha256(receipt.get("launcherSha256"))
        or receipt.get("model") != "fable"
        or receipt.get("effort") != "high"
        or receipt.get("tools") != ["Read"]
        or receipt.get("noSessionPersistence") is not True
        or receipt.get("argv") != claude_argv
        or receipt.get("containerArgv") != container_argv
        or receipt.get("containerInvocationSha256") != container_invocation_sha256
        or receipt.get("containerConfig") != container_config
        or receipt.get("containerConfigSha256") != container_config_sha256
        or receipt.get("startArgv") != expected_container_start_argv(container_name)
        or receipt.get("cleanupArgv") != expected_container_cleanup_argv(container_name)
        or receipt.get("cleanupVerified") is not True
        or container_runtime != APPROVED_REVIEW_CONTAINER
        or receipt.get("containerCwd") != str(CONTAINER_REVIEW_ROOT)
        or receipt.get("exitCode") != 0
        or receipt.get("verdict") != "ACCEPT"
        or receipt.get("localStdoutSha256") != receipt.get("stdoutSha256")
        or receipt.get("localStderrSha256") != receipt.get("stderrSha256")
        or not all(
            is_sha256(receipt.get(field))
            for field in (
                "reviewRequestSha256", "reviewAttemptSha256", "sourceLockSha256",
                "reviewAttesterPublicKeySha256", "stdoutSha256", "stderrSha256",
            )
        )
    ):
        raise ValueError("P30 analysis Fable review receipt changed")

    draft = read_json_object(local_draft if verify_local_files else draft_path, "analysis draft")
    manifest = read_json_object(
        local_manifest if verify_local_files else manifest_path, "analysis manifest"
    )
    source_binding = draft.get("sourceContract")
    if (
        not isinstance(source_binding, dict)
        or set(source_binding) != {"path", "sha256"}
        or receipt.get("sourceLockPath") != source_binding["path"]
        or receipt.get("sourceLockSha256") != source_binding["sha256"]
    ):
        raise ValueError("P30 analysis Fable source lock binding changed")
    request_read = local_request if verify_local_files else request_path
    request = read_json_object(request_read, "P30 local analysis review-attester request")
    if sha256(request_read) != receipt["reviewRequestSha256"]:
        raise ValueError("P30 local analysis review-attester request hash changed")
    _validate_remote_review_request(
        request,
        request_path=request_path,
        draft_path=draft_path,
        draft_sha256=draft_hash,
        manifest_path=manifest_path,
        manifest_sha256=manifest_hash,
        attempt_path=attempt_path,
        review_receipt_path=Path(request["expectedOutputPath"]),
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        review_attester_public_key_path=Path(receipt["reviewAttesterPublicKeyPath"]),
        review_attester_public_key_sha256=receipt["reviewAttesterPublicKeySha256"],
    )
    if request["subject"]["launcherSha256"] != receipt["launcherSha256"]:
        raise ValueError("P30 analysis review request launcher binding changed")
    if receipt.get("request") != {
        "path": str(request_path), "sha256": receipt["reviewRequestSha256"]
    }:
        raise ValueError("P30 analysis review receipt lacks its exact local-attester request")
    attempt_read = local_attempt if verify_local_files else attempt_path
    attempt = read_json_object(attempt_read, "P30 analysis review attempt reservation")
    if sha256(attempt_read) != receipt["reviewAttemptSha256"]:
        raise ValueError("P30 analysis review attempt reservation hash changed")
    validate_analysis_review_attempt_payload(
        attempt,
        attempt_path=attempt_path,
        request_binding=receipt["request"],
        draft_binding={"path": str(draft_path), "sha256": draft_hash},
        manifest_binding={"path": str(manifest_path), "sha256": manifest_hash},
        receipt_path=Path(request["expectedOutputPath"]),
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        source_lock_sha256=receipt["sourceLockSha256"],
        launcher_sha256=receipt["launcherSha256"],
        claude_executable=executable,
        container_runtime=container_runtime,
        container_name=container_name,
        container_invocation_sha256=container_invocation_sha256,
        container_id=container_id,
        container_config_sha256=container_config_sha256,
        authenticated_liveness=authenticated_liveness,
        clock_skew_preflight=clock_skew_preflight,
    )
    started = utc_instant(receipt["startedAtUtc"], "analysis Fable review start")
    finished = utc_instant(receipt["finishedAtUtc"], "analysis Fable review finish")
    reserved = utc_instant(attempt["reservedAtUtc"], "analysis review reservation")
    if finished <= started or started <= reserved:
        raise ValueError("P30 analysis Fable review did not run after its reservation")
    if started <= max(
        utc_instant(draft.get("issuedAtUtc"), "analysis draft issue time"),
        utc_instant(manifest.get("issuedAtUtc"), "analysis manifest issue time"),
    ):
        raise ValueError("P30 analysis Fable review did not start after its inputs")
    stream_stdout = local_stdout if verify_local_files else stdout_path
    stream_stderr = local_stderr if verify_local_files else stderr_path
    if sha256(stream_stdout) != receipt["stdoutSha256"] or sha256(stream_stderr) != receipt["stderrSha256"]:
        raise ValueError("P30 analysis Fable review stream changed")
    if stream_stderr.stat().st_size != 0:
        raise ValueError("P30 analysis Fable review stderr is not empty")
    nonempty = [
        line.strip()
        for line in read_regular_nofollow(stream_stdout).decode("utf-8").splitlines()
        if line.strip()
    ]
    if not nonempty or nonempty[-1] != "VERDICT: ACCEPT":
        raise ValueError("P30 analysis Fable review did not end in VERDICT: ACCEPT")

    source_lock_path = (
        local_source_lock
        if verify_local_files
        else resolve_artifact(source_binding["path"], anchor=REPO_ROOT, label="source lock")
    )
    source_lock = read_json_object(source_lock_path, "analysis review source lock")
    launcher_entry = _source_file_entry(source_lock, LOCAL_REVIEW_LAUNCHER_RELATIVE)
    if launcher_entry["sha256"] != receipt["launcherSha256"]:
        raise ValueError("P30 local analysis review launcher differs from source lock")
    if verify_local_files:
        files = (
            (local_draft, "localTargetDraftSha256"),
            (local_manifest, "localManifestSha256"),
            (local_request, "localReviewRequestSha256"),
            (local_attempt, "localAttemptSha256"),
            (local_completion, "localCompletionSha256"),
            (local_stdout, "localStdoutSha256"),
            (local_stderr, "localStderrSha256"),
            (local_source_lock, "localSourceLockSha256"),
            (local_review_attester_key, "localReviewAttesterPublicKeySha256"),
        )
        for local_path, field in files:
            expected = receipt[field]
            if not local_path.is_file() or sha256(local_path) != expected:
                raise ValueError("P30 analysis Fable local evidence changed")
        launcher = local_repo_root / LOCAL_REVIEW_LAUNCHER_RELATIVE
        if sha256(launcher) != receipt["launcherSha256"]:
            raise ValueError("P30 analysis Fable local launcher changed")
        engine = APPROVED_REVIEW_CONTAINER["engine"]
        resolved_engine = Path(engine["path"]).resolve()
        if (
            str(resolved_engine) != engine["resolvedPath"]
            or sha256(resolved_engine) != engine["sha256"]
        ):
            raise ValueError("P30 review container engine changed")
    return receipt


def validate_local_analysis_review_payload(
    receipt: dict[str, Any],
    *,
    remote_draft_path: Path,
    remote_manifest_path: Path,
    review_attester_public_key_path: Path,
    artifact_path: Path | None = None,
) -> dict[str, Any]:
    del artifact_path
    return _validate_analysis_review_payload(
        receipt,
        draft_path=remote_draft_path,
        manifest_path=remote_manifest_path,
        review_attester_public_key_path=review_attester_public_key_path,
        verify_local_files=True,
    )


def validate_signed_local_analysis_review_payload(
    signed: Mapping[str, Any],
    *,
    remote_draft_path: Path,
    remote_manifest_path: Path,
    review_attester_public_key_path: Path,
) -> dict[str, Any]:
    payload = verify_signed_payload(
        signed, expected_role="review-attester", public_key_path=review_attester_public_key_path
    )
    return validate_local_analysis_review_payload(
        payload,
        remote_draft_path=remote_draft_path,
        remote_manifest_path=remote_manifest_path,
        review_attester_public_key_path=review_attester_public_key_path,
    )


def validate_analysis_review_receipt(
    receipt_path: Path,
    *,
    draft_path: Path,
    manifest_path: Path,
    review_attester_public_key_path: Path,
) -> dict[str, Any]:
    signed = read_json_object(receipt_path.resolve(), "signed P30 analysis Fable review receipt")
    payload = verify_signed_payload(
        signed, expected_role="review-attester", public_key_path=review_attester_public_key_path
    )
    return _validate_analysis_review_payload(
        payload,
        draft_path=draft_path,
        manifest_path=manifest_path,
        review_attester_public_key_path=review_attester_public_key_path,
        verify_local_files=False,
    )


def validate_analysis_review_draft(*args: Any, **kwargs: Any) -> dict[str, Any]:
    del args, kwargs
    raise ValueError("unsigned P30 analysis review receipts are no longer accepted")
