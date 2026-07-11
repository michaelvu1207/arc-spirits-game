# Arc Spirits — ML Bot Pipeline

A self-play training pipeline for a game-winning Arc Spirits bot, plus the headless,
portable environment others can use to build and submit their own bots.

The **game engine is the single source of truth** (TypeScript, `src/lib/play/`). The
**learning is Python** (PyTorch/MPS, `ml/`). They communicate through files on disk — TS
generates self-play data and runs inference; Python trains and exports weights. No slow
per-step bridge; both languages do what they're best at.

```
 TS self-play (native speed)            Python training (PyTorch / Apple MPS)
 ─────────────────────────────         ─────────────────────────────────────
 legalActions + encode + reward         model.py   candidate scorer + auxiliary heads
 driver.ts  → ml/data/*.jsonl   ──────▶ train.py   league PPO / BC / AlphaZero targets
 net.ts     ← ml/weights/*.json ◀────── export     weights → JSON
 arena/eval (win-rate gate)
```

## Why this shape

- **The engine is already a pure, deterministic reducer** (`applyGameCommand`), so full
  games run headless with no Supabase/DOM. `sim/selfPlay.ts` already proved this.
- **Candidate-scoring policy** handles the game's _parametric_ action space cleanly: the net
  scores each _legal_ action `score(concat(obs, actionFeat)) → logit`; softmax over the legal
  set is the policy. No brittle fixed action head.
- **`legalActions` uses the engine as its own legality oracle**: enumerate candidate commands,
  dry-run each through the pure reducer, keep the `ok` ones. The bot can take _any_ real
  in-game action (full rules action set; manual/sandbox/debug commands excluded).

## Current status (verified July 10, 2026)

- The bundled champion is **v13-2 / v13y2-gen44**
  (`ml/champions/v13-2/main-0-gen44.json`), with an **83-float observation** and
  **52-float action** contract. Live serving samples navigation decisions at temperature
  0.65; the evaluated search tier remains disabled because it regressed strength.
- The v14 push did not promote: its best candidate exploited v13-2 head-to-head but lost
  the broad gauntlet and heuristic-field gates. See `META_IMPACT_V13.md`.
- Current corrective work separates public action information from hidden RNG outcomes,
  records exact PPO behavior probabilities, and removes the unconditional delayed-PvP
  override. Those changes require a fresh aux-off reproduction and fixed-seed A/B before
  any new checkpoint can replace v13-2.
- Strong checkpoints still lean heavily on corruption/PvP pressure. Human play, a
  held-out exploiter field, and strategy-diversity checks remain important promotion
  layers; a single Elo or heuristic result is not enough.

## Files

**TypeScript (`src/lib/play/ml/`)**
| File | Role |
|---|---|
| `encode.ts` | `encodeObs` (OBS_DIM=83) + `encodeAction` (ACT_DIM=52) — the feature contract |
| `actions.ts` | `legalActions` — full legal candidate set (dry-run filtered) + `commandMatches` |
| `reward.ts` | `computeReturns` — placement blended with VP progress; winner pinned to 1.0 |
| `net.ts` | pure-TS forward pass of the exported weights (`NeuralPolicy`) |
| `driver.ts` | `playRecordingGame` — headless self-play plus exact behavior/trajectory recording |
| `../bots/contract.ts` | `arc-bot-v1` observation/action-id contract and the live `neural` profile key |
| `neuralBot.ts` | `planNeuralPhaseActions` / `getNeuralPolicy` — production planner for `botSim` |
| `nodeIo.ts` | catalog snapshot + JSONL/weights IO (node-only, test-runner use) |
| `_gen.test.ts` | data generation runner (`GEN=1 …`) |
| `_eval.test.ts` | win-rate evaluation vs heuristic fields (`EVAL=1 …`) |
| `_health.test.ts` | engine/heuristic finish-rate probe (`HEALTH=1 …`) |

**Python (`ml/`)**: `model.py`, `ppo.py`, `train.py`, `verify_export.py`, and
`benchmark_model_sizes.py` (see `README_train.md`). League orchestration lives under
`src/lib/play/ml/league/`; shell launchers remain for legacy and meta-discovery runs.

## Run it

Use `../docs/bot-testing-criteria.md` as the required testing and promotion gate before
trusting a checkpoint or starting a long GPU run.

```bash
npm run test:bot:engine
npm run test:bot:ml-smoke
npm run test:bot:az-smoke
```

```bash
# 0. one-time: snapshot the live catalog to ml/catalog.json (happens automatically on first gen)

# 1. cold-start data (parallel shards): MODE GAMES/shard SHARDS PREFIX
GEN_MAXROUNDS=90 ./ml/run_gen.sh heur 60 6 cold        # ~200k samples

# 2. full iterated pipeline: train → eval → (neural self-play → retrain → eval) × ITERS
ITERS=2 GEN_PER=45 SHARDS=6 EVAL_GAMES=24 ./ml/pipeline.sh

# individual steps:
EPOCHS=12 BETA=1.0 ./ml/train.sh                        # train → ml/weights/policy.json
EVAL=1 EVAL_OPPONENTS=pvphunter,mixed npx vitest run src/lib/play/ml/_eval.test.ts --disable-console-intercept
```

`pipeline.sh` writes `ml/eval_iter*.json` after each round so you can watch the bot improve.

## Productionizing the bot

`ml/train.py` exports `ml/weights/policy.json`; copy it to
`src/lib/play/ml/policy-weights.json` (bundled) and the live server picks it up.

Live bots use the shared `arc-bot-v1` contract in `src/lib/play/bots/contract.ts`.
The only public live bot profile key is `neural`; old heuristic profile names normalize to
that key at API/service boundaries. A session member with `bot_profile = 'neural'` is
driven by `planNeuralPhaseActions` in `server/botSim.ts`. If weights are missing, the
room uses uniform legal action selection as a safety fallback, not strategic heuristics.
That keeps live behavior on the same legal-action contract while making missing weights
obvious in evaluation.

```bash
cp ml/weights/policy.json src/lib/play/ml/policy-weights.json
```

## Historical AWR result (superseded; not a current promotion result)

The following table records the earlier June AWR-era result. It predates the 83-feature
encoder, rules v1.3, league-PPO champions, and the corrected stochastic/PPO contracts;
do not compare these numbers directly with v13/v14 or use this recipe for promotion.
It was trained end-to-end on the M4 (Apple MPS) via `ml/overnight.sh`. Deployable **hybrid**
selection, 24 games per opponent, **25% = fair share** in a 4-player game:

| Neural bot vs                       | Win rate    | avg place | avg VP |
| ----------------------------------- | ----------- | --------- | ------ |
| **pvphunter** (strongest heuristic) | **~70–75%** | ~1.3      | ~20    |
| **medium** (economy)                | **~71–79%** | ~1.0      | ~26–28 |
| **mixed field**                     | **~75–88%** | ~1.0      | ~26–29 |

~3× fair share against the strongest heuristic, confirmed across multiple training
iterations. The bot learns the only winning line under current rules: descend to **Fallen**
and farm the +3-VP group attack.

### The historical recipe (and its dead ends)

The win came from making three things line up — see `neuralBot.ts` / `ml/overnight.sh`:

1. **Champion-only behaviour-cloning prior** — imitate `pvphunter` (the only heuristic that
   wins now), not the whole field (whole-field BC collapses to `refillMarket` spam → 0 VP).
2. **AWR self-play, hard-filtered to winners (β=4)** — explore with value-lookahead + sampling
   (a Fallen-seeking shaping term + a no-op penalty get it to ~20–27% self-play wins), then
   advantage-weight so only the _winning_ trajectories shape the policy.
3. **Historical hybrid deployment selection** — outright win > fire `initiatePvp` when legal (the +3 VP is
   credited at encounter _resolution_, so pure BC/value miss this rare decisive action) >
   grab immediate VP > learned-policy positioning.

Dead ends (all gave ~0 VP): whole-field BC; pure policy-greedy (misses the rare PvP trigger);
1-ply value-lookahead alone (too myopic — camps the Rest chokepoint and idles); and an
_incoherent_ loop that explored with one policy and trained/evaluated another. Coherence
(train + eval the same agent) plus the hard winner-filter was the unlock.

## Scaling beyond the M4 (later)

The same pipeline scales to the SimForge A100 box. Use
`/data/share8/michaelvuaprilexperimentation/arc-bot` on `ubuntu@216.151.21.122`, check GPU
occupancy first, and run the smoke command in `../docs/bot-testing-criteria.md` before any
medium or long training run. The current v1 architecture is CPU-actor/GPU-learner: local
TypeScript inference is faster than the measured A100 socket path for this tiny network.
Use `npm run bot:bench:actors` for worker/serialization sweeps and
`npm run bot:bench:models` for full learner-step model/batch/bucketing sweeps. Older AWR
scripts are historical comparisons only and must not be the sole promotion evidence.
