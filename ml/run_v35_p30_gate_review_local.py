#!/usr/bin/env python3
"""Run and attest one metric-free Fable launch-gate review locally."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import shlex
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from run_v35_p30_analysis_review_local import (
    read_secret_fd,
    authenticated_liveness_preflight,
    create_review_completion,
    create_postprocess_marker,
    prepare_review_container,
    remove_review_container,
    remote_clock_preflight,
    require_exact_accept,
    resolve_review_container,
    run_fable,
    sanitized_environment,
    upload_review_evidence,
    validate_postprocess_marker,
    validate_review_completion,
)
from run_v35_p30_local_custody import DEFAULT_CONFIG, load_config
from v35_p30_crypto import (
    SIGNATURE_SCHEMA,
    atomic_write_exclusive,
    canonical_json,
    public_key_identity,
    read_regular_nofollow,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)
from v35_p30_phase0 import (
    REVIEW_RECEIPT_SCHEMA,
    gate_review_launcher_sha256,
    gate_review_prompt,
)
from v35_p30_analysis_review import (
    APPROVED_REVIEW_CONTAINER,
    APPROVED_REVIEW_RUNTIME,
    CLAUDE_AUTH_DELIVERY,
    CONTAINER_REVIEW_ROOT,
    SANITIZED_ENVIRONMENT_KEYS,
    expected_container_cleanup_argv,
    expected_container_config,
    expected_container_create_argv,
    expected_container_start_argv,
    validate_authenticated_liveness,
    validate_clock_skew_preflight,
)


REMOTE = "simforge1"
REMOTE_REPO = "/data/share8/michaelvuaprilexperimentation/arc-bot"
SAFE_REMOTE_PATH = re.compile(r"^/[A-Za-z0-9._/-]+$")
SAFE_REVIEW_PREFIXES = (
    REMOTE_REPO,
    "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger",
    "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-artifacts",
)


def utc_now() -> str:
    import datetime as dt

    return dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")


def _is_sha(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )


def _validate_review_remote_path(value: object) -> str:
    if (
        not isinstance(value, str) or not SAFE_REMOTE_PATH.fullmatch(value)
        or ".." in Path(value).parts
        or not any(value == prefix or value.startswith(prefix + "/") for prefix in SAFE_REVIEW_PREFIXES)
    ):
        raise ValueError("P30 gate-review remote path escaped the frozen roots")
    return value


def scheduler_status(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        str(Path(args.remote_repo) / "ml/.venv/bin/python"),
        "ml/run_v35_p30_campaign.py",
        "--protocol",
        args.remote_protocol,
    ]
    completed = subprocess.run(
        [
            "ssh",
            "-T",
            "-o",
            "LogLevel=ERROR",
            args.remote,
            f"cd {shlex.quote(args.remote_repo)} && {shlex.join(command)}",
        ],
        check=True,
        capture_output=True,
        timeout=args.transfer_timeout_seconds,
    )
    if completed.stderr:
        raise RuntimeError("remote P30 gate scheduler emitted stderr")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("remote P30 gate scheduler emitted unexpected output")
    value = json.loads(lines[0])
    required = {
        "schemaVersion",
        "status",
        "mode",
        "outcomesInspected",
        "promotionEligible",
        "inputs",
        "reviewRequest",
        "attemptPath",
        "stdoutPath",
        "stderrPath",
        "receiptPath",
        "reviewAttesterPublicKey",
        "reviewRuntime",
        "launcherSha256",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("schemaVersion")
        != "arc-v35-p30-gate-review-required-v1"
        or value.get("mode") != args.mode
        or value.get("status") != f"awaiting-{args.mode}-fable-review"
        or value.get("outcomesInspected") is not False
        or value.get("promotionEligible") is not False
        or not isinstance(value.get("inputs"), list)
        or not value["inputs"]
        or value.get("reviewRuntime") != APPROVED_REVIEW_RUNTIME
        or value.get("launcherSha256") != gate_review_launcher_sha256()
    ):
        raise ValueError("remote P30 gate-review status changed")
    for item in [*value["inputs"], value["reviewRequest"], value["reviewAttesterPublicKey"]]:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "sha256"}
            or not Path(item["path"]).is_absolute()
            or not _is_sha(item["sha256"])
        ):
            raise ValueError("remote P30 gate-review binding is malformed")
        _validate_review_remote_path(item["path"])
    for key in ("attemptPath", "stdoutPath", "stderrPath", "receiptPath"):
        if not isinstance(value.get(key), str) or not Path(value[key]).is_absolute():
            raise ValueError("remote P30 gate-review output path is malformed")
        _validate_review_remote_path(value[key])
    return value


def fetch(
    *, remote: str, binding: dict[str, str], target: Path, timeout: int
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _validate_review_remote_path(binding["path"])
    if target.exists() or target.is_symlink():
        raise FileExistsError("P30 gate-review input target already exists")
    try:
        completed = subprocess.run(
            ["scp", "-q", f"{remote}:{binding['path']}", str(target)],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        metadata = target.lstat()
        if (
            completed.stdout
            or completed.stderr
            or target.is_symlink()
            or not stat.S_ISREG(metadata.st_mode)
            or sha256_file(target) != binding["sha256"]
        ):
            raise ValueError("downloaded P30 gate-review input changed")
        os.chmod(target, 0o400)
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def reserve_attempt(
    *, remote: str, path: str, payload: bytes, timeout: int
) -> None:
    encoded = base64.b64encode(payload).decode("ascii")
    script = (
        "import base64,os,sys; p=sys.argv[1]; d=base64.b64decode(sys.argv[2],validate=True); "
        "os.makedirs(os.path.dirname(p),exist_ok=True); "
        "f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400); "
        "os.write(f,d); os.fsync(f); os.close(f); "
        "q=os.open(os.path.dirname(p),os.O_RDONLY); os.fsync(q); os.close(q)"
    )
    completed = subprocess.run(
        [
            "ssh",
            "-T",
            "-o",
            "LogLevel=ERROR",
            remote,
            shlex.join(["python3", "-c", script, path, encoded]),
        ],
        capture_output=True,
        timeout=timeout,
    )
    if completed.returncode != 0 or completed.stdout or completed.stderr:
        raise RuntimeError("P30 gate-review attempt is already consumed")


def validate_gate_unsigned_for_signing(payload: dict[str, Any]) -> None:
    capsule = Path(str(payload.get("cwd")))
    liveness = payload.get("authenticatedLiveness")
    validate_authenticated_liveness(liveness, capsule=capsule, verify_local_files=True)
    validate_clock_skew_preflight(payload.get("clockSkewPreflight"))
    completion_binding = payload.get("completion")
    if not isinstance(completion_binding, dict) or set(completion_binding) != {"path", "sha256"}:
        raise ValueError("P30 gate-review completion binding changed")
    completion_path = Path(completion_binding["path"])
    completion = json.loads(read_regular_nofollow(completion_path))
    name = payload.get("containerName")
    identifier = payload.get("containerId")
    config = expected_container_config(
        capsule=capsule, container_name=name, container_id=identifier,
        claude_argv=payload.get("argv"),
    )
    if (
        payload.get("schemaVersion") != REVIEW_RECEIPT_SCHEMA
        or payload.get("valid") is not True or payload.get("immutable") is not True
        or payload.get("outcomesInspected") is not False
        or payload.get("promotionEligible") is not False
        or payload.get("verdict") != "ACCEPT" or payload.get("exitCode") != 0
        or payload.get("launcherSha256") != gate_review_launcher_sha256()
        or payload.get("containerRuntime") != APPROVED_REVIEW_CONTAINER
        or payload.get("claudeExecutable")
        != APPROVED_REVIEW_CONTAINER["image"]["claudeExecutable"]
        or payload.get("containerConfig") != config
        or payload.get("containerConfigSha256") != sha256_bytes(canonical_json(config))
        or payload.get("authDelivery") != CLAUDE_AUTH_DELIVERY
        or payload.get("cleanupVerified") is not True
        or completion_binding["sha256"] != sha256_file(completion_path)
        or completion.get("attemptSha256") != payload.get("attempt", {}).get("sha256")
        or completion.get("stdout", {}).get("sha256") != payload.get("stdout", {}).get("sha256")
        or completion.get("stderr", {}).get("sha256") != payload.get("stderr", {}).get("sha256")
    ):
        raise ValueError("P30 gate-review unsigned payload changed")


def _sign_from_stdin(
    *, unsigned: Path, signed: Path, public_key: Path, input_fd: int = 0
) -> None:
    payload = json.loads(read_regular_nofollow(unsigned))
    validate_gate_unsigned_for_signing(payload)
    secret = read_secret_fd(input_fd, "review-attester signing key")
    try:
        private = serialization.load_pem_private_key(bytes(secret), password=None)
        public = serialization.load_pem_public_key(
            read_regular_nofollow(public_key)
        )
        if (
            not isinstance(private, Ed25519PrivateKey)
            or private.public_key().public_bytes_raw() != public.public_bytes_raw()
        ):
            raise ValueError("review-attester key differs from trust root")
        encoded = canonical_json(payload)
        key_id, public_sha = public_key_identity(public_key)
        payload["signature"] = {
            "schemaVersion": SIGNATURE_SCHEMA,
            "algorithm": "Ed25519",
            "role": "review-attester",
            "keyId": key_id,
            "publicKeyDerSha256": public_sha,
            "payloadSha256": sha256_bytes(encoded),
            "valueBase64": base64.b64encode(private.sign(encoded)).decode("ascii"),
        }
        atomic_write_exclusive(signed, canonical_json(payload) + b"\n", mode=0o400)
    finally:
        secret[:] = b"\0" * len(secret)


def sign_with_vault(
    *,
    unsigned: Path,
    signed: Path,
    public_key: Path,
    config: Path,
    op: Path,
    timeout: int,
) -> None:
    reference = load_config(config)["review-attester"]
    read_fd, write_fd = os.pipe()
    signer = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--sign-only",
            "--unsigned",
            str(unsigned),
            "--signed",
            str(signed),
            "--public-key",
            str(public_key),
        ],
        stdin=read_fd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    os.close(read_fd)
    reader = subprocess.Popen(
        [str(op), "read", reference],
        stdout=write_fd,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    os.close(write_fd)
    try:
        if reader.wait(timeout=timeout) != 0 or signer.wait(timeout=timeout) != 0:
            raise RuntimeError("P30 gate-review attestation signing failed")
    except BaseException:
        if reader.poll() is None:
            reader.kill()
        if signer.poll() is None:
            signer.kill()
        raise


def build_gate_review_payload(
    *, status: dict[str, Any], mode: str, attempt_local: Path,
    completion_path: Path, executable: dict[str, str],
    container_runtime: dict[str, Any], container_argv: list[str],
    container_name: str, container_invocation_sha256: str,
    container_id: str, container_config: dict[str, Any],
    container_config_sha256: str, authenticated_liveness: dict[str, Any],
    clock_skew_preflight: dict[str, Any],
    start_argv: list[str], cleanup_argv: list[str], cleanup_verified: bool,
    claude_argv: list[str], capsule: Path, environment: dict[str, str],
    started: str, finished: str, exit_code: int, stdout: Path, stderr: Path,
) -> dict[str, Any]:
    return {
        "schemaVersion": REVIEW_RECEIPT_SCHEMA, "valid": True, "immutable": True,
        "promotionEligible": False, "outcomesInspected": False, "mode": mode,
        "model": "fable", "effort": "high", "tools": ["Read"],
        "noSessionPersistence": True, "verdict": "ACCEPT",
        "protocol": status["inputs"][0],
        "sourceContractSha256": status["inputs"][2]["sha256"],
        "inputs": status["inputs"], "request": status["reviewRequest"],
        "attempt": {"path": status["attemptPath"], "sha256": sha256_file(attempt_local)},
        "completion": {"path": str(completion_path), "sha256": sha256_file(completion_path)},
        "launcherSha256": gate_review_launcher_sha256(),
        "claudeExecutable": executable, "containerRuntime": container_runtime,
        "containerArgv": container_argv, "containerName": container_name,
        "containerInvocationSha256": container_invocation_sha256,
        "containerId": container_id, "containerConfig": container_config,
        "containerConfigSha256": container_config_sha256,
        "authenticatedLiveness": authenticated_liveness,
        "clockSkewPreflight": clock_skew_preflight,
        "startArgv": start_argv, "cleanupArgv": cleanup_argv,
        "cleanupVerified": cleanup_verified, "argv": claude_argv,
        "cwd": str(capsule), "containerCwd": str(CONTAINER_REVIEW_ROOT),
        "environmentKeys": list(SANITIZED_ENVIRONMENT_KEYS),
        "authDelivery": CLAUDE_AUTH_DELIVERY,
        "startedAtUtc": started, "finishedAtUtc": finished, "exitCode": exit_code,
        "stdout": {"path": status["stdoutPath"], "sha256": sha256_file(stdout)},
        "stderr": {"path": status["stderrPath"], "sha256": sha256_file(stderr)},
    }


def remote_sha256(*, remote: str, path: str, timeout: int) -> str:
    script = (
        "import hashlib,os,stat,sys; p=sys.argv[1]; s=os.lstat(p); "
        "assert stat.S_ISREG(s.st_mode); h=hashlib.sha256(); "
        "f=open(p,'rb'); [h.update(b) for b in iter(lambda:f.read(1048576),b'')]; "
        "f.close(); print(h.hexdigest())"
    )
    completed = subprocess.run(
        ["ssh", "-T", "-o", "LogLevel=ERROR", remote, shlex.join(["python3", "-c", script, path])],
        capture_output=True, timeout=timeout, check=True,
    )
    value = completed.stdout.decode("ascii").strip()
    if completed.stderr or not _is_sha(value):
        raise ValueError("remote P30 review artifact hash failed")
    return value


def resume_postprocess(args: argparse.Namespace) -> Path:
    """Resume only signing/upload from already-fixed local review bytes."""

    status = scheduler_status(args)
    capsule = args.capsule.resolve()
    inputs = capsule / "inputs"
    outputs = capsule / "outputs"
    attempt = inputs / "attempt.json"
    stdout = outputs / "fable.stdout"
    stderr = outputs / "fable.stderr"
    completion_path = outputs / "review-completion.json"
    unsigned = outputs / "review-receipt.unsigned.json"
    signed = outputs / "review-receipt.signed.json"
    marker_path = outputs / "postprocess-marker.json"
    public = inputs / "review-attester.pem"
    marker = validate_postprocess_marker(
        json.loads(read_regular_nofollow(marker_path)), path=marker_path
    )
    if (
        marker["attempt"]["sha256"] != sha256_file(attempt)
        or marker["completion"]["sha256"] != sha256_file(completion_path)
        or marker["unsigned"]["sha256"] != sha256_file(unsigned)
        or marker["signedPath"] != str(signed)
        or marker["uploadTargets"]
        != [status["stdoutPath"], status["stderrPath"], status["receiptPath"]]
        or remote_sha256(remote=args.remote, path=status["attemptPath"], timeout=args.transfer_timeout_seconds)
        != sha256_file(attempt)
    ):
        raise ValueError("P30 gate-review resume binding changed")
    attempt_value = json.loads(read_regular_nofollow(attempt))
    completion = validate_review_completion(
        json.loads(read_regular_nofollow(completion_path)), attempt_path=attempt,
        stdout_path=stdout, stderr_path=stderr,
        container_name=attempt_value["containerName"],
    )
    del completion
    payload = json.loads(read_regular_nofollow(unsigned))
    validate_gate_unsigned_for_signing(payload)
    if signed.exists():
        signed_value = json.loads(read_regular_nofollow(signed))
        verified = verify_signed_payload(
            signed_value, expected_role="review-attester", public_key_path=public
        )
        if verified != payload:
            raise ValueError("P30 gate-review existing signature changed")
    else:
        sign_with_vault(
            unsigned=unsigned, signed=signed, public_key=public,
            config=args.custody_config.resolve(), op=args.op_michaelagents.resolve(),
            timeout=args.transfer_timeout_seconds,
        )
    upload_review_evidence(
        remote=args.remote,
        files=[(stdout, status["stdoutPath"]), (stderr, status["stderrPath"]), (signed, status["receiptPath"])],
        timeout=args.transfer_timeout_seconds,
    )
    return signed


def launch(args: argparse.Namespace) -> Path:
    status = scheduler_status(args)
    capsule = args.capsule.resolve()
    capsule.mkdir(mode=0o700, parents=False, exist_ok=False)
    inputs_dir = capsule / "inputs"
    outputs_dir = capsule / "outputs"
    inputs_dir.mkdir(mode=0o700)
    outputs_dir.mkdir(mode=0o700)
    local_inputs: list[Path] = []
    for index, remote_binding in enumerate(status["inputs"]):
        local = inputs_dir / f"input-{index:02d}{Path(remote_binding['path']).suffix}"
        fetch(
            remote=args.remote,
            binding=remote_binding,
            target=local,
            timeout=args.transfer_timeout_seconds,
        )
        local_inputs.append(local)
    request_local = inputs_dir / "review-request.json"
    public_local = inputs_dir / "review-attester.pem"
    fetch(
        remote=args.remote,
        binding=status["reviewRequest"],
        target=request_local,
        timeout=args.transfer_timeout_seconds,
    )
    fetch(
        remote=args.remote,
        binding=status["reviewAttesterPublicKey"],
        target=public_local,
        timeout=args.transfer_timeout_seconds,
    )
    request = json.loads(read_regular_nofollow(request_local))
    if (
        request.get("role") != "review-attester"
        or request.get("verb") != "attest-gate-review"
        or request.get("subject", {}).get("mode") != args.mode
        or request.get("subject", {}).get("inputs") != status["inputs"]
        or request.get("subject", {}).get("reviewRuntime") != status["reviewRuntime"]
        or request.get("subject", {}).get("launcherSha256") != status["launcherSha256"]
        or request.get("expectedOutputPath") != status["receiptPath"]
    ):
        raise ValueError("P30 gate-review request changed")
    environment = sanitized_environment(capsule=capsule)
    container_runtime = resolve_review_container(environment=environment)
    executable = dict(container_runtime["image"]["claudeExecutable"])
    prompt = gate_review_prompt(
        args.mode,
        [str(CONTAINER_REVIEW_ROOT / "inputs" / path.name) for path in local_inputs],
    )
    claude_argv = [
        executable["path"],
        "-p",
        "--model",
        "fable",
        "--effort",
        "high",
        "--tools",
        "Read",
        "--no-session-persistence",
        prompt,
    ]
    container_name = f"arc-p30-review-{secrets.token_hex(8)}"
    container_argv = expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=claude_argv
    )
    container_invocation_sha256 = sha256_bytes(canonical_json(container_argv))
    start_argv = expected_container_start_argv(container_name)
    cleanup_argv = expected_container_cleanup_argv(container_name)
    stdout = outputs_dir / "fable.stdout"
    stderr = outputs_dir / "fable.stderr"
    if any(path.exists() or path.is_symlink() for path in (stdout, stderr)):
        raise FileExistsError("P30 gate-review stream already exists")
    auth = read_secret_fd(args.claude_auth_fd, "Claude OAuth token", single_line=True)
    container_created = False
    attempt_local = inputs_dir / "attempt.json"
    try:
        authenticated_liveness = authenticated_liveness_preflight(
            capsule=capsule, outputs=outputs_dir, claude_auth=auth,
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
            "schemaVersion": "arc-v35-p30-gate-review-attempt-v2",
            "valid": True, "immutable": True, "promotionEligible": False,
            "outcomesInspected": False, "mode": args.mode,
            "request": status["reviewRequest"],
            "inputsSha256": sha256_bytes(canonical_json(status["inputs"])),
            "launcherSha256": gate_review_launcher_sha256(),
            "claudeExecutable": executable, "containerRuntime": container_runtime,
            "containerName": container_name,
            "containerInvocationSha256": container_invocation_sha256,
            "containerId": container_id,
            "containerConfigSha256": container_config_sha256,
            "authenticatedLiveness": authenticated_liveness,
            "clockSkewPreflight": clock_skew_preflight,
            "nonce": secrets.token_hex(32), "reservedAtUtc": utc_now(),
        }
        attempt_bytes = canonical_json(attempt) + b"\n"
        atomic_write_exclusive(attempt_local, attempt_bytes, mode=0o400)
        reserve_attempt(
            remote=args.remote, path=status["attemptPath"], payload=attempt_bytes,
            timeout=args.transfer_timeout_seconds,
        )
        try:
            started, finished, code = run_fable(
                start_argv=start_argv, claude_auth=auth, cwd=capsule,
                stdout_path=stdout, stderr_path=stderr,
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
        path=outputs_dir / "review-completion.json", attempt_path=attempt_local,
        stdout_path=stdout, stderr_path=stderr, started=started, finished=finished,
        exit_code=code, container_name=container_name,
    )
    require_exact_accept(stdout_path=stdout, stderr_path=stderr, exit_code=code)
    unsigned_payload = build_gate_review_payload(
        status=status, mode=args.mode, attempt_local=attempt_local,
        completion_path=outputs_dir / "review-completion.json",
        executable=executable, container_runtime=container_runtime,
        container_argv=container_argv, container_name=container_name,
        container_invocation_sha256=container_invocation_sha256,
        container_id=container_id, container_config=container_config,
        container_config_sha256=container_config_sha256,
        authenticated_liveness=authenticated_liveness,
        clock_skew_preflight=clock_skew_preflight,
        start_argv=start_argv, cleanup_argv=cleanup_argv,
        cleanup_verified=cleanup_verified, claude_argv=claude_argv,
        capsule=capsule, environment=environment, started=started,
        finished=finished, exit_code=code, stdout=stdout, stderr=stderr,
    )
    unsigned = outputs_dir / "review-receipt.unsigned.json"
    signed = outputs_dir / "review-receipt.signed.json"
    atomic_write_exclusive(unsigned, canonical_json(unsigned_payload) + b"\n", mode=0o400)
    create_postprocess_marker(
        path=outputs_dir / "postprocess-marker.json", unsigned=unsigned,
        completion=outputs_dir / "review-completion.json", attempt=attempt_local,
        signed=signed,
        uploads=[status["stdoutPath"], status["stderrPath"], status["receiptPath"]],
        created_at=utc_now(),
    )
    sign_with_vault(
        unsigned=unsigned,
        signed=signed,
        public_key=public_local,
        config=args.custody_config.resolve(),
        op=args.op_michaelagents.resolve(),
        timeout=args.transfer_timeout_seconds,
    )
    upload_review_evidence(
        remote=args.remote,
        files=[
            (stdout, status["stdoutPath"]),
            (stderr, status["stderrPath"]),
            (signed, status["receiptPath"]),
        ],
        timeout=args.transfer_timeout_seconds,
    )
    return signed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sign-only", action="store_true")
    parser.add_argument("--resume-post-review", action="store_true")
    parser.add_argument("--unsigned", type=Path)
    parser.add_argument("--signed", type=Path)
    parser.add_argument("--public-key", type=Path)
    parser.add_argument("--mode", choices=("phase0-runtime", "full-campaign"))
    parser.add_argument("--capsule", type=Path)
    parser.add_argument("--remote", default=REMOTE)
    parser.add_argument("--remote-repo", default=REMOTE_REPO)
    parser.add_argument("--remote-protocol", required=False)
    parser.add_argument("--custody-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--op-michaelagents", type=Path, default=Path.home() / "bin/op-michaelagents"
    )
    parser.add_argument("--claude-auth-fd", type=int, default=3)
    parser.add_argument("--review-timeout-seconds", type=int, default=7200)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=600)
    args = parser.parse_args()
    if args.sign_only:
        if not all((args.unsigned, args.signed, args.public_key)):
            parser.error("--sign-only requires --unsigned, --signed, and --public-key")
        _sign_from_stdin(
            unsigned=args.unsigned.resolve(),
            signed=args.signed.resolve(),
            public_key=args.public_key.resolve(),
        )
        return
    if not all((args.mode, args.capsule, args.remote_protocol)):
        parser.error("review mode requires --mode, --capsule, and --remote-protocol")
    if args.resume_post_review:
        print(resume_postprocess(args))
        return
    print(launch(args))


if __name__ == "__main__":
    main()
