#!/usr/bin/env python3
"""Trusted V35 evaluator and private-query broker.

Candidate configuration is data, not executable code. The trusted backend owns command
construction, seeds, game execution, report validation, scoring, cost accounting, and signing.
The current Node backend is explicitly a Phase-0 solo measurement backend: its reports can guide
development, but they remain promotion-ineligible until the complete replay and task-mix gates exist.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from .core import (
    ArtifactSigner,
    Budget,
    Candidate,
    DIAGNOSTIC_CODES,
    canonical_sha256,
    exact_keys,
    file_record,
    finite_number,
    mean_lcb,
)

EVALUATION_SCHEMA = "arc-v35-evaluation-v1"
FEEDBACK_SCHEMA = "arc-v35-feedback-v1"


@dataclass(frozen=True)
class EvaluationRequest:
    candidate: Candidate
    tier: str
    campaign: str
    games: int
    seed0: int
    seed_commitment: str

    def __post_init__(self) -> None:
        if self.tier not in {"public", "private", "confirmation", "final"}:
            raise ValueError("invalid evaluation tier")
        if not self.campaign or self.games < 1 or self.seed0 < 1:
            raise ValueError("invalid evaluation request")


@dataclass(frozen=True)
class BackendRun:
    report: Mapping[str, Any]
    stdout_sha256: str
    stderr_sha256: str
    wall_seconds: float
    cpu_seconds: float
    gpu_seconds: float
    backend: str


class Backend(Protocol):
    def run(self, request: EvaluationRequest) -> BackendRun: ...


@dataclass(frozen=True)
class GateThresholds:
    min_true_win_rate: float = 0.0
    min_reach15_rate: float = 0.0
    max_stall_rate: float = 0.0
    max_game_wall_ms_p95: float = 60_000.0
    max_complexity_units: float = 40.0
    require_complete_task_mix: bool = True


@dataclass(frozen=True)
class ScoreWeights:
    """Immutable evaluator-owned scalar weights; candidates cannot change these."""

    terminal: float = 0.60
    vp_growth: float = 0.25
    engine_growth: float = 0.15

    def __post_init__(self) -> None:
        values = (self.terminal, self.vp_growth, self.engine_growth)
        if any(not math.isfinite(value) or value < 0 or value > 1 for value in values):
            raise ValueError("score weights must be finite values in [0,1]")
        if abs(sum(values) - 1) > 1e-9 or self.terminal < 0.5:
            raise ValueError("score weights must sum to one and remain terminal-dominant")


@dataclass(frozen=True)
class EvaluationResult:
    candidate_id: str
    tier: str
    arc_fitness: float
    accepted: bool
    diagnostic_codes: tuple[str, ...]
    endpoints: Mapping[str, float]
    signed_entry: Mapping[str, Any]
    selection_values: tuple[float, ...]

    def feedback(self, *, reveal_scalar: bool) -> dict[str, Any]:
        feedback: dict[str, Any] = {
            "schemaVersion": FEEDBACK_SCHEMA,
            "accepted": self.accepted,
            "diagnosticCodes": list(self.diagnostic_codes),
        }
        if reveal_scalar:
            feedback["arc_fitness"] = self.arc_fitness
        return feedback


def _finite(value: Any, label: str) -> float:
    return finite_number(value, label, -1e12, 1e12)


def validate_solo_report(report: Mapping[str, Any], request: EvaluationRequest) -> list[dict[str, Any]]:
    if not isinstance(report, dict) or report.get("schemaVersion") != "solo-heldout-v2":
        raise ValueError("unexpected solo report schema")
    if report.get("seed0") != request.seed0 or report.get("games") != request.games:
        raise ValueError("solo report seed/game identity mismatch")
    rows = report.get("perGame")
    if not isinstance(rows, list) or len(rows) != request.games:
        raise ValueError("solo report must contain exactly one trusted per-game row per seed")
    expected_seeds = list(range(request.seed0, request.seed0 + request.games))
    if sorted(row.get("seed") for row in rows if isinstance(row, dict)) != expected_seeds:
        raise ValueError("solo report seed coverage is not exact")
    checked: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("solo report contains a non-object row")
        for field in (
            "seed",
            "guardian",
            "trueWin",
            "stalled",
            "finalVP",
            "first30Round",
            "post15VpPerRound",
            "finalAttackDice",
            "finalSpirits",
            "finalMaxBarrier",
            "cycle",
        ):
            if field not in row:
                raise ValueError(f"solo row is missing {field}")
        if not isinstance(row["trueWin"], bool) or not isinstance(row["stalled"], bool):
            raise ValueError("solo row booleans are invalid")
        if row["trueWin"] != (_finite(row["finalVP"], "finalVP") >= 30 and not row["stalled"]):
            raise ValueError("solo row trueWin is not derivable from trusted endpoints")
        for field in ("post15VpPerRound", "finalAttackDice", "finalSpirits", "finalMaxBarrier"):
            _finite(row[field], field)
        checked.append(dict(row))
    return checked


def late_game_score(
    weights: ScoreWeights, rows: Sequence[Mapping[str, Any]]
) -> tuple[float, dict[str, float], tuple[float, ...]]:
    scores: list[float] = []
    for row in rows:
        terminal = 1.0 if row["trueWin"] else 0.0
        vp_growth = min(max(float(row["post15VpPerRound"]) / 3.0, 0.0), 1.0)
        engine_growth = min(
            max(
                (
                    float(row["finalAttackDice"]) / 8.0
                    + float(row["finalSpirits"]) / 8.0
                    + float(row["finalMaxBarrier"]) / 8.0
                )
                / 3.0,
                0.0,
            ),
            1.0,
        )
        scores.append(
            weights.terminal * terminal
            + weights.vp_growth * vp_growth
            + weights.engine_growth * engine_growth
        )
    endpoints = {
        "trueWinRate": sum(bool(row["trueWin"]) for row in rows) / len(rows),
        "stallRate": sum(bool(row["stalled"]) for row in rows) / len(rows),
        "meanFinalVP": sum(float(row["finalVP"]) for row in rows) / len(rows),
        "meanPost15VpPerRound": sum(float(row["post15VpPerRound"]) for row in rows) / len(rows),
        "meanLateGameScore": sum(scores) / len(scores),
    }
    return mean_lcb(scores), endpoints, tuple(scores)


class TrustedEvaluator:
    def __init__(
        self,
        *,
        backend: Backend,
        signer: ArtifactSigner,
        budget: Budget,
        immutable_manifest: Mapping[str, Any],
        thresholds: GateThresholds | None = None,
        score_weights: ScoreWeights | None = None,
    ):
        self.backend = backend
        self.signer = signer
        self.budget = budget
        self.immutable_manifest = dict(immutable_manifest)
        self.immutable_manifest_hash = canonical_sha256(self.immutable_manifest)
        self.thresholds = thresholds or GateThresholds()
        self.score_weights = score_weights or ScoreWeights()
        self.previous_entry_hash = "0" * 64

    def evaluate(self, request: EvaluationRequest) -> EvaluationResult:
        run = self.backend.run(request)
        rows = validate_solo_report(run.report, request)
        arc_fitness, endpoints, selection_values = late_game_score(self.score_weights, rows)
        performance = run.report.get("performance")
        if not isinstance(performance, dict):
            raise ValueError("solo report performance is missing")
        game_p95 = _finite(performance.get("gameWallMsP95"), "gameWallMsP95")
        reach15 = _finite(run.report.get("reach15Rate"), "reach15Rate")
        endpoints = {**endpoints, "reach15Rate": reach15, "gameWallMsP95": game_p95}
        codes: list[str] = []
        if endpoints["stallRate"] > self.thresholds.max_stall_rate:
            codes.append("stall_gate_failed")
        if endpoints["trueWinRate"] < self.thresholds.min_true_win_rate:
            codes.append("solo_gate_failed")
        if reach15 < self.thresholds.min_reach15_rate:
            codes.append("early_game_regression")
        if game_p95 > self.thresholds.max_game_wall_ms_p95:
            codes.append("latency_over_budget")
        if request.candidate.complexity_units > self.thresholds.max_complexity_units:
            codes.append("complexity_over_budget")
        if self.thresholds.require_complete_task_mix:
            codes.append("incomplete_task_mix")
        codes = sorted(set(codes)) or ["ok"]
        if any(code not in DIAGNOSTIC_CODES for code in codes):
            raise RuntimeError("evaluator generated a non-whitelisted diagnostic")
        self.budget.charge(
            games=request.games,
            cpu_seconds=run.cpu_seconds,
            gpu_seconds=run.gpu_seconds,
            wall_seconds=run.wall_seconds,
            private=request.tier == "private",
        )
        payload = {
            "schemaVersion": EVALUATION_SCHEMA,
            "candidateId": request.candidate.candidate_id,
            "tier": request.tier,
            "campaign": request.campaign,
            "seedCommitment": request.seed_commitment,
            "games": request.games,
            "arcFitness": arc_fitness,
            "accepted": codes == ["ok"],
            "diagnosticCodes": codes,
            "endpoints": endpoints,
            "candidateSha256": canonical_sha256(request.candidate.to_json()),
            "rawReportSha256": canonical_sha256(run.report),
            "selectionValuesSha256": canonical_sha256(selection_values),
            "stdoutSha256": run.stdout_sha256,
            "stderrSha256": run.stderr_sha256,
            "backend": run.backend,
            "immutableManifestSha256": self.immutable_manifest_hash,
            "cost": self.budget.snapshot(),
        }
        entry = self.signer.sign(payload, self.previous_entry_hash)
        self.previous_entry_hash = str(entry["entrySha256"])
        return EvaluationResult(
            candidate_id=request.candidate.candidate_id,
            tier=request.tier,
            arc_fitness=arc_fitness,
            accepted=codes == ["ok"],
            diagnostic_codes=tuple(codes),
            endpoints=endpoints,
            signed_entry=entry,
            selection_values=selection_values,
        )


class PrivateBroker:
    """Cap private queries and expose no scalar to an untrusted caller."""

    def __init__(self, evaluator: TrustedEvaluator, max_queries: int = 10):
        if max_queries < 1 or max_queries > 10:
            raise ValueError("the immutable pilot private-query cap is 1..10")
        self.evaluator = evaluator
        self.max_queries = max_queries
        self.queries = 0

    def query(self, request: EvaluationRequest) -> tuple[EvaluationResult, dict[str, Any]]:
        if request.tier != "private":
            raise ValueError("private broker accepts private requests only")
        if self.queries >= self.max_queries:
            raise RuntimeError("private_query_cap_reached")
        self.queries += 1
        result = self.evaluator.evaluate(request)
        return result, result.feedback(reveal_scalar=False)


class NodeSoloBackend:
    def __init__(
        self,
        *,
        repo_root: Path,
        weights: Path,
        workers: int = 8,
        timeout_seconds: float = 1800,
        node: str = "node",
        max_status_level: int = 3,
    ):
        self.repo_root = repo_root.resolve(strict=True)
        self.weights = weights.resolve(strict=True)
        self.workers = workers
        self.timeout_seconds = timeout_seconds
        self.node = node
        self.max_status_level = max_status_level
        self.script = self.repo_root / "scripts" / "evaluate-solo-checkpoint.mjs"
        if workers < 1 or timeout_seconds <= 0 or max_status_level not in {0, 1, 2, 3}:
            raise ValueError("invalid Node backend resource limits")
        file_record(self.script)
        file_record(self.weights)

    def run(self, request: EvaluationRequest) -> BackendRun:
        usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="arc-v35-solo-") as temp_dir:
            output = Path(temp_dir) / "report.json"
            command = [
                self.node,
                str(self.script),
                "--weights",
                str(self.weights),
                "--games",
                str(request.games),
                "--workers",
                str(self.workers),
                "--seed0",
                str(request.seed0),
                "--max-rounds",
                "30",
                "--max-status-level",
                str(self.max_status_level),
                "--include-games",
                "--out",
                str(output),
                *request.candidate.evaluator_args(),
            ]
            environment = {
                "HOME": os.environ.get("HOME", ""),
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "NODE_OPTIONS": "--no-warnings",
            }
            completed = subprocess.run(
                command,
                cwd=self.repo_root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout_seconds,
                check=False,
            )
            wall_seconds = time.monotonic() - started
            if completed.returncode != 0:
                raise RuntimeError(
                    f"trusted solo evaluator failed with exit {completed.returncode}; "
                    f"stdout/stderr retained only as hashes"
                )
            if not output.is_file():
                raise RuntimeError("trusted solo evaluator did not write its report")
            report = json.loads(output.read_text())
        usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_seconds = (usage_after.ru_utime - usage_before.ru_utime) + (
            usage_after.ru_stime - usage_before.ru_stime
        )
        return BackendRun(
            report=report,
            stdout_sha256=hashlib.sha256(completed.stdout).hexdigest(),
            stderr_sha256=hashlib.sha256(completed.stderr).hexdigest(),
            wall_seconds=wall_seconds,
            cpu_seconds=cpu_seconds,
            gpu_seconds=0.0,
            backend="trusted-node-solo-v1",
        )


class SyntheticBackend:
    """Deterministic, non-claim synthetic landscape for controller/security tests."""

    def run(self, request: EvaluationRequest) -> BackendRun:
        started = time.monotonic()
        candidate = request.candidate
        planner_bonus = {"none": 0.0, "rerank": 0.07, "search": 0.11}[candidate.planner_mode]
        target_distance = abs(candidate.temperature - 0.72) * 0.35
        width_penalty = max(candidate.search_sims - 8, 0) * 0.004
        strategic = 0.28 + planner_bonus - target_distance - width_penalty
        strategic += 0.08 * candidate.snapshot_share + 0.03 * candidate.engine_loss_weight
        rows: list[dict[str, Any]] = []
        for seed in range(request.seed0, request.seed0 + request.games):
            noise_digest = hashlib.sha256(
                f"arc-v35-synthetic-common-random-number|{seed}".encode()
            ).digest()
            noise = (int.from_bytes(noise_digest[:8], "big") / 2**64 - 0.5) * 0.24
            strength = strategic + noise
            true_win = strength >= 0.30
            final_vp = 30 + 8 * (strength - 0.30) if true_win else 22 + 20 * strength
            post15 = max(0.0, 0.7 + 2.1 * strength)
            attack = max(0.0, 3.5 + 5 * strength)
            spirits = max(0.0, 3.0 + 6 * strength)
            barrier = max(0.0, 1.5 + 4 * strength)
            rows.append(
                {
                    "seed": seed,
                    "guardian": f"synthetic-{seed % 8}",
                    "trueWin": true_win,
                    "stalled": False,
                    "finalVP": final_vp,
                    "first30Round": 27 if true_win else None,
                    "post15VpPerRound": post15,
                    "finalAttackDice": attack,
                    "finalSpirits": spirits,
                    "finalMaxBarrier": barrier,
                    "cycle": {},
                }
            )
        sorted_wall = 1.0 + candidate.complexity_units * 0.2
        report = {
            "schemaVersion": "solo-heldout-v2",
            "seed0": request.seed0,
            "games": request.games,
            "reach15Rate": 1.0,
            "performance": {"gameWallMsP95": sorted_wall},
            "perGame": rows,
        }
        wall = time.monotonic() - started
        report_hash = canonical_sha256(report)
        return BackendRun(
            report=report,
            stdout_sha256=report_hash,
            stderr_sha256=hashlib.sha256(b"").hexdigest(),
            wall_seconds=wall,
            cpu_seconds=wall,
            gpu_seconds=0.0,
            backend="synthetic-controller-test-v1",
        )


def immutable_manifest(repo_root: Path, weights: Path) -> dict[str, Any]:
    root = repo_root.resolve(strict=True)
    records = [
        file_record(root / "scripts" / "evaluate-solo-checkpoint.mjs"),
        file_record(root / "ml" / "autoresearch" / "v35" / "core.py"),
        file_record(root / "ml" / "autoresearch" / "v35" / "evaluator.py"),
        file_record(weights),
    ]
    return {"schemaVersion": "arc-v35-immutable-manifest-v1", "files": records}
