#!/usr/bin/env python3
"""Outcome-blind verifier for the four-job V35 runtime parity preflight.

The verifier reads sealed evaluator reports but emits only provenance, coverage,
stall/lifecycle counts, trace roots, mismatch counts, and a sanitized result.
No gameplay outcome or latency field is copied into its output or errors.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA = "arc-v35-runtime-parity-result-v1"
AUTH_SCHEMA = "arc-v35-runtime-parity-authorization-v1"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SERVING_PREFIX = "[infer] serving "
SHUTDOWN_LINE = "[infer] shut down"
ERROR_PATTERN = re.compile(r"Traceback|reload FAILED|RuntimeError|Exception|CUDA error:|\bError:")


class ContractError(Exception):
    """A sanitized fail-closed contract error."""

    def __init__(self, code: str):
        if not re.fullmatch(r"[a-z0-9-]+", code):
            code = "internal-contract-error"
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise ContractError(code)


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def read_json(path: Path, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except Exception:
        fail(code)
    if not isinstance(value, dict):
        fail(code)
    return value


def require(condition: bool, code: str) -> None:
    if not condition:
        fail(code)


@dataclass(frozen=True)
class JobEvidence:
    name: str
    seed0: int
    games: int
    stalls: int
    traces: dict[int, str]
    trace_root: str
    provenance_sha256: str
    lifecycle: dict[str, int]


def expected_decode(auth: dict[str, Any]) -> dict[str, Any]:
    candidate = auth["candidate"]
    return {
        "policyObsVersion": 2,
        "learnMonsterRewardChoices": False,
        "sample": False,
        "search": candidate["search"],
    }


def verify_decode(actual: Any, expected: dict[str, Any]) -> None:
    require(isinstance(actual, dict), "decode-contract")
    for key in ("policyObsVersion", "learnMonsterRewardChoices", "sample", "search"):
        require(actual.get(key) == expected[key], "decode-contract")
    require("rerank" not in actual, "decode-contract")
    require(isinstance(actual.get("inferenceSocket"), str), "decode-contract")


def read_exit(path: Path, code: str) -> None:
    try:
        value = path.read_text().strip()
    except Exception:
        fail(code)
    require(value == "0", code)


def lifecycle(path: Path) -> dict[str, int]:
    try:
        lines = path.read_text(errors="replace").splitlines()
    except Exception:
        fail("inference-log-missing")
    counts = {
        "servingLines": sum(line.startswith(SERVING_PREFIX) for line in lines),
        "shutdownLines": sum(line == SHUTDOWN_LINE for line in lines),
        "reloadLines": sum("[infer] reloaded weights" in line for line in lines),
        "errorLines": sum(bool(ERROR_PATTERN.search(line)) for line in lines),
    }
    require(counts == {"servingLines": 1, "shutdownLines": 1, "reloadLines": 0, "errorLines": 0},
            "inference-lifecycle")
    return counts


def load_job(root: Path, name: str, contract: dict[str, Any], auth: dict[str, Any]) -> JobEvidence:
    job = root / name
    read_exit(job / "evaluator.exit", "evaluator-exit")
    read_exit(job / "infer.exit", "inference-exit")
    report = read_json(job / "report.json", "report-json")

    require(report.get("schemaVersion") == "solo-heldout-v2", "report-schema")
    require(report.get("sourceCommit") == contract["sourceCommit"], "source-provenance")
    require(report.get("weightsSha256") == auth["checkpointSha256"], "checkpoint-provenance")
    require(report.get("catalogSha256") == auth["catalogSha256"], "catalog-provenance")
    require(report.get("seed0") == contract["seed0"], "seed-contract")
    require(report.get("games") == contract["games"], "seed-contract")
    require(report.get("maxRounds") == 30, "round-contract")
    require(report.get("maxStatusLevel") == 2, "status-contract")
    require(isinstance(report.get("stalls"), int) and report["stalls"] >= 0, "stall-contract")
    verify_decode(report.get("decode"), expected_decode(auth))

    inference = report.get("inference")
    require(isinstance(inference, dict), "inference-provenance")
    require(inference.get("format") == "arc-entity-scorer-v2", "inference-provenance")
    require(inference.get("weightsSha256") == auth["checkpointSha256"], "inference-provenance")
    require(inference.get("wire") == "binary", "inference-provenance")

    rows = report.get("replayHashes")
    require(isinstance(rows, list) and len(rows) == contract["games"], "trace-coverage")
    traces: dict[int, str] = {}
    for row in rows:
        require(isinstance(row, dict) and set(row) == {"seed", "replayTraceSha256"}, "trace-row")
        seed = row.get("seed")
        digest = row.get("replayTraceSha256")
        require(isinstance(seed, int) and isinstance(digest, str) and HEX64.fullmatch(digest) is not None,
                "trace-row")
        require(seed not in traces, "trace-duplicate-seed")
        traces[seed] = digest
    expected_seeds = set(range(contract["seed0"], contract["seed0"] + contract["games"]))
    require(set(traces) == expected_seeds, "trace-seed-coverage")

    ordered = [{"seed": seed, "replayTraceSha256": traces[seed]} for seed in sorted(traces)]
    provenance = {
        "sourceCommit": report["sourceCommit"],
        "weightsSha256": report["weightsSha256"],
        "catalogSha256": report["catalogSha256"],
        "seed0": report["seed0"],
        "games": report["games"],
        "maxRounds": report["maxRounds"],
        "maxStatusLevel": report["maxStatusLevel"],
        "decode": {key: report["decode"][key] for key in
                   ("policyObsVersion", "learnMonsterRewardChoices", "sample", "search")},
        "inference": {key: inference.get(key) for key in
                      ("format", "obsDim", "actDim", "weightsSha256", "wire")},
    }
    return JobEvidence(
        name=name,
        seed0=contract["seed0"],
        games=contract["games"],
        stalls=report["stalls"],
        traces=traces,
        trace_root=canonical_sha256(ordered),
        provenance_sha256=canonical_sha256(provenance),
        lifecycle=lifecycle(job / "infer.stderr"),
    )


def mismatch_count(left: JobEvidence, right: JobEvidence, seeds: range) -> int:
    return sum(left.traces.get(seed) != right.traces.get(seed) for seed in seeds)


def verify(auth_path: Path, jobs_root: Path) -> dict[str, Any]:
    auth = read_json(auth_path, "authorization-json")
    require(auth.get("schemaVersion") == AUTH_SCHEMA, "authorization-schema")
    contracts = auth.get("jobs")
    expected_names = {
        "legacy-functional", "optimized-functional", "optimized-operational", "legacy-operational"
    }
    require(isinstance(contracts, dict) and set(contracts) == expected_names, "authorization-jobs")

    jobs = {name: load_job(jobs_root, name, contracts[name], auth) for name in sorted(expected_names)}
    seed0 = auth["seedContract"]["seed0"]
    functional_games = auth["seedContract"]["functionalGames"]
    operational_games = auth["seedContract"]["operationalGames"]
    require(seed0 == 969060000 and functional_games == 8 and operational_games == 64,
            "authorization-seeds")
    functional = range(seed0, seed0 + functional_games)
    operational = range(seed0, seed0 + operational_games)

    comparisons = {
        "crossRuntimeFunctional": mismatch_count(
            jobs["legacy-functional"], jobs["optimized-functional"], functional
        ),
        "crossRuntimeOperational": mismatch_count(
            jobs["legacy-operational"], jobs["optimized-operational"], operational
        ),
        "legacyBatchingControl": mismatch_count(
            jobs["legacy-functional"], jobs["legacy-operational"], functional
        ),
        "optimizedBatchingControl": mismatch_count(
            jobs["optimized-functional"], jobs["optimized-operational"], functional
        ),
    }
    total_stalls = sum(job.stalls for job in jobs.values())
    batching_invalid = comparisons["legacyBatchingControl"] or comparisons["optimizedBatchingControl"]
    runtime_mismatch = comparisons["crossRuntimeFunctional"] or comparisons["crossRuntimeOperational"]
    classification = (
        "batching-control-invalid" if batching_invalid else
        "runtime-trace-mismatch" if runtime_mismatch else
        "stall" if total_stalls else
        "pass"
    )
    passed = classification == "pass"
    result = {
        "schemaVersion": SCHEMA,
        "passed": passed,
        "classification": classification,
        "outcomeFieldsEmitted": False,
        "privateOutcomesRead": False,
        "strengthComparisonPerformed": False,
        "jobs": {
            name: {
                "seed0": job.seed0,
                "games": job.games,
                "coverage": len(job.traces),
                "stalls": job.stalls,
                "traceRootSha256": job.trace_root,
                "provenanceSha256": job.provenance_sha256,
                "lifecycle": job.lifecycle,
            }
            for name, job in sorted(jobs.items())
        },
        "comparisons": comparisons,
        "totalStalls": total_stalls,
        "latencyPrecheckAuthorized": passed,
        "strengthConfirmationAuthorized": False,
        "privateConfirmationAuthorized": False,
        "promotionEligible": False,
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--jobs-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit(2)
    try:
        result = verify(args.authorization, args.jobs_root)
    except ContractError as error:
        result = {
            "schemaVersion": SCHEMA,
            "passed": False,
            "classification": error.code,
            "outcomeFieldsEmitted": False,
            "privateOutcomesRead": False,
            "strengthComparisonPerformed": False,
            "latencyPrecheckAuthorized": False,
            "strengthConfirmationAuthorized": False,
            "privateConfirmationAuthorized": False,
            "promotionEligible": False,
        }
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
