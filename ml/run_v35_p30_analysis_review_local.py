#!/usr/bin/env python3
"""Exactly-once, source-locked local launcher for the final P30 Fable gate.

No report/replay/outcome is copied locally.  Before Fable starts, a request-bound
attempt is durably created with O_EXCL on SimForge.  Every later failure closes
the lane.  Fable runs in a default-deny macOS sandbox and the completed receipt
is signed locally with the dedicated one-operation review-attester key from
MichaelAgents; that private key is never delivered to SimForge.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import shlex
import shutil
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
    CLAUDE_AUTH_ENVIRONMENT_KEY,
    LOCAL_REVIEW_LAUNCHER_RELATIVE,
    SANITIZED_ENVIRONMENT_KEYS,
    expected_argv,
    sandbox_runtime_read_paths,
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


def validate_scheduler_status(value: Mapping[str, Any]) -> dict[str, Any]:
    expected = {
        "schemaVersion", "status", "manifest", "authorizationDraft",
        "reviewReceiptPath", "reviewAttemptPath", "reviewStdoutPath",
        "reviewStderrPath", "reviewAttestationRequest", "reviewAttesterPublicKey",
        "claudeExecutable",
        "outcomesInspected", "promotionEligible",
    }
    if set(value) != expected:
        raise ValueError("remote P30 analysis-review scheduler status keys changed")
    if (
        value.get("schemaVersion") != "arc-v35-p30-campaign-status-v1"
        or value.get("status") != "analysis-review-required"
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
    parents = {Path(value[field]).parent for field in (
        "reviewReceiptPath", "reviewAttemptPath", "reviewStdoutPath", "reviewStderrPath"
    )}
    if len(parents) != 1:
        raise ValueError("scheduler review artifacts do not share one ledger directory")
    return dict(value)


def scheduler_status(*, remote: str, remote_repo: str, remote_protocol: str, timeout: int) -> dict[str, Any]:
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
    return validate_scheduler_status(json.loads(lines[0]))


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
    forbidden = {"wins", "losses", "winRate", "trueWinRate", "lateGameScore", "victoryPoints", "selectedArm"}
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
    ):
        raise ValueError("review-attester request does not bind the local review")
    return manifest, draft, request


def _sandbox_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_sandbox_profile(*, capsule: Path, executable: Path) -> bytes:
    """Construct a default-deny profile; only capsule/runtime reads are allowed."""
    capsule = capsule.resolve()
    executable = executable.resolve()
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork)",
        f'(allow process-exec (literal "{_sandbox_string(str(executable))}"))',
        "(allow signal (target self))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow network-outbound)",
        '(allow file-read* (literal "/"))',
    ]
    for path in sorted({str(capsule), *sandbox_runtime_read_paths(executable)}):
        escaped = _sandbox_string(path)
        lines.append(f'(allow file-read* (literal "{escaped}"))')
        lines.append(f'(allow file-read* (subpath "{escaped}"))')
    escaped_capsule = _sandbox_string(str(capsule))
    lines.append(f'(allow file-write* (literal "{escaped_capsule}"))')
    lines.append(f'(allow file-write* (subpath "{escaped_capsule}"))')
    return ("\n".join(lines) + "\n").encode("utf-8")


def resolve_claude_executable(command: str, *, environment: Mapping[str, str]) -> dict[str, str]:
    found = shutil.which(command) if not Path(command).is_absolute() else command
    if not found:
        raise FileNotFoundError("frozen Claude executable is unavailable")
    path = Path(found).resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("resolved Claude executable is not executable")
    completed = subprocess.run(
        [str(path), "--version"], stdin=subprocess.DEVNULL, capture_output=True,
        timeout=30, env=dict(environment), check=True,
    )
    version = completed.stdout.decode("utf-8").strip()
    if completed.stderr or not version or "\n" in version or len(version) > 256:
        raise ValueError("Claude executable version output changed")
    return {"path": str(path), "sha256": sha256_file(path), "version": version}


def read_secret_fd(descriptor: int, label: str) -> bytearray:
    metadata = os.fstat(descriptor)
    if os.isatty(descriptor) or not (stat.S_ISFIFO(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)):
        raise ValueError(f"{label} must arrive through a pipe or socket")
    secret = bytearray()
    while len(secret) <= MAXIMUM_SECRET_BYTES:
        chunk = os.read(descriptor, min(65536, MAXIMUM_SECRET_BYTES + 1 - len(secret)))
        if not chunk: break
        secret.extend(chunk)
    while secret and secret[-1] in b"\r\n": secret.pop()
    if not secret or len(secret) > MAXIMUM_SECRET_BYTES or b"\x00" in secret:
        secret[:] = b"\0" * len(secret)
        raise ValueError(f"{label} is empty or oversized")
    return secret


def sanitized_environment(*, capsule: Path, claude_auth: bytearray | None) -> dict[str, str]:
    home = capsule / "runtime-home"
    tmp = capsule / "tmp"
    for path in (home, tmp, home / ".cache", home / ".config", home / ".local/share"):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = {
        "HOME": str(home), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "NO_COLOR": "1",
        "PATH": "/usr/bin:/bin", "TMPDIR": str(tmp),
        "XDG_CACHE_HOME": str(home / ".cache"), "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
    }
    if claude_auth is not None:
        result[CLAUDE_AUTH_ENVIRONMENT_KEY] = claude_auth.decode("utf-8")
    if sorted(result) != sorted(
        key for key in SANITIZED_ENVIRONMENT_KEYS if claude_auth is not None or key != CLAUDE_AUTH_ENVIRONMENT_KEY
    ):
        raise RuntimeError("P30 sanitized environment construction changed")
    return result


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
    *, sandbox_argv: Sequence[str], cwd: Path, stdout_path: Path, stderr_path: Path,
    timeout: int, environment: Mapping[str, str],
) -> tuple[str, str, int]:
    stdout_fd = _open_exclusive_stream(stdout_path)
    try: stderr_fd = _open_exclusive_stream(stderr_path)
    except BaseException:
        os.close(stdout_fd); stdout_path.unlink(missing_ok=True); raise
    started = utc_now()
    try:
        completed = subprocess.run(
            list(sandbox_argv), cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout_fd,
            stderr=stderr_fd, timeout=timeout, env=dict(environment), close_fds=True,
        )
    finally:
        os.close(stdout_fd); os.close(stderr_fd)
    return started, utc_now(), completed.returncode


def require_exact_accept(*, stdout_path: Path, stderr_path: Path, exit_code: int) -> None:
    stdout = read_regular_nofollow(stdout_path)
    stderr = read_regular_nofollow(stderr_path)
    nonempty = [line.strip() for line in stdout.decode("utf-8").splitlines() if line.strip()]
    if exit_code != 0 or stderr or not nonempty or nonempty[-1] != "VERDICT: ACCEPT":
        raise RuntimeError("local P30 Fable review did not pass exactly; the consumed lane is closed")


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
    if any(os.path.lexists(target) for _,target,_ in items): raise FileExistsError('target exists')
    for stage,target,expected in items:
        st=os.lstat(stage)
        if not stat.S_ISREG(st.st_mode): raise ValueError('stage is not regular')
        h=hashlib.sha256()
        with open(stage,'rb') as f:
            for block in iter(lambda:f.read(1048576),b''): h.update(block)
        if h.hexdigest()!=expected: raise ValueError('stage hash mismatch')
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
    base_env = sanitized_environment(capsule=capsule, claude_auth=None)
    executable = resolve_claude_executable(args.claude, environment=base_env)
    if executable != status["claudeExecutable"]:
        raise ValueError("resolved Claude executable differs from the frozen scheduler pin")
    profile_path = capsule / "sandbox.sb"
    atomic_write_exclusive(
        profile_path,
        build_sandbox_profile(capsule=capsule, executable=Path(executable["path"])),
        mode=0o400,
    )
    launcher_sha = sha256_file(repo_root / LOCAL_REVIEW_LAUNCHER_RELATIVE)
    attempt_local = inputs / "review-attempt.json"
    attempt = {
        "schemaVersion": ANALYSIS_REVIEW_ATTEMPT_SCHEMA, "valid": True, "immutable": True,
        "outcomesInspected": False, "promotionEligible": False,
        "request": dict(status["reviewAttestationRequest"]),
        "authorizationDraft": dict(status["authorizationDraft"]),
        "manifest": dict(status["manifest"]), "attemptPath": status["reviewAttemptPath"],
        "receiptPath": status["reviewReceiptPath"], "stdoutPath": status["reviewStdoutPath"],
        "stderrPath": status["reviewStderrPath"],
        "sourceLockSha256": sha256_file(source_lock_local), "launcherSha256": launcher_sha,
        "claudeExecutable": executable, "sandboxProfileSha256": sha256_file(profile_path),
        "reservedAtUtc": utc_now(),
    }
    atomic_write_exclusive(attempt_local, canonical_json(attempt) + b"\n", mode=0o400)
    auth = read_secret_fd(args.claude_auth_fd, "Claude OAuth token")
    try:
        environment = sanitized_environment(capsule=capsule, claude_auth=auth)
        claude_argv = expected_argv(
            local_draft_path=draft_local, draft_sha256=status["authorizationDraft"]["sha256"],
            local_manifest_path=manifest_local, manifest_sha256=status["manifest"]["sha256"],
            local_request_path=request_local, request_sha256=status["reviewAttestationRequest"]["sha256"],
            remote_draft_path=status["authorizationDraft"]["path"],
            remote_manifest_path=status["manifest"]["path"], claude_path=executable["path"],
        )
        sandbox_argv = [args.sandbox_exec, "-f", str(profile_path), *claude_argv]
        stdout_local, stderr_local = outputs / "fable.stdout", outputs / "fable.stderr"
        # This is the final non-Fable preflight. Secret retrieval, environment
        # construction, input validation, runtime hashing, and sandbox creation
        # have already succeeded. Once this remote O_EXCL reservation lands,
        # every later failure is terminal and no retry is permitted.
        reserve_remote_attempt(
            remote=args.remote,
            remote_path=status["reviewAttemptPath"],
            payload=read_regular_nofollow(attempt_local),
            timeout=args.transfer_timeout_seconds,
        )
        started, finished, exit_code = run_fable(
            sandbox_argv=sandbox_argv, cwd=capsule, stdout_path=stdout_local,
            stderr_path=stderr_local, timeout=args.review_timeout_seconds, environment=environment,
        )
    finally:
        auth[:] = b"\0" * len(auth)
    require_exact_accept(stdout_path=stdout_local, stderr_path=stderr_local, exit_code=exit_code)
    source_binding = draft["sourceContract"]
    unsigned_local = outputs / "review-receipt.unsigned.json"
    signed_local = outputs / "review-receipt.signed.json"
    receipt = {
        "schemaVersion": ANALYSIS_REVIEW_RECEIPT_SCHEMA, "valid": True, "immutable": True,
        "outcomesInspected": False, "promotionEligible": False,
        "targetDraftPath": status["authorizationDraft"]["path"],
        "targetDraftSha256": status["authorizationDraft"]["sha256"],
        "manifestPath": status["manifest"]["path"], "manifestSha256": status["manifest"]["sha256"],
        "reviewRequestPath": status["reviewAttestationRequest"]["path"],
        "reviewRequestSha256": status["reviewAttestationRequest"]["sha256"],
        "reviewAttemptPath": status["reviewAttemptPath"], "reviewAttemptSha256": sha256_file(attempt_local),
        "localAttemptPath": str(attempt_local), "localAttemptSha256": sha256_file(attempt_local),
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
        "claudeExecutable": executable, "argv": claude_argv, "sandboxArgv": sandbox_argv,
        "cwd": str(capsule),
        "environment": {
            "clearInherited": True, "keys": list(SANITIZED_ENVIRONMENT_KEYS),
            "secretKeys": [CLAUDE_AUTH_ENVIRONMENT_KEY], "home": str(capsule / "runtime-home"),
            "tmpdir": str(capsule / "tmp"),
        },
        "sandbox": {
            "backend": "sandbox-exec", "backendPath": args.sandbox_exec,
            "profilePath": str(profile_path), "profileSha256": sha256_file(profile_path),
            "defaultDecision": "deny",
            "allowedReadPaths": sorted({str(capsule), *sandbox_runtime_read_paths(Path(executable["path"]))}),
            "allowedWritePaths": [str(capsule)], "network": ["outbound"],
            "filesystemSecretsAllowed": False,
        },
        "startedAtUtc": started, "finishedAtUtc": finished, "exitCode": exit_code,
        "stdoutPath": status["reviewStdoutPath"], "stdoutSha256": sha256_file(stdout_local),
        "localStdoutPath": str(stdout_local), "localStdoutSha256": sha256_file(stdout_local),
        "stderrPath": status["reviewStderrPath"], "stderrSha256": sha256_file(stderr_local),
        "localStderrPath": str(stderr_local), "localStderrSha256": sha256_file(stderr_local),
        "verdict": "ACCEPT", "request": dict(status["reviewAttestationRequest"]),
    }
    atomic_write_exclusive(unsigned_local, canonical_json(receipt) + b"\n", mode=0o400)
    validate_local_analysis_review_payload(
        receipt, remote_draft_path=Path(status["authorizationDraft"]["path"]),
        remote_manifest_path=Path(status["manifest"]["path"]),
        review_attester_public_key_path=review_attester_key_local,
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
    parser.add_argument("--claude", default="claude")
    parser.add_argument("--claude-auth-fd", type=int, default=3)
    parser.add_argument("--sandbox-exec", default="/usr/bin/sandbox-exec")
    parser.add_argument("--review-timeout-seconds", type=int, default=3600)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=120)
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
    if args.sandbox_exec != "/usr/bin/sandbox-exec":
        raise ValueError("P30 review sandbox executable changed")
    print(str(launch(args)))


if __name__ == "__main__":
    main()
