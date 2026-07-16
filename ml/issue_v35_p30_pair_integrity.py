#!/usr/bin/env python3
"""Validate two signed P30 attempts and issue a metric-free pair-integrity receipt."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import REPO_ROOT, sha256
from run_v35_p30_evaluation_attempt import SCHEMA as INNER_SCHEMA
from v35_p30_authorized_execution import RECEIPT_SCHEMA
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    read_regular_nofollow,
    sha256_bytes,
    sha256_file,
    sign_payload,
    verify_signed_payload,
)


SCHEMA = "arc-v35-p30-evaluation-pair-integrity-v1"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def read_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def load_attempt(path: Path, public_key_path: Path, role: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    signed = read_object(path, f"{role} outer receipt")
    receipt = verify_signed_payload(
        signed, expected_role="executor", public_key_path=public_key_path
    )
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("kind") != f"evaluation-{role}"
        or receipt.get("promotionEligible") is not False
        or receipt.get("gpuEmptyAfter") is not True
        or receipt.get("leaseReleased") is not True
        or receipt.get("noSupervisorChildRemaining") is not True
        or receipt.get("exitCode") != 0
    ):
        raise ValueError(f"{role} outer execution receipt is invalid")
    artifacts = receipt.get("artifacts")
    inner_entry = artifacts.get("innerExecution") if isinstance(artifacts, dict) else None
    if not isinstance(inner_entry, dict):
        raise ValueError(f"{role} receipt does not bind its inner execution")
    inner_path = Path(inner_entry.get("path", ""))
    if not inner_path.is_file() or sha256_file(inner_path) != inner_entry.get("sha256"):
        raise ValueError(f"{role} inner execution artifact is missing or hash-invalid")
    inner = read_object(inner_path, f"{role} inner execution")
    subject = receipt.get("subject")
    if (
        inner.get("schemaVersion") != INNER_SCHEMA
        or inner.get("valid") is not True
        or inner.get("role") != role
        or not isinstance(subject, dict)
        or inner.get("attemptToken") != receipt.get("tokenId")
        or inner.get("root") != subject.get("root")
        or inner.get("replicate") != subject.get("replicate")
        or inner.get("arm") != subject.get("arm")
        or inner.get("protocolSha256") != subject.get("protocolSha256")
        or inner.get("sourceContractSha256") != subject.get("sourceContractSha256")
        or inner.get("checkpointSha256") != subject.get("checkpointSha256")
        or inner.get("generationAuditSha256") != subject.get("generationAuditSha256")
    ):
        raise ValueError(f"{role} inner execution identity differs from its signed receipt")
    report_entry = inner.get("report")
    if not isinstance(report_entry, dict):
        raise ValueError(f"{role} inner execution lacks a report binding")
    report_path = Path(report_entry.get("path", ""))
    if not report_path.is_file() or sha256_file(report_path) != report_entry.get("sha256"):
        raise ValueError(f"{role} report is missing or hash-invalid")
    report = read_object(report_path, f"{role} report")
    if (
        report.get("sourceCommit") != inner.get("sourceCommit")
        or report.get("weightsSha256") != inner.get("checkpointSha256")
        or report.get("executionIdentity")
        != {
            "experiment": receipt["campaignId"],
            "replicate": inner["replicate"],
            "arm": inner["arm"],
            "configSha256": inner["configSha256"],
            "bindingSha256": inner["bindingSha256"],
            "root": inner["root"],
        }
    ):
        raise ValueError(f"{role} report identity changed")
    return receipt, inner, report


def build(
    *,
    protocol_path: Path,
    public_key_path: Path,
    primary_receipt_path: Path,
    replay_receipt_path: Path,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    if not public_key_path.is_absolute() or public_key_path.is_symlink():
        raise ValueError("P30 public key path must be absolute and non-symlink")
    primary_receipt_path = primary_receipt_path.resolve()
    replay_receipt_path = replay_receipt_path.resolve()
    primary, primary_inner, primary_report = load_attempt(
        primary_receipt_path, public_key_path, "primary"
    )
    replay, replay_inner, replay_report = load_attempt(
        replay_receipt_path, public_key_path, "replay"
    )
    if (
        replay.get("predecessor")
        != {"receiptPath": str(primary_receipt_path), "sha256": sha256_file(primary_receipt_path)}
        or primary["subject"] | {"role": "replay"} != replay["subject"]
        or primary_inner["socketPath"] == replay_inner["socketPath"]
        or primary_inner["socketInode"] == replay_inner["socketInode"]
    ):
        raise ValueError("replay attempt is not a distinct signed successor of primary")
    primary_games = primary_report.get("perGame")
    replay_games = replay_report.get("perGame")
    primary_replays = primary_report.get("replayHashes")
    replay_replays = replay_report.get("replayHashes")
    if not isinstance(primary_games, list) or not isinstance(primary_replays, list):
        raise ValueError("primary report lacks deterministic evidence")
    if primary_games != replay_games or primary_replays != replay_replays:
        raise ValueError("primary and replay deterministic evidence differs")
    if len(primary_games) != primary["subject"].get("games"):
        raise ValueError("pair does not contain the authorized game count")
    payload = {
        "schemaVersion": SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "diagnosticCodes": ["EXACT_PER_GAME_MATCH", "EXACT_REPLAY_HASH_MATCH"],
        "issuedAtUtc": utc_now(),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "root": primary["subject"]["root"],
        "replicate": primary["subject"]["replicate"],
        "arm": primary["subject"]["arm"],
        "checkpointSha256": primary["subject"]["checkpointSha256"],
        "primaryReceipt": {"path": str(primary_receipt_path), "sha256": sha256_file(primary_receipt_path)},
        "replayReceipt": {"path": str(replay_receipt_path), "sha256": sha256_file(replay_receipt_path)},
        "games": len(primary_games),
        "perGameSha256": sha256_bytes(canonical_json(primary_games)),
        "replayHashesSha256": sha256_bytes(canonical_json(primary_replays)),
        "malformedEpisodes": 0,
    }
    return payload


def main() -> None:
    raise SystemExit(
        "direct guardian CLI is disabled; use run_v35_p30_role.py through local custody"
    )


if __name__ == "__main__":
    main()
