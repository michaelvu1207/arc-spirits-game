from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ml.verify_v35_runtime_parity import ContractError, verify


OLD = "5574310327a19a609eb3713bff76efe48535aa91"
NEW = "07dc5e2a183a3f8dbb3ad1719fc228da7d7508af"
WEIGHTS = "c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91"
CATALOG = "62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59"
SEED0 = 969060000


def auth() -> dict:
    jobs = {
        "legacy-functional": {"sourceCommit": OLD, "seed0": SEED0, "games": 8},
        "optimized-functional": {"sourceCommit": NEW, "seed0": SEED0, "games": 8},
        "optimized-operational": {"sourceCommit": NEW, "seed0": SEED0, "games": 64},
        "legacy-operational": {"sourceCommit": OLD, "seed0": SEED0, "games": 64},
    }
    return {
        "schemaVersion": "arc-v35-runtime-parity-authorization-v1",
        "checkpointSha256": WEIGHTS,
        "catalogSha256": CATALOG,
        "candidate": {
            "search": {
                "sims": 4,
                "objective": "solo-reach30",
                "horizonRounds": 6,
                "frac": 0.84868158,
                "valueWeight": 0.25337527,
                "rollout": "policy",
                "navTemperature": 0.01453346,
            }
        },
        "seedContract": {"seed0": SEED0, "functionalGames": 8, "operationalGames": 64},
        "jobs": jobs,
    }


def report(commit: str, games: int, traces: dict[int, str] | None = None) -> dict:
    if traces is None:
        traces = {seed: f"{seed - SEED0 + 1:064x}" for seed in range(SEED0, SEED0 + games)}
    return {
        "schemaVersion": "solo-heldout-v2",
        "sourceCommit": commit,
        "weightsSha256": WEIGHTS,
        "catalogSha256": CATALOG,
        "seed0": SEED0,
        "games": games,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "stalls": 0,
        "trueWins": 999999,
        "meanVP": 123456.75,
        "decode": {
            "policyObsVersion": 2,
            "inferenceSocket": "/sealed/infer.sock",
            "learnMonsterRewardChoices": False,
            "sample": False,
            "search": auth()["candidate"]["search"],
        },
        "inference": {
            "format": "arc-entity-scorer-v2",
            "obsDim": 3419,
            "actDim": 104,
            "weightsSha256": WEIGHTS,
            "wire": "binary",
        },
        "replayHashes": [
            {"seed": seed, "replayTraceSha256": traces[seed]} for seed in sorted(traces)
        ],
    }


class Fixture:
    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.auth_path = self.root / "authorization.json"
        self.auth_path.write_text(json.dumps(auth()))
        for name, contract in auth()["jobs"].items():
            job = self.root / name
            job.mkdir()
            (job / "report.json").write_text(
                json.dumps(report(contract["sourceCommit"], contract["games"]))
            )
            (job / "evaluator.exit").write_text("0\n")
            (job / "infer.exit").write_text("0\n")
            (job / "infer.stderr").write_text(
                "[infer] serving /sealed/infer.sock\n[infer] shut down\n"
            )

    def close(self) -> None:
        self.temp.cleanup()

    def mutate_trace(self, name: str, seed: int, digest: str) -> None:
        path = self.root / name / "report.json"
        value = json.loads(path.read_text())
        for row in value["replayHashes"]:
            if row["seed"] == seed:
                row["replayTraceSha256"] = digest
        path.write_text(json.dumps(value))


class RuntimeParityVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_pass_is_strength_free(self) -> None:
        result = verify(self.fixture.auth_path, self.fixture.root)
        self.assertTrue(result["passed"])
        encoded = json.dumps(result)
        for forbidden in ("trueWins", "meanVP", "999999", "123456"):
            self.assertNotIn(forbidden, encoded)
        self.assertTrue(result["latencyPrecheckAuthorized"])
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(set(result["comparisons"].values()), {0})

    def test_cross_runtime_mismatch_rejects(self) -> None:
        self.fixture.mutate_trace("optimized-operational", SEED0 + 20, "f" * 64)
        result = verify(self.fixture.auth_path, self.fixture.root)
        self.assertFalse(result["passed"])
        self.assertEqual(result["classification"], "runtime-trace-mismatch")
        self.assertEqual(result["comparisons"]["crossRuntimeOperational"], 1)

    def test_batching_control_mismatch_has_distinct_classification(self) -> None:
        self.fixture.mutate_trace("legacy-operational", SEED0 + 2, "e" * 64)
        result = verify(self.fixture.auth_path, self.fixture.root)
        self.assertFalse(result["passed"])
        self.assertEqual(result["classification"], "batching-control-invalid")
        self.assertEqual(result["comparisons"]["legacyBatchingControl"], 1)

    def test_malformed_trace_fails_with_sanitized_code(self) -> None:
        path = self.fixture.root / "legacy-functional" / "report.json"
        value = json.loads(path.read_text())
        value["replayHashes"][0]["replayTraceSha256"] = "not-a-hash-123456-vp"
        path.write_text(json.dumps(value))
        with self.assertRaises(ContractError) as raised:
            verify(self.fixture.auth_path, self.fixture.root)
        self.assertEqual(raised.exception.code, "trace-row")
        self.assertNotIn("123456", str(raised.exception))

    def test_lifecycle_and_exit_fail_closed(self) -> None:
        (self.fixture.root / "optimized-functional" / "infer.stderr").write_text(
            "[infer] serving /sealed/infer.sock\nTraceback: secret outcome 123456\n"
        )
        with self.assertRaises(ContractError) as raised:
            verify(self.fixture.auth_path, self.fixture.root)
        self.assertEqual(raised.exception.code, "inference-lifecycle")


if __name__ == "__main__":
    unittest.main()
