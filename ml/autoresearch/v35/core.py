#!/usr/bin/env python3
"""Immutable primitives for the private/local V35 autoresearch controller.

This module intentionally uses only the Python standard library. Candidate code is never
imported here. Private seeds are derived in memory from a sealed key, reports are chained
with HMAC-SHA256, and every mutable candidate field has an exact schema and hard range.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import random
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path
from statistics import NormalDist, mean
from typing import Any, Iterable, Mapping, Sequence

CANDIDATE_SCHEMA = "arc-v35-candidate-v1"
SIGNED_LEDGER_SCHEMA = "arc-v35-signed-ledger-entry-v1"
SEED_COMMITMENT_SCHEMA = "arc-v35-seed-commitment-v1"

DIAGNOSTIC_CODES = frozenset(
    {
        "ok",
        "candidate_schema_invalid",
        "candidate_timeout",
        "candidate_sandbox_failed",
        "candidate_network_attempt",
        "candidate_private_access_attempt",
        "candidate_stdout_suppressed",
        "immutable_manifest_changed",
        "replay_invalid",
        "illegal_action",
        "nondeterministic",
        "stall_gate_failed",
        "solo_gate_failed",
        "early_game_regression",
        "late_game_regression",
        "multiplayer_gate_failed",
        "fairness_gate_failed",
        "exploitability_gate_failed",
        "latency_over_budget",
        "memory_over_budget",
        "complexity_over_budget",
        "budget_exhausted",
        "private_query_cap_reached",
        "private_result_sealed",
        "final_tier_closed",
        "evaluator_tamper",
        "signature_invalid",
        "incomplete_task_mix",
    }
)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    st = resolved.lstat()
    if not stat.S_ISREG(st.st_mode) or resolved.is_symlink():
        raise ValueError(f"not a regular non-symlink file: {resolved}")
    payload = resolved.read_bytes()
    return {"path": str(resolved), "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}


def exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} keys must be exactly {sorted(expected)}")


def finite_number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be finite")
    result = float(value)
    if result < minimum or result > maximum:
        raise ValueError(f"{label} must be in [{minimum}, {maximum}]")
    return result


def integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


@dataclass(frozen=True)
class Candidate:
    planner_mode: str
    sample: bool
    temperature: float
    rerank_policy_weight: float | None
    search_sims: int
    search_horizon: int
    search_fraction: float
    search_value_weight: float
    search_rollout: str
    search_nav_temperature: float
    solo_share: float
    snapshot_share: float
    multiplayer_share: float
    terminal_loss_weight: float
    engine_loss_weight: float
    reach30_loss_weight: float
    entropy_weight: float

    def to_json(self) -> dict[str, Any]:
        return {
            "schemaVersion": CANDIDATE_SCHEMA,
            "policy": {"sample": self.sample, "temperature": self.temperature},
            "planner": {
                "mode": self.planner_mode,
                "rerankPolicyWeight": self.rerank_policy_weight,
                "searchSims": self.search_sims,
                "searchHorizonRounds": self.search_horizon,
                "searchFraction": self.search_fraction,
                "searchValueWeight": self.search_value_weight,
                "searchRollout": self.search_rollout,
                "searchNavTemperature": self.search_nav_temperature,
            },
            "curriculum": {
                "soloShare": self.solo_share,
                "lateSnapshotShare": self.snapshot_share,
                "multiplayerShare": self.multiplayer_share,
            },
            "loss": {
                "terminalWeight": self.terminal_loss_weight,
                "engineWeight": self.engine_loss_weight,
                "reach30Weight": self.reach30_loss_weight,
                "entropyWeight": self.entropy_weight,
            },
        }

    @property
    def candidate_id(self) -> str:
        return canonical_sha256(self.to_json())[:16]

    @property
    def complexity_units(self) -> float:
        planner_cost = 2 if self.planner_mode == "search" else 1 if self.planner_mode == "rerank" else 0
        return float(self.search_sims) + self.search_horizon / 4 + planner_cost

    def evaluator_args(self) -> list[str]:
        args = ["--temperature", format(self.temperature, ".8g")]
        if self.sample:
            args.append("--sample")
        if self.planner_mode == "rerank":
            args += ["--rerank-policy-weight", format(self.rerank_policy_weight or 0, ".8g")]
        elif self.planner_mode == "search":
            args += [
                "--search-sims",
                str(self.search_sims),
                "--search-objective", "solo-reach30",
                "--search-horizon", str(self.search_horizon),
                "--search-frac", format(self.search_fraction, ".8g"),
                "--search-value-weight", format(self.search_value_weight, ".8g"),
                "--search-rollout", self.search_rollout,
                "--search-nav-temperature", format(self.search_nav_temperature, ".8g"),
            ]
        return args


DEFAULT_CANDIDATE = {
    "schemaVersion": CANDIDATE_SCHEMA,
    "policy": {"sample": False, "temperature": 0.65},
    "planner": {
        "mode": "none",
        "rerankPolicyWeight": None,
        "searchSims": 0,
        "searchHorizonRounds": 2,
        "searchFraction": 1.0,
        "searchValueWeight": 0.5,
        "searchRollout": "heuristic",
        "searchNavTemperature": 0.0,
    },
    "curriculum": {"soloShare": 0.5, "lateSnapshotShare": 0.35, "multiplayerShare": 0.15},
    "loss": {"terminalWeight": 1.0, "engineWeight": 0.3, "reach30Weight": 0.5, "entropyWeight": 0.01},
}


def validate_candidate(value: Mapping[str, Any]) -> Candidate:
    exact_keys(value, {"schemaVersion", "policy", "planner", "curriculum", "loss"}, "candidate")
    if value["schemaVersion"] != CANDIDATE_SCHEMA:
        raise ValueError("candidate schemaVersion changed")
    policy = value["policy"]
    planner = value["planner"]
    curriculum = value["curriculum"]
    loss = value["loss"]
    exact_keys(policy, {"sample", "temperature"}, "candidate.policy")
    exact_keys(
        planner,
        {
            "mode",
            "rerankPolicyWeight",
            "searchSims",
            "searchHorizonRounds",
            "searchFraction",
            "searchValueWeight",
            "searchRollout",
            "searchNavTemperature",
        },
        "candidate.planner",
    )
    exact_keys(curriculum, {"soloShare", "lateSnapshotShare", "multiplayerShare"}, "candidate.curriculum")
    exact_keys(loss, {"terminalWeight", "engineWeight", "reach30Weight", "entropyWeight"}, "candidate.loss")
    if not isinstance(policy["sample"], bool):
        raise ValueError("candidate.policy.sample must be boolean")
    mode = planner["mode"]
    if mode not in {"none", "rerank", "search"}:
        raise ValueError("candidate.planner.mode is invalid")
    rollout = planner["searchRollout"]
    if rollout not in {"policy", "heuristic"}:
        raise ValueError("candidate.planner.searchRollout is invalid")
    rerank = planner["rerankPolicyWeight"]
    if rerank is not None:
        rerank = finite_number(rerank, "rerankPolicyWeight", 0, 1)
    sims = integer(planner["searchSims"], "searchSims", 0, 32)
    if mode == "none" and (rerank is not None or sims != 0):
        raise ValueError("none planner requires null rerank and zero sims")
    if mode == "rerank" and (rerank is None or sims != 0):
        raise ValueError("rerank planner requires weight and zero sims")
    if mode == "search" and (rerank is not None or sims not in {2, 4, 8, 16, 32}):
        raise ValueError("search planner requires an allowed positive sim count and null rerank")
    curriculum_values = [
        finite_number(curriculum[k], f"curriculum.{k}", 0, 1)
        for k in ("soloShare", "lateSnapshotShare", "multiplayerShare")
    ]
    if abs(sum(curriculum_values) - 1) > 1e-9 or curriculum_values[1] < 0.25:
        raise ValueError("curriculum shares must sum to 1 with lateSnapshotShare >= 0.25")
    return Candidate(
        planner_mode=mode,
        sample=policy["sample"],
        temperature=finite_number(policy["temperature"], "temperature", 0.05, 2.0),
        rerank_policy_weight=rerank,
        search_sims=sims,
        search_horizon=integer(planner["searchHorizonRounds"], "searchHorizonRounds", 1, 8),
        search_fraction=finite_number(planner["searchFraction"], "searchFraction", 0.1, 1.0),
        search_value_weight=finite_number(planner["searchValueWeight"], "searchValueWeight", 0, 2),
        search_rollout=rollout,
        search_nav_temperature=finite_number(planner["searchNavTemperature"], "searchNavTemperature", 0, 2),
        solo_share=curriculum_values[0],
        snapshot_share=curriculum_values[1],
        multiplayer_share=curriculum_values[2],
        terminal_loss_weight=finite_number(loss["terminalWeight"], "loss.terminalWeight", 0, 4),
        engine_loss_weight=finite_number(loss["engineWeight"], "loss.engineWeight", 0, 4),
        reach30_loss_weight=finite_number(loss["reach30Weight"], "loss.reach30Weight", 0, 4),
        entropy_weight=finite_number(loss["entropyWeight"], "loss.entropyWeight", 0, 0.5),
    )


class SeedVault:
    """Derive undisclosed contiguous seed families without persisting raw private seeds."""

    def __init__(self, key: bytes):
        if len(key) < 32:
            raise ValueError("seed key must contain at least 32 bytes")
        self._key = bytes(key)

    @classmethod
    def open_or_create(cls, path: Path) -> "SeedVault":
        path = path.expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.exists():
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, secrets.token_bytes(32))
                os.fsync(fd)
            finally:
                os.close(fd)
        st = path.stat()
        if stat.S_IMODE(st.st_mode) != 0o600 or st.st_uid != os.getuid():
            raise PermissionError("seed vault must be user-owned mode 0600")
        return cls(path.read_bytes())

    def family(self, tier: str, campaign: str, games: int) -> dict[str, Any]:
        if tier not in {"private", "confirmation", "final"} or not campaign or games < 1 or games > 100_000:
            raise ValueError("invalid seed-family request")
        label = f"arc-v35|{tier}|{campaign}|{games}".encode()
        digest = hmac.new(self._key, label, hashlib.sha256).digest()
        # Keep the entire contiguous family inside the reserved V35 band.
        available_starts = 20_000_000 - games + 1
        seed0 = 970_000_000 + int.from_bytes(digest[:8], "big") % available_starts
        commitment = hmac.new(self._key, b"commit|" + label, hashlib.sha256).hexdigest()
        return {
            "schemaVersion": SEED_COMMITMENT_SCHEMA,
            "tier": tier,
            "campaign": campaign,
            "games": games,
            "seed0": seed0,
            "commitment": commitment,
        }


class ArtifactSigner:
    def __init__(self, key: bytes):
        if len(key) < 32:
            raise ValueError("signing key must contain at least 32 bytes")
        self._key = bytes(key)

    @classmethod
    def open_or_create(cls, path: Path) -> "ArtifactSigner":
        vault = SeedVault.open_or_create(path)
        return cls(vault._key)

    def sign(self, payload: Mapping[str, Any], previous_hash: str = "0" * 64) -> dict[str, Any]:
        if len(previous_hash) != 64:
            raise ValueError("previous ledger hash is invalid")
        body = {
            "schemaVersion": SIGNED_LEDGER_SCHEMA,
            "previousEntrySha256": previous_hash,
            "payload": dict(payload),
        }
        entry_hash = canonical_sha256(body)
        signature = hmac.new(self._key, entry_hash.encode(), hashlib.sha256).hexdigest()
        return {**body, "entrySha256": entry_hash, "signature": signature}

    def verify(self, entry: Mapping[str, Any]) -> bool:
        try:
            exact_keys(
                entry,
                {"schemaVersion", "previousEntrySha256", "payload", "entrySha256", "signature"},
                "ledger",
            )
            body = {k: entry[k] for k in ("schemaVersion", "previousEntrySha256", "payload")}
            expected_hash = canonical_sha256(body)
            expected_sig = hmac.new(self._key, expected_hash.encode(), hashlib.sha256).hexdigest()
            return (
                entry["schemaVersion"] == SIGNED_LEDGER_SCHEMA
                and hmac.compare_digest(entry["entrySha256"], expected_hash)
                and hmac.compare_digest(entry["signature"], expected_sig)
            )
        except (KeyError, TypeError, ValueError):
            return False


@dataclass
class Budget:
    max_evaluations: int
    max_games: int
    max_private_queries: int = 10
    max_cpu_seconds: float = 64 * 3600
    max_gpu_seconds: float = 8 * 3600
    max_wall_seconds: float = 24 * 3600
    evaluations: int = 0
    games: int = 0
    private_queries: int = 0
    cpu_seconds: float = 0.0
    gpu_seconds: float = 0.0
    wall_seconds: float = 0.0

    def charge(
        self,
        *,
        games: int,
        cpu_seconds: float,
        gpu_seconds: float,
        wall_seconds: float,
        private: bool = False,
    ) -> None:
        proposed = (
            self.evaluations + 1,
            self.games + games,
            self.private_queries + int(private),
            self.cpu_seconds + cpu_seconds,
            self.gpu_seconds + gpu_seconds,
            self.wall_seconds + wall_seconds,
        )
        limits = (
            self.max_evaluations,
            self.max_games,
            self.max_private_queries,
            self.max_cpu_seconds,
            self.max_gpu_seconds,
            self.max_wall_seconds,
        )
        if any(value > limit + 1e-9 for value, limit in zip(proposed, limits)):
            raise RuntimeError("budget_exhausted")
        self.evaluations, self.games, self.private_queries, self.cpu_seconds, self.gpu_seconds, self.wall_seconds = proposed

    @property
    def normalized_cost(self) -> float:
        return self.gpu_seconds + self.cpu_seconds / 16

    def snapshot(self) -> dict[str, Any]:
        return {
            name: getattr(self, name)
            for name in (
                "evaluations",
                "games",
                "private_queries",
                "cpu_seconds",
                "gpu_seconds",
                "wall_seconds",
                "normalized_cost",
            )
        }


def mean_lcb(values: Sequence[float], confidence: float = 0.95) -> float:
    if not values:
        return float("-inf")
    if len(values) == 1:
        return values[0]
    m = mean(values)
    variance = sum((x - m) ** 2 for x in values) / (len(values) - 1)
    z = NormalDist().inv_cdf(0.5 + confidence / 2)
    return m - z * math.sqrt(variance / len(values))


def paired_lcb(candidate: Sequence[float], baseline: Sequence[float], confidence: float = 0.95) -> float:
    if len(candidate) != len(baseline) or not candidate:
        raise ValueError("paired samples must be non-empty and equal length")
    return mean_lcb([a - b for a, b in zip(candidate, baseline)], confidence)


def paired_bootstrap_lcb(
    candidate: Sequence[float],
    baseline: Sequence[float],
    *,
    confidence: float = 0.95,
    samples: int = 10_000,
    seed: int = 35_035,
) -> float:
    if len(candidate) != len(baseline) or not candidate:
        raise ValueError("paired samples must be non-empty and equal length")
    if not 0.5 < confidence < 1 or samples < 100:
        raise ValueError("invalid bootstrap configuration")
    differences = [left - right for left, right in zip(candidate, baseline)]
    rng = random.Random(seed)
    boot = sorted(
        mean(rng.choice(differences) for _ in differences)
        for _ in range(samples)
    )
    index = max(0, math.floor((1 - confidence) * samples))
    return boot[index]


def paired_sign_test_p(candidate: Sequence[float], baseline: Sequence[float]) -> float:
    """Exact two-sided sign test, ignoring ties."""
    if len(candidate) != len(baseline) or not candidate:
        raise ValueError("paired samples must be non-empty and equal length")
    wins = sum(left > right for left, right in zip(candidate, baseline))
    losses = sum(left < right for left, right in zip(candidate, baseline))
    n = wins + losses
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(0, min(wins, losses) + 1)) / (2**n)
    return min(1.0, 2 * tail)


def holm_bonferroni(p_values: Sequence[float], alpha: float = 0.05) -> list[bool]:
    indexed = sorted(enumerate(p_values), key=lambda row: row[1])
    rejected = [False] * len(p_values)
    for rank, (index, p_value) in enumerate(indexed):
        if p_value <= alpha / (len(indexed) - rank):
            rejected[index] = True
        else:
            break
    return rejected


def required_games(stddev: float, minimum_effect: float, power: float = 0.8, alpha: float = 0.05) -> int:
    if stddev <= 0 or minimum_effect <= 0:
        raise ValueError("stddev and minimum_effect must be positive")
    z_alpha = NormalDist().inv_cdf(1 - alpha / 2)
    z_power = NormalDist().inv_cdf(power)
    return math.ceil(((z_alpha + z_power) * stddev / minimum_effect) ** 2)


def spearman_rank_correlation(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or len(left) < 3:
        raise ValueError("correlation requires equal samples of length >= 3")
    def ranks(values: Sequence[float]) -> list[float]:
        order = sorted(range(len(values)), key=lambda i: values[i])
        result = [0.0] * len(values)
        cursor = 0
        while cursor < len(order):
            end = cursor + 1
            while end < len(order) and values[order[end]] == values[order[cursor]]:
                end += 1
            rank = (cursor + end - 1) / 2 + 1
            for pos in range(cursor, end):
                result[order[pos]] = rank
            cursor = end
        return result
    a, b = ranks(left), ranks(right)
    ma, mb = mean(a), mean(b)
    numerator = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    denominator = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return numerator / denominator if denominator else 0.0
