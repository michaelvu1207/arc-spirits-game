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
from v35_p30_crypto import read_regular_nofollow, verify_signed_payload


ANALYSIS_REVIEW_RECEIPT_SCHEMA = (
    "arc-v35-p30-analysis-authorization-review-receipt-v2"
)
ANALYSIS_REVIEW_ATTEMPT_SCHEMA = "arc-v35-p30-analysis-review-attempt-v1"
LOCAL_REVIEW_LAUNCHER_RELATIVE = "ml/run_v35_p30_analysis_review_local.py"
CLAUDE_AUTH_ENVIRONMENT_KEY = "CLAUDE_CODE_OAUTH_TOKEN"
SANITIZED_ENVIRONMENT_KEYS = (
    "CLAUDE_CODE_OAUTH_TOKEN",
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
)
VERSION_PATTERN = re.compile(r"^[^\r\n]{1,256}$")
APPROVED_CLAUDE_EXECUTABLE = {
    "path": "/Users/maikyon/.local/share/claude/versions/2.1.211",
    "sha256": "5a728a76198b6eca7f3c7cdbff43bab44b77b48c2108f7a3107d889773382629",
    "version": "2.1.211 (Claude Code)",
}


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


def sandbox_runtime_read_paths(claude_executable: Path) -> list[str]:
    """Minimal immutable macOS runtime roots required by a Mach-O CLI."""

    paths = {
        str(claude_executable.resolve()),
        "/Library/Apple/System",
        "/System",
        "/dev/null",
        "/dev/random",
        "/dev/urandom",
        "/private/var/db/dyld",
        "/usr/lib",
        "/usr/share/icu",
    }
    return sorted(paths)


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
    sandbox_profile_sha256: str,
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
            "sandboxProfileSha256",
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
        or attempt.get("sandboxProfileSha256") != sandbox_profile_sha256
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
            "localAttemptPath", "localAttemptSha256", "localTargetDraftPath",
            "localTargetDraftSha256", "localManifestPath", "localManifestSha256",
            "localReviewRequestPath", "localReviewRequestSha256", "sourceLockPath",
            "sourceLockSha256", "localSourceLockPath", "localSourceLockSha256",
            "launcherRelativePath", "launcherSha256", "localRepoRoot",
            "reviewAttesterPublicKeyPath", "reviewAttesterPublicKeySha256",
            "localReviewAttesterPublicKeyPath", "localReviewAttesterPublicKeySha256",
            "model", "effort", "tools", "noSessionPersistence", "claudeExecutable",
            "argv", "sandboxArgv", "cwd", "environment", "sandbox",
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
    claude_argv = expected_argv(
        local_draft_path=local_draft,
        draft_sha256=draft_hash,
        local_manifest_path=local_manifest,
        manifest_sha256=manifest_hash,
        local_request_path=local_request,
        request_sha256=receipt["reviewRequestSha256"],
        remote_draft_path=str(draft_path),
        remote_manifest_path=str(manifest_path),
        claude_path=executable["path"],
    )
    environment = receipt.get("environment")
    exact_keys(
        environment,
        {"clearInherited", "keys", "secretKeys", "home", "tmpdir"},
        "P30 analysis Fable environment",
    )
    capsule = Path(receipt["cwd"])
    if (
        environment.get("clearInherited") is not True
        or environment.get("keys") != list(SANITIZED_ENVIRONMENT_KEYS)
        or environment.get("secretKeys") != [CLAUDE_AUTH_ENVIRONMENT_KEY]
        or environment.get("home") != str(capsule / "runtime-home")
        or environment.get("tmpdir") != str(capsule / "tmp")
    ):
        raise ValueError("P30 analysis Fable environment changed")
    sandbox = receipt.get("sandbox")
    exact_keys(
        sandbox,
        {
            "backend", "backendPath", "profilePath", "profileSha256",
            "defaultDecision", "allowedReadPaths", "allowedWritePaths",
            "network", "filesystemSecretsAllowed",
        },
        "P30 analysis Fable sandbox",
    )
    expected_reads = sorted(
        {str(capsule.resolve()), *sandbox_runtime_read_paths(Path(executable["path"]))}
    )
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
        or receipt.get("sandboxArgv")
        != [sandbox.get("backendPath"), "-f", sandbox.get("profilePath"), *claude_argv]
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
        or sandbox.get("backend") != "sandbox-exec"
        or sandbox.get("backendPath") != "/usr/bin/sandbox-exec"
        or sandbox.get("defaultDecision") != "deny"
        or sandbox.get("allowedReadPaths") != expected_reads
        or sandbox.get("allowedWritePaths") != [str(capsule.resolve())]
        or sandbox.get("network") != ["outbound"]
        or sandbox.get("filesystemSecretsAllowed") is not False
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
        sandbox_profile_sha256=sandbox["profileSha256"],
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
            (local_stdout, "localStdoutSha256"),
            (local_stderr, "localStderrSha256"),
            (local_source_lock, "localSourceLockSha256"),
            (local_review_attester_key, "localReviewAttesterPublicKeySha256"),
            (Path(sandbox["profilePath"]), None),
        )
        for local_path, field in files:
            expected = sandbox["profileSha256"] if field is None else receipt[field]
            if not local_path.is_file() or sha256(local_path) != expected:
                raise ValueError("P30 analysis Fable local evidence changed")
        launcher = local_repo_root / LOCAL_REVIEW_LAUNCHER_RELATIVE
        if sha256(launcher) != receipt["launcherSha256"]:
            raise ValueError("P30 analysis Fable local launcher changed")
        if sha256(Path(executable["path"])) != executable["sha256"]:
            raise ValueError("P30 review Claude executable changed")
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
