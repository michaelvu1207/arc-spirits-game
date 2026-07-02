# M0 Baseline — 2026-07-01 (gauntlet-v1, immutable)

Every future bot-strength number compares against this table. Full 800-game
gauntlet-v1 runs (200 base seeds × 4 seat rotations, 4p FFA, frozen anchor pool).
Result JSONs committed under `ml/gauntlet_results/`.

| Candidate | Elo vs anchors | Mean placement | Win rate | Runtime |
|---|---|---|---|---|
| **live policy-weights (traceq-damage-nearmiss-vp28-29)** | **+221** | **1.494** | **59.8%** | 9.1 min |
| routeexecq-shared-allseat best_policy | +192 | 1.563 | 54.8% | 9.1 min |
| pvphunter (strongest heuristic) | +190 | 1.623 | 53.9% | 10.6 min |

Notes
- The live net (shipped in `src/lib/play/ml/policy-weights.json` at commit df43cc7,
  fixing the uniform-random production degradation) is the strongest known agent:
  +31 Elo over the strongest heuristic.
- Elo = closed-form logistic of Laplace-smoothed pairwise placement score vs the
  anchor pool (see `src/lib/play/ml/gauntlet/manifest.ts`). Aggregate is over
  2,400 candidate-vs-anchor pairings per run.
- `act52-full-g6` (the June-27 "champion") is dim-incompatible (obs 55 vs 62) and
  recorded as such in the manifest — not scoreable, not an anchor.

## Throughput baseline (single core, Apple Silicon Mac, 2026-07-01)

| Path | games/s |
|---|---|
| Heuristic 4p mirror (`hard`) | ~8–9 |
| Neural 4p (`playRecordingGame`, net every decision) | ~4.8 |

M1 target: ≥500–1,000 neural games/s aggregate (worker pool + batched GPU
inference server). Napkin: 128 simforge1 cores × 4.8 ≈ 600/s before optimization.

## M0 exit criteria — all met
- [x] Working tree committed + tagged `baseline-m0`; history split into clean commits
- [x] Live random-bot bug fixed and shipped (df43cc7)
- [x] `ml/meta_runs` pruned 549 → 7 dirs (1.3 GB archived to `ml/_archive/`)
- [x] `selfplay.ts` split into `gates/recorder/loop` (byte-identical determinism proof)
- [x] gauntlet-v1 frozen (46379da) — changes require version bump
- [x] Baselines recorded (this file)
