#!/usr/bin/env python3
"""Equal-budget local search controllers for the V35 configuration pilot."""

from __future__ import annotations

import copy
import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from .core import Candidate, DEFAULT_CANDIDATE, validate_candidate
from .evaluator import EvaluationRequest, EvaluationResult, TrustedEvaluator


@dataclass(frozen=True)
class Observation:
    candidate: Candidate
    score: float
    accepted: bool
    codes: tuple[str, ...]
    step: int
    parent_id: str | None
    lineage: int


@dataclass
class SearchState:
    method: str
    observations: list[Observation] = field(default_factory=list)
    rejected_signatures: set[tuple[str, ...]] = field(default_factory=set)

    @property
    def valid(self) -> list[Observation]:
        return [item for item in self.observations if item.accepted]

    @property
    def best(self) -> Observation:
        pool = self.valid or self.observations
        if not pool:
            raise RuntimeError("search has no observations")
        return max(pool, key=lambda item: (item.score, -item.candidate.complexity_units))


@dataclass(frozen=True)
class AidePolicy:
    lineages: int = 4
    bootstrap_steps: int = 8
    stagnation_limit: int = 3
    random_restart_interval: int = 5
    simplify_interval: int = 7
    mutation_scale: float = 0.12

    def __post_init__(self) -> None:
        if self.lineages < 2 or self.lineages > 8:
            raise ValueError("AIDE lineages must be in [2,8]")
        if self.bootstrap_steps < self.lineages or self.bootstrap_steps > 20:
            raise ValueError("AIDE bootstrap steps must cover every lineage and remain <=20")
        if self.stagnation_limit < 1 or self.stagnation_limit > 8:
            raise ValueError("AIDE stagnation limit must be in [1,8]")
        if self.random_restart_interval < 2 or self.simplify_interval < 2:
            raise ValueError("AIDE restart/simplify intervals must be >=2")
        if self.mutation_scale <= 0 or self.mutation_scale > 0.5:
            raise ValueError("AIDE mutation scale must be in (0,.5]")


def _shares(rng: random.Random) -> tuple[float, float, float]:
    snapshot = rng.uniform(0.25, 0.65)
    remaining = 1.0 - snapshot
    solo = remaining * rng.uniform(0.55, 0.95)
    multiplayer = remaining - solo
    return solo, snapshot, multiplayer


def random_candidate(rng: random.Random) -> Candidate:
    value = copy.deepcopy(DEFAULT_CANDIDATE)
    mode = rng.choices(["none", "rerank", "search"], [0.20, 0.35, 0.45])[0]
    value["policy"] = {
        "sample": rng.random() < 0.25,
        "temperature": rng.uniform(0.35, 1.15),
    }
    planner = value["planner"]
    planner["mode"] = mode
    planner["searchHorizonRounds"] = rng.randint(1, 6)
    planner["searchFraction"] = rng.uniform(0.25, 1.0)
    planner["searchValueWeight"] = rng.uniform(0.0, 1.5)
    planner["searchRollout"] = rng.choice(["policy", "heuristic"])
    planner["searchNavTemperature"] = rng.uniform(0.0, 1.0)
    if mode == "none":
        planner["rerankPolicyWeight"] = None
        planner["searchSims"] = 0
    elif mode == "rerank":
        planner["rerankPolicyWeight"] = rng.uniform(0.05, 0.95)
        planner["searchSims"] = 0
    else:
        planner["rerankPolicyWeight"] = None
        planner["searchSims"] = rng.choice([2, 4, 8, 16, 32])
    solo, snapshot, multiplayer = _shares(rng)
    value["curriculum"] = {
        "soloShare": solo,
        "lateSnapshotShare": snapshot,
        "multiplayerShare": multiplayer,
    }
    value["loss"] = {
        "terminalWeight": rng.uniform(0.5, 2.5),
        "engineWeight": rng.uniform(0.0, 1.5),
        "reach30Weight": rng.uniform(0.0, 2.0),
        "entropyWeight": rng.uniform(0.0, 0.08),
    }
    return validate_candidate(value)


def mutate_candidate(parent: Candidate, rng: random.Random, scale: float = 0.20) -> Candidate:
    value = parent.to_json()
    dimension = rng.choice(
        [
            "temperature",
            "sample",
            "planner",
            "horizon",
            "search",
            "curriculum",
            "loss",
        ]
    )
    if dimension == "temperature":
        current = float(value["policy"]["temperature"])
        value["policy"]["temperature"] = min(2.0, max(0.05, current + rng.gauss(0, scale)))
    elif dimension == "sample":
        value["policy"]["sample"] = not value["policy"]["sample"]
    elif dimension == "planner":
        mode = rng.choice(["none", "rerank", "search"])
        value["planner"]["mode"] = mode
        value["planner"]["rerankPolicyWeight"] = rng.uniform(0.1, 0.9) if mode == "rerank" else None
        value["planner"]["searchSims"] = rng.choice([2, 4, 8, 16]) if mode == "search" else 0
    elif dimension == "horizon":
        value["planner"]["searchHorizonRounds"] = min(
            8, max(1, int(value["planner"]["searchHorizonRounds"]) + rng.choice([-1, 1]))
        )
    elif dimension == "search":
        if value["planner"]["mode"] == "search":
            value["planner"]["searchSims"] = rng.choice([2, 4, 8, 16, 32])
            value["planner"]["searchValueWeight"] = min(
                2.0,
                max(0.0, float(value["planner"]["searchValueWeight"]) + rng.gauss(0, scale)),
            )
        elif value["planner"]["mode"] == "rerank":
            value["planner"]["rerankPolicyWeight"] = min(
                1.0,
                max(0.0, float(value["planner"]["rerankPolicyWeight"]) + rng.gauss(0, scale)),
            )
        else:
            value["planner"]["mode"] = "rerank"
            value["planner"]["rerankPolicyWeight"] = rng.uniform(0.1, 0.9)
    elif dimension == "curriculum":
        solo, snapshot, multiplayer = _shares(rng)
        value["curriculum"] = {
            "soloShare": solo,
            "lateSnapshotShare": snapshot,
            "multiplayerShare": multiplayer,
        }
    else:
        key = rng.choice(["terminalWeight", "engineWeight", "reach30Weight", "entropyWeight"])
        upper = 0.5 if key == "entropyWeight" else 4.0
        value["loss"][key] = min(
            upper,
            max(0.0, float(value["loss"][key]) + rng.gauss(0, scale if upper > 1 else 0.02)),
        )
    return validate_candidate(value)


def tpe_candidate(observations: Iterable[Observation], rng: random.Random) -> Candidate:
    valid = sorted((item for item in observations if item.accepted), key=lambda item: item.score)
    if len(valid) < 5:
        return random_candidate(rng)
    elite = valid[max(0, math.floor(len(valid) * 0.75)) :]
    parent = rng.choice(elite).candidate
    return mutate_candidate(parent, rng, scale=0.10)


class SearchRunner:
    def __init__(
        self,
        *,
        evaluator: TrustedEvaluator,
        seed0: int,
        seed_commitment: str,
        games_per_step: int,
        campaign: str,
        random_seed: int,
        aide_policy: AidePolicy | None = None,
    ):
        self.evaluator = evaluator
        self.seed0 = seed0
        self.seed_commitment = seed_commitment
        self.games_per_step = games_per_step
        self.campaign = campaign
        self.rng = random.Random(random_seed)
        self.aide_policy = aide_policy or AidePolicy()

    def _evaluate(
        self,
        state: SearchState,
        candidate: Candidate,
        step: int,
        parent_id: str | None,
        lineage: int,
    ) -> Observation:
        result = self.evaluator.evaluate(
            EvaluationRequest(
                candidate=candidate,
                tier="public",
                campaign=self.campaign,
                games=self.games_per_step,
                seed0=self.seed0,
                seed_commitment=self.seed_commitment,
            )
        )
        observation = Observation(
            candidate=candidate,
            score=result.arc_fitness,
            accepted=result.accepted,
            codes=result.diagnostic_codes,
            step=step,
            parent_id=parent_id,
            lineage=lineage,
        )
        state.observations.append(observation)
        if not observation.accepted:
            state.rejected_signatures.add(observation.codes)
        return observation

    def run(self, method: str, steps: int) -> SearchState:
        if method not in {"random", "evolutionary", "tpe", "aide"} or steps < 1:
            raise ValueError("invalid search request")
        state = SearchState(method=method)
        lineages: dict[int, Observation] = {}
        stagnant: dict[int, int] = {}
        for step in range(steps):
            parent: Observation | None = None
            lineage = 0
            if method == "random" or not state.observations:
                candidate = random_candidate(self.rng) if step else validate_candidate(DEFAULT_CANDIDATE)
            elif method == "tpe":
                candidate = tpe_candidate(state.observations, self.rng)
            elif method == "evolutionary":
                elite = sorted(state.valid or state.observations, key=lambda item: item.score)[-4:]
                parent = self.rng.choice(elite)
                lineage = parent.lineage
                candidate = mutate_candidate(parent.candidate, self.rng)
            else:
                # AIDE-style: bootstrap several diverse lineages, exploit within each, fork
                # after stagnation, retain periodic global exploration, and simplify cost.
                policy = self.aide_policy
                if step < min(policy.bootstrap_steps, steps):
                    lineage = step % min(policy.lineages, steps)
                    candidate = random_candidate(self.rng) if step else validate_candidate(DEFAULT_CANDIDATE)
                else:
                    lineage = step % len(lineages)
                    parent = lineages[lineage]
                    if (
                        stagnant.get(lineage, 0) >= policy.stagnation_limit
                        or step % policy.random_restart_interval == 0
                    ):
                        candidate = random_candidate(self.rng)
                        stagnant[lineage] = 0
                    elif step % policy.simplify_interval == 0 and parent.candidate.planner_mode == "search":
                        simpler = parent.candidate.to_json()
                        sims = int(simpler["planner"]["searchSims"])
                        simpler["planner"]["searchSims"] = max(2, sims // 2)
                        candidate = validate_candidate(simpler)
                    else:
                        candidate = mutate_candidate(
                            mutate_candidate(parent.candidate, self.rng, scale=policy.mutation_scale),
                            self.rng,
                            scale=policy.mutation_scale,
                        )
            observed = self._evaluate(
                state,
                candidate,
                step,
                parent.candidate.candidate_id if parent else None,
                lineage,
            )
            if method == "aide":
                incumbent = lineages.get(lineage)
                if incumbent is None or (observed.accepted and observed.score > incumbent.score):
                    lineages[lineage] = observed
                    stagnant[lineage] = 0
                else:
                    stagnant[lineage] = stagnant.get(lineage, 0) + 1
        return state


def state_summary(state: SearchState) -> dict[str, Any]:
    best = state.best
    return {
        "method": state.method,
        "steps": len(state.observations),
        "accepted": len(state.valid),
        "bestCandidateId": best.candidate.candidate_id,
        "bestScore": best.score,
        "bestComplexityUnits": best.candidate.complexity_units,
        "bestCandidate": best.candidate.to_json(),
        "rejectionCategories": [list(codes) for codes in sorted(state.rejected_signatures)],
        "lineages": len({item.lineage for item in state.observations}),
    }
