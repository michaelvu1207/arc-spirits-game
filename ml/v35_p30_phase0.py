#!/usr/bin/env python3
"""Frozen, outcome-blind readiness contracts for the P30 campaign."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from v35_p30_crypto import (
    canonical_json,
    read_regular_nofollow,
    role_public_key_path,
    sha256_bytes,
    sha256_file,
    verify_signed_payload,
)


PHASE0_NAMES = (
    "fault-injection",
    "analyzer-rehearsal",
    "cuda-determinism",
)
PHASE0_REPORT_SCHEMAS = {
    "fault-injection": "arc-v35-p30-fault-injection-preflight-v1",
    "analyzer-rehearsal": "arc-v35-p30-analyzer-synthetic-rehearsal-v1",
    "cuda-determinism": "arc-v35-p30-cuda-determinism-preflight-v1",
}
PHASE0_READINESS_SCHEMA = "arc-v35-p30-phase0-readiness-v1"
REVIEW_RECEIPT_SCHEMA = "arc-v35-p30-gate-review-receipt-v1"
FULL_CAMPAIGN_AUTHORIZATION_SCHEMA = (
    "arc-v35-p30-full-campaign-authorization-v1"
)
GATE_REVIEW_REQUEST_SCHEMA = "arc-v35-p30-gate-review-request-v1"


def ledger_for(protocol: Mapping[str, Any]) -> Path:
    trust = protocol["executionTrust"]
    return Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]


def artifact_root(protocol: Mapping[str, Any]) -> Path:
    return Path(
        "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-artifacts"
    ) / str(protocol["executionTrust"]["campaignInstanceId"])


def phase0_output_root(protocol: Mapping[str, Any], name: str) -> Path:
    if name not in PHASE0_NAMES:
        raise ValueError("unknown P30 phase-zero preflight")
    return artifact_root(protocol) / "phase0" / name


def phase0_authorization_path(protocol: Mapping[str, Any], name: str) -> Path:
    if name not in PHASE0_NAMES:
        raise ValueError("unknown P30 phase-zero preflight")
    return ledger_for(protocol) / "authorizations" / f"phase0-{name}.json"


def phase0_readiness_path(protocol: Mapping[str, Any]) -> Path:
    return ledger_for(protocol) / "preflights" / "phase0-readiness.signed.json"


def gate_review_paths(
    protocol: Mapping[str, Any], mode: str
) -> dict[str, Path]:
    if mode not in {"phase0-runtime", "full-campaign"}:
        raise ValueError("unknown P30 gate-review mode")
    root = ledger_for(protocol) / "reviews" / mode
    return {
        "request": ledger_for(protocol)
        / "requests"
        / f"{mode}-fable-review.json",
        "attempt": root / "attempt.json",
        "stdout": root / "fable.stdout",
        "stderr": root / "fable.stderr",
        "receipt": root / "review-receipt.signed.json",
    }


def full_campaign_authorization_path(protocol: Mapping[str, Any]) -> Path:
    return (
        ledger_for(protocol)
        / "authorizations"
        / "full-campaign.signed.json"
    )


def _read_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(read_regular_nofollow(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def binding(path: Path) -> dict[str, str]:
    return {"path": str(path), "sha256": sha256_file(path)}


def gate_review_launcher_sha256() -> str:
    return sha256_file(
        Path(__file__).resolve().parent / "run_v35_p30_gate_review_local.py"
    )


def validate_gate_review_receipt(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    mode: str,
    required_inputs: list[dict[str, str]],
) -> dict[str, Any]:
    paths = gate_review_paths(protocol, mode)
    signed = _read_object(paths["receipt"], f"{mode} review receipt")
    receipt = verify_signed_payload(
        signed,
        expected_role="review-attester",
        public_key_path=role_public_key_path(
            protocol["executionTrust"], "review-attester"
        ),
    )
    expected_keys = {
        "schemaVersion",
        "valid",
        "immutable",
        "promotionEligible",
        "outcomesInspected",
        "mode",
        "model",
        "effort",
        "tools",
        "noSessionPersistence",
        "verdict",
        "protocol",
        "sourceContractSha256",
        "inputs",
        "request",
        "attempt",
        "launcherSha256",
        "claudeExecutable",
        "sandboxProfileSha256",
        "argv",
        "environmentKeys",
        "startedAtUtc",
        "finishedAtUtc",
        "exitCode",
        "stdout",
        "stderr",
        "signature",
    }
    pinned_claude = protocol["executionTrust"]["reviewRuntime"][
        "claudeExecutable"
    ]
    argv = receipt.get("argv")
    environment_keys = receipt.get("environmentKeys")
    allowed_environment_keys = {
        "ANTHROPIC_API_KEY",
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    }
    if (
        set(signed) != expected_keys
        or receipt.get("schemaVersion") != REVIEW_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("immutable") is not True
        or receipt.get("promotionEligible") is not False
        or receipt.get("outcomesInspected") is not False
        or receipt.get("mode") != mode
        or receipt.get("model") != "fable"
        or receipt.get("effort") != "high"
        or receipt.get("tools") != ["Read"]
        or receipt.get("noSessionPersistence") is not True
        or receipt.get("verdict") != "ACCEPT"
        or receipt.get("protocol")
        != {"path": str(protocol_path), "sha256": sha256_file(protocol_path)}
        or receipt.get("sourceContractSha256")
        != protocol["sourceContract"]["sha256"]
        or receipt.get("inputs") != required_inputs
        or receipt.get("request") != binding(paths["request"])
        or receipt.get("attempt") != binding(paths["attempt"])
        or receipt.get("launcherSha256") != gate_review_launcher_sha256()
        or receipt.get("claudeExecutable") != pinned_claude
        or not isinstance(argv, list)
        or len(argv) != 13
        or argv[0] != "/usr/bin/sandbox-exec"
        or argv[1] != "-f"
        or not isinstance(argv[2], str)
        or not Path(argv[2]).is_absolute()
        or argv[3] != pinned_claude["path"]
        or argv[4:12]
        != [
            "-p",
            "--model",
            "fable",
            "--effort",
            "high",
            "--tools",
            "Read",
            "--no-session-persistence",
        ]
        or not isinstance(argv[12], str)
        or not argv[12]
        or not isinstance(environment_keys, list)
        or environment_keys != sorted(set(environment_keys))
        or not set(environment_keys).issubset(allowed_environment_keys)
        or set(environment_keys)
        not in (
            allowed_environment_keys,
            allowed_environment_keys - {"ANTHROPIC_API_KEY"},
        )
        or receipt.get("exitCode") != 0
        or receipt.get("stdout") != binding(paths["stdout"])
        or receipt.get("stderr") != binding(paths["stderr"])
        or paths["stderr"].stat().st_size != 0
    ):
        raise ValueError(f"{mode} Fable review receipt is invalid")
    lines = [
        line.strip()
        for line in read_regular_nofollow(paths["stdout"])
        .decode("utf-8")
        .splitlines()
        if line.strip()
    ]
    if not lines or lines[-1] != "VERDICT: ACCEPT":
        raise ValueError(f"{mode} Fable review did not accept exactly")
    return receipt


def outcome_blind_inputs_hash(inputs: list[dict[str, str]]) -> str:
    return sha256_bytes(canonical_json(inputs))
