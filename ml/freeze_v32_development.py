#!/usr/bin/env python3
"""Create and verify the fail-closed V32 development-input freeze.

This program never runs an evaluation.  It opens the 949M development block only
after the outcome-blind endpoint rule, all screen roots, checkpoint lineage,
policy-medoid selection, recovery evidence, and evaluation source inventory are
hash-valid.  The resulting manifest and sidecar are write-once inputs to the
development launcher and analyzer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Iterable


REPLICATES = ("a", "b", "c")
ARMS = ("control-uniform", "round-reweighted", "p30-credit025")
TREATMENTS = ("round-reweighted", "p30-credit025")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
GEN_RE = re.compile(r"main-0-gen(\d+)\.pt$")
INFRA_FAILURE_RE = re.compile(
    r"socket|infer(?:ence)?|out of memory|\boom\b|enospc|disk|device|cuda|signal|worker.*exit",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha(value: Any) -> str:
    rendered = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(rendered.encode()).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def require_sha(value: Any, label: str) -> str:
    require(isinstance(value, str) and SHA_RE.fullmatch(value) is not None, f"{label}: invalid SHA-256")
    return value


def finite(value: Any, label: str) -> float:
    number = float(value)
    require(math.isfinite(number), f"{label}: non-finite value")
    return number


def repository_for(experiment: Path) -> Path:
    experiment = experiment.resolve()
    require(experiment.name == "v32-onpolicy-solo", "unexpected V32 experiment directory")
    require(experiment.parent.name == "experiments" and experiment.parent.parent.name == "ml", "experiment must be below ml/experiments")
    return experiment.parents[2]


def display_path(repo: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(repo).as_posix()
    except ValueError:
        return str(resolved)


def resolve_record(repo: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else repo / path


def file_record(repo: Path, path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing file: {path}")
    return {"path": display_path(repo, path), "bytes": path.stat().st_size, "sha256": sha256(path)}


def verify_record(repo: Path, record: dict[str, Any], label: str) -> None:
    require(isinstance(record, dict), f"{label}: invalid file record")
    path = resolve_record(repo, str(record.get("path", "")))
    require(path.is_file(), f"{label}: missing {path}")
    require(path.stat().st_size == int(record.get("bytes", -1)), f"{label}: byte size changed")
    require(sha256(path) == require_sha(record.get("sha256"), label), f"{label}: hash changed")


def inventory(repo: Path, root: Path) -> dict[str, Any]:
    files = sorted(path for path in root.rglob("*") if path.is_file())
    require(bool(files), f"empty inventory root: {root}")
    entries = [file_record(repo, path) for path in files]
    digest = hashlib.sha256()
    for entry in entries:
        relative_text = path_relative(resolve_record(repo, entry["path"]), root)
        digest.update(f"{relative_text}\0{entry['bytes']}\0{entry['sha256']}\n".encode())
    return {
        "path": display_path(repo, root),
        "inventorySha256": digest.hexdigest(),
        "files": [
            {**entry, "relativePath": path_relative(resolve_record(repo, entry["path"]), root)}
            for entry in entries
        ],
    }


def path_relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def verify_inventory(repo: Path, value: dict[str, Any], label: str) -> None:
    root = resolve_record(repo, str(value.get("path", ""))).resolve()
    entries = value.get("files")
    require(isinstance(entries, list) and entries, f"{label}: empty inventory")
    expected_relatives = []
    digest = hashlib.sha256()
    for index, entry in enumerate(entries):
        verify_record(repo, entry, f"{label}[{index}]")
        path = resolve_record(repo, entry["path"])
        relative = path_relative(path, root)
        require(relative == entry.get("relativePath"), f"{label}[{index}]: relative path mismatch")
        expected_relatives.append(relative)
        digest.update(f"{relative}\0{entry['bytes']}\0{entry['sha256']}\n".encode())
    actual_relatives = sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())
    require(expected_relatives == actual_relatives, f"{label}: file set changed")
    require(digest.hexdigest() == value.get("inventorySha256"), f"{label}: inventory hash mismatch")


def verify_screen_lock(repo: Path, path: Path) -> dict[str, Any]:
    lock = load_json(path)
    require(lock.get("schemaVersion") == "arc-v32-input-lock-v1", "unexpected screen-lock schema")
    require(lock.get("phase") == "screen", "screen lock has wrong phase")
    files = lock.get("files")
    require(isinstance(files, dict) and files, "screen lock has no files")
    for name, expected in files.items():
        target = repo / name
        require(target.is_file(), f"screen-lock input missing: {name}")
        require(sha256(target) == require_sha(expected, f"screen lock {name}"), f"screen-lock hash mismatch: {name}")
    return lock


def validate_manipulation(path: Path, generation: int) -> dict[str, Any]:
    audit = load_json(path)
    require(audit.get("schemaVersion") == "arc-v32-manipulation-audit-v1", f"{path}: wrong schema")
    require(audit.get("valid") is True, f"{path}: invalid manipulation audit")
    require(int(audit.get("generation", -1)) == generation, f"{path}: wrong generation")
    require(audit.get("performanceOutcomesInspected") is False, f"{path}: outcome inspection is forbidden")
    require(audit.get("endpointRule") == "generation 8 unless movement fails, then all roots continue unchanged to generation 12", f"{path}: endpoint rule changed")
    require(isinstance(audit.get("models"), dict), f"{path}: missing models")
    require(isinstance(audit.get("manipulation", {}).get("passed"), bool), f"{path}: missing pass decision")
    disposition = "eligible-endpoint" if audit["manipulation"]["passed"] else "inconclusive-underdosed"
    require(audit.get("disposition") == disposition, f"{path}: inconsistent disposition")
    return audit


def choose_endpoint(experiment: Path) -> tuple[int, list[tuple[Path, dict[str, Any]]]]:
    gen8_path = experiment / "artifacts" / "manipulation-gen8.json"
    require(gen8_path.is_file(), "generation-8 manipulation audit is required")
    gen8 = validate_manipulation(gen8_path, 8)
    if gen8["manipulation"]["passed"]:
        require(not (experiment / "artifacts" / "manipulation-gen12.json").exists(), "generation 12 exists even though generation 8 passed")
        return 8, [(gen8_path, gen8)]
    gen12_path = experiment / "artifacts" / "manipulation-gen12.json"
    require(gen12_path.is_file(), "generation-8 movement failed; valid generation-12 audit is required")
    gen12 = validate_manipulation(gen12_path, 12)
    require(gen12["manipulation"]["passed"] is True, "generation-12 manipulation audit did not pass")
    return 12, [(gen8_path, gen8), (gen12_path, gen12)]


def expected_training_seed(config: dict[str, Any], generation: int) -> tuple[int, int, int]:
    schedule = config["seedSchedule"]
    first = int(schedule["trainBase"]) + (generation - 1) * int(schedule["trainStride"])
    count = int(config["gamesPerGen"])
    return first, first + count - 1, count


def expected_eval_seed(config: dict[str, Any], generation: int) -> tuple[int, int, int]:
    schedule = config["seedSchedule"]
    first = int(schedule["evalBase"]) + (generation - 1) * int(schedule["evalStride"])
    count = int(config["evalGames"])
    return first, first + count - 1, count


def validate_seed_summary(actual: Any, expected: tuple[int, int, int], label: str) -> None:
    require(isinstance(actual, dict), f"{label}: missing seed summary")
    require((int(actual.get("min", -1)), int(actual.get("max", -1)), int(actual.get("count", -1))) == expected, f"{label}: wrong seed set")


def validate_generation(
    repo: Path,
    root: Path,
    config: dict[str, Any],
    generation: int,
    previous_checkpoint: Path,
    catalog_sha: str,
    gates: dict[str, Any],
) -> tuple[dict[str, Any], Path]:
    audit_path = root / "artifacts" / f"gen{generation}-audit.json"
    audit = load_json(audit_path)
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    manifest = checkpoint.with_suffix(".manifest.json")
    require(audit.get("schemaVersion") == "arc-v32-generation-audit-v1" and audit.get("valid") is True, f"{root}: invalid generation {generation} audit")
    require(int(audit.get("generation", -1)) == generation, f"{root}: audit generation mismatch")
    expected_root_suffix = root.resolve().relative_to(repo.resolve()).as_posix()
    require(str(audit.get("root", "")).rstrip("/").endswith(expected_root_suffix), f"{root}: audit root mismatch")
    validate_seed_summary(audit.get("trainingSeeds"), expected_training_seed(config, generation), f"{root} gen{generation} training")
    validate_seed_summary(audit.get("evaluationSeeds"), expected_eval_seed(config, generation), f"{root} gen{generation} eval")
    require(int(audit.get("games", -1)) == int(config["gamesPerGen"]), f"{root}: wrong game count")
    require(int(audit.get("stalls", -1)) == 0 and int(audit.get("evaluationStalls", -1)) == 0, f"{root}: stall in generation {generation}")
    require(int(audit.get("rows", 0)) > 0 and int(audit.get("policyRows", 0)) > 0, f"{root}: missing telemetry rows")
    for key in ("roundCounts", "policyRoundCounts"):
        counts = audit.get(key)
        require(isinstance(counts, dict) and set(counts) == {"1-8", "9-18", "19-30"}, f"{root}: missing round telemetry")
        require(all(int(value) >= 0 for value in counts.values()), f"{root}: invalid round counts")
    require(sha256(previous_checkpoint) == audit.get("behaviorCheckpointSha256"), f"{root}: checkpoint lineage mismatch at gen {generation}")
    require(finite(audit.get("behaviorLogpMaxAbsError"), "behavior logp") <= float(gates["maxBehaviorLogpReconstructionError"]), f"{root}: behavior logp gate failed")
    calibration = audit.get("behaviorReach30Calibration")
    require(isinstance(calibration, dict), f"{root}: missing calibration")
    require(finite(calibration.get("ece"), "calibration ECE") <= float(gates["maxBehaviorReach30Ece"]), f"{root}: ECE gate failed")
    epoch_metrics = audit.get("epochMetrics")
    require(isinstance(epoch_metrics, list) and len(epoch_metrics) == int(config["train"]["epochs"]), f"{root}: wrong epoch telemetry")
    for metric in epoch_metrics:
        require(int(metric.get("optimizerSteps", -1)) == int(gates["exactOptimizerStepsPerEpoch"]), f"{root}: optimizer-step gate failed")
        require(finite(metric.get("approxKl"), "approx KL") <= float(gates["maxApproxKl"]), f"{root}: KL gate failed")
        require(finite(metric.get("roundWeightedKl"), "weighted KL") <= float(gates["maxApproxKl"]), f"{root}: weighted KL gate failed")
        require(finite(metric.get("clipFraction"), "clip fraction") <= float(gates["maxClipFraction"]), f"{root}: clip gate failed")
        require(finite(metric.get("roundWeightedClipFraction"), "weighted clip fraction") <= float(gates["maxClipFraction"]), f"{root}: weighted clip gate failed")
    require(checkpoint.is_file() and manifest.is_file(), f"{root}: missing generation {generation} checkpoint")
    checkpoint_sha = sha256(checkpoint)
    manifest_sha = sha256(manifest)
    require(audit.get("checkpointSha256") == checkpoint_sha, f"{root}: audited checkpoint hash mismatch")
    require(audit.get("manifestSha256") == manifest_sha, f"{root}: audited manifest hash mismatch")
    manifest_data = load_json(manifest)
    require(manifest_data.get("format") == "arc-entity-scorer-v2" and int(manifest_data.get("obs_version", -1)) == 2, f"{root}: invalid endpoint manifest")
    require(int(manifest_data.get("obs_flat_len", -1)) == 3419 and int(manifest_data.get("act_dim", -1)) == 104, f"{root}: endpoint dimensions changed")
    require(int(manifest_data.get("d_model", -1)) == int(config["v2"]["dModel"]), f"{root}: endpoint width changed")
    require(int(manifest_data.get("layers", -1)) == int(config["v2"]["layers"]) and int(manifest_data.get("heads", -1)) == int(config["v2"]["heads"]), f"{root}: endpoint architecture changed")
    record = {
        "generation": generation,
        "audit": file_record(repo, audit_path),
        "checkpoint": file_record(repo, checkpoint),
        "manifest": file_record(repo, manifest),
        "behaviorCheckpointSha256": sha256(previous_checkpoint),
        "trainingSeeds": {"min": expected_training_seed(config, generation)[0], "max": expected_training_seed(config, generation)[1], "count": expected_training_seed(config, generation)[2]},
        "evaluationSeeds": {"min": expected_eval_seed(config, generation)[0], "max": expected_eval_seed(config, generation)[1], "count": expected_eval_seed(config, generation)[2]},
        "rows": int(audit["rows"]),
        "policyRows": int(audit["policyRows"]),
        "stalls": 0,
        "evaluationStalls": 0,
    }
    return record, checkpoint


def validate_history(repo: Path, root: Path, config: dict[str, Any], endpoint: int, catalog_sha: str, generation_records: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = root / "history.jsonl"
    require(path.is_file(), f"{root}: history is missing")
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    require(len(rows) == endpoint, f"{root}: expected exactly {endpoint} history rows")
    require([int(row.get("gen", -1)) for row in rows] == list(range(1, endpoint + 1)), f"{root}: history generation set is not exact")
    for generation, (row, generation_record) in enumerate(zip(rows, generation_records), 1):
        require(row.get("lane") == "main-0" and row.get("kind") == "main" and row.get("model") == "v2", f"{root}: wrong history lane")
        require(row.get("catalogSha256") == catalog_sha, f"{root}: history catalog mismatch")
        require(int(row.get("games", -1)) == int(config["gamesPerGen"]) and int(row.get("evalGames", -1)) == int(config["evalGames"]), f"{root}: history game count mismatch")
        require(int(row.get("samples", -1)) > 0, f"{root}: history samples missing")
        expected_trainer_seed = int(config["seedBase"]) + generation * 1_000_003 + 73
        require(int(row.get("trainerSeed", -1)) == expected_trainer_seed, f"{root}: trainer seed mismatch")
        expected_steps = int(config["train"]["epochs"]) * 196
        require(int(row.get("optimizerStepsPerEpoch", -1)) == 196 and int(row.get("optimizerStepsTotal", -1)) == expected_steps, f"{root}: history optimizer steps mismatch")
        require(int(row.get("samples", -1)) == int(generation_record["rows"]), f"{root}: history/audit sample count mismatch")
        require(finite(row.get("evalStallRate"), "eval stall rate") == 0, f"{root}: history contains eval stalls")
        require(row.get("promoted") is None, f"{root}: screen unexpectedly promoted a checkpoint")
        require(str(row.get("ckpt", "")).endswith(generation_record["checkpoint"]["path"]), f"{root}: history checkpoint mismatch")
    return file_record(repo, path), rows


def recovery_records(repo: Path, root: Path, config: dict[str, Any], generations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    artifacts = root / "artifacts"
    failures: list[tuple[Path, dict[str, Any]]] = []
    recoveries: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(artifacts.glob("*.json")):
        value = load_json(path)
        if value.get("schemaVersion") == "arc-v32-failure-evidence-v1":
            failures.append((path, value))
        elif value.get("schemaVersion") == "arc-v32-recovery-verification-v1":
            recoveries.append((path, value))
    by_failure = {str(value.get("failureEvidence")): (path, value) for path, value in recoveries}
    result = []
    for failure_path, failure in failures:
        rel_failure = display_path(repo, failure_path)
        require(failure.get("validTrainingArtifact") is False, f"{failure_path}: failed attempt cannot be a training artifact")
        require(INFRA_FAILURE_RE.search(str(failure.get("failure", ""))) is not None, f"{failure_path}: failure is not infrastructure-attributed")
        generation = int(failure.get("stateAtFailure", {}).get("gen", -1)) + 1
        details = failure.get(f"generation{generation}")
        require(isinstance(details, dict), f"{failure_path}: missing generation details")
        require(details.get("checkpointCreated") is False and details.get("trainingStarted") is False and details.get("auditCreated") is False, f"{failure_path}: unsafe retry evidence")
        validate_seed_summary(details.get("scheduledTrainingSeeds"), expected_training_seed(config, generation), f"{failure_path}: scheduled seeds")
        preserved = failure.get("preserved")
        require(isinstance(preserved, dict), f"{failure_path}: missing preserved evidence")
        preserved_records = []
        for key, value in preserved.items():
            if key.endswith("Sha256") or key in ("checkpoint", "checkpointSha256"):
                continue
            sha_key = f"{key}Sha256"
            if isinstance(value, str) and sha_key in preserved:
                path = resolve_record(repo, value)
                require(path.is_file() and sha256(path) == preserved[sha_key], f"{failure_path}: preserved {key} changed")
                preserved_records.append(file_record(repo, path))
        previous = resolve_record(repo, str(preserved.get("checkpoint", "")))
        require(previous.is_file() and sha256(previous) == preserved.get("checkpointSha256"), f"{failure_path}: recovery checkpoint changed")
        recovery_entry = by_failure.get(rel_failure)
        require(recovery_entry is not None, f"{failure_path}: missing recovery verification")
        recovery_path, recovery = recovery_entry
        require(recovery.get("valid") is True and recovery.get("sameSeedRetry") is True and int(recovery.get("retryOrdinal", -1)) == 1, f"{recovery_path}: invalid recovery")
        recovered = recovery.get(f"generation{generation}")
        require(isinstance(recovered, dict), f"{recovery_path}: missing recovered generation")
        validate_seed_summary(recovered.get("trainingSeeds"), expected_training_seed(config, generation), f"{recovery_path}: recovered seeds")
        require(int(recovered.get("games", -1)) == int(config["gamesPerGen"]) and int(recovered.get("stalls", -1)) == 0 and int(recovered.get("evaluationStalls", -1)) == 0, f"{recovery_path}: incomplete recovered generation")
        generation_record = generations[generation - 1]
        require(recovered.get("checkpointSha256") == generation_record["checkpoint"]["sha256"], f"{recovery_path}: recovered checkpoint mismatch")
        require(recovered.get("auditSha256") == generation_record["audit"]["sha256"], f"{recovery_path}: recovered audit mismatch")
        result.append({"failure": file_record(repo, failure_path), "recovery": file_record(repo, recovery_path), "preserved": preserved_records, "generation": generation, "retryOrdinal": 1})
    require(len(recoveries) == len(failures), f"{root}: unmatched recovery-verification artifact")
    return result


def validate_root(repo: Path, experiment: Path, protocol: dict[str, Any], replicate: str, arm: str, endpoint: int) -> dict[str, Any]:
    root = experiment / "league" / f"rep-{replicate}" / arm
    config_path = root / "config.json"
    state_path = root / "state.json"
    config = load_json(config_path)
    state = load_json(state_path)
    screen = protocol["screen"]
    replicate_protocol = next(item for item in screen["replicates"] if item["id"] == replicate)
    arm_protocol = next(item for item in screen["arms"] if item["id"] == arm)
    require(config.get("catalogSha256") == protocol["catalog"]["sha256"], f"{root}: config catalog mismatch")
    require(config.get("seedBase") == replicate_protocol["seedBase"], f"{root}: seed base mismatch")
    schedule = config.get("seedSchedule")
    require(schedule == {"trainBase": replicate_protocol["trainBase"], "trainStride": screen["seedSchedule"]["trainStride"], "evalBase": replicate_protocol["evalBase"], "evalStride": screen["seedSchedule"]["evalStride"], "maxGeneration": screen["seedSchedule"]["maxGeneration"]}, f"{root}: seed schedule mismatch")
    require(int(config.get("gamesPerGen", -1)) == 1024 and int(config.get("evalGames", -1)) == 256, f"{root}: game budget mismatch")
    require(int(config.get("workers", -1)) == 24 and int(config.get("matchupConcurrency", -1)) == 1, f"{root}: runtime mismatch")
    require(config.get("sample") is True and finite(config.get("temperature"), "temperature") == 0.55, f"{root}: decode mismatch")
    require(int(config.get("seats", -1)) == 1 and int(config.get("maxRounds", -1)) == 30 and int(config.get("soloMaxStatusLevel", -1)) == 2, f"{root}: game contract mismatch")
    require(config.get("guardianSchedule") == "absolute-balanced" and config.get("selection") == "hybrid", f"{root}: guardian/selection mismatch")
    require(config.get("promoteEvery") == 0 and config.get("v2", {}).get("distillEveryGen") is False, f"{root}: promotion or distillation enabled")
    require(config.get("laneInit", {}).get("main-0") == "ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt", f"{root}: wrong initial checkpoint")
    extra = config.get("train", {}).get("extraArgs", [])
    reach_index = max(index for index, value in enumerate(extra) if value == "--solo-reach30-coef")
    require(float(extra[reach_index + 1]) == float(arm_protocol["soloReach30Coef"]), f"{root}: reach30 arm mismatch")
    configured_bands = None
    if "--ppo-round-policy-bands" in extra:
        band_index = max(index for index, value in enumerate(extra) if value == "--ppo-round-policy-bands")
        configured_bands = [[int(a), float(b)] for a, b in (item.split(":") for item in extra[band_index + 1].split(","))]
    require(configured_bands == arm_protocol["roundPolicyBands"], f"{root}: round-weight arm mismatch")
    require(int(state.get("gen", -1)) == endpoint and state.get("phase") == "idle", f"{root}: state is not exactly idle generation {endpoint}")
    main_members = [member for member in state.get("members", []) if member.get("id") == "main-0"]
    require(len(main_members) == 1 and main_members[0].get("model") == "v2", f"{root}: invalid main member")
    shared = experiment / "shared-critic" / "checkpoint.pt"
    previous = shared
    generation_records = []
    for generation in range(1, endpoint + 1):
        record, previous = validate_generation(repo, root, config, generation, previous, protocol["catalog"]["sha256"], screen["perGenerationTrustGates"])
        generation_records.append(record)
    actual_checkpoints = sorted(int(match.group(1)) for path in (root / "checkpoints").glob("main-0-gen*.pt") if (match := GEN_RE.search(path.name)))
    require(actual_checkpoints == list(range(1, endpoint + 1)), f"{root}: checkpoint generation set is not exact")
    actual_manifests = sorted(int(match.group(1)) for path in (root / "checkpoints").glob("main-0-gen*.manifest.json") if (match := re.search(r"main-0-gen(\d+)\.manifest\.json$", path.name)))
    require(actual_manifests == list(range(1, endpoint + 1)), f"{root}: manifest generation set is not exact")
    actual_audits = sorted(int(match.group(1)) for path in (root / "artifacts").glob("gen*-audit.json") if (match := re.search(r"gen(\d+)-audit\.json$", path.name)))
    require(actual_audits == list(range(1, endpoint + 1)), f"{root}: audit generation set is not exact")
    endpoint_record = generation_records[-1]
    require(str(main_members[0].get("ptPath", "")).endswith(endpoint_record["checkpoint"]["path"]), f"{root}: state checkpoint mismatch")
    history_record, _ = validate_history(repo, root, config, endpoint, protocol["catalog"]["sha256"], generation_records)
    recoveries = recovery_records(repo, root, config, generation_records)
    return {
        "replicate": replicate,
        "arm": arm,
        "root": display_path(repo, root),
        "config": file_record(repo, config_path),
        "state": file_record(repo, state_path),
        "history": {**history_record, "rows": endpoint},
        "generationAudits": generation_records,
        "endpoint": {"checkpoint": endpoint_record["checkpoint"], "manifest": endpoint_record["manifest"]},
        "recoveryEvidence": recoveries,
    }


def validate_protocol(protocol: dict[str, Any]) -> None:
    require(protocol.get("schemaVersion") == "arc-controlled-experiment-v1" and protocol.get("status") == "screen-frozen", "protocol is not screen-frozen")
    development = protocol.get("development")
    require(development == {"seed0": 949000000, "games": 4096, "open": False, "comparators": ["V23", "V30", "shared-critic", "nine final screen checkpoints"], "familySize": 2}, "development protocol changed")
    runtime = protocol.get("screen", {}).get("runtime", {})
    require(runtime.get("workersPerRoot") == 24 and runtime.get("maxConcurrentRoots") == 4 and runtime.get("maxActorThreads") == 96, "runtime protocol changed")
    require(runtime.get("gpuWaveOrder") == [5, 6, 7, 0] and runtime.get("excludedGpu") == 4, "GPU protocol changed")


def validate_representatives(repo: Path, experiment: Path, path: Path, endpoint: int, selected_manipulation: Path, roots: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    value = load_json(path)
    require(value.get("schemaVersion") == "arc-v32-policy-medoid-v1" and value.get("valid") is True, "invalid representative artifact")
    require(value.get("outcomeBlind") is True and value.get("forbiddenOutcomesInspected") is False, "representative selection inspected outcomes")
    require(int(value.get("generation", -1)) == endpoint and finite(value.get("temperature"), "medoid temperature") == 0.55, "representative endpoint/decode mismatch")
    require(value.get("precision") == "model-forward-float32, logits/probabilities/KL-float64", "representative precision contract changed")
    require(value.get("determinism") == {"device": "cpu", "torchThreads": 1, "tieBreak": list(REPLICATES)}, "representative determinism contract changed")
    require(value.get("manipulationAudit", {}).get("sha256") == sha256(selected_manipulation), "representative manipulation hash mismatch")
    require(set(value.get("checkpointSha256", {})) == set(TREATMENTS), "representative treatment set changed")
    representatives = {}
    for treatment in TREATMENTS:
        treatment_value = value.get("treatments", {}).get(treatment)
        require(isinstance(treatment_value, dict), f"missing representative {treatment}")
        scores = treatment_value.get("medoidScores")
        require(isinstance(scores, dict) and set(scores) == set(REPLICATES), f"{treatment}: invalid medoid scores")
        distances = treatment_value.get("pairwiseSymmetricKl")
        require(isinstance(distances, dict) and set(distances) == {"a-b", "a-c", "b-c"}, f"{treatment}: invalid pairwise distances")
        distance_values = {name: finite(distance, f"{treatment} {name}") for name, distance in distances.items()}
        require(all(distance >= 0 for distance in distance_values.values()), f"{treatment}: negative pairwise distance")
        expected_scores = {
            "a": (distance_values["a-b"] + distance_values["a-c"]) / 2,
            "b": (distance_values["a-b"] + distance_values["b-c"]) / 2,
            "c": (distance_values["a-c"] + distance_values["b-c"]) / 2,
        }
        require(all(math.isclose(finite(scores[replicate], "medoid score"), expected_scores[replicate], rel_tol=0, abs_tol=1e-15) for replicate in REPLICATES), f"{treatment}: medoid scores do not match pairwise distances")
        selected = min(REPLICATES, key=lambda replicate: (finite(scores[replicate], "medoid score"), REPLICATES.index(replicate)))
        require(treatment_value.get("selectedReplicate") == selected, f"{treatment}: medoid selection mismatch")
        treatment_label = f"rep-{selected}-{treatment}"
        control_label = f"rep-{selected}-control-uniform"
        treatment_sha = roots[treatment_label]["endpoint"]["checkpoint"]["sha256"]
        control_sha = roots[control_label]["endpoint"]["checkpoint"]["sha256"]
        require(treatment_value.get("checkpointSha256") == treatment_sha, f"{treatment}: selected checkpoint mismatch")
        require(treatment_value.get("matchedControlSha256") == control_sha, f"{treatment}: matched control mismatch")
        require(value["checkpointSha256"][treatment] == {replicate: roots[f"rep-{replicate}-{treatment}"]["endpoint"]["checkpoint"]["sha256"] for replicate in REPLICATES}, f"{treatment}: endpoint inventory mismatch")
        representatives[treatment] = {
            "selectedReplicate": selected,
            "treatmentPolicyLabel": treatment_label,
            "controlPolicyLabel": control_label,
            "checkpointSha256": treatment_sha,
            "matchedControlSha256": control_sha,
            "medoidScore": float(scores[selected]),
            "pairwiseSymmetricKl": treatment_value.get("pairwiseSymmetricKl"),
        }
    validation = value.get("validation")
    require(isinstance(validation, dict) and int(validation.get("seed0", -1)) == 946004096 and int(validation.get("seedMax", -1)) == 946005119 and int(validation.get("games", -1)) == 1024 and int(validation.get("policyRows", 0)) > 0, "representative validation coverage mismatch")
    allowed_top = {"schemaVersion", "valid", "outcomeBlind", "forbiddenOutcomesInspected", "generation", "temperature", "precision", "determinism", "validation", "manipulationAudit", "checkpointSha256", "treatments"}
    require(set(value) == allowed_top, "representative artifact contains unregistered fields")
    return value, representatives, validation


def evaluation_source_inventory(repo: Path) -> tuple[dict[str, str], list[str], str]:
    explicit = [
        "package.json",
        "package-lock.json",
        "ml/freeze_v32_development.py",
        "ml/test_freeze_v32_development.py",
        "ml/select_v32_representatives.py",
        "ml/test_select_v32_representatives.py",
        "ml/analyze_v32_development.py",
        "ml/test_analyze_v32_development.py",
        "ml/benchmark_infer_latency.py",
        "ml/test_benchmark_infer_latency.py",
        "ml/infer_server.py",
        "ml/model_v2.py",
        "ml/obs_v2.py",
        "scripts/evaluate-solo-checkpoint.mjs",
        "scripts/run-v32-development-eval.sh",
        "ml/experiments/v32-onpolicy-solo/plan.md",
        "ml/experiments/v32-onpolicy-solo/evaluation-plan.md",
        "ml/experiments/v32-onpolicy-solo/fable-review.md",
        "ml/experiments/v32-onpolicy-solo/evaluation-fable-review.md",
    ]
    root_name = "src/lib/play"
    play_files = [display_path(repo, path) for path in sorted((repo / root_name).rglob("*")) if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"]
    names = sorted(set(explicit + play_files))
    values = {}
    for name in names:
        path = repo / name
        require(path.is_file(), f"missing evaluation source: {name}")
        values[name] = sha256(path)
    return values, [root_name], canonical_sha(values)


def create_freeze(experiment: Path, validation_path: Path, representatives_path: Path) -> dict[str, Any]:
    experiment = experiment.resolve()
    repo = repository_for(experiment)
    protocol_path = experiment / "protocol.json"
    screen_lock_path = experiment / "artifacts" / "screen-lock.json"
    protocol = load_json(protocol_path)
    validate_protocol(protocol)
    verify_screen_lock(repo, screen_lock_path)
    require(sha256(repo / protocol["catalog"]["path"]) == protocol["catalog"]["sha256"], "catalog hash mismatch")
    endpoint, manipulation_audits = choose_endpoint(experiment)
    roots = {}
    for replicate in REPLICATES:
        for arm in ARMS:
            label = f"rep-{replicate}-{arm}"
            roots[label] = validate_root(repo, experiment, protocol, replicate, arm, endpoint)
    for manipulation_path, manipulation in manipulation_audits:
        manipulation_generation = int(manipulation["generation"])
        for replicate in REPLICATES:
            for arm in ARMS:
                expected = roots[f"rep-{replicate}-{arm}"]["generationAudits"][manipulation_generation - 1]["checkpoint"]["sha256"]
                require(manipulation["models"][replicate][arm]["sha256"] == expected, f"{manipulation_path}: model hash mismatch for {replicate}/{arm}")
        require(manipulation.get("base", {}).get("sha256") == sha256(experiment / "shared-critic" / "checkpoint.pt"), f"{manipulation_path}: base hash mismatch")
    require(sum(len(root["recoveryEvidence"]) for root in roots.values()) <= 1, "the frozen screen permits at most one documented environment-only retry")
    selected_manipulation_path = manipulation_audits[-1][0]
    representatives_value, representatives, representative_validation = validate_representatives(repo, experiment, representatives_path, endpoint, selected_manipulation_path, roots)
    corpus = inventory(repo, validation_path.resolve())
    require(corpus["inventorySha256"] == representative_validation.get("inventorySha256"), "medoid validation inventory hash mismatch")
    selector_files = representative_validation.get("files")
    require(isinstance(selector_files, list) and len(selector_files) == len(corpus["files"]), "medoid validation file inventory length mismatch")
    selector_by_relative = {entry["path"]: entry for entry in selector_files}
    for entry in corpus["files"]:
        selected = selector_by_relative.get(entry["relativePath"])
        require(selected is not None and selected.get("sha256") == entry["sha256"] and int(selected.get("bytes", -1)) == entry["bytes"], "medoid validation file hash mismatch")

    policies: dict[str, Any] = {}
    comparator_paths = {
        "v23": repo / "ml/warmstart/v24/v23-control-gen5-obs199-act104.json",
        "v30": resolve_record(repo, protocol["initialPolicy"]["path"]),
        "shared-critic": experiment / "shared-critic" / "checkpoint.pt",
    }
    for label, path in comparator_paths.items():
        obs = 1 if label == "v23" else 2
        policy = {"role": "comparator", "weights": display_path(repo, path), "weightsSha256": sha256(path), "policyObsVersion": obs}
        manifest = path.with_suffix(".manifest.json")
        if manifest.is_file():
            policy.update({"manifest": display_path(repo, manifest), "manifestSha256": sha256(manifest)})
        policies[label] = policy
    require(policies["v30"]["weightsSha256"] == protocol["initialPolicy"]["sha256"], "V30 comparator hash mismatch")
    screen_lock = load_json(screen_lock_path)
    require(policies["shared-critic"]["weightsSha256"] == screen_lock["files"]["ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"], "shared critic comparator hash mismatch")
    for label, root_value in roots.items():
        policies[label] = {
            "role": "screen-endpoint",
            "replicate": root_value["replicate"],
            "arm": root_value["arm"],
            "weights": root_value["endpoint"]["checkpoint"]["path"],
            "weightsSha256": root_value["endpoint"]["checkpoint"]["sha256"],
            "manifest": root_value["endpoint"]["manifest"]["path"],
            "manifestSha256": root_value["endpoint"]["manifest"]["sha256"],
            "policyObsVersion": 2,
        }
    require(len(policies) == 12, "development must freeze exactly 12 policies")

    contract = {
        "seed0": 949000000,
        "seedMax": 949004095,
        "games": 4096,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "selection": "hybrid",
        "sample": True,
        "temperature": 0.55,
        "guardianSchedule": "absolute-balanced",
        "includeGames": True,
        "workersPerPolicy": 24,
        "maxConcurrentPolicies": 4,
        "maxActorThreads": 96,
        "gpuWaveOrder": [5, 6, 7, 0],
        "excludedGpu": 4,
        "binaryInferenceObsVersion": 2,
        "v23ObsVersion": 1,
        "retry": {"maxInfrastructureRetries": 1, "automaticRetry": False, "outcomeBlind": True, "quarantineBeforeInspection": True},
    }
    sources, source_roots, source_inventory_sha = evaluation_source_inventory(repo)
    source_contract_sha = canonical_sha({"evaluationSources": sources, "developmentContract": contract})
    return {
        "schemaVersion": "arc-v32-development-freeze-v1",
        "valid": True,
        "immutable": True,
        "outcomeBlindEndpointSelection": True,
        "experiment": display_path(repo, experiment),
        "endpointGeneration": endpoint,
        "screenLock": {**file_record(repo, screen_lock_path), "verified": True},
        "protocol": file_record(repo, protocol_path),
        "catalog": file_record(repo, resolve_record(repo, protocol["catalog"]["path"])),
        "manipulation": {
            f"gen{generation}": {**file_record(repo, path), "passed": audit["manipulation"]["passed"]}
            for path, audit in manipulation_audits
            for generation in [int(audit["generation"])]
        }
        | {"selected": file_record(repo, selected_manipulation_path)},
        "validationCorpus": corpus,
        "representativeSelection": {**file_record(repo, representatives_path), "schemaVersion": representatives_value["schemaVersion"], "treatments": representatives_value["treatments"]},
        "roots": roots,
        "policies": policies,
        "representatives": representatives,
        "evaluationSourceRoots": source_roots,
        "evaluationSources": sources,
        "evaluationSourceInventorySha256": source_inventory_sha,
        "developmentContract": contract,
        "authorization": {
            "developmentSeedsOpen": False,
            "hiddenSeedsOpen": False,
            "preDevelopmentDiagnosticsOpen": True,
            "diagnosticSeedMin": 951920000,
            "diagnosticSeedMax": 951920255,
            "sourceContractSha256": source_contract_sha,
        },
    }


def sidecar_path(manifest: Path) -> Path:
    return manifest.with_suffix(manifest.suffix + ".sha256")


def write_freeze(path: Path, value: dict[str, Any]) -> None:
    sidecar = sidecar_path(path)
    require(not path.exists() and not sidecar.exists(), f"refusing to overwrite immutable freeze: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(value, indent=2, sort_keys=True) + "\n"
    temporary = path.with_suffix(path.suffix + ".tmp")
    sidecar_temporary = sidecar.with_suffix(sidecar.suffix + ".tmp")
    temporary.write_text(rendered)
    digest = sha256(temporary)
    sidecar_temporary.write_text(f"{digest}  {path.name}\n")
    temporary.replace(path)
    sidecar_temporary.replace(sidecar)
    os.chmod(path, 0o444)
    os.chmod(sidecar, 0o444)


def verify_freeze(path: Path) -> dict[str, Any]:
    path = path.resolve()
    value = load_json(path)
    require(value.get("schemaVersion") == "arc-v32-development-freeze-v1" and value.get("valid") is True and value.get("immutable") is True, "invalid development freeze")
    # The normal location is <repo>/ml/experiments/v32-onpolicy-solo/artifacts.
    if path.parent.name == "artifacts" and path.parent.parent.name == "v32-onpolicy-solo":
        experiment = path.parent.parent
        repo = repository_for(experiment)
    else:
        experiment = resolve_record(Path.cwd(), value["experiment"])
        repo = repository_for(experiment)
    sidecar = sidecar_path(path)
    require(sidecar.is_file(), "development freeze sidecar is missing")
    fields = sidecar.read_text().strip().split()
    require(len(fields) == 2 and fields[0] == sha256(path) and fields[1] == path.name, "development freeze sidecar mismatch")
    for label in ("screenLock", "protocol", "catalog", "representativeSelection"):
        verify_record(repo, value[label], label)
    for label, record in value["manipulation"].items():
        verify_record(repo, record, f"manipulation/{label}")
    verify_inventory(repo, value["validationCorpus"], "validation corpus")
    for label, root in value["roots"].items():
        for name in ("config", "state", "history"):
            verify_record(repo, root[name], f"{label}/{name}")
        for generation in root["generationAudits"]:
            for name in ("audit", "checkpoint", "manifest"):
                verify_record(repo, generation[name], f"{label}/gen{generation['generation']}/{name}")
        for recovery in root["recoveryEvidence"]:
            verify_record(repo, recovery["failure"], f"{label}/recovery/failure")
            verify_record(repo, recovery["recovery"], f"{label}/recovery/verification")
            for preserved in recovery["preserved"]:
                verify_record(repo, preserved, f"{label}/recovery/preserved")
    for label, policy in value["policies"].items():
        weights = resolve_record(repo, policy["weights"])
        require(weights.is_file() and sha256(weights) == policy["weightsSha256"], f"{label}: policy weights changed")
        if "manifest" in policy:
            manifest = resolve_record(repo, policy["manifest"])
            require(manifest.is_file() and sha256(manifest) == policy["manifestSha256"], f"{label}: policy manifest changed")
    for name, expected in value["evaluationSources"].items():
        require((repo / name).is_file() and sha256(repo / name) == expected, f"evaluation source changed: {name}")
    for root_name in value["evaluationSourceRoots"]:
        actual = {display_path(repo, item) for item in (repo / root_name).rglob("*") if item.is_file() and "__pycache__" not in item.parts and item.suffix != ".pyc"}
        frozen = {name for name in value["evaluationSources"] if name == root_name or name.startswith(root_name + "/")}
        require(actual == frozen, f"evaluation source file set changed: {root_name}")
    require(canonical_sha(value["evaluationSources"]) == value["evaluationSourceInventorySha256"], "evaluation source inventory hash mismatch")
    require(canonical_sha({"evaluationSources": value["evaluationSources"], "developmentContract": value["developmentContract"]}) == value["authorization"]["sourceContractSha256"], "source contract hash mismatch")
    contract = value["developmentContract"]
    require(contract["seed0"] == 949000000 and contract["seedMax"] == 949004095 and contract["games"] == 4096, "development seed contract changed")
    require(value["authorization"] == {"developmentSeedsOpen": False, "hiddenSeedsOpen": False, "preDevelopmentDiagnosticsOpen": True, "diagnosticSeedMin": 951920000, "diagnosticSeedMax": 951920255, "sourceContractSha256": value["authorization"]["sourceContractSha256"]}, "development freeze must remain closed")
    require(len(value["policies"]) == 12, "freeze does not contain exactly 12 policies")
    return value


def validate_diagnostic_report(repo: Path, freeze: dict[str, Any], path: Path) -> dict[str, Any]:
    report = load_json(path)
    contract = freeze["developmentContract"]
    v30 = freeze["policies"]["v30"]
    require(report.get("schemaVersion") == "solo-heldout-v2", "unexpected V30 diagnostic schema")
    require(int(report.get("seed0", -1)) == 951920000 and int(report.get("games", -1)) == 256, "V30 diagnostic used the wrong seeds")
    require(int(report.get("maxRounds", -1)) == contract["maxRounds"] and int(report.get("maxStatusLevel", -1)) == contract["maxStatusLevel"], "V30 diagnostic game contract mismatch")
    require(report.get("weightsSha256") == v30["weightsSha256"] and report.get("catalogSha256") == freeze["catalog"]["sha256"], "V30 diagnostic input hash mismatch")
    require(report.get("sourceCommit") == freeze["authorization"]["sourceContractSha256"], "V30 diagnostic source contract mismatch")
    decode = report.get("decode")
    require(isinstance(decode, dict) and decode.get("policyObsVersion") == 2 and isinstance(decode.get("inferenceSocket"), str), "V30 diagnostic did not use binary obs-v2 inference")
    require(decode.get("sample") is True and finite(decode.get("temperature"), "diagnostic temperature") == 0.55 and decode.get("learnMonsterRewardChoices") is False, "V30 diagnostic decode mismatch")
    require(int(report.get("stalls", -1)) == 0, "V30 diagnostic stalled")
    per_game = report.get("perGame")
    require(isinstance(per_game, list) and len(per_game) == 256, "V30 diagnostic per-game coverage mismatch")
    seeds = [int(row.get("seed", -1)) for row in per_game]
    require(sorted(seeds) == list(range(951920000, 951920256)) and len(set(seeds)) == 256, "V30 diagnostic seed set mismatch")
    require(all(row.get("stalled") is False for row in per_game), "V30 diagnostic contains a stalled game")
    return report


def validate_latency_smoke(repo: Path, freeze: dict[str, Any], path: Path) -> dict[str, Any]:
    report = load_json(path)
    require(report.get("schemaVersion") == "arc-infer-latency-v1", "unexpected latency-smoke schema")
    server = report.get("server")
    require(isinstance(server, dict) and server.get("format") == "arc-entity-scorer-v2", "latency smoke used the wrong server format")
    require(int(server.get("obs_dim", -1)) == 3419 and int(server.get("act_dim", -1)) == 104, "latency smoke server dimensions changed")
    weights = resolve_record(repo, str(server.get("weights", "")))
    require(weights.is_file() and sha256(weights) == freeze["policies"]["shared-critic"]["weightsSha256"], "latency smoke did not serve the frozen shared critic")
    protocol = report.get("protocol")
    require(protocol == {**protocol, "wire": "binary", "rowsPerRequest": 32, "candidatesPerRow": 30, "clients": 8, "warmupRequestsPerClient": 20, "measuredRequestsPerClient": 200}, "latency smoke protocol mismatch")
    measurement = report.get("measurement")
    require(isinstance(measurement, dict) and int(measurement.get("requests", -1)) == 1600 and int(measurement.get("rows", -1)) == 51200, "latency smoke request coverage mismatch")
    latency = measurement.get("requestLatencyMs")
    require(isinstance(latency, dict) and all(finite(latency.get(key), f"latency {key}") >= 0 for key in ("min", "p50", "p95", "p99", "max", "mean")), "latency smoke has invalid measurements")
    # This smoke test is systems/integrity-only; its p95 is deliberately non-binding.
    return report


def require_success_evidence(path: Path, label: str) -> list[dict[str, Any]]:
    directory = path.parent
    exit_code = directory / "exit-code"
    run_log = directory / "run.log"
    server_log = directory / "server.log"
    require(exit_code.is_file() and exit_code.read_text().strip() == "0", f"{label}: missing successful exit evidence")
    require(run_log.is_file(), f"{label}: run log is missing")
    # The caller records these with its known repository; return paths here.
    return [{"path": str(item.resolve()), "bytes": item.stat().st_size, "sha256": sha256(item)} for item in (exit_code, run_log, server_log) if item.is_file()]


def normalize_evidence_records(repo: Path, records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [file_record(repo, Path(record["path"])) for record in records]


def authorize_development(freeze_path: Path, diagnostic_path: Path, latency_path: Path, tests_exit_path: Path) -> dict[str, Any]:
    freeze = verify_freeze(freeze_path)
    experiment = freeze_path.resolve().parent.parent
    repo = repository_for(experiment)
    validate_diagnostic_report(repo, freeze, diagnostic_path)
    validate_latency_smoke(repo, freeze, latency_path)
    diagnostic_evidence = normalize_evidence_records(repo, require_success_evidence(diagnostic_path, "V30 diagnostic"))
    latency_evidence = normalize_evidence_records(repo, require_success_evidence(latency_path, "latency smoke"))
    require(tests_exit_path.is_file() and tests_exit_path.read_text().strip() == "0", "pre-development unit tests did not pass")
    tests_log = tests_exit_path.parent / "run.log"
    require(tests_log.is_file(), "pre-development unit-test log is missing")
    return {
        "schemaVersion": "arc-v32-development-authorization-v1",
        "valid": True,
        "immutable": True,
        "freeze": file_record(repo, freeze_path),
        "sourceContractSha256": freeze["authorization"]["sourceContractSha256"],
        "preDevelopmentChecks": {
            "unitTests": {"exitCode": file_record(repo, tests_exit_path), "runLog": file_record(repo, tests_log), "passed": True},
            "v30Diagnostic": {"report": file_record(repo, diagnostic_path), "evidence": diagnostic_evidence, "strengthOutcomesInspected": False, "passed": True},
            "sharedCriticLatencySmoke": {"report": file_record(repo, latency_path), "evidence": latency_evidence, "bindingP95Gate": False, "passed": True},
        },
        "authorization": {
            "developmentSeedsOpen": True,
            "hiddenSeedsOpen": False,
            "authorizedSeedMin": 949000000,
            "authorizedSeedMax": 949004095,
            "sourceContractSha256": freeze["authorization"]["sourceContractSha256"],
        },
    }


def verify_authorization(path: Path, freeze_path: Path | None = None) -> dict[str, Any]:
    path = path.resolve()
    value = load_json(path)
    require(value.get("schemaVersion") == "arc-v32-development-authorization-v1" and value.get("valid") is True and value.get("immutable") is True, "invalid development authorization")
    if freeze_path is None:
        candidate = resolve_record(Path.cwd(), value["freeze"]["path"])
        if path.parent.name == "artifacts" and not candidate.is_absolute():
            candidate = path.parent.parent.parents[2] / candidate
        freeze_path = candidate
    freeze = verify_freeze(freeze_path)
    experiment = freeze_path.resolve().parent.parent
    repo = repository_for(experiment)
    sidecar = sidecar_path(path)
    require(sidecar.is_file(), "development authorization sidecar is missing")
    fields = sidecar.read_text().strip().split()
    require(len(fields) == 2 and fields[0] == sha256(path) and fields[1] == path.name, "development authorization sidecar mismatch")
    verify_record(repo, value["freeze"], "authorization freeze")
    require(value["freeze"]["sha256"] == sha256(freeze_path), "authorization points to another freeze")
    checks = value.get("preDevelopmentChecks", {})
    for name in ("unitTests", "v30Diagnostic", "sharedCriticLatencySmoke"):
        require(checks.get(name, {}).get("passed") is True, f"authorization check failed: {name}")
    verify_record(repo, checks["unitTests"]["exitCode"], "unit-test exit")
    verify_record(repo, checks["unitTests"]["runLog"], "unit-test log")
    diagnostic_path = resolve_record(repo, checks["v30Diagnostic"]["report"]["path"])
    latency_path = resolve_record(repo, checks["sharedCriticLatencySmoke"]["report"]["path"])
    verify_record(repo, checks["v30Diagnostic"]["report"], "diagnostic report")
    verify_record(repo, checks["sharedCriticLatencySmoke"]["report"], "latency report")
    for check_name in ("v30Diagnostic", "sharedCriticLatencySmoke"):
        for index, record in enumerate(checks[check_name]["evidence"]):
            verify_record(repo, record, f"{check_name} evidence {index}")
    validate_diagnostic_report(repo, freeze, diagnostic_path)
    validate_latency_smoke(repo, freeze, latency_path)
    require(value["authorization"] == {"developmentSeedsOpen": True, "hiddenSeedsOpen": False, "authorizedSeedMin": 949000000, "authorizedSeedMax": 949004095, "sourceContractSha256": freeze["authorization"]["sourceContractSha256"]}, "development authorization contract changed")
    require(value["sourceContractSha256"] == freeze["authorization"]["sourceContractSha256"], "authorization source contract mismatch")
    return value


def validate_development_report(freeze: dict[str, Any], label: str, path: Path) -> dict[str, Any]:
    report = load_json(path)
    policy = freeze["policies"][label]
    contract = freeze["developmentContract"]
    require(report.get("schemaVersion") == "solo-heldout-v2", f"{label}: unexpected report schema")
    require(int(report.get("seed0", -1)) == contract["seed0"] and int(report.get("games", -1)) == contract["games"], f"{label}: development seed block mismatch")
    require(int(report.get("maxRounds", -1)) == contract["maxRounds"] and int(report.get("maxStatusLevel", -1)) == contract["maxStatusLevel"], f"{label}: game contract mismatch")
    require(report.get("weightsSha256") == policy["weightsSha256"] and report.get("catalogSha256") == freeze["catalog"]["sha256"], f"{label}: frozen input hash mismatch")
    require(report.get("sourceCommit") == freeze["authorization"]["sourceContractSha256"], f"{label}: source contract mismatch")
    decode = report.get("decode")
    require(isinstance(decode, dict) and int(decode.get("policyObsVersion", -1)) == int(policy["policyObsVersion"]), f"{label}: observation decoder mismatch")
    if int(policy["policyObsVersion"]) == 2:
        require(isinstance(decode.get("inferenceSocket"), str) and decode["inferenceSocket"], f"{label}: binary inference transport missing")
    else:
        require("inferenceSocket" not in decode, f"{label}: obs-v1 policy unexpectedly used a socket")
    require(decode.get("sample") is True and finite(decode.get("temperature"), f"{label} temperature") == 0.55 and decode.get("learnMonsterRewardChoices") is False, f"{label}: decode semantics changed")
    per_game = report.get("perGame")
    require(isinstance(per_game, list) and len(per_game) == contract["games"], f"{label}: per-game coverage mismatch")
    seeds = [int(row.get("seed", -1)) for row in per_game]
    expected = list(range(contract["seed0"], contract["seedMax"] + 1))
    require(sorted(seeds) == expected and len(set(seeds)) == contract["games"], f"{label}: missing or duplicate development seed")
    require(int(report.get("stalls", -1)) == sum(bool(row.get("stalled")) for row in per_game), f"{label}: stall aggregate mismatch")
    return report


def create_reports_manifest(freeze_path: Path, authorization_path: Path, development: Path) -> dict[str, Any]:
    freeze = verify_freeze(freeze_path)
    authorization = verify_authorization(authorization_path, freeze_path)
    repo = repository_for(freeze_path.resolve().parent.parent)
    report_records = {}
    retry_records = {}
    for label in sorted(freeze["policies"]):
        policy_dir = development / label
        attempts = sorted(
            int(match.group(1))
            for candidate in policy_dir.glob("attempt-*")
            if candidate.is_dir() and (match := re.fullmatch(r"attempt-(\d+)", candidate.name))
        )
        require(attempts in ([1], [1, 2]), f"{label}: invalid attempt set")
        successful = []
        for attempt in attempts:
            attempt_dir = policy_dir / f"attempt-{attempt}"
            exit_path = attempt_dir / "exit-code"
            require(exit_path.is_file(), f"{label}: attempt {attempt} has no exit code")
            code = int(exit_path.read_text().strip())
            if code == 0:
                successful.append(attempt)
        require(len(successful) == 1 and successful[0] == attempts[-1], f"{label}: no unique final successful attempt")
        attempt = successful[0]
        attempt_dir = policy_dir / f"attempt-{attempt}"
        report_path = attempt_dir / "report.json"
        report = validate_development_report(freeze, label, report_path)
        report_records[label] = {
            "path": display_path(repo, report_path),
            "sha256": sha256(report_path),
            "weightsSha256": freeze["policies"][label]["weightsSha256"],
            "policyObsVersion": freeze["policies"][label]["policyObsVersion"],
            "exitCode": 0,
            "attempt": attempt,
            "stalls": int(report["stalls"]),
        }
        if attempt == 2:
            failure = policy_dir / "attempt-1/failure-evidence.json"
            retry = policy_dir / "retry-authorization.json"
            require(failure.is_file() and retry.is_file(), f"{label}: retry evidence missing")
            retry_value = load_json(retry)
            require(retry_value.get("schemaVersion") == "arc-v32-development-retry-authorization-v1" and retry_value.get("valid") is True and retry_value.get("outcomesInspected") is False and retry_value.get("identicalSeedRetry") is True, f"{label}: invalid retry authorization")
            require(retry_value.get("failureEvidenceSha256") == sha256(failure), f"{label}: retry evidence hash mismatch")
            retry_records[label] = {"failure": file_record(repo, failure), "authorization": file_record(repo, retry), "attempt": 2}
    return {
        "schemaVersion": "arc-v32-development-reports-v1",
        "valid": True,
        "immutable": True,
        "freeze": file_record(repo, freeze_path),
        "authorization": file_record(repo, authorization_path),
        "sourceContractSha256": freeze["authorization"]["sourceContractSha256"],
        "seed0": 949000000,
        "games": 4096,
        "reports": report_records,
        "retries": retry_records,
        "quarantineEvidence": retry_records,
        "strengthOutcomesInspected": False,
        "authorizationSha256": sha256(authorization_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--experiment", type=Path, default=Path("ml/experiments/v32-onpolicy-solo"))
    create.add_argument("--validation", type=Path, default=Path("/dev/shm/arc-v32-critic/validation"))
    create.add_argument("--representatives", type=Path, default=Path("ml/experiments/v32-onpolicy-solo/artifacts/policy-medoid.json"))
    create.add_argument("--out", type=Path, default=Path("ml/experiments/v32-onpolicy-solo/artifacts/development-freeze.json"))
    verify = subparsers.add_parser("verify")
    verify.add_argument("--manifest", type=Path, required=True)
    authorize = subparsers.add_parser("authorize")
    authorize.add_argument("--freeze", type=Path, required=True)
    authorize.add_argument("--diagnostic", type=Path, required=True)
    authorize.add_argument("--latency-smoke", type=Path, required=True)
    authorize.add_argument("--tests-exit", type=Path, required=True)
    authorize.add_argument("--out", type=Path, default=Path("ml/experiments/v32-onpolicy-solo/artifacts/development-authorization.json"))
    verify_authorized = subparsers.add_parser("verify-authorization")
    verify_authorized.add_argument("--manifest", type=Path, required=True)
    verify_authorized.add_argument("--freeze", type=Path)
    reports = subparsers.add_parser("record-reports")
    reports.add_argument("--freeze", type=Path, required=True)
    reports.add_argument("--authorization", type=Path, required=True)
    reports.add_argument("--development", type=Path, required=True)
    reports.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "create":
        value = create_freeze(args.experiment, args.validation, args.representatives)
        write_freeze(args.out, value)
        print(json.dumps({"manifest": str(args.out), "sha256": sha256(args.out), "endpointGeneration": value["endpointGeneration"], "policies": len(value["policies"]), "authorization": value["authorization"]}, indent=2))
    elif args.command == "verify":
        value = verify_freeze(args.manifest)
        print(json.dumps({"valid": True, "manifest": str(args.manifest), "sha256": sha256(args.manifest), "endpointGeneration": value["endpointGeneration"], "developmentSeedsOpen": False}, indent=2))
    elif args.command == "authorize":
        value = authorize_development(args.freeze, args.diagnostic, args.latency_smoke, args.tests_exit)
        write_freeze(args.out, value)
        print(json.dumps({"valid": True, "manifest": str(args.out), "sha256": sha256(args.out), "authorization": value["authorization"]}, indent=2))
    elif args.command == "verify-authorization":
        value = verify_authorization(args.manifest, args.freeze)
        print(json.dumps({"valid": True, "manifest": str(args.manifest), "sha256": sha256(args.manifest), "authorization": value["authorization"]}, indent=2))
    else:
        value = create_reports_manifest(args.freeze, args.authorization, args.development)
        write_freeze(args.out, value)
        print(json.dumps({"valid": True, "manifest": str(args.out), "sha256": sha256(args.out), "reports": len(value["reports"]), "strengthOutcomesInspected": False}, indent=2))


if __name__ == "__main__":
    main()
