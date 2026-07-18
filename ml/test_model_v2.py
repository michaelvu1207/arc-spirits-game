"""
Tests for ml/obs_v2.py + ml/model_v2.py against a REAL-encoder fixture.

Fixture: ml/data_fixtures/obsv2_fixture.json — real decision-point observations
flattened by src/lib/play/ml/encodeV2.ts. Regenerate with:

    FIXTURE=1 npx vitest run src/lib/play/ml/_obsv2fixture.test.ts

Run:  ml/.venv/bin/python ml/test_model_v2.py
"""

from __future__ import annotations

import copy
import json
import time
import traceback
from pathlib import Path

import numpy as np
import torch

from model_v2 import build_model_v2, load_checkpoint, save_checkpoint
from obs_v2 import MASKED_FAMILIES, ObsV2Spec

ACT_DIM = 52
FIXTURE = Path(__file__).parent / "data_fixtures" / "obsv2_fixture.json"

_fixture_cache: dict | None = None


def load_fixture() -> tuple[ObsV2Spec, np.ndarray, dict]:
    global _fixture_cache
    if _fixture_cache is None:
        with open(FIXTURE) as f:
            _fixture_cache = json.load(f)
    fx = _fixture_cache
    spec = ObsV2Spec.from_meta(fx["meta"])
    flat = np.asarray(fx["flat"], dtype=np.float32)
    return spec, flat, fx["meta"]


def make_cands(batch: int, n_cands: int, valid: int | None = None, seed: int = 7):
    g = torch.Generator().manual_seed(seed)
    cands = torch.rand(batch, n_cands, ACT_DIM, generator=g)
    mask = torch.ones(batch, n_cands, dtype=torch.bool)
    if valid is not None:
        mask[:, valid:] = False
        cands[~mask] = 0.0
    return cands, mask


def _family_offsets(spec: ObsV2Spec, name: str) -> tuple[int, int]:
    """(payload_start, mask_start) of a family inside the flat row."""
    pay = spec.header_len
    for f in spec.families:
        if f.name == name:
            break
        pay += f.cap * f.dim
    msk = spec.header_len + spec.payload_len
    for f in spec.families:
        if f.name == name:
            break
        if f.name in MASKED_FAMILIES:
            msk += f.cap
    return pay, msk


def permute_family(spec: ObsV2Spec, row: np.ndarray, name: str, perm: np.ndarray) -> np.ndarray:
    """Reorder one family's token rows (and its mask entries) in a flat row."""
    fam = spec.family(name)
    pay, msk = _family_offsets(spec, name)
    out = row.copy()
    block = row[pay : pay + fam.cap * fam.dim].reshape(fam.cap, fam.dim)
    out[pay : pay + fam.cap * fam.dim] = block[perm].reshape(-1)
    out[msk : msk + fam.cap] = row[msk : msk + fam.cap][perm]
    return out


# ── parser ───────────────────────────────────────────────────────────────────

def test_fixture_parser_roundtrip():
    spec, flat, meta = load_fixture()
    assert flat.shape[0] >= 50, f"fixture has only {flat.shape[0]} rows"
    assert flat.shape[1] == spec.flat_length == meta["flatLength"]

    # Header-derived spec agrees with meta-derived spec.
    assert ObsV2Spec.from_flat(flat).header == spec.header
    assert spec.header == [int(x) for x in meta["flatHeader"]]

    tokens, masks = spec.unflatten(flat)
    for f in spec.families:
        assert tokens[f.name].shape == (flat.shape[0], f.cap, f.dim)
        assert masks[f.name].shape == (flat.shape[0], f.cap)
        m = masks[f.name]
        assert torch.all((m == 0) | (m == 1)), f"{f.name}: non-binary mask"
        # Pad rows are all-zero; real rows carry present=1 in field 0.
        pad_rows = tokens[f.name][m == 0]
        assert pad_rows.numel() == 0 or torch.all(pad_rows == 0), f"{f.name}: nonzero pad row"
        if meta["fieldNames"][f.name][0] == "present":
            assert torch.all(tokens[f.name][m == 1][:, 0] == 1), f"{f.name}: real row without present=1"

    # Contract: seat row 0 is always the acting seat.
    is_self = meta["fieldNames"]["seat"].index("isSelf")
    assert torch.all(tokens["seat"][:, 0, is_self] == 1)
    assert torch.all(masks["seat"][:, 0] == 1)
    # Fixture includes both 4p and 2p games -> seat-mask variety.
    seat_counts = masks["seat"].sum(dim=1)
    assert set(seat_counts.tolist()) >= {2.0, 4.0}

    # Single row == first row of batch.
    t1, m1 = spec.unflatten(flat[0])
    for name in t1:
        assert torch.equal(t1[name][0], tokens[name][0])
    for name in m1:
        assert torch.equal(m1[name][0], masks[name][0])


def test_parser_rejects_bad_input():
    spec, flat, meta = load_fixture()
    bad = flat[0].copy()
    bad[0] = 3  # wrong version code
    for fn in (lambda: ObsV2Spec.from_flat(bad), lambda: spec.unflatten(bad)):
        try:
            fn()
            raise AssertionError("accepted wrong version code")
        except ValueError:
            pass
    try:
        spec.unflatten(flat[:, :-1])
        raise AssertionError("accepted truncated row")
    except ValueError:
        pass
    meta_bad = copy.deepcopy(meta)
    meta_bad["dims"]["seat"] += 1
    try:
        ObsV2Spec.from_meta(meta_bad)
        raise AssertionError("accepted meta/header dim mismatch")
    except ValueError:
        pass


# ── model ────────────────────────────────────────────────────────────────────

def test_forward_shapes_and_finiteness():
    spec, flat, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=0).eval()
    obs = torch.from_numpy(flat)
    cands, mask = make_cands(flat.shape[0], 17, valid=11)
    with torch.no_grad():
        logits, probs, value = model(obs, cands, mask)
    assert logits.shape == probs.shape == (flat.shape[0], 17)
    assert value.shape == (flat.shape[0],)
    assert torch.isfinite(logits[mask]).all() and torch.isfinite(value).all()
    assert torch.all(logits[~mask] <= -1e8), "padded candidates not masked"
    assert torch.all(probs[~mask] < 1e-6)
    assert torch.allclose(probs.sum(dim=-1), torch.ones(flat.shape[0]), atol=1e-5)

    # Aux heads: shapes + finiteness.
    with torch.no_grad():
        fv = model.farm_value(obs)
        rm = model.route_mode_logits(obs)
        rp = model.reward_pick_logits(obs, cands, mask)
        pl, seat_real = model.placement_logits(obs)
    assert fv.shape == rm.shape == (flat.shape[0],)
    assert rp.shape == (flat.shape[0], 17)
    assert pl.shape == seat_real.shape == (flat.shape[0], spec.family("seat").cap)
    assert torch.isfinite(fv).all() and torch.isfinite(rm).all() and torch.isfinite(pl).all()
    assert torch.all(pl[~seat_real] == 0), "placement pred leaks onto pad seats"

    # score_single convenience path.
    with torch.no_grad():
        l1, p1, v1 = model.score_single(obs[0], cands[0, :11])
    assert l1.shape == (1, 11)
    assert torch.allclose(l1[0], logits[0, :11], atol=1e-5)


def test_zero_width_option_contract_and_multihorizon_reach30():
    spec, flat, _ = load_fixture()
    model = build_model_v2(
        spec, ACT_DIM, d_model=32, layers=1, heads=2,
        reach30_horizons=(20, 25, 30), seed=7,
    ).eval()
    obs = torch.from_numpy(flat[:5])
    cands, mask = make_cands(5, 7)
    empty_option = torch.zeros((5, 0), dtype=torch.float32)
    with torch.no_grad():
        logits, probs, value = model(obs, cands, mask, empty_option)
        all_reach = model.reach30_all_logits(obs, empty_option)
        primary = model.reach30_logits(obs, empty_option)
    assert model.option_dim == 0
    assert logits.shape == probs.shape == (5, 7) and value.shape == (5,)
    assert all_reach.shape == (5, 3)
    assert torch.equal(primary, all_reach[:, -1])
    try:
        model(obs, cands, mask, torch.ones((5, 1)))
        raise AssertionError("accepted non-empty option conditioning")
    except ValueError:
        pass


def test_seed_stable_init_and_deterministic_eval():
    spec, flat, _ = load_fixture()
    a = build_model_v2(spec, ACT_DIM, seed=123)
    b = build_model_v2(spec, ACT_DIM, seed=123)
    for (ka, va), (kb, vb) in zip(a.state_dict().items(), b.state_dict().items()):
        assert ka == kb and torch.equal(va, vb), f"seeded init differs at {ka}"

    a = a.eval()
    obs = torch.from_numpy(flat[:8])
    cands, mask = make_cands(8, 9)
    with torch.no_grad():
        out1 = a(obs, cands, mask)
        out2 = a(obs, cands, mask)
    for x, y in zip(out1, out2):
        assert torch.equal(x, y), "eval forward not deterministic on CPU"


def test_batch_vs_single_consistency():
    spec, flat, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=0).eval()
    n = 12
    obs = torch.from_numpy(flat[:n])
    cands, mask = make_cands(n, 13, valid=9)
    with torch.no_grad():
        bl, bp, bv = model(obs, cands, mask)
        for i in range(n):
            sl, sp, sv = model(obs[i : i + 1], cands[i : i + 1], mask[i : i + 1])
            assert torch.allclose(sl[0], bl[i], atol=1e-6), f"row {i}: logits batch/single drift"
            assert torch.allclose(sp[0], bp[i], atol=1e-6), f"row {i}: probs batch/single drift"
            assert torch.allclose(sv[0], bv[i], atol=1e-6), f"row {i}: value batch/single drift"


def test_permutation_invariance():
    spec, flat, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=0).eval()
    rng = np.random.default_rng(3)
    rows = flat[:6]
    cands, mask = make_cands(rows.shape[0], 8)
    with torch.no_grad():
        base = model(torch.from_numpy(rows), cands, mask)

    # (a) shuffling PAD positions only, (b) shuffling ALL rows of a family —
    # spirit order carries no meaning beyond the slot feature, and the model has
    # no positional encoding, so both must be no-ops.
    for label, permute in (
        ("pads-only", lambda m: _pad_only_perm(rng, m)),
        ("full-family", lambda m: rng.permutation(len(m))),
    ):
        for family in ("spirit", "rune", "market", "seat"):
            fam = spec.family(family)
            _, msk = _family_offsets(spec, family)
            shuffled = np.stack(
                [
                    permute_family(spec, r, family, np.asarray(permute(r[msk : msk + fam.cap])))
                    for r in rows
                ]
            )
            with torch.no_grad():
                got = model(torch.from_numpy(shuffled), cands, mask)
            for x, y, what in zip(got, base, ("logits", "probs", "value")):
                assert torch.allclose(x, y, atol=1e-5), f"{family} {label} permutation changed {what}"


def _pad_only_perm(rng: np.random.Generator, mask_slice: np.ndarray) -> np.ndarray:
    perm = np.arange(len(mask_slice))
    pads = np.where(mask_slice < 0.5)[0]
    perm[pads] = rng.permutation(pads)
    return perm


def test_gradient_flows_and_toy_loss_decreases():
    spec, flat, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=0).train()
    obs = torch.from_numpy(flat[:16])
    cands, mask = make_cands(16, 10, valid=8)
    target = torch.arange(16) % 8

    opt = torch.optim.Adam(model.parameters(), lr=3e-4)

    def loss_fn() -> torch.Tensor:
        logits, _, value = model(obs, cands, mask)
        return torch.nn.functional.cross_entropy(logits, target) + 0.1 * value.pow(2).mean()

    before = loss_fn()
    before.backward()
    grads = sum(1 for p in model.parameters() if p.grad is not None and p.grad.abs().sum() > 0)
    total = sum(1 for _ in model.parameters())
    # Aux heads (farm/route/reward_pick/placement) get no gradient from this loss.
    aux = {"farm_value_head", "route_mode_head", "reward_pick_head", "placement_head"}
    expected_no_grad = sum(1 for n, _ in model.named_parameters() if n.split(".")[0] in aux)
    assert grads >= total - expected_no_grad, f"only {grads}/{total} params got gradient"
    opt.step()
    opt.zero_grad()
    after = loss_fn()
    assert after.item() < before.item(), f"toy CE loss did not decrease: {before.item()} -> {after.item()}"


def test_checkpoint_roundtrip(tmpdir: Path | None = None):
    import tempfile

    spec, flat, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=5).eval()
    obs = torch.from_numpy(flat[:4])
    cands, mask = make_cands(4, 6)
    with torch.no_grad():
        want = model(obs, cands, mask)

    with tempfile.TemporaryDirectory() as td:
        pt = Path(td) / "weights" / "v2.pt"
        manifest_path = save_checkpoint(model, pt)
        assert pt.exists() and manifest_path.exists()
        with open(manifest_path) as f:
            manifest = json.load(f)
        assert manifest["format"] == "arc-entity-scorer-v2"
        assert manifest["obs_version"] == 2
        assert manifest["obs_flat_len"] == spec.flat_length
        assert manifest["act_dim"] == ACT_DIM
        assert manifest["params"] == model.param_count()

        loaded = load_checkpoint(pt, spec=spec).eval()
        with torch.no_grad():
            got = loaded(obs, cands, mask)
        for x, y in zip(got, want):
            assert torch.equal(x, y), "checkpoint round-trip changed outputs"

        # A checkpoint must refuse a different obs layout.
        other = ObsV2Spec.from_header(
            [2, 6, 0, 1, 122, 1, 6, 55, 2, 42, 58, 3, 6, 49, 4, 9, 18, 5, 1, 10]
        )
        if other.header != spec.header:
            try:
                load_checkpoint(pt, spec=other)
                raise AssertionError("loaded checkpoint against mismatched obs spec")
            except ValueError:
                pass


def test_reach30_checkpoint_capability_roundtrip():
    import tempfile

    spec, flat, _ = load_fixture()
    model = build_model_v2(
        spec, ACT_DIM, d_model=32, layers=1, heads=2,
        reach30_horizons=(20, 25, 30), seed=11,
    ).eval()
    model.reach30_trained = True
    obs = torch.from_numpy(flat[:4])
    with torch.no_grad():
        want = model.reach30_all_logits(obs)
    with tempfile.TemporaryDirectory() as td:
        pt = Path(td) / "reach.pt"
        manifest_path = save_checkpoint(model, pt)
        manifest = json.loads(manifest_path.read_text())
        assert manifest["reach30_horizons"] == [20, 25, 30]
        assert manifest["reach30_trained"] is True
        loaded = load_checkpoint(pt).eval()
        assert loaded.reach30_trained
        assert loaded.reach30_horizon == 30
        assert loaded.reach30_horizons == (20, 25, 30)
        with torch.no_grad():
            got = loaded.reach30_all_logits(obs)
        assert torch.equal(got, want)


def test_param_count_report():
    spec, _, _ = load_fixture()
    model = build_model_v2(spec, ACT_DIM, seed=0)
    n = model.param_count()
    print(f"  param count @ defaults (d_model=128, layers=3, heads=4, ff 4x): {n:,}")
    assert 400_000 < n < 5_000_000, f"param count {n} outside the expected few-M band"


def test_throughput_probe():
    spec, flat, _ = load_fixture()
    B, C = 256, 30
    reps = int(np.ceil(B / flat.shape[0]))
    obs_np = np.tile(flat, (reps, 1))[:B]

    for dev_name in ("cpu", "mps"):
        if dev_name == "mps" and not torch.backends.mps.is_available():
            print("  throughput mps: unavailable, skipped")
            continue
        device = torch.device(dev_name)
        model = build_model_v2(spec, ACT_DIM, seed=0, device=device).eval()
        obs = torch.from_numpy(obs_np).to(device)
        cands, mask = make_cands(B, C, valid=24)
        cands, mask = cands.to(device), mask.to(device)
        with torch.no_grad():
            for _ in range(3):  # warmup
                model(obs, cands, mask)
            if dev_name == "mps":
                torch.mps.synchronize()
            iters = 10
            t0 = time.perf_counter()
            for _ in range(iters):
                model(obs, cands, mask)
            if dev_name == "mps":
                torch.mps.synchronize()
            dt = time.perf_counter() - t0
        rows_s = B * iters / dt
        print(
            f"  throughput {dev_name}: B={B} C={C} -> {rows_s:,.0f} rows/s "
            f"({dt / iters * 1000:.1f} ms/batch)"
        )


def main() -> int:
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
