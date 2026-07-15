#!/usr/bin/env python3
"""Fail-closed V35 Phase 1 generation audit built on the frozen V32 PPO audit."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

EXPERIMENT = Path("ml/experiments/v35-weco-recursive-autoresearch")
DEFAULT_PROTOCOL = EXPERIMENT / "phase1-protocol.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_commitment(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    files = 0
    total_bytes = 0
    for file in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = file.relative_to(path).as_posix().encode()
        file_digest = sha256(file).encode()
        size = file.stat().st_size
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(size.to_bytes(8, "big"))
        digest.update(file_digest)
        files += 1
        total_bytes += size
    return {"sha256": digest.hexdigest(), "files": files, "bytes": total_bytes}


def extra_arg(extra: list[str], name: str) -> str:
    try:
        at = len(extra) - 1 - list(reversed(extra)).index(name)
        return extra[at + 1]
    except (ValueError, IndexError) as exc:
        raise ValueError(f"missing frozen trainer argument {name}") from exc


def require_equal(actual: Any, expected: Any, name: str) -> None:
    if actual != expected:
        raise ValueError(f"{name} changed: expected {expected!r}, got {actual!r}")


def validate_binding(root: Path, protocol_path: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    config_path = root / "config.json"
    binding_path = root / "v35-binding.json"
    for required in (config_path, binding_path, protocol_path):
        if not required.exists():
            raise FileNotFoundError(required)
    protocol = json.loads(protocol_path.read_text())
    config = json.loads(config_path.read_text())
    binding = json.loads(binding_path.read_text())
    require_equal(protocol.get("schemaVersion"), "arc-v35-phase1-protocol-v1", "protocol schema")
    require_equal(protocol.get("status"), "smoke-frozen", "protocol status")
    require_equal(binding.get("schemaVersion"), "arc-v35-root-binding-v1", "binding schema")
    require_equal(binding.get("experiment"), protocol["experiment"], "binding experiment")
    require_equal(binding.get("protocolSha256"), sha256(protocol_path), "protocol hash")
    require_equal(binding.get("configSha256"), sha256(config_path), "config hash")
    require_equal(binding.get("catalogSha256"), protocol["catalog"]["sha256"], "catalog binding")
    require_equal(
        binding.get("initialPolicySha256"),
        protocol["initialPolicy"]["sha256"],
        "initial policy binding",
    )
    require_equal(binding.get("promotionEligible"), False, "promotion eligibility")

    replicate = next(
        (item for item in protocol["replicates"] if item["id"] == binding.get("replicate")),
        None,
    )
    arm = next((item for item in protocol["arms"] if item["id"] == binding.get("arm")), None)
    if replicate is None or arm is None:
        raise ValueError("binding names an unknown replicate or arm")
    schedule = protocol["seedSchedule"]
    training = protocol["training"]
    require_equal(config["catalogPath"], protocol["catalog"]["path"], "catalog path")
    require_equal(config["catalogSha256"], protocol["catalog"]["sha256"], "catalog hash")
    require_equal(config["initFrom"], protocol["initialPolicy"]["path"], "initial policy path")
    require_equal(config["laneInit"], {"main-0": protocol["initialPolicy"]["path"]}, "lane init")
    require_equal(config["seedBase"], replicate["trainBase"], "seed base")
    require_equal(
        config["seedSchedule"],
        {
            "trainBase": replicate["trainBase"],
            "trainStride": schedule["trainStride"],
            "evalBase": replicate["evalBase"],
            "evalStride": schedule["evalStride"],
            "maxGeneration": schedule["maxGeneration"],
        },
        "seed schedule",
    )
    for name, expected in (
        ("seats", training["seats"]),
        ("soloMaxStatusLevel", training["soloMaxStatusLevel"]),
        ("maxRounds", training["maxRounds"]),
        ("gamesPerGen", training["gamesPerGeneration"]),
        ("evalGames", training["evalGamesPerGeneration"]),
        ("sample", training["sample"]),
        ("temperature", training["temperature"]),
        ("strategicDecisionScope", training["strategicDecisionScope"]),
        ("guardianSchedule", training["guardianSchedule"]),
        ("workers", training["workers"]),
    ):
        require_equal(config[name], expected, f"config.{name}")
    require_equal(config["lanes"], {"main": 1, "mainExploiter": 0, "leagueExploiter": 0}, "lanes")
    require_equal(config["promoteEvery"], 0, "promotion cadence")
    require_equal(config["train"]["epochs"], training["epochs"], "epochs")
    require_equal(config["train"]["batchSize"], training["batchSize"], "batch size")
    require_equal(config["train"]["ppoRowsPerEpoch"], training["ppoRowsPerEpoch"], "PPO rows")

    extra = config["train"]["extraArgs"]
    frozen_args = {
        "--lr": training["learningRate"],
        "--clip-eps": training["clipEpsilon"],
        "--value-clip-eps": training["valueClipEpsilon"],
        "--entropy-coef": training["entropyCoef"],
        "--kl-ref-coef": training["klReferenceCoef"],
        "--gamma": training["gamma"],
        "--gae-lambda": training["gaeLambda"],
        "--value-coef": training["valueCoef"],
        "--reach30-value-coef": training["reach30ValueCoef"],
        "--win-bonus": training["winBonus"],
        "--all-fallen-loss": training["allFallenPenalty"],
        "--solo-reach30-coef": arm["soloReach30Coef"],
        "--behavior-reach30-ece-max": protocol["trustGates"]["maxBehaviorReach30Ece"],
    }
    for name, expected in frozen_args.items():
        actual = float(extra_arg(extra, name))
        if abs(actual - float(expected)) > 1e-12:
            raise ValueError(f"{name} changed: expected {expected}, got {actual}")
    band_name = "--ppo-round-policy-bands"
    if arm["roundPolicyBands"] is None:
        if band_name in extra:
            raise ValueError("uniform arm unexpectedly enables round policy bands")
    else:
        expected_bands = ",".join(f"{upper}:{weight:g}" for upper, weight in arm["roundPolicyBands"])
        require_equal(extra_arg(extra, band_name), expected_bands, "round policy bands")
    return protocol, config, binding


def audit(root: Path, generation: int, protocol_path: Path) -> dict[str, Any]:
    from audit_v32_generation import audit as audit_v32_generation

    root = root.resolve()
    protocol_path = protocol_path.resolve()
    protocol, config, binding = validate_binding(root, protocol_path)
    gates = protocol["trustGates"]
    core_args = SimpleNamespace(
        root=root,
        gen=generation,
        max_approx_kl=float(gates["maxApproxKl"]),
        max_clip_fraction=min(
            float(gates["maxOrdinaryClipFraction"]),
            float(gates["maxWeightedClipFraction"]),
        ),
        max_ece=float(gates["maxBehaviorReach30Ece"]),
        max_logp_error=float(gates["maxBehaviorLogpReconstructionError"]),
        optimizer_steps=int(protocol["training"]["optimizerStepsPerEpoch"]),
        batch_size=int(protocol["training"]["batchSize"]),
    )
    result = audit_v32_generation(core_args)
    calibration = result["behaviorReach30Calibration"]
    if not {"brier", "constant_brier", "rows"}.issubset(calibration):
        raise ValueError(f"incomplete behavior Brier telemetry: {calibration}")
    if int(calibration["rows"]) <= 0:
        raise ValueError("behavior reach30 calibration has no rows")
    if gates["behaviorReach30BrierNoWorseThanConstant"] and (
        float(calibration["brier"]) > float(calibration["constant_brier"]) + 1e-12
    ):
        raise ValueError(f"behavior Brier gate failed: {calibration}")
    data_root = root / "data" / f"gen{generation}"
    commitment = tree_commitment(data_root)
    result["trustedCoreAuditSchema"] = result.pop("schemaVersion")
    result["schemaVersion"] = "arc-v35-generation-audit-v1"
    result["experiment"] = protocol["experiment"]
    result["replicate"] = binding["replicate"]
    result["arm"] = binding["arm"]
    result["protocol"] = str(protocol_path)
    result["protocolSha256"] = sha256(protocol_path)
    result["configSha256"] = sha256(root / "config.json")
    result["bindingSha256"] = sha256(root / "v35-binding.json")
    result["catalogSha256"] = sha256(Path(config["catalogPath"]))
    result["rawGenerationCommitment"] = commitment
    result["promotionEligible"] = False
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--gen", type=int, required=True)
    parser.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.root, args.gen, args.protocol)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
