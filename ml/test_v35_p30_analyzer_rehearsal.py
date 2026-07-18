from __future__ import annotations

import ast
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import run_v35_p30_analyzer_rehearsal as rehearsal
from analyze_v35_p30_long_horizon import (
    validate_authorized_evaluation_execution,
    validate_generation_execution_receipt_chain,
    validate_pair_integrity_receipt,
)
from v35_p30_analyzer_rehearsal_fixture import (
    ROLE_POLICIES,
    build_evaluation,
    build_generation_chain,
    build_pair,
    generate_keypair,
    synthetic_row,
    trust_roles,
    write_json,
)
from v35_p30_crypto import sha256_file


REPO = Path(__file__).resolve().parents[1]


class AnalyzerRehearsalTests(unittest.TestCase):
    def test_runner_has_no_alternate_analysis_child_or_custom_loader(self) -> None:
        source = (REPO / "ml/run_v35_p30_analyzer_rehearsal.py").read_text()
        tree = ast.parse(source)
        self.assertNotIn("synthetic-child", source)
        self.assertNotIn("_validate_manifest_shape", source)
        self.assertNotIn("testId", source)
        self.assertNotIn("load_inputs", source)
        self.assertNotIn("subprocess", {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)})

    def test_fixture_rows_are_exactly_synthetic_and_derivable(self) -> None:
        row = synthetic_row(969070000, "Guardian A", 0)
        self.assertEqual(row["trueWin"], row["finalVP"] >= 30)
        self.assertFalse(row["stalled"])
        self.assertEqual(row["first30Round"], row["cycle"]["first30Round"])
        self.assertEqual(row["post15VpPerRound"], row["cycle"]["post15VpPerRound"])

    def test_runner_requires_explicit_parent_protocol(self) -> None:
        source = (REPO / "ml/run_v35_p30_analyzer_rehearsal.py").read_text()
        self.assertIn('parser.add_argument("--protocol", type=Path, required=True)', source)
        self.assertIn("build_executor_launch_permit_payload", source)
        self.assertIn("prepare_execution_receipt", source)
        self.assertIn("seal_execution_receipt", source)

    def test_one_endpoint_chain_passes_production_analyzer_validators(self) -> None:
        proposal = json.loads(
            (
                REPO
                / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/protocol.proposed.json"
            ).read_text()
        )
        with tempfile.TemporaryDirectory() as temporary:
            temp = Path(temporary).resolve()
            key_root = temp / "keys"
            key_root.mkdir()
            keys = {role: generate_keypair(key_root, role) for role in ROLE_POLICIES}
            ledger = temp / "ledger" / ("1" * 64)
            for path in (ledger / "requests", ledger / "authorizations", ledger / "evaluations", ledger / "pairs"):
                path.mkdir(parents=True, exist_ok=True)
            source_lock = temp / "source-lock.json"
            write_json(source_lock, {"synthetic": True})
            proposal["executionTrust"]["campaignInstanceId"] = "1" * 64
            proposal["executionTrust"]["roles"] = trust_roles(keys)
            proposal["executionTrust"]["ledgerRoot"] = str(temp / "ledger")
            proposal["sourceContract"] = {
                "schemaVersion": "arc-v35-p30-source-lock-v1",
                "artifact": str(source_lock),
                "sha256": sha256_file(source_lock),
            }
            protocol_path = temp / "protocol.json"
            write_json(protocol_path, proposal)
            root = ledger / "endpoints" / "rep-a-control-zero"
            root.mkdir(parents=True)
            source_commit = "a" * 40
            base = dt.datetime(2026, 7, 16, tzinfo=dt.timezone.utc)
            generations, checkpoint, _manifest, config, root_binding = build_generation_chain(
                root,
                protocol=proposal,
                protocol_path=protocol_path,
                ledger=ledger,
                keys=keys,
                replicate="a",
                arm="control-zero",
                source_commit=source_commit,
                source_contract_sha256=sha256_file(source_lock),
                time_base=base,
            )
            catalog = json.loads((REPO / proposal["catalog"]["path"]).read_text())
            guardians = tuple(item["name"] for item in catalog["guardians"])
            evaluation, reports = build_evaluation(
                root,
                protocol=proposal,
                protocol_path=protocol_path,
                ledger=ledger,
                keys=keys,
                replicate="a",
                arm="control-zero",
                source_commit=source_commit,
                source_contract_sha256=sha256_file(source_lock),
                checkpoint=checkpoint,
                config_path=config,
                binding_path=root_binding,
                final_generation_receipt=generations[-1],
                guardians=guardians,
                time_base=base,
            )
            pair = build_pair(
                protocol=proposal,
                protocol_path=protocol_path,
                ledger=ledger,
                keys=keys,
                replicate="a",
                arm="control-zero",
                root=root,
                checkpoint=checkpoint,
                evaluation=evaluation,
                reports=reports,
                issued="2026-07-16T00:01:00Z",
            )
            final = validate_generation_execution_receipt_chain(
                final_receipt_path=generations[-1],
                final_receipt_sha256=sha256_file(generations[-1]),
                endpoint_root=root.resolve(),
                protocol=proposal,
                protocol_path=protocol_path,
                source_commit=source_commit,
                source_contract_sha256=sha256_file(source_lock),
                replicate="a",
                arm="control-zero",
                config_sha256=sha256_file(config),
                binding_sha256=sha256_file(root_binding),
                final_checkpoint_sha256=sha256_file(checkpoint),
                label="rep-a-control-zero",
            )
            self.assertEqual(final["kind"], "generation")
            for role in ("primary", "replay"):
                validated = validate_authorized_evaluation_execution(
                    receipt_path=evaluation[f"{role}Receipt"],
                    expected_hash=sha256_file(evaluation[f"{role}Receipt"]),
                    legacy_receipt_path=evaluation[f"{role}Legacy"],
                    role=role,
                    label="rep-a-control-zero",
                    replicate="a",
                    arm="control-zero",
                    protocol=proposal,
                    protocol_path=protocol_path,
                    source_commit=source_commit,
                    source_contract_sha256=sha256_file(source_lock),
                    checkpoint_path=checkpoint,
                    weights_hash=sha256_file(checkpoint),
                    generation_audit_path=root / "artifacts/gen8-audit.json",
                    config_sha256=sha256_file(config),
                    binding_sha256=sha256_file(root_binding),
                    root_identity=str(root.resolve()),
                )
                self.assertEqual(validated["kind"], f"evaluation-{role}")
            validated_pair = validate_pair_integrity_receipt(
                receipt_path=pair,
                expected_hash=sha256_file(pair),
                primary_execution_receipt_path=evaluation["primaryReceipt"],
                replay_execution_receipt_path=evaluation["replayReceipt"],
                primary_report_path=evaluation["primaryReport"],
                replay_report_path=evaluation["replayReport"],
                protocol=proposal,
                protocol_path=protocol_path,
                root_identity=str(root.resolve()),
                replicate="a",
                arm="control-zero",
                weights_hash=sha256_file(checkpoint),
            )
            self.assertTrue(validated_pair["valid"])


if __name__ == "__main__":
    unittest.main()
