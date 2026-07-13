from __future__ import annotations

import copy

import numpy as np

from widen_checkpoint import hidden_widths, parameter_count, verify_parity, widen_checkpoint


def layer(out_width: int, in_width: int, rng: np.random.Generator) -> dict:
    return {
        "W": rng.standard_normal((out_width, in_width)).tolist(),
        "b": rng.standard_normal(out_width).tolist(),
    }


def checkpoint() -> dict:
    rng = np.random.default_rng(7)
    candidate = [layer(4, 5, rng), layer(3, 4, rng), layer(1, 3, rng)]
    obs = [layer(2, 3, rng), layer(1, 2, rng)]
    return {
        "format": "arc-cand-scorer-v1",
        "obs_dim": 3,
        "act_dim": 2,
        "trunk_hidden": [4, 3],
        "value_hidden": [2],
        "trunk": copy.deepcopy(candidate),
        "reward_pick": copy.deepcopy(candidate),
        "value": copy.deepcopy(obs),
        "farm_value": copy.deepcopy(obs),
        "route_mode": copy.deepcopy(obs),
        "reach30": copy.deepcopy(obs),
        "placement": [layer(2, 3, rng), layer(4, 2, rng)],
    }


def test_widen_preserves_every_head_and_metadata():
    source = checkpoint()
    widened = widen_checkpoint(source, (8, 6), (5,), symmetry_epsilon=1e-3, seed=11)
    assert hidden_widths(widened["trunk"]) == (8, 6)
    assert hidden_widths(widened["value"]) == (5,)
    assert widened["trunk_hidden"] == [8, 6]
    assert widened["value_hidden"] == [5]
    assert widened["net2wider"]["symmetry_epsilon"] == 1e-3
    assert widened["params"] == parameter_count(widened)
    assert verify_parity(source, widened, samples=64) <= 1e-9

    # Every original first-layer unit has one duplicate. Their outgoing columns
    # must differ so the duplicates receive different gradients, while summing
    # back to the original outgoing column exactly enough to preserve outputs.
    old_next = np.asarray(source["trunk"][1]["W"])
    new_next = np.asarray(widened["trunk"][1]["W"])
    for index in range(old_next.shape[1]):
        original_rows = slice(0, old_next.shape[0])
        assert not np.array_equal(
            new_next[original_rows, index],
            new_next[original_rows, index + old_next.shape[1]],
        )
        np.testing.assert_allclose(
            new_next[original_rows, index] + new_next[original_rows, index + old_next.shape[1]],
            old_next[:, index],
            rtol=0,
            atol=1e-12,
        )


def test_widen_rejects_narrowing():
    try:
        widen_checkpoint(checkpoint(), (3, 3), (2,))
    except ValueError as exc:
        assert "cannot narrow" in str(exc)
    else:
        raise AssertionError("narrowing must fail")


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} tests passed")
