from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from freeze_v34_teacher_snapshots import (
    BAND_ORDER,
    GENERATION_SEEDS,
    MAX_ROWS_PER_PUBLIC_STATE_HASH,
    MAX_ROWS_PER_SOURCE_GAME,
    PROTOCOL_SCHEMA_VERSION,
    canonical_bytes,
    freeze_snapshots,
    load_snapshot_rows,
    sha256_file,
    validate_protocol,
    verify_freeze_ledger,
)


def state_hash(label: str) -> str:
    return hashlib.sha256(f"synthetic:{label}".encode()).hexdigest()


def diagnostics(
    *, status: bool = False, weak: bool = False, stalled: bool = False
) -> dict:
    return {
        "statusRecovery": status,
        "weakEngine": weak,
        "noPositiveVpInPriorThreeCompletedRounds": stalled,
        "recoveryEligible": status or weak or stalled,
        "observed": {"synthetic": True},
    }


def snapshot_row(
    seed: int,
    ordinal: int,
    round_number: int,
    *,
    hash_label: str | None = None,
    recovery: dict | None = None,
    selection_band: str | None = None,
) -> dict:
    recovery = recovery or diagnostics()
    if selection_band is None:
        if recovery["recoveryEligible"]:
            selection_band = "recovery"
        elif round_number <= 8:
            selection_band = "early"
        elif round_number <= 15:
            selection_band = "mid"
        else:
            selection_band = "late"
    return {
        "schema": "synthetic-unregistered-v34-snapshot-v1",
        "publicStateHash": state_hash(hash_label or f"{seed}:{ordinal}"),
        "sourceGameSeed": seed,
        "decisionOrdinal": ordinal,
        "round": round_number,
        "selectionBand": selection_band,
        "recoveryDiagnostics": recovery,
        "currentVisibleState": {"synthetic": True, "vp": ordinal % 7},
        "candidates": [
            {"commandHash": state_hash(f"command-a:{seed}:{ordinal}"), "hasHiddenOutcome": False},
            {"commandHash": state_hash(f"command-b:{seed}:{ordinal}"), "hasHiddenOutcome": True},
        ],
    }


def sort_key(row: dict) -> tuple[str, int, int]:
    return row["publicStateHash"], row["sourceGameSeed"], row["decisionOrdinal"]


def write_json(path: Path, value: dict) -> None:
    path.write_bytes(canonical_bytes(value))


def write_jsonl(path: Path, rows: list[dict], *, sort_rows: bool = True) -> None:
    ordered = sorted(rows, key=sort_key) if sort_rows else rows
    path.write_bytes(b"".join(canonical_bytes(row) for row in ordered))


def write_protocol(path: Path, **quotas: int) -> None:
    complete = {band: 0 for band in BAND_ORDER}
    complete.update(quotas)
    write_json(
        path,
        {"schemaVersion": PROTOCOL_SCHEMA_VERSION, "quotas": complete},
    )


def output_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class FreezeFixture(unittest.TestCase):
    def paths(self, root: Path, suffix: str = "") -> tuple[Path, Path, Path, Path]:
        return (
            root / "input.jsonl",
            root / f"protocol{suffix}.json",
            root / f"frozen{suffix}.jsonl",
            root / f"ledger{suffix}.json",
        )


class ExactFreezeTest(FreezeFixture):
    def test_exact_disjoint_quotas_recovery_precedence_and_hash_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path, protocol_path, output_path, ledger_path = self.paths(root)
            rows = [
                snapshot_row(10, 0, 20, recovery=diagnostics(weak=True)),
                snapshot_row(11, 0, 5, recovery=diagnostics(status=True)),
                *[snapshot_row(20 + index, 0, 20) for index in range(6)],
                *[snapshot_row(40 + index, 0, 12) for index in range(4)],
                *[snapshot_row(60 + index, 0, 4) for index in range(3)],
            ]
            write_jsonl(input_path, rows)
            write_protocol(protocol_path, recovery=2, late=3, mid=2, early=1)

            result = freeze_snapshots(
                input_path, output_path, ledger_path, protocol_path, generation=1
            )
            frozen = output_rows(output_path)
            self.assertEqual(
                Counter(row["selectionBand"] for row in frozen),
                Counter({"recovery": 2, "late": 3, "mid": 2, "early": 1}),
            )
            self.assertEqual([sort_key(row) for row in frozen], sorted(map(sort_key, frozen)))
            self.assertEqual(len({sort_key(row) for row in frozen}), len(frozen))
            self.assertTrue(
                all(
                    row["selectionBand"] == "recovery"
                    for row in frozen
                    if row["recoveryDiagnostics"]["recoveryEligible"]
                )
            )
            self.assertEqual(result["input"]["sha256"], sha256_file(input_path))
            self.assertEqual(result["output"]["sha256"], sha256_file(output_path))
            self.assertEqual(result["output"]["bytes"], output_path.stat().st_size)
            self.assertEqual(result["selection"]["rngSeed"], GENERATION_SEEDS[1])
            self.assertFalse(result["outcomesInspected"])
            self.assertEqual(verify_freeze_ledger(ledger_path)["valid"], True)

    def test_pc64_selection_is_reproducible_and_generation_separated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "input.jsonl"
            rows = [snapshot_row(100 + index, 0, 20) for index in range(40)]
            write_jsonl(input_path, rows)

            outputs = []
            ledgers = []
            for suffix, generation in (("-g1a", 1), ("-g1b", 1), ("-g2", 2), ("-g3", 3)):
                protocol = root / f"protocol{suffix}.json"
                output = root / f"output{suffix}.jsonl"
                ledger = root / f"ledger{suffix}.json"
                write_protocol(protocol, late=7)
                result = freeze_snapshots(input_path, output, ledger, protocol, generation)
                outputs.append(output.read_bytes())
                ledgers.append(result)

            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(
                ledgers[0]["selection"]["samplingPermutationSha256ByBand"],
                ledgers[1]["selection"]["samplingPermutationSha256ByBand"],
            )
            self.assertNotEqual(outputs[0], outputs[2])
            self.assertNotEqual(outputs[0], outputs[3])
            self.assertEqual(
                [ledger["selection"]["rngSeed"] for ledger in ledgers],
                [34043101, 34043101, 34043102, 34043103],
            )
            # Golden output-order fixtures pin PCG64, band traversal, and the final
            # canonical-key sort instead of proving only same-process repeatability.
            self.assertEqual(
                [[row["sourceGameSeed"] for row in output_rows(root / name)] for name in (
                    "output-g1a.jsonl",
                    "output-g2.jsonl",
                    "output-g3.jsonl",
                )],
                [
                    [106, 121, 100, 139, 116, 119, 112],
                    [109, 106, 115, 120, 137, 100, 125],
                    [108, 114, 123, 122, 139, 132, 125],
                ],
            )


class ClassificationValidationTest(FreezeFixture):
    def assert_row_rejected(self, row: dict, pattern: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "input.jsonl"
            write_jsonl(path, [row])
            with self.assertRaisesRegex(ValueError, pattern):
                load_snapshot_rows(path)

    def test_rejects_missing_or_ambiguous_band_and_upstream_flags(self) -> None:
        missing_band = snapshot_row(1, 0, 20)
        del missing_band["selectionBand"]
        self.assert_row_rejected(missing_band, "selectionBand")

        alias = snapshot_row(1, 0, 20)
        alias["band"] = "late"
        self.assert_row_rejected(alias, "ambiguous band alias")

        missing_weak = snapshot_row(1, 0, 20)
        del missing_weak["recoveryDiagnostics"]["weakEngine"]
        self.assert_row_rejected(missing_weak, "missing upstream flags")

    def test_rejects_recovery_precedence_mismatch_and_inconsistent_upstream_result(self) -> None:
        ambiguous = snapshot_row(
            1,
            0,
            20,
            recovery=diagnostics(weak=True),
            selection_band="late",
        )
        self.assert_row_rejected(ambiguous, "expected 'recovery' from recovery precedence")

        inconsistent = snapshot_row(1, 0, 20)
        inconsistent["recoveryDiagnostics"]["recoveryEligible"] = True
        inconsistent["selectionBand"] = "recovery"
        self.assert_row_rejected(inconsistent, "disagrees with upstream reason flags")

    def test_rejects_target_outcome_fields_without_rejecting_policy_safe_names(self) -> None:
        safe = snapshot_row(1, 0, 20)
        safe["candidates"][0]["targetSeat"] = "Blue"
        safe["candidates"][0]["hasHiddenOutcome"] = True
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "safe.jsonl"
            write_jsonl(path, [safe])
            self.assertEqual(len(load_snapshot_rows(path)[0]), 1)

        unsafe = snapshot_row(1, 0, 20)
        unsafe["future"] = {"finalVP": 30}
        self.assert_row_rejected(unsafe, "forbidden feature keys.*finalVP")


class CapAndShortageTest(FreezeFixture):
    def test_source_game_cap_is_exact_and_shortage_leaves_no_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path, protocol_path, output_path, ledger_path = self.paths(root)
            rows = [snapshot_row(77, index, 20) for index in range(60)]
            write_jsonl(input_path, rows)
            write_protocol(protocol_path, late=MAX_ROWS_PER_SOURCE_GAME)
            freeze_snapshots(input_path, output_path, ledger_path, protocol_path, 1)
            self.assertEqual(len(output_rows(output_path)), MAX_ROWS_PER_SOURCE_GAME)

            protocol_short = root / "protocol-short.json"
            output_short = root / "output-short.jsonl"
            ledger_short = root / "ledger-short.json"
            write_protocol(protocol_short, late=MAX_ROWS_PER_SOURCE_GAME + 1)
            with self.assertRaisesRegex(ValueError, "quota shortage for late"):
                freeze_snapshots(
                    input_path, output_short, ledger_short, protocol_short, generation=1
                )
            self.assertFalse(output_short.exists())
            self.assertFalse(ledger_short.exists())

    def test_public_state_hash_cap_is_exact_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "input.jsonl"
            rows = [
                snapshot_row(100 + index, 0, 20, hash_label="shared-public-state")
                for index in range(8)
            ]
            write_jsonl(input_path, rows)
            protocol = root / "protocol.json"
            output = root / "output.jsonl"
            ledger = root / "ledger.json"
            write_protocol(protocol, late=MAX_ROWS_PER_PUBLIC_STATE_HASH)
            freeze_snapshots(input_path, output, ledger, protocol, generation=1)
            frozen = output_rows(output)
            self.assertEqual(len(frozen), MAX_ROWS_PER_PUBLIC_STATE_HASH)
            self.assertEqual(len({row["publicStateHash"] for row in frozen}), 1)

            short_protocol = root / "short.json"
            write_protocol(short_protocol, late=MAX_ROWS_PER_PUBLIC_STATE_HASH + 1)
            with self.assertRaisesRegex(ValueError, "quota shortage for late"):
                freeze_snapshots(
                    input_path,
                    root / "short-output.jsonl",
                    root / "short-ledger.json",
                    short_protocol,
                    1,
                )

    def test_raw_band_shortage_never_backfills_from_another_band(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path, protocol_path, output_path, ledger_path = self.paths(root)
            write_jsonl(
                input_path,
                [snapshot_row(1, 0, 20), snapshot_row(2, 0, 20), snapshot_row(3, 0, 5)],
            )
            write_protocol(protocol_path, late=2, early=2)
            with self.assertRaisesRegex(ValueError, "quota shortage for early"):
                freeze_snapshots(input_path, output_path, ledger_path, protocol_path, 1)
            self.assertFalse(output_path.exists())
            self.assertFalse(ledger_path.exists())


class OrderAndProtocolTest(FreezeFixture):
    def test_input_must_be_strictly_sorted_and_unique(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = snapshot_row(1, 0, 20, hash_label="a")
            second = snapshot_row(2, 0, 20, hash_label="b")
            ordered = sorted([first, second], key=sort_key)
            path = root / "unsorted.jsonl"
            write_jsonl(path, list(reversed(ordered)), sort_rows=False)
            with self.assertRaisesRegex(ValueError, "strictly sorted"):
                load_snapshot_rows(path)

            duplicate = root / "duplicate.jsonl"
            write_jsonl(duplicate, [first, first], sort_rows=False)
            with self.assertRaisesRegex(ValueError, "no duplicates"):
                load_snapshot_rows(duplicate)

    def test_protocol_requires_exact_nonnegative_band_quotas(self) -> None:
        valid = {
            "schemaVersion": PROTOCOL_SCHEMA_VERSION,
            "quotas": {"recovery": 0, "late": 1, "mid": 0, "early": 0},
        }
        self.assertEqual(validate_protocol(valid)["late"], 1)
        with self.assertRaisesRegex(ValueError, "expected keys"):
            validate_protocol({**valid, "extra": True})
        invalid = json.loads(json.dumps(valid))
        invalid["quotas"]["late"] = -1
        with self.assertRaisesRegex(ValueError, "non-negative integer"):
            validate_protocol(invalid)


class LedgerIntegrityTest(FreezeFixture):
    def test_ledger_binds_every_input_disposition_and_detects_output_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path, protocol_path, output_path, ledger_path = self.paths(root)
            rows = [snapshot_row(200 + index, 0, 20) for index in range(10)]
            write_jsonl(input_path, rows)
            write_protocol(protocol_path, late=4)
            result = freeze_snapshots(
                input_path, output_path, ledger_path, protocol_path, generation=1
            )
            self.assertEqual(len(result["rows"]), len(rows))
            self.assertEqual(
                Counter(entry["disposition"] for entry in result["rows"]),
                Counter({"selected": 4, "notSelectedQuotaFilled": 6}),
            )
            self.assertTrue(all(entry["rawLineSha256"] for entry in result["rows"]))
            self.assertTrue(all(entry["canonicalRowSha256"] for entry in result["rows"]))
            self.assertEqual(verify_freeze_ledger(ledger_path)["output"]["rows"], 4)

            output_path.write_bytes(output_path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "byte count changed|SHA-256 changed"):
                verify_freeze_ledger(ledger_path)

    def test_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path, protocol_path, output_path, ledger_path = self.paths(root)
            write_jsonl(input_path, [snapshot_row(1, 0, 20)])
            write_protocol(protocol_path, late=1)
            freeze_snapshots(input_path, output_path, ledger_path, protocol_path, 1)
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                freeze_snapshots(input_path, output_path, ledger_path, protocol_path, 1)


if __name__ == "__main__":
    unittest.main()
