# Simulation Optimization Plan — toward superhuman-scale ML training

Goal: take the headless engine from ~**1.6 games/s/core** to the throughput a professional,
production-grade RL pipeline needs (≈10⁸–10⁹ env steps to reach superhuman in a game this
complex), with a clear ladder of CPU → WASM → GPU options.

## July 10, 2026 status update

The original 1.6 games/s diagnosis below is historical. The legality oracle,
mutating commit path, combat-clone reduction, and 30-round rule have already moved
the raw local engine to roughly **16.6 random games/s** and **13.9 medium games/s**
on the M4 in the current audit. The production-shaped neural actor path is now the
relevant bottleneck: policy/candidate work plus four-seat trajectory recording was
about **2.8 games/s / 939 rows/s** with one local worker; removing recording reached
about **4.4 games/s**, and four workers reached about **10.2 games/s** before eight
workers regressed on the four-performance-core laptop.

SimForge has 128 physical EPYC cores, 1 TiB RAM, and 8 idle A100-40GB GPUs. Current
v1 leagues correctly keep actor inference in local TypeScript and use an A100 only
for learning. Measured A100 Unix-socket inference topped out around 4.5k rows/s with
6-13 ms closed-loop latency, versus roughly 90-102 microseconds for local h128
scoring, so moving the tiny v1 policy to GPU actors would make decisions slower.

The current optimization order is therefore:

1. preserve fairness and exact trajectories;
2. use persistent dynamic seed scheduling to cut worker stragglers;
3. sweep worker count/matchup concurrency and NUMA placement on SimForge;
4. reduce recording/serialization and the remaining heuristic/combat-preview costs;
5. bucket ragged PPO candidates before increasing learner batch size;
6. consider a vectorized/GPU environment only after those measured CPU levers are
   exhausted.

The repeatable actor and learner probes are `npm run bot:bench:actors` and
`npm run bot:bench:models`; the latter includes ragged collation, transfer, gradient
clipping, optimizer update, finite checks, and random-vs-bucketed padding.

### July 11, 2026 SimForge measurement

Commit `ddf5301` was benchmarked on a fresh corrected-contract h128 generation. The
isolated production-shaped actor scaled from about 5.8 games/s at two workers to
32.9 games/s at sixteen workers. For the actual 16-matchup league scheduler with a
40-worker budget, four concurrent matchups was the best tested setting: the same
512 games and 45,075 samples took 25.1 seconds, versus 27.0 seconds at six, 30.1
seconds at eight, and 34.9 seconds at sixteen. The fair-v15 configs therefore use
`matchupConcurrency: 4`.

On one A100-40GB, candidate-count bucketing raised the best replay learner throughput
to roughly 248k rows/s for h128, 279k for h256, and 240k for h512. In the real trainer,
batch 1024 shortened a four-epoch h128 update only from 8.74 to 7.47 seconds; batch
4096 took 8.10 seconds. Simulation remains the bottleneck, and fair-v15 keeps batch
256 so the systems change does not also change PPO optimization dynamics.

The fair-v15 reproduction configs also set `promoteEvery: 0`: checkpoints are
evaluated and promoted only after the fixed-seed experiment, rather than spending
training time on correlated intermediate gauntlets. The manager now matches a
gauntlet-history result by checkpoint path, so unrelated concurrent league runs
cannot accidentally consume one another's Elo line.

## Diagnosis (measured)

- Single core, 4-player full games: **~1.6 games/s, ~144 rounds/s, ~912 command-applies/s, ~622 ms/game.**
- **`random` and `medium` bots run at the same speed → the cost is the ENGINE, not the policy.**
- Root cause: `applyGameCommand` deep-clones the whole state on **every** call via
  `JSON.parse(JSON.stringify(state))` (`runtime.ts:cloneState`). A game is ~90 rounds ×
  ~30 commands/round ≈ **2,700 full-state JSON round-trips per game**. That clone dominates.
- Secondary per-command cost: `ensureStateShape` re-normalizes the state every call.

## Target

PPO/self-play to superhuman ≈ 10⁸–10⁹ env steps. At today's ~10³ steps/s/core that's
weeks–years. We need **~10⁵–10⁶ steps/s aggregate**. The ladder below gets there.

## Guiding principle: a golden-reference parity harness (do this FIRST)

The canonical TS `applyGameCommand` is the **source of truth** for the rules. EVERY optimized
path (in-place, WASM, GPU/JAX) must be **differential-tested** against it: run K random seeded
rollouts through both, assert identical state hashes at every step. This is the safety net that
makes all the speedups below safe — without it, a "fast but subtly wrong" engine silently
corrupts training. Build this before optimizing.

## The optimization ladder

| Tier                  | Change                      | Expected               | Effort | Risk               |
| --------------------- | --------------------------- | ---------------------- | ------ | ------------------ |
| **1. CPU hot-path**   | kill the per-command clone  | **5–30×**              | S–M    | med (parity-gated) |
| **2. Parallelism**    | worker-pool / multi-machine | ×cores (×8 here)       | S      | low                |
| **3. WASM**           | compile engine to WASM      | 2–10× + Python interop | L      | med                |
| **4. GPU-vectorized** | data-parallel batched env   | 100–1000×              | XL     | high               |
| **5. Distributed RL** | actor-learner fleet         | scale-out              | L      | med                |

### Tier 1 — CPU hot-path (do first; biggest bang/effort)

The clone exists only for _purity_ (so callers keep the old state). In self-play we apply
commands sequentially and **discard the old state** — so the clone is pure waste in the hot loop.

1. **In-place / no-clone fast path.** Add `applyGameCommand(state, …, { mutate: true })` (or a
   `stepInPlace`) that skips `cloneState` and mutates directly. Guard: most commands validate
   _before_ mutating (early-return on failure); for the few that don't, snapshot only the touched
   subtree or fall back to clone-on-write. Parity-test exhaustively. **Expected 5–30×.**
2. **Trim what's cloned/carried.** `bags.history` (the `BagsData` spectate/export blob) and full
   bag `contents` are likely large and irrelevant to the rules sim — drop or shallow-copy them in
   a sim-only state. **Often the single cheapest big win** once profiled.
3. **Faster clone where still needed** (bot-search rollouts): replace JSON round-trip with a typed
   structural clone that shares immutable substructures (catalog refs, history). 2–5×.
4. **Hoist `ensureStateShape`** out of the per-command path (normalize once at game start).
5. **Cheaper `legalActions`** — it dry-runs N candidates, each cloning; reuse the no-clone path.

After Tier 1: plausibly **~10–30 games/s/core** (hundreds of decisions/s → ~10⁴–10⁵ steps/s/core).

### Tier 2 — Parallelism (linear, easy)

Worker-thread / multi-process pool across all cores (we already shard 6×). Formalize a
self-play worker pool; then a cloud CPU fleet for big runs. Linear scaling → ×8 locally,
×100s in the cloud. Combined with Tier 1 this likely **already suffices for strong/superhuman**
self-play (OpenAI Five trained on CPU env fleets).

### Tier 3 — WASM (portability + Python RL)

Compile the engine (or its hot core, via AssemblyScript or a Rust port) to WASM. Benefits:
runs in Node, **and in-process from Python** — so a PettingZoo/Gymnasium wrapper can step it with
no IPC, unlocking the mature Python RL stack on GPU. 2–10× over JS + the cross-language bridge.

### Tier 4 — GPU-vectorized simulation (only if we hit the wall)

The extreme-scale unlock (à la EnvPool / Brax / Pgx / Isaac Gym): run thousands of game
instances in lockstep as **data-parallel array ops** (SoA layout, branch-free kernels) in JAX or
CUDA/Triton. 100–1000× but an **XL rewrite** of branching rules into vectorized kernels, with
high rules-drift risk — hence the parity harness is mandatory. Most RL projects never need this;
reserve it for if Tiers 1–3 + cloud can't hit the step budget.

### Tier 5 — Distributed RL (the production training system)

Actor-learner architecture (IMPALA/SEED-RL): many CPU/WASM env **actors** generate experience →
central **GPU learner** (PyTorch/JAX); experience queue, checkpointing, and **league play** to
prevent strategy collapse in the multiplayer free-for-all. This is the scaffold that actually
produces a superhuman agent once env throughput is solved.

## Recommended sequencing

1. **Profile** the state (what % of clone time is `bags.history` vs players vs combats) — 1 hr,
   decides Tier-1 ordering.
2. **Build the parity harness** (golden TS reference + differential rollout test).
3. **Tier 1** (no-clone fast path + trim state) behind the parity gate → re-benchmark.
4. **Tier 2** (worker pool) → measure aggregate; if it hits the step budget, train.
5. **Tier 3 (WASM + Python bridge)** when moving to serious GPU RL / the actor-learner fleet.
6. **Tier 4 (GPU-vectorized)** only if step-starved at the frontier.

Bottom line: Tiers 1–2 (days of work, low risk, parity-gated) realistically get us **~100–1000×**
aggregate over today — enough to train strong agents now; WASM + distributed for production
superhuman; GPU-vectorized held in reserve.

---

## Results & decisions (implemented + measured)

A 6-dimension Opus-4.8 audit (allocation, dry-run-cost, per-command-overhead, parallel-scaling,
wasm-native, status-review) plus a synthesis pass evaluated the implementation and hunted for
remaining wins. What we acted on, each benchmarked per the "re-benchmark after every change" rule:

### ✅ Tier 1 — in-place mutate fast path (`applyGameCommand(..., { mutate: true })`)

Skips the defensive deep clone in the self-play / training hot loop; parity-gated by
`sim/_parity.test.ts` (byte-identical state vs the cloning reducer across 8 seeds). Used in
`sim/selfPlay.ts` and the parity harness. ~1.5× single-core on raw self-play.

### ✅ `bags.history` clone-cost cut (the headline allocation win)

`buildHistoryBags` returns a snapshot whose bags **alias the same objects already on `state.bags`**
(`history.hexSpirits === bags.hexSpirits`). `JSON.parse(JSON.stringify())` can't see the aliasing,
so it serializes every bag's contents **twice**. `bags.history` is read in exactly ONE place —
`buildHistorySnapshotRows` (server persistence) — and never by any handler, policy, `legalActions`
dry-run, or the training loop. Fix (`cloneState`, parity-gated): detach `history` before the JSON
round-trip and rebuild it **by reference** on the clone (zero extra serialized bytes).

- **Isolated clone cost: 120.97 → 101.09 µs/clone (−16.4%, +19.6% clones/s)** (`sim/_profile.test.ts`).
- **End-to-end RL data-gen (`ml/_gen.test.ts`, 24 heur games): 29.4s → 22.7s (−23%), byte-identical
  output** (same 1562 samples, same 63% finished) — the gen path is dominated by `legalActions`
  dry-run clones, so it gains more than the isolated number.
- Lands on the JSON-clone paths: `ml/driver.ts` `legalActions` fan-out + the live server. (Self-play's
  hot loop uses `mutate` and never clones; `botPolicy` uses `structuredClone`, which preserves
  aliasing and so was never affected.)

### ✅ Tier 1 extended to the RL driver (`ml/driver.ts` heuristic commit)

The driver's per-command commit (`applyHeuristic`) deep-cloned on every heuristic command even though
the prior state is discarded each step (same shape as self-play). Switched the commit to the
parity-tested `mutate: true` fast path (the recording dry-runs above still clone, preserving the
candidate states). Validated by **byte-identical training data** — same SHA-256 over the generated
JSONL (1562 samples) before vs after — proving no aliasing corruption in the recorded
`obs`/`phi`/`cands`.

- **RL data-gen (24 heur games): 22.7s → 18.8s (−17% more).**

### ✅ `isLegal` redundant double-clone removed (`server/botPolicy.ts:85`)

`isLegal` did `applyGameCommand(structuredClone(state), …)` — but the default (no-`mutate`)
`applyGameCommand` already deep-clones its input internally, so the `structuredClone` wrapper made a
full extra deep copy that was immediately cloned again and discarded; `isLegal` only reads `.ok`.
Dropped the wrapper. On the data-gen heuristic hot path (all FIELD profiles are `kind:'medium'` →
`planMediumPhaseActions` → `isLegal` at navigation/encounter/location decisions).

- Surfaced by the final verification critic (measured the wrapper at ~61% per-probe overhead,
  141.6 → 55.2 µs). Validated: **identical SHA-256** over generated JSONL (decisions unchanged).
- **RL data-gen (24 heur games): 18.8s → 17.3s (−8% more).**

**Compounded data-gen result (`bags.history` + driver mutate commit + `isLegal` declone):
29.4s → 22.7s → 18.8s → 17.3s = −41% (1.70× throughput), byte-identical output across the whole chain.**

### ✅ Parity gate extended to the data-gen FIELD profiles (`sim/_parity.test.ts`)

The standing parity gate previously drove only the `medium` profile. Added a second case that runs
clone-vs-mutate byte-identity across the data-gen FIELD (`pvphunter/aggressive/cultivator/survivor/
fighter/hard`, 5 seeds) — these exercise PvP-initiation, abyss-fishing, arcane-trade, and
corruption-discard branches medium alone doesn't. This makes the in-place fast path's correctness
(and the driver's `mutate:true` commit) a **permanent regression guard** on the exact command surface
training data is generated from, rather than a one-time manual hash. Both parity cases pass; suite 777.

### ✅ Tier 2 — parallelism (already committed)

`ml/run_gen.sh` forks N shards (child processes), each running `_gen.test.ts` over a disjoint seed
range → per-shard JSONL → merge. This is the production data-gen fan-out; per-core throughput
(~1 game/s heur, post-`bags.history`) multiplies across cores. The `bags.history` win compounds
per shard.

### ❌ Rejected after benchmarking — `ensureStateShape` skip

A Symbol-marked "already-shaped" fast path to skip the ~61 idempotent `??=`/backfill ops per player
per command. Parity-safe, but **measured no gain** on the mutate loop (1723 → 1760 ms/game, within
noise) — the per-command cost is dominated by handler/effects work, not the cheap field checks.
Reverted to avoid complexity without payoff. (Would only help the clone/dry-run path, where the
~120µs clone dwarfs it anyway.)

### ❌ Tier 3 — WASM: do NOT pursue (audit consensus)

The hot path is megamorphic dynamic dispatch (37 string-keyed class-effect modules, fresh context
per class per trigger). QuickJS-in-WASM is an **interpreter — typically 3–10× slower than V8's JIT**
on exactly this code. A native Rust/AssemblyScript port is XL effort + high rules-drift risk against
a 2,771-line reducer + ~37 class modules, and the 8-seed parity gate is insufficient to certify a
reimplementation. TS allocation cleanup recovers most of what a port would buy, at a fraction of the
risk. WASM's only legitimate value (in-process Python RL bridge) is better served by Node-subprocess
/ Arrow-IPC at Tier 5. **Tier 3 is dropped as a speed play.**

### ⏭ Deferred (known, higher-risk; not cheap wins)

- **`legalActions` dry-run reduction via pure pre-checks** (audit's biggest remaining RL-path lever:
  cut location-phase clones from ~50-95 to ~10-25). **Deferred deliberately**: a pre-check that is
  even slightly too aggressive would HIDE a legal action from the bot, violating the binding
  action-set-fidelity requirement ("the bot should be able to do any action that is in the actual
  game"). Only safe with a strict under-approximation + a differential test asserting the legal SET
  equals the full clone-based oracle across many seeds. Worth doing in a focused pass, not a drive-by.
- **Tier 5 — single-box actor-learner** (worker pool ⇄ GPU trainer with a shared replay buffer):
  pure infra, no reducer risk; the natural next step once data-gen throughput is the bottleneck.

### ⚠️ Correctness constraint discovered (load-bearing for any rollback scheme)

`resolveLocationInteraction` **mutates before it can return `failure('cannot_afford')`** (Undercover
discards, bag pushes/shuffles, clears the one-shot `freeNextRelicTrade`). So a naive
"mutate-and-rollback-only-on-reject" dry-run is UNSAFE — `legalActions` must keep cloning (or use a
true snapshot/restore). The parity test only covers commands that the heuristic emits AND that
succeed; it does not prove rejected candidates leave state pristine.

---

## Round 2 — the legality oracle + the 30-round cap (the big one)

A CPU profile (`sim/_cpuprofile.test.ts`, `CPUPROF=1`) showed the truth: **~71% of all sim time was
deep-cloning** the ~38 KB state; the game rules themselves were ~4%. The clones were not from
_playing_ (one move forward = `mutate`, ~free) but from _asking "is this legal / what-if?"_ — the
engine answers legality by trial-applying a candidate on a fresh clone and reading one boolean. We
attacked the _reason_ we clone.

### ✅ `canApply` — a pure legality oracle (`src/lib/play/legality.ts`)

A pure, side-effect-free predicate `canApply(state, actor, cmd, catalog): true | false | undefined`
that decides legality by READING state, no clone. `undefined` = "defer to the clone oracle". Every
enumerated command's reachable `failure(...)` guards were mapped (Opus-4.8 fan-out) and mirrored
exactly; impure cases (combat / awaken-condition / augment placement acceptance) return `false` on
their cheap pure guards and otherwise defer. Three commands (`absorbSpirit`, `attachRuneToSpirit`,
`detachRuneFromSpirit`) have **no reducer case** → always `false` (a whole `×spirits` block of
illegal candidates eliminated for free).

- **Fidelity is GUARANTEED, not hoped:** `ml/_canApply.test.ts` drives games across all profiles and
  asserts, for every enumerated candidate (~245 k/run), `canApply === undefined || === reducer.ok`.
  It can only ever DEFER, never disagree — so the legal set stays a faithful, complete oracle of the
  real action set (the binding directive). **Decided 99.7% of candidates clone-free, 0 mismatches.**
- Wired into three paths, each verified **byte-identical** (gen JSONL SHA + parity):
  `legalActions` (cmd-only → zero clones), `botPolicy.isLegal` (the bot's own probes), and the bot's
  planning sequence (`advanceWorking`: mutate-in-place when `canApply` PROVES legal — provably can't
  mutate-then-fail — else skip/clone). `cloneState` self-time fell 58.5% → ~3%.

### ✅ Cheaper combat-evaluation clone (`cloneForCombatSim`)

`computeKillProbability` / `firepowerKillProbability` / `expectedAttack` cloned the whole state to run
`resetCombatFlags` + the `inCombat` trigger. Those write only to PLAYERS (acting + colocated; the
trigger's log is a throwaway param, not `state.log`). Switched to `{ ...state, players: clone }` —
shares bags (44% of the bytes, only read in combat). Verified byte-identical (gen SHA + full combat
suite). `structuredClone` self-time 42.5% → ~30%.

### ✅ 30-round cap (`MAX_ROUNDS = 30`, `phases.ts tryAdvanceFromCleanup`)

Round 30 is the last round; if its cleanup closes with no VP-target winner, the game ends and the
most Victory Points wins (ties → seat order). One guard before `state.round += 1`, after the existing
end-conditions. Independent of the analytics `CURVE_POINTS`/`ROUND_NORM = 36`. Effects:

- Games now **finish 100%** (was ~63% at `maxRounds=90`) and end by round 30 → ~2-3× fewer decisions.
- **Makes the economy / VP-accumulation line viable** — you win by LEADING on VP at the cap, not only
  by racing to 30 VP (which the economy line couldn't reach under prior rules). All 778 tests pass.

### 📊 Measured result (single-core, M4, heur data-gen path)

| stage                                  | 24-game gen    | games/s    |
| -------------------------------------- | -------------- | ---------- |
| start of investigation                 | ~17–29 s       | ~1         |
| `canApply` (legalActions + isLegal)    | ~11 s          | ~2.2       |
| + bot planning `advanceWorking` mutate | ~4.5 s         | ~5         |
| + 30-round cap                         | ~2.0 s         | ~12        |
| + `cloneForCombatSim`                  | **~1.8–2.0 s** | **~12–13** |

**~12–15× single-core**, every step byte-identical / fidelity-gated. Parallel via `ml/run_gen.sh`:
180 games / 6.9 s ≈ 26 games/s across ~5.4 cores (per-shard vitest startup depresses short runs;
steady-state for long runs approaches single-core × cores).

### Remaining bottleneck (diminishing returns / rising risk)

Profile now: bot decision LOGIC `planMediumPhaseActions` ~32% (intrinsic compute, not cloning) and
the players-only combat clone ~30%. Going further means a pure combat-buff calculator (a `canApply`
for combat — large, differential-testable) or accepting the heuristic-bot cost (irrelevant once
neural self-play, which uses a fast forward pass, replaces the heuristic field). Deferred.
