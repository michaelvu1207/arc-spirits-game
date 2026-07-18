#!/usr/bin/env python3
"""Outcome-blind policy-medoid selection for frozen V32 treatment endpoints."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import torch

from model_v2 import load_checkpoint


REPLICATES = ("a", "b", "c")
TREATMENTS = ("round-reweighted", "p30-credit025")
PAIRS = (("a", "b"), ("a", "c"), ("b", "c"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root: Path) -> tuple[list[dict[str, Any]], str]:
    files = sorted(path for path in root.rglob("*") if path.is_file())
    if not files:
        raise ValueError(f"validation corpus is empty: {root}")
    entries = []
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix()
        size = path.stat().st_size
        file_sha = sha256(path)
        entries.append({"path": relative, "bytes": size, "sha256": file_sha})
        digest.update(f"{relative}\0{size}\0{file_sha}\n".encode())
    return entries, digest.hexdigest()


def select_medoid(pair_distances: dict[str, float]) -> tuple[str, dict[str, float]]:
    expected = {"a-b", "a-c", "b-c"}
    if set(pair_distances) != expected:
        raise ValueError(f"pair distances must be {sorted(expected)}")
    if any(not math.isfinite(value) or value < 0 for value in pair_distances.values()):
        raise ValueError("pair distances must be finite and nonnegative")
    scores = {
        "a": (pair_distances["a-b"] + pair_distances["a-c"]) / 2,
        "b": (pair_distances["a-b"] + pair_distances["b-c"]) / 2,
        "c": (pair_distances["a-c"] + pair_distances["b-c"]) / 2,
    }
    selected = min(REPLICATES, key=lambda replicate: (scores[replicate], REPLICATES.index(replicate)))
    return selected, scores


def padded_batch(rows: list[dict[str, Any]]) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    max_candidates = max(len(row["cands"]) for row in rows)
    action_dim = len(rows[0]["cands"][0])
    obs = np.asarray([row["obsV2"] for row in rows], dtype=np.float32)
    candidates = np.zeros((len(rows), max_candidates, action_dim), dtype=np.float32)
    support = np.zeros((len(rows), max_candidates), dtype=bool)
    for index, row in enumerate(rows):
        row_candidates = np.asarray(row["cands"], dtype=np.float32)
        row_support = np.asarray(row.get("behaviorMask"), dtype=bool)
        if row_candidates.ndim != 2 or row_candidates.shape[1] != action_dim:
            raise ValueError("candidate shape changed within validation batch")
        if row_support.shape != (len(row_candidates),) or not bool(row_support.any()):
            raise ValueError("invalid exact legal support in validation row")
        candidates[index, : len(row_candidates)] = row_candidates
        support[index, : len(row_candidates)] = row_support
    return torch.from_numpy(obs), torch.from_numpy(candidates), torch.from_numpy(support)


def iter_policy_rows(validation: Path) -> Iterable[dict[str, Any]]:
    shards = sorted(validation.glob("shard-*.jsonl"))
    if not shards:
        raise ValueError(f"no validation shards below {validation}")
    for shard in shards:
        with shard.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                if int(row.get("policyMask", 0)) != 1:
                    continue
                if not row.get("gameId") or not isinstance(row.get("obsV2"), list):
                    raise ValueError(f"{shard}:{line_number}: malformed policy row")
                if not isinstance(row.get("cands"), list) or not row["cands"]:
                    raise ValueError(f"{shard}:{line_number}: missing candidates")
                yield row


def expected_endpoint_hashes(
    manipulation: dict[str, Any], generation: int
) -> dict[str, dict[str, str]]:
    if manipulation.get("schemaVersion") != "arc-v32-manipulation-audit-v1":
        raise ValueError("unexpected manipulation-audit schema")
    if not manipulation.get("valid") or int(manipulation.get("generation", -1)) != generation:
        raise ValueError("manipulation audit is invalid or for the wrong generation")
    if not manipulation.get("manipulation", {}).get("passed"):
        raise ValueError("cannot select representatives from an ineligible endpoint")
    models = manipulation.get("models")
    expected: dict[str, dict[str, str]] = {}
    for treatment in TREATMENTS:
        expected[treatment] = {}
        for replicate in REPLICATES:
            value = models.get(replicate, {}).get(treatment, {}).get("sha256")
            if not isinstance(value, str) or len(value) != 64:
                raise ValueError(f"missing manipulation hash for {replicate}/{treatment}")
            expected[treatment][replicate] = value
    return expected


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    experiment = args.experiment.resolve()
    validation = args.validation.resolve()
    manipulation_path = args.manipulation.resolve()
    manipulation = json.loads(manipulation_path.read_text())
    expected = expected_endpoint_hashes(manipulation, args.generation)

    paths: dict[str, dict[str, Path]] = {treatment: {} for treatment in TREATMENTS}
    models: dict[str, dict[str, Any]] = {treatment: {} for treatment in TREATMENTS}
    checkpoint_hashes: dict[str, dict[str, str]] = {treatment: {} for treatment in TREATMENTS}
    for treatment in TREATMENTS:
        for replicate in REPLICATES:
            path = (
                experiment
                / "league"
                / f"rep-{replicate}"
                / treatment
                / "checkpoints"
                / f"main-0-gen{args.generation}.pt"
            )
            if not path.is_file():
                raise FileNotFoundError(path)
            actual_sha = sha256(path)
            if actual_sha != expected[treatment][replicate]:
                raise ValueError(f"checkpoint hash mismatch for {replicate}/{treatment}")
            paths[treatment][replicate] = path
            checkpoint_hashes[treatment][replicate] = actual_sha
            models[treatment][replicate] = load_checkpoint(path, torch.device("cpu")).eval()

    # Equal-row means within each game, followed by equal-game means.
    sums: dict[str, dict[str, dict[str, float]]] = {
        treatment: {f"{left}-{right}": defaultdict(float) for left, right in PAIRS}
        for treatment in TREATMENTS
    }
    counts: dict[str, int] = defaultdict(int)
    game_seeds: dict[str, int] = {}
    row_count = 0
    batch: list[dict[str, Any]] = []

    def flush(rows: list[dict[str, Any]]) -> None:
        nonlocal row_count
        if not rows:
            return
        obs, candidates, support = padded_batch(rows)
        policies: dict[str, dict[str, tuple[torch.Tensor, torch.Tensor]]] = {
            treatment: {} for treatment in TREATMENTS
        }
        with torch.no_grad():
            for treatment in TREATMENTS:
                for replicate in REPLICATES:
                    logits = models[treatment][replicate](obs, candidates, support)[0].double()
                    logits = logits / args.temperature
                    log_probs = torch.log_softmax(logits, dim=-1)
                    probabilities = torch.softmax(logits, dim=-1)
                    if not bool(torch.isfinite(log_probs[support]).all()) or not bool(
                        torch.isfinite(probabilities[support]).all()
                    ):
                        raise ValueError(f"non-finite policy for {replicate}/{treatment}")
                    policies[treatment][replicate] = (probabilities, log_probs)
            for index, row in enumerate(rows):
                game_id = str(row["gameId"])
                try:
                    game_seed = int(game_id.split("-", 1)[0])
                except ValueError as exc:
                    raise ValueError(f"invalid validation game id: {game_id}") from exc
                previous_seed = game_seeds.setdefault(game_id, game_seed)
                if previous_seed != game_seed:
                    raise ValueError(f"validation game id changed seed: {game_id}")
                counts[game_id] += 1
                for treatment in TREATMENTS:
                    for left, right in PAIRS:
                        p_left, lp_left = policies[treatment][left]
                        p_right, lp_right = policies[treatment][right]
                        row_support = support[index]
                        forward = torch.sum(
                            p_left[index, row_support]
                            * (lp_left[index, row_support] - lp_right[index, row_support])
                        )
                        reverse = torch.sum(
                            p_right[index, row_support]
                            * (lp_right[index, row_support] - lp_left[index, row_support])
                        )
                        value = float(0.5 * (forward + reverse))
                        if not math.isfinite(value) or value < -1e-12:
                            raise ValueError("invalid symmetric KL")
                        sums[treatment][f"{left}-{right}"][game_id] += max(0.0, value)
        row_count += len(rows)

    for row in iter_policy_rows(validation):
        batch.append(row)
        if len(batch) >= args.batch_size:
            flush(batch)
            batch.clear()
    flush(batch)
    if len(counts) != args.expected_games:
        raise ValueError(f"expected {args.expected_games} validation games, got {len(counts)}")
    expected_seeds = set(range(args.expected_seed0, args.expected_seed0 + args.expected_games))
    actual_seeds = set(game_seeds.values())
    if actual_seeds != expected_seeds or len(game_seeds) != len(actual_seeds):
        raise ValueError("validation game ids do not cover the exact frozen seed block")
    if row_count <= 0 or any(count <= 0 for count in counts.values()):
        raise ValueError("validation corpus has no complete policy-row coverage")

    results: dict[str, Any] = {}
    for treatment in TREATMENTS:
        distances = {
            pair: float(np.mean([total / counts[game_id] for game_id, total in by_game.items()]))
            for pair, by_game in sums[treatment].items()
        }
        if any(set(by_game) != set(counts) for by_game in sums[treatment].values()):
            raise ValueError(f"incomplete per-game KL coverage for {treatment}")
        selected, scores = select_medoid(distances)
        matched_control = (
            experiment
            / "league"
            / f"rep-{selected}"
            / "control-uniform"
            / "checkpoints"
            / f"main-0-gen{args.generation}.pt"
        )
        if not matched_control.is_file():
            raise FileNotFoundError(matched_control)
        results[treatment] = {
            "pairwiseSymmetricKl": distances,
            "medoidScores": scores,
            "selectedReplicate": selected,
            "checkpoint": str(paths[treatment][selected]),
            "checkpointSha256": checkpoint_hashes[treatment][selected],
            "matchedControl": str(matched_control),
            "matchedControlSha256": sha256(matched_control),
        }

    corpus_inventory, inventory_sha = inventory(validation)
    return {
        "schemaVersion": "arc-v32-policy-medoid-v1",
        "valid": True,
        "outcomeBlind": True,
        "forbiddenOutcomesInspected": False,
        "generation": args.generation,
        "temperature": args.temperature,
        "precision": "model-forward-float32, logits/probabilities/KL-float64",
        "determinism": {"device": "cpu", "torchThreads": 1, "tieBreak": list(REPLICATES)},
        "validation": {
            "path": str(validation),
            "seed0": args.expected_seed0,
            "seedMax": args.expected_seed0 + args.expected_games - 1,
            "games": len(counts),
            "policyRows": row_count,
            "aggregation": "rows-within-game then equal-game mean",
            "inventorySha256": inventory_sha,
            "files": corpus_inventory,
        },
        "manipulationAudit": {
            "path": str(manipulation_path),
            "sha256": sha256(manipulation_path),
        },
        "checkpointSha256": checkpoint_hashes,
        "treatments": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--manipulation", type=Path, required=True)
    parser.add_argument("--generation", type=int, choices=(8, 12), required=True)
    parser.add_argument("--temperature", type=float, default=0.55)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--expected-games", type=int, default=1024)
    parser.add_argument("--expected-seed0", type=int, default=946004096)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError(f"refusing to overwrite representative freeze: {args.out}")
    result = evaluate(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
