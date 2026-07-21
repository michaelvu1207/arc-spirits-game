# Seat-Invariant Retrain + Training Throughput Plan

Owner: Michael · Date: 2026-07-20 · Branch: `bot/seat-invariant-obs`

## 1. Why we're retraining (Part B)

The live bot underperforms in every non-Red seat. Root cause is **not** a game
imbalance — the game is symmetric (simultaneous actions, no seat conflict). It is a
**training artifact**: obs-v2 fed the policy an *absolute* seat-color one-hot
(`seatToken` + `spiritToken` in `encodeV2.ts`), so the 4p self-play policy learned a
seat-color convention — play strongly as Red (seat 0), passively elsewhere. `/api/play/solo`
always seats the human as Red, so live bots always got the weak seats; the human bench
put the bot in seat 0, so it looked strong. Mirror self-play confirmed it: Red beats an
identical policy 6-0 regardless of engine processing order.

**Fix (implemented, obs-v3):** replace the absolute seat/owner color one-hots with a
**rotation-invariant offset-from-self rank** (self is always slot 0). Pure rotation of
the color ring ⇒ the observation is byte-identical under any relabeling of seats ⇒ the
policy physically cannot condition on absolute seat color. Same dims (3419 floats), so
the trainer needs no shape change. Version code bumped 2→3 so old-obs checkpoints can't
mix with new data. This forces a fresh training run — which §3-4 make fast.

## 2. Current pipeline: measured bottleneck

From live `transfer-4p-e/history.jsonl` + `mpstat` + `infer-main-0.log` (simforge1, 128
cores, 8× A100-40GB, **shared with the Alpamayo sim2real tenant**):

| phase | wall | bound by |
|---|---|---|
| pool (game-gen, 1024 games) | 50-59 s | inference latency (batch ~40/512) + CPU |
| **train step** | **77-93 s** | **CPU dataloader (num_workers=0), GPU near-idle** |
| eval | 13-14 s | — |
| **gen total** | **~150-165 s** | — |

Reality check on "A100 utilization": with a d128/l3 model, **no A100 is the limiter**.
GPUs 0/1/5 sit at **0% util** all gen. The trainer is CPU-bound (single-threaded JSON
parse of 110k × 3419-float rows before each step). Game-gen inference is *latency*-bound
(batch ~40 of a 512 max, 85 forwards/s). And arc-bot only wins **~32 of 128 cores** —
Alpamayo (carla/nurec) holds ~78. Only **one** lane (4p-c) is generating; ~12 stale
`infer_server.py` processes pin VRAM at 0% util.

So there are two distinct goals, and the plan serves both honestly:
- **Fastest to a seat-invariant champion** → fix the CPU trainer + warm-start (§3).
- **Maximize A100 utilization / ambition** → parallel lanes + a bigger model that the
  idle A100s can afford for free (§4).

## 3. Tier 1 — Fastest path to a correct champion (do first, low risk)

**T1.1 — Fix the trainer dataloader.** `ml/train.py:1185` `DataLoader(...)` runs
`num_workers=0, pin_memory=False`. Set `num_workers=8-16, pin_memory=True,
persistent_workers=True`, and cache each gen's parsed obs as a binary `.npy`/tensor
instead of re-parsing JSONL every gen. Must preserve the seed-deterministic shuffle
(`train.py:731`) and numeric parity.
→ **train step 85 s → 20-40 s. Gen wall ~150 s → ~100-115 s (~35% faster), GPU util up.**

**T1.2 — Warm-start from the code-2 champion.** obs-v3 keeps identical dims and the
same d128/l3 arch, so `gen-128` weights load directly. ~90% of the obs is unchanged; the
model already knows the game and only needs to shed seat-color dependence.
→ **re-plateau in ~30-50 gens instead of ~128** (the code-2 run climbed elo 289→367
over gens 96-128; a warm-started run should recover that band far sooner).

**T1.3 — Reap stale infer servers** (hygiene): ~12 orphaned `infer_server.py` whose
orchestrators are dead, pinning VRAM on GPUs 0-4. Frees VRAM for new lanes. Zero risk.

**Tier-1 result:** first seat-invariant champion in **~40 gens × ~110 s ≈ 70-90 min**,
vs. ~128 × 165 s ≈ **5.9 h** today. **~4-5× wall-clock.**

## 4. Tier 2 — Use the idle A100s (ambitious, parallel)

**T2.1 — Parallel independent seeds, one orchestrator per idle GPU.** Launch 2-3 code-3
lanes pinned via `CUDA_VISIBLE_DEVICES` to GPUs 5, 0, 1. Lanes are fully independent;
pick the best champion by gauntlet + multi-seat humanbench. Because arc-bot shares CPU
with Alpamayo (~42 idle cores), size lanes to the *cores*, not the GPUs: ~2-3 lanes ×
~16-20 workers each (not 96), so we fill idle cores without starving Alpamayo.
→ **2-3 candidate champions in the same wall-clock; robustness against a bad seed.**

**T2.2 — Bigger model, since the GPU is free (the real "A100 utilization" lever).**
Bump `v2` d128/l3 → **d256/l4**. The A100 absorbs this at ~no wall-clock cost (train
step is dataloader-bound, not compute-bound) and it raises the strength ceiling. Caveat:
a wider model **cannot** warm-start from d128 weights (dim mismatch) → trains from
scratch. So run it as a **parallel bet**: one warm-started d128 lane (fast, T1) + one
d256 from-scratch lane (higher ceiling, uses otherwise-idle A100). Promote whichever
wins the bench.

**T2.3 — Inference batching.** Raise `v2.windowMs` 4→8-12 to coalesce forwards toward
batch 100-200 (currently ~40). Modest pool speedup; low priority vs T1.

## 5. Tier 3 — Stretch (bigger swings, only if we want more)

- **Vectorize the game simulator.** The true throughput ceiling is the CPU TS engine
  (`playRecordingGame`, one game per worker thread). Batching many games per process or
  a data-oriented rewrite would multiply games/sec far beyond core count. Large effort.
- **CPU renegotiation with Alpamayo.** arc-bot gets only ~32/128 cores. Reclaiming cores
  is the single biggest game-gen lever — but Alpamayo is your other live project; this is
  your call, not something I'll do unilaterally.
- **Horizontal scale** across more machines if available.

## 6. Migration sequencing (safe, non-destructive)

The remote `src/encodeV2.ts` is **shared by all league experiments**; flipping it to
code-3 in place would corrupt the running code-2 `4p-c` lane (worker_threads re-import
per gen via jiti). So:

1. Create an **isolated checkout/worktree** of arc-bot for the code-3 run — 4p-c keeps
   running code-2 undisturbed.
2. In the code-3 checkout: drop in the staged `encodeV2.ts` (already at
   `_staging_obsv3/`, byte-verified vs. the current file pre-edit) + bump
   `ml/obs_v2.py` `OBS_V2_VERSION_CODE` 2→3 + regenerate the Python parity fixture
   (`FIXTURE=1 npx vitest run _obsv2fixture.test.ts`).
3. Apply T1.1 trainer fix in that checkout.
4. Launch the code-3 lane(s) warm-started from `transfer-4p-e/checkpoints/main-0-gen128.pt`.

## 7. Validation (before any deploy)

The bug is seat imbalance, so the acceptance test **is** seat balance:
1. **Seat-balance mirror test** — same code-3 policy in all seats; VP spread across seats
   must be flat (no seat wins systematically). This is the direct pass/fail for B.
2. **Multi-seat humanbench** — replay Michael's games with the bot in *each* seat, not
   just seat 0. Old bench masked the bug by only using seat 0.
3. **Gauntlet elo** ≥ code-2 champion (~367) and **1v1 duel** parity across colors.
4. Only then deploy: merge `bot/seat-invariant-obs` (encoder) **together with** the new
   code-3 weights, in one step — never a code-3 encoder against code-2 live weights.

## 8. Guardrails

- Don't starve the Alpamayo tenant: size arc lanes to idle cores, don't kill its procs.
- obs-v3 encoder + weights deploy atomically; `main` stays on code-2 until then.
- Preserve trainer numeric parity + deterministic seeds when touching the dataloader.
