#!/usr/bin/env python3
"""Sign one executor launch permit locally without printing private key bytes."""

from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import stat
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from v35_p30_crypto import (
    SIGNATURE_SCHEMA,
    canonical_json,
    sha256_bytes,
)


SCHEMA = "arc-v35-p30-executor-launch-permit-v1"
MAXIMUM_KEY_BYTES = 1024 * 1024


def _read_private_key() -> tuple[Ed25519PrivateKey, bytearray]:
    metadata = os.fstat(0)
    if os.isatty(0) or not (
        stat.S_ISFIFO(metadata.st_mode) or stat.S_ISSOCK(metadata.st_mode)
    ):
        raise ValueError("launch-permit private key input must be a pipe or socket")
    value = bytearray()
    while len(value) <= MAXIMUM_KEY_BYTES:
        chunk = os.read(0, min(65536, MAXIMUM_KEY_BYTES + 1 - len(value)))
        if not chunk:
            break
        value.extend(chunk)
    if not value or len(value) > MAXIMUM_KEY_BYTES:
        raise ValueError("launch-permit private key is empty or oversized")
    key = serialization.load_pem_private_key(bytes(value), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("launch-permit private key is not Ed25519")
    return key, value


def sign(payload: dict, key: Ed25519PrivateKey) -> dict:
    if (
        set(payload)
        != {
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
        }
        or payload.get("schemaVersion") != SCHEMA
        or payload.get("authorized") is not True
        or payload.get("immutable") is not True
        or payload.get("promotionEligible") is not False
        or payload.get("outcomesInspected") is not False
        or payload.get("verb") not in {"execute", "execute-recovery"}
    ):
        raise ValueError("launch-permit payload contract changed")
    encoded = canonical_json(payload)
    public = key.public_key()
    der = public.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_digest = sha256_bytes(der)
    result = dict(payload)
    result["signature"] = {
        "schemaVersion": SIGNATURE_SCHEMA,
        "algorithm": "Ed25519",
        "role": "executor",
        "keyId": f"ed25519:{public_digest[:24]}",
        "publicKeyDerSha256": public_digest,
        "payloadSha256": sha256_bytes(encoded),
        "valueBase64": base64.b64encode(key.sign(encoded)).decode("ascii"),
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-base64", required=True)
    args = parser.parse_args()
    try:
        payload_bytes = base64.b64decode(args.payload_base64, validate=True)
        payload = json.loads(payload_bytes)
        if not isinstance(payload, dict) or canonical_json(payload) != payload_bytes:
            raise ValueError("launch-permit payload is not canonical JSON")
        key, key_bytes = _read_private_key()
        try:
            signed = sign(payload, key)
        finally:
            key_bytes[:] = b"\0" * len(key_bytes)
        sys.stdout.buffer.write(canonical_json(signed) + b"\n")
        sys.stdout.buffer.flush()
    except BaseException as exc:
        raise SystemExit(f"launch-permit signing failed: {type(exc).__name__}") from None


if __name__ == "__main__":
    main()
