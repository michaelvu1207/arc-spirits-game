#!/usr/bin/env python3
"""Freeze an outcome-blind, quota-exact V34 teacher-snapshot shard.

The collector owns all gameplay classification.  This freezer only validates the
upstream recovery flags and explicit selection band, performs a reproducible
without-replacement selection under the frozen caps, and records an exact ledger.
It never loads a target shard or reads future outcomes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np


SCHEMA_VERSION = "arc-v34-teacher-snapshot-freeze-v1"
PROTOCOL_SCHEMA_VERSION = "arc-v34-teacher-snapshot-freeze-protocol-v1"
BAND_ORDER = ("recovery", "late", "mid", "early")
ROUND_BANDS = {"early": (1, 8), "mid": (9, 15), "late": (16, 30)}
GENERATION_SEEDS = {1: 34043101, 2: 34043102, 3: 34043103}
MAX_ROWS_PER_SOURCE_GAME = 48
MAX_ROWS_PER_PUBLIC_STATE_HASH = 4
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_SAFE_INTEGER = 2**53 - 1

# Exact keys only.  Similar-looking fields are deliberately not pattern-matched,
# so legal command fields such as targetSeat and hasHiddenOutcome remain valid.
FORBIDDEN_FEATURE_KEYS = {
    "target",
    "targets",
    "outcome",
    "outcomes",
    "finalvp",
    "finalscore",
    "winnerseat",
    "won",
    "placement",
    "done",
    "ret",
    "episodereturn",
    "terminalreward",
    "reached30",
    "first30round",
    "post15vpperround",
    "teacherlabel",
    "teacherlabels",
    "teacherscores",
    "chosencandidate",
    "selectedcandidate",
    "realizednextstate",
    "authoritativenextstate",
    "futurestate",
    "futurerng",
    "futureseed",
    "nextrng",
    "rngcursor",
    "bagorder",
    "targetshard",
    "targetshardhash",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def normalized_key(key: str) -> str:
    return "".join(character.lower() for character in key if character.isalnum())


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)[:-1]).hexdigest()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant {value} is forbidden")


def reject_duplicate_keys(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def strict_json_loads(payload: str, label: str) -> Any:
    try:
        return json.loads(
            payload,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_json_constant,
        )
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"{label}: invalid strict JSON: {error}") from error


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    require(path.is_file(), f"{label}: missing file {path}")
    value = strict_json_loads(path.read_text(encoding="utf-8"), label)
    require(isinstance(value, dict), f"{label}: expected a JSON object")
    return value


def exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    require(actual == expected, f"{label}: expected keys {sorted(expected)}, got {sorted(actual)}")


def file_record(path: Path, payload: bytes | None = None) -> dict[str, Any]:
    resolved = path.resolve()
    if payload is None:
        require(path.is_file(), f"missing file {path}")
        return {
            "path": str(resolved),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    return {"path": str(resolved), "bytes": len(payload), "sha256": sha256_bytes(payload)}


def validate_file_record(record: Any, label: str) -> Path:
    require(isinstance(record, dict), f"{label}: invalid file record")
    exact_keys(record, {"path", "bytes", "sha256"}, label)
    path = Path(record["path"])
    require(path.is_file(), f"{label}: missing file {path}")
    require(type(record["bytes"]) is int and record["bytes"] >= 0, f"{label}: invalid byte count")
    require(path.stat().st_size == record["bytes"], f"{label}: byte count changed")
    require(
        isinstance(record["sha256"], str) and SHA256_RE.fullmatch(record["sha256"]) is not None,
        f"{label}: invalid SHA-256",
    )
    require(sha256_file(path) == record["sha256"], f"{label}: SHA-256 changed")
    return path


def validate_protocol(protocol: Mapping[str, Any]) -> dict[str, int]:
    exact_keys(protocol, {"schemaVersion", "quotas"}, "protocol")
    require(protocol["schemaVersion"] == PROTOCOL_SCHEMA_VERSION, "protocol: unsupported schema")
    quotas = protocol["quotas"]
    require(isinstance(quotas, dict), "protocol.quotas: expected an object")
    exact_keys(quotas, set(BAND_ORDER), "protocol.quotas")
    normalized: dict[str, int] = {}
    for band in BAND_ORDER:
        quota = quotas[band]
        require(type(quota) is int and quota >= 0, f"protocol.quotas.{band}: expected a non-negative integer")
        normalized[band] = quota
    require(sum(normalized.values()) > 0, "protocol quotas must select at least one row")
    return normalized


def forbidden_paths(value: Any) -> list[str]:
    paths: list[str] = []

    def visit(current: Any, path: str) -> None:
        if isinstance(current, dict):
            for key, child in current.items():
                child_path = f"{path}.{key}"
                if normalized_key(key) in FORBIDDEN_FEATURE_KEYS:
                    paths.append(child_path)
                visit(child, child_path)
        elif isinstance(current, list):
            for index, child in enumerate(current):
                visit(child, f"{path}[{index}]")

    visit(value, "$")
    return sorted(paths)


def required_safe_integer(value: Any, label: str, minimum: int = 0) -> int:
    require(type(value) is int, f"{label}: expected an integer")
    require(minimum <= value <= MAX_SAFE_INTEGER, f"{label}: outside safe integer range")
    return value


def round_band(round_number: int) -> str:
    for band, (minimum, maximum) in ROUND_BANDS.items():
        if minimum <= round_number <= maximum:
            return band
    raise ValueError(f"round {round_number} is outside the frozen 1-30 support")


@dataclass
class SnapshotRow:
    input_line: int
    raw_line_sha256: str
    canonical_row_sha256: str
    value: dict[str, Any]
    public_state_hash: str
    source_game_seed: int
    decision_ordinal: int
    band: str
    sampling_rank: int | None = None
    disposition: str = "unvisited"
    output_index: int | None = None

    @property
    def sort_key(self) -> tuple[str, int, int]:
        return self.public_state_hash, self.source_game_seed, self.decision_ordinal

    def ledger_entry(self) -> dict[str, Any]:
        return {
            "inputLine": self.input_line,
            "key": {
                "publicStateHash": self.public_state_hash,
                "sourceGameSeed": self.source_game_seed,
                "decisionOrdinal": self.decision_ordinal,
            },
            "band": self.band,
            "rawLineSha256": self.raw_line_sha256,
            "canonicalRowSha256": self.canonical_row_sha256,
            "samplingRank": self.sampling_rank,
            "disposition": self.disposition,
            "outputIndex": self.output_index,
        }


def validate_recovery_diagnostics(row: Mapping[str, Any], line_number: int) -> bool:
    label = f"input line {line_number}.recoveryDiagnostics"
    diagnostics = row.get("recoveryDiagnostics")
    require(isinstance(diagnostics, dict), f"{label}: missing or invalid")
    flag_names = {
        "statusRecovery",
        "weakEngine",
        "noPositiveVpInPriorThreeCompletedRounds",
        "recoveryEligible",
    }
    missing = flag_names - set(diagnostics)
    require(not missing, f"{label}: missing upstream flags {sorted(missing)}")
    for name in flag_names:
        require(type(diagnostics[name]) is bool, f"{label}.{name}: expected a boolean")
    expected = (
        diagnostics["statusRecovery"]
        or diagnostics["weakEngine"]
        or diagnostics["noPositiveVpInPriorThreeCompletedRounds"]
    )
    require(
        diagnostics["recoveryEligible"] is expected,
        f"{label}: recoveryEligible disagrees with upstream reason flags",
    )
    return expected


def validate_snapshot_row(value: Any, input_line: int, raw_line: bytes) -> SnapshotRow:
    label = f"input line {input_line}"
    require(isinstance(value, dict), f"{label}: expected a JSON object")
    leaked = forbidden_paths(value)
    require(not leaked, f"{label}: forbidden feature keys {leaked}")
    for alias in ("band", "roundBand", "freezeBand"):
        require(alias not in value, f"{label}: ambiguous band alias {alias!r}")

    public_hash = value.get("publicStateHash")
    require(
        isinstance(public_hash, str) and SHA256_RE.fullmatch(public_hash) is not None,
        f"{label}.publicStateHash: expected lowercase SHA-256",
    )
    source_seed = required_safe_integer(value.get("sourceGameSeed"), f"{label}.sourceGameSeed")
    ordinal = required_safe_integer(value.get("decisionOrdinal"), f"{label}.decisionOrdinal")
    round_number = required_safe_integer(value.get("round"), f"{label}.round", minimum=1)
    expected_round_band = round_band(round_number)
    recovery = validate_recovery_diagnostics(value, input_line)

    selection_band = value.get("selectionBand")
    require(selection_band in BAND_ORDER, f"{label}.selectionBand: missing or invalid")
    expected_band = "recovery" if recovery else expected_round_band
    require(
        selection_band == expected_band,
        f"{label}.selectionBand: expected {expected_band!r} from recovery precedence, got {selection_band!r}",
    )

    canonical = canonical_bytes(value)[:-1]
    return SnapshotRow(
        input_line=input_line,
        raw_line_sha256=sha256_bytes(raw_line),
        canonical_row_sha256=sha256_bytes(canonical),
        value=dict(value),
        public_state_hash=public_hash,
        source_game_seed=source_seed,
        decision_ordinal=ordinal,
        band=selection_band,
    )


def load_snapshot_rows(path: Path) -> tuple[list[SnapshotRow], bytes]:
    require(path.is_file(), f"input: missing file {path}")
    payload = path.read_bytes()
    require(payload, "input: empty JSONL file")
    require(payload.endswith(b"\n"), "input: JSONL must end with one newline")
    physical_lines = payload.splitlines(keepends=True)
    rows: list[SnapshotRow] = []
    previous_key: tuple[str, int, int] | None = None
    for input_line, raw_line in enumerate(physical_lines, start=1):
        require(raw_line.strip(), f"input line {input_line}: blank lines are forbidden")
        try:
            text = raw_line.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"input line {input_line}: invalid UTF-8") from error
        value = strict_json_loads(text, f"input line {input_line}")
        row = validate_snapshot_row(value, input_line, raw_line)
        if previous_key is not None:
            require(
                previous_key < row.sort_key,
                "input must be strictly sorted by (publicStateHash, sourceGameSeed, decisionOrdinal) with no duplicates",
            )
        previous_key = row.sort_key
        rows.append(row)
    return rows, payload


def select_rows(
    rows: Sequence[SnapshotRow], quotas: Mapping[str, int], generation: int
) -> tuple[list[SnapshotRow], dict[str, Any]]:
    require(generation in GENERATION_SEEDS, f"generation must be one of {sorted(GENERATION_SEEDS)}")
    seed = GENERATION_SEEDS[generation]
    rng = np.random.Generator(np.random.PCG64(seed))
    by_band = {band: [row for row in rows if row.band == band] for band in BAND_ORDER}
    game_counts: dict[int, int] = {}
    hash_counts: dict[str, int] = {}
    selected: list[SnapshotRow] = []
    permutation_hashes: dict[str, str] = {}
    capacity_skips = {band: {"sourceGame": 0, "publicStateHash": 0, "both": 0} for band in BAND_ORDER}

    # Recovery is visited first.  Every row qualifying for recovery was already removed
    # from its round band by validate_snapshot_row, so the four supports are disjoint.
    for band in BAND_ORDER:
        candidates = by_band[band]
        permutation = rng.permutation(len(candidates)).tolist()
        permutation_hashes[band] = canonical_sha256(
            [candidates[index].input_line for index in permutation]
        )
        selected_in_band = 0
        quota = quotas[band]
        for sampling_rank, candidate_index in enumerate(permutation):
            row = candidates[candidate_index]
            row.sampling_rank = sampling_rank
            if selected_in_band >= quota:
                row.disposition = "notSelectedQuotaFilled"
                continue
            game_full = game_counts.get(row.source_game_seed, 0) >= MAX_ROWS_PER_SOURCE_GAME
            hash_full = hash_counts.get(row.public_state_hash, 0) >= MAX_ROWS_PER_PUBLIC_STATE_HASH
            if game_full or hash_full:
                if game_full and hash_full:
                    row.disposition = "notSelectedBothCaps"
                    capacity_skips[band]["both"] += 1
                elif game_full:
                    row.disposition = "notSelectedSourceGameCap"
                    capacity_skips[band]["sourceGame"] += 1
                else:
                    row.disposition = "notSelectedPublicStateHashCap"
                    capacity_skips[band]["publicStateHash"] += 1
                continue
            row.disposition = "selected"
            selected.append(row)
            selected_in_band += 1
            game_counts[row.source_game_seed] = game_counts.get(row.source_game_seed, 0) + 1
            hash_counts[row.public_state_hash] = hash_counts.get(row.public_state_hash, 0) + 1

        require(
            selected_in_band == quota,
            f"quota shortage for {band}: required {quota}, selected {selected_in_band} "
            f"from {len(candidates)} rows under frozen caps",
        )

    require(len({row.input_line for row in selected}) == len(selected), "selection used replacement")
    require(
        max(game_counts.values(), default=0) <= MAX_ROWS_PER_SOURCE_GAME,
        "internal source-game cap violation",
    )
    require(
        max(hash_counts.values(), default=0) <= MAX_ROWS_PER_PUBLIC_STATE_HASH,
        "internal public-state-hash cap violation",
    )

    selected.sort(key=lambda row: row.sort_key)
    for output_index, row in enumerate(selected):
        row.output_index = output_index
    audit = {
        "bandOrder": list(BAND_ORDER),
        "rng": "numpy.random.Generator(numpy.random.PCG64)",
        "rngSeed": seed,
        "inputCountsByBand": {band: len(by_band[band]) for band in BAND_ORDER},
        "selectedCountsByBand": {
            band: sum(row.band == band for row in selected) for band in BAND_ORDER
        },
        "samplingPermutationSha256ByBand": permutation_hashes,
        "capacitySkipsByBand": capacity_skips,
        "selectedMaxRowsPerSourceGame": max(game_counts.values(), default=0),
        "selectedMaxRowsPerPublicStateHash": max(hash_counts.values(), default=0),
        "selectedKeysSha256": canonical_sha256(
            [
                [row.public_state_hash, row.source_game_seed, row.decision_ordinal]
                for row in selected
            ]
        ),
    }
    return selected, audit


def output_payload(selected: Iterable[SnapshotRow]) -> bytes:
    return b"".join(canonical_bytes(row.value) for row in selected)


def atomic_write_new(path: Path, payload: bytes) -> None:
    require(not path.exists() and not path.is_symlink(), f"refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{os.urandom(6).hex()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def freeze_snapshots(
    input_path: Path,
    output_path: Path,
    ledger_path: Path,
    protocol_path: Path,
    generation: int,
) -> dict[str, Any]:
    paths = [input_path.resolve(), output_path.resolve(), ledger_path.resolve(), protocol_path.resolve()]
    require(len(set(paths)) == len(paths), "input, protocol, output, and ledger paths must be distinct")
    require(not output_path.exists() and not output_path.is_symlink(), f"refusing to overwrite {output_path}")
    require(not ledger_path.exists() and not ledger_path.is_symlink(), f"refusing to overwrite {ledger_path}")
    protocol = load_json_object(protocol_path, "protocol")
    quotas = validate_protocol(protocol)
    rows, input_payload = load_snapshot_rows(input_path)
    selected, selection_audit = select_rows(rows, quotas, generation)
    frozen_payload = output_payload(selected)

    ledger = {
        "schemaVersion": SCHEMA_VERSION,
        "valid": True,
        "outcomesInspected": False,
        "generation": generation,
        "protocol": file_record(protocol_path),
        "input": {**file_record(input_path, input_payload), "rows": len(rows)},
        "output": {**file_record(output_path, frozen_payload), "rows": len(selected)},
        "tool": file_record(Path(__file__)),
        "contract": {
            "inputOrder": ["publicStateHash", "sourceGameSeed", "decisionOrdinal"],
            "outputOrder": ["publicStateHash", "sourceGameSeed", "decisionOrdinal"],
            "withoutReplacement": True,
            "recoveryPrecedence": True,
            "weakEngineClassification": "upstream",
            "maxRowsPerSourceGame": MAX_ROWS_PER_SOURCE_GAME,
            "maxRowsPerPublicStateHash": MAX_ROWS_PER_PUBLIC_STATE_HASH,
            "quotas": dict(quotas),
            "generationSeeds": {str(key): value for key, value in GENERATION_SEEDS.items()},
        },
        "selection": selection_audit,
        "rows": [row.ledger_entry() for row in rows],
    }
    ledger_payload = canonical_bytes(ledger)
    atomic_write_new(output_path, frozen_payload)
    try:
        atomic_write_new(ledger_path, ledger_payload)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    try:
        verify_freeze_ledger(ledger_path)
    except Exception:
        ledger_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        raise
    return {**ledger, "ledgerSha256": sha256_bytes(ledger_payload)}


def verify_freeze_ledger(ledger_path: Path) -> dict[str, Any]:
    ledger = load_json_object(ledger_path, "ledger")
    require(ledger.get("schemaVersion") == SCHEMA_VERSION, "ledger: unsupported schema")
    require(ledger.get("valid") is True, "ledger: not valid")
    require(ledger.get("outcomesInspected") is False, "ledger: outcome inspection flag changed")
    for label in ("protocol", "input", "output", "tool"):
        record = ledger.get(label)
        if label in {"input", "output"}:
            require(isinstance(record, dict), f"ledger.{label}: invalid record")
            file_part = {key: record.get(key) for key in ("path", "bytes", "sha256")}
            validate_file_record(file_part, f"ledger.{label}")
            require(type(record.get("rows")) is int and record["rows"] >= 0, f"ledger.{label}: invalid rows")
        else:
            validate_file_record(record, f"ledger.{label}")

    contract = ledger.get("contract")
    require(isinstance(contract, dict), "ledger.contract: missing")
    require(contract.get("withoutReplacement") is True, "ledger: replacement contract changed")
    require(contract.get("recoveryPrecedence") is True, "ledger: recovery precedence changed")
    require(contract.get("weakEngineClassification") == "upstream", "ledger: weak-engine contract changed")
    require(contract.get("maxRowsPerSourceGame") == MAX_ROWS_PER_SOURCE_GAME, "ledger: game cap changed")
    require(
        contract.get("maxRowsPerPublicStateHash") == MAX_ROWS_PER_PUBLIC_STATE_HASH,
        "ledger: hash cap changed",
    )
    require(
        contract.get("generationSeeds") == {str(key): value for key, value in GENERATION_SEEDS.items()},
        "ledger: generation seed schedule changed",
    )
    quotas = contract.get("quotas")
    require(isinstance(quotas, dict), "ledger: quotas missing")
    normalized_quotas = validate_protocol(
        {"schemaVersion": PROTOCOL_SCHEMA_VERSION, "quotas": quotas}
    )
    generation = ledger.get("generation")
    require(type(generation) is int and generation in GENERATION_SEEDS, "ledger: invalid generation")
    selection = ledger.get("selection")
    require(isinstance(selection, dict), "ledger.selection: missing")
    require(selection.get("rngSeed") == GENERATION_SEEDS[generation], "ledger: RNG seed mismatch")

    rows = ledger.get("rows")
    require(isinstance(rows, list), "ledger.rows: missing")
    require(len(rows) == ledger["input"]["rows"], "ledger: input row count mismatch")
    selected_entries = [entry for entry in rows if entry.get("disposition") == "selected"]
    require(len(selected_entries) == ledger["output"]["rows"], "ledger: selected row count mismatch")
    output_indexes = sorted(entry.get("outputIndex") for entry in selected_entries)
    require(output_indexes == list(range(len(selected_entries))), "ledger: output indexes are not exact")
    selected_lines = [entry.get("inputLine") for entry in selected_entries]
    require(len(selected_lines) == len(set(selected_lines)), "ledger: replacement detected")

    game_counts: dict[int, int] = {}
    hash_counts: dict[str, int] = {}
    band_counts = {band: 0 for band in BAND_ORDER}
    selected_keys: list[list[Any]] = []
    for entry in sorted(selected_entries, key=lambda item: item["outputIndex"]):
        key = entry.get("key")
        require(isinstance(key, dict), "ledger: selected key missing")
        game = key.get("sourceGameSeed")
        state_hash = key.get("publicStateHash")
        ordinal = key.get("decisionOrdinal")
        required_safe_integer(game, "ledger selected sourceGameSeed")
        required_safe_integer(ordinal, "ledger selected decisionOrdinal")
        require(isinstance(state_hash, str) and SHA256_RE.fullmatch(state_hash) is not None, "ledger: bad state hash")
        band = entry.get("band")
        require(band in BAND_ORDER, "ledger: invalid selected band")
        band_counts[band] += 1
        game_counts[game] = game_counts.get(game, 0) + 1
        hash_counts[state_hash] = hash_counts.get(state_hash, 0) + 1
        selected_keys.append([state_hash, game, ordinal])
    require(band_counts == normalized_quotas, "ledger: selected quotas are not exact")
    require(max(game_counts.values(), default=0) <= MAX_ROWS_PER_SOURCE_GAME, "ledger: source-game cap exceeded")
    require(max(hash_counts.values(), default=0) <= MAX_ROWS_PER_PUBLIC_STATE_HASH, "ledger: state-hash cap exceeded")
    require(selected_keys == sorted(selected_keys), "ledger: selected output keys are not sorted")
    require(
        canonical_sha256(selected_keys) == selection.get("selectedKeysSha256"),
        "ledger: selected-key hash mismatch",
    )

    output_path = Path(ledger["output"]["path"])
    output_rows, _ = load_snapshot_rows(output_path)
    require(len(output_rows) == len(selected_entries), "ledger: parsed output row count mismatch")
    for row, entry in zip(output_rows, sorted(selected_entries, key=lambda item: item["outputIndex"])):
        require(row.sort_key == (
            entry["key"]["publicStateHash"],
            entry["key"]["sourceGameSeed"],
            entry["key"]["decisionOrdinal"],
        ), "ledger: output row key mismatch")
        require(row.canonical_row_sha256 == entry.get("canonicalRowSha256"), "ledger: output row hash mismatch")
    return ledger


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    freeze = subparsers.add_parser("freeze", help="freeze one generation snapshot shard")
    freeze.add_argument("--input", type=Path, required=True)
    freeze.add_argument("--output", type=Path, required=True)
    freeze.add_argument("--ledger", type=Path, required=True)
    freeze.add_argument("--protocol", type=Path, required=True)
    freeze.add_argument("--generation", type=int, choices=sorted(GENERATION_SEEDS), required=True)
    verify = subparsers.add_parser("verify", help="verify an existing freeze ledger and bound files")
    verify.add_argument("--ledger", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "verify":
        ledger = verify_freeze_ledger(args.ledger)
        summary = {
            "valid": True,
            "generation": ledger["generation"],
            "output": ledger["output"],
            "ledgerSha256": sha256_file(args.ledger),
        }
    else:
        ledger = freeze_snapshots(
            args.input, args.output, args.ledger, args.protocol, args.generation
        )
        summary = {
            "valid": True,
            "generation": ledger["generation"],
            "output": ledger["output"],
            "ledger": file_record(args.ledger),
        }
    print(json.dumps(summary, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
