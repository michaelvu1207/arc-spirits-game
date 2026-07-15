#!/usr/bin/env python3
"""Synthetic-only preflight for the V35 outer researcher loop.

This validates equal-cost control/treatment plumbing. It cannot support a recursive-improvement claim;
that requires real disjoint bot campaigns and the frozen meta-evaluator described in the plan.
"""

from __future__ import annotations

import dataclasses
import random
import tempfile
from pathlib import Path
from statistics import mean
from typing import Any, Iterable

from .core import (
    ArtifactSigner,
    Budget,
    SeedVault,
    paired_bootstrap_lcb,
    paired_sign_test_p,
)
from .evaluator import GateThresholds, SyntheticBackend, TrustedEvaluator
from .search import AidePolicy, SearchRunner


def _one_campaign(
    policy: AidePolicy,
    *,
    seed_key: Path,
    campaign: str,
    random_seed: int,
    steps: int,
    games: int,
) -> float:
    vault = SeedVault.open_or_create(seed_key)
    family = vault.family("private", campaign, games)
    with tempfile.TemporaryDirectory(prefix="arc-v35-researcher-") as temp_name:
        signer = ArtifactSigner.open_or_create(Path(temp_name) / "sign.key")
        evaluator = TrustedEvaluator(
            backend=SyntheticBackend(),
            signer=signer,
            budget=Budget(max_evaluations=steps, max_games=steps * games),
            immutable_manifest={"schemaVersion": "arc-v35-synthetic-meta-evaluator-v1"},
            thresholds=GateThresholds(require_complete_task_mix=False),
        )
        runner = SearchRunner(
            evaluator=evaluator,
            seed0=family["seed0"],
            seed_commitment=family["commitment"],
            games_per_step=games,
            campaign=campaign,
            random_seed=random_seed,
            aide_policy=policy,
        )
        return runner.run("aide", steps).best.score


def policy_candidates(seed: int, count: int) -> list[AidePolicy]:
    if count < 1 or count > 64:
        raise ValueError("outer policy candidate count must be in [1,64]")
    rng = random.Random(seed)
    candidates = [AidePolicy()]
    seen = {candidates[0]}
    while len(candidates) < count:
        lineages = rng.choice([2, 3, 4, 5, 6])
        bootstrap = rng.choice([6, 8, 10, 12])
        bootstrap = max(lineages, bootstrap)
        candidate = AidePolicy(
            lineages=lineages,
            bootstrap_steps=bootstrap,
            stagnation_limit=rng.choice([2, 3, 4, 5]),
            random_restart_interval=rng.choice([4, 5, 6, 8]),
            simplify_interval=rng.choice([5, 7, 9, 11]),
            mutation_scale=rng.choice([0.08, 0.12, 0.16, 0.22]),
        )
        if candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)
    return candidates


def run_synthetic_recursive_preflight(
    *,
    seed_key: Path,
    outer_candidates: int = 12,
    development_replicates: int = 3,
    confirmation_replicates: int = 8,
    steps: int = 20,
    games: int = 64,
    seed: int = 35_400,
) -> dict[str, Any]:
    if development_replicates < 2 or confirmation_replicates < 3:
        raise ValueError("recursive preflight needs >=2 development and >=3 confirmation replicates")
    candidates = policy_candidates(seed, outer_candidates)
    development: list[dict[str, Any]] = []
    for policy_index, policy in enumerate(candidates):
        scores = [
            _one_campaign(
                policy,
                seed_key=seed_key,
                campaign=f"recursive-dev-r{replicate}",
                random_seed=seed + replicate * 101,
                steps=steps,
                games=games,
            )
            for replicate in range(development_replicates)
        ]
        development.append(
            {
                "policy": dataclasses.asdict(policy),
                "developmentScores": scores,
                "developmentMean": mean(scores),
                "policyIndex": policy_index,
            }
        )
    selected = max(development, key=lambda row: row["developmentMean"])
    treatment = AidePolicy(**selected["policy"])
    control = AidePolicy()
    control_scores: list[float] = []
    treatment_scores: list[float] = []
    for replicate in range(confirmation_replicates):
        campaign = f"recursive-confirm-r{replicate}"
        common_seed = seed + 10_000 + replicate * 103
        control_scores.append(
            _one_campaign(
                control,
                seed_key=seed_key,
                campaign=campaign,
                random_seed=common_seed,
                steps=steps,
                games=games,
            )
        )
        treatment_scores.append(
            _one_campaign(
                treatment,
                seed_key=seed_key,
                campaign=campaign,
                random_seed=common_seed,
                steps=steps,
                games=games,
            )
        )
    differences = [left - right for left, right in zip(treatment_scores, control_scores)]
    lcb = paired_bootstrap_lcb(treatment_scores, control_scores, seed=seed + 99)
    p_value = paired_sign_test_p(treatment_scores, control_scores)
    return {
        "schemaVersion": "arc-v35-synthetic-recursive-preflight-v1",
        "syntheticOnly": True,
        "recursiveImprovementClaim": False,
        "equalEvaluatorCalls": True,
        "stepsPerInnerCampaign": steps,
        "gamesPerStep": games,
        "developmentReplicates": development_replicates,
        "confirmationReplicates": confirmation_replicates,
        "controlPolicy": dataclasses.asdict(control),
        "selectedTreatmentPolicy": dataclasses.asdict(treatment),
        "selectionIndex": selected["policyIndex"],
        "development": development,
        "confirmation": {
            "controlScores": control_scores,
            "treatmentScores": treatment_scores,
            "pairedDifferences": differences,
            "meanDifference": mean(differences),
            "pairedBootstrap95Lcb": lcb,
            "exactSignTestP": p_value,
            "syntheticGatePassed": lcb > 0 and p_value <= 0.05,
        },
    }
