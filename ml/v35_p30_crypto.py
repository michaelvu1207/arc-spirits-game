#!/usr/bin/env python3
"""Small, fail-closed signing and file primitives for the V35 P30 campaign."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


SIGNATURE_SCHEMA = "arc-v35-p30-ed25519-signature-v2"
SIGNING_ROLES = frozenset(
    {"issuer", "executor", "guardian", "analysis-authorizer", "review-attester"}
)
ROLE_TRUST_SCHEMA = "arc-v35-p30-role-trust-v3"
ROLE_POLICIES = {
    "issuer": {
        "artifactSchemas": ["arc-v35-p30-execution-authorization-v1"],
        "kinds": ["generation", "evaluation-primary", "evaluation-replay", "preflight"],
    },
    "executor": {
        "artifactSchemas": [
            "arc-v35-p30-authorized-execution-receipt-v1",
            "arc-v35-p30-executor-launch-permit-v1",
        ],
        "kinds": [
            "generation",
            "evaluation-primary",
            "evaluation-replay",
            "preflight",
            "analysis",
        ],
    },
    "guardian": {
        "artifactSchemas": [
            "arc-v35-p30-outcome-blind-preflight-v1",
            "arc-v35-p30-final-generation-completeness-v1",
            "arc-v35-p30-evaluation-pair-integrity-v1",
            "arc-v35-p30-analysis-manifest-v1",
            "arc-v35-p30-phase0-readiness-v1",
            "arc-v35-p30-full-campaign-authorization-v1",
            "arc-v35-p30-recovery-incident-v1",
            "arc-v35-p30-logical-completion-v1",
        ],
        "kinds": [],
    },
    "analysis-authorizer": {
        "artifactSchemas": ["arc-v35-p30-execution-authorization-v1"],
        "kinds": ["analysis"],
    },
    "review-attester": {
        "artifactSchemas": [
            "arc-v35-p30-analysis-authorization-review-receipt-v3",
            "arc-v35-p30-gate-review-receipt-v2",
        ],
        "kinds": [],
    },
}


def venv_python_entrypoint(repo_root: Path) -> Path:
    """Return the absolute venv launcher without dereferencing its symlink.

    On Linux, ``Path.resolve()`` turns ``ml/.venv/bin/python`` into the system
    interpreter and thereby removes the venv site-packages from child startup.
    """

    root = repo_root.absolute()
    path = root / "ml/.venv/bin/python"
    if not root.is_absolute() or not path.is_file():
        raise ValueError("P30 virtual-environment Python entrypoint is unavailable")
    return path


def canonical_json(value: Any) -> bytes:
    """Return the sole byte representation accepted by P30 signatures."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    descriptor = open_regular_nofollow(path)
    try:
        return sha256_fd(descriptor)
    finally:
        os.close(descriptor)


def executable_sha256(path: Path) -> str:
    """Hash executable bytes without replacing a venv launcher in ``argv``.

    Data and key files continue to use ``sha256_file`` and reject symlinks.
    Python virtual environments, however, require the original
    ``.venv/bin/python`` path so the interpreter discovers ``pyvenv.cfg``.
    Resolve only for byte hashing; the authorization retains the exact launcher.
    """

    if not path.is_absolute():
        raise ValueError("runtime executable path must be absolute")
    target = path.resolve(strict=True)
    if not target.is_file():
        raise ValueError("runtime executable target is unavailable")
    return sha256_file(target)


def sha256_fd(descriptor: int) -> str:
    digest = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(descriptor, 1024 * 1024, offset)
        if not chunk:
            break
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def regular_file_evidence(path: Path) -> dict[str, Any]:
    """Hash and identify one immutable FD snapshot without reopening the path."""

    descriptor = open_regular_nofollow(path)
    try:
        metadata = os.fstat(descriptor)
        return {
            "path": str(path),
            "sha256": sha256_fd(descriptor),
            "bytes": metadata.st_size,
            "device": metadata.st_dev,
            "inode": metadata.st_ino,
        }
    finally:
        os.close(descriptor)


def open_regular_nofollow(path: Path, *, maximum_bytes: int | None = None) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"not a regular file: {path}")
        if maximum_bytes is not None and metadata.st_size > maximum_bytes:
            raise ValueError(f"file exceeds size limit: {path}")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_regular_nofollow(path: Path, *, maximum_bytes: int = 64 * 1024 * 1024) -> bytes:
    descriptor = open_regular_nofollow(path, maximum_bytes=maximum_bytes)
    try:
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        value = b"".join(chunks)
        if len(value) > maximum_bytes:
            raise ValueError(f"file exceeds size limit: {path}")
        return value
    finally:
        os.close(descriptor)


def atomic_write_exclusive(path: Path, payload: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        path.unlink(missing_ok=True)
        raise
    else:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _public_key_from_bytes(pem: bytes) -> tuple[Ed25519PublicKey, str, str]:
    key = serialization.load_pem_public_key(pem)
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("trust root is not an Ed25519 public key")
    der = key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    digest = sha256_bytes(der)
    return key, f"ed25519:{digest[:24]}", digest


def public_key_identity(public_key_path: Path) -> tuple[str, str]:
    # Identity and key material are derived from the same O_NOFOLLOW read.
    pem = read_regular_nofollow(public_key_path, maximum_bytes=1024 * 1024)
    _, key_id, digest = _public_key_from_bytes(pem)
    return f"ed25519:{digest[:24]}", digest


def validate_role_trust(
    trust: Any, *, require_materialized: bool
) -> dict[str, Mapping[str, Any]]:
    expected_trust_keys = {
        "schemaVersion",
        "algorithm",
        "campaignInstanceId",
        "roles",
        "custody",
        "ledgerRoot",
        "leasePath",
        "bubblewrapPath",
        "bubblewrapSha256",
        "reviewRuntime",
    }
    if (
        not isinstance(trust, dict)
        or set(trust) != expected_trust_keys
        or trust.get("schemaVersion") != ROLE_TRUST_SCHEMA
        or trust.get("algorithm") != "Ed25519"
    ):
        raise ValueError("P30 role trust schema changed")
    roles = trust.get("roles")
    if not isinstance(roles, dict) or set(roles) != SIGNING_ROLES:
        raise ValueError("P30 role trust registry changed")
    expected_role_keys = {
        "publicKeyPath",
        "publicKeyPemSha256",
        "publicKeyDerSha256",
        "keyId",
        "allowedArtifactSchemas",
        "allowedKinds",
    }
    identities: list[tuple[str, str]] = []
    for role in sorted(SIGNING_ROLES):
        entry = roles[role]
        policy = ROLE_POLICIES[role]
        if (
            not isinstance(entry, dict)
            or set(entry) != expected_role_keys
            or entry.get("allowedArtifactSchemas") != policy["artifactSchemas"]
            or entry.get("allowedKinds") != policy["kinds"]
        ):
            raise ValueError(f"P30 {role} trust policy changed")
        material = (
            entry.get("publicKeyPath"),
            entry.get("publicKeyPemSha256"),
            entry.get("publicKeyDerSha256"),
            entry.get("keyId"),
        )
        if not require_materialized:
            if any(value is not None for value in material) and not all(
                isinstance(value, str) and value for value in material
            ):
                raise ValueError(f"P30 {role} trust root is partially materialized")
            continue
        if not all(isinstance(value, str) and value for value in material):
            raise ValueError(f"P30 {role} trust root is not materialized")
        path = Path(entry["publicKeyPath"])
        if not path.is_absolute() or sha256_file(path) != entry["publicKeyPemSha256"]:
            raise ValueError(f"P30 {role} public key path is invalid")
        key_id, der_sha256 = public_key_identity(path)
        if key_id != entry["keyId"] or der_sha256 != entry["publicKeyDerSha256"]:
            raise ValueError(f"P30 {role} public key identity changed")
        identities.append((key_id, der_sha256))
    if require_materialized and len(set(identities)) != len(SIGNING_ROLES):
        raise ValueError("P30 signing roles must use distinct public keys")
    custody = trust.get("custody")
    if custody != {
        "provider": "1Password",
        "vault": "MichaelAgents",
        "secretGranularity": "one-item-per-role",
        "delivery": "encrypted-ssh-after-ready-to-sealed-memfd-cloexec",
        "schedulerPrivateKeyAccess": False,
        "maximumConcurrentPrivateKeyRoles": 1,
        "requirePrSetDumpableZero": True,
        "localOnlyRoles": ["review-attester"],
        "remoteDeliveryRoles": [
            "issuer",
            "executor",
            "guardian",
            "analysis-authorizer",
        ],
    }:
        raise ValueError("P30 key-custody policy changed")
    if trust.get("reviewRuntime") != {
        "attesterRole": "review-attester",
        "privateKeyRemoteDelivery": False,
        "attemptReservation": "remote-o-excl-before-fable",
        "claudeExecutable": {
            "path": "/usr/local/bin/claude",
            "sha256": "1fff7e8f947c07b19d10b1fbf714b7e547e9536253b9b58230d8adbc4624f867",
            "version": "2.1.211 (Claude Code)",
        },
        "container": {
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
                "securityOptions": [
                    "name=seccomp,profile=unconfined",
                    "name=cgroupns",
                ],
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
                "claudeExecutable": {
                    "path": "/usr/local/bin/claude",
                    "sha256": "1fff7e8f947c07b19d10b1fbf714b7e547e9536253b9b58230d8adbc4624f867",
                    "version": "2.1.211 (Claude Code)",
                },
            },
            "authDelivery": "oauth-token-file-descriptor-stdin-fd0",
            "rootFilesystem": "read-only",
            "capsuleMount": "read-only:/review",
            "capabilities": [],
            "noNewPrivileges": True,
            "network": "default-bridge-icc-enabled",
            "seccomp": "builtin-enforced",
            "logDriver": "none",
        },
    }:
        raise ValueError("P30 local review runtime policy changed")
    return roles


def role_public_key_path(trust: Any, role: str) -> Path:
    if role not in SIGNING_ROLES:
        raise ValueError("unknown P30 signing role")
    roles = validate_role_trust(trust, require_materialized=True)
    return Path(str(roles[role]["publicKeyPath"]))


def _private_key_from_fd(private_key_fd: int) -> Ed25519PrivateKey:
    metadata = os.fstat(private_key_fd)
    descriptor_flags = fcntl.fcntl(private_key_fd, fcntl.F_GETFD)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size > 1024 * 1024
        or metadata.st_mode & 0o077
        or not descriptor_flags & fcntl.FD_CLOEXEC
    ):
        raise ValueError("private signing key FD is not a bounded regular file")
    pem = os.pread(private_key_fd, metadata.st_size, 0)
    if len(pem) != metadata.st_size:
        raise ValueError("private signing key FD could not be read atomically")
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("private signing key is not Ed25519")
    return key


def _enforce_role_policy(payload: Mapping[str, Any], role: str) -> None:
    policy = ROLE_POLICIES[role]
    if payload.get("schemaVersion") not in policy["artifactSchemas"]:
        raise ValueError(f"P30 {role} may not sign this artifact schema")
    allowed_kinds = policy["kinds"]
    if allowed_kinds and payload.get("kind") not in allowed_kinds:
        raise ValueError(f"P30 {role} may not sign this artifact kind")


def sign_payload(
    payload: Mapping[str, Any], *, role: str, private_key_fd: int, public_key_path: Path
) -> dict[str, str]:
    if "signature" in payload:
        raise ValueError("payload must not already contain a signature")
    if role not in SIGNING_ROLES:
        raise ValueError("unknown P30 signing role")
    _enforce_role_policy(payload, role)
    encoded = canonical_json(payload)
    public_pem = read_regular_nofollow(public_key_path, maximum_bytes=1024 * 1024)
    public_key, key_id, public_sha256 = _public_key_from_bytes(public_pem)
    private_key = _private_key_from_fd(private_key_fd)
    if private_key.public_key().public_bytes_raw() != public_key.public_bytes_raw():
        raise ValueError("private signing key does not match the pinned public key")
    raw_signature = private_key.sign(encoded)
    return {
        "schemaVersion": SIGNATURE_SCHEMA,
        "algorithm": "Ed25519",
        "role": role,
        "keyId": key_id,
        "publicKeyDerSha256": public_sha256,
        "payloadSha256": sha256_bytes(encoded),
        "valueBase64": base64.b64encode(raw_signature).decode("ascii"),
    }


def verify_signed_payload(
    value: Mapping[str, Any], *, expected_role: str, public_key_path: Path,
    expected_key_id: str | None = None
) -> dict[str, Any]:
    if expected_role not in SIGNING_ROLES:
        raise ValueError("unknown expected P30 signing role")
    if not isinstance(value, dict):
        raise ValueError("signed payload must be an object")
    signature = value.get("signature")
    expected_signature_keys = {
        "schemaVersion",
        "algorithm",
        "role",
        "keyId",
        "publicKeyDerSha256",
        "payloadSha256",
        "valueBase64",
    }
    if not isinstance(signature, dict) or set(signature) != expected_signature_keys:
        raise ValueError("signature envelope is malformed")
    # The identity check and signature verification use this same immutable byte snapshot.
    public_pem = read_regular_nofollow(public_key_path, maximum_bytes=1024 * 1024)
    public_key, key_id, public_sha256 = _public_key_from_bytes(public_pem)
    if (
        signature.get("schemaVersion") != SIGNATURE_SCHEMA
        or signature.get("algorithm") != "Ed25519"
        or signature.get("role") != expected_role
        or signature.get("keyId") != key_id
        or signature.get("publicKeyDerSha256") != public_sha256
        or (expected_key_id is not None and key_id != expected_key_id)
    ):
        raise ValueError("signature key identity differs from the trust root")
    unsigned = dict(value)
    del unsigned["signature"]
    _enforce_role_policy(unsigned, expected_role)
    encoded = canonical_json(unsigned)
    if signature.get("payloadSha256") != sha256_bytes(encoded):
        raise ValueError("signed payload hash is invalid")
    try:
        raw_signature = base64.b64decode(signature.get("valueBase64"), validate=True)
    except (TypeError, ValueError) as exc:
        raise ValueError("signature is not canonical base64") from exc
    if len(raw_signature) != 64 or base64.b64encode(raw_signature).decode("ascii") != signature.get(
        "valueBase64"
    ):
        raise ValueError("signature is not canonical Ed25519 base64")
    try:
        public_key.verify(raw_signature, encoded)
    except Exception as exc:
        raise ValueError("Ed25519 signature verification failed") from exc
    return unsigned
