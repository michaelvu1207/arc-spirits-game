"""Focused tests for the V31 paired terminal-credit analysis."""

from __future__ import annotations

import traceback

from analyze_terminal_credit import analyze_reports, holm_adjust


def provenance(reports: dict[str, dict]) -> dict:
    return {
        "expected_catalog_sha256": "catalog",
        "expected_source_commit": "fixture",
        "expected_weights_sha256": {label: "0" * 64 for label in reports},
        "expected_policy_obs_versions": {label: 2 for label in reports},
    }


def make_report(seed0: int, games: int, wins: set[int], *, improved: bool = False) -> dict:
    rows = []
    for index in range(games):
        won = index in wins
        rows.append({
            "seed": seed0 + index,
            "guardian": f"guardian-{index % 3}",
            "trueWin": won,
            "stalled": False,
            "finalVP": 32 if won else (25 if improved else 20),
            "first30Round": 20 if won else None,
            "post15VpPerRound": 2.0 if improved else 1.0,
            "finalAttackDice": 5,
            "finalSpirits": 6,
            "finalMaxBarrier": 4,
        })
    return {
        "schemaVersion": "solo-heldout-v2",
        "sourceCommit": "fixture",
        "weightsSha256": "0" * 64,
        "seed0": seed0,
        "games": games,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "catalogSha256": "catalog",
        "decode": {
            "policyObsVersion": 2,
            "inferenceSocket": "/tmp/test.sock",
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": 0.55,
        },
        "trueWins": len(wins),
        "trueWinRate": len(wins) / games,
        "stalls": 0,
        "perGame": rows,
    }


def test_holm_adjustment_is_monotone() -> None:
    adjusted = holm_adjust({"a": 0.01, "b": 0.03, "c": 0.04})
    assert adjusted == {"a": 0.03, "b": 0.06, "c": 0.06}


def test_analysis_selects_only_large_clean_treatment() -> None:
    seed0 = 944000000
    games = 12
    baseline = set(range(4))
    strong = set(range(10))
    reports = {
        "v23": make_report(seed0, games, baseline),
        "v30": make_report(seed0, games, baseline),
        "anchor": make_report(seed0, games, baseline),
        "pg01": make_report(seed0, games, strong, improved=True),
        "pg03": make_report(seed0, games, baseline),
        "pg06": make_report(seed0, games, baseline),
    }
    result = analyze_reports(
        reports,
        treatment_labels=["pg01", "pg03", "pg06"],
        expected_seed0=seed0,
        expected_games=games,
        bootstrap=500,
        bootstrap_seed=310199,
        **provenance(reports),
    )
    assert result["trainingParity"]["passed"] is True
    assert result["arms"]["pg01"]["eligible"] is True
    assert result["arms"]["pg03"]["eligible"] is False
    assert result["winner"] == "pg01"
    assert result["mcnemarHolmSensitivity"]["decisionUse"] is False


def test_analysis_rejects_wrong_seed_set() -> None:
    seed0 = 944000000
    reports = {
        label: make_report(seed0, 4, {0, 1})
        for label in ("v23", "v30", "anchor", "pg01", "pg03", "pg06")
    }
    reports["pg06"]["perGame"][0]["seed"] += 100
    try:
        analyze_reports(
            reports,
            treatment_labels=["pg01", "pg03", "pg06"],
            expected_seed0=seed0,
            expected_games=4,
            bootstrap=10,
            bootstrap_seed=1,
            **provenance(reports),
        )
    except ValueError as exc:
        assert "seed set" in str(exc)
    else:
        raise AssertionError("invalid seed set was accepted")


def test_analysis_rejects_nonfrozen_checkpoint() -> None:
    seed0 = 944000000
    reports = {
        label: make_report(seed0, 4, {0, 1})
        for label in ("v23", "v30", "anchor", "pg01", "pg03", "pg06")
    }
    expected = provenance(reports)
    expected["expected_weights_sha256"]["pg03"] = "1" * 64
    try:
        analyze_reports(
            reports,
            treatment_labels=["pg01", "pg03", "pg06"],
            expected_seed0=seed0,
            expected_games=4,
            bootstrap=10,
            bootstrap_seed=1,
            **expected,
        )
    except ValueError as exc:
        assert "frozen checkpoint" in str(exc)
    else:
        raise AssertionError("nonfrozen checkpoint was accepted")


def main() -> int:
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, test in tests:
        try:
            test()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
