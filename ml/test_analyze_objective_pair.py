import json
import tempfile
import traceback
from pathlib import Path

from analyze_objective_pair import analyze_pair


def _make_root(base: Path, name: str, outcomes: list[tuple[int, int, int | None]]) -> Path:
    root = base / name
    eval_dir = root / "data" / "gen1" / "main-0_eval"
    eval_dir.mkdir(parents=True)
    games = []
    for seed, vp, first30 in outcomes:
        games.append(
            {
                "seed": seed,
                "stalled": False,
                "perSeat": [
                    {
                        "finalVP": vp,
                        "finalSpirits": 6,
                        "finalAttackDice": 3,
                        "finalMaxBarrier": 8,
                        "cycle": {
                            "first30Round": first30,
                            "post15VpPerRound": 1.0,
                            "decisions": 100,
                        },
                    }
                ],
            }
        )
    (eval_dir / "games-0.jsonl").write_text(
        "".join(json.dumps(game) + "\n" for game in games), encoding="utf-8"
    )
    history = {
        "gen": 1,
        "lane": "main-0",
        "catalogPath": "live.json",
        "catalogSha256": "abc",
        "games": 1024,
        "samples": 120000,
        "trainerSeed": 7,
        "optimizerStepsPerEpoch": 10,
        "optimizerStepsTotal": 40,
        "evalGames": len(games),
    }
    (root / "history.jsonl").write_text(json.dumps(history) + "\n", encoding="utf-8")
    return root


def test_paired_objective_analysis_counts_discordant_successes_and_deltas():
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        control = _make_root(base, "control", [(1, 28, None), (2, 32, 29), (3, 30, 30)])
        treatment = _make_root(base, "treatment", [(1, 31, 28), (2, 27, None), (3, 35, 25)])
        treatment_history = json.loads((treatment / "history.jsonl").read_text(encoding="utf-8"))
        treatment_history["samples"] = 119000
        (treatment / "history.jsonl").write_text(
            json.dumps(treatment_history) + "\n", encoding="utf-8"
        )
        result = analyze_pair(
            control,
            treatment,
            gen=1,
            bootstrap_samples=200,
            bootstrap_seed=1,
        )

    assert result["pairedSeeds"] == 3
    assert result["reach30"]["control"] == 2
    assert result["reach30"]["treatment"] == 2
    assert result["reach30"]["controlOnly"] == 1
    assert result["reach30"]["treatmentOnly"] == 1
    assert result["reach30"]["mcnemarExactTwoSidedP"] == 1.0
    assert result["metrics"]["finalVP"]["pairedMeanDelta"] == 1.0
    assert result["trainingSamples"] == {"control": 120000, "treatment": 119000}


def test_paired_objective_analysis_rejects_different_seed_sets():
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        control = _make_root(base, "control", [(1, 30, 30)])
        treatment = _make_root(base, "treatment", [(2, 30, 30)])
        try:
            analyze_pair(control, treatment, gen=1, bootstrap_samples=100)
        except ValueError as error:
            assert "seed sets differ" in str(error)
        else:
            raise AssertionError("mismatched evaluation seeds must fail closed")


def main() -> int:
    tests = [
        (name, function)
        for name, function in sorted(globals().items())
        if name.startswith("test_") and callable(function)
    ]
    failures = 0
    for name, function in tests:
        try:
            function()
            print(f"PASS {name}")
        except Exception:
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} tests passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
