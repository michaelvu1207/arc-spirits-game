#!/usr/bin/env python3
"""Fail-closed runner for the bounded V35 public inference-configuration pilot."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .core import ArtifactSigner, Budget, canonical_sha256, exact_keys
from .evaluator import GateThresholds, TrustedEvaluator
from .search import AidePolicy, SearchRunner, SearchState, state_summary
from .simforge import GPU7_UUID, SimForgeGPU7Backend


SCHEMA = "arc-v35-public-config-pilot-authorization-v1"
RESULT_SCHEMA = "arc-v35-public-config-pilot-result-v1"
METHODS = ("random", "evolutionary", "tpe", "aide")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_authorization(path: Path, repo_root: Path) -> dict[str, Any]:
    authorization_path = path.resolve(strict=True)
    root = repo_root.resolve(strict=True)
    value = json.loads(authorization_path.read_text())
    exact_keys(
        value,
        {
            "schemaVersion",
            "campaign",
            "promotionEligible",
            "privateAccess",
            "searchSurface",
            "methods",
            "stepsPerArm",
            "totalProposals",
            "gamesPerProposal",
            "publicSeed",
            "randomSeeds",
            "checkpoint",
            "trustedFiles",
            "resources",
            "thresholds",
            "selection",
            "searchPolicy",
            "output",
        },
        "public-pilot authorization",
    )
    if value["schemaVersion"] != SCHEMA:
        raise ValueError("unexpected public-pilot authorization schema")
    if value["promotionEligible"] is not False or value["privateAccess"] is not False:
        raise ValueError("public pilot cannot authorize promotion or private access")
    if value["searchSurface"] != "inference" or tuple(value["methods"]) != METHODS:
        raise ValueError("public pilot must use the frozen inference-only four-arm search")
    steps = value["stepsPerArm"]
    games = value["gamesPerProposal"]
    if not isinstance(steps, int) or steps != 5:
        raise ValueError("public pilot requires exactly five steps per arm")
    if value["totalProposals"] != steps * len(METHODS) or value["totalProposals"] != 20:
        raise ValueError("public pilot proposal cap must be exactly 20")
    if not isinstance(games, int) or games != 256:
        raise ValueError("public pilot must use the powered 256-game task")

    seed = value["publicSeed"]
    exact_keys(seed, {"seed0", "seedMax", "commitment"}, "publicSeed")
    if seed["seedMax"] != seed["seed0"] + games - 1:
        raise ValueError("public seed range does not match games per proposal")
    expected_commitment = canonical_sha256(
        {
            "schemaVersion": "arc-v35-public-seed-family-v1",
            "campaign": value["campaign"],
            "seed0": seed["seed0"],
            "games": games,
        }
    )
    if seed["commitment"] != expected_commitment:
        raise ValueError("public seed commitment mismatch")

    random_seeds = value["randomSeeds"]
    if set(random_seeds) != set(METHODS) or any(
        isinstance(seed_value, bool) or not isinstance(seed_value, int)
        for seed_value in random_seeds.values()
    ):
        raise ValueError("public pilot random-seed catalog is invalid")

    checkpoint = value["checkpoint"]
    exact_keys(checkpoint, {"path", "sha256"}, "checkpoint")
    if not isinstance(checkpoint["path"], str) or not checkpoint["path"].startswith("ml/"):
        raise ValueError("checkpoint path must be repository-relative")
    if not isinstance(checkpoint["sha256"], str) or len(checkpoint["sha256"]) != 64:
        raise ValueError("checkpoint hash is invalid")

    trusted_files = value["trustedFiles"]
    if not isinstance(trusted_files, dict) or len(trusted_files) < 7:
        raise ValueError("trusted-file lock is incomplete")
    for relative, digest in trusted_files.items():
        candidate = (root / relative).resolve(strict=True)
        if root not in candidate.parents or _sha256(candidate) != digest:
            raise ValueError(f"trusted file changed: {relative}")

    resources = value["resources"]
    exact_keys(
        resources,
        {
            "physicalGpu",
            "gpuUuid",
            "forbiddenGpus",
            "workers",
            "timeoutSeconds",
            "maxStatusLevel",
            "maxGpuSecondsPerArm",
            "maxCpuSecondsPerArm",
            "maxWallSecondsPerArm",
        },
        "resources",
    )
    if (
        resources["physicalGpu"] != 7
        or resources["gpuUuid"] != GPU7_UUID
        or resources["forbiddenGpus"] != [4, 5, 6]
        or resources["workers"] != 24
        or resources["maxStatusLevel"] != 2
    ):
        raise ValueError("public pilot resource fence changed")
    if not 1 <= resources["timeoutSeconds"] <= 3600:
        raise ValueError("public pilot timeout is invalid")

    thresholds = value["thresholds"]
    exact_keys(
        thresholds,
        {
            "minTrueWinRate",
            "minReach15Rate",
            "maxStallRate",
            "maxGameWallMsP95",
            "maxComplexityUnits",
            "requireCompleteTaskMix",
        },
        "thresholds",
    )
    if thresholds["requireCompleteTaskMix"] is not False:
        raise ValueError("public solo pilot must remain explicitly promotion-ineligible")

    selection = value["selection"]
    exact_keys(selection, {"aideParityTolerance", "freshPublicRequired"}, "selection")
    if selection["aideParityTolerance"] != 0.01 or selection["freshPublicRequired"] is not True:
        raise ValueError("public pilot selection rule changed")

    search_policy = value["searchPolicy"]
    exact_keys(search_policy, {"tpeMinObservations", "aide"}, "searchPolicy")
    if search_policy["tpeMinObservations"] != 2:
        raise ValueError("small-budget TPE policy changed")
    aide = search_policy["aide"]
    exact_keys(
        aide,
        {
            "lineages",
            "bootstrapSteps",
            "stagnationLimit",
            "randomRestartInterval",
            "simplifyInterval",
            "mutationScale",
        },
        "searchPolicy.aide",
    )
    expected_aide = {
        "lineages": 2,
        "bootstrapSteps": 2,
        "stagnationLimit": 1,
        "randomRestartInterval": 5,
        "simplifyInterval": 7,
        "mutationScale": 0.12,
    }
    if aide != expected_aide:
        raise ValueError("small-budget AIDE policy changed")

    output = value["output"]
    exact_keys(output, {"path", "schemaVersion"}, "output")
    if output["schemaVersion"] != RESULT_SCHEMA or not output["path"].startswith("ml/"):
        raise ValueError("public pilot output binding is invalid")
    return value


def _observation_rows(state: SearchState) -> list[dict[str, Any]]:
    return [
        {
            "step": item.step,
            "candidateId": item.candidate.candidate_id,
            "candidate": item.candidate.to_json(),
            "arcFitness": item.score,
            "accepted": item.accepted,
            "diagnosticCodes": list(item.codes),
            "parentId": item.parent_id,
            "lineage": item.lineage,
        }
        for item in state.observations
    ]


def run_public_pilot(
    *, authorization_path: Path, repo_root: Path, signing_key: Path
) -> dict[str, Any]:
    root = repo_root.resolve(strict=True)
    authorization = load_authorization(authorization_path, root)
    resources = authorization["resources"]
    thresholds = authorization["thresholds"]
    trusted = authorization["trustedFiles"]
    checkpoint = authorization["checkpoint"]
    signer = ArtifactSigner.open_or_create(signing_key)
    arms: list[dict[str, Any]] = []
    aide_config = authorization["searchPolicy"]["aide"]
    aide_policy = AidePolicy(
        lineages=aide_config["lineages"],
        bootstrap_steps=aide_config["bootstrapSteps"],
        stagnation_limit=aide_config["stagnationLimit"],
        random_restart_interval=aide_config["randomRestartInterval"],
        simplify_interval=aide_config["simplifyInterval"],
        mutation_scale=aide_config["mutationScale"],
    )

    immutable_manifest: Mapping[str, Any] = {
        "schemaVersion": "arc-v35-public-config-pilot-manifest-v1",
        "authorizationSha256": _sha256(authorization_path.resolve(strict=True)),
        "checkpoint": checkpoint,
        "trustedFiles": trusted,
        "publicSeedCommitment": authorization["publicSeed"]["commitment"],
    }
    for method in METHODS:
        budget = Budget(
            max_evaluations=authorization["stepsPerArm"],
            max_games=authorization["stepsPerArm"] * authorization["gamesPerProposal"],
            max_private_queries=0,
            max_cpu_seconds=resources["maxCpuSecondsPerArm"],
            max_gpu_seconds=resources["maxGpuSecondsPerArm"],
            max_wall_seconds=resources["maxWallSecondsPerArm"],
        )
        backend = SimForgeGPU7Backend(
            checkpoint=checkpoint["path"],
            checkpoint_sha256=checkpoint["sha256"],
            evaluator_sha256=trusted["scripts/evaluate-solo-checkpoint.mjs"],
            infer_server_sha256=trusted["ml/infer_server.py"],
            catalog_sha256=trusted["ml/catalog.json"],
            workers=resources["workers"],
            timeout_seconds=resources["timeoutSeconds"],
            max_status_level=resources["maxStatusLevel"],
        )
        evaluator = TrustedEvaluator(
            backend=backend,
            signer=signer,
            budget=budget,
            immutable_manifest=immutable_manifest,
            thresholds=GateThresholds(
                min_true_win_rate=thresholds["minTrueWinRate"],
                min_reach15_rate=thresholds["minReach15Rate"],
                max_stall_rate=thresholds["maxStallRate"],
                max_game_wall_ms_p95=thresholds["maxGameWallMsP95"],
                max_complexity_units=thresholds["maxComplexityUnits"],
                require_complete_task_mix=False,
            ),
        )
        runner = SearchRunner(
            evaluator=evaluator,
            seed0=authorization["publicSeed"]["seed0"],
            seed_commitment=authorization["publicSeed"]["commitment"],
            games_per_step=authorization["gamesPerProposal"],
            campaign=f"{authorization['campaign']}-{method}",
            random_seed=authorization["randomSeeds"][method],
            search_surface="inference",
            aide_policy=aide_policy,
            tpe_min_observations=authorization["searchPolicy"]["tpeMinObservations"],
        )
        state = runner.run(method, authorization["stepsPerArm"])
        arms.append(
            {
                **state_summary(state),
                "observations": _observation_rows(state),
                "signedLedger": state.ledger_entries,
                "cost": budget.snapshot(),
            }
        )

    by_method = {arm["method"]: arm for arm in arms}
    simple_best = max(
        by_method[method]["bestScore"] for method in ("random", "evolutionary", "tpe")
    )
    aide_parity = (
        by_method["aide"]["bestScore"]
        >= simple_best - authorization["selection"]["aideParityTolerance"]
    )
    best_arm = max(
        arms, key=lambda arm: (arm["bestScore"], -arm["bestComplexityUnits"])
    )
    return {
        "schemaVersion": RESULT_SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "privateConfirmationAuthorized": False,
        "authorization": {
            "path": str(authorization_path.resolve(strict=True)),
            "sha256": _sha256(authorization_path.resolve(strict=True)),
        },
        "contract": {
            "methods": list(METHODS),
            "stepsPerArm": authorization["stepsPerArm"],
            "totalProposals": authorization["totalProposals"],
            "gamesPerProposal": authorization["gamesPerProposal"],
            "searchSurface": "inference",
            "commonRandomNumbers": True,
            "publicSeedCommitment": authorization["publicSeed"]["commitment"],
            "searchPolicy": authorization["searchPolicy"],
        },
        "arms": arms,
        "gate": {
            "pipelineComplete": sum(arm["steps"] for arm in arms) == 20,
            "aideParityWithSimpleSearch": aide_parity,
            "aideParityTolerance": authorization["selection"]["aideParityTolerance"],
            "configurationPilotPassed": aide_parity,
        },
        "developmentChampion": {
            "method": best_arm["method"],
            "candidateId": best_arm["bestCandidateId"],
            "candidate": best_arm["bestCandidate"],
            "arcFitness": best_arm["bestScore"],
            "freshPublicConfirmationRequired": True,
        },
    }
