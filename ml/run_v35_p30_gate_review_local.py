#!/usr/bin/env python3
"""Run and attest one metric-free Fable launch-gate review locally."""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from run_v35_p30_analysis_review_local import (
    build_sandbox_profile,
    require_exact_accept,
    resolve_claude_executable,
    run_fable,
    sanitized_environment,
    upload_review_evidence,
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
)
from v35_p30_phase0 import REVIEW_RECEIPT_SCHEMA


REMOTE = "simforge1"
REMOTE_REPO = "/data/share8/michaelvuaprilexperimentation/arc-bot"


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
    value = json.loads(completed.stdout)
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
    for key in ("attemptPath", "stdoutPath", "stderrPath", "receiptPath"):
        if not isinstance(value.get(key), str) or not Path(value[key]).is_absolute():
            raise ValueError("remote P30 gate-review output path is malformed")
    return value


def fetch(
    *, remote: str, binding: dict[str, str], target: Path, timeout: int
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    os.close(descriptor)
    try:
        completed = subprocess.run(
            ["scp", "-q", f"{remote}:{binding['path']}", str(target)],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        if completed.stdout or completed.stderr or sha256_file(target) != binding["sha256"]:
            raise ValueError("downloaded P30 gate-review input changed")
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


def _sign_from_stdin(
    *, unsigned: Path, signed: Path, public_key: Path
) -> None:
    secret = bytearray(sys.stdin.buffer.read(65537))
    while secret and secret[-1] in b"\r\n":
        secret.pop()
    if not secret or len(secret) > 65536:
        raise ValueError("review-attester secret is empty or oversized")
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
        payload = json.loads(read_regular_nofollow(unsigned))
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
        or request.get("expectedOutputPath") != status["receiptPath"]
    ):
        raise ValueError("P30 gate-review request changed")
    attempt = {
        "schemaVersion": "arc-v35-p30-gate-review-attempt-v1",
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "mode": args.mode,
        "request": status["reviewRequest"],
        "inputsSha256": sha256_bytes(canonical_json(status["inputs"])),
        "nonce": secrets.token_hex(32),
        "reservedAtUtc": utc_now(),
    }
    attempt_bytes = canonical_json(attempt) + b"\n"
    attempt_local = inputs_dir / "attempt.json"
    atomic_write_exclusive(attempt_local, attempt_bytes, mode=0o400)
    reserve_attempt(
        remote=args.remote,
        path=status["attemptPath"],
        payload=attempt_bytes,
        timeout=args.transfer_timeout_seconds,
    )
    auth = None
    auth_fd = args.claude_auth_fd
    if auth_fd >= 0:
        auth = bytearray(os.read(auth_fd, 65537))
        while auth and auth[-1] in b"\r\n":
            auth.pop()
    environment = sanitized_environment(capsule=capsule, claude_auth=auth)
    executable = resolve_claude_executable(args.claude, environment=environment)
    executable_path = Path(executable["path"])
    profile = build_sandbox_profile(capsule=capsule, executable=executable_path)
    profile_path = inputs_dir / "sandbox.sb"
    atomic_write_exclusive(profile_path, profile, mode=0o400)
    input_names = ", ".join(str(path) for path in local_inputs)
    if args.mode == "phase0-runtime":
        prompt = (
            "Independently audit the Arc Spirits P30 launch evidence in "
            f"{input_names}. Verify the signed CPU fault matrix, synthetic analyzer "
            "rehearsal, exact fresh-server CUDA determinism, isolation, disk/runtime "
            "safety, and that no outcome metric was exposed. Identify any P0/P1 launch "
            "blocker. End the final nonempty line with exactly VERDICT: ACCEPT only if "
            "none remains; otherwise end with exactly VERDICT: REJECT."
        )
    else:
        prompt = (
            "Review the immutable P30 full-campaign authorization inputs in "
            f"{input_names}. Verify Phase 0 readiness, the signed matched generation-one "
            "storage/runtime projection, outcome blindness, GPU7-only isolation, and the "
            "remaining campaign stop gates. Identify any P0/P1 blocker to continuing the "
            "sealed campaign. End the final nonempty line with exactly VERDICT: ACCEPT "
            "only if none remains; otherwise end with exactly VERDICT: REJECT."
        )
    argv = [
        args.sandbox_exec,
        "-f",
        str(profile_path),
        str(executable_path),
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
    stdout = outputs_dir / "fable.stdout"
    stderr = outputs_dir / "fable.stderr"
    started, finished, code = run_fable(
        sandbox_argv=argv,
        cwd=capsule,
        stdout_path=stdout,
        stderr_path=stderr,
        timeout=args.review_timeout_seconds,
        environment=environment,
    )
    require_exact_accept(stdout_path=stdout, stderr_path=stderr, exit_code=code)
    if auth is not None:
        auth[:] = b"\0" * len(auth)
    protocol_binding = status["inputs"][0]
    source_contract_sha = status["inputs"][2]["sha256"]
    unsigned_payload = {
        "schemaVersion": REVIEW_RECEIPT_SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "mode": args.mode,
        "model": "fable",
        "effort": "high",
        "tools": ["Read"],
        "noSessionPersistence": True,
        "verdict": "ACCEPT",
        "protocol": protocol_binding,
        "sourceContractSha256": source_contract_sha,
        "inputs": status["inputs"],
        "request": status["reviewRequest"],
        "attempt": {"path": status["attemptPath"], "sha256": sha256_file(attempt_local)},
        "claudeExecutable": executable,
        "sandboxProfileSha256": sha256_file(profile_path),
        "argv": argv,
        "environmentKeys": sorted(environment),
        "startedAtUtc": started,
        "finishedAtUtc": finished,
        "exitCode": code,
        "stdout": {"path": status["stdoutPath"], "sha256": sha256_file(stdout)},
        "stderr": {"path": status["stderrPath"], "sha256": sha256_file(stderr)},
    }
    unsigned = outputs_dir / "review-receipt.unsigned.json"
    signed = outputs_dir / "review-receipt.signed.json"
    atomic_write_exclusive(unsigned, canonical_json(unsigned_payload) + b"\n", mode=0o400)
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
    parser.add_argument("--claude", default="claude")
    parser.add_argument("--claude-auth-fd", type=int, default=-1)
    parser.add_argument("--sandbox-exec", default="/usr/bin/sandbox-exec")
    parser.add_argument("--review-timeout-seconds", type=int, default=3600)
    parser.add_argument("--transfer-timeout-seconds", type=int, default=120)
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
    print(launch(args))


if __name__ == "__main__":
    main()
