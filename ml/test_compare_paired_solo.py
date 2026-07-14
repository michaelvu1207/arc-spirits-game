"""Contract tests for compare_paired_solo.py."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


def report(path: Path, *, obs_version: int, outcomes: list[tuple[int, bool, int, int | None, float]]) -> None:
    payload = {
        "seed0": 100,
        "games": len(outcomes),
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "decode": {
            "policyObsVersion": obs_version,
            **({"inferenceSocket": "/tmp/entity.sock"} if obs_version == 2 else {}),
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": 0.55,
        },
        "weights": f"v{obs_version}",
        "perGame": [
            {
                "seed": seed,
                "trueWin": win,
                "stalled": False,
                "finalVP": vp,
                "first30Round": finish,
                "post15VpPerRound": post15,
            }
            for seed, win, vp, finish, post15 in outcomes
        ],
    }
    path.write_text(json.dumps(payload))


def test_transport_and_obs_version_are_not_decision_semantic_mismatches():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        a, b, out = root / "a.json", root / "b.json", root / "out.json"
        report(a, obs_version=1, outcomes=[(100, False, 28, None, 0.5), (101, True, 31, 29, 1.0)])
        report(b, obs_version=2, outcomes=[(100, True, 30, 28, 0.8), (101, True, 33, 25, 1.3)])
        completed = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("compare_paired_solo.py")),
                "--a", str(a), "--b", str(b), "--bootstrap", "200", "--out", str(out),
            ],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        result = json.loads(out.read_text())
        assert result["winRate"]["deltaBMinusA"] == 0.5
        assert "deltaBootstrap9833Simultaneous" in result["winRate"]
        assert result["censoredFirst30Round"]["meanDeltaBMinusA"] == -3.5
        assert abs(result["post15VpPerRound"]["meanDeltaBMinusA"] - 0.3) < 1e-9


def main() -> int:
    test_transport_and_obs_version_are_not_decision_semantic_mismatches()
    print("PASS test_transport_and_obs_version_are_not_decision_semantic_mismatches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
