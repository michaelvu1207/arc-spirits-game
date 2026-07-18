#!/usr/bin/env python3
"""Local MichaelAgents-to-SimForge controller for one allowlisted P30 role action."""

from __future__ import annotations

import argparse
import base64
import json
import os
import selectors
import shlex
import stat
import subprocess
import sys
import time
from pathlib import Path


REMOTE = "simforge1"
REMOTE_REPO = "/data/share8/michaelvuaprilexperimentation/arc-bot"
DEFAULT_CONFIG = Path.home() / ".config/arc-spirits/v35-p30-custody.json"
ROLES = ("issuer", "executor", "guardian", "analysis-authorizer")
ALL_CUSTODY_ROLES = (*ROLES, "review-attester")
MAXIMUM_HANDSHAKE_LINE_BYTES = 65536
MAXIMUM_EARLY_STDERR_BYTES = 65536
ROLE_SIGN_READY_SCHEMA = "arc-v35-p30-role-sign-ready-v1"
EXECUTOR_SIGN_READY_SCHEMA = "arc-v35-p30-executor-sign-ready-v1"
LAUNCH_PERMIT_SCHEMA = "arc-v35-p30-executor-launch-permit-v1"


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def validate_sign_ready(
    sign_ready: object, *, role: str, action_id: str
) -> None:
    """Validate the final keyless commitment before starting secret retrieval."""

    if not isinstance(sign_ready, dict):
        raise ValueError("remote P30 role sign-ready message is malformed")
    if role == "executor":
        unsigned_draft = sign_ready.get("unsignedDraft")
        if (
            set(sign_ready)
            != {
                "schemaVersion",
                "actionId",
                "requiredRole",
                "unsignedDraft",
            }
            or sign_ready.get("schemaVersion") != EXECUTOR_SIGN_READY_SCHEMA
            or sign_ready.get("actionId") != action_id
            or sign_ready.get("requiredRole") != "executor"
            or not isinstance(unsigned_draft, dict)
            or set(unsigned_draft) != {"path", "sha256"}
            or not isinstance(unsigned_draft.get("path"), str)
            or not Path(unsigned_draft["path"]).is_absolute()
            or not _is_sha256(unsigned_draft.get("sha256"))
        ):
            raise ValueError("remote P30 executor sign-ready message is malformed")
        return
    expected_output = sign_ready.get("expectedOutputPath")
    signing_plan = sign_ready.get("unsignedSigningPlan")
    attempt_marker = sign_ready.get("attemptMarker")
    if (
        set(sign_ready)
        != {
            "schemaVersion",
            "actionId",
            "requiredRole",
            "expectedOutputPath",
            "unsignedSigningPlan",
            "attemptMarker",
        }
        or sign_ready.get("schemaVersion") != ROLE_SIGN_READY_SCHEMA
        or sign_ready.get("actionId") != action_id
        or sign_ready.get("requiredRole") != role
        or not isinstance(expected_output, str)
        or not Path(expected_output).is_absolute()
        or not isinstance(signing_plan, dict)
        or set(signing_plan) != {"path", "sha256"}
        or not isinstance(signing_plan.get("path"), str)
        or not Path(signing_plan["path"]).is_absolute()
        or not _is_sha256(signing_plan.get("sha256"))
        or not isinstance(attempt_marker, dict)
        or set(attempt_marker) != {"path", "sha256"}
        or not isinstance(attempt_marker.get("path"), str)
        or not Path(attempt_marker["path"]).is_absolute()
        or not _is_sha256(attempt_marker.get("sha256"))
    ):
        raise ValueError("remote P30 role sign-ready message is malformed")


def validate_launch_permit_challenge(
    challenge: object,
    *,
    action_id: str,
    action_verb: str,
    protocol_sha256: str,
    source_contract_sha256: str,
) -> dict:
    if not isinstance(challenge, dict) or set(challenge) != {
        "schemaVersion",
        "authorized",
        "immutable",
        "promotionEligible",
        "outcomesInspected",
        "kind",
        "campaignInstanceId",
        "actionId",
        "verb",
        "protocol",
        "sourceContract",
        "request",
        "authorization",
        "tokenId",
        "executorProcess",
    }:
        raise ValueError("remote executor launch-permit challenge is malformed")
    protocol = challenge.get("protocol")
    source = challenge.get("sourceContract")
    request = challenge.get("request")
    authorization = challenge.get("authorization")
    process = challenge.get("executorProcess")
    if (
        challenge.get("schemaVersion") != LAUNCH_PERMIT_SCHEMA
        or challenge.get("authorized") is not True
        or challenge.get("immutable") is not True
        or challenge.get("promotionEligible") is not False
        or challenge.get("outcomesInspected") is not False
        or challenge.get("actionId") != action_id
        or challenge.get("verb") != action_verb
        or action_verb not in {"execute", "execute-recovery"}
        or not _is_sha256(challenge.get("tokenId"))
        or not _is_sha256(challenge.get("campaignInstanceId"))
        or not isinstance(protocol, dict)
        or set(protocol) != {"path", "sha256"}
        or protocol.get("sha256") != protocol_sha256
        or not isinstance(source, dict)
        or set(source) != {"path", "sha256"}
        or source.get("sha256") != source_contract_sha256
        or not isinstance(request, dict)
        or set(request) != {"path", "sha256"}
        or request.get("sha256") != action_id
        or not isinstance(authorization, dict)
        or set(authorization) != {"path", "sha256"}
        or not _is_sha256(authorization.get("sha256"))
        or not isinstance(process, dict)
        or set(process) != {"pid", "startTicks", "uid", "gid", "host", "bootId"}
        or any(type(process.get(field)) is not int or process[field] < 0 for field in ("pid", "startTicks", "uid", "gid"))
        or not all(isinstance(process.get(field), str) and process[field] for field in ("host", "bootId"))
    ):
        raise ValueError("remote executor launch-permit challenge is malformed")
    return challenge


def sign_launch_permit_locally(
    challenge: dict, *, secret_reference: str, timeout_seconds: int
) -> bytes:
    """Pipe the vault key into a local signer; return only the signed permit."""

    encoded = json.dumps(
        challenge,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    read_fd, write_fd = os.pipe()
    signer = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).with_name("sign_v35_p30_launch_permit_local.py")),
            "--payload-base64",
            base64.b64encode(encoded).decode("ascii"),
        ],
        stdin=read_fd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    os.close(read_fd)
    key_process: subprocess.Popen[bytes] | None = None
    try:
        key_process = subprocess.Popen(
            [str(Path.home() / "bin/op-michaelagents"), "read", secret_reference],
            stdout=write_fd,
            stderr=subprocess.DEVNULL,
        )
        os.close(write_fd)
        write_fd = -1
        stdout, _ = signer.communicate(timeout=timeout_seconds)
        key_code = key_process.wait(timeout=30)
        if signer.returncode != 0 or key_code != 0:
            raise RuntimeError("local executor launch-permit signing failed")
        lines = [line for line in stdout.splitlines() if line]
        if len(lines) != 1 or len(lines[0]) > MAXIMUM_HANDSHAKE_LINE_BYTES:
            raise ValueError("local executor launch-permit signer emitted malformed output")
        signed = json.loads(lines[0])
        if not isinstance(signed, dict) or set(signed) != {*challenge, "signature"}:
            raise ValueError("local executor launch permit changed its payload")
        unsigned = dict(signed)
        signature = unsigned.pop("signature")
        if unsigned != challenge or not isinstance(signature, dict) or (
            signature.get("role") != "executor"
            or signature.get("payloadSha256")
            != __import__("hashlib").sha256(encoded).hexdigest()
        ):
            raise ValueError("local executor launch-permit signature envelope changed")
        return lines[0]
    except BaseException:
        if key_process is not None and key_process.poll() is None:
            key_process.kill()
        if signer.poll() is None:
            signer.kill()
        raise
    finally:
        if write_fd >= 0:
            os.close(write_fd)
def read_bounded_remote_line(
    selector: selectors.BaseSelector,
    *,
    stdout_fd: int,
    stderr_fd: int,
    timeout_seconds: int,
    stdout_buffer: bytearray,
    early_stderr: bytearray,
) -> bytes:
    """Read one complete line with a real deadline while draining stderr."""

    deadline = time.monotonic() + timeout_seconds
    while True:
        newline = stdout_buffer.find(b"\n")
        if newline >= 0:
            if newline > MAXIMUM_HANDSHAKE_LINE_BYTES:
                raise ValueError("remote P30 role handshake line is oversized")
            line = bytes(stdout_buffer[:newline])
            del stdout_buffer[: newline + 1]
            return line
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("remote P30 role handshake line timed out")
        events = selector.select(timeout=remaining)
        if not events:
            raise TimeoutError("remote P30 role handshake line timed out")
        for key, _ in events:
            descriptor = int(key.fd)
            try:
                chunk = os.read(descriptor, 65536)
            except BlockingIOError:
                continue
            if descriptor == stderr_fd:
                if not chunk:
                    selector.unregister(stderr_fd)
                    continue
                early_stderr.extend(chunk)
                if len(early_stderr) > MAXIMUM_EARLY_STDERR_BYTES:
                    raise RuntimeError("remote P30 role emitted excessive early stderr")
                continue
            if descriptor != stdout_fd:
                raise RuntimeError("unexpected P30 custody selector descriptor")
            if not chunk:
                raise RuntimeError("remote P30 role exited before completing handshake")
            stdout_buffer.extend(chunk)
            if (
                b"\n" not in stdout_buffer
                and len(stdout_buffer) > MAXIMUM_HANDSHAKE_LINE_BYTES
            ):
                raise ValueError("remote P30 role handshake line is oversized")


def write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        offset += os.write(descriptor, payload[offset:])


def load_config(path: Path) -> dict[str, str]:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError("P30 custody config must be a 0600 regular file")
        value = json.loads(os.read(descriptor, metadata.st_size).decode("utf-8"))
    finally:
        os.close(descriptor)
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "roleSecretReferences"}
        or value.get("schemaVersion") != "arc-v35-p30-local-custody-v1"
        or not isinstance(value.get("roleSecretReferences"), dict)
        or set(value["roleSecretReferences"])
        != set(ALL_CUSTODY_ROLES)
        or not all(
            isinstance(reference, str)
            and reference.startswith("op://MichaelAgents/")
            and "\n" not in reference
            for reference in value["roleSecretReferences"].values()
        )
    ):
        raise ValueError("P30 custody config schema changed")
    return value["roleSecretReferences"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--role", choices=ROLES, required=True)
    parser.add_argument("--handshake-timeout-seconds", type=int, default=60)
    parser.add_argument("--action-timeout-seconds", type=int, default=86400)
    args = parser.parse_args()
    references = load_config(args.config.expanduser())
    remote_argv = [
        "ml/.venv/bin/python",
        "ml/run_v35_p30_role.py",
        "--protocol",
        args.protocol,
        "--request",
        args.request,
        "--expected-role",
        args.role,
    ]
    read_fd, write_fd = os.pipe()
    remote_command = (
        f"cd {shlex.quote(REMOTE_REPO)} && exec {shlex.join(remote_argv)}"
    )
    ssh = subprocess.Popen(
        ["ssh", "-T", "-o", "LogLevel=ERROR", REMOTE, remote_command],
        stdin=read_fd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    os.close(read_fd)
    assert ssh.stdout is not None and ssh.stderr is not None
    stdout_fd = ssh.stdout.fileno()
    stderr_fd = ssh.stderr.fileno()
    os.set_blocking(stdout_fd, False)
    os.set_blocking(stderr_fd, False)
    selector = selectors.DefaultSelector()
    selector.register(stdout_fd, selectors.EVENT_READ)
    selector.register(stderr_fd, selectors.EVENT_READ)
    ready_line = b""
    stdout_buffer = bytearray()
    early_stderr = bytearray()
    op: subprocess.Popen[bytes] | None = None
    try:
        ready_line = read_bounded_remote_line(
            selector,
            stdout_fd=stdout_fd,
            stderr_fd=stderr_fd,
            timeout_seconds=args.handshake_timeout_seconds,
            stdout_buffer=stdout_buffer,
            early_stderr=early_stderr,
        )
        ready = json.loads(ready_line)
        action_id = ready.get("actionId")
        if (
            set(ready)
            != {
                "schemaVersion",
                "actionId",
                "protocolSha256",
                "sourceContractSha256",
                "requiredRole",
                "actionVerb",
                "launchPermitChallenge",
            }
            or ready.get("schemaVersion") != "arc-v35-p30-role-ready-v1"
            or ready.get("requiredRole") != args.role
            or not isinstance(ready.get("actionVerb"), str)
            or not isinstance(action_id, str)
            or len(action_id) != 64
            or any(character not in "0123456789abcdef" for character in action_id)
        ):
            raise ValueError("remote P30 role handshake is malformed")
        challenge = ready.get("launchPermitChallenge")
        if challenge is not None:
            if args.role != "executor":
                raise ValueError("non-executor role requested a launch permit")
            challenge = validate_launch_permit_challenge(
                challenge,
                action_id=action_id,
                action_verb=ready["actionVerb"],
                protocol_sha256=ready["protocolSha256"],
                source_contract_sha256=ready["sourceContractSha256"],
            )
            signed_permit = sign_launch_permit_locally(
                challenge,
                secret_reference=references["executor"],
                timeout_seconds=args.handshake_timeout_seconds,
            )
            write_all(write_fd, signed_permit + b"\n")
        elif args.role == "executor" and ready["actionVerb"] in {
            "execute",
            "execute-recovery",
        }:
            # A null challenge is allowed only when a completed unsigned draft
            # already exists and this process can perform sealing only.
            pass
        sign_ready_line = read_bounded_remote_line(
            selector,
            stdout_fd=stdout_fd,
            stderr_fd=stderr_fd,
            timeout_seconds=args.action_timeout_seconds,
            stdout_buffer=stdout_buffer,
            early_stderr=early_stderr,
        )
        sign_ready = json.loads(sign_ready_line)
        validate_sign_ready(sign_ready, role=args.role, action_id=action_id)
        if stdout_buffer or early_stderr:
            raise ValueError("remote P30 role emitted unexpected data before key retrieval")
        # The secret process starts only after the remote role validated its
        # exact action and committed its complete unsigned signing payload. For
        # executor actions it starts only after the candidate process has exited
        # and the immutable unsigned draft is on disk.
        op = subprocess.Popen(
            [str(Path.home() / "bin/op-michaelagents"), "read", references[args.role]],
            stdout=write_fd,
            stderr=subprocess.DEVNULL,
        )
        os.close(write_fd)
        write_fd = -1
        stdout, stderr = ssh.communicate(timeout=args.action_timeout_seconds)
        op_code = op.wait(timeout=30)
        if op_code != 0:
            raise RuntimeError("MichaelAgents role-key retrieval failed")
        if ssh.returncode != 0 or early_stderr or stderr:
            raise RuntimeError("remote P30 role action failed")
        lines = [line for line in stdout.splitlines() if line]
        if len(lines) != 1:
            raise ValueError("remote P30 role emitted unexpected terminal output")
        result = json.loads(lines[0])
        artifact = result.get("artifact")
        if (
            set(result)
            != {
                "schemaVersion",
                "actionId",
                "artifact",
                "stateAdvanced",
                "promotionEligible",
                "outcomesInspected",
            }
            or result.get("schemaVersion") != "arc-v35-p30-role-result-v1"
            or result.get("actionId") != action_id
            or not isinstance(artifact, dict)
            or set(artifact) != {"path", "sha256"}
            or result.get("stateAdvanced") is not True
            or result.get("promotionEligible") is not False
            or result.get("outcomesInspected") is not False
        ):
            raise ValueError("remote P30 role result is malformed")
        print(json.dumps(result, separators=(",", ":")))
    except BaseException:
        if op is not None and op.poll() is None:
            op.kill()
        if ssh.poll() is None:
            ssh.kill()
        raise
    finally:
        selector.close()
        if write_fd >= 0:
            os.close(write_fd)


if __name__ == "__main__":
    main()
