#!/usr/bin/env python3
"""Command-line entry point for the private/local V35 autoresearch lane."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any

from .core import ArtifactSigner, Budget, SeedVault, validate_candidate
from .evaluator import (
    GateThresholds,
    NodeSoloBackend,
    SyntheticBackend,
    TrustedEvaluator,
    immutable_manifest,
)
from .search import SearchRunner, state_summary
from .recursive import run_synthetic_recursive_preflight


def _candidate(path: Path):
    return validate_candidate(json.loads(path.read_text()))


def _pilot(args: argparse.Namespace) -> dict[str, Any]:
    summaries = []
    with tempfile.TemporaryDirectory(prefix="arc-v35-pilot-") as temp:
        temp_path = Path(temp)
        vault = SeedVault.open_or_create(temp_path / "seed.key")
        family = vault.family("private", args.campaign, args.games)
        for index, method in enumerate(("random", "evolutionary", "tpe", "aide")):
            signer = ArtifactSigner.open_or_create(temp_path / f"{method}.key")
            budget = Budget(
                max_evaluations=args.steps,
                max_games=args.steps * args.games,
                max_private_queries=10,
            )
            evaluator = TrustedEvaluator(
                backend=SyntheticBackend(),
                signer=signer,
                budget=budget,
                immutable_manifest={"schemaVersion": "arc-v35-synthetic-manifest-v1"},
                thresholds=GateThresholds(require_complete_task_mix=False),
            )
            runner = SearchRunner(
                evaluator=evaluator,
                seed0=family["seed0"],
                seed_commitment=family["commitment"],
                games_per_step=args.games,
                campaign=f"{args.campaign}-{method}",
                random_seed=args.seed + index,
            )
            state = runner.run(method, args.steps)
            summaries.append({**state_summary(state), "cost": budget.snapshot()})
    return {
        "schemaVersion": "arc-v35-search-comparison-v1",
        "syntheticOnly": True,
        "promotionEligible": False,
        "stepsPerArm": args.steps,
        "gamesPerStep": args.games,
        "arms": summaries,
    }


def _real_solo(args: argparse.Namespace) -> dict[str, Any]:
    repo = args.repo.resolve(strict=True)
    candidate = _candidate(args.candidate)
    vault = SeedVault.open_or_create(args.seed_key)
    signer = ArtifactSigner.open_or_create(args.signing_key)
    family = vault.family("private" if args.private else "confirmation", args.campaign, args.games)
    budget = Budget(max_evaluations=1, max_games=args.games)
    evaluator = TrustedEvaluator(
        backend=NodeSoloBackend(
            repo_root=repo,
            weights=args.weights,
            workers=args.workers,
            timeout_seconds=args.timeout,
            max_status_level=args.max_status_level,
        ),
        signer=signer,
        budget=budget,
        immutable_manifest=immutable_manifest(repo, args.weights),
        thresholds=GateThresholds(
            min_true_win_rate=args.min_win_rate,
            min_reach15_rate=args.min_reach15_rate,
            require_complete_task_mix=True,
        ),
    )
    from .evaluator import EvaluationRequest

    result = evaluator.evaluate(
        EvaluationRequest(
            candidate=candidate,
            tier="private" if args.private else "public",
            campaign=args.campaign,
            games=args.games,
            seed0=family["seed0"],
            seed_commitment=family["commitment"],
        )
    )
    if args.private:
        if args.trusted_ledger_out is None:
            raise ValueError("private evaluations require --trusted-ledger-out")
        ledger_path = args.trusted_ledger_out.expanduser().resolve()
        ledger_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        ledger_path.write_text(json.dumps(result.signed_entry, sort_keys=True) + "\n")
        ledger_path.chmod(0o600)
    return {
        "schemaVersion": "arc-v35-real-solo-cli-v1",
        "promotionEligible": False,
        "reason": "solo-only backend; complete replay and task-mix gates are not attached",
        "feedback": result.feedback(reveal_scalar=not args.private),
        **({} if args.private else {"signedEntry": result.signed_entry}),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("candidate", type=Path)

    pilot = commands.add_parser("synthetic-pilot")
    pilot.add_argument("--steps", type=int, default=20)
    pilot.add_argument("--games", type=int, default=64)
    pilot.add_argument("--seed", type=int, default=35001)
    pilot.add_argument("--campaign", default="v35-synthetic-pilot")
    pilot.add_argument("--out", type=Path)

    recursive = commands.add_parser("synthetic-recursive")
    recursive.add_argument("--outer-candidates", type=int, default=12)
    recursive.add_argument("--development-replicates", type=int, default=3)
    recursive.add_argument("--confirmation-replicates", type=int, default=8)
    recursive.add_argument("--steps", type=int, default=20)
    recursive.add_argument("--games", type=int, default=64)
    recursive.add_argument("--seed", type=int, default=35_400)
    recursive.add_argument("--seed-key", type=Path, required=True)
    recursive.add_argument("--out", type=Path)

    solo = commands.add_parser("real-solo")
    solo.add_argument("--repo", type=Path, default=Path.cwd())
    solo.add_argument("--candidate", type=Path, required=True)
    solo.add_argument("--weights", type=Path, required=True)
    solo.add_argument("--games", type=int, default=16)
    solo.add_argument("--workers", type=int, default=8)
    solo.add_argument("--timeout", type=float, default=1800)
    solo.add_argument("--max-status-level", type=int, choices=(0, 1, 2, 3), default=3)
    solo.add_argument("--campaign", required=True)
    solo.add_argument("--seed-key", type=Path, required=True)
    solo.add_argument("--signing-key", type=Path, required=True)
    solo.add_argument("--min-win-rate", type=float, default=0.0)
    solo.add_argument("--min-reach15-rate", type=float, default=0.0)
    solo.add_argument("--private", action="store_true")
    solo.add_argument("--trusted-ledger-out", type=Path)
    solo.add_argument("--out", type=Path)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "validate":
        result: dict[str, Any] = {
            "valid": True,
            "candidateId": _candidate(args.candidate).candidate_id,
        }
    elif args.command == "synthetic-pilot":
        if args.steps < 1 or args.steps > 20 or args.games < 4:
            parser.error("pilot requires 1..20 steps and at least 4 games per step")
        result = _pilot(args)
    elif args.command == "synthetic-recursive":
        result = run_synthetic_recursive_preflight(
            seed_key=args.seed_key,
            outer_candidates=args.outer_candidates,
            development_replicates=args.development_replicates,
            confirmation_replicates=args.confirmation_replicates,
            steps=args.steps,
            games=args.games,
            seed=args.seed,
        )
    else:
        result = _real_solo(args)
    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if getattr(args, "out", None):
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload)
    print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
