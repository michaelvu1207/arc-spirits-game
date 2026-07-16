#!/usr/bin/env python3
"""Execute one pre-authorized P30 command in an isolated namespace and sign evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping

from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    executable_sha256,
    read_regular_nofollow,
    regular_file_evidence,
    sha256_bytes,
    sha256_file,
    sign_payload,
    validate_role_trust,
    verify_signed_payload,
)


AUTHORIZATION_SCHEMA = "arc-v35-p30-execution-authorization-v1"
CONSUMED_SCHEMA = "arc-v35-p30-consumed-token-v1"
RECEIPT_SCHEMA = "arc-v35-p30-authorized-execution-receipt-v1"
NORMAL_SEAL_ATTEMPT_SCHEMA = "arc-v35-p30-normal-seal-attempt-v1"
RECOVERY_SEAL_ATTEMPT_SCHEMA = "arc-v35-p30-recovery-seal-attempt-v1"
PRE_CHILD_RECOVERY_ATTEMPT_SCHEMA = "arc-v35-p30-pre-child-execution-attempt-v1"
ANALYSIS_LAUNCH_INTENT_SCHEMA = "arc-v35-p30-analysis-launch-intent-v1"
ANALYSIS_LAUNCH_EVIDENCE_SCHEMA = "arc-v35-p30-analysis-launch-evidence-v1"
ANALYSIS_CAPABILITY_FD = 198
ANALYSIS_CAPABILITY_BYTES = 32
EXECUTOR_LAUNCH_PERMIT_SCHEMA = "arc-v35-p30-executor-launch-permit-v1"
UNSIGNED_RECEIPT_SUFFIX = ".unsigned.json"
TOKEN_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_KINDS = {
    "generation",
    "evaluation-primary",
    "evaluation-replay",
    "analysis",
    "preflight",
}
GPU_UUID = "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
ALLOWED_ENVIRONMENT_KEYS = {
    "ARC_ROOT",
    "ARC_V35_P30_EXTERNAL_LEASE",
    "ARC_V35_P30_AUTH_TOKEN",
    "ARC_V35_P30_PROTOCOL",
    "ARC_V35_P30_SCRATCH",
    "CUBLAS_WORKSPACE_CONFIG",
    "CUDA_DEVICE_ORDER",
    "CUDA_VISIBLE_DEVICES",
    "HOME",
    "PATH",
    "PYTHONHASHSEED",
    "PYTHONPATH",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def host_boot_id() -> str:
    path = Path("/proc/sys/kernel/random/boot_id")
    if path.is_file():
        return path.read_text().strip()
    if platform.system() == "Linux":
        raise ValueError("Linux host boot ID is unavailable")
    return "non-linux-test-host"


def executor_process_identity() -> dict[str, Any]:
    """Return the exact remote role process identity a local permit authorizes."""

    stat_fields = Path("/proc/self/stat").read_text().split()
    return {
        "pid": os.getpid(),
        "startTicks": int(stat_fields[21]),
        "uid": os.getuid(),
        "gid": os.getgid(),
        "host": platform.node(),
        "bootId": host_boot_id(),
    }


def validate_frozen_working_source(protocol: Mapping[str, Any]) -> None:
    """Validate source closure inside the executor, not only in its role wrapper."""

    contract = protocol.get("sourceContract")
    if not isinstance(contract, dict) or set(contract) != {
        "schemaVersion",
        "artifact",
        "sha256",
    }:
        raise ValueError("executor source contract changed")
    source_path = Path(str(contract["artifact"]))
    if not source_path.is_absolute():
        source_path = Path(__file__).resolve().parents[1] / source_path
    if not source_path.is_file() or sha256_file(source_path) != contract["sha256"]:
        raise ValueError("executor source lock is missing or hash-invalid")
    source_lock = read_json(source_path, "executor source lock")
    if (
        source_lock.get("schemaVersion") != "arc-v35-p30-source-lock-v1"
        or source_lock.get("authorized") is not True
        or source_lock.get("immutable") is not True
        or source_lock.get("promotionEligible") is not False
        or not isinstance(source_lock.get("files"), dict)
    ):
        raise ValueError("executor source lock is not authorized and immutable")
    repo_root = Path(__file__).resolve().parents[1]
    registered: set[str] = set()
    for entry in source_lock["files"].values():
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "gitBlobOid"}
            or not isinstance(entry.get("path"), str)
            or not TOKEN_PATTERN.fullmatch(str(entry.get("sha256")))
        ):
            raise ValueError("executor source-lock registry is malformed")
        registered.add(entry["path"])
        working = repo_root / entry["path"]
        if not working.is_file() or sha256_file(working) != entry["sha256"]:
            raise ValueError(f"executor frozen source changed: {entry['path']}")
    required = {
        "ml/v35_p30_authorized_execution.py",
        "ml/v35_p30_crypto.py",
        "ml/v35_p30_key_custody.py",
        "ml/v35_p30_recovery.py",
        "ml/run_v35_p30_campaign.py",
        "ml/run_v35_p30_role.py",
        "ml/analyze_v35_p30_long_horizon.py",
    }
    if not required.issubset(registered):
        raise ValueError("executor source lock omits its launch-security closure")


def executor_launch_permit_path(ledger_root: Path, action_id: str) -> Path:
    if not TOKEN_PATTERN.fullmatch(action_id):
        raise ValueError("executor launch-permit action changed")
    return ledger_root / "launch-permits" / f"{action_id}.json"


def build_executor_launch_permit_payload(
    *,
    protocol_path: Path,
    protocol: Mapping[str, Any],
    request: Mapping[str, Any],
    request_binding: Mapping[str, str],
    authorization_path: Path,
) -> dict[str, Any]:
    authorization_path = authorization_path.resolve()
    authorization = read_json(authorization_path, "launch-permit authorization")
    verb = request.get("verb")
    if (
        verb not in {"execute", "execute-recovery"}
        or request.get("role") != "executor"
        or request.get("expectedOutputPath")
        != str(Path(authorization["ledger"]["receiptPath"]))
        or request_binding.get("sha256") is None
        or sha256_file(Path(request_binding["path"])) != request_binding["sha256"]
    ):
        raise ValueError("executor launch-permit request changed")
    return {
        "schemaVersion": EXECUTOR_LAUNCH_PERMIT_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "kind": authorization["kind"],
        "campaignInstanceId": protocol["executionTrust"]["campaignInstanceId"],
        "actionId": request_binding["sha256"],
        "verb": verb,
        "protocol": {
            "path": str(protocol_path.resolve()),
            "sha256": sha256_file(protocol_path.resolve()),
        },
        "sourceContract": dict(authorization["sourceContract"]),
        "request": dict(request_binding),
        "authorization": {
            "path": str(authorization_path),
            "sha256": sha256_file(authorization_path),
        },
        "tokenId": authorization["tokenId"],
        "executorProcess": executor_process_identity(),
    }


def persist_executor_launch_permit(
    signed_permit: Mapping[str, Any],
    *,
    expected_payload: Mapping[str, Any],
    protocol: Mapping[str, Any],
) -> Path:
    """Verify and exclusively reserve the sole launch permit for this action."""

    payload = verify_signed_payload(
        signed_permit,
        expected_role="executor",
        public_key_path=Path(
            protocol["executionTrust"]["roles"]["executor"]["publicKeyPath"]
        ),
    )
    if canonical_json(payload) != canonical_json(dict(expected_payload)):
        raise ValueError("executor launch permit differs from its remote challenge")
    path = executor_launch_permit_path(
        Path(protocol["executionTrust"]["ledgerRoot"])
        / protocol["executionTrust"]["campaignInstanceId"],
        payload["actionId"],
    )
    atomic_write_exclusive(path, canonical_json(dict(signed_permit)) + b"\n")
    return path


def validate_executor_launch_permit(
    permit_path: Path,
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    protocol: Mapping[str, Any],
    execution_request_binding: Mapping[str, str],
    expected_request_verb: str,
) -> dict[str, Any]:
    validate_frozen_working_source(protocol)
    request_path = Path(execution_request_binding["path"])
    request = read_json(request_path, "executor launch-permit request")
    expected = build_executor_launch_permit_payload(
        protocol_path=Path(authorization["protocol"]["path"]),
        protocol=protocol,
        request=request,
        request_binding=execution_request_binding,
        authorization_path=authorization_path,
    )
    expected_path = executor_launch_permit_path(
        Path(authorization["ledger"]["root"]), expected["actionId"]
    )
    if permit_path.resolve() != expected_path.resolve() or expected["verb"] != expected_request_verb:
        raise ValueError("executor launch-permit path or verb changed")
    signed = read_json(permit_path, "executor launch permit")
    payload = verify_signed_payload(
        signed,
        expected_role="executor",
        public_key_path=Path(
            protocol["executionTrust"]["roles"]["executor"]["publicKeyPath"]
        ),
    )
    if (
        canonical_json(payload) != canonical_json(expected)
        or payload.get("executorProcess") != executor_process_identity()
    ):
        raise ValueError("executor launch permit is forged, replayed, or stale")
    return payload


def parse_utc(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{label} is not an ISO-8601 UTC instant")
    parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo != dt.timezone.utc:
        raise ValueError(f"{label} is not UTC")
    return parsed


def exact_keys(value: Any, expected: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} keys changed")
    return value


def read_json(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def gpu_snapshot() -> dict[str, Any]:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=index,uuid,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rows = []
    for line in result.stdout.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 4:
            raise ValueError("nvidia-smi returned malformed GPU state")
        rows.append(
            {
                "index": int(fields[0]),
                "uuid": fields[1],
                "memoryMiB": int(fields[2]),
                "utilizationPercent": int(fields[3]),
            }
        )
    selected = [row for row in rows if row["index"] == 7]
    if len(selected) != 1 or selected[0]["uuid"] != GPU_UUID:
        raise ValueError("physical GPU 7 identity changed")
    forbidden = [row for row in rows if row["index"] in (4, 5, 6)]
    return {"selected": selected[0], "forbidden": forbidden}


def process_record(pid: int) -> dict[str, Any]:
    process = Path(f"/proc/{pid}")
    if not process.is_dir():
        return {"pid": pid, "available": False}
    stat_fields = (process / "stat").read_text().split()
    cgroup = (process / "cgroup").read_text().splitlines()
    status = (process / "status").read_text().splitlines()
    uid_line = next((line for line in status if line.startswith("Uid:")), None)
    gid_line = next((line for line in status if line.startswith("Gid:")), None)
    return {
        "pid": pid,
        "available": True,
        "processGroup": int(stat_fields[4]),
        "startTicks": int(stat_fields[21]),
        "uids": uid_line,
        "gids": gid_line,
        "cgroup": cgroup,
    }


def analysis_launch_paths(ledger_root: Path, token_id: str) -> tuple[Path, Path]:
    if not TOKEN_PATTERN.fullmatch(token_id):
        raise ValueError("analysis launch token changed")
    return (
        ledger_root / f"{token_id}.analysis-launch-intent.json",
        ledger_root / f"{token_id}.analysis-launch.json",
    )


def _namespace_links(pid: int | str) -> dict[str, str]:
    root = Path(f"/proc/{pid}/ns")
    try:
        return {
            "pid": os.readlink(root / "pid"),
            "user": os.readlink(root / "user"),
            "network": os.readlink(root / "net"),
        }
    except OSError as exc:
        raise RuntimeError(f"namespace evidence is unavailable for PID {pid}") from exc


def _status_fields(pid: int) -> tuple[list[int], int, int]:
    lines = Path(f"/proc/{pid}/status").read_text().splitlines()
    nspid_line = next((line for line in lines if line.startswith("NSpid:")), None)
    uid_line = next((line for line in lines if line.startswith("Uid:")), None)
    gid_line = next((line for line in lines if line.startswith("Gid:")), None)
    if nspid_line is None or uid_line is None or gid_line is None:
        raise RuntimeError(f"process identity evidence is unavailable for PID {pid}")
    namespace_pids = [int(value) for value in nspid_line.split()[1:]]
    if not namespace_pids or namespace_pids[0] != pid:
        raise RuntimeError("analysis child PID namespace chain changed")
    return namespace_pids, int(uid_line.split()[1]), int(gid_line.split()[1])


def _supervisor_namespace_evidence() -> dict[str, Any]:
    stat_fields = Path("/proc/self/stat").read_text().split()
    return {
        "pid": os.getpid(),
        "uid": os.getuid(),
        "gid": os.getgid(),
        "bootId": host_boot_id(),
        "startTicks": int(stat_fields[21]),
        "namespaces": _namespace_links("self"),
    }


def _create_analysis_capability() -> tuple[int, str]:
    if not hasattr(os, "memfd_create"):
        raise RuntimeError("analysis launch requires Linux memfd_create")
    try:
        os.fstat(ANALYSIS_CAPABILITY_FD)
    except OSError as exc:
        if exc.errno != errno.EBADF:
            raise RuntimeError("reserved analysis capability FD cannot be inspected") from exc
    else:
        raise RuntimeError("reserved analysis capability FD is already open")
    allow_sealing = getattr(os, "MFD_ALLOW_SEALING", None)
    cloexec = getattr(os, "MFD_CLOEXEC", None)
    add_seals = getattr(fcntl, "F_ADD_SEALS", None)
    required_seals = tuple(
        getattr(fcntl, name, None)
        for name in ("F_SEAL_SEAL", "F_SEAL_SHRINK", "F_SEAL_GROW", "F_SEAL_WRITE")
    )
    if (
        allow_sealing is None
        or cloexec is None
        or add_seals is None
        or any(value is None for value in required_seals)
    ):
        raise RuntimeError("analysis launch requires sealed Linux memfds")
    secret = os.urandom(ANALYSIS_CAPABILITY_BYTES)
    descriptor = os.memfd_create(
        "arc-v35-p30-analysis-capability", cloexec | allow_sealing
    )
    try:
        offset = 0
        while offset < len(secret):
            offset += os.write(descriptor, secret[offset:])
        os.lseek(descriptor, 0, os.SEEK_SET)
        seal_mask = 0
        for value in required_seals:
            assert value is not None
            seal_mask |= value
        fcntl.fcntl(descriptor, add_seals, seal_mask)
        if descriptor != ANALYSIS_CAPABILITY_FD:
            os.dup2(descriptor, ANALYSIS_CAPABILITY_FD, inheritable=True)
            os.close(descriptor)
            descriptor = ANALYSIS_CAPABILITY_FD
        else:
            os.set_inheritable(descriptor, True)
        return descriptor, sha256_bytes(secret)
    except BaseException:
        os.close(descriptor)
        raise


def _proc_descendants(root_pid: int) -> set[int]:
    pending = [root_pid]
    observed: set[int] = set()
    while pending:
        pid = pending.pop()
        if pid in observed:
            continue
        observed.add(pid)
        children_path = Path(f"/proc/{pid}/task/{pid}/children")
        try:
            children = [int(value) for value in children_path.read_text().split()]
        except (FileNotFoundError, OSError, ValueError):
            continue
        pending.extend(children)
    return observed


def _analysis_child_evidence(
    launcher_pid: int,
    *,
    supervisor_namespaces: Mapping[str, str],
    executable_sha256: str,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        candidates: list[dict[str, Any]] = []
        for pid in sorted(_proc_descendants(launcher_pid)):
            try:
                namespaces = _namespace_links(pid)
                if any(
                    namespaces[name] == supervisor_namespaces[name]
                    for name in ("pid", "user", "network")
                ):
                    continue
                executable_path = Path(f"/proc/{pid}/exe").resolve(strict=True)
                if sha256_file(executable_path) != executable_sha256:
                    continue
                namespace_pids, uid, gid = _status_fields(pid)
                stat_fields = Path(f"/proc/{pid}/stat").read_text().split()
                candidates.append(
                    {
                        "launcherPid": launcher_pid,
                        "hostPid": pid,
                        "namespacePid": namespace_pids[-1],
                        "namespacePidChain": namespace_pids,
                        "uid": uid,
                        "gid": gid,
                        "startTicks": int(stat_fields[21]),
                        "namespaces": namespaces,
                        "executableSha256": executable_sha256,
                    }
                )
            except (FileNotFoundError, OSError, RuntimeError, ValueError):
                continue
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            raise RuntimeError("analysis launch has ambiguous namespace children")
        time.sleep(0.01)
    raise RuntimeError("analysis child namespace evidence was not observed")


def validate_authorization(
    signed: Mapping[str, Any], *, issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path, authorization_path: Path,
    now: dt.datetime | None = None
) -> dict[str, Any]:
    untrusted_kind = signed.get("kind")
    expected_role = "analysis-authorizer" if untrusted_kind == "analysis" else "issuer"
    authorization_public_key_path = (
        analysis_authorizer_public_key_path
        if expected_role == "analysis-authorizer"
        else issuer_public_key_path
    )
    authorization = verify_signed_payload(
        signed,
        expected_role=expected_role,
        public_key_path=authorization_public_key_path,
    )
    exact_keys(
        authorization,
        {
            "schemaVersion",
            "authorized",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "issuedAtUtc",
            "notBeforeUtc",
            "expiresAtUtc",
            "protocol",
            "sourceContract",
            "subject",
            "command",
            "isolation",
            "outputs",
            "ledger",
            "predecessor",
            "request",
        },
        "execution authorization",
    )
    if (
        authorization.get("schemaVersion") != AUTHORIZATION_SCHEMA
        or authorization.get("authorized") is not True
        or authorization.get("immutable") is not True
        or authorization.get("promotionEligible") is not False
        or authorization.get("kind") not in ALLOWED_KINDS
        or not TOKEN_PATTERN.fullmatch(str(authorization.get("tokenId")))
        or not isinstance(authorization.get("campaignId"), str)
        or not authorization["campaignId"]
    ):
        raise ValueError("execution authorization identity changed")
    moment = now or dt.datetime.now(dt.timezone.utc)
    issued = parse_utc(authorization["issuedAtUtc"], "authorization issue time")
    not_before = parse_utc(authorization["notBeforeUtc"], "authorization not-before time")
    expires = parse_utc(authorization["expiresAtUtc"], "authorization expiry time")
    if not (issued <= not_before <= moment < expires) or expires - issued > dt.timedelta(hours=24):
        raise ValueError("execution authorization is not currently valid")
    bound_paths: dict[str, Path] = {}
    for label in ("protocol", "sourceContract"):
        binding = exact_keys(authorization[label], {"path", "sha256"}, label)
        path = Path(binding["path"])
        if not path.is_absolute() or sha256_file(path) != binding["sha256"]:
            raise ValueError(f"{label} binding is missing or hash-invalid")
        bound_paths[label] = path
    protocol = read_json(bound_paths["protocol"], "authorized P30 protocol")
    trust = protocol.get("executionTrust")
    roles = validate_role_trust(trust, require_materialized=True)
    expected_trust_entry = roles[expected_role]
    if (
        Path(str(expected_trust_entry.get("publicKeyPath")))
        != authorization_public_key_path
        or not TOKEN_PATTERN.fullmatch(str(trust.get("campaignInstanceId")))
    ):
        raise ValueError("authorization is not bound to the protocol trust root")
    command = exact_keys(
        authorization["command"],
        {"argv", "cwd", "env", "executableSha256"},
        "command",
    )
    if (
        not isinstance(command["argv"], list)
        or not command["argv"]
        or not all(isinstance(value, str) and value for value in command["argv"])
        or not Path(command["argv"][0]).is_absolute()
        or executable_sha256(Path(command["argv"][0]))
        != command["executableSha256"]
        or not Path(command["cwd"]).is_absolute()
        or not isinstance(command["env"], dict)
        or not set(command["env"]).issubset(ALLOWED_ENVIRONMENT_KEYS)
        or not all(
            isinstance(key, str)
            and key
            and isinstance(value, str)
            and "\x00" not in key + value
            for key, value in command["env"].items()
        )
    ):
        raise ValueError("authorized command is malformed")
    isolation = exact_keys(
        authorization["isolation"],
        {
            "backend",
            "backendPath",
            "backendSha256",
            "network",
            "newPidNamespace",
            "newUserNamespace",
            "readOnlyPaths",
            "writablePaths",
            "tmpfsPaths",
            "gpuMode",
            "gpuUuid",
            "forbiddenGpuIndices",
        },
        "isolation",
    )
    if (
        isolation["backend"] != "bubblewrap"
        or isolation["backendPath"] != trust["bubblewrapPath"]
        or isolation["backendSha256"] != trust["bubblewrapSha256"]
        or not Path(isolation["backendPath"]).is_absolute()
        or sha256_file(Path(isolation["backendPath"])) != isolation["backendSha256"]
        or isolation["network"] != "none"
        or isolation["newPidNamespace"] is not True
        or isolation["newUserNamespace"] is not True
        or isolation["forbiddenGpuIndices"] != [4, 5, 6]
    ):
        raise ValueError("execution isolation contract changed")
    if (
        isolation["gpuMode"] == "exclusive-gpu7"
        and isolation["gpuUuid"] == GPU_UUID
    ):
        pass
    elif isolation["gpuMode"] == "none" and isolation["gpuUuid"] is None:
        pass
    else:
        raise ValueError("execution GPU isolation mode changed")
    for field in ("readOnlyPaths", "writablePaths", "tmpfsPaths"):
        paths = isolation[field]
        if (
            not isinstance(paths, list)
            or paths != sorted(set(paths))
            or not all(isinstance(path, str) and Path(path).is_absolute() for path in paths)
        ):
            raise ValueError(f"isolation {field} is malformed")
    writable = [Path(path).resolve() for path in isolation["writablePaths"]]
    if any(
        left == right or left in right.parents or right in left.parents
        for index, left in enumerate(writable)
        for right in writable[index + 1 :]
    ):
        raise ValueError("writable isolation paths overlap")
    outputs = authorization["outputs"]
    if not isinstance(outputs, dict) or not outputs:
        raise ValueError("authorized output registry is empty")
    tentative_ledger_root = Path(authorization.get("ledger", {}).get("root", "")).resolve()
    supervisor_root = tentative_ledger_root / "supervisor" / authorization["tokenId"]
    for label, entry in outputs.items():
        allowed_output_keys = {"path", "required", "mustBeAbsentAtStart"}
        if authorization["kind"] == "analysis":
            allowed_output_keys.add("childWritable")
        exact_keys(entry, allowed_output_keys, f"output {label}")
        path = Path(entry["path"])
        resolved_path = path.resolve()
        child_writable = entry.get("childWritable", True)
        if (
            not isinstance(label, str)
            or not label
            or not path.is_absolute()
            or type(entry["required"]) is not bool
            or type(entry["mustBeAbsentAtStart"]) is not bool
            or type(child_writable) is not bool
            or (
                child_writable
                and not any(
                    resolved_path == root or root in resolved_path.parents
                    for root in writable
                )
            )
            or (
                not child_writable
                and (
                    authorization["kind"] != "analysis"
                    or label not in {"stdout", "stderr", "exitCode"}
                    or resolved_path.parent != supervisor_root
                )
            )
        ):
            raise ValueError(f"authorized output {label} is malformed")
    if authorization["kind"] == "analysis" and (
        set(outputs) != {"analysis", "stdout", "stderr", "exitCode"}
        or outputs["analysis"].get("childWritable") is not True
        or any(outputs[label].get("childWritable") is not False for label in ("stdout", "stderr", "exitCode"))
    ):
        raise ValueError("analysis output ownership contract changed")
    ledger = exact_keys(
        authorization["ledger"],
        {"root", "consumedPath", "receiptPath", "leasePath"},
        "ledger",
    )
    ledger_root = Path(ledger["root"])
    resolved_ledger_root = ledger_root.resolve()
    if (
        not ledger_root.is_absolute()
        or ledger_root
        != Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
        or Path(ledger["consumedPath"]) != ledger_root / f"{authorization['tokenId']}.consumed.json"
        or Path(ledger["receiptPath"]) != ledger_root / f"{authorization['tokenId']}.receipt.json"
        or not Path(ledger["leasePath"]).is_absolute()
        or Path(ledger["leasePath"]) != Path(trust["leasePath"])
        or any(
            resolved_ledger_root == root
            or root in resolved_ledger_root.parents
            or resolved_ledger_root in root.parents
            for root in writable
        )
    ):
        raise ValueError("authorization ledger is not isolated from candidate writes")
    predecessor = authorization["predecessor"]
    if predecessor is not None:
        exact_keys(predecessor, {"receiptPath", "sha256"}, "predecessor")
        if sha256_file(Path(predecessor["receiptPath"])) != predecessor["sha256"]:
            raise ValueError("predecessor receipt is missing or hash-invalid")
    request_binding = exact_keys(
        authorization["request"], {"path", "sha256"}, "role request binding"
    )
    request_path = Path(request_binding["path"])
    if (
        not request_path.is_absolute()
        or request_path.parent != ledger_root / "requests"
        or sha256_file(request_path) != request_binding["sha256"]
    ):
        raise ValueError("authorization role request is missing or hash-invalid")
    request = read_json(request_path, "authorization role request")
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
        "authorization role request",
    )
    expected_verb = {
        "generation": "issue-generation",
        "evaluation-primary": "issue-evaluation",
        "evaluation-replay": "issue-evaluation",
        "analysis": "issue-analysis",
        "preflight": "issue-preflight-execution",
    }[authorization["kind"]]
    request_verb = request.get("verb")
    is_pre_child_recovery = request_verb == "issue-recovery"
    if is_pre_child_recovery:
        if authorization["kind"] not in {
            "generation",
            "evaluation-primary",
            "evaluation-replay",
        }:
            raise ValueError("recovery authorization kind is not rerunnable")
        recovery_subject = exact_keys(
            request.get("subject"),
            {
                "logicalId",
                "originalAuthorizationPath",
                "executionDraft",
                "guardianIncident",
                "incidentAttestation",
                "recoveryClass",
                "recoveryOrdinal",
                "recoveryTokenId",
            },
            "recovery authorization request subject",
        )
        from v35_p30_recovery import (
            PRE_CHILD,
            protected_bindings_sha256,
            validate_execution_draft,
            validate_guardian_incident,
        )

        original_path = Path(str(recovery_subject["originalAuthorizationPath"]))
        if not original_path.is_absolute() or original_path == authorization_path:
            raise ValueError("recovery authorization original path changed")
        original_signed = read_json(original_path, "original recovery authorization")
        original = verify_signed_payload(
            original_signed,
            expected_role="issuer",
            public_key_path=issuer_public_key_path,
        )
        original_request_path = Path(str(original.get("request", {}).get("path", "")))
        if (
            original.get("kind") != authorization["kind"]
            or original.get("campaignId") != authorization["campaignId"]
            or original.get("tokenId") == authorization["tokenId"]
            or not original_request_path.is_absolute()
            or read_json(original_request_path, "original authorization request").get("verb")
            == "issue-recovery"
        ):
            raise ValueError("nested or unrelated recovery authorization is forbidden")
        draft_binding = exact_keys(
            recovery_subject["executionDraft"], {"path", "sha256"}, "recovery draft binding"
        )
        draft_path = Path(str(draft_binding["path"]))
        incident_binding = exact_keys(
            recovery_subject["guardianIncident"],
            {"path", "sha256"},
            "guardian incident binding",
        )
        incident_path = Path(str(incident_binding["path"]))
        attestation_binding = exact_keys(
            recovery_subject["incidentAttestation"],
            {"path", "sha256"},
            "incident attestation binding",
        )
        attestation_path = Path(str(attestation_binding["path"]))
        for label, path, binding in (
            ("recovery draft", draft_path, draft_binding),
            ("guardian incident", incident_path, incident_binding),
            ("incident attestation", attestation_path, attestation_binding),
        ):
            if not path.is_absolute() or sha256_file(path) != binding["sha256"]:
                raise ValueError(f"{label} is missing or hash-invalid")
        draft = read_json(draft_path, "PRE_CHILD recovery draft")
        validate_execution_draft(draft, authorization=original)
        incident_signed = read_json(incident_path, "guardian recovery incident")
        incident = validate_guardian_incident(
            incident_signed,
            guardian_public_key_path=Path(roles["guardian"]["publicKeyPath"]),
            execution_draft=draft,
            authorization=original,
        )
        attestation = verify_signed_payload(
            read_json(attestation_path, "guardian incident attestation"),
            expected_role="guardian",
            public_key_path=Path(roles["guardian"]["publicKeyPath"]),
        )
        if (
            recovery_subject.get("recoveryClass") != PRE_CHILD
            or recovery_subject.get("recoveryOrdinal") != 1
            or recovery_subject.get("recoveryTokenId") != authorization["tokenId"]
            or draft.get("recoveryClass") != PRE_CHILD
            or incident.get("recoveryClass") != PRE_CHILD
            or attestation.get("phase") != "incident"
            or attestation.get("valid") is not True
            or attestation.get("outcomeBlind") is not True
            or attestation.get("outcomesInspected") is not False
            or attestation.get("originalTokenId") != original.get("tokenId")
            or attestation.get("recoveryClass") != PRE_CHILD
            or attestation.get("attemptOrdinal") != 1
            or attestation.get("artifact") != dict(incident_binding)
            or protected_bindings_sha256(authorization)
            != protected_bindings_sha256(original)
        ):
            raise ValueError("recovery authorization changes its guardian-bound identity")
    if (
        request.get("schemaVersion") != "arc-v35-p30-role-request-v1"
        or request.get("campaignInstanceId") != trust["campaignInstanceId"]
        or request.get("protocol") != authorization["protocol"]
        or request.get("role") != expected_role
        or request_verb != ("issue-recovery" if is_pre_child_recovery else expected_verb)
        or request.get("expectedOutputPath") != str(authorization_path.resolve())
        or request.get("predecessorSha256")
        != (
            attestation_binding["sha256"]
            if is_pre_child_recovery
            else (None if predecessor is None else predecessor["sha256"])
        )
        or not TOKEN_PATTERN.fullmatch(str(request.get("requestNonce")))
    ):
        raise ValueError("authorization role request changed")
    return authorization


def bubblewrap_command(
    authorization: Mapping[str, Any], *, analysis_capability_fd: int | None = None
) -> list[str]:
    isolation = authorization["isolation"]
    argv = [
        isolation["backendPath"],
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-ipc",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]
    if analysis_capability_fd is not None:
        if (
            authorization.get("kind") != "analysis"
            or analysis_capability_fd != ANALYSIS_CAPABILITY_FD
        ):
            raise ValueError("analysis launch capability FD contract changed")
        argv.extend(("--keep-fd", str(analysis_capability_fd)))
    for path in isolation["readOnlyPaths"]:
        argv.extend(("--ro-bind", path, path))
    for path in isolation["writablePaths"]:
        argv.extend(("--bind", path, path))
    for path in isolation["tmpfsPaths"]:
        argv.extend(("--tmpfs", path))
    if isolation["gpuMode"] == "exclusive-gpu7":
        for device in ("/dev/nvidia7", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"):
            if Path(device).exists():
                argv.extend(("--dev-bind", device, device))
    for key, value in sorted(authorization["command"]["env"].items()):
        argv.extend(("--setenv", key, value))
    argv.extend(("--chdir", authorization["command"]["cwd"], "--"))
    argv.extend(authorization["command"]["argv"])
    return argv


def _ensure_no_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current = current / component
        if current.exists() and current.is_symlink():
            raise ValueError(f"symlink component is forbidden: {current}")


def _prepare_output_parents(authorization: Mapping[str, Any]) -> None:
    writable = [Path(value) for value in authorization["isolation"]["writablePaths"]]
    for root in writable:
        root.mkdir(parents=True, exist_ok=True)
        _ensure_no_symlink_components(root)
        if not root.is_dir():
            raise ValueError(f"authorized writable root is not a directory: {root}")
    for entry in authorization["outputs"].values():
        parent = Path(entry["path"]).parent
        child_writable = entry.get("childWritable", True)
        if child_writable and not any(
            parent == root or root in parent.parents for root in writable
        ):
            raise ValueError("output parent escapes authorized writable roots")
        parent.mkdir(parents=True, exist_ok=True)
        _ensure_no_symlink_components(parent)
        if not parent.is_dir():
            raise ValueError(f"authorized output parent is not a directory: {parent}")


def _terminate_child(child: subprocess.Popen[Any] | None) -> None:
    if child is None or child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("authorized process group survived SIGKILL") from exc


def _wait_for_gpu_empty(seconds: int = 30) -> tuple[dict[str, Any], bool]:
    deadline = time.monotonic() + seconds
    latest = gpu_snapshot()
    while (
        latest["selected"]["memoryMiB"] != 0
        or latest["selected"]["utilizationPercent"] != 0
    ) and time.monotonic() < deadline:
        time.sleep(1)
        latest = gpu_snapshot()
    return latest, (
        latest["selected"]["memoryMiB"] == 0
        and latest["selected"]["utilizationPercent"] == 0
    )


def unsigned_receipt_path(receipt_path: Path) -> Path:
    return receipt_path.with_name(receipt_path.name + UNSIGNED_RECEIPT_SUFFIX)


def normal_seal_attempt_path(receipt_path: Path) -> Path:
    return receipt_path.with_name(receipt_path.name + ".normal-seal-attempt.json")


def recovery_seal_attempt_path(receipt_path: Path) -> Path:
    return receipt_path.with_name(receipt_path.name + ".recovery-seal-attempt.json")


def pre_child_recovery_attempt_path(receipt_path: Path) -> Path:
    return receipt_path.with_name(
        receipt_path.name + ".pre-child-recovery-attempt.json"
    )


def _file_binding(path: Path) -> dict[str, str]:
    return {"path": str(path.resolve()), "sha256": sha256_file(path)}


def _analysis_launch_intent(
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    consumed_path: Path,
    capability_sha256: str,
    intent_path: Path,
    evidence_path: Path,
    launch_permit_path: Path,
) -> dict[str, Any]:
    return {
        "schemaVersion": ANALYSIS_LAUNCH_INTENT_SCHEMA,
        "immutable": True,
        "promotionEligible": False,
        "kind": "analysis",
        "tokenId": authorization["tokenId"],
        "campaignId": authorization["campaignId"],
        "authorization": {
            "path": str(authorization_path.resolve()),
            "sha256": sha256_file(authorization_path),
        },
        "consumedMarker": {
            "path": str(consumed_path),
            "sha256": sha256_file(consumed_path),
        },
        "launchPermit": {
            "path": str(launch_permit_path.resolve()),
            "sha256": sha256_file(launch_permit_path),
        },
        "capabilitySha256": capability_sha256,
        "capabilityFd": ANALYSIS_CAPABILITY_FD,
        "supervisor": _supervisor_namespace_evidence(),
        "launchEvidencePath": str(evidence_path),
        "createdAtUtc": utc_now(),
    }


def _commit_analysis_launch_evidence(
    *,
    intent_path: Path,
    evidence_path: Path,
    intent: Mapping[str, Any],
    child: subprocess.Popen[Any],
    authorization: Mapping[str, Any],
) -> dict[str, Any]:
    child_evidence = _analysis_child_evidence(
        child.pid,
        supervisor_namespaces=intent["supervisor"]["namespaces"],
        executable_sha256=authorization["command"]["executableSha256"],
    )
    evidence = {
        "schemaVersion": ANALYSIS_LAUNCH_EVIDENCE_SCHEMA,
        "immutable": True,
        "promotionEligible": False,
        "kind": "analysis",
        "tokenId": authorization["tokenId"],
        "campaignId": authorization["campaignId"],
        "authorization": dict(intent["authorization"]),
        "consumedMarker": dict(intent["consumedMarker"]),
        "launchPermit": dict(intent["launchPermit"]),
        "launchIntent": {
            "path": str(intent_path),
            "sha256": sha256_file(intent_path),
        },
        "capabilitySha256": intent["capabilitySha256"],
        "supervisor": dict(intent["supervisor"]),
        "child": child_evidence,
        "committedAtUtc": utc_now(),
    }
    atomic_write_exclusive(evidence_path, canonical_json(evidence) + b"\n")
    return evidence


def _seal_attempt_payload(
    *,
    schema_version: str,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    draft_path: Path,
    execution_request_binding: Mapping[str, str],
    recovery_evidence: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": schema_version,
        "immutable": True,
        "promotionEligible": False,
        "kind": authorization["kind"],
        "tokenId": authorization["tokenId"],
        "campaignId": authorization["campaignId"],
        "authorization": {
            "path": str(authorization_path.resolve()),
            "sha256": sha256_file(authorization_path),
        },
        "unsignedReceipt": {
            "path": str(draft_path.resolve()),
            "sha256": sha256_file(draft_path),
        },
        "executionRequest": dict(execution_request_binding),
        "predecessor": authorization["predecessor"],
        "recoveryEvidence": None if recovery_evidence is None else dict(recovery_evidence),
        "attemptOrdinal": 1,
        "attemptedAtUtc": utc_now(),
        "signingRole": "executor",
        "processId": os.getpid(),
        "host": platform.node(),
        "bootId": host_boot_id(),
    }


def _validate_seal_attempt(
    path: Path,
    *,
    expected_schema: str,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    draft_path: Path,
    execution_request_binding: Mapping[str, str],
    recovery_evidence: Mapping[str, Any] | None,
) -> dict[str, Any]:
    marker = read_json(path, "executor seal-attempt marker")
    exact_keys(
        marker,
        {
            "schemaVersion",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "unsignedReceipt",
            "executionRequest",
            "predecessor",
            "recoveryEvidence",
            "attemptOrdinal",
            "attemptedAtUtc",
            "signingRole",
            "processId",
            "host",
            "bootId",
        },
        "executor seal-attempt marker",
    )
    expected_authorization = {
        "path": str(authorization_path.resolve()),
        "sha256": sha256_file(authorization_path),
    }
    expected_draft = {
        "path": str(draft_path.resolve()),
        "sha256": sha256_file(draft_path),
    }
    if (
        marker.get("schemaVersion") != expected_schema
        or marker.get("immutable") is not True
        or marker.get("promotionEligible") is not False
        or marker.get("kind") != authorization["kind"]
        or marker.get("tokenId") != authorization["tokenId"]
        or marker.get("campaignId") != authorization["campaignId"]
        or marker.get("authorization") != expected_authorization
        or marker.get("unsignedReceipt") != expected_draft
        or marker.get("executionRequest") != dict(execution_request_binding)
        or marker.get("predecessor") != authorization["predecessor"]
        or marker.get("recoveryEvidence")
        != (None if recovery_evidence is None else dict(recovery_evidence))
        or marker.get("attemptOrdinal") != 1
        or marker.get("signingRole") != "executor"
        or type(marker.get("processId")) is not int
        or marker["processId"] <= 0
        or not isinstance(marker.get("host"), str)
        or not marker["host"]
        or not isinstance(marker.get("bootId"), str)
        or not marker["bootId"]
    ):
        raise ValueError("executor seal-attempt marker identity changed")
    parse_utc(marker.get("attemptedAtUtc"), "seal-attempt time")
    return marker


def _prepare_execution_receipt(
    authorization_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    execution_request_binding: Mapping[str, str],
    expected_request_verb: str,
    expected_request_predecessor_sha256: str,
    terminal_on_pre_child_failure: bool,
    launch_permit_path: Path | None,
) -> Path:
    """Run one authorized command without loading any private signing key.

    The resulting immutable unsigned draft is the only object that may be
    presented to the executor key.  If a draft already exists, it is validated
    and returned without running candidate code again.
    """

    signed = read_json(authorization_path, "execution authorization")
    authorization = validate_authorization(
        signed,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        authorization_path=authorization_path.resolve(),
    )
    protocol = read_json(Path(authorization["protocol"]["path"]), "authorized P30 protocol")
    ledger = authorization["ledger"]
    consumed_path = Path(ledger["consumedPath"])
    receipt_path = Path(ledger["receiptPath"])
    draft_path = unsigned_receipt_path(receipt_path)
    if receipt_path.exists():
        raise FileExistsError("authorization already has an execution receipt")
    exact_keys(
        execution_request_binding, {"path", "sha256"}, "execution request binding"
    )
    execution_request_path = Path(execution_request_binding["path"])
    if (
        execution_request_path.parent != Path(ledger["root"]) / "requests"
        or sha256_file(execution_request_path) != execution_request_binding["sha256"]
    ):
        raise ValueError("execution role request is missing or hash-invalid")
    execution_request = read_json(execution_request_path, "execution role request")
    if (
        execution_request.get("schemaVersion") != "arc-v35-p30-role-request-v1"
        or execution_request.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
        or execution_request.get("protocol") != authorization["protocol"]
        or execution_request.get("role") != "executor"
        or execution_request.get("verb") != expected_request_verb
        or execution_request.get("expectedOutputPath") != str(receipt_path)
        or execution_request.get("predecessorSha256")
        != expected_request_predecessor_sha256
        or not TOKEN_PATTERN.fullmatch(str(execution_request.get("requestNonce")))
    ):
        raise ValueError("execution role request changed")
    if draft_path.exists():
        validate_unsigned_receipt_draft(
            draft_path,
            authorization_path=authorization_path,
            authorization=authorization,
            execution_request_binding=execution_request_binding,
        )
        return draft_path
    if launch_permit_path is None:
        raise RuntimeError(
            "executor launch permit is required before token consumption or Popen"
        )
    validate_executor_launch_permit(
        launch_permit_path,
        authorization_path=authorization_path.resolve(),
        authorization=authorization,
        protocol=protocol,
        execution_request_binding=execution_request_binding,
        expected_request_verb=expected_request_verb,
    )
    if consumed_path.exists():
        raise RuntimeError(
            "authorization was consumed without a sealable unsigned receipt; "
            "guardian recovery is required"
        )
    _prepare_output_parents(authorization)
    for label, entry in authorization["outputs"].items():
        if entry["mustBeAbsentAtStart"] and Path(entry["path"]).exists():
            raise FileExistsError(f"authorized output already exists: {label}")
    if not {"stdout", "stderr", "exitCode"}.issubset(authorization["outputs"]):
        raise ValueError("authorization lacks executor control outputs")
    analysis_capability_fd: int | None = None
    analysis_capability_sha256: str | None = None
    analysis_intent_path: Path | None = None
    analysis_evidence_path: Path | None = None
    if authorization["kind"] == "analysis":
        analysis_intent_path, analysis_evidence_path = analysis_launch_paths(
            Path(ledger["root"]), authorization["tokenId"]
        )
        if analysis_intent_path.exists() or analysis_evidence_path.exists():
            raise FileExistsError("analysis launch evidence already exists")
        analysis_capability_fd, analysis_capability_sha256 = (
            _create_analysis_capability()
        )
    command = bubblewrap_command(
        authorization, analysis_capability_fd=analysis_capability_fd
    )
    stdout_path = Path(authorization["outputs"]["stdout"]["path"])
    stderr_path = Path(authorization["outputs"]["stderr"]["path"])
    exit_path = Path(authorization["outputs"]["exitCode"]["path"])
    started = utc_now()
    consumed = {
        "schemaVersion": CONSUMED_SCHEMA,
        "tokenId": authorization["tokenId"],
        "authorizationPath": str(authorization_path.resolve()),
        "authorizationSha256": sha256_file(authorization_path),
        "consumedAtUtc": started,
        "consumerPid": os.getpid(),
        "host": platform.node(),
        "bootId": host_boot_id(),
    }
    try:
        atomic_write_exclusive(consumed_path, canonical_json(consumed) + b"\n")
    except BaseException:
        if analysis_capability_fd is not None:
            os.close(analysis_capability_fd)
        raise
    gpu_mode = authorization["isolation"]["gpuMode"]
    lease_path = Path(ledger["leasePath"])
    before_gpu: dict[str, Any] | None = None
    after_gpu: dict[str, Any] | None = None
    gpu_empty = gpu_mode == "none"
    lease_acquired = False
    stdout_fd: int | None = None
    stderr_fd: int | None = None
    child: subprocess.Popen[Any] | None = None
    record: dict[str, Any] = {"pid": None, "available": False}
    exit_code = 125
    spawn_call_entered = False
    child_started = False
    failure: BaseException | None = None
    pre_child_diagnostic = "SUPERVISOR_INTERRUPTED_PRE_CHILD"
    try:
        if analysis_capability_fd is not None:
            assert analysis_capability_sha256 is not None
            assert analysis_intent_path is not None
            assert analysis_evidence_path is not None
            intent = _analysis_launch_intent(
                authorization_path=authorization_path,
                authorization=authorization,
                consumed_path=consumed_path,
                capability_sha256=analysis_capability_sha256,
                intent_path=analysis_intent_path,
                evidence_path=analysis_evidence_path,
                launch_permit_path=launch_permit_path,
            )
            atomic_write_exclusive(
                analysis_intent_path, canonical_json(intent) + b"\n"
            )
        if gpu_mode == "exclusive-gpu7":
            pre_child_diagnostic = "LEASE_ACQUISITION_FAILED"
            lease_path.mkdir(parents=False, exist_ok=False)
            lease_acquired = True
            lease_owner = {
                "schemaVersion": "arc-v35-p30-external-gpu7-lease-v1",
                "tokenId": authorization["tokenId"],
                "authorizationSha256": sha256_file(authorization_path),
                "subjectSha256": sha256_bytes(canonical_json(authorization["subject"])),
                "root": authorization["subject"].get("root"),
                "generation": authorization["subject"].get("generation"),
                "pid": os.getpid(),
                "acquiredAtUtc": started,
                "gpuUuid": GPU_UUID,
            }
            atomic_write_exclusive(
                lease_path / "owner.json", canonical_json(lease_owner) + b"\n"
            )
            pre_child_diagnostic = "GPU7_PRECHECK_FAILED"
            before_gpu = gpu_snapshot()
            if (
                before_gpu["selected"]["memoryMiB"] != 0
                or before_gpu["selected"]["utilizationPercent"] != 0
            ):
                raise ValueError("GPU 7 is not empty after acquiring the authorized lease")
        pre_child_diagnostic = "OUTPUT_OPEN_FAILED"
        stdout_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        stderr_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        # Entering Popen is a separate, irreversible boundary from receiving a
        # usable child handle.  If Popen raises, the supervisor cannot prove
        # that no OS child briefly existed, so PRE_CHILD recovery is forbidden.
        spawn_call_entered = True
        child = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout_fd,
            stderr=stderr_fd,
            start_new_session=True,
            pass_fds=(
                ()
                if analysis_capability_fd is None
                else (analysis_capability_fd,)
            ),
        )
        child_started = True
        if analysis_capability_fd is not None:
            os.close(analysis_capability_fd)
            analysis_capability_fd = None
            assert analysis_intent_path is not None
            assert analysis_evidence_path is not None
            _commit_analysis_launch_evidence(
                intent_path=analysis_intent_path,
                evidence_path=analysis_evidence_path,
                intent=intent,
                child=child,
                authorization=authorization,
            )
        record = {
            **process_record(child.pid),
            "spawnCallEntered": True,
            "childStarted": True,
        }
        exit_code = child.wait()
    except BaseException as exc:
        failure = exc
        try:
            _terminate_child(child)
        except BaseException:
            pass
    finally:
        if stdout_fd is not None:
            os.close(stdout_fd)
        if stderr_fd is not None:
            os.close(stderr_fd)
        if analysis_capability_fd is not None:
            os.close(analysis_capability_fd)
            analysis_capability_fd = None
        if spawn_call_entered and not exit_path.exists():
            try:
                atomic_write_exclusive(exit_path, f"{exit_code}\n".encode("ascii"))
            except BaseException:
                pass
        if gpu_mode == "exclusive-gpu7":
            try:
                after_gpu, gpu_empty = _wait_for_gpu_empty()
            except BaseException:
                after_gpu = None
                gpu_empty = False
        if lease_acquired and gpu_empty and (child is None or child.poll() is not None):
            try:
                (lease_path / "owner.json").unlink()
                lease_path.rmdir()
            except BaseException:
                pass
    finished = utc_now()
    if failure is not None and not spawn_call_entered and not child_started:
        # Supervisor-created streams are not evidence that candidate code ran.
        # Remove them before making the much stronger PRE_CHILD claim.  Any
        # cleanup ambiguity deliberately leaves no recoverable draft.
        for path in (stdout_path, stderr_path, exit_path):
            path.unlink(missing_ok=True)
        if any(Path(entry["path"]).exists() for entry in authorization["outputs"].values()):
            raise RuntimeError(
                "pre-child failure left an authorized output; campaign recovery is ambiguous"
            ) from failure
        if terminal_on_pre_child_failure:
            raise RuntimeError(
                "PRE_CHILD recovery execution failed before Popen and cannot be retried"
            ) from failure
        try:
            from v35_p30_recovery import persist_pre_child_recovery_draft

            recovery_path = persist_pre_child_recovery_draft(
                authorization_path=authorization_path,
                authorization=authorization,
                consumed_path=consumed_path,
                diagnostic_code=pre_child_diagnostic,
                started_at_utc=started,
                finished_at_utc=finished,
                gpu_empty_after=gpu_empty,
                lease_released=gpu_mode == "none" or not lease_path.exists(),
            )
        except BaseException as recovery_error:
            raise RuntimeError(
                "pre-child failure could not be proven; campaign must fail closed"
            ) from recovery_error
        raise RuntimeError(
            f"guardian PRE_CHILD recovery is required: {recovery_path}"
        ) from failure
    no_process = child is None or not Path(f"/proc/{child.pid}").exists()
    artifacts: dict[str, Any] = {}
    missing: list[str] = []
    for label, entry in authorization["outputs"].items():
        path = Path(entry["path"])
        try:
            evidence = regular_file_evidence(path)
        except (FileNotFoundError, OSError, ValueError):
            if entry["required"]:
                missing.append(label)
            continue
        artifacts[label] = {
            "path": str(path),
            "sha256": evidence["sha256"],
            "bytes": evidence["bytes"],
        }
    record = {
        **record,
        "spawnCallEntered": spawn_call_entered,
        "childStarted": child_started,
    }
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA,
        "valid": exit_code == 0
        and not missing
        and no_process
        and gpu_empty
        and (gpu_mode == "none" or not lease_path.exists()),
        "promotionEligible": False,
        "kind": authorization["kind"],
        "tokenId": authorization["tokenId"],
        "campaignId": authorization["campaignId"],
        "authorization": {
            "path": str(authorization_path.resolve()),
            "sha256": sha256_file(authorization_path),
        },
        "consumedMarker": {"path": str(consumed_path), "sha256": sha256_file(consumed_path)},
        "startedAtUtc": started,
        "finishedAtUtc": finished,
        "subject": authorization["subject"],
        "command": authorization["command"],
        "isolation": {
            **authorization["isolation"],
            "argvSha256": sha256_bytes(canonical_json(command)),
        },
        "process": record,
        "exitCode": exit_code,
        "noSupervisorChildRemaining": no_process,
        "gpuBefore": before_gpu,
        "gpuAfter": after_gpu,
        "gpuEmptyAfter": gpu_empty,
        "leaseReleased": gpu_mode == "none" or not lease_path.exists(),
        "missingRequiredOutputs": missing,
        "artifacts": artifacts,
        "predecessor": authorization["predecessor"],
        "executionRequest": dict(execution_request_binding),
    }
    atomic_write_exclusive(draft_path, canonical_json(receipt) + b"\n")
    validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=authorization_path,
        authorization=authorization,
        execution_request_binding=execution_request_binding,
    )
    return draft_path


def prepare_execution_receipt(
    authorization_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    execution_request_binding: Mapping[str, str],
    launch_permit_path: Path | None = None,
) -> Path:
    """Prepare an ordinary, non-recovery execution exactly once."""

    return _prepare_execution_receipt(
        authorization_path,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        execution_request_binding=execution_request_binding,
        expected_request_verb="execute",
        expected_request_predecessor_sha256=sha256_file(authorization_path.resolve()),
        terminal_on_pre_child_failure=False,
        launch_permit_path=launch_permit_path,
    )


def _validate_pre_child_recovery_execution_context(
    recovery_authorization_path: Path,
    original_authorization_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    link_attestation_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    guardian_public_key_path: Path,
    execution_request_binding: Mapping[str, str],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Validate the complete guardian-bound PRE_CHILD rerun chain."""

    from v35_p30_recovery import (
        PRE_CHILD,
        recovery_execution_draft_path,
        validate_execution_draft,
        validate_guardian_incident,
        validate_recovery_link,
    )

    recovery_authorization_path = recovery_authorization_path.resolve()
    original_authorization_path = original_authorization_path.resolve()
    recovery_signed = read_json(
        recovery_authorization_path, "PRE_CHILD recovery authorization"
    )
    recovery_authorization = validate_authorization(
        recovery_signed,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        authorization_path=recovery_authorization_path,
    )
    if recovery_authorization["kind"] not in {
        "generation",
        "evaluation-primary",
        "evaluation-replay",
    }:
        raise ValueError("PRE_CHILD recovery cannot run this authorization kind")
    original_signed = read_json(
        original_authorization_path, "original PRE_CHILD authorization"
    )
    original_unsigned = verify_signed_payload(
        original_signed,
        expected_role="issuer",
        public_key_path=issuer_public_key_path,
    )
    if recovery_draft_path != recovery_execution_draft_path(
        Path(original_unsigned["ledger"]["receiptPath"])
    ):
        raise ValueError("PRE_CHILD recovery draft path changed")
    recovery_draft = validate_execution_draft(
        read_json(recovery_draft_path, "PRE_CHILD recovery draft"),
        authorization=original_unsigned,
    )
    original = validate_authorization(
        original_signed,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        authorization_path=original_authorization_path,
        now=parse_utc(recovery_draft["startedAtUtc"], "original execution start time"),
    )
    incident = validate_guardian_incident(
        read_json(guardian_incident_path, "guardian PRE_CHILD incident"),
        guardian_public_key_path=guardian_public_key_path,
        execution_draft=recovery_draft,
        authorization=original,
    )
    link = validate_recovery_link(
        read_json(recovery_link_path, "PRE_CHILD recovery link"),
        guardian_incident=incident,
        original_authorization=original,
        replacement_authorization=recovery_authorization,
    )
    link_attestation = verify_signed_payload(
        read_json(link_attestation_path, "guardian PRE_CHILD link attestation"),
        expected_role="guardian",
        public_key_path=guardian_public_key_path,
    )
    exact_keys(
        execution_request_binding,
        {"path", "sha256"},
        "PRE_CHILD execution request binding",
    )
    request_path = Path(str(execution_request_binding["path"]))
    if (
        not request_path.is_absolute()
        or sha256_file(request_path) != execution_request_binding["sha256"]
    ):
        raise ValueError("PRE_CHILD execution request is missing or hash-invalid")
    request = read_json(request_path, "PRE_CHILD execution request")
    subject = exact_keys(
        request.get("subject"),
        {
            "logicalId",
            "authorizationPath",
            "originalAuthorizationPath",
            "executionDraft",
            "guardianIncident",
            "recoveryLink",
            "linkAttestation",
            "recoveryOrdinal",
            "recoveryTokenId",
        },
        "PRE_CHILD execution request subject",
    )
    expected_draft_binding = _file_binding(recovery_draft_path)
    expected_incident_binding = _file_binding(guardian_incident_path)
    expected_link_binding = _file_binding(recovery_link_path)
    expected_link_attestation_binding = _file_binding(link_attestation_path)
    protocol = read_json(
        Path(recovery_authorization["protocol"]["path"]), "authorized P30 protocol"
    )
    if (
        request.get("schemaVersion") != "arc-v35-p30-role-request-v1"
        or request.get("campaignInstanceId")
        != protocol["executionTrust"]["campaignInstanceId"]
        or request.get("protocol") != recovery_authorization["protocol"]
        or request.get("role") != "executor"
        or request.get("verb") != "execute-recovery"
        or request.get("predecessorSha256") != expected_link_attestation_binding["sha256"]
        or request.get("expectedOutputPath")
        != recovery_authorization["ledger"]["receiptPath"]
        or not TOKEN_PATTERN.fullmatch(str(request.get("requestNonce")))
        or subject.get("authorizationPath") != str(recovery_authorization_path)
        or subject.get("originalAuthorizationPath") != str(original_authorization_path)
        or subject.get("executionDraft") != expected_draft_binding
        or subject.get("guardianIncident") != expected_incident_binding
        or subject.get("recoveryLink") != expected_link_binding
        or subject.get("linkAttestation") != expected_link_attestation_binding
        or subject.get("recoveryOrdinal") != 1
        or subject.get("recoveryTokenId") != recovery_authorization["tokenId"]
        or recovery_draft.get("recoveryClass") != PRE_CHILD
        or link.get("recoveryClass") != PRE_CHILD
        or link_attestation.get("phase") != "link"
        or link_attestation.get("valid") is not True
        or link_attestation.get("outcomeBlind") is not True
        or link_attestation.get("outcomesInspected") is not False
        or link_attestation.get("originalTokenId") != original["tokenId"]
        or link_attestation.get("recoveryClass") != PRE_CHILD
        or link_attestation.get("attemptOrdinal") != 1
        or link_attestation.get("artifact") != expected_link_binding
    ):
        raise ValueError("PRE_CHILD execution request or guardian link changed")
    replacement_recovery_draft = recovery_execution_draft_path(
        Path(recovery_authorization["ledger"]["receiptPath"])
    )
    if replacement_recovery_draft.exists():
        raise RuntimeError("nested PRE_CHILD recovery is forbidden")
    return recovery_authorization, original, request


def _pre_child_attempt_payload(
    *,
    recovery_authorization_path: Path,
    recovery_authorization: Mapping[str, Any],
    original_authorization_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    link_attestation_path: Path,
    execution_request_binding: Mapping[str, str],
) -> dict[str, Any]:
    return {
        "schemaVersion": PRE_CHILD_RECOVERY_ATTEMPT_SCHEMA,
        "immutable": True,
        "promotionEligible": False,
        "recoveryClass": "PRE_CHILD",
        "recoveryOrdinal": 1,
        "originalAuthorization": _file_binding(original_authorization_path),
        "recoveryAuthorization": _file_binding(recovery_authorization_path),
        "executionDraft": _file_binding(recovery_draft_path),
        "guardianIncident": _file_binding(guardian_incident_path),
        "recoveryLink": _file_binding(recovery_link_path),
        "linkAttestation": _file_binding(link_attestation_path),
        "executionRequest": dict(execution_request_binding),
        "originalTokenId": read_json(
            original_authorization_path, "original recovery authorization"
        )["tokenId"],
        "recoveryTokenId": recovery_authorization["tokenId"],
        "attemptedAtUtc": utc_now(),
        "secondRecoveryForbidden": True,
    }


def validate_pre_child_recovery_attempt(
    attempt_path: Path,
    *,
    recovery_authorization_path: Path,
    recovery_authorization: Mapping[str, Any],
    original_authorization_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    link_attestation_path: Path,
) -> dict[str, Any]:
    """Validate the durable pre-Popen permit after replacement output reuse."""

    attempt = read_json(attempt_path, "PRE_CHILD recovery attempt")
    request_binding = attempt.get("executionRequest")
    exact_keys(
        request_binding,
        {"path", "sha256"},
        "PRE_CHILD attempt execution request",
    )
    request_path = Path(str(request_binding["path"]))
    if not request_path.is_absolute() or sha256_file(request_path) != request_binding["sha256"]:
        raise ValueError("PRE_CHILD attempt execution request is missing or hash-invalid")
    expected = _pre_child_attempt_payload(
        recovery_authorization_path=recovery_authorization_path.resolve(),
        recovery_authorization=recovery_authorization,
        original_authorization_path=original_authorization_path.resolve(),
        recovery_draft_path=recovery_draft_path,
        guardian_incident_path=guardian_incident_path,
        recovery_link_path=recovery_link_path,
        link_attestation_path=link_attestation_path,
        execution_request_binding=request_binding,
    )
    expected["attemptedAtUtc"] = attempt.get("attemptedAtUtc")
    if attempt != expected:
        raise ValueError("PRE_CHILD recovery attempt marker changed")
    parse_utc(attempt["attemptedAtUtc"], "PRE_CHILD recovery attempt time")
    return attempt


def prepare_pre_child_recovery_execution(
    recovery_authorization_path: Path,
    original_authorization_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    link_attestation_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    guardian_public_key_path: Path,
    execution_request_binding: Mapping[str, str],
    launch_permit_path: Path | None = None,
) -> Path:
    """Run the sole guardian-approved PRE_CHILD replacement attempt."""

    early_signed = read_json(
        recovery_authorization_path, "PRE_CHILD recovery authorization"
    )
    early_authorization = verify_signed_payload(
        early_signed,
        expected_role="issuer",
        public_key_path=issuer_public_key_path,
    )
    early_attempt_path = pre_child_recovery_attempt_path(
        Path(early_authorization["ledger"]["receiptPath"])
    )
    if early_attempt_path.exists():
        raise RuntimeError("PRE_CHILD recovery execution was already attempted")
    authorization, _, _ = _validate_pre_child_recovery_execution_context(
        recovery_authorization_path,
        original_authorization_path,
        recovery_draft_path,
        guardian_incident_path,
        recovery_link_path,
        link_attestation_path,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        guardian_public_key_path=guardian_public_key_path,
        execution_request_binding=execution_request_binding,
    )
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    protocol = read_json(
        Path(authorization["protocol"]["path"]), "PRE_CHILD authorized protocol"
    )
    if launch_permit_path is None:
        raise RuntimeError(
            "executor launch permit is required before PRE_CHILD attempt consumption"
        )
    validate_executor_launch_permit(
        launch_permit_path,
        authorization_path=recovery_authorization_path.resolve(),
        authorization=authorization,
        protocol=protocol,
        execution_request_binding=execution_request_binding,
        expected_request_verb="execute-recovery",
    )
    attempt_path = pre_child_recovery_attempt_path(receipt_path)
    if attempt_path.exists():
        raise RuntimeError("PRE_CHILD recovery execution was already attempted")
    if receipt_path.exists() or unsigned_receipt_path(receipt_path).exists():
        raise RuntimeError("PRE_CHILD recovery execution already has terminal evidence")
    attempt = _pre_child_attempt_payload(
        recovery_authorization_path=recovery_authorization_path.resolve(),
        recovery_authorization=authorization,
        original_authorization_path=original_authorization_path.resolve(),
        recovery_draft_path=recovery_draft_path,
        guardian_incident_path=guardian_incident_path,
        recovery_link_path=recovery_link_path,
        link_attestation_path=link_attestation_path,
        execution_request_binding=execution_request_binding,
    )
    # This marker is fsync-backed and precedes Popen.  Its existence makes every
    # later invocation terminal, including a crash during Popen itself.
    atomic_write_exclusive(attempt_path, canonical_json(attempt) + b"\n")
    draft_path = _prepare_execution_receipt(
        recovery_authorization_path,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        execution_request_binding=execution_request_binding,
        expected_request_verb="execute-recovery",
        expected_request_predecessor_sha256=sha256_file(link_attestation_path),
        terminal_on_pre_child_failure=True,
        launch_permit_path=launch_permit_path,
    )
    draft = validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=recovery_authorization_path,
        authorization=authorization,
        execution_request_binding=execution_request_binding,
    )
    if draft["valid"] is not True:
        raise RuntimeError("PRE_CHILD recovery execution failed and cannot be retried")
    return draft_path


def validate_unsigned_receipt_draft(
    draft_path: Path,
    *,
    authorization_path: Path,
    authorization: Mapping[str, Any],
    execution_request_binding: Mapping[str, str],
) -> dict[str, Any]:
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    if draft_path != unsigned_receipt_path(receipt_path):
        raise ValueError("unsigned execution receipt path changed")
    draft = read_json(draft_path, "unsigned execution receipt")
    exact_keys(
        draft,
        {
            "schemaVersion",
            "valid",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "consumedMarker",
            "startedAtUtc",
            "finishedAtUtc",
            "subject",
            "command",
            "isolation",
            "process",
            "exitCode",
            "noSupervisorChildRemaining",
            "gpuBefore",
            "gpuAfter",
            "gpuEmptyAfter",
            "leaseReleased",
            "missingRequiredOutputs",
            "artifacts",
            "predecessor",
            "executionRequest",
        },
        "unsigned execution receipt",
    )
    authorization_path = authorization_path.resolve()
    consumed_path = Path(authorization["ledger"]["consumedPath"])
    consumed_binding = draft.get("consumedMarker")
    if (
        draft.get("schemaVersion") != RECEIPT_SCHEMA
        or type(draft.get("valid")) is not bool
        or draft.get("promotionEligible") is not False
        or draft.get("kind") != authorization["kind"]
        or draft.get("tokenId") != authorization["tokenId"]
        or draft.get("campaignId") != authorization["campaignId"]
        or draft.get("authorization")
        != {"path": str(authorization_path), "sha256": sha256_file(authorization_path)}
        or not isinstance(consumed_binding, dict)
        or consumed_binding
        != {"path": str(consumed_path), "sha256": sha256_file(consumed_path)}
        or draft.get("subject") != authorization["subject"]
        or draft.get("command") != authorization["command"]
        or draft.get("predecessor") != authorization["predecessor"]
        or draft.get("executionRequest") != dict(execution_request_binding)
    ):
        raise ValueError("unsigned execution receipt differs from its authorization")
    consumed = read_json(consumed_path, "consumed token marker")
    exact_keys(
        consumed,
        {
            "schemaVersion",
            "tokenId",
            "authorizationPath",
            "authorizationSha256",
            "consumedAtUtc",
            "consumerPid",
            "host",
            "bootId",
        },
        "consumed token marker",
    )
    started = parse_utc(draft["startedAtUtc"], "execution start time")
    finished = parse_utc(draft["finishedAtUtc"], "execution finish time")
    if (
        consumed.get("schemaVersion") != CONSUMED_SCHEMA
        or consumed.get("tokenId") != authorization["tokenId"]
        or consumed.get("authorizationPath") != str(authorization_path)
        or consumed.get("authorizationSha256") != sha256_file(authorization_path)
        or consumed.get("consumedAtUtc") != draft["startedAtUtc"]
        or not started <= finished
        or finished - started > dt.timedelta(days=14)
    ):
        raise ValueError("unsigned receipt consumed-token evidence changed")
    expected_isolation = {
        **authorization["isolation"],
        "argvSha256": sha256_bytes(
            canonical_json(
                bubblewrap_command(
                    authorization,
                    analysis_capability_fd=(
                        ANALYSIS_CAPABILITY_FD
                        if authorization["kind"] == "analysis"
                        else None
                    ),
                )
            )
        ),
    }
    if draft.get("isolation") != expected_isolation:
        raise ValueError("unsigned receipt isolation evidence changed")
    missing: list[str] = []
    expected_artifacts: dict[str, Any] = {}
    for label, output in authorization["outputs"].items():
        path = Path(output["path"])
        try:
            evidence = regular_file_evidence(path)
        except (FileNotFoundError, OSError, ValueError):
            if output["required"]:
                missing.append(label)
            continue
        expected_artifacts[label] = {
            "path": str(path),
            "sha256": evidence["sha256"],
            "bytes": evidence["bytes"],
        }
    if (
        draft.get("artifacts") != expected_artifacts
        or draft.get("missingRequiredOutputs") != missing
    ):
        raise ValueError("unsigned receipt artifact evidence changed")
    exit_path = Path(authorization["outputs"]["exitCode"]["path"])
    if exit_path.is_file():
        try:
            observed_exit = int(read_regular_nofollow(exit_path, maximum_bytes=32))
        except (TypeError, ValueError) as exc:
            raise ValueError("unsigned receipt exit-code evidence changed") from exc
        if draft.get("exitCode") != observed_exit:
            raise ValueError("unsigned receipt exit-code evidence changed")
    objective_valid = (
        draft.get("exitCode") == 0
        and not missing
        and draft.get("noSupervisorChildRemaining") is True
        and draft.get("gpuEmptyAfter") is True
        and draft.get("leaseReleased") is True
    )
    if draft.get("valid") is not objective_valid:
        raise ValueError("unsigned receipt validity differs from objective cleanup evidence")
    return draft


def _seal_execution_receipt(
    authorization_path: Path,
    draft_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    executor_public_key_path: Path,
    executor_private_key_fd: int,
    execution_request_binding: Mapping[str, str],
    expected_authorization_request_verb: str,
    prevalidated_authorization: Mapping[str, Any] | None = None,
) -> Path:
    signed = read_json(authorization_path, "execution authorization")
    draft = read_json(draft_path, "unsigned execution receipt")
    authorization = (
        dict(prevalidated_authorization)
        if prevalidated_authorization is not None
        else validate_authorization(
            signed,
            issuer_public_key_path=issuer_public_key_path,
            analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
            authorization_path=authorization_path.resolve(),
            now=parse_utc(draft.get("startedAtUtc"), "execution start time"),
        )
    )
    if prevalidated_authorization is not None:
        verified = verify_signed_payload(
            signed,
            expected_role=(
                "analysis-authorizer"
                if authorization.get("kind") == "analysis"
                else "issuer"
            ),
            public_key_path=(
                analysis_authorizer_public_key_path
                if authorization.get("kind") == "analysis"
                else issuer_public_key_path
            ),
        )
        if verified != authorization:
            raise ValueError("prevalidated authorization differs from its signed file")
    protocol = read_json(Path(authorization["protocol"]["path"]), "authorized P30 protocol")
    executor_trust = validate_role_trust(
        protocol["executionTrust"], require_materialized=True
    )["executor"]
    if Path(str(executor_trust["publicKeyPath"])) != executor_public_key_path:
        raise ValueError("executor public key differs from the protocol trust root")
    authorization_request = read_json(
        Path(authorization["request"]["path"]), "authorization role request"
    )
    if authorization_request.get("verb") != expected_authorization_request_verb:
        raise ValueError("execution sealing path does not match authorization origin")
    draft = validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=authorization_path,
        authorization=authorization,
        execution_request_binding=execution_request_binding,
    )
    if draft["valid"] is not True:
        raise RuntimeError("invalid unsigned execution draft requires guardian resolution")
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    if receipt_path.exists():
        raise FileExistsError("authorization already has an execution receipt")
    seal_attempt_path = normal_seal_attempt_path(receipt_path)
    if seal_attempt_path.exists():
        _validate_seal_attempt(
            seal_attempt_path,
            expected_schema=NORMAL_SEAL_ATTEMPT_SCHEMA,
            authorization_path=authorization_path,
            authorization=authorization,
            draft_path=draft_path,
            execution_request_binding=execution_request_binding,
            recovery_evidence=None,
        )
        raise RuntimeError(
            "normal executor signing was already attempted; guardian recovery is required"
        )
    seal_attempt = _seal_attempt_payload(
        schema_version=NORMAL_SEAL_ATTEMPT_SCHEMA,
        authorization_path=authorization_path,
        authorization=authorization,
        draft_path=draft_path,
        execution_request_binding=execution_request_binding,
        recovery_evidence=None,
    )
    # This fsync-backed marker is deliberately committed before the private key
    # is touched.  A crash or signature failure can therefore never be retried
    # through the ordinary seal path.
    atomic_write_exclusive(
        seal_attempt_path, canonical_json(seal_attempt) + b"\n"
    )
    receipt = dict(draft)
    receipt["signature"] = sign_payload(
        receipt,
        role="executor",
        private_key_fd=executor_private_key_fd,
        public_key_path=executor_public_key_path,
    )
    atomic_write_exclusive(receipt_path, canonical_json(receipt) + b"\n")
    if receipt["valid"] is not True:
        raise RuntimeError(f"authorized execution failed; sealed receipt: {receipt_path}")
    return receipt_path


def seal_execution_receipt(
    authorization_path: Path,
    draft_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    executor_public_key_path: Path,
    executor_private_key_fd: int,
    execution_request_binding: Mapping[str, str],
) -> Path:
    """Seal only an ordinary execution; recovery authorizations are rejected."""

    return _seal_execution_receipt(
        authorization_path,
        draft_path,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        executor_public_key_path=executor_public_key_path,
        executor_private_key_fd=executor_private_key_fd,
        execution_request_binding=execution_request_binding,
        expected_authorization_request_verb={
            "generation": "issue-generation",
            "evaluation-primary": "issue-evaluation",
            "evaluation-replay": "issue-evaluation",
            "analysis": "issue-analysis",
            "preflight": "issue-preflight-execution",
        }[
            read_json(authorization_path, "execution authorization")["kind"]
        ],
        prevalidated_authorization=None,
    )


def seal_pre_child_recovery(
    recovery_authorization_path: Path,
    draft_path: Path,
    original_authorization_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    link_attestation_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    guardian_public_key_path: Path,
    executor_public_key_path: Path,
    executor_private_key_fd: int,
    execution_request_binding: Mapping[str, str],
) -> Path:
    """Seal the sole completed PRE_CHILD rerun through its dedicated path."""

    signed_authorization = read_json(
        recovery_authorization_path, "PRE_CHILD recovery authorization"
    )
    authorization = verify_signed_payload(
        signed_authorization,
        expected_role="issuer",
        public_key_path=issuer_public_key_path,
    )
    if authorization.get("kind") not in {
        "generation",
        "evaluation-primary",
        "evaluation-replay",
    }:
        raise ValueError("PRE_CHILD seal authorization kind changed")
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    attempt_path = pre_child_recovery_attempt_path(receipt_path)
    attempt = read_json(attempt_path, "PRE_CHILD recovery attempt")
    expected = _pre_child_attempt_payload(
        recovery_authorization_path=recovery_authorization_path.resolve(),
        recovery_authorization=authorization,
        original_authorization_path=original_authorization_path.resolve(),
        recovery_draft_path=recovery_draft_path,
        guardian_incident_path=guardian_incident_path,
        recovery_link_path=recovery_link_path,
        link_attestation_path=link_attestation_path,
        execution_request_binding=execution_request_binding,
    )
    expected["attemptedAtUtc"] = attempt.get("attemptedAtUtc")
    if attempt != expected:
        raise ValueError("PRE_CHILD recovery attempt marker changed")
    attempted = parse_utc(attempt["attemptedAtUtc"], "PRE_CHILD recovery attempt time")
    draft = read_json(draft_path, "PRE_CHILD unsigned execution receipt")
    started = parse_utc(draft.get("startedAtUtc"), "PRE_CHILD execution start time")
    if attempted > started or started - attempted > dt.timedelta(minutes=5):
        raise ValueError("PRE_CHILD recovery attempt marker does not precede execution")
    return _seal_execution_receipt(
        recovery_authorization_path,
        draft_path,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        executor_public_key_path=executor_public_key_path,
        executor_private_key_fd=executor_private_key_fd,
        execution_request_binding=execution_request_binding,
        expected_authorization_request_verb="issue-recovery",
        prevalidated_authorization=authorization,
    )


def prepare_receipt_only_recovery_draft(
    authorization_path: Path,
    draft_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    execution_request_binding: Mapping[str, str],
    diagnostic_code: str = "RECEIPT_SIGNATURE_FAILED",
) -> Path:
    """Create the canonical RECEIPT_ONLY draft without running candidate code."""

    signed = read_json(authorization_path, "execution authorization")
    from v35_p30_recovery import require_recovery_eligible_kind

    require_recovery_eligible_kind(signed)
    unsigned_receipt = read_json(draft_path, "unsigned execution receipt")
    authorization = validate_authorization(
        signed,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        authorization_path=authorization_path.resolve(),
        now=parse_utc(unsigned_receipt.get("startedAtUtc"), "execution start time"),
    )
    unsigned_receipt = validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=authorization_path,
        authorization=authorization,
        execution_request_binding=execution_request_binding,
    )
    if unsigned_receipt["valid"] is not True:
        raise RuntimeError("RECEIPT_ONLY requires a valid completed execution")
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    if receipt_path.exists():
        raise FileExistsError("authorization already has an execution receipt")
    attempt_path = normal_seal_attempt_path(receipt_path)
    attempt = _validate_seal_attempt(
        attempt_path,
        expected_schema=NORMAL_SEAL_ATTEMPT_SCHEMA,
        authorization_path=authorization_path,
        authorization=authorization,
        draft_path=draft_path,
        execution_request_binding=execution_request_binding,
        recovery_evidence=None,
    )
    attempted = parse_utc(attempt["attemptedAtUtc"], "normal seal-attempt time")
    finished = parse_utc(unsigned_receipt["finishedAtUtc"], "execution finish time")
    if not finished <= attempted <= finished + dt.timedelta(hours=24):
        raise ValueError("normal seal-attempt time is outside the recovery window")
    from v35_p30_recovery import persist_receipt_only_recovery_draft

    return persist_receipt_only_recovery_draft(
        authorization_path=authorization_path,
        authorization=authorization,
        consumed_path=Path(authorization["ledger"]["consumedPath"]),
        unsigned_receipt_path=draft_path,
        unsigned_receipt=unsigned_receipt,
        normal_seal_attempt_path=attempt_path,
        diagnostic_code=diagnostic_code,
    )


def seal_receipt_only_recovery(
    authorization_path: Path,
    draft_path: Path,
    recovery_draft_path: Path,
    guardian_incident_path: Path,
    recovery_link_path: Path,
    *,
    issuer_public_key_path: Path,
    analysis_authorizer_public_key_path: Path,
    guardian_public_key_path: Path,
    executor_public_key_path: Path,
    executor_private_key_fd: int,
    execution_request_binding: Mapping[str, str],
) -> Path:
    """Seal one guardian-approved receipt-only recovery.

    There is deliberately no command, candidate, or ``Popen`` path in this
    function.  It can only sign the already validated normal unsigned receipt,
    after the original seal-attempt marker and guardian recovery chain exist.
    """

    from v35_p30_recovery import (
        RECEIPT_ONLY,
        recovery_execution_draft_path,
        validate_execution_draft,
        validate_guardian_incident,
        validate_recovery_link,
    )

    signed = read_json(authorization_path, "execution authorization")
    from v35_p30_recovery import require_recovery_eligible_kind

    require_recovery_eligible_kind(signed)
    unsigned_receipt = read_json(draft_path, "unsigned execution receipt")
    authorization = validate_authorization(
        signed,
        issuer_public_key_path=issuer_public_key_path,
        analysis_authorizer_public_key_path=analysis_authorizer_public_key_path,
        authorization_path=authorization_path.resolve(),
        now=parse_utc(unsigned_receipt.get("startedAtUtc"), "execution start time"),
    )
    protocol = read_json(Path(authorization["protocol"]["path"]), "authorized P30 protocol")
    executor_trust = validate_role_trust(
        protocol["executionTrust"], require_materialized=True
    )["executor"]
    if Path(str(executor_trust["publicKeyPath"])) != executor_public_key_path:
        raise ValueError("executor public key differs from the protocol trust root")
    unsigned_receipt = validate_unsigned_receipt_draft(
        draft_path,
        authorization_path=authorization_path,
        authorization=authorization,
        execution_request_binding=execution_request_binding,
    )
    if unsigned_receipt["valid"] is not True:
        raise RuntimeError("RECEIPT_ONLY requires a valid completed execution")
    receipt_path = Path(authorization["ledger"]["receiptPath"])
    if receipt_path.exists():
        raise FileExistsError("authorization already has an execution receipt")
    if recovery_draft_path != recovery_execution_draft_path(receipt_path):
        raise ValueError("recovery execution draft path changed")
    normal_attempt_path = normal_seal_attempt_path(receipt_path)
    _validate_seal_attempt(
        normal_attempt_path,
        expected_schema=NORMAL_SEAL_ATTEMPT_SCHEMA,
        authorization_path=authorization_path,
        authorization=authorization,
        draft_path=draft_path,
        execution_request_binding=execution_request_binding,
        recovery_evidence=None,
    )
    recovery_draft = validate_execution_draft(
        read_json(recovery_draft_path, "RECEIPT_ONLY recovery draft"),
        authorization=authorization,
    )
    expected_unsigned_binding = {
        "path": str(draft_path.resolve()),
        "sha256": sha256_file(draft_path),
    }
    expected_attempt_binding = {
        "path": str(normal_attempt_path.resolve()),
        "sha256": sha256_file(normal_attempt_path),
    }
    if (
        recovery_draft.get("recoveryClass") != RECEIPT_ONLY
        or recovery_draft.get("unsignedReceipt") != expected_unsigned_binding
        or recovery_draft.get("normalSealAttempt") != expected_attempt_binding
    ):
        raise ValueError("receipt-only recovery does not bind the normal seal failure")
    signed_incident = read_json(guardian_incident_path, "guardian recovery incident")
    incident = validate_guardian_incident(
        signed_incident,
        guardian_public_key_path=guardian_public_key_path,
        execution_draft=recovery_draft,
        authorization=authorization,
    )
    recovery_link = read_json(recovery_link_path, "receipt-only recovery link")
    validate_recovery_link(
        recovery_link,
        guardian_incident=incident,
        original_authorization=authorization,
        replacement_authorization=None,
    )
    evidence = {
        "executionDraft": {
            "path": str(recovery_draft_path.resolve()),
            "sha256": sha256_file(recovery_draft_path),
        },
        "guardianIncident": {
            "path": str(guardian_incident_path.resolve()),
            "sha256": sha256_file(guardian_incident_path),
        },
        "recoveryLink": {
            "path": str(recovery_link_path.resolve()),
            "sha256": sha256_file(recovery_link_path),
        },
    }
    recovery_attempt_path = recovery_seal_attempt_path(receipt_path)
    if recovery_attempt_path.exists():
        _validate_seal_attempt(
            recovery_attempt_path,
            expected_schema=RECOVERY_SEAL_ATTEMPT_SCHEMA,
            authorization_path=authorization_path,
            authorization=authorization,
            draft_path=draft_path,
            execution_request_binding=execution_request_binding,
            recovery_evidence=evidence,
        )
        raise RuntimeError("receipt-only recovery signing was already attempted")
    recovery_attempt = _seal_attempt_payload(
        schema_version=RECOVERY_SEAL_ATTEMPT_SCHEMA,
        authorization_path=authorization_path,
        authorization=authorization,
        draft_path=draft_path,
        execution_request_binding=execution_request_binding,
        recovery_evidence=evidence,
    )
    atomic_write_exclusive(
        recovery_attempt_path, canonical_json(recovery_attempt) + b"\n"
    )
    receipt = dict(unsigned_receipt)
    receipt["signature"] = sign_payload(
        receipt,
        role="executor",
        private_key_fd=executor_private_key_fd,
        public_key_path=executor_public_key_path,
    )
    atomic_write_exclusive(receipt_path, canonical_json(receipt) + b"\n")
    return receipt_path


def main() -> None:
    raise SystemExit(
        "direct executor CLI is disabled; use run_v35_p30_role.py through local custody"
    )


if __name__ == "__main__":
    main()
