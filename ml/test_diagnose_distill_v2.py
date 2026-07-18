"""Unit tests for V29 diagnostic aggregation."""

from diagnose_distill_v2 import game_cluster_bootstrap_p99, metric_summary, round_bucket


def main() -> int:
    summary = metric_summary(
        [0.0, 0.1, 0.2, 0.3], [True, True, False, True], [0.1, -0.1, 0.2, -0.2]
    )
    assert summary["rows"] == 4
    assert abs(summary["klMean"] - 0.15) < 1e-9
    assert summary["top1Agreement"] == 0.75
    assert abs(summary["klCvar05"] - 0.3) < 1e-9
    assert abs(summary["entropyDeltaMean"]) < 1e-9
    assert [round_bucket(value) for value in (1, 8, 9, 15, 16, 22, 23, 30)] == [
        "01-08", "01-08", "09-15", "09-15", "16-22", "16-22", "23-30", "23-30"
    ]
    bootstrap = game_cluster_bootstrap_p99(
        {"a": [0.1, 0.2], "b": [0.3, 0.4], "c": [0.5, 0.6]},
        replicates=100,
        seed=7,
    )
    assert bootstrap["games"] == 3 and bootstrap["replicates"] == 100
    assert 0.1 <= bootstrap["lower95"] <= bootstrap["upper95"] <= 0.6
    print("PASS V29 diagnostic helpers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
