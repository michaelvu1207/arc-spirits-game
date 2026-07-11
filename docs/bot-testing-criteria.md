# Arc Spirits Bot Testing Criteria

This is the acceptance checklist for Arc bot development, ML training, dashboard work, and Browser verification.

Architecture reference: `docs/bot-development-architecture.md`.

## Required Gates

Run the smallest gate that matches the change, then record the exact command, run id, output artifact path, and pass/fail summary.

| Change type                                                        | Required test                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Engine/rules/legal-action changes                                  | `npm run check`, `npm test`, plus targeted reducer/legal-action parity tests  |
| Bot policy, observation, action encoding, or training-data changes | Engine gate plus generation smoke, training smoke, and eval smoke             |
| AlphaZero/MCTS/planner changes                                     | Engine gate plus `ml/discover_meta.sh` smoke and planner/eval tests           |
| Clean farm/economy strategy changes                                | Engine gate plus `npm run test:bot:clean-farm`                                |
| Curriculum, league, or population-training changes                 | Engine gate plus curriculum slice, all-planner meta, arena, and league/duel   |
| Dashboard/UI/browser-facing changes                                | Engine or ML gate when relevant, then Browser verification and Playwright E2E |
| Long GPU training recipe changes                                   | Local smoke first, remote GPU smoke second, then long run                     |
| Live bot profile/contract changes                                  | Engine gate plus `src/lib/play/bots/contract.test.ts` and a Browser room flow |

Do not treat a long run as valid if the smoke gate fails.

## Fairness and PPO correctness gates

These are blocking gates for every new PPO checkpoint generated after July 10,
2026:

- **Public information stays public.** A candidate may expose the selected
  monster's visible stats, remaining lives, public reward track/options, expected
  incoming damage, and kill/reward probabilities. It must not expose the die roll
  that will occur, the identity of a not-yet-drawn Spirit, a future bag order, or
  a stochastic PvP resolution before the action is committed.
- **Hidden-seed invariance.** Changing only the hidden RNG stream must leave the
  policy observation, candidate features, candidate support, logits/search values,
  and selected action identical before commitment. Cover constrained driver play,
  search, and enabled self-play gates/oracles, not only base action encoding.
- **Exact behavior probabilities.** PPO policy rows must retain the exact mask,
  temperature, and serialized float32 inputs used by the actor. At learner start,
  the sampled-row ratio must be numerically 1 within a tight end-to-end tolerance.
- **Complete trajectories.** Deterministic hybrid/search overrides remain in the
  episode for reward, terminal, value, placement, and auxiliary targets. They carry
  `policyMask=false`; only the policy surrogate/entropy/KL terms exclude them. A
  terminal override must not erase placement/win reward or intervening dense reward.
- **Auxiliary objectives are an A/B, not a repair claim.** Reproduce the corrected
  h128 baseline with farm/reward/route coefficients off, then compare fixed seeds
  with them on. Report label coverage, auxiliary gradient scale, KL, clip fraction,
  entropy, and effective learning rate.

## Promotion Philosophy

Do not promote a checkpoint because it wins one local metric. The desired bot
program is population + league + curriculum + search:

- Simulator and legal action tests must pass first.
- Curriculum slices must prove the model can execute specific known skills such
  as reward picks, low-rung Abyss farming, and farm-vs-build decisions.
- All-planner meta must show the learned population can find scoring lines from
  normal starts.
- Arena eval must prove the candidate does not collapse against fixed heuristic
  and historical learned opponents.
- League/duel eval must prove the candidate beats or at least counters the
  current learned champion without forgetting known counters.
- Unrestricted meta eval must prove the monster-farm-to-player-attack route:
  efficient early Abyss farming first, then attacks on valuable Good players once
  the current monster rung is less efficient or less cleanly survivable.
- Do not evaluate the unrestricted "best bot" through a Pure or non-Fallen status
  cap. Pure/non-Fallen score-floor runs are useful route-proof benchmarks, but
  the best-bot lane must be allowed to descend to Fallen and cash PvP when HP4+
  monsters become a worse VP source than Good-player attacks.
- Run summaries must include farm opportunity, reward VP, decision types, class
  composition, status/corruption, win rate, VP, PvP target quality, HP4+ PvP
  pivot counters, and artifact paths.

Heuristic bots remain valid test fixtures, teachers, and sparring partners. They
are not the live product target, but a learned bot that cannot beat them has not
earned promotion.

## Capacity and systems experiment gates

- Sweep v1 trunk widths `64,128,256,512` (h320 is an optional bridge), three
  scratch seeds each, at equal environment steps and equal wall-clock budgets.
  Larger is not automatically better reasoning: width adds function capacity but
  not memory, search, or missing entity information.
- A wider model promotes only if at least two of three seeds beat h128 in both the
  held-out gauntlet and heuristic-field probe, without an exploiter/collusion
  regression and with acceptable TypeScript serving latency.
- Benchmark learner batches `256,512,1024,2048,4096` on actual ragged replay.
  Compare random padding with candidate-count buckets and report padding ratio,
  optimizer-update count, KL, clip fraction, entropy, gradient norm, and wall time.
  Do not adopt a larger batch only because a fixed-width synthetic benchmark is fast.
- Benchmark actor workers with one learner seat, the real opponent mix, sampling
  and temperature enabled, three repetitions, and randomized trial order. Report
  p50/p90 games and valid-policy rows per second. Keep v1 inference local unless a
  fresh end-to-end socket benchmark beats it.
- Reopen the v2/entity model only for a named representation/capacity failure that
  h512 cannot solve. Start with d64/l2 or d128/l3 and evaluate the model directly,
  not only through a distilled proxy.

Repeatable systems probes:

```bash
npm run bot:bench:actors -- --games 128 --repeats 3 \
  --workers 16,24,32,48,60 --sample --temperature 1 \
  --neural-seats Red --record-seats Red

npm run bot:bench:models -- --replay ml/league_v14b/data/gen120/main-0 \
  --widths 64,128,256,512 --batches 256,512,1024,2048,4096 \
  --bucketing random,bucketed --precision fp32
```

July 1, 2026 pivot diagnostic:

- The hunter lane can already execute the intended pivot. In
  `ml/meta_runs/nonfallen-hp4-conversion-teacher-smoke-20260701Tlocal/hunter_vs_target.json`,
  the hunter averaged 21.25 VP, 9.75 PvP VP/game, 3.25 PvP attacks/game, and
  0% missed PvP opportunities in the small smoke.
- The score-floor target lane is not a best-bot proxy yet. With the default
  `TARGET_STATUS_CAP=2` and `TARGET_FORBID_TYPES=initiatePvp`, it is mechanically
  prevented from attacking Good players. Unlocking that cap without training did
  not fix the lane; it still failed to reliably reach real conversion states.
- Promotion should therefore require both lanes: a Pure/non-Fallen monster route
  proof and an unrestricted farm-to-Fallen-to-PvP conversion evaluation.

## Bot Contract Gate

Live bots use the shared `arc-bot-v1` contract in `src/lib/play/bots/contract.ts`.
The only public live bot profile key is `neural`; legacy heuristic names must normalize to
that key at API/service boundaries.

When changing the contract, legal action surface, or live bot runtime, verify:

- action ids remain stable for the same `GameCommand`;
- every live bot decision resolves to one advertised legal action;
- old heuristic profile strings cannot re-enable live heuristic bots;
- missing weights fall back to uniform legal action selection, not strategic heuristics;
- run artifacts include contract version, rules commit, catalog hash, checkpoint id, and run id.

## Local Bot Test Commands

From the repo root:

```bash
npm run test:bot:engine
```

ML smoke:

```bash
npm run test:bot:ml-smoke
```

This smoke is intentionally hermetic: it clears and rewrites `ml/data_smoke/`,
trains `ml/weights/policy-smoke.json`, and evaluates that smoke checkpoint via
`EVAL_WEIGHTS`. Do not point the smoke gate at mixed historical `ml/data/*.jsonl`
files; old observation/action dimensions can make the test fail for the wrong
reason.

AlphaZero/meta smoke:

```bash
npm run test:bot:az-smoke
```

Accept the smoke only if it writes `ml/meta_runs/smoke/latest_meta.json` or the run-specific equivalent, reports no illegal action/stall failures, and the training log loads samples with valid `pi` targets when running AlphaZero mode.

`test:bot:az-smoke` also scrubs `npm_config_prefix` from the child environment
before `ml/discover_meta.sh` sources `nvm`; this avoids local Homebrew/npm env
noise from blocking the actual planner smoke.

Baseline manifest:

```bash
node scripts/write-bot-baseline-manifest.mjs \
  --run-id meta-eval-act52-baseline \
  --weights ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  --eval-summary ml/meta_runs/meta-eval-act52-baseline/summary.json \
  --out ml/meta_runs/meta-eval-act52-baseline/baseline-manifest.json
```

Every strict baseline/current-leader eval should produce a manifest with source
commit, dirty-worktree status, `arc-bot-v1` contract version, catalog hash,
checkpoint hash, current `62/52` dimensions, eval artifact paths, and verdict.
`npm run bot:meta:evaluate` now copies the remote run artifacts back locally and
writes `baseline-manifest.json` automatically after the remote suite succeeds.

Full-command AlphaZero smoke:

```bash
AZ_CONTROL=full AZ_FULL_SELECTION=value \
  RUN_ID=full-control-smoke OUTER=1 GAMES=2 SHARDS=2 MCTS=4 HORIZON=8 \
  EPOCHS=1 BATCH=128 META_GAMES=1 META_MCTS=4 \
  bash ml/discover_meta.sh
```

Use this gate when changing the self-play planner, candidate-action encoder, or meta
training path. `AZ_CONTROL=full` preserves navigation MCTS, but planner seats also
choose non-navigation legal commands through the neural candidate policy instead of
delegating those phases back to the legacy profile executor. Inspect the generated
JSONL when validating this mode; a valid full-control run should include action types
beyond `lockNavigation`, such as location interactions, combat, market, awakening,
encounter, and cleanup decisions.

Auxiliary-head sample/training smoke:

```bash
rm -rf ml/data_aux_smoke && mkdir -p ml/data_aux_smoke
AZ=1 AZ_CONTROL=full AZ_FULL_SELECTION=value AZ_PLANNER_SEATS=all \
  AZ_GAMES=1 AZ_ITERS=2 AZ_HORIZON=4 \
  AZ_OUT=ml/data_aux_smoke/az.jsonl \
  ML_META_PATH=ml/data_aux_smoke/meta.json \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept

ml/.venv/bin/python ml/train.py \
  --data ml/data_aux_smoke \
  --out ml/weights/aux-smoke.json \
  --mode alphazero \
  --epochs 1 \
  --batch-size 64 \
  --farm-value-coef 0.25 \
  --reward-pick-coef 0.25 \
  --no-warm-start

AZEVAL=1 AZEVAL_GAMES=1 AZEVAL_ITERS=1 \
  AZEVAL_WEIGHTS=ml/weights/aux-smoke.json \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

Accept this smoke only if generated samples include `farmValue`, the trainer
prints nonzero `n_with_farm_value`, the exported checkpoint contains
`farm_value`, `reward_pick`, and `aux_heads`, and the TypeScript eval path loads
the checkpoint. `rewardPi` is sparse in tiny generated games; the deterministic
unit gate for that target is:

```bash
npx vitest run src/lib/play/ml/neuralBot.test.ts --disable-console-intercept
```

That test verifies all small monster reward combinations are legal ML
candidates and that `rewardPickTarget` weights legal reward choices by immediate
VP.

June 27, 2026 local aux-head smoke result: one full-control generated game wrote
473 samples, all 473 with `farmValue`. A natural one-game smoke did not hit a
reward-pick state, so `rewardPi` coverage was verified by the deterministic
unit test and by a synthetic trainer-only reward-head smoke. The exported
`aux-smoke` and `aux-reward-smoke` checkpoints both had `55/52` dims and
included `farm_value`, `reward_pick`, and `aux_heads`.

No-op/progress selector gate:

```bash
npx vitest run src/lib/play/ml/neuralBot.test.ts --disable-console-intercept
AZ=1 AZ_CONTROL=full AZ_FULL_SELECTION=hybrid \
  AZ_PLANNER_SEATS=all AZ_GAMES=1 AZ_ITERS=4 AZ_HORIZON=8 \
  AZ_OUT=ml/data_smoke/az_hybrid_noop_guard_smoke.jsonl \
  ML_META_PATH=ml/data_smoke/meta_hybrid_noop_guard.json \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept
```

Run this before any long GPU run when a change touches full-command selection,
`materialSig`, no-op penalties, market actions, phase-ready/yield actions, or
pending reward scoring. The regression test must prove `endLocationActions` is
treated as progress while `refillMarket` is treated as non-progress when it only
refreshes table state. Generated meta artifacts must not show `refillMarket` as
a dominant action type unless a targeted test intentionally studies market churn.

Deterministic Abyss route rules sanity:

```bash
npm run test:bot:abyss-route
```

Equivalent direct command:

```bash
ABYSSROUTE=1 ABYSSROUTE_GAMES=8 ABYSSROUTE_DICE_COUNTS=0,1,2 \
  npx vitest run src/lib/play/ml/_abyssroute.test.ts --disable-console-intercept
```

This is not a bot-quality gate. It drives the reducer through a narrow route:
lock Arcane Abyss, start monster combat when legal, claim the highest-VP monster
reward tokens, resolve required draws, and end phases. Use it to answer rules
questions such as "does a kill grant VP immediately?" and "what does blind Abyss
spam score if the player has 0/1/2 injected attack dice?"

Current June 27, 2026 result over 8 games / 32 seat-games per dice setting:

| Injected arcane dice | Avg VP | Avg status | Avg rounds | Kills/seat-game | Reward VP/seat-game |
| -------------------- | ------ | ---------- | ---------- | --------------- | ------------------- |
| 0                    | 3.47   | 3.00       | 6.0        | 1.16            | 3.47                |
| 1                    | 6.72   | 3.00       | 5.1        | 2.25            | 6.72                |
| 2                    | 7.38   | 3.00       | 5.4        | 2.50            | 7.38                |

Interpretation: "always go Abyss and fight" is not a 30-round, 30-point line by
itself. The monster hits first, early rewards are usually 1-2 VP token choices,
and blind fighting corrupts the player to status 3 quickly. A strong bot must
learn the surrounding economy loop: build barrier, build damage, pick rewards,
and decide when to fight.

Prebuilt Abyss feasibility diagnostic:

```bash
ABYSSROUTE=1 ABYSSROUTE_GAMES=12 ABYSSROUTE_SEATS=4 \
  ABYSSROUTE_DICE_COUNTS=6,10 \
  ABYSSROUTE_SPIRIT_ANIMALS=2 \
  ABYSSROUTE_MAX_BARRIERS=12,16,20 \
  ABYSSROUTE_OUT=ml/abyssroute_high_build_probe_arcane.json \
  npx vitest run src/lib/play/ml/_abyssroute.test.ts --disable-console-intercept
```

Use this to separate "the engine cannot score this route" from "the bot cannot
build or time this route." The route harness can now inject starting max barrier
and a face-up Spirit Animal trait count, then still drives the real reducer for
combat, reward claims, corruption, cleanup, and win conditions.

Current June 27, 2026 prebuilt result over 12 games / 48 seat-games per setting:

| Build                                    | Avg VP | Avg status | Kills/seat-game | Reward VP/seat-game |
| ---------------------------------------- | ------ | ---------- | --------------- | ------------------- |
| 0 dice, 2 Spirit Animal, default barrier | 4.08   | 3.00       | 1.36            | 4.08                |
| 6 dice, 2 Spirit Animal, 12 max barrier  | 23.48  | 2.83       | 7.54            | 23.48               |
| 10 dice, 2 Spirit Animal, 16 max barrier | 28.44  | 2.04       | 8.10            | 28.44               |
| 10 dice, 2 Spirit Animal, 20 max barrier | 29.63  | 1.52       | 8.10            | 29.63               |

Interpretation: one or two Spirit Animal traits by themselves do not create the
owner's expected 15-30 VP line. A mature monster-farm build with damage and
survivability does. Clean-line ML should therefore train toward the build/timing
sequence, not just force earlier Abyss navigation.

Correction for multi-life monsters: the mature build table above proves the
ceiling, but it overstates the minimum build required to start farming. In a
4-player game, each monster rung has one life per active seat, so low-HP rungs
can pay rewards multiple times before the ladder advances. If one player
monopolizes those lives, far less than a 10-dice / 20-barrier boss build can be
enough to approach the 30 VP route. If all four seats farm the Abyss, the lives
and reward VP are shared, so per-seat VP is lower.

Moderate multi-life forced-Abyss probe:

```bash
ABYSSROUTE=1 ABYSSROUTE_GAMES=6 ABYSSROUTE_SEATS=4 \
  ABYSSROUTE_DICE_COUNTS=2,3,4,5 \
  ABYSSROUTE_SPIRIT_ANIMALS=2 \
  ABYSSROUTE_MAX_BARRIERS=5,6,8 \
  ABYSSROUTE_OUT=ml/abyssroute_moderate_multilife_probe.json \
  npx vitest run src/lib/play/ml/_abyssroute.test.ts --disable-console-intercept
```

Current June 27, 2026 result with all four seats forced to Abyss: 2-5 arcane
dice, 2 Spirit Animal, and 5-8 max barrier scored roughly 9.75-13.46 VP per
seat-game, with 3.67-5.29 kills per seat-game. The table-wide VP is substantial;
the per-seat number is lower because every forced farmer competes for the same
monster lives.

Abyss curriculum data smoke:

```bash
npm run test:bot:abyss-curriculum
```

Equivalent direct command:

```bash
ABYSSCURRICULUM=1 ABYSSCURRICULUM_GAMES=1 \
  ABYSSCURRICULUM_DICE_COUNTS=6 \
  ABYSSCURRICULUM_MAX_BARRIERS=12 \
  ABYSSCURRICULUM_SPIRIT_ANIMALS=2 \
  ABYSSCURRICULUM_DATA_DIR=ml/data_abyss_curriculum_smoke \
  npx vitest run src/lib/play/ml/_abysscurriculum.test.ts --disable-console-intercept
```

This writes normal `obs/cands/chosen/pi/ret` JSONL samples from prebuilt farm
states, using the real reducer and legal action contract. Use
`ABYSSCURRICULUM_SKIP_RECORD_TYPES=lockNavigation` when the experiment should
teach farm micro-actions without teaching a global Abyss navigation prior.

Normal-start clean-farm diagnostic:

```bash
npm run test:bot:clean-farm
```

Equivalent direct command:

```bash
CLEANFARM=1 CLEANFARM_GAMES=4 CLEANFARM_SEATS=4 \
  CLEANFARM_PROFILES=paragon,farmer,farmer2,hard \
  CLEANFARM_OUT=ml/cleanfarm_result.json \
  npx vitest run src/lib/play/ml/_cleanfarm.test.ts --disable-console-intercept
```

This drives named profiles from real legal starts, records whether they reach
clean Abyss farmability, then checks whether they choose Arcane Abyss when that
farmable state is available. It is a diagnosis gate, not a promotion gate.

Current June 27, 2026 result over 4 games / 16 seat-games per profile:

| Profile | Avg VP | Reward VP | Kills/seat-game | Clean farmable seats | Missed farmable Abyss navs | Boss-farmable seats |
| ------- | ------ | --------- | --------------- | -------------------- | -------------------------- | ------------------- |
| hard    | 7.56   | 7.56      | 2.69            | 100.0%               | 85.7%                      | 0.0%                |
| farmer  | 6.88   | 6.88      | 2.31            | 100.0%               | 90.7%                      | 0.0%                |
| farmer2 | 6.88   | 6.88      | 2.31            | 100.0%               | 90.7%                      | 0.0%                |
| paragon | 5.25   | 5.25      | 2.19            | 100.0%               | 88.6%                      | 0.0%                |

Interpretation: these baselines can reach clean farmable states early, but they
skip the Abyss on most farmable navigation decisions and never reach the mature
boss-farm build. That is the exact failure a clean-line bot/dashboard must track:
"farmable but not farming" is different from "not farmable."

Reachable clean-farm curriculum smoke:

```bash
npm run test:bot:clean-farm-curriculum
```

Equivalent direct command:

```bash
CLEANFARMCURRICULUM=1 CLEANFARMCURRICULUM_GAMES=1 CLEANFARMCURRICULUM_SEATS=4 \
  CLEANFARMCURRICULUM_PROFILES=paragon,farmer,farmer2,hard \
  CLEANFARMCURRICULUM_DATA_DIR=ml/data_cleanfarm_curriculum_smoke \
  npx vitest run src/lib/play/ml/_cleanfarmcurriculum.test.ts --disable-console-intercept
```

This writes contract-compatible `obs/cands/chosen/pi/ret/farmValue/rewardPi`
JSONL samples from legal round-1 starts. Heuristic profiles build the prefix,
then the teacher overrides only when `evaluateFarmValue` says a clean Arcane
Abyss farm is available. This is the preferred low-interference correction data
for the "farmable but not farming" failure; keep `_abysscurriculum.test.ts` for
prebuilt micro-action proof states.

Current June 27, 2026 SimForge reachable-curriculum run:

- Data: `/data/share8/michaelvuaprilexperimentation/arc-bot/ml/data_cleanfarm_curriculum_20260627T2312Z`
- Samples: 1,026 total; 352 farm-navigation, 351 combat, 323 reward-pick
- Contract: `obs_dim=55`, `act_dim=52`, 323 reward-pick samples with `rewardPi`
- Correction checkpoint: `ml/weights/act52-cleanfarm-reachable-20260627T2316Z.json`
- Eval summary: `ml/meta_runs/act52-cleanfarm-reachable-eval-20260627T2318Z/summary.json`

That checkpoint is **not promoted**. It improved arena performance versus Act52
(82.5% win, 21.45 VP, 48% reach30 in arena), but deterministic meta stayed low
(7.19 VP, 0% reach30), sampled meta stayed low (4.17 VP, 0% reach30), and pure
forced-Abyss remained weak (3.25 VP, 1.08 kills/game). Treat it as evidence that
the reachable-prefix curriculum can teach farm actions, not as evidence that the
bot has learned a complete clean economy strategy.

Clean-route proof and farm-Q counterfactuals:

Do not treat another pure/economy fine-tune as the next major run until the route
itself has been proved or falsified from normal legal starts. The immediate
diagnostic question is:

> When a clean farm window appears, is Arcane Abyss actually better than the best
> non-Abyss navigation after the opportunity cost of future rounds is counted?

Farm counterfactual smoke:

```bash
npm run test:bot:farm-counterfactual
```

Clean-route legal beam smoke:

```bash
npm run test:bot:clean-route-beam
```

This is an oracle/prover diagnostic, not a policy. It starts from normal legal
games, advances non-target seats with existing profiles, and branches the target
seat over the reducer-legal action set under Pure/no-PvP constraints. Use it to
ask whether any bounded legal planner can find the clean monster route before
training another checkpoint.

Clean-route proof smoke:

```bash
npm run test:bot:clean-route-proof
```

This is the compact local version of the recommendation ladder. It generates
farm-Q branch labels, audits the resulting `55/52` contract rows for exact/near
aliasing conflicts, then runs heldout route-imitation on the same rows. Use it
before any clean specialist training run.

GPU clean-route proof suite:

```bash
npm run bot:clean-route-proof
```

The GPU suite syncs the SimForge arc-bot workspace, runs the route-proof matrix,
generates farm-Q branch data from legal normal starts, audits the farm-Q rows,
runs heldout route-imitation, and writes
`ml/meta_runs/<run>/clean_route_suite_summary.json`. Its verdict is either
`clean-specialist-training-allowed` or `diagnose-before-training`; do not promote
oracle/bonus variants as live policy evidence.

By default the suite uses GPU 6 for route proof and GPU 7 for farm-Q/imitation.
Both lanes honor `MIN_FREE_MB` before starting remote work; raise it when sharing
the SimForge box with other jobs, and do not use GPUs outside the approved 4-7
range unless the owner explicitly changes the pool.

June 28, 2026 full clean-route proof suite:
`ml/meta_runs/clean-route-proof-suite-20260628T203700Z/clean_route_suite_summary.json`
returned `clean-specialist-training-allowed`, but not route promotion. Strict
Pure scored 21.00 VP, 93.8% win, 7.19 monster kills/game, status 0/max 0, and
0% reach30. The no-`pvphunter` field improved to 22.44 VP, 100% win, and 7.66
kills/game, still with 0% reach30. Tainted tolerance regressed by 2.00 VP,
no-PvP corruption regressed by 0.31 VP, and farm oracle/bonus added 0.00 VP.
Farm-Q generated 256 windows; 184/256 (71.9%) preferred farming now at the
10-round label horizon, while the rest preferred build/navigation alternatives.
The farm-Q contract audit passed at `55/52` with zero exact and near conflicts,
and heldout route-imitation passed with validation top-1 0.734 and top-3 1.000.
Trace analysis again identified the HP4 wall, current-barrier deficits,
max-barrier/Cultivator deficits, and post-VP navigation churn as the next
collector targets, not more farm-now pressure.

June 29, 2026 guarded clean-route proof suite:
`ml/meta_runs/clean-route-proof-suite-20260629T093420Z/clean_route_suite_summary.json`
reran the same route-proof ladder on SimForge with route proof on GPU 6,
farm-Q/imitation on GPU 7, and `MIN_FREE_MB=20000`. It again returned
`clean-specialist-training-allowed`, but not route promotion. Strict Pure scored
21.00 VP, 93.8% win, 7.19 kills/game, status 0/max 0, and 0% reach30. Removing
`pvphunter` lifted the route to 22.44 VP, 100% win, 7.66 kills/game, and still
0% reach30. Tainted tolerance regressed by 2.00 VP, no-PvP corruption regressed
by 0.31 VP, and both farm oracle variants added exactly 0.00 VP. Farm-Q produced
256 contract-compatible rows; 181/256 (70.7%) preferred farming now at the
10-round label horizon. The `55/52` contract audit passed with zero exact and
near conflicts, and route imitation passed with validation top-1 0.781 and
top-3 1.000 versus a 0.703 majority baseline. Trace analysis found the HP4 wall
in every strict/no-`pvphunter` game and again recommended HP4+ wall execution,
restore timing, Cultivator/max-barrier acquisition, damage assembly, and
post-VP navigation-churn audits before any more farm-now training.

June 29, 2026 legal beam prover:
`src/lib/play/ml/_cleanroutebeam.test.ts` and
`npm run test:bot:clean-route-beam` now provide a direct bounded route prover.
The smoke reaches 9 VP / 3 monster kills from one normal legal start. A wider
local slice,
`ml/clean_route_beam_4g_b24_summary.json`, used 4 games, beam 24, action beam
24, 240 target decisions, max status 0, and `initiatePvp` forbidden. It found
average best VP 16.00, max best VP 22, 5.50 monster kills/game, 16.00 reward VP,
status 0/max 0, 0 target PvP events, and 0% reach30. The best row reached 22 VP
by round 26 with 8 monster kills, max barrier 10, 4 Spirit Animal, 2 Cultivator,
and HP5/damage4/lives4 remaining, but clean/firepower kill probability was 0 at
that snapshot. Current interpretation: a legal search can reproduce the low-20s
clean-route ceiling, but this bounded prover still does not certify a legal
30-point Pure route from normal starts. The next prover improvement should
diagnose late frontier states around VP18-22 instead of generating more farm-now
labels.

Equivalent direct command:

```bash
FARMQ=1 FARMQ_GAMES=1 FARMQ_MAX_WINDOWS=4 FARMQ_HORIZONS=3,6 \
  FARMQ_LABEL_HORIZON=6 \
  FARMQ_DATA_OUT=ml/data_farmq_smoke/farmq.jsonl \
  FARMQ_OUT=ml/farmq_counterfactual_smoke.json \
  FARMQ_SUMMARY=ml/farmq_counterfactual_smoke_summary.json \
  npx vitest run src/lib/play/ml/_farmcounterfactual.test.ts --disable-console-intercept
```

The counterfactual harness starts from legal normal games, finds clean-farmable
navigation windows, then branches:

- `lockNavigation:Arcane Abyss`
- heuristic non-Abyss navigation
- rollout-best non-Abyss navigation

It rolls the branches forward at configurable horizons and writes
`farmQDeltaVp`, `farmQDeltaStatus`, `farmQDeltaRewardVp`,
`farmQDeltaPvpVp`, `farmQDeltaMonsterLivesConsumed`,
`farmQDeltaRaceMargin`, `farmQDeltaReach30`, `farmQDeltaPvpExposure`, and
`farmNowCorrect`. A farmable state should only become training signal when the
counterfactual label says farming wins, not merely because the clean kill
probability is high. These tradeoff fields are dashboard inputs: they tell us
whether the farm decision won by actual monster rewards, race position, hidden
PvP exposure, or just a short-horizon local VP bump.

As of June 29, 2026, farm-Q branch rollouts are capped at `FARMQ_MAXROUNDS`
instead of only `startRound + horizon`. Summaries expose
`branchRolloutsCapAtMaxRounds`, `roundCappedBranches`,
`roundCappedWindows`, and `labelRoundCappedWindows`; late-window labels should
be treated as real 30-round game evidence only when those cap fields are
understood.

June 28, 2026 farm-Q route-proof pass:
`npm run test:bot:farm-counterfactual` now also writes contract-compatible
`obs/cands/chosen/pi/ret` rows when `FARMQ_DATA_OUT` is set. A 128-window
normal-start slice,
`ml/meta_runs/farmq-data-audit-20260628T182818Z/summary.json`, found that clean
farmable navigation is not automatically correct: at a 10-round label horizon,
90/128 windows (70.3%) preferred Arcane Abyss now, while 38/128 preferred a
non-Abyss navigation, mostly Floral Patch. The contract audit
`ml/meta_runs/farmq-data-audit-20260628T182818Z/contract_audit_summary.json`
passed at `55/52` with five labels, zero exact conflicts, zero near conflicts,
and nearest different-label distance `0.0278`. The heldout route-imitation
diagnostic
`ml/meta_runs/farmq-data-audit-20260628T182818Z/route_imitation_summary.json`
also passed: final train top-1 `0.835`, validation top-1 `0.774`, validation
top-3 `1.000`, versus validation majority `0.710`.

Survivability counterfactual smoke:

```bash
npm run test:bot:survival-counterfactual
```

Equivalent direct command:

```bash
SURVIVALQ=1 SURVIVALQ_GAMES=1 SURVIVALQ_MAX_WINDOWS=4 SURVIVALQ_HORIZONS=3,6 \
  SURVIVALQ_LABEL_HORIZON=6 \
  SURVIVALQ_OUT=ml/survivalq_counterfactual_smoke.json \
  SURVIVALQ_SUMMARY=ml/survivalq_counterfactual_smoke_summary.json \
  npx vitest run src/lib/play/ml/_survivalcounterfactual.test.ts --disable-console-intercept
```

This harness starts from legal normal games and finds Pure navigation windows
where the player has enough firepower to kill the current monster but cannot
survive the monster's first hit cleanly. It branches:

- `lockNavigation:Arcane Abyss` now
- heuristic non-Abyss navigation
- rollout-best non-Abyss navigation

It writes `buildQDeltaVp`, `buildQDeltaCleanCombatOpportunities`,
`buildQDeltaStatus`, and `buildNowCorrect`. Use it before turning survivability
examples into training data: a state should become a build/rest/timing
correction only when the counterfactual says building now creates more clean
fight windows or VP than Abyss-now.

June 28, 2026 local smoke result: 4/4 unsafe-firepower windows labeled
`buildNowCorrect`, average `+1.00` clean combat opportunity and `+3.00` VP by
the 6-round label horizon. The best rollout branch chose `Lantern Canyon` in all
four windows, from states with 100% firepower kill probability but 0% clean kill
probability because current barrier was below the monster hit.

To emit training rows from the same labels, set `SURVIVALQ_DATA_OUT`:

```bash
rm -rf ml/data_survivalq_smoke && mkdir -p ml/data_survivalq_smoke
SURVIVALQ=1 SURVIVALQ_GAMES=1 SURVIVALQ_MAX_WINDOWS=4 SURVIVALQ_HORIZONS=3,6 \
  SURVIVALQ_LABEL_HORIZON=6 \
  SURVIVALQ_DATA_OUT=ml/data_survivalq_smoke/survivalq.jsonl \
  npx vitest run src/lib/play/ml/_survivalcounterfactual.test.ts --disable-console-intercept
```

The JSONL rows use the normal `obs/cands/chosen/pi/ret/farmValue` format. In
the local smoke this produced 4 contract-compatible navigation correction
samples with `obs_dim=55` and `act_dim=52`.

June 28, 2026 SimForge survival-Q result:
`ml/meta_runs/survivalq-20260628T0226Z/survivalq.json`, 4 games, 24 windows,
horizons 3/6/10. Build-first was correct in 12/24 windows, with average
`+0.50` clean combat opportunities and `+1.33` VP by the 10-round label
horizon. The best rollout destinations were `Lantern Canyon` 11 times, `Floral
Patch` 12 times, and `Cyber City` once; however the actual training labels were
12 `Arcane Abyss` negatives, 11 `Lantern Canyon` positives, and 1 `Cyber City`
positive. The exported dataset
`ml/meta_runs/survivalq-20260628T0226Z/data/survivalq.jsonl` contains 24
contract-compatible `55/52` samples.

Strict constraint attribution gate:

```bash
npm run test:bot:strict-constraints
```

This deterministic unit gate verifies that status-cap crossings are attributed
as planner-owned, external/opponent-forced, or deadline/auto-advance events. A
strict Pure route proof should now inspect both the old noisy cap-observation
count and the event split:

- `planner_own_status_cap_violation_events`
- `planner_external_status_cap_violation_events`
- `planner_deadline_status_cap_violation_events`
- `planner_status_cap_violation_sources`

Use `planner_own_status_cap_violation_events == 0` to prove the planner did not
choose corrupting actions. Use `planner_external_status_cap_violation_events` to
measure whether the opponent field, especially `pvphunter`, can force the clean
bot into corruption anyway.

June 28, 2026 SimForge survival-Q fine-tune result:
`ml/meta_runs/survivalq-finetune-20260628T0233Z/` generated 128
counterfactual samples, then fine-tuned from
`ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json`.
Do **not** promote this checkpoint. In the matched 16-game strict-Pure
route-proof comparison at 32 iterations / horizon 16:

| Checkpoint           | Avg VP | Win % | Max status | Cap violations | Kills/game | Clean fights/game | Firepower fights/game |
| -------------------- | ------ | ----- | ---------- | -------------- | ---------- | ----------------- | --------------------- |
| Baseline aux-head    | 5.63   | 50.0  | 1          | 82             | 1.88       | 2.13              | 30.19                 |
| Survival-Q fine-tune | 5.25   | 56.3  | 1          | 86             | 1.75       | 1.81              | 35.06                 |

The fine-tune increased attack-dice tendency but lowered VP, kills, clean fight
windows, and farm-opportunity VP. A follow-up strict-cap repro showed the
status-0 leakage in this comparison was externally forced by the opponent field,
not owned by the planner: 3 cap-crossing events, `own=0`, `external=3`, source
`external:Green:initiatePvp`. Treat this as useful diagnostic data only. A
clean-route checkpoint under pressure must report both no owned corruption
events and whether the field can still corrupt it externally.

Focused route-proof attribution refresh:
`ml/meta_runs/route-proof-status-attrib-baseline-20260628T0255Z/summary.json`
and
`ml/meta_runs/route-proof-status-attrib-survivalq-20260628T0255Z/summary.json`
ran 8 strict-Pure games at 16 iterations / horizon 12 after adding the event
fields. Both checkpoints scored 4.50 VP, 1.50 kills/game, max status 0, and
zero owned/external/deadline status-cap events in that slice. This confirms the
route-proof summaries now carry the attribution fields, but it does not improve
the clean-route verdict.

Contract sufficiency audit:

```bash
npm run test:bot:contract-audit
```

This gate generates a fresh survival-Q JSONL slice, then runs
`src/lib/play/ml/_contractaudit.test.ts` against the actual `obs/cands/chosen`
features. By default it fails on stale dimensions, exact contradictory labels
for the same rounded `obs + candidate set`, or near-identical contradictory
labels below the configured distance threshold when the candidate set also
matches. This is intentional for full-action datasets: the model scores legal
candidate actions, so identical observations with different legal action menus
are reported as `obsOnlyExactConflictCount` diagnostics rather than hard alias
failures. Set `CONTRACTAUDIT_KEY_MODE=obs` when deliberately auditing
observation-only aliasing.

Current June 28, 2026 result:

- Fresh 24-window gate: 24 rows, `55/52`, labels split across `Arcane Abyss`,
  `Lantern Canyon`, and `Cyber City`, zero exact conflicts, zero near conflicts,
  nearest different-label distance `0.0278`.
- Larger survival-Q fine-tune audit:
  `ml/meta_runs/survivalq-finetune-20260628T0233Z/contract_audit_summary.json`,
  128 rows, `55/52`, five destination labels, zero exact conflicts, zero near
  conflicts, nearest different-label distance `0.0277`.

Interpretation: the current contract can represent these survival-Q navigation
labels well enough for this dataset. The strict Pure failure is therefore more
likely data volume/search/training/objective quality than exact observation
aliasing for these route-critical windows. This does not prove the full clean
route is solved; it only clears the contract for this slice.

Route-Q imitation gate:

```bash
npm run test:bot:route-imitation
```

This gate generates a fresh survival-Q JSONL slice, trains the same candidate
scorer architecture from scratch with a stratified heldout split, and requires
heldout route-label accuracy above the majority baseline. It answers a narrower
question than route-proof: can the current `55/52` scorer imitate these
counterfactual labels at all?

Current June 28, 2026 result:

- Fresh 24-window gate:
  `ml/data_route_imitation/route_imitation_summary.json`, final train top-1
  `0.947`, heldout top-1 `0.800`, heldout top-3 `1.000`, validation majority
  baseline `0.600`.
- Larger 128-row survival-Q dataset:
  `ml/meta_runs/survivalq-finetune-20260628T0233Z/route_imitation_summary.json`,
  final train top-1 `0.896`, heldout top-1 `0.844`, heldout top-3 `1.000`,
  validation majority baseline `0.500`.

Interpretation: the candidate scorer can learn the survival/build navigation
labels when trained directly. The failed low-LR survival-Q fine-tune was a
training recipe/interference failure, not evidence that the labels are
unlearnable.

Route-Q navigation-prior specialist:
`ml/meta_runs/routeq-nav-specialist-20260628T0305Z/` generated a larger
512-window survival-Q dataset. The labels were harder and more diverse:
build-first was correct in 38.7% of windows, average build delta was `+0.40`
future clean fights and `+0.92` VP, and best build destinations were `Lantern
Canyon` 155, `Floral Patch` 318, `Cyber City` 34, `Tidal Cove` 5. With the
256/256 scorer, heldout imitation passed: train top-1 `0.873`, heldout top-1
`0.811`, heldout top-3 `0.969`, majority baseline `0.551`.

Do **not** promote the exported navigation-prior checkpoint. In
`ml/meta_runs/route-proof-routeq-navprior-20260628T0315Z/summary.json`, using
`ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json` as
`NAV_WEIGHTS` with the baseline aux-head policy regressed the matched strict
Pure route-proof slice from the previous baseline's 4.50 VP / 1.50 kills/game
to 2.63 VP / 0.88 kills/game. It stayed clean at status 0, but missed 95.2% of
measured farm-opportunity VP and saw far fewer legal/firepower Abyss fights.
Interpretation: survival-Q labels are useful supervised data, but a raw
navigation-prior specialist is too local. It teaches "build when unsafe" without
a reliable return-to-farm loop.

Gated route-Q navigation prior:
`NAV_GATE=unsafe-firepower` uses the route-Q navigation prior only in the exact
state class it was trained on: Pure states where the player has firepower to
kill the Abyss monster but cannot survive the monster hit cleanly. This changed
the route proof materially.

Current June 28, 2026 results with
`NAV_WEIGHTS=ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json`
and `NAV_GATE=unsafe-firepower`:

| Eval                         | Games | Avg VP | Win % | Kills/game | Missed farm VP % | Max status | Owned cap events | External cap events |
| ---------------------------- | ----- | ------ | ----- | ---------- | ---------------- | ---------- | ---------------- | ------------------- |
| mixed field with `pvphunter` | 32    | 10.41  | 81.3  | 3.47       | 4.0              | 1          | 0                | 2                   |
| no-`pvphunter` field         | 32    | 10.59  | 96.9  | 3.53       | 3.9              | 0          | 0                | 0                   |

Artifacts:

- `ml/meta_runs/route-proof-routeq-navprior-gated-32g-20260628T0330Z/summary.json`
- `ml/meta_runs/route-proof-routeq-navprior-gated-no-pvphunter-32g-20260628T0340Z/summary.json`

Interpretation: Tier-2 clean route proof is now positive at the 10+ VP /
3.5-kill level. The old strict-Pure wall was a training/search problem, not an
engine impossibility. This is **not** a solved champion: reach30 is still 0%,
external PvP pressure can corrupt the clean bot in the mixed field, and average
VP is still below the current no-PvP corruption route.

Build-execution diagnostic:
`ml/meta_runs/route-proof-routeq-builddiag-20260628T034942Z/summary.json`
added planner destination and location-row histograms to the same
no-`pvphunter` gated route proof. In 8 games at 32 iterations / horizon 16 it
scored 10.88 VP, 87.5% win, 0 status, 3.63 kills/game, and 12.4% missed
farm-opportunity VP. The key new fields are
`planner_navigation_destinations_per_game` and
`planner_location_interactions_per_game`.

The diagnostic says the current clean route is no longer mainly missing Abyss
navigation. It spends about 15.25 turns/game in `Arcane Abyss`, 5.38 in
`Floral Patch`, 5.38 in `Lantern Canyon`, and 3.88 in `Cyber City`, but only
0.13 in `Tidal Cove`. Its top rows are `Lantern Canyon` cultivate+restore
(3.75/game), `Lantern Canyon` any-basic -> Cursed Spirit trade (3.00/game),
and `Floral Patch` rest/restore rows. The resulting build still peaks at only
3.04 expected attack, 4.50 max barrier, 1.63 attack dice, 2.13 Spirit Animal,
and 1.75 Cultivator. Interpretation: the next bottleneck is build execution and
survivable damage scaling, not reward-choice legality or raw Abyss navigation.
The next training lane should label route options such as summon/augment/dice
and barrier timing, then verify that they increase clean combat windows and
reach30 rather than merely preserving the 10-VP farm loop.

Route-execution counterfactual gate:

```bash
npm run test:bot:route-execution-counterfactual
```

This gate branches legal `resolveLocationInteraction` row choices at normal-start
Pure location windows and rolls each branch forward. It labels the row/choice
that produces the best future clean-route score, then can export ordinary
`55/52` JSONL samples through `ROUTEEXECQ_DATA_OUT`.

The summary now distinguishes "best branch" from "teachable correction":

- `sourceWasBest` / `sourceWasBestPct`: the current source action already matched
  the counterfactual best row.
- `routeExecCorrections` / `routeExecCorrectionPct`: the best row beat the source
  by `ROUTEEXECQ_LABEL_SCORE_THRESHOLD`, met `ROUTEEXECQ_LABEL_VP_THRESHOLD`, and
  did not exceed `ROUTEEXECQ_LABEL_STATUS_TOLERANCE`.
- `routeExecQDeltaScore`, `routeExecQDeltaVp`, `routeExecQDeltaStatus`, and
  `routeExecQDeltaReach30`: per-window branch deltas at the label horizon.
- `ROUTEEXECQ_POSITIVE_ONLY_DATA=1`: write JSONL only for teachable corrections.
  Use this for correction-only curriculum slices; keep it off for audits and
  imitation diagnostics that need the full source distribution.

June 28, 2026 smoke result:
`ml/routeexecq_counterfactual_smoke_summary.json` found 4/4 windows at `Tidal
Cove`; the counterfactual preferred the Animal augment trade over the heuristic
free summon in 3/4 windows, with average `+1.42` expected attack and `+1.25`
Spirit Animal by the 6-round horizon. The local gate now writes
`ml/data_routeexecq_smoke/routeexecq.jsonl` plus `meta.json`; the smoke produced
4 `55/52` samples and 4/4 teachable corrections at the default score threshold.

Larger SimForge result:
`ml/meta_runs/routeexecq-20260628T035831Z/summary.json` generated 128
route-execution windows and 128 training samples. The best actions were
primarily `Tidal Cove` free summon (43), `Floral Patch` rest (33), and `Tidal
Cove` Animal augment trade (26 with `choices=2`, plus 5 default-choice augment
rows). Heldout imitation on those row labels passed:
`ml/meta_runs/routeexecq-20260628T035831Z/route_imitation_summary.json`
reported train top-1 `0.990`, val top-1 `0.920`, val top-3 `1.000`, majority
baseline `0.080`. Interpretation: the existing `55/52` contract can represent
these location-row labels.

The first `microGate=location-interactions` proof used
`ml/meta_runs/routeexecq-micro-20260628T0405Z/best_policy.json` as a row-choice
specialist. It is a diagnostic checkpoint, not a champion: warm-start from the
aux-head policy was skipped because the JSON layer layout did not match the
trainer, so it is effectively a scratch specialist. Even so, when gated only to
`resolveLocationInteraction` candidates and paired with the gated route-Q
navigation prior, it improved the 32-game no-`pvphunter` strict-Pure proof:

| Eval                      | Games | Avg VP | Win % | Reach30 % | Status | Kills/game | Missed farm VP % |
| ------------------------- | ----- | ------ | ----- | --------- | ------ | ---------- | ---------------- |
| gated route-Q only        | 32    | 10.59  | 96.9  | 0.0       | 0      | 3.53       | 3.9              |
| + location-row micro gate | 32    | 13.69  | 96.9  | 0.0       | 0      | 4.56       | 0.0              |

Artifact:
`ml/meta_runs/route-proof-routeexecq-micro-no-pvphunter-32g-20260628T044654Z/summary.json`.
This is meaningful progress toward Tier 3, but not a solved route because
reach30 remains 0%.

Trainer fix and follow-up checks:

- `ml/train.py` now supports `--init-from`, and `ml/model.py` can build a model
  using checkpoint-inferred `trunk_hidden` / `value_hidden` sizes. This prevents
  accidental scratch training when the base policy is `256,256` / `128` but the
  trainer default is `128,128` / `64`.
- The compatible warm-start row specialist
  `ml/meta_runs/routeexecq-micro-warm-20260628T050546Z/best_policy.json`
  successfully warm-started from the aux-head checkpoint and reached `0.992`
  top-1 on the 128 row-label samples, but its 8-game no-`pvphunter` proof was
  weaker than the scratch specialist: 12.75 VP / 4.25 kills/game / 0 status.
  Do not promote it over the scratch diagnostic yet.
- A policy-distribution route-execution collection,
  `ml/meta_runs/routeexecq-policy-20260628T051141Z/summary.json`, used
  `ROUTEEXECQ_WEIGHTS` plus the gated route-Q navigation prior during collection
  and rollouts. It found only `Floral Patch` and `Lantern Canyon` row windows,
  with `avgBestScoreDelta=0`: the heuristic already chose the same rest/cultivate
  rows. Do not train from that slice as an improvement dataset; it mainly proves
  that the current collector still does not match the full-control Cyber/Tidal
  proof distribution.
- A full-control route-exec collection path is now available:

  ```bash
  npm run bot:routeexecq:fullcontrol
  ```

  Default remote command shape:

  ```bash
  RUN_ID=routeexecq-fullcontrol-$(date -u +%Y%m%dT%H%M%SZ) \
  GPU=7 MIN_FREE_MB=1024 GAMES=64 MAX_WINDOWS=128 \
  WEIGHTS=ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json \
  NAV_WEIGHTS=ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json \
  NAV_GATE=unsafe-firepower \
  MICRO_WEIGHTS=ml/meta_runs/routeexecq-micro-20260628T0405Z/best_policy.json \
  MICRO_GATE=location-interactions \
  bash scripts/run-arc-routeexecq-fullcontrol.sh
  ```

  The script checks selected-GPU free memory before running, writes artifacts to
  `ml/meta_runs/$RUN_ID/`, optionally runs heldout route imitation, optionally
  trains a warm-started row specialist with `TRAIN=1`, and rsyncs the run back
  locally. Set `POSITIVE_ONLY_DATA=1` only when the goal is a correction-only
  training slice.

- First full-control artifact:
  `ml/meta_runs/routeexecq-fullcontrol-20260628T052738Z/summary.json`. It scanned
  32 full-control location windows from 16 games: 22 `Lantern Canyon`, 6 `Floral
Patch`, and 4 `Cyber City`. Three windows were positive corrections under the
  new label definition. The largest miss was `Cyber City` row 0
  `spiritWorldSummon+abyssSummon` beating the source rune row by `+11.43` score
  and `+6` VP at the label horizon. This is positive evidence for more
  full-control DAgger-style data, not enough data to promote a new specialist.
- Larger full-control artifact:
  `ml/meta_runs/routeexecq-fullcontrol-20260628T0540Z/summary.json`. It reached
  128/128 windows after about 17 minutes, with 10 teachable corrections
  (`7.8%`) and 128 exported samples. The window distribution was `Lantern
Canyon` 81, `Cyber City` 29, `Floral Patch` 17, `Tidal Cove` 1. The correction
  set was mostly `Cyber City` row 0
  `spiritWorldSummon+abyssSummon` over the source rune row, plus a few Lantern
  choice corrections. Heldout route imitation passed on the full-control data:
  `route_imitation_summary.json` reported final train top-1 `0.980`, val top-1
  `0.963`, val top-3 `1.000`, majority `0.185`.
- The full-control runner now forwards `ROUTEEXECQ_PROGRESS_EVERY`; default
  remote runs print per-game progress so long collectors do not sit silent.
- A higher-budget proof with the scratch row specialist,
  `ml/meta_runs/route-proof-routeexecq-micro-hibudget-16g-20260628T051529Z/summary.json`,
  used 64 iterations / horizon 24 and held 13.31 VP, 93.8% win, 4.44
  kills/game, status 0, and 1.4% missed farm VP over 16 games. This falsifies
  the simple explanation that the 13-VP clean line is only a shallow-search
  artifact. It still has 0% reach30, so it is not a solved Tier-3 route.

Mixed-field check with `pvphunter`:
`ml/meta_runs/route-proof-routeexecq-micro-mixed-16g-20260628T045731Z/summary.json`
scored 13.13 VP, 87.5% win, 4.38 kills/game, and 0.0% missed farm VP over 16
games, but max status reached 1 from one external `pvphunter`-driven status cap
event. Owned cap events stayed 0. Interpretation: the row-specialist improves
the clean route in the real mixed field too, but PvP disruption is still a live
counter-pressure, and strict Pure is not Tier 3 while reach30 is 0%.

Full-control route-exec micro follow-up:
`ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json`
warm-started from the aux-head checkpoint and trained on the 128 full-control
route-exec samples. This is a diagnostic specialist, not a promotion candidate.
In a 16-game no-`pvphunter` proof at 32 iterations / horizon 16, it matched the
best prior clean-route band: 13.69 VP, 93.8% win, 4.56 kills/game, status 0,
0.0% missed farm VP, and 0% reach30
(`ml/meta_runs/route-proof-routeexecq-fullcontrol-micro-no-pvphunter-16g-20260628T0602Z/summary.json`).
In the mixed `pvphunter,medium,cultivator,survivor` field, it scored 12.94 VP,
87.5% win, 4.31 kills/game, status 0, zero owned/external cap events, and 0%
reach30
(`ml/meta_runs/route-proof-routeexecq-fullcontrol-micro-mixed-16g-20260628T0603Z/summary.json`).
Conclusion: full-control row labels improve Cyber/Tidal route shape and preserve
the Tier-2 clean loop, but they do not solve the late-game ceiling. The next
counterfactual data should target route states that distinguish 13 VP loops from
20+ VP clean runs, especially damage/barrier scaling and repeated Cyber/Tidal
summon/augment choices.

Scaling-navigation counterfactual gate:

```bash
npm run test:bot:scaling-navigation-counterfactual
```

Equivalent direct command:

```bash
SCALEQ=1 SCALEQ_SOURCE=heuristic SCALEQ_GAMES=1 SCALEQ_MAX_WINDOWS=4 \
  SCALEQ_HORIZONS=3,6 SCALEQ_LABEL_HORIZON=6 \
  SCALEQ_MIN_PLAYER_VP=0 SCALEQ_MIN_ROUND=0 \
  SCALEQ_OUT=ml/scalingq_counterfactual_smoke.json \
  SCALEQ_SUMMARY=ml/scalingq_counterfactual_smoke_summary.json \
  SCALEQ_DATA_OUT=ml/data_scalingq_smoke/scalingq.jsonl \
  npx vitest run src/lib/play/ml/_scalingnavigationcounterfactual.test.ts --disable-console-intercept
```

Use this when the clean route is no longer failing to take obvious farm windows
but is plateauing around the 10-14 VP loop. It branches legal navigation
destinations from clean mid-route states and scores future VP, reach30, kills,
clean fight opportunities, expected attack, dice, Spirit Animal, Cultivator,
barrier, and status. `SCALEQ_SOURCE=full-control` collects windows from the
actual full-control evaluator via `navigationProbe`; `SCALEQ_NAV_GATE` supports
the same `all`, `unsafe-firepower`, `midroute-scaling`, and
`route-option-scaling` arbitration modes as route proof.

Current June 28, 2026 SimForge evidence:

- `ml/meta_runs/routeexecq-scaling-fullcontrol-20260628T0610Z/summary.json`
  found only 2 corrections in 62 late row-choice windows. Row choice is not the
  main ceiling after the 13 VP clean loop.
- `ml/meta_runs/scaleq-fullcontrol-20260628T0645Z/summary.json` found 36
  corrections in 64 mid-route navigation windows. Most corrections moved
  overused Arcane Abyss/Lantern decisions toward Floral Patch or Tidal Cove for
  future scaling.
- `ml/meta_runs/route-proof-scaleq-nav-midroute-farmpreserve-no-pvphunter-16g-20260628T0700Z/summary.json`
  is a non-promotion result. Farm windows were preserved and status stayed 0,
  but average VP regressed to 7.50, kills to 2.50/game, reach30 stayed 0%, and
  the nav prior spent about half the game at Floral Patch. Treat the labels as
  useful training data; do not deploy the scaling-navigation specialist directly
  as the clean-route navigation prior.

Composite navigation specialist proof:

```bash
RUN_ID=route-proof-routeq-plus-scaleq-routeoption-$(date -u +%Y%m%dT%H%M%SZ) \
GPU=7 GAMES=16 ITERS=32 HORIZON=16 VARIANTS=strict-pure-no-pvphunter \
WEIGHTS=ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json \
NAV_WEIGHTS=ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json \
NAV_GATE=unsafe-firepower \
SCALE_NAV_WEIGHTS=ml/meta_runs/scaleq-nav-20260628T0650Z/best_policy.json \
SCALE_NAV_GATE=route-option-scaling \
MICRO_WEIGHTS=ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json \
MICRO_GATE=location-interactions \
npm run bot:route-proof
```

`NAV_WEIGHTS` remains the proven survival/build route-Q specialist; `SCALE_NAV_WEIGHTS`
is a second, sparse scaling option. The first corrected composite proof,
`ml/meta_runs/route-proof-routeq-plus-scaleq-routeoption-no-pvphunter-16g-20260628T0730Z/summary.json`,
matched the previous clean-loop baseline at 13.69 VP, 4.56 kills/game, status 0,
0% missed farm VP, and 0% reach30. It is safe enough as an experiment, but not
an improvement. One seat reached 24 VP cleanly, so the next data job should
collect/compare high-roll clean route states rather than promote the composite
policy.

Standalone `npm run bot:route-proof` now defaults the known patch/nav gates to
the clean-suite settings: `PATCH_NAV_GATE=hp2-survival-deficit` and
`NAV_GATE=unsafe-firepower-build-option`. Override them explicitly only when an
experiment needs an all-state specialist; running the HP2 patch or route-Q
policy with `all` gates produces invalid low-VP ablations.

Trace capture:

```bash
TRACE=1 TRACE_MIN_VP=20 npm run bot:route-proof
```

This writes `route-proof/<variant>.trace.json` with compact planner-seat events
for games whose final VP is at least `TRACE_MIN_VP`. Set `TRACE_MAX_VP` to focus
only on low-tail games, for example `TRACE=1 TRACE_MIN_VP=0 TRACE_MAX_VP=18`.
After local artifact sync, the route-proof runner automatically writes
`route-proof/<variant>.trace-analysis.json`; the analyzer can also be run directly:

```bash
npm run bot:route-trace:analyze -- \
  --out ml/meta_runs/<run>/route-proof/strict-pure.trace-analysis.json \
  ml/meta_runs/<run>/route-proof/strict-pure.trace.json
```

The first traced composite
run,
`ml/meta_runs/route-proof-routeq-plus-scaleq-trace-no-pvphunter-16g-20260628T0745Z/route-proof/strict-pure-no-pvphunter.trace.json`,
captured the 24 VP game. The trace showed the route consumed the HP-1 and HP-2
multi-life rungs cleanly, then stalled at the HP-4 / damage-4 rung because the
bot repeatedly chose Arcane Abyss with current barrier 2/10 instead of restoring
to a clean-fight threshold.

Unsafe-firepower build-option proof:

```bash
RUN_ID=route-proof-routeq-buildoption-plus-scaleq-$(date -u +%Y%m%dT%H%M%SZ) \
GPU=7 GAMES=16 ITERS=32 HORIZON=16 \
WEIGHTS=ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json \
NAV_WEIGHTS=ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json \
NAV_GATE=unsafe-firepower-build-option \
SCALE_NAV_WEIGHTS=ml/meta_runs/scaleq-nav-20260628T0650Z/best_policy.json \
SCALE_NAV_GATE=route-option-scaling \
MICRO_WEIGHTS=ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json \
MICRO_GATE=location-interactions \
npm run bot:route-proof
```

`unsafe-firepower-build-option` uses the route-Q specialist only when the bot has
firepower to kill but cannot survive cleanly, and filters root navigation away
from Arcane Abyss toward `Lantern Canyon`, `Floral Patch`, `Cyber City`, or
`Tidal Cove`. This is the first trace-derived average lift:

| Eval           | Artifact                                                                                                     | Avg VP | Kills/game | Status | Reach30 | 20+ VP traces |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ------ | ---------- | ------ | ------- | ------------- |
| no-`pvphunter` | `ml/meta_runs/route-proof-routeq-buildoption-plus-scaleq-trace-no-pvphunter-16g-20260628T0800Z/summary.json` | 16.56  | 5.56       | 0      | 0%      | 5             |
| mixed field    | `ml/meta_runs/route-proof-routeq-buildoption-plus-scaleq-trace-mixed-16g-20260628T0810Z/summary.json`        | 15.19  | 5.13       | 0      | 0%      | 4             |

The best no-`pvphunter` trace reached 28 VP cleanly by restoring at Lantern
Canyon until current barrier reached 5/10, then farming the HP-4 rung twice.
This proves the route can nearly win clean from normal starts. It is still not
solved: reach30 stayed 0%, mixed-field variance included one 3 VP failure, and
the next target is reliable conversion of the HP-4 rung and later rungs.

Firepower-preservation proof:

```bash
PRESERVE_ROUTE_FIREPOWER=1 npm run bot:route-proof
```

The full mixed-field trace
`ml/meta_runs/route-proof-routeq-buildoption-fulltrace-mixed-16g-20260628T0820Z/route-proof/strict-pure.trace.json`
showed the 3 VP failure came from an early Lantern Canyon row trade:
`anyBasic -> Cursed Spirit` destroyed the bot's only meaningful attacker, taking
firepower from kill-capable to zero. High-VP traces use that same row only after
they already have enough dice/Spirit Animal redundancy. `PRESERVE_ROUTE_FIREPOWER=1`
filters non-scoring planner actions that would drop current monster firepower
below threshold.

Firepower-preservation baseline:

| Eval           | Artifact                                                                                         | Avg VP | Kills/game | Status | Reach30 | Note                             |
| -------------- | ------------------------------------------------------------------------------------------------ | ------ | ---------- | ------ | ------- | -------------------------------- |
| no-`pvphunter` | `ml/meta_runs/route-proof-buildoption-preservefire-no-pvphunter-16g-20260628T0840Z/summary.json` | 17.31  | 5.81       | 0      | 0%      | six 20+ VP traces                |
| mixed field    | `ml/meta_runs/route-proof-buildoption-preservefire-mixed-16g-20260628T0830Z/summary.json`        | 17.25  | 5.81       | 0      | 0%      | former 3 VP failure became 24 VP |

Current best strict-Pure proof:

| Eval           | Artifact                                                                                               | Avg VP | Kills/game | Status | Reach30 | Note                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------ | ---------- | ------ | ------- | ----------------------------------------------------- |
| mixed field    | `ml/meta_runs/route-proof-restoreguard-v2-preservefire-survivaldamage-16g-20260628T0917Z/summary.json` | 21.25  | 7.38       | 0      | 0%      | clean status, 87.5% win, no owned/external cap events |
| no-`pvphunter` | `ml/meta_runs/route-proof-restoreguard-v2-preservefire-survivaldamage-16g-20260628T0917Z/summary.json` | 22.31  | 7.75       | 0      | 0%      | clean status, 100% win                                |

`PRESERVE_ROUTE_SURVIVAL=1` plus the restore/build split is now the promoted
route-proof diagnostic. The v1 artifact
`ml/meta_runs/route-proof-restoreguard-preservefire-survivaldamage-16g-20260628T0902Z/summary.json`
hit the same VP averages, and v2 kept those averages while eliminating the
mixed-field status-cap events. This proves a meaningful strict-Pure
monster-economy route from normal legal starts, but it is still not final meta
proof: reach30 remains 0%.

The remaining low-tail traces are no longer mainly missed reward picks or
unrestored current barrier. The 15-18 VP failures reach the HP-4 rung and then
stall on damage/max-barrier breakpoints: examples include max attack 2 with no
dice, or one die plus 3 Spirit Animal at only 67% HP-4 firepower. Several traces
repeat `Lantern Canyon:row0:trade:anyBasic->Cursed Spirit` and
`Lantern Canyon:row1:gain:free->cultivate+restoreBarrier` without gaining the
Spirit Animal/Fighter/Cultivator shape needed to farm HP-4+ cleanly. The next
gate should be HP-4 route-Q / full-control counterfactual data, not another
destination-only navigation gate.

HP-4 wall counterfactual gate:

```bash
npm run test:bot:hp4-wall-counterfactual
```

This smoke gate runs both HP-4 slices:

- `src/lib/play/ml/_scalingnavigationcounterfactual.test.ts`
- `src/lib/play/ml/_routeexecutioncounterfactual.test.ts`

The branch rollouts now use the same target-seat full-control continuation as
`playPlannerSelfPlayGame` when `*_SOURCE=full-control`: neural full-action
lookahead, the configured micro policy/gate, `forbidTypes`, `maxStatusLevel`,
`PRESERVE_ROUTE_FIREPOWER`, and `PRESERVE_ROUTE_SURVIVAL`. This matters because
HP-4 labels are invalid if the rollout switches back to a destructive heuristic
phase plan after the sampled branch.

Current June 28, 2026 local full-control HP-4 slices:

| Slice              | Artifact                                            | Windows | Corrections | Read                                                                                                                  |
| ------------------ | --------------------------------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| scaling navigation | `ml/hp4wall_scalingq_fullcontrol_v2_summary.json`   | 16/29   | 0           | source is always `Tidal Cove`, branch score prefers `Cyber City` in 15/16 windows, but VP/score/reach30 deltas stay 0 |
| route execution    | `ml/hp4wall_routeexecq_fullcontrol_v2_summary.json` | 16/84   | 0           | source is already the best row in all sampled HP-4 windows                                                            |

Interpretation: after fixing rollout parity, the HP-4 wall is not just an
artifact of losing Spirit Animals during branch evaluation. The current route
stack reaches HP-4 with average 21 VP / 3.33 expected attack / 2 attack dice /
2 Spirit Animal / 10 max barrier in scaling windows, but only 44% firepower and
no clean kill opportunity. Route-exec windows are later, around 24 VP with 79%
firepower but max barrier 4 and too few rounds left. The current policy
continuation cannot turn those states into HP-4 VP within the label horizon, so
the next implementation target is a stronger oracle/DAgger route prover for
damage and clean-survival breakpoints, not a simple HP-4 fine-tune from these
zero-delta labels.

HP-4 breakpoint-oracle gate:

```bash
npm run test:bot:hp4-wall-oracle
```

Set `SCALEQ_ROLLOUT_POLICY=breakpoint-oracle` or
`ROUTEEXECQ_ROLLOUT_POLICY=breakpoint-oracle` to replace the target seat's
post-branch neural continuation with a legal-action oracle that scores immediate
VP, monster kills, HP-4 firepower, clean survivability, attack dice, Spirit
Animal, Cultivator, current barrier, and max barrier. This is a diagnostic
teacher only; it is not a live bot policy and should not be used as a promoted
eval result.

Current June 28, 2026 full-control breakpoint-oracle HP-4 result:

| Slice              | Artifact                                                     | Windows | Corrections                     | Read                                                                                                                       |
| ------------------ | ------------------------------------------------------------ | ------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| scaling navigation | `ml/hp4wall_scalingq_oracle_fullcontrol_v2_64w_summary.json` | 64/161  | 3 score-positive, 2 VP-positive | sparse but real route signal: `Lantern Canyon` or `Cyber City` can convert a stuck HP-4 window into one extra kill / +2 VP |
| route execution    | `ml/hp4wall_routeexecq_oracle_fullcontrol_v2_summary.json`   | 16/84   | 0                               | still flat; row choices are not the main HP-4 bottleneck                                                                   |

The wider scaling-oracle slice wrote 64 samples to
`ml/data_hp4_wall_oracle_fullcontrol_64w/scaling/scalingq.jsonl`. Only two
windows had a clear positive VP delta: `Tidal Cove -> Lantern Canyon` at round
18 and `Tidal Cove -> Cyber City` at round 23, both +2 VP / +1 kill at status 0.
One additional `Lantern Canyon` label was score-positive but VP-flat. Training
from this lane should require `SCALEQ_LABEL_VP_THRESHOLD=1` or an equivalent
positive-VP filter until a larger oracle slice proves that non-VP breakpoint
labels improve route-proof performance.

June 28, 2026 SimForge VP-positive HP-4 scaling specialist result:

- Data/training artifact:
  `ml/meta_runs/hp4-scalingq-oracle-vppos-512w-20260628T100244Z/summary.json`
- Route-proof artifact:
  `ml/meta_runs/route-proof-hp4-scaleq-oracle-vppos-512w-20260628T103500Z/summary.json`

The 512-window full-control breakpoint-oracle slice scanned 1,440 windows,
filtered 928 non-matching windows, and kept only 37 VP-positive correction
samples with `SCALEQ_LABEL_VP_THRESHOLD=1` and `SCALEQ_POSITIVE_ONLY_DATA=1`.
Correction labels were mostly `Arcane Abyss` (21) and `Lantern Canyon` (11),
with smaller `Floral Patch` (2), `Tidal Cove` (2), and `Cyber City` (1) counts.
Heldout route imitation passed on the tiny sample: train top-1 `0.926`,
validation top-1 `0.800`, validation top-3 `0.900`, majority baseline `0.500`.

The trained specialist is **not promoted**. Used as
`SCALE_NAV_WEIGHTS` with `SCALE_NAV_GATE=route-option-scaling`, it tied the
current best strict-Pure proof instead of improving it:

| Eval           | Avg VP | Win % | Kills/game | Missed farm VP % | Status | Reach30 |
| -------------- | ------ | ----- | ---------- | ---------------- | ------ | ------- |
| mixed field    | 21.25  | 87.5  | 7.38       | 1.8              | 0      | 0%      |
| no-`pvphunter` | 22.31  | 100.0 | 7.75       | 2.7              | 0      | 0%      |

Interpretation: the positive-VP HP-4 oracle labels are real and learnable, but
37 sparse samples do not raise the normal-start proof above the restore/firepower
/ survival-guard route. Keep this lane as DAgger/counterfactual infrastructure.
The next HP-4 data pass should collect more route-failure states and include
the branch context that explains when the 20+ VP route stalls before 30.

Route-closer navigation gate:

`SCALE_NAV_GATE=route-closer` is a narrow diagnostic gate for high-VP HP-4+
states. It only activates after the clean route has reached at least 15 VP, the
monster has HP 4+, the player is still Pure, and the current state is not already
a clean farm. Its root destinations are selected by the current deficit:

- damage/firepower deficit: `Tidal Cove`, `Cyber City`, `Lantern Canyon`
- max-barrier deficit: `Floral Patch`, `Lantern Canyon`, `Cyber City`
- current-barrier restore deficit: `Lantern Canyon`, `Floral Patch`

Current June 28, 2026 SimForge result:
`ml/meta_runs/route-proof-routecloser-16g-20260628T105859Z/summary.json`.

| Eval           | Avg VP | Win % | Kills/game | Status       | Reach30 | Read                                                                                       |
| -------------- | ------ | ----- | ---------- | ------------ | ------- | ------------------------------------------------------------------------------------------ |
| mixed field    | 21.00  | 87.5  | 7.25       | 0.06 / max 1 | 0%      | regressed below the 21.25 clean baseline and allowed one external `pvphunter` status event |
| no-`pvphunter` | 22.06  | 100.0 | 7.63       | 0 / max 0    | 0%      | regressed below the 22.31 no-`pvphunter` baseline                                          |

Do **not** promote `route-closer` as a route-proof setting. It is useful
instrumentation because it increases targeted late Cyber/restore pressure, but
it does not fix the 30-point closure. The next route work should move from
navigation roots to full-action closer data: Tidal/Cyber summons, augment/rune
selection, attachment/replacement choices, and round-20+ HP-4/HP-5 DAgger states.

Route-closer full-action oracle:

`MICRO_GATE=route-closer-oracle` is a diagnostic full-action gate for the same
late strict-Pure HP-4+ stall. It activates only when the route is Pure, already
at 15-29 VP, round 12+, HP 4+, not currently clean-farmable, and short on damage,
max barrier, or current barrier. It then uses the breakpoint oracle over the
complete legal action set instead of a learned micro policy.

Current June 28, 2026 SimForge results:

- Smoke artifact:
  `ml/meta_runs/route-proof-routecloser-microoracle-smoke-20260628T111340Z/summary.json`
- Matched proof artifact:
  `ml/meta_runs/route-proof-routecloser-microoracle-16g-20260628T111920Z/summary.json`

| Eval                          | Avg VP | Win % | Kills/game | Status    | Reach30 | Read                                              |
| ----------------------------- | ------ | ----- | ---------- | --------- | ------- | ------------------------------------------------- |
| 8-game smoke, mixed field     | 22.00  | 100.0 | 7.50       | 0 / max 0 | 0%      | lifted one low-tail trace but did not close       |
| 8-game smoke, no-`pvphunter`  | 23.25  | 100.0 | 8.00       | 0 / max 0 | 0%      | promising but unstable                            |
| 16-game proof, mixed field    | 20.75  | 93.8  | 7.13       | 0 / max 0 | 0%      | regressed below the 21.25 clean baseline          |
| 16-game proof, no-`pvphunter` | 21.75  | 100.0 | 7.50       | 0 / max 0 | 0%      | regressed below the 22.31 no-`pvphunter` baseline |

Do **not** promote `route-closer-oracle` as a route-proof setting. The smoke
signal confirms that full-action control matters after the HP-4 stall, but the
matched proof falsifies this particular oracle as a 30-point closer. Use the
traces as DAgger/counterfactual failure data for a trainable full-action closer
head, not as a replacement for the learned policy.

Trainable full-action closer:

`MICRO_GATE=route-closer-full` applies a learned `MICRO_WEIGHTS` policy only in
the same late strict-Pure HP-4+ stall band used by `route-closer-oracle`. It is
the trainable version of that diagnostic, and should be evaluated only against a
matched no-micro baseline.

The route-exec collector now supports:

```bash
BRANCH_SCOPE=full \
BRANCH_TYPES=resolveLocationInteraction,spawnHandSpirit,discardHandDraws,redrawHandDraws,startCombat,resolveMonsterReward,endLocationActions,commitBenefits,resolveDecision,awakenSpirit,manualAwaken,placeAugmentOnSpirit,resolveAwakenReward,commitAwakening \
npm run bot:routeexecq:fullcontrol
```

Important runner fix: pass `MICRO_WEIGHTS=` explicitly when collecting labels
from the route-proof baseline. The route-exec runner now preserves an explicit
empty value instead of silently loading the old `routeexecq-micro` default. Before
that fix, the source games averaged only 1.5 VP and never reached the late route
band; after the fix, the same mirrored source produced VP10+ windows immediately.

Current June 28, 2026 SimForge result:

- Data/training artifact:
  `ml/meta_runs/routeexecq-fullcloser-vp15hp4-64w-20260628T120112Z/summary.json`
- Trained-closer route proof:
  `ml/meta_runs/route-proof-fullcloser-micro-8g-20260628T120551Z/summary.json`
- Matched no-micro baseline:
  `ml/meta_runs/route-proof-baseline-nomicro-8g-i32-20260628T121036Z/summary.json`

The VP15+/round12+/HP4+ full-action collector exported 64 samples and found
zero route-execution corrections under the 6-round score. Heldout imitation
passed easily: train top-1 `1.000`, validation top-1 `1.000`, validation top-3
`1.000` versus a `0.375` validation majority baseline. The trained checkpoint
was therefore learnable, but it only learned behavior the current route-proof
source was already choosing.

| Eval                   | No-micro VP | Closer VP | No-micro kills | Closer kills | Reach30 | Read         |
| ---------------------- | ----------- | --------- | -------------- | ------------ | ------- | ------------ |
| mixed field, 8g/i32    | 18.63       | 18.63     | 6.25           | 6.25         | 0% / 0% | exact VP tie |
| no-`pvphunter`, 8g/i32 | 21.50       | 21.50     | 7.25           | 7.25         | 0% / 0% | exact VP tie |

Do **not** promote `route-closer-full`. The useful conclusion is that the
current 6-round full-action branch scorer does not expose a hidden closer
improvement in the VP15/HP4 band. The remaining miss is more likely upstream:
route timing, farm-window conversion, or a longer-horizon/reach30 objective, not
local full-action selection under this label definition.

Current June 29, 2026 finish-line TraceQ result:

- Data/training artifact:
  `ml/meta_runs/traceq-finishline-hp4-clean-inclusive-20260629T063436Z/summary.json`
- Capped replay artifact:
  `ml/meta_runs/traceq-finishline-hp4-clean-inclusive-capped-20260629T081724Z/summary.json`
- Trained restore-closer route proof:
  `ml/meta_runs/route-proof-finishline-cleaninclusive-16g-20260629T065824Z/summary.json`
- Finish-loop gate ablation:
  `ml/meta_runs/route-proof-finishline-cleaninclusive-finishloop-16g-20260629T071611Z/summary.json`
- Finish-loop legal-action oracle proof:
  `ml/meta_runs/route-proof-finishloop-oracle-16g-20260629T073324Z/summary.json`
- Lantern-only restore oracle proof:
  `ml/meta_runs/route-proof-finishloop-oracle-lanternonly-16g-20260629T075035Z/summary.json`
- Over-buffered restore oracle proof:
  `ml/meta_runs/route-proof-finishloop-oracle-buffer-16g-20260629T075751Z/summary.json`

The original clean-inclusive finish-line collector sampled VP21-29 / HP4-HP10
states with clean-kill probability up to 1.0 and a stronger reach30 score bonus.
It captured 256 windows, exported 267 `arc-bot-v1` samples, found 7 corrections
(`2.7%`), and all corrections came from `restore-loop`. Correction rows averaged
`+3.14` VP and produced `+5` reach30 delta in branch replay, but that run was
generated before branch replay was capped at the real game max round.

The capped rerun used the same 48-game / 256-window finish-line slice with
`TRACEQ_MAXROUNDS=30`, `TRACEQ_HORIZONS=6,12,20`, and `TRACEQ_LABEL_HORIZON=20`.
It captured 256 windows, exported 65 samples, found only 2 corrections (`0.8%`),
averaged `-0.13` VP delta overall and `+2.00` VP on correction rows, and produced
`0` reach30 delta. All 256 windows had capped label horizons
(`roundCappedBranches=1536`, `labelRoundCappedWindows=256`). This means the old
`+5` reach30 result was optimistic continuation evidence, not proof of a legal
30-round finish-line route.

The trained checkpoint is not promotable. In route proof with the exact
clean-suite gates it scored:

| Eval                        | Avg VP | Win % | Kills/game | Status    | Reach30 | Read                                                             |
| --------------------------- | ------ | ----- | ---------- | --------- | ------- | ---------------------------------------------------------------- |
| mixed field, 16g/i64/h24    | 21.06  | 93.8  | 7.25       | 0 / max 0 | 0%      | tiny lift over the prior narrow-gate run, baseline-level overall |
| no-`pvphunter`, 16g/i64/h24 | 21.94  | 100.0 | 7.56       | 0 / max 0 | 0%      | below the 32-game clean-route no-`pvphunter` baseline            |

Do **not** promote
`ml/meta_runs/traceq-finishline-hp4-clean-inclusive-20260629T063436Z/best_policy.json`.
Use it as evidence that the late route still has a restore/re-entry conversion
signal, but not enough normal-start coverage to turn low-20s VP into reliable
30-point games. Loosening the overlay from strict restore-deficit to
finish-loop states tied the same proof exactly (21.06 / 21.94 VP, 0% reach30),
so the remaining miss is not just the activation predicate.

The stronger diagnostic oracle adds `ROUTE_FINISH_ORACLE=1` for legal full-action
choices and `PATCH2_NAV_GATE=route-finish-loop` for late navigation roots. It is
an upper-bound test, not a bot to promote. With the current clean-route stack it
lifted no-`pvphunter` from 21.94 to 22.19 VP, still with 0% reach30. A high-tail
trace showed the oracle wasted restore turns at Floral Patch, so the restore
root was narrowed to Lantern Canyon only. That improved no-`pvphunter` to 22.44
VP and 7.81 kills/game, matching the full-suite no-`pvphunter` baseline but
still 0% reach30. A further "restore enough for all remaining HP4 kills" buffer
regressed to 22.19 VP and raised missed farm VP, so do not use that rule.

Current read: a legal oracle can recover some late HP4 VP, but even hand-coded
finish-loop control is not yet enough to produce reliable 30-point games. The
remaining gap is timing: the bot reaches VP26/28 too late or with too little
clean multi-kill buffer, then spends the final rounds restoring instead of
claiming the last HP4 reward.

Long-horizon current-stack scaling follow-up:

- Full-action closer with a longer reach30 objective:
  `ml/meta_runs/routeexecq-fullcloser-reach15-32w-20260628T121923Z/summary.json`
- Current-stack 64-window scaling diagnostic:
  `ml/meta_runs/scalingq-reach15-currenthp4-64w-20260628T123325Z/summary.json`
- Current-stack 128-window scaling diagnostic:
  `ml/meta_runs/scalingq-reach15-currenthp4-128w-20260628T124112Z/summary.json`
- Matched route proof:
  `ml/meta_runs/route-proof-scalingq-reach15-currenthp4-8g-20260628T125425Z/summary.json`

The reach15 full-action closer found 32 late HP-4 windows, 0 corrections, and 0
training samples even with horizons `6,10,15`, label horizon 15, reach30 bonus
12, and kill weight 0.5. That falsifies the immediate idea that a longer local
full-action objective exposes a hidden closer in the sampled VP15+/HP4 band.

The current-stack scaling collector was more informative. The first 64-window
run found 3 VP-positive corrections from a source stack that matched the
route-proof baseline: source VP averaged 17.83, max source VP was 24, and all 3
samples were +2 VP at the label horizon. The wider 128-window run found 25
corrections in 128 windows, source VP averaged 18.08, max source VP was 24, and
the average correction was +1.75 score / +0.63 VP. Labels concentrated on
`Lantern Canyon` (11), `Arcane Abyss` (10), `Tidal Cove` (2), plus single
`Cyber City` and `Floral Patch` corrections.

This is real route-Q signal, but still not a promotion candidate. The contract
audit on the exact 25-sample dataset passed with 25 unique observations, 0 exact
conflicts, and 0 near conflicts under the current 55/52 contract. The heldout
route-imitation gate did not pass: train top-1 reached 0.842, but validation was
only 0.667 top-1 / 0.833 top-3 on a 6-sample split. A manually trained
diagnostic checkpoint exported successfully, but its standard training top-1 was
only 0.400 after 12 epochs.

Behaviorally, the trained scaling checkpoint tied the matched no-micro baseline:

| Eval                   | Baseline VP | Scaling VP | Baseline kills | Scaling kills | Reach30 | Read      |
| ---------------------- | ----------- | ---------- | -------------- | ------------- | ------- | --------- |
| mixed field, 8g/i32    | 18.63       | 18.63      | 6.25           | 6.25          | 0% / 0% | exact tie |
| no-`pvphunter`, 8g/i32 | 21.50       | 21.50      | 7.25           | 7.25          | 0% / 0% | exact tie |

Do **not** promote
`ml/meta_runs/scalingq-reach15-currenthp4-128w-20260628T124112Z/best_policy.json`.
The important conclusion is narrower: long-horizon navigation branch labels
exist under the current route stack, including some high-value +4/+6 VP rows,
but a small supervised scaling specialist still collapses back to the existing
route behavior. The next pass should gather larger DAgger data from the
high-value correction games and use validation-selected imitation before another
route-proof promotion attempt.

Larger validation-gated scaling pass:

- Data/training artifact:
  `ml/meta_runs/scalingq-reach15-currenthp4-256w-20260628T130201Z/summary.json`
- Isolated warm-start route proof:
  `ml/meta_runs/route-proof-scalingq-reach15-currenthp4-warm160-16g-trace-20260628T133147Z/summary.json`
- Matched current-stack route proof:
  `ml/meta_runs/route-proof-scalingq-reach15-currenthp4-warm160-currentstack-16g-20260628T134151Z/summary.json`

The 256-window collector scanned 770 navigation windows, kept 256 HP-4 route
windows, and found 29 positive correction samples. Source VP averaged 17.92 and
max source VP was 24. This larger dataset passed the heldout route-imitation
gate: final train top-1 `1.000`, validation top-1 `0.875`, validation top-3
`1.000`, versus validation majority `0.375`.

The default production training schedule was too short for this sparse dataset:
16 epochs reached only top-1 `0.345`. Two diagnostic retrains with 160 epochs
and learning rate `0.001` did fit the labels: a warm-started checkpoint
`best_policy_warm160.json` and a scratch checkpoint `best_policy_scratch160.json`
both reached training top-1 `1.000`. Fitting the labels still did not improve
route proof.

Isolated from the route-exec micro policy, both 8-game route proofs tied the
matched no-micro baseline exactly at 18.63 mixed VP and 21.50 no-`pvphunter` VP,
with 0% reach30. The 16-game traced isolated proof regressed to 18.06 mixed VP
and 20.13 no-`pvphunter` VP, with missed farm VP rising above 28%. That is a
negative promotion result.

The fair current-stack proof, with the proven route-exec micro restored via
`MICRO_WEIGHTS=ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json`
and `MICRO_GATE=location-interactions`, tied the current best strict-Pure proof
exactly:

| Eval                        | Current best VP | Warm160 current-stack VP | Kills/game | Missed farm VP % | Missed firepower % | Reach30 |
| --------------------------- | --------------- | ------------------------ | ---------- | ---------------- | ------------------ | ------- |
| mixed field, 16g/i64/h24    | 21.25           | 21.25                    | 7.38       | 1.8              | 30.6               | 0%      |
| no-`pvphunter`, 16g/i64/h24 | 22.31           | 22.31                    | 7.75       | 2.7              | 30.9               | 0%      |

Do **not** promote the 256-window scaling checkpoint. The correct read is that
late scaling-root labels can be represented and learned, but destination
selection alone does not close the route. The current best stack already keeps
missed farm low when the route-exec micro is present; the remaining measurable
gap is the large firepower-not-clean opportunity band after HP-2 is exhausted.
The next data lane should target "firepower-ready but not clean" HP-4 states:
restore timing, max/current barrier, and whether to take the immediate
probabilistic HP-4 attack versus another build/restore action.

Firepower-ready full-action route-closer result:

`ml/meta_runs/routeexecq-firepowerhp4-typed-96w-20260628T141556Z/summary.json`
collected 96 full-action HP-4 windows from the matched current stack, filtering to
strict-Pure states with VP 15-29, monster HP 4, firepower kill probability at
least 0.5, and clean kill probability below 0.5. The branch set was intentionally
typed to avoid branch-all blowups:
`resolveLocationInteraction,endLocationActions,commitCleanup,refillMarket,startCombat,resolveMonsterReward`.
It found 23 corrections (24.0%), mostly in Lantern/Cyber/Floral recovery states,
not direct Abyss combat states. Route imitation remained diagnostic rather than
promotable (`val_top1=0.667`, `val_top3=0.875`), but manual 200-epoch training
exported `best_policy.json` with 0.844 train top-1.

A second specialist slot now exists: `routeCloserMicroPolicy` in `selfplay`,
threaded through `AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS`,
`AZMETA_ROUTE_CLOSER_MICRO_WEIGHTS`, and
`ROUTE_CLOSER_MICRO_WEIGHTS` in `npm run bot:route-proof`. This lets the proven
`MICRO_GATE=location-interactions` policy stay active while a separate
route-closer full-action policy is used only in late finish-loop states: VP24-29,
HP4-HP10, enough remaining monster reward lives to reach 30, and either a
restore deficit or survival-ready clean/firepower access. Use
`MICRO_GATE=route-closer-full` when a deliberately broad HP-4 wall experiment is
needed.

The fair route-proof rejected the checkpoint:
`ml/meta_runs/route-proof-routecloserhp4-typed96-16g-20260628T143113Z/summary.json`.

| Eval                        | Current best VP | Route-closer VP | Kills/game | Missed farm VP % | Missed firepower % | Reach30 |
| --------------------------- | --------------- | --------------- | ---------- | ---------------- | ------------------ | ------- |
| mixed field, 16g/i64/h24    | 21.25           | 20.50           | 7.00       | 0.0              | 31.3               | 0%      |
| no-`pvphunter`, 16g/i64/h24 | 22.31           | 21.56           | 7.38       | 1.1              | 30.8               | 0%      |

Do **not** promote this route-closer full-action checkpoint. It proves the
bot-contract can layer a second micro specialist, but the target was not the
dominant failure: missed firepower stayed around 31%, current barrier was lower
than the current best, and VP regressed. The next lane should not be another
small HP-4 action-head patch. It should either gather low-roll traces with
`TRACE=1` around the 12-15 VP games or train a broader current-barrier/re-entry
sequence policy that changes earlier Lantern/Tidal/Cyber timing before the HP-4
stall appears.

Current-stack low-roll traces:
`ml/meta_runs/route-proof-currentstack-lowtrace-8g-20260628T144402Z/summary.json`
ran the current best stack with `TRACE=1 TRACE_MIN_VP=0`. The mixed-field trace
contains low games at 15 VP and 12 VP, plus near-success 28 VP games. The key
finding is that the worst lows are damage-deficit HP-4 states, not
firepower-ready states:

- mixed game 0 reaches HP-4 at round 14 with 15 VP, max barrier 4, attack 2,
  Spirit Animal 2, firepower 0, then loops Tidal Cove through round 30.
- mixed game 5 reaches HP-4 after 12 VP with attack 3, Spirit Animal 3,
  firepower 0; the no-`pvphunter` version of the same game reaches 21 VP,
  so opponent pressure/turn interaction can affect this low-roll branch.
- near-success games usually reach HP-4 with 24 VP and at least partial
  firepower, then need only one or two additional kills.

Summon-resolution smoke:
`ml/meta_runs/routeexecq-hp4-damagedeficit-summon-smoke2-20260628T145506Z/summary.json`
branched Tidal/Cove hand-draw resolution in HP-4 damage-deficit states. It found
16 Tidal windows and zero score-positive corrections. Some branch labels chose
`spawnHandSpirit:Fish Guide` or `spawnHandSpirit:Forbidden Child` over
`discardHandDraws`, but the 10-round scorer measured no VP/attack/clean-route
gain. Do not train this as-is.

Damage-deficit navigation smoke:
`ml/meta_runs/scalingq-hp4-damagedeficit-smoke-20260628T145846Z/summary.json`
branched navigation in strict-Pure HP-4 states with clean/firepower kill
probability below 0.5. It found 22 windows and 4 corrections. Sources were
mostly Tidal Cove (19/22), while branch bests were mostly Cyber City (17/22);
the best positive row gained +4 VP by choosing Tidal instead of immediate Abyss
from a 24 VP, 10 max-barrier, 0.444 firepower state. This is the next plausible
lane, but it needs a larger validation-gated collector before training. Do not
promote from the 22-sample smoke.

Damage-deficit navigation trained pass:
`ml/meta_runs/scalingq-hp4-damagedeficit-160w-20260628T150730Z/summary.json`
scaled the smoke to 160 HP-4 damage-deficit windows from normal full-control
games. It found 50 corrections (31.3%) with average score delta 1.5, average VP
delta 0.1, and 0 reach30 delta. Source destinations were mostly Tidal Cove
(118/160), while branch bests were Cyber City (54), Lantern Canyon (47), Floral
Patch (46), and Tidal Cove (13). Route imitation passed strongly: validation
top-1 0.925 and top-3 1.000 versus a 0.300 majority baseline.

The checkpoint is **not promoted**. The matched strict route proof
`ml/meta_runs/route-proof-damagedeficit-scaleq-16g-20260628T153453Z/summary.json`
tied the current best exactly:

| Eval           | Avg VP | Win % | Kills/game | Status    | Reach30 | Read                             |
| -------------- | ------ | ----- | ---------- | --------- | ------- | -------------------------------- |
| mixed field    | 21.25  | 93.8  | 7.38       | 0 / max 0 | 0%      | no improvement over current best |
| no-`pvphunter` | 22.31  | 100.0 | 7.75       | 0 / max 0 | 0%      | no improvement over current best |

A diagnostic probe that widened the live `route-option-scaling` root set to
allow Floral Patch also failed:
`ml/meta_runs/route-proof-damagedeficit-scaleq-floralroot-16g-20260628T154603Z/summary.json`.
It kept the same VP averages but introduced strict-Pure external PvP status
events in the mixed field (status avg 0.13, max 1, 724 cap violations), so the
Floral-root change was reverted. Interpretation: the HP-4 damage-deficit labels
are learnable and alter route shape, but simple destination-root control still
does not convert the 12-15 VP lows into 30 VP. The next lane should instrument
why the bot reaches HP-4 with attack 2-3 and no firepower, and should separate
pre-HP4 damage assembly from HP4 re-entry.

HP-2 survival-deficit navigation pass:
the low-score trace showed a sharper pre-HP4 failure: at HP2 the bot often has
firepower but not a clean survivable kill, restores/builds while other seats can
consume monster lives, then reaches HP4 too late or too weak. A smoke collector,
`ml/meta_runs/scalingq-hp2-survivaldeficit-smoke-20260628T160153Z/summary.json`,
found 64 HP2 firepower-not-clean windows and 19 corrections. Every source
destination was Lantern Canyon; every positive correction preferred Floral
Patch. The scaled run
`ml/meta_runs/scalingq-hp2-survivaldeficit-160w-20260628T161431Z/summary.json`
found 160 windows, 43 corrections (26.9%), average score delta 1.66, average VP
delta 0.44, and best destinations Floral Patch 143 / Lantern Canyon 17. Route
imitation passed (validation top-1 0.878, top-3 1.000), but the majority
baseline was already high at 0.829.

Two early integration proofs rejected this checkpoint:

| Integration                                                                          | Artifact                                                                         | Mixed VP | No-`pvphunter` VP | Status      | Read                                                                          |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------- | ----------------- | ----------- | ----------------------------------------------------------------------------- |
| broad replacement for `unsafe-firepower-build-option`                                | `ml/meta_runs/route-proof-hp2-survival-nav-16g-20260628T164217Z/summary.json`    | 11.94    | 12.00             | mixed max 1 | catastrophic over-resting: 20+ Floral Patch visits/game and only 4 kills/game |
| narrow `hp2-survival-deficit` gate, with old route-Q handling broad firepower states | `ml/meta_runs/route-proof-hp2-survival-narrow-16g-20260628T165350Z/summary.json` | 20.31    | 21.13             | mixed max 1 | less bad, but still below current best 21.25 / 22.31 and not strict-Pure safe |

A later low-attack-only patch made the HP2 idea safe enough to keep as a
candidate overlay. The implementation adds ordered navigation patch layers,
`PATCH_NAV_WEIGHTS` / `PATCH_NAV_GATE` and `PATCH2_NAV_WEIGHTS` /
`PATCH2_NAV_GATE`, checked before the main route-Q and scale-Q policies. For
`hp2-survival-deficit`, the live gate now only fires on Pure HP2 states in
rounds 6-18, VP 9-18, firepower-capable but not clean killable, needing
restore/survival, and with expected attack below 3.25. `clean-farm-q` fires only
on strict-Pure clean-farmable monster windows with at least 1 expected reward VP.

| Integration                                                       | Artifact                                                                                  | Mixed VP | No-`pvphunter` VP | Status    | Read                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------- | ----------------- | --------- | ------------------------------------------------------------- |
| low-attack HP2 patch + route-Q + scale-Q, 16 games                | `ml/meta_runs/route-proof-hp2patch-routeq-scaleq-16g-20260628T173108Z/summary.json`       | 21.63    | 22.50             | 0 / max 0 | clean 16-game lift over 21.25 / 22.31                         |
| low-attack HP2 patch + route-Q + scale-Q, 32 games                | `ml/meta_runs/route-proof-hp2patch-routeq-scaleq-32g-20260628T174111Z/summary.json`       | 20.97    | 22.41             | 0 / max 0 | clean but tiny matched-sample lift; reach30 remains 0%        |
| farm-Q patch + low-attack HP2 patch + route-Q + scale-Q, 16 games | `ml/meta_runs/route-proof-farmq-hp2patch-routeq-scaleq-16g-20260628T183529Z/summary.json` | 21.75    | 22.50             | 0 / max 0 | best 16-game mixed result so far; zero mixed missed-farm navs |
| farm-Q patch + low-attack HP2 patch + route-Q + scale-Q, 32 games | `ml/meta_runs/route-proof-farmq-hp2patch-routeq-scaleq-32g-20260628T184548Z/summary.json` | 20.94    | 22.41             | 0 / max 0 | clean, but does not beat HP2-only 32-game proof               |
| previous current stack, matched 32 games                          | `ml/meta_runs/route-proof-currentstack-32g-20260628T180202Z/summary.json`                 | 20.78    | 22.31             | 0 / max 0 | comparison baseline for the patch                             |

Interpretation: the low-attack HP2 patch is a clean candidate layer, not a
solution. It improves the 32-game mixed field by +0.19 VP and the no-`pvphunter`
field by +0.10 VP, with small kill lifts and no status-cap events. Keep it
available for league/arbiter experiments, but do **not** count it as solving the
30-VP Abyss route.

Farm-Q interpretation: the farm-Q labels are real, contract-compatible, and
imitable, but the first 128-window farm-Q live patch is not promoted. It improved
the 16-game mixed proof, then fell slightly below HP2-only on the matched
32-game mixed proof (20.94 vs 20.97) while tying no-`pvphunter` (22.41). Use the
dataset and `clean-farm-q` gate for larger DAgger/arbiter work, not as the next
current-best route stack.

Fresh HP2-patch low-tail trace:
`ml/meta_runs/route-proof-hp2patch-lowtrace-16g-20260628T191401Z/route-proof/strict-pure.trace-analysis.json`
ran the HP2 patch stack with `TRACE=1 TRACE_MIN_VP=0`. The proof averaged 21.63
VP, 7.50 kills/game, 0 status, and 0% reach30. The trace analysis found:

| Signal                             | Value                               |
| ---------------------------------- | ----------------------------------- |
| low tail                           | 3/16 games below 18 VP              |
| HP4 wall                           | 16/16 games                         |
| HP4 current-barrier deficit        | 15/16 games                         |
| HP4 max-barrier/Cultivator deficit | 8/16 games                          |
| missed farm games                  | 3/16, only 0.37 missed farm VP/game |

The low games were not primarily reward-pick or farm-now failures. They were
post-low-rung extension failures. The 12 VP low game reached HP4 with 7/8
barrier, attack 3.33, 2 attack dice, 2 Spirit Animal, and 2 Cultivator, then
visited Tidal Cove 21 times while repeatedly choosing `discardHandDraws`. That
exposed a full-action failure: the navigation policy was trying to assemble
damage, but the action selector could throw away route-improving hand draws.

Implementation response: `filterPlannerActions` now blocks `discardHandDraws`
in strict-Pure committed monster-route states when any legal `spawnHandSpirit`
alternative improves the route build score. This is a guard, not a heuristic
bot policy; it only preserves a legal action opportunity that the learned policy
was discarding in trace-proven failure states.

Matched hand-draw guard proof:
`ml/meta_runs/route-proof-handdrawguard-hp2patch-lowtrace-16g-20260628T200524Z/summary.json`
showed the guard is useful but not sufficient. It raised strict-Pure mixed VP
from 21.63 to 21.69 and kills/game from 7.50 to 7.56, reduced the low tail from
3/16 to 2/16 games, and stayed status 0, but reach30 remained 0%. The remaining
12 VP low still looped Tidal Cove at HP4. The more precise failure is now:
safe but sub-threshold Abyss probes. At 12 VP the bot had 7/8 barrier, HP4
monster damage 4, and 44.4% clean/firepower kill odds. Because the farmability
threshold was 0.5, it kept building while other seats consumed monster lives.

Rejected diagnostic: a temporary safe-probe route option sent the bot to Abyss
for Pure VP 9-23 HP4 states with positive reward, current barrier at least
monster damage + 1, and 30-50% clean/firepower odds. The matched proof
`ml/meta_runs/route-proof-safeprobe-handdrawguard-hp2patch-16g-20260628T201320Z/summary.json`
tied the hand-draw guard at 21.69 VP and still had the 12 VP low. A second
temporary re-entry/root patch raised VP to 21.81 in
`ml/meta_runs/route-proof-reentryroots-handdrawguard-hp2patch-16g-20260628T202047Z/summary.json`,
but failed the strict-Pure gate with external PvP status pressure (max status 1,
337 cap violations) and still had the 12 VP low. These safe-probe/re-entry root
changes are **not promoted**; keep the hand-draw preservation guard and move the
next lane to train a real HP4 wall/re-entry policy from traces instead of adding
more deterministic root patches.

Latest HP4/re-entry negative evidence:

| Experiment                              | Artifact                                                                                     | Result                                                                                 | Verdict                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| full-action HP4 wall/re-entry collector | `ml/meta_runs/routeexecq-hp4-wall-reentry-oracle-20260628T214500Z/summary.json`              | 192 windows, 8 corrections, avg VP delta 0.09, no reach30 delta, below train threshold | too sparse/noisy to train         |
| scaling HP4 re-entry collector          | `ml/meta_runs/scalingq-hp4-reentry-oracle-20260628T220000Z/summary.json`                     | 256 windows, 2 corrections, avg VP delta 0.02, no checkpoint                           | no useful broad navigation signal |
| route-closer micro oracle               | `ml/meta_runs/route-proof-routecloser-oracle-currentstack-16g-20260628T222500Z/summary.json` | strict Pure 20.75 VP, no-`pvphunter` 21.75 VP, both 0% reach30                         | underperforms current stack       |

Do **not** promote a route-closer checkpoint from these lanes, and do not run a
larger version of the same generic HP4 branch collectors without changing the
question. The next testing artifact should be a trace-state counterfactual
prover: snapshot exact low-tail states around the last VP gain / HP4 wall, then
compare scripted continuations such as immediate Abyss probe, restore/Cultivator
loop, max-barrier loop, damage assembly, and fixed-step re-entry against the
current policy continuation.

Trace-state counterfactual smoke:

```bash
npm run test:bot:trace-state-counterfactual
```

This smoke intentionally relaxes the HP4 filters so it can prove the replay
harness quickly. For real route diagnosis, run the same harness with HP4 filters
and the current route stack:

```bash
TRACEQ=1 TRACEQ_GAMES=16 TRACEQ_MAX_WINDOWS=64 \
  TRACEQ_HORIZONS=6,12,18 TRACEQ_LABEL_HORIZON=12 \
  TRACEQ_MIN_SOURCE_VP=0 TRACEQ_MAX_SOURCE_VP=24 \
  TRACEQ_MIN_PLAYER_VP=9 TRACEQ_MAX_PLAYER_VP=24 \
  TRACEQ_MIN_ROUND=8 TRACEQ_MIN_MONSTER_HP=4 \
  TRACEQ_MAX_CLEAN_KILL_PROB=0.5 \
  TRACEQ_ROLLOUT_POLICY=policy \
  npx vitest run src/lib/play/ml/_tracestatecounterfactual.test.ts --disable-console-intercept
```

Equivalent SimForge runner:

```bash
npm run bot:traceq:fullcontrol
```

The runner syncs the arc-bot workspace by default, checks `MIN_FREE_MB` on the
selected GPU, writes `ml/meta_runs/<run>/summary.json`, and rsyncs the artifact
back locally. It also writes positive correction samples to
`ml/meta_runs/<run>/data/traceq.jsonl` when `TRACEQ_DATA_OUT` is set. Set
`TRAIN=1` on the runner to warm-start a specialist checkpoint from those samples;
training refuses to start when `traceq_samples < MIN_TRAIN_SAMPLES`.
The runner forwards `ROUTE_FINISH_ORACLE=1` as `TRACEQ_ROUTE_FINISH_ORACLE=1`
when testing the legal-action finish oracle.

As of June 29, 2026, TraceQ branch rollouts are capped at `TRACEQ_MAXROUNDS`.
Summaries include `branchRolloutsCapAtMaxRounds`, `roundCappedBranches`,
`roundCappedWindows`, and `labelRoundCappedWindows`. Any older TraceQ
`reach30Delta` generated before this cap should be treated as optimistic
continuation evidence until rerun under the capped harness.

Use `TRACEQ_ROLLOUT_POLICY=breakpoint-oracle` only as an oracle diagnostic. A
useful result is not "the scripted branch has a nicer local score"; it is a
positive VP or reach30 delta against the `policy` continuation from the exact
same captured route state, with no status-cap regression.

Latest trace-state result, June 28, 2026:

| Experiment                                 | Artifact                                                                              | Result                                                                               | Verdict                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| HP2-to-HP4 transition baseline             | `ml/meta_runs/tracestateq-hp2hp4-transition-data-20260628T230500Z/summary.json`       | 64 windows, 12 restore-loop corrections, avg VP delta 0.89, correction VP delta 5.0  | trainable restore/re-entry miss            |
| TraceQ restore specialist training         | `ml/meta_runs/tracestateq-hp2hp4-restore-train-20260628T231500Z/summary.json`         | 128 windows, 28 samples, checkpoint top-1 0.821 on the small correction shard        | produced `best_policy.json` for gated eval |
| TraceQ restore specialist eval             | `ml/meta_runs/tracestateq-hp2hp4-restore-eval-20260628T233000Z/summary.json`          | 64 windows, corrections dropped from 12 to 2, avg VP delta dropped from 0.89 to 0.05 | fixed the diagnosed HP2 restore-loop miss  |
| Normal-start route proof with TraceQ patch | `ml/meta_runs/route-proof-tracestate-restore-patch-32g-20260628T234000Z/summary.json` | strict Pure 20.81 VP, no-`pvphunter` 22.34 VP, both status 0 and 0% reach30          | route is meaningful but not closed to 30   |

Conclusion: the simulator/reward flow is not the reason the bots score below 30. The current clean route harvests real multi-life monster VP, but the learned
stack still has a low-tail/late-closure problem after the HP2 restore miss is
patched.

Low-tail trace and HP4 first-wall follow-up, June 29, 2026:

| Experiment                                             | Artifact                                                                                                                     | Result                                                                                       | Verdict                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Low-tail route trace with HP2 TraceQ patch             | `ml/meta_runs/route-proof-tracestate-restore-lowtail-trace-32g-20260629T000000Z/route-proof/strict-pure.trace-analysis.json` | 11 traced games at VP 12-18; 0 missed farm VP; all 11 hit HP4 wall and post-VP plateau churn | the next failure is HP4 execution/closure, not missed low-rung farm |
| First-HP4 wall counterfactual, breakpoint continuation | `ml/meta_runs/tracestateq-lowtail-firsthp4-breakpoint-20260629T001000Z/summary.json`                                         | 63 windows, 13 restore-loop corrections, avg VP delta 0.60                                   | trainable but oracle-assisted signal                                |
| HP4 first-wall gate, oracle-shard checkpoint           | `ml/meta_runs/route-proof-hp2-hp4-traceq-patches-32g-20260629T012000Z/summary.json`                                          | strict Pure 20.44 VP, no-`pvphunter` 22.09 VP, both below HP2-only route proof               | do not promote; over-triggers Abyss/restore and reduces kills       |
| First-HP4 wall counterfactual, policy continuation     | `ml/meta_runs/tracestateq-lowtail-firsthp4-policy-20260629T013500Z/summary.json`                                             | 63 windows, 15 restore-loop corrections, avg VP delta 0.63                                   | real-policy signal exists                                           |
| HP4 first-wall gate, policy-shard checkpoint           | `ml/meta_runs/route-proof-hp2-hp4-policytraceq-strict-32g-20260629T021000Z/summary.json`                                     | strict Pure 20.63 VP, still below HP2-only 20.81                                             | do not promote; local diagnostic fix is not route-level improvement |

The new `hp4-first-wall` gate is available for diagnostics, but current HP4
first-wall checkpoints are **not** part of the promoted clean-route stack. They
prove that the low tail contains local restore/re-entry mistakes, while route
proof shows those labels alone do not close the route and can waste Abyss visits.
Next HP4 work should move to full-action execution or a broader late-route
DAgger lane that labels both navigation and combat/reward timing together.

HP4 full-action / DAgger follow-up, June 29, 2026:

`src/lib/play/ml/_routeexecutioncounterfactual.test.ts` and
`scripts/run-arc-routeexecq-fullcontrol.sh` now support the same layered
navigation stack used by route proof: `PATCH_NAV_WEIGHTS` /
`PATCH_NAV_GATE`, `PATCH2_NAV_WEIGHTS` / `PATCH2_NAV_GATE`, route-Q navigation,
scale-Q navigation, and micro policy. This matters because HP4 route-exec
diagnostics must replay the promoted HP2 restore patch rather than silently
falling back to an older single-prior source policy.

Matched strict-Pure HP4 full-action runs used the HP2 TraceQ patch, route-Q
navigation, scale-Q navigation, and full-control micro policy; they filtered for
normal-start VP 12-22, rounds 9-22, monster HP 4-5, and non-clean-killable
states.

| Experiment                                      | Artifact                                                                               | Result                                                                                                      | Verdict                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| HP4 full-action, policy continuation            | `ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-20260629T020332Z/summary.json`        | 64 windows from 964 scanned, 4 corrections, 4 samples, avg VP delta 0.13, no reach30 delta                  | sparse local micro signal; below training threshold  |
| HP4 full-action, breakpoint-oracle continuation | `ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-oracle-20260629T021217Z/summary.json` | 64 windows, 8 corrections, 8 samples, avg VP delta 0.03, no reach30 delta; tiny imitation pass on 8 samples | oracle finds setup choices, not route payoff         |
| HP4 full-action, VP-positive scoring            | `ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-vppos-20260629T021952Z/summary.json`  | 64 windows, 3 corrections, 3 samples, avg VP delta 0.13, no reach30 delta                                   | true point-paying corrections exist but are too rare |

The correction rows are mostly build/micro choices: Fish Guide spawns, Cursed
Spirit augment placement, and rune-choice resolution. They are not a dense
"go Abyss, kill, resolve reward" route-execution lane. Destination counts were
mostly Lantern Canyon/Tidal Cove/Cyber City, with only 1/64 sampled windows at
Arcane Abyss. Do **not** train or promote from this HP4 full-action shard alone.
The next useful collector should either broaden the late-route state
distribution substantially or start from exact low-tail trace states and produce
many VP-positive combat/reward/re-entry labels before training.

Exact low-tail trace-state DAgger follow-up:

`TRACEQ_SAMPLE_MODE=both` now lets the trace-state prover export both the
initial navigation label and the full-action decisions from the best scripted
continuation. `TRACEQ_FULL_SAMPLE_TYPES` can restrict those downstream samples
to combat, monster reward, location-row, summon, market, rune, awaken, decision,
and augment actions. This is opt-in; the default remains navigation-only so the
older trace-Q navigation diagnostics stay comparable.

Small strict-Pure low-tail shards did not produce trainable route-closing data:

| Experiment                                         | Artifact                                                                                      | Result                                                                                                                | Verdict                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Trace-state DAgger, policy continuation            | `ml/meta_runs/traceq-lowtail-hp4-dagger-both-smoke-20260629T031033Z/summary.json`             | 12 low-tail HP4 windows, 0 corrections, 0 samples, avg VP delta 0; best raw scripts were max-barrier-loop/abyss-probe | scripts improve shaping/firepower only, not points      |
| Trace-state DAgger, breakpoint-oracle continuation | `ml/meta_runs/traceq-lowtail-hp4-dagger-both-oracle-smoke-20260629T031340Z/summary.json`      | same 12 windows, 0 corrections, 0 samples, avg VP delta 0                                                             | oracle micro does not turn these states into VP         |
| Trace-state DAgger, status-3/no-PvP ablation       | `ml/meta_runs/traceq-lowtail-hp4-dagger-status3-smoke-20260629T031615Z/summary.json`          | 12 windows, 0 corrections, 0 samples, avg VP delta 0; policy was already best in 11/12                                | relaxing status did not expose a hidden scripted closer |
| Trace-state DAgger, alternate source seed          | `ml/meta_runs/traceq-lowtail-hp4-dagger-both-seed6500100-smoke-20260629T031931Z/summary.json` | 12 windows, 0 corrections, 0 samples, avg VP delta 0                                                                  | repeated on a different seed slice                      |

In the strict shards, scripts often created firepower opportunities or attack
dice, but not clean combat, kills, reward claims, or reach30 movement. Do not
scale this scripted low-tail trace-state DAgger lane without changing the
scripts/objective. The next HP4 proof should either construct a stronger
survival/max-barrier oracle that demonstrably reaches clean HP4 kills from these
states, or pivot to evaluating balance/status rules rather than training another
model on zero-VP labels.

June 29 HP4 survival-oracle branch:
`src/lib/play/ml/_tracestatecounterfactual.test.ts` now includes a
`hp4-survival-oracle` script. It is a diagnostic branch, not a live policy. The
script deliberately sequences damage assembly, max-barrier/Cultivator work,
current-barrier restoration, and then Arcane Abyss re-entry. Use it to answer a
more precise question than the previous generic scripts: can a legal hand-coded
HP4 survival/re-entry plan create actual point-paying clean HP4 kills from the
current low-tail states? If this branch still produces zero VP-positive
corrections, the next discussion should shift toward balance/status rules or a
deeper search oracle rather than another small imitation patch.

Focused SimForge result:
`ml/meta_runs/traceq-hp4-survival-oracle-20260629T104319Z/summary.json` ran 16
source games, 64 VP9-24 / HP4+ windows, policy continuation, no PvP, status 0,
and `TRACEQ_SAMPLE_MODE=both` with combat/reward/location/summon/decision/augment
full-action exports. It found 2 VP-positive corrections, both from
`hp4-survival-oracle`, exported 20 samples, averaged only +0.06 VP over all
windows, averaged +2.00 VP on corrected windows, and produced no reach30 delta.
Best-script counts were restore-loop 24, max-barrier-loop 17, policy 17,
hp4-survival-oracle 4, fixed-reentry 2. Verdict: the branch proves legal
point-paying late HP4/HP5 corrections exist, but the signal is still too sparse
and too late to train or promote a clean-route specialist from this shard alone.
The next run should either widen exact low-tail/high-VP state coverage or add a
stronger objective/search oracle that can move reach30, not just 24 VP to 26 VP.

Wider exact-state SimForge result:
`ml/meta_runs/traceq-hp4-survival-oracle-wide-20260629T105620Z/summary.json`
used GPU 6 with `MIN_FREE_MB=20000`, 64 source games, a 256-window cap,
VP12-29 / round10-24 / HP4+ filters, policy continuation, no PvP, status 0,
and a 6-round label horizon. It reached the cap after 40 source games:
256 windows, 19 VP-positive corrections, 428 exported mixed samples, +0.09 VP
average delta, +2.00 VP average correction delta, and 0 reach30 delta. The
corrections split across restore-loop 11 and `hp4-survival-oracle` 8; best-script
counts were policy 120, restore-loop 75, max-barrier-loop 25, fixed-reentry 21,
`hp4-survival-oracle` 13, damage-assembly 2. The sample contract audit passed at
`55/52` with `keyMode=obs-cands`, 0 exact conflicts, 0 near conflicts, and one
obs-only collision between `startCombat` and `resolveLocationInteraction` that
had different candidate menus. Route imitation on the 428 rows passed
(`val_top1=0.898`, `val_top3=0.972`, majority `0.343`). Verdict: the HP4
restore/survival labels are learnable and no longer zero-signal, but they still
do not prove a 30-point clean route. Treat this as a narrow specialist/DAgger
candidate only after a route-level eval plan is in place; do not promote it as a
clean-route solution.

Specialist training and route-level ablation:
`ml/meta_runs/traceq-hp4-survival-oracle-wide-20260629T105620Z/best_policy.json`
was trained from the 428-row TraceQ shard with AlphaZero-style targets and the
aux-head policy as warm start. Three 16-game SimForge route proofs tested the
checkpoint as a route-closer navigation patch, a late route-closer micro patch,
and both together:

| Eval                          | Artifact                                                                         | Strict Pure                                     | No-`pvphunter`               | Verdict                                  |
| ----------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------- | ---------------------------------------- |
| nav+micro HP4 specialist      | `ml/meta_runs/route-proof-hp4-survival-specialist-20260629T113600Z/summary.json` | 19.88 VP, 0% reach30, one external status event | 21.00 VP, 0% reach30         | regresses; do not promote                |
| micro-only route-closer patch | `ml/meta_runs/route-proof-hp4-survival-microonly-20260629T114636Z/summary.json`  | 20.94 VP, 0% reach30                            | 21.81 VP, 0% reach30         | roughly baseline, no closure             |
| nav-only route-closer patch   | `ml/meta_runs/route-proof-hp4-survival-navonly-20260629T115643Z/summary.json`    | 21.06 VP, 0% reach30, max 28                    | 21.56 VP, 0% reach30, max 28 | raises ceiling to 28 but not finish      |
| route-finish-loop nav guard   | `ml/meta_runs/route-proof-route-finish-loop-20260629T120741Z/summary.json`       | 21.56 VP, 0% reach30                            | 22.44 VP, 0% reach30         | best strict slice here, still not solved |

Near-success traces show the remaining miss precisely: in 28 VP games the bot
can reach HP4 with remaining reward lives and enough max barrier, but it either
arrives too late, spends several turns restoring current barrier, or misses a
clean-farmable final Abyss re-entry by one navigation decision. The
`route-finish-loop` guard fixes some final ready-state navigation but does not
create reach30. Next data should target VP26-28 finish timing with an explicit
reach30 label/objective, not another local +2 VP HP4 shard.

Finish-line TraceQ proof, June 29, 2026:
`ml/meta_runs/traceq-finishline-reach30-20260629T122717Z/summary.json` targeted
VP24-29 / round16-29 / HP4+ states with `finish-line-oracle`,
`hp4-survival-oracle`, restore-loop, and fixed-reentry branches. It collected
128 windows from 46 source games and exported 136 mixed navigation/full-action
samples. The key result is that finish-line signal exists: 14 VP-positive
corrections, all from `finish-line-oracle`, +2.00 VP average correction delta,
and `reach30Delta=1`. The dataset passed the candidate-aware contract audit at
`55/52` with zero exact or near conflicts, and route imitation passed strongly
(`val_top1=0.971`, `val_top3=1.000`, majority `0.171`). The trained specialist
`ml/meta_runs/traceq-finishline-reach30-20260629T122717Z/best_policy.json` is
therefore a valid narrow diagnostic checkpoint.

Normal-start route proof still rejected that checkpoint as a promotion:

| Eval                                                             | Artifact                                                                       | Strict Pure                                     | No-`pvphunter`       | Verdict                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------- | --------------------------------------- |
| finish-line specialist, prior Lantern root                       | `ml/meta_runs/route-proof-finishline-specialist-20260629T124508Z/summary.json` | 20.94 VP, 0% reach30                            | 22.06 VP, 0% reach30 | no route-level transfer; do not promote |
| finish-line specialist, Floral-first large-deficit root ablation | `ml/meta_runs/route-proof-finishline-floralroot-20260629T125751Z/summary.json` | 21.19 VP, 0% reach30, one external status event | 22.06 VP, 0% reach30 | failed ablation; do not keep as default |

The 28 VP trace from the first run showed a concrete stall: after a VP26 kill,
the bot restored slowly from barrier 1 through repeated Lantern Canyon turns and
only got one final Abyss kill at round 30, ending at VP28. A Floral-first root
was tested because it should speed that restore cycle, but it did not improve
reach30 and reduced the no-`pvphunter` high from 28 to 26. Keep
`finish-line-oracle` as a TraceQ/search diagnostic, but do not promote the
trained finish-line specialist or the Floral-root route-finish behavior. The
next proof needs a broader search/route-exec collector for the full VP24-30
cycle, not another tiny finish-line fine-tune.

VP24-to-30 route-exec cycle and current-best proof, June 29, 2026:
the broader full-control collector
`ml/meta_runs/routeexecq-vp24-cycle-20260629T131405Z/summary.json` used the
current stacked route policy, the HP2 survival patch, the HP4 finish-loop patch,
route-Q navigation, scale-Q navigation, and the route-exec micro policy. It
scanned 2,914 states, kept 256 VP24-29 / HP4 windows, and found only 9
corrections. Those corrections averaged +0.50 score / +0.05 VP and produced no
reach30 delta, so the late full-action micro signal is too sparse to train as a
major next checkpoint.

The matched 64-game normal-start proof
`ml/meta_runs/route-proof-currentbest-hp4finish-64g-20260629T134118Z/summary.json`
changes the route status from "existence unproven" to "existence proven but
inconsistent":

| Eval                        | Strict Pure                                                        | No-`pvphunter`                                                    | Read                                                                  |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| current stacked route proof | 21.95 VP, 95.3% win, status 0/max 0, 7.64 kills/game, 6.3% reach30 | 23.27 VP, 100% win, status 0/max 0, 8.06 kills/game, 3.1% reach30 | strict clean normal-start route can reach 30, but consistency is poor |

Route-trace analysis is now part of the route-proof artifact loop via
`npm run bot:route-trace:analyze`. The refreshed analyses
`ml/meta_runs/route-proof-currentbest-hp4finish-64g-20260629T134118Z/route-proof/strict-pure.trace-analysis.json`
and
`ml/meta_runs/route-proof-currentbest-hp4finish-64g-20260629T134118Z/route-proof/strict-pure-no-pvphunter.trace-analysis.json`
show the new bottleneck: among VP28+ traced strict games, 4 finished at 30 and 6
stalled at 28; finishers averaged 0.83 more kills. The no-`pvphunter` trace had
2 finishers and 6 near-misses with the same 0.83 kill gap. Next training should
therefore collect success-prefix / contrast labels around the final HP4
reward-life cycle, not keep re-proving that the route exists.

Success/near-miss route sample export, June 29, 2026:
`_azeval.test.ts` and `scripts/run-arc-route-proof-matrix.sh` now support
`ROUTE_SAMPLE_EXPORT=1`. Exported route-proof data is written as trainable
subdirectories, not a flat mixed folder:

```text
<variant>.data/success/samples.jsonl
<variant>.data/near_miss/samples.jsonl
<variant>.data/contrast/samples.jsonl
<variant>.data/low_tail/samples.jsonl
```

Each subdirectory has its own `meta.json`, so `ml/train.py` and
`ml/route_imitation.py` can point at exactly one shard without double-counting.
`low_tail` is opt-in via `ROUTE_SAMPLE_LOW_MAX_VP`; by default its rows are
written with `policyWeight=0`, so they train value/regression without imitating
the bad low-tail action choices. Use `ROUTE_SAMPLE_LOW_MIN_DECISION_VP` and
`ROUTE_SAMPLE_LOW_MAX_DECISION_VP` when the value-only failure slice should cover
a different decision-VP band than success/near-miss contrast.
The exported proof
`ml/meta_runs/route-proof-sample-export-currentbest-20260629T143125Z/summary.json`
matched the current-best 64-game route proof while adding data: strict Pure
exported 450 success rows and 655 near-miss rows; no-`pvphunter` exported 219
success rows and 652 near-miss rows. The combined contrast shard
`ml/meta_runs/route-success-contrast-combined-20260629T151223Z/data` has 1,976
rows from 18 high-tail games. Heldout route imitation on the strict contrast
shard passed strongly (`val_top1=0.844`, `val_top3=0.967`, majority `0.175`),
which proves the current `55/52` contract can represent the high-tail labels.

The first AWR specialist trained from that combined contrast shard is useful but
not a global promotion. Its 32-game proof
`ml/meta_runs/route-proof-successcontrast-specialist-20260629T151330Z/summary.json`
looked promising: strict Pure improved to 23.13 VP / 8.22 kills/game / 6.3%
reach30, and no-`pvphunter` reached 23.34 VP / 8.28 kills/game / 3.1% reach30.
The wider strict-only confirmation
`ml/meta_runs/route-proof-successcontrast-specialist-strict64-20260629T153347Z/summary.json`
kept the average lift at 23.05 VP and 8.28 kills/game, but reach30 fell to 3.1%
and the low tail worsened, including a 3 VP game. Verdict: keep this checkpoint
as diagnostic/gating material, not a replacement for the current base stack.
Next training should either gate the specialist only in validated high-tail
states or add lower-tail regression data before another global-weight proof.

The first gated attempt did not work. `ROUTE_CLOSER_MICRO_WEIGHTS` was set to
the same success/near-miss specialist while the global base stayed on the
current stack. The 64-game proof
`ml/meta_runs/route-proof-successcontrast-gated-closer-20260629T155715Z/summary.json`
rejected this as a promotion:

| Eval                                           | Strict Pure                             | No-`pvphunter`                          | Verdict                               |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------- |
| current base stack                             | 21.95 VP, 6.3% reach30, 7.64 kills/game | 23.27 VP, 3.1% reach30, 8.06 kills/game | current reference                     |
| success-contrast as route-closer micro overlay | 21.52 VP, 3.1% reach30, 7.42 kills/game | 22.95 VP, 1.6% reach30, 7.91 kills/game | regresses both fields; do not promote |

Interpretation: the success-contrast specialist's useful signal is not captured
by simply swapping late full-action micro decisions. The next experiment should
target navigation/re-entry timing or train with lower-tail regression data,
rather than reusing this checkpoint as `ROUTE_CLOSER_MICRO_WEIGHTS`.

The navigation-level finish gate was neutral, not positive. In
`ml/meta_runs/route-proof-successcontrast-navfinish-strict64-20260629T163748Z/summary.json`,
the success/near-miss specialist replaced the previous
`PATCH2_NAV_GATE=route-finish-loop` HP4 finish patch. The strict 64-game result
matched the current reference exactly: 21.95 VP, 95.3% win, 7.64 kills/game,
8.09 Abyss navs/game, status 0, and 6.3% reach30. Treat this as evidence that
the current high-tail contrast checkpoint is not yet useful as a route-finish
navigation replacement. The next useful branch is either a non-confounding extra
patch slot for finish experiments or a retrain that mixes high-tail contrast
with lower-tail regression and explicit VP24-30 re-entry labels.

Survival-rebuild diagnostics:

```bash
SCALE_NAV_GATE=survival-rebuild \
PRESERVE_ROUTE_FIREPOWER=1 \
PRESERVE_ROUTE_SURVIVAL=1 \
npm run bot:route-proof
```

Two 16-game SimForge proof attempts tested whether a sparse survival/scaling
navigation prior can fix the HP-4 stall. Both are diagnostic, not promoted:

| Variant                    | Artifact                                                                               | Mixed VP | No-`pvphunter` VP | Status                       | Reach30 | Read                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- | -------- | ----------------- | ---------------------------- | ------- | ---------------------------------------------------------------- |
| broad survival roots       | `ml/meta_runs/route-proof-survivalrebuild-preserve-16g-20260628T0813Z/summary.json`    | 16.31    | 17.63             | mixed 0.13, no-`pvphunter` 0 | 0%      | slight no-`pvphunter` lift, but too many Floral Patch rest loops |
| damage/restore split roots | `ml/meta_runs/route-proof-survivalrebuild-v2-preserve-16g-20260628T0828Z/summary.json` | 16.50    | 17.25             | 0                            | 0%      | removed Floral loops but over-shifted to Tidal Cove summon loops |

Conclusion: destination gating can certify a meaningful clean monster-economy
route, but it does not yet solve the route. The missing piece is a stronger
route-execution/full-control policy that preserves or rebuilds Spirit Animal /
attack damage after the HP-1 and HP-2 rungs are exhausted. Do not train a major
curriculum from `survival-rebuild` alone; use the traces as DAgger/counterfactual
failure states.

Route-proof matrix:

```bash
npm run bot:route-proof
```

Default remote command shape:

```bash
RUN_ID=route-proof-$(date -u +%Y%m%dT%H%M%SZ) \
WEIGHTS=ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json \
GPU=6 GAMES=32 ITERS=64 HORIZON=24 \
bash scripts/run-arc-route-proof-matrix.sh
```

The matrix runs:

- strict Pure: `initiatePvp` forbidden, max status 0
- Tainted tolerance: `initiatePvp` forbidden, max status 1
- no-PvP corruption: `initiatePvp` forbidden, max status 3
- strict Pure + farm navigation oracle
- strict Pure + farm navigation oracle + farm-value bonus
- strict Pure against a field without `pvphunter`

Oracle/bonus variants are **diagnostic only** and must never be promoted. If the
strict Pure route cannot approach 10-12 VP even with high-budget lookahead and
farm oracle/bonus diagnostics, treat strict Pure economy as a current-rules
balance finding rather than a training failure.

Strict Pure promotion requires both a score threshold and proof cleanliness:
average VP alone is insufficient. The summary must report zero planner-owned
PvP/corruption events, no oracle, no farm-value bonus, normal legal starts, and
real monster VP through `resolveMonsterReward`. If the field forces external
corruption, report that separately as matchup pressure; do not collapse it into
"the planner chose a corrupting route."

Current June 28, 2026 SimForge route-proof result:
`ml/meta_runs/route-proof-full-hardcap-20260628T0101Z/summary.json`, 32 games
per variant, 64 planner iterations, horizon 24, full-control lookahead.

| Variant                    | Avg VP | Win % | Status avg/max | Cap violations | Kills/game | Reach 30% |
| -------------------------- | ------ | ----- | -------------- | -------------- | ---------- | --------- |
| strict Pure                | 5.63   | 59.4  | 0.00 / 0       | 0              | 1.88       | 0.0       |
| Tainted tolerance          | 9.03   | 71.9  | 0.97 / 2       | 52             | 3.03       | 0.0       |
| no-PvP corruption          | 16.63  | 90.6  | 2.53 / 3       | 0              | 6.25       | 3.1       |
| strict Pure + farm oracle  | 5.63   | 59.4  | 0.00 / 0       | 0              | 1.88       | 0.0       |
| strict Pure + oracle bonus | 5.63   | 59.4  | 0.00 / 0       | 0              | 1.88       | 0.0       |
| strict Pure, no pvphunter  | 5.25   | 84.4  | 0.00 / 0       | 0              | 1.75       | 0.0       |

Interpretation: pause the pure/economy mixed lane as a major GPU run. The
current bot already navigates to the Abyss frequently and misses 0% of detected
clean farm windows, but strict Pure still converts only about two kills per
game. Farm navigation oracle and a +20 farm-value bonus do not change the
outcome, so the bottleneck is tactical execution/build/reward conversion after
arriving at the Abyss. Allowing status-3 corruption without PvP unlocks a much
stronger monster route, while max-status-1 is not a clean proof because later
state transitions exceed the cap.

Microdiagnostic follow-up:
`ml/meta_runs/route-proof-microdiag-20260628T0212Z/summary.json`, 8 games per
variant, 16 planner iterations, horizon 12.

| Variant           | Avg VP | Kills/game | Legal fights/game | Clean fights/game | Firepower fights/game | Missed clean % | Max barrier avg |
| ----------------- | ------ | ---------- | ----------------- | ----------------- | --------------------- | -------------- | --------------- |
| strict Pure       | 4.50   | 1.50       | 42.00             | 1.50              | 34.38                 | 0.0            | 4.00            |
| no-PvP corruption | 13.88  | 5.13       | 17.63             | 3.75              | 9.00                  | 20.0           | 4.13            |

Interpretation: strict Pure is not primarily skipping clean combat. It has many
legal and firepower-capable Abyss fights, but very few clean survivable fights.
The current policy's barrier ceiling stays around the starting value, so monster
damage would empty barrier and corrupt before the counterattack. The next
training/eval lane should target survivability and timing: max barrier,
mitigation, restore loops, or simultaneous-attack builds before forcing more
Abyss navigation.

Clean-farm navigation oracle probe:

```bash
AZMETA=1 AZMETA_GAMES=4 AZMETA_ITERS=12 \
  AZMETA_WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  AZMETA_CONTROL=full AZMETA_FULL_SELECTION=value \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept

AZMETA=1 AZMETA_GAMES=4 AZMETA_ITERS=12 \
  AZMETA_WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  AZMETA_CONTROL=full AZMETA_FULL_SELECTION=value \
  AZMETA_FARM_NAV_ORACLE=force \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept
```

`AZ*_FARM_NAV_ORACLE=force` is a curriculum/eval knob, not a live-bot rule. It
only changes a planner-seat navigation decision when the current reducer state is
clean farmable: Pure status and clean monster kill probability at or above
`AZ*_FARM_NAV_THRESHOLD` / `AZ_FARM_NAV_THRESHOLD` (default `0.5`). All runs now
also report farmable navigation counts and missed farmable-Abyss rates.

Current June 27, 2026 Act52 smoke result:

| Probe                                  | Avg VP | Status | Abyss navs/seat-game | Kills/seat-game | Farmable navs/seat-game | Missed farmable navs |
| -------------------------------------- | ------ | ------ | -------------------- | --------------- | ----------------------- | -------------------- |
| Act52 all-planner                      | 0.00   | 0.00   | 0.00                 | 0.00            | 22.00                   | 100.0%               |
| Act52 + force oracle                   | 3.38   | 0.19   | 1.13                 | 1.13            | 1.13                    | 0.0%                 |
| Act52 + 2-epoch oracle smoke fine-tune | 6.19   | 0.63   | 2.31                 | 1.94            | 2.75                    | 59.1%                |
| Act52 replay + 10x oracle slice        | 5.44   | 0.25   | 1.94                 | 1.81            | 2.63                    | 54.8%                |

The same fine-tune regressed the 8-game heuristic-field arena from Act52's
23.13 VP / 62.5% win to 15.00 VP / 50.0% win. Treat this as positive evidence
for the training signal and negative evidence for promotion. The next GPU lane
must mix oracle clean-farm data with broad Act52 replay or split navigation/micro
heads; do not promote a pure oracle fine-tune.

The first 10x mixed-replay smoke improved the tiny all-planner meta probe but
still regressed the same arena to 16.13 VP / 50.0% win / status 3.0. That means
simple replay mixing is not enough at local scale; the next serious lane should
either use a much broader seeded GPU mix with validation checkpoints or isolate
the clean-farm navigation correction in a separate navigation head/gate.

Prebuilt policy eval:

```bash
ABYSSCURRICULUM_EVAL=1 ABYSSCURRICULUM_EVAL_GAMES=6 \
  ABYSSCURRICULUM_EVAL_DICE_COUNTS=6,10 \
  ABYSSCURRICULUM_EVAL_MAX_BARRIERS=12,16,20 \
  ABYSSCURRICULUM_EVAL_SPIRIT_ANIMALS=2 \
  ABYSSCURRICULUM_EVAL_WEIGHTS=ml/path/to/policy.json \
  ABYSSCURRICULUM_EVAL_SELECTION=policy \
  npx vitest run src/lib/play/ml/_abysscurriculum.test.ts --disable-console-intercept
```

This is a curriculum-slice metric only. A checkpoint that scores high here can
execute mature farm states; it still must pass normal-start meta and arena gates
before promotion.

Split navigation/micro policy diagnostic:

```bash
AZEVAL=1 AZEVAL_GAMES=6 AZEVAL_ITERS=16 \
  AZEVAL_WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  AZEVAL_MICRO_WEIGHTS=ml/weights/act52-abyss-micro-policyonly.json \
  AZEVAL_MICRO_GATE=abyss-round \
  AZEVAL_CONTROL=full AZEVAL_FULL_SELECTION=value \
  AZEVAL_FIELD=godly,medium,cultivator,pvphunter \
  AZEVAL_OUT=ml/split_gated_act52_nav_micro_value_eval.json \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

`AZ*_MICRO_WEIGHTS` keeps navigation/search on `AZ*_WEIGHTS`, but routes
non-navigation full-control decisions through a separate scorer. Supported
`AZ*_MICRO_GATE` values:

- `all`: use the micro scorer for every non-navigation full-control decision.
- `abyss-round`: use it only after the seat has locked Arcane Abyss.
- `abyss-farm-actions`: at the Abyss, let it compete only on
  `startCombat`, `resolveMonsterReward`, and draw/summon resolution.
- `abyss-reward-actions`: at the Abyss, let it compete only on reward/draw
  resolution, leaving combat timing to the main policy.
- `abyss-farm-overlay`: keep the main policy in control, but let the micro
  policy override only concrete Abyss payoff actions: VP reward claims or
  killing combats that create pending reward VP.

These gates are for architecture experiments; promotion still requires the full
meta suite and should beat the unsplit checkpoint across multiple search
budgets, not only one small-seed arena.

Learned-controller forced-Abyss gate:

```bash
AZEVAL=1 AZEVAL_GAMES=8 AZEVAL_ITERS=32 \
  AZEVAL_WEIGHTS=ml/path/to/candidate_policy.json \
  AZEVAL_FORCE_DEST="Arcane Abyss" \
  AZEVAL_CONTROL=full AZEVAL_FULL_SELECTION=value \
  AZEVAL_FIELD=godly,medium,cultivator,pvphunter \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

Run this before any long GPU run when a change affects combat, reward scoring,
full-command action selection, or bot evaluation. It answers a narrow question: if
the learned controller is already sent to the Arcane Abyss, can it cash monster
kills into VP? A candidate that cannot beat a strong farm baseline here is not a
valid meta candidate, even if a broad arena metric looks high.

Do not assume every early monster is worth 3 VP. The engine creates a
`pendingReward` on monster kill, then `resolveMonsterReward` chooses up to the
monster's `chooseAmount` reward tokens from its track. Early tracks can include
1-2 VP choices and summon/economy choices, while higher VP choices appear later.
Use the VP-source or forced-Abyss artifact to prove actual reward VP, kills, and
monster-rung progress before making balance conclusions.

Monster reward action-surface gate:

```bash
npx vitest run src/lib/play/ml/neuralBot.test.ts src/lib/play/monsterRewards.test.ts --disable-console-intercept
```

The reducer already supports arbitrary monster reward picks and wildcard
`choices`. The ML action surface must expose those choices too. This gate proves
a small `choose 2 of 4` monster reward track produces all non-empty legal pick
combinations (`0`, `1`, `2`, `3`, `0,1`, `0,2`, `0,3`, `1,2`, `1,3`, `2,3`) and
that wildcard rune rewards expose distinct choice candidates. This matters
because a bot that cannot see `3 VP + summon` or `3 VP + rune` can look weak even
when the game rule is correct.

Post-fix Act52 smoke, June 27, 2026:

| Probe                                                       | Avg VP | Win%  | Status | Farmable navs   | Missed farmable navs | Notes                                                |
| ----------------------------------------------------------- | ------ | ----- | ------ | --------------- | -------------------- | ---------------------------------------------------- |
| Act52 all-planner meta, 4 games / 12 iters                  | 0.00   | n/a   | 0.00   | 22.00/seat-game | 100.0%               | Reward surface fix alone does not make Act52 farm.   |
| Act52 vs heuristic field, 8 games / 16 iters                | 23.13  | 62.5% | 2.75   | 0.75/game       | 0.0%                 | Arena strength unchanged, still corruption-heavy.    |
| Act52 + mixed10 nav prior, all-planner meta                 | 6.56   | n/a   | 0.81   | 2.38/seat-game  | 55.3%                | Navigation split fixes part of all-planner collapse. |
| Act52 + mixed10 nav prior, arena 4 games / 12 iters         | 8.25   | 0.0%  | 1.00   | 2.25/game       | 22.2%                | Cleaner but loses to `pvphunter`.                    |
| Act52 + force farmable-nav oracle, arena 4 games / 12 iters | 6.75   | 0.0%  | 1.00   | 1.75/game       | 0.0%                 | Hard farm-now rule is too local for field play.      |

Conclusion: fixing reward choices was necessary, but it does not solve the
navigation policy. A pure "if clean-farmable then Abyss" rule underperforms
against fast heuristic-field pressure. The next training target should be
value-aware: farm low-rung lives when the expected reward VP, race state,
survival risk, and opportunity cost beat alternatives, rather than treating
clean kill probability alone as sufficient.

The meta/eval/generation artifacts now include missed farm opportunity VP:

- `farm_opportunity_vp_per_seat_game` / `planner_farm_opportunity_vp_per_game`
- `missed_farm_opportunity_vp_per_seat_game` / `planner_missed_farm_opportunity_vp_per_game`
- `missed_farm_opportunity_vp_pct`
- `max_farm_opportunity_vp`

A tiny 2-game / 8-iteration Act52 meta probe after this instrumentation wrote
`ml/rewardchoices_act52_meta2_i8_opportunity.json`: 0.00 avg VP, 18.75 farmable
navs per seat-game, and 49.00 missed farm-opportunity VP per seat-game. Use this
as a dashboard/training signal: missed farm opportunity is now quantified in VP,
not only as a navigation count.

Farm-value diagnostic prior:

```bash
AZMETA=1 AZMETA_GAMES=4 AZMETA_ITERS=12 \
  AZMETA_WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  AZMETA_PROFILE=cultivator \
  AZMETA_FARM_VALUE_BONUS=20 AZMETA_FARM_VALUE_THRESHOLD=0.02 \
  AZMETA_OUT=ml/farmvalue_bonus20_act52_meta4_i12.json \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept

AZEVAL=1 AZEVAL_GAMES=4 AZEVAL_ITERS=12 \
  AZEVAL_WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  AZEVAL_CONTROL=full AZEVAL_FULL_SELECTION=value \
  AZEVAL_FIELD=pvphunter,medium,cultivator,survivor \
  AZEVAL_FARM_VALUE_BONUS=20 AZEVAL_FARM_VALUE_THRESHOLD=0.02 \
  AZEVAL_OUT=ml/farmvalue_bonus20_act52_eval4_i12.json \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

`AZ*_FARM_VALUE_BONUS` is an off-by-default diagnostic. It adds a root navigation
prior toward Arcane Abyss proportional to a shared farm-value signal:
clean kill probability, claimable reward VP, remaining monster lives, status, and
opponent race pressure. It is not a live bot rule and it is not a promotion
shortcut.

June 27, 2026 smoke:

| Probe                                                 | Avg VP / Win    | Status | Kills          | Missed farm opp VP |
| ----------------------------------------------------- | --------------- | ------ | -------------- | ------------------ |
| Act52 meta, no farm-value bonus, `cultivator` profile | 0.00 VP         | 0.00   | 0.00/seat-game | 100.0%             |
| Act52 meta, rollout value only (`AZMETA_VALUEW=0`)    | 3.19 VP         | 0.25   | 1.06/seat-game | 92.2%              |
| Act52 meta, farm-value bonus 20                       | 2.06 VP         | 0.00   | 0.69/seat-game | 0.0%               |
| Act52 arena 4g/12i, no bonus                          | 0.0% / 2.25 VP  | 0.25   | 0.75/game      | 93.8%              |
| Act52 arena 4g/12i, farm-value bonus 20               | 25.0% / 8.25 VP | 0.25   | 2.75/game      | 0.0%               |

Interpretation: the farm-value prior fixes the specific "skip clean low-rung
farm" miss in these tiny probes, but it still does not create a solved bot.
Treat it as a teacher/curriculum signal. A checkpoint still needs to pass the
normal meta and arena gates without collapsing against `pvphunter`.

Pure-only Abyss diagnostic:

```bash
AZEVAL=1 AZEVAL_GAMES=8 AZEVAL_ITERS=32 \
  AZEVAL_WEIGHTS=ml/path/to/candidate_policy.json \
  AZEVAL_FORCE_DEST="Arcane Abyss" \
  AZEVAL_CONTROL=full AZEVAL_FULL_SELECTION=value \
  AZEVAL_MAX_STATUS_LEVEL=0 \
  AZEVAL_FIELD=godly,medium,cultivator,pvphunter \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

Use this as a balance/strategy diagnostic, not a normal promotion gate. It shows
whether the checkpoint has learned a clean non-corrupt monster/economy line or is
relying on corruption to survive and score.

Full-command lookahead diagnostic:

```bash
AZEVAL=1 AZEVAL_GAMES=8 AZEVAL_ITERS=24 \
  AZEVAL_WEIGHTS=ml/path/to/candidate_policy.json \
  AZEVAL_CONTROL=full AZEVAL_FULL_SELECTION=lookahead \
  AZEVAL_FULL_LOOKAHEAD_DEPTH=2 \
  AZEVAL_FIELD=pvphunter,medium,cultivator,survivor \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
```

Use this when `value` selection appears myopic. It is slower, but it can reveal
whether the checkpoint contains useful value/policy signal that only fails under
one-step command selection.

Sequence-lookahead full-command smoke:

```bash
AZ_CONTROL=full AZ_FULL_SELECTION=lookahead \
  AZ_FULL_LOOKAHEAD_DEPTH=1 AZ_FULL_LOOKAHEAD_BEAM=4 AZ_FULL_LOOKAHEAD_ROOT_BEAM=8 \
  RUN_ID=lookahead-smoke OUTER=1 GAMES=1 SHARDS=1 MCTS=4 HORIZON=8 \
  EPOCHS=1 BATCH=128 META_GAMES=1 META_MCTS=4 \
  bash ml/discover_meta.sh
```

Use this when changing sequence-aware full-command decision logic. `lookahead` is
slower than `value`, so keep the smoke depth/beam small and only scale after the
smoke proves that generation, training, and meta eval finish.

Soft policy-target smoke:

```bash
AZ=1 AZ_CONTROL=full AZ_FULL_SELECTION=value AZ_FULL_TARGET_TEMP=0.5 \
  AZ_PLANNER_SEATS=all AZ_GAMES=1 AZ_ITERS=4 AZ_HORIZON=8 \
  AZ_OUT=ml/data_smoke/az_soft_pi_smoke.jsonl \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept
```

Use this when changing full-command training targets. Inspect the JSONL and confirm
multi-candidate rows include `pi` distributions with more than one nonzero entry.
Soft-target training is experimental; compare it against the current best checkpoint
before promoting it.

Shard-diversity smoke:

```bash
rm -rf ml/data_az_seed_smoke && mkdir -p ml/data_az_seed_smoke
AZ=1 AZ_GAMES=1 AZ_ITERS=2 AZ_HORIZON=4 AZ_SEED0=123456 \
  AZ_OUT=ml/data_az_seed_smoke/az.jsonl \
  ML_META_PATH=ml/data_az_seed_smoke/meta.json \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept
```

Every sharded AlphaZero run must pass unique `AZ_SEED0` values per shard. Do not
trust a long run whose shard logs show identical sample counts, VP averages, and
round counts; that means the run is replaying duplicate games. The current
`ml/discover_meta.sh` and `ml/az_loop.sh` wrappers offset seeds as
`4000000 + iter * 1000000 + shard * 100000`.

AWR/BC data wrappers must derive encoder dimensions from the generated rows. The
current contract is `obs_dim=83`, `act_dim=52`; hard-coding the June 29 `62/52`
contract (or older `55/52`, `55/47`, `48/40` values) poisons training or exports
incompatible checkpoints. The June 29 bump to 62 added damage-class composition
and catalog-aware market features; subsequent encoder revisions brought v1 to 83.

Current damage-contract route-proof reference:

- Candidate: `ml/meta_runs/route-proof-damage-navbuild-unsafe-strict64-hibudget-20260629T195417Z`
- Weights: `ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json`
- Nav specialist: `ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json`
- Gate: `NAV_GATE=unsafe-firepower-build-option`
- Result: 23.83 VP, 96.9% win, 1.6% reach30, 8.78 kills/game, clean status.

This is a comparison baseline, not a promotion. Before treating it as the new
best bot, compare it against the learned-policy league and require a successor
to beat both VP average and finish rate. Do not replace the global policy with
the exported route-finish continuation; the first attempt regressed to 16.94 VP
because it damaged opening/damage assembly.

Rejected finish overlays:

- `route-proof-damage-finishoracle-strict32-hibudget-20260629T201640Z`: hand
  route-finish oracle tied the 32-game control at 22.59 VP and 3.1% reach30.
- `route-proof-damage-routefinish-micro-strict32-hibudget-20260629T052045Z`:
  existing route-finish checkpoint as late micro also tied the control.
- `traceq-damage-nearmiss-vp28-29-20260630T053132Z`: useful data artifact, 32
  exact VP28-29 windows, 9 corrections, 215 samples, +9 reach30 in branch
  comparison.
- `route-proof-damage-nearmiss-specialist-strict32-hibudget-20260630T054651Z`:
  trained near-miss specialist under narrow `route-finish-loop` gate tied
  control.
- `route-proof-damage-nearmiss-specialist-routecloser32-20260630T055729Z`:
  broad `route-closer` / `route-closer-full` gate regressed to 19.91 VP and
  0% reach30 by over-routing to build locations and reducing Abyss farm density.

Direct AlphaZero checkpoint duel:

```bash
AZDUEL=1 AZDUEL_GAMES=12 AZDUEL_ITERS=32 AZDUEL_HORIZON=18 \
  AZDUEL_CONTROL=full AZDUEL_FULL_SELECTION=value \
  AZDUEL_NAMES=champion,candidate \
  AZDUEL_FILES=ml/meta_runs/full-control-extend-g6-20260627T084758Z/best_policy.json,ml/path/to/candidate_policy.json \
  AZDUEL_OUT=ml/meta_runs/azduel-smoke/azduel.json \
  npx vitest run src/lib/play/ml/_azduel.test.ts --disable-console-intercept
```

Use this gate before promoting a checkpoint that looked strong against heuristic
baselines. `AZDUEL` keeps all seats on the AlphaZero/full-command decision path
and assigns checkpoints per seat, so it catches policies that beat the old
baseline field but lose to newer learned policies.

AlphaZero population league matrix:

```bash
AZLEAGUE=1 AZLEAGUE_GAMES=8 AZLEAGUE_ITERS=64 AZLEAGUE_HORIZON=24 \
  AZLEAGUE_CONTROL=full AZLEAGUE_FULL_SELECTION=value \
  AZLEAGUE_NAMES=champion,softpi,softcont,candidate \
  AZLEAGUE_FILES=ml/meta_runs/full-control-extend-g6-20260627T084758Z/best_policy.json,ml/meta_runs/softpi-value-g7-20260627T104341Z/best_policy.json,ml/meta_runs/softpi-continue-g5-20260627T124642Z/best_policy.json,ml/path/to/candidate_policy.json \
  AZLEAGUE_OUT=ml/meta_runs/azleague-candidate/azleague.json \
  npx vitest run src/lib/play/ml/_azleague.test.ts --disable-console-intercept
```

Use this after a candidate wins any broad or focused `AZDUEL`. `AZLEAGUE` runs
all focused pairwise duels through the full-command AlphaZero path and writes
both per-pair results and an Elo-style rating table. Promotion requires the
candidate to lead the population matrix and not lose the focused direct duel
against the previous leader.

Mixed-opponent policy-pool training smoke:

```bash
RUN_ID=policy-pool-smoke \
  INIT_WEIGHTS=ml/meta_runs/softpi-continue-g5-20260627T124642Z/best_policy.json \
  AZ_POLICY_POOL=ml/meta_runs/full-control-extend-g6-20260627T084758Z/best_policy.json,ml/meta_runs/softpi-value-g7-20260627T104341Z/best_policy.json \
  AZ_POLICY_POOL_MIX=1 AZ_CONTROL=full AZ_FULL_SELECTION=value \
  OUTER=1 GAMES=1 SHARDS=1 MCTS=4 HORIZON=8 EPOCHS=1 BATCH=128 META_GAMES=1 META_MCTS=4 \
  bash ml/discover_meta.sh
```

When `AZ_POLICY_POOL` is set, all seats still use the full-command planner path,
but only the rotating learner seat is written to JSONL. This prevents learner
training data from imitating frozen opponent checkpoints. Accept the smoke only if
`data/meta.json` records `plannerSeatMode: "policy-pool"` and
`recordSeatMode: "one-learner"`.

Set `AZ_POLICY_POOL_MIX` below `1` to mix normal all-seat self-play games back
into the same generation pass. For example, `AZ_POLICY_POOL_MIX=0.5` records
roughly half learner-vs-pool games and half all-seat self-play games; the expected
metadata is `recordSeatMode: "mixed-self-and-learner"`.

Controlled strategy-ablation smoke:

```bash
AZMETA=1 AZMETA_GAMES=1 AZMETA_ITERS=4 AZMETA_HORIZON=8 \
  AZMETA_CONTROL=full AZMETA_FORBID_TYPES=initiatePvp AZMETA_MAX_STATUS_LEVEL=0 \
  AZMETA_OUT=ml/meta_runs/pure-smoke/meta.json \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept
```

Use `AZ_FORBID_TYPES` / `AZMETA_FORBID_TYPES` / `AZEVAL_FORBID_TYPES` to remove
command types from planner-seat legal actions. Use `AZ_MAX_STATUS_LEVEL`,
`AZMETA_MAX_STATUS_LEVEL`, or `AZEVAL_MAX_STATUS_LEVEL` to reject planner-seat
actions whose resulting state exceeds a status cap. These are evaluation and
training ablation knobs, not game rules. Always record them with the run id; a
Pure-only or no-PvP result is not comparable to an unrestricted champion unless
the artifact includes `forbidTypes` and `maxStatusLevel`.

Pure AWR/BC bootstrap smoke:

```bash
GEN=1 GEN_MODE=heur GEN_GAMES=2 GEN_SEATS=4 GEN_MAXROUNDS=30 \
  GEN_FIELD=paragon,paragon,paragon,paragon GEN_RECORD_PROFILE=paragon \
  GEN_FORBID=initiatePvp GEN_MAX_STATUS_LEVEL=0 GEN_SHAPING=pure \
  GEN_OUT=ml/data_smoke_pure/pure_heur.jsonl \
  ML_META_PATH=ml/data_smoke_pure/meta.json \
  npx vitest run src/lib/play/ml/_gen.test.ts --disable-console-intercept

ml/.venv/bin/python ml/train.py \
  --data ml/data_smoke_pure \
  --out ml/weights/pure-smoke.json \
  --epochs 1 --batch-size 128 --mode awr
```

Evaluate AWR/BC checkpoints with a selector matrix, not only `value`. `policy`
tests the learned imitation head, `hybrid` adds tactical VP grabs, and `value`
tests whether the value head can drive full-control play by itself.

## Browser Testing Criteria

Use the Browser plugin for human-visible app verification when work touches UI, dashboards, routing, auth-adjacent flows, multiplayer screens, or data visualizations.

Browser acceptance means:

- The app opens from a real browser session at the tested URL.
- There are no hydration errors, uncaught exceptions, broken network calls, or console errors caused by the change.
- The primary user path still works, not just the first screen.
- Layout holds at desktop and mobile widths.
- Text is readable and not overlapping.
- For dashboards, tables/charts render real data or an intentional empty state; filters, tabs, and run selectors do not crash.
- For bot-development dashboard pages, at least one run can be selected and the page shows run id, patch id, bot/checkpoint identity, win/VP metrics, and source artifact paths.

Local Browser flow:

```bash
npm run dev -- --host 127.0.0.1
```

Then open `http://127.0.0.1:5173` with Browser and verify the relevant route. If the flow is automatable, also run:

```bash
npm run test:bot:browser
```

The packaged Browser gate currently runs:

- `e2e/play-p0.spec.ts`: creates a two-player room through the play API, seeds each
  Browser context with its own room-member cookie, locks both navigation choices,
  verifies one player cannot reveal destinations early, force-advances to round 2,
  then reopens both clients and checks both the server projection and visible
  navigation UI.
- `e2e/mobile-perf-smoke.spec.ts`: verifies the play landing route hydrates on a
  mobile viewport and that the splat quality setting toggles/persists.

Remote Browser flow for the SimForge GPU box:

```bash
ssh -N -L 5173:127.0.0.1:5173 ubuntu@216.151.21.122
```

In a separate SSH session on the box:

```bash
cd /data/share8/michaelvuaprilexperimentation/arc-bot
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173` locally with Browser. The Browser is local; the app is remote through the SSH tunnel.

## SimForge GPU Box Runbook

Host: `ubuntu@216.151.21.122`

Expected hostname: `simforge1`

Arc bot workspace: `/data/share8/michaelvuaprilexperimentation/arc-bot`

Preflight:

```bash
npm run bot:gpu:preflight
```

GPU allocation rule:

- Use GPUs `0-3` for Arc bot/Alpha work after checking they are free enough for the intended run.
- GPUs `4-7` may be used for Arc bot/Alpha work only when the user explicitly reassigns them for the session. Check available memory with `nvidia-smi` first, set `CUDA_VISIBLE_DEVICES` to the chosen subset, and do not exceed the remaining free memory.
- Do not stop Docker containers outside the arc bot workspace as part of bot testing.

Refreshing the remote workspace from local source is allowed for this repo. Prefer rsync over hand-editing remote files:

```bash
npm run bot:gpu:sync
```

The GPU runner scripts now sync `ml/meta_runs/<RUN_ID>` back even when the
remote job exits nonzero after producing useful artifacts. This is intentional:
sample-count refusals, imitation-gate failures, and timeout partials are often
the evidence needed for the next diagnosis. The scripts still return the remote
failure status after syncing, so CI and manual runs do not silently pass.

If generated files are stale and the user has approved clearing the arc bot workspace, clear only generated artifacts:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  rm -rf .svelte-kit build node_modules/.vite ml/data ml/data_az ml/logs ml/meta_runs
'
```

Set up dependencies:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  npm ci
  python3 -m venv ml/.venv
  ml/.venv/bin/pip install -r ml/requirements.txt
  npx playwright install chromium
'
```

Remote smoke run:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=0 RUN_ID=smoke OUTER=1 GAMES=1 SHARDS=1 MCTS=4 EPOCHS=1 META_GAMES=1 META_MCTS=4 \
    bash ml/discover_meta.sh
'
```

Auxiliary-head remote smoke uses the same launcher with opt-in coefficients:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=0 RUN_ID=aux-smoke OUTER=1 GAMES=1 SHARDS=1 MCTS=4 \
    EPOCHS=1 META_GAMES=1 META_MCTS=4 \
    FARM_VALUE_COEF=0.25 REWARD_PICK_COEF=0.25 \
    bash ml/discover_meta.sh
'
```

After syncing to the remote workspace, also run a cheap source sanity check before
long training:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  npm run check
  npx vitest run src/lib/play/bots/contract.test.ts --disable-console-intercept
'
```

Remote medium run after smoke passes:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=0 RUN_ID=agent-$(date -u +%Y%m%dT%H%M%SZ) \
    OUTER=3 GAMES=40 SHARDS=8 MCTS=32 EPOCHS=3 META_GAMES=8 META_MCTS=16 \
    FARM_VALUE_COEF=0.25 REWARD_PICK_COEF=0.25 \
    bash ml/discover_meta.sh
'
```

## Current Meta Evidence

As of the June 27, 2026 GPU pass, the meta is not solved. The strongest current
learned-vs-learned checkpoint is:

```text
ml/meta_runs/softpi-continue-g5-20260627T124642Z/best_policy.json
```

It won the top-three direct AlphaZero duel, but it did not dominate every gate.
Treat it as the current league leader, not a final champion.

Current unrestricted comparison:

| Checkpoint        | Gate artifact                                                 | Deterministic meta VP | Sampled meta VP | Arena win | Arena VP | Direct AZ duel win           |
| ----------------- | ------------------------------------------------------------- | --------------------- | --------------- | --------- | -------- | ---------------------------- |
| champion          | `full-control-final-eval-20260627T093347Z/summary.json`       | 9.21                  | 5.85            | 75.0%     | 19.05    | 14.6%                        |
| softpi            | `softpi-full-gate-20260627T120901Z/summary.json`              | 9.31                  | 5.11            | 82.5%     | 16.88    | 16.7%                        |
| softpi-continued  | `softpi-continue-full-gate-20260627T125749Z/summary.json`     | 7.78                  | 4.67            | 82.5%     | 19.63    | 43.8%                        |
| policy-pool best  | `policy-pool-g7-20260627T134916Z/best_meta.json`              | 8.73                  | n/a             | 87.5%     | 18.88    | 27.5%                        |
| pool conservative | `policy-pool-conservative-g6-20260627T141543Z/best_meta.json` | 7.98                  | n/a             | 87.5%     | 20.00    | n/a                          |
| pool/self mix     | `policy-pool-mix-g6-20260627T142617Z/best_meta.json`          | 9.13                  | n/a             | 75.0%     | 16.81    | 40.0% four-way; lost focused |

Direct duel artifact:

```text
ml/meta_runs/azduel-top3-20260627T132940Z/azduel.json
```

Top-three direct duel result: `softpi-continued` won 43.8% of seat-games with
11.27 avg VP and 1.79 avg place; `softpi` won 16.7%; the previous champion won
14.6%. The focused champion-vs-softpi duel also showed `softpi` beating the
previous champion 30.0% to 20.0%.

Policy-pool lane result: `policy-pool-g7-20260627T134916Z` trained one learner
seat against frozen `champion`, `softpi`, and `softpi-continued` seats. Its best
checkpoint improved over `softpi` and `champion` in the four-way direct duel, but
did not beat `softpi-continued`: `softcont` 37.5%, `policy-pool best` 27.5%,
`softpi` 20.0%, `champion` 15.0%. Later policy-pool iterations overfit/regressed
despite lower training loss. A conservative one-step lower-LR pool update also
failed to improve meta strength. Conclusion: policy-pool training is useful
infrastructure, but it is not yet a promotion path.

Mixed pool/self-play lane result: `policy-pool-mix-g6-20260627T142617Z` used
`AZ_POLICY_POOL_MIX=0.5`, producing 74,264 samples from a mix of frozen-pool games
and normal all-seat self-play. It improved deterministic meta to 9.13 VP / 14.55
meta score and won the first four-way direct duel at 40.0%, narrowly over
`softpi-continued` at 35.0%. A focused 60-game duel then reversed that signal:
`softpi-continued` beat `mix` 27.5% to 22.5% with higher VP. Conclusion:
mixed-objective training is promising, but `softpi-continued` remains the learned
leader until a candidate wins both broad and focused direct duels.

Population league matrix:

```text
ml/meta_runs/azleague-top5-20260627T150358Z/azleague.json
```

This matrix ran 10 focused pairwise matchups, 8 games per pair, across
`champion`, `softpi`, `softpi-continued`, `policy-pool best`, and `pool/self mix`.
Rating result:

| Rank | Checkpoint       | Elo  | Team VP win | Avg VP | Notes                                                            |
| ---- | ---------------- | ---- | ----------- | ------ | ---------------------------------------------------------------- |
| 1    | softpi-continued | 1074 | 65.6%       | 8.92   | Beat champion, poolbest, and mix; split softpi in the small pair |
| 2    | softpi           | 999  | 48.4%       | 9.16   | Beat champion, edged mix, lost to poolbest                       |
| 3    | pool/self mix    | 996  | 50.0%       | 9.16   | Beat champion, lost to softcont, close with softpi/poolbest      |
| 4    | policy-pool best | 987  | 50.0%       | 9.33   | Countered softpi, lost hard to softcont                          |
| 5    | champion         | 944  | 35.9%       | 6.69   | Clearly below newer learned checkpoints                          |

Interpretation: `softpi-continued` is the current population leader, but the
counter-matchups below it mean the meta is not mathematically solved. The next
candidate must beat `softpi-continued` in both a focused duel and the population
league matrix.

Ablation comparison points:

- no-PvP fast probe (`forbidTypes=["initiatePvp"]`): meta avg VP 7.25, arena win
  50%, planner VP 12.83, avg status 2.08, still `fallen-corruption`;
- Pure-only fast probe (`forbidTypes=["initiatePvp"]`, `maxStatusLevel=0`): meta
  avg VP 6.50, arena win 8.3%, planner VP 4.67, strategy `abyss-monster-farm`;
- Pure-only one-iteration training from champion:
  `pure-only-train-g6-20260627T113226Z`, meta avg VP 5.98, arena win 6.3%,
  planner VP 2.81.

Interpretation: the current discovered strategy family still depends on
high-status fallen/corruption pressure. Removing only PvP is insufficient because
monster/combat lines can still drive corruption. Forcing Pure-only play currently
collapses competitive performance. The newer soft-target continuation is a real
counter to the previous champion in learned-policy duels, but its deterministic
and sampled meta scores are weaker, so promotion needs a league/mixed-opponent
training lane before calling the meta stable.

June 27, 2026 Abyss sanity and Act52 findings:

- Fresh heuristic VP-source audit (`VPSRC=1`, 8 games, 4p):
  `pvphunter` averaged 28.1 VP, with 17.63 VP/game from `initiatePvp` and
  10.50 from monster rewards; `godly` averaged 8.63 monster-reward VP;
  `medium` averaged 6.75; `cultivator` averaged 5.63.
- Deterministic blind Abyss route (`ABYSSROUTE=1`, 8 games, 4p) averaged
  3.47 VP with 0 injected arcane dice, 6.72 VP with 1 die, and 7.38 VP with
  2 dice. All variants ended at average status 3 around round 5-6, so blind
  early fighting is not a 30-round farm baseline.
- Fresh full-control Act52 training run on SimForge:
  `ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json`
  (`obs_dim=55`, `act_dim=52`). Strict eval suite
  `ml/meta_runs/act52-full-g6-20260627T181633Z-eval32/summary.json` returned
  `verdict=not-yet`: deterministic meta 10.28 VP / 6.3% reach30 / status 2.66
  (`fallen-corruption`), sampled meta 4.44 VP / status 1.56, and heuristic-field
  arena 33.3% win / 7.83 VP / status 1.42.
- The same Act52 checkpoint can exploit forced Abyss only by corrupting:
  forced-Abyss value selection scored 15.38 VP with 5.25 kills/game and status
  3.00; Pure forced-Abyss value selection scored 2.25 VP with 0.75 kills/game
  and status 0.00.
- Full-command `lookahead` selection is a useful short-term selector but not a
  solved meta. With the same Act52 checkpoint, mixed-field lookahead scored
  75.0% win / 12.88 VP / 4.38 kills/game, but status was still 1.75. All-planner
  lookahead meta scored only 5.44 VP at status 0.69.
- Pure constrained lookahead self-play did not solve the clean line:
  `ml/meta_runs/act52-pure-lookahead-g5-20260627T182701Z` trained two
  iterations with `AZ_FORBID_TYPES=initiatePvp` and `AZ_MAX_STATUS_LEVEL=0`.
  Both meta iterations scored 0 VP, 0 Abyss navigations, 0 combats, and 0 kills.
  This rules out "just run the Pure constrained lane longer" as the next
  high-leverage step.

Scoring clarification: `startCombat` itself grants 0 VP; a kill creates
`pendingReward`, and VP lands only after `resolveMonsterReward`. One-ply value
selection must therefore credit claimable pending-reward VP, or it can undervalue
the combat action that creates the reward.

June 27, 2026 owner-question recovery check:

- Fresh forced-route probe for the exact "early Spirit Animal + Arcane Abyss"
  question:

  ```bash
  ABYSSROUTE=1 ABYSSROUTE_GAMES=4 ABYSSROUTE_SEATS=4 \
    ABYSSROUTE_DICE_COUNTS=0 ABYSSROUTE_SPIRIT_ANIMALS=0,1,2 \
    ABYSSROUTE_OUT=ml/abyssroute_user_question_smoke.json \
    npx vitest run src/lib/play/ml/_abyssroute.test.ts --disable-console-intercept
  ```

  Results: 0 Spirit Animal scored 3.38 VP, 1 Spirit Animal scored 4.69 VP,
  and 2 Spirit Animal scored 3.56 VP. All ended at average status 3 around
  round 6. Reward labels were only `2 Victory Points` and `1 Victory Point`
  in this slice. Under current rules, one or two Spirit Animal traits do not
  make a 15 VP early-Abyss line by themselves.

- The same reducer supports the high-scoring line when the build exists:
  `10x arcane dice + 2 Spirit Animal + 20 max barrier` scored 31.19 VP with
  8.25 kills/seat-game in 10 rounds. This separates "engine cannot score" from
  "bot cannot build/time the line."
- `AZ*_MICRO_GATE=abyss-farm-overlay` is now available. It lets the main policy
  choose normally, then allows the micro policy to override only for concrete
  Abyss payoff actions: reward claims with claimable VP or killing combats that
  create pending reward VP. This is safer than `abyss-farm-actions`, which can
  force farm actions too early.
- Initial overlay check:
  `ml/split_overlay_act52_nav_micro_value_eval12_i16.json` matched the Act52
  baseline at 50.0% win / 20.67 VP / 33.3% reach30 / status 2.75, and
  `ml/split_overlay_act52_nav_micro_meta6.json` still scored only 6.67 VP /
  4.2% reach30 in all-planner meta. Verdict: overlay is valid instrumentation,
  not a promotion candidate.
- Do not launch long GPU loops until a normal-start clean-farm oracle or
  reachable-prefix curriculum proves that a bot can reliably build damage,
  max barrier, and Spirit Animal before committing to the Abyss farm.

Evaluation safety clarification: `_azmeta`, `_azeval`, `_azduel`, and
`_azleague` must load explicit checkpoints strictly. Missing or stale
`obs_dim`/`act_dim` weights must fail the run, not fall back to random weights.
Random bootstrap is allowed for `_azgen` data generation only.

Remote full-command medium run:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=6 RUN_ID=full-control-$(date -u +%Y%m%dT%H%M%SZ) \
    INIT_WEIGHTS=ml/weights/policy.json \
    AZ_CONTROL=full AZ_FULL_SELECTION=value \
    OUTER=2 GAMES=32 SHARDS=8 MCTS=32 HORIZON=18 EPOCHS=3 BATCH=1024 \
    META_GAMES=8 META_MCTS=32 \
    bash ml/discover_meta.sh
'
```

Remote sequence-lookahead probe:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=4 RUN_ID=lookahead-probe-$(date -u +%Y%m%dT%H%M%SZ) \
    INIT_WEIGHTS=ml/meta_runs/full-control-extend-g6-20260627T084758Z/best_policy.json \
    AZ_CONTROL=full AZ_FULL_SELECTION=lookahead \
    AZ_FULL_LOOKAHEAD_DEPTH=1 AZ_FULL_LOOKAHEAD_BEAM=4 AZ_FULL_LOOKAHEAD_ROOT_BEAM=12 \
    OUTER=1 GAMES=16 SHARDS=4 MCTS=16 HORIZON=12 EPOCHS=1 BATCH=512 META_GAMES=4 META_MCTS=16 \
    bash ml/discover_meta.sh
'
```

Full current-checkpoint meta evaluation:

```bash
RUN_ID=meta-eval-$(date -u +%Y%m%dT%H%M%SZ) \
  WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  META_GPU=6 SAMPLED_GPU=6 ARENA_GPU=7 \
  npm run bot:meta:evaluate
```

`scripts/run-arc-meta-eval-suite.sh` defaults to
`ml/weights/policy-smoke.json` only so an accidental smoke run does not crash on
the stale Act47 `ml/weights/policy.json`. Any serious promotion run must pass the
candidate `WEIGHTS=` explicitly and must report `weight_dims.act_dim` matching
the current encoder.

Current Act52 full-suite baseline, copied locally from the SimForge GPU box:
`ml/meta_runs/act52-current-meta-eval-20260627T210828Z/summary.json`.

| Gate                           | Result                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| Deterministic all-planner meta | 7.93 VP, 0% reach30, status 3.00, `fallen-corruption`        |
| Sampled all-planner meta       | 4.11 VP, 0% reach30, status 1.98, `cursed-spirit-corruption` |
| Heuristic-field arena          | 75.0% win, 19.68 VP, status 2.85                             |
| Forced Abyss                   | 70.8% win, 13.25 VP, status 2.96                             |
| Pure forced Abyss              | 4.2% win, 2.88 VP, status 0.00                               |

Verdict: `not-yet`. This checkpoint can beat fixed heuristic opponents via a
corruption-heavy route, but it does not solve normal-start all-planner play and
does not execute a clean Pure Abyss route. Use it as a baseline for the next
population + curriculum + auxiliary-head lane, not as a promotion candidate.

Split/overlay checkpoint evaluation:

```bash
RUN_ID=meta-eval-overlay-$(date -u +%Y%m%dT%H%M%SZ) \
  WEIGHTS=ml/meta_runs/act52-full-g6-20260627T181633Z/best_policy.json \
  MICRO_WEIGHTS=ml/weights/act52-abyss-micro-policyonly.json \
  MICRO_GATE=abyss-farm-overlay \
  META_GPU=6 SAMPLED_GPU=6 ARENA_GPU=7 \
  npm run bot:meta:evaluate
```

This writes:

- `ml/meta_runs/$RUN_ID/meta/policy_meta.json`
- `ml/meta_runs/$RUN_ID/meta/policy_meta_sampled.json`
- `ml/meta_runs/$RUN_ID/arena/policy_vs_heuristic_field.json`
- `ml/meta_runs/$RUN_ID/summary.json`

A100-sized run only after the medium run is clean:

```bash
ssh ubuntu@216.151.21.122 '
  cd /data/share8/michaelvuaprilexperimentation/arc-bot
  CUDA_VISIBLE_DEVICES=0 RUN_ID=full-$(date -u +%Y%m%dT%H%M%SZ) \
    OUTER=20 GAMES=400 SHARDS=12 MCTS=200 META_GAMES=48 \
    bash ml/discover_meta.sh
'
```

June 30, 2026 PvP-pivot check:

- Strict Pure finish-navigation oracle A/B:
  `ml/meta_runs/route-proof-damage-finishnavoracle-strict32-hibudget-20260630T061223Z/summary.json`.
  It scored 22.66 VP, 93.8% win, 12.5% reach30, 8.25 kills/game, and status 0.
  This improves reach30 but loses average VP to the current strict baseline
  `route-proof-damage-navbuild-unsafe-strict64-hibudget-20260629T195417Z`
  at 23.83 VP, so do not promote the finish-navigation oracle.
- Unrestricted lookahead arena:
  `ml/meta_runs/meta-pivot-lookahead-20260630T062300Z/azeval-unrestricted.json`.
  It scored 18.88 VP, 93.8% win, 6.3% reach30, status avg 0.47/max 3,
  6.69 kills/game, 19.25 Abyss navs/game, and **0.00 PvP attacks / 0.00 PvP
  VP per game**.
- Unrestricted hybrid arena:
  `ml/meta_runs/meta-pivot-hybrid-20260630T063251Z/azeval-unrestricted-hybrid.json`.
  It scored 8.78 VP, 43.8% win, 0% reach30, status avg 2.78/max 3,
  2.97 kills/game, 22.97 Abyss navs/game, and again **0.00 PvP attacks /
  0.00 PvP VP per game**.

Interpretation: the current 62/52 candidate can execute parts of the clean
Abyss route, but it does **not** perform the intended farm-to-player pivot.
Even when PvP and corruption are unrestricted, the planner mostly stays in
Arcane Abyss, where PvP is illegal, instead of becoming Evil/Fallen and meeting
Good players at non-Abyss locations. A promoted meta bot must therefore report
nonzero `planner_pvp_attacks_per_game` and `planner_pvp_vp_per_game` in an
unrestricted arena, plus a trace showing the pivot happens after monster EV
drops rather than as blind early corruption.

Follow-up PvP opportunity audit:

- `ml/meta_runs/pvp-opportunity-lookahead-20260630T063924Z/azeval-pvp-opportunity.json`
  added explicit legal-PvP-window counters. Result: 19.38 VP, 6.3% reach30,
  max status 3, but **0.00 legal PvP opportunities/game**. The issue is not
  choosing `passEncounter` over `initiatePvp`; the planner never creates a legal
  PvP state.
- `ml/meta_runs/pvp-pivot-oracle-fallenhunt-20260630T064718Z/azeval-pvp-pivot-oracle.json`
  forced a Spirit World hunt destination after Fallen. Result matched the
  opportunity audit, with `planner_pvp_pivot_oracle_uses_per_game = 0.00`.
  Trace inspection showed the only Fallen high-tail game became Fallen in the
  round-19 location phase while already reaching 30 VP, leaving no later
  navigation phase to hunt.
- `ml/meta_runs/pvp-curriculum-pvphunter-bc-20260630T065341Z` generated 6,435
  `pvphunter` imitation samples and trained a warm-start PvP specialist. Eval
  collapsed to 0.56 VP, 0% win, 0.19 kills/game, and 0.00 legal PvP
  opportunities/game. It overlearned Tidal Cove/summon setup and never converted.
- `ml/meta_runs/pvp-mix-route-pvphunter-bc-20260630T065655Z` mixed the current
  damage-contract route data with four copies of the PvP imitation lane
  (54,722 samples total). Eval still collapsed to 6.31 VP, 0% reach30, and
  0.00 legal PvP opportunities/game.
- `ml/meta_runs/pvp-pivot-focused-mix-20260630T071003Z` generated a targeted
  PvP-pivot curriculum (2,351 focused samples: class setup, descend navigation,
  descend combat, hunt navigation, and `initiatePvp`) and mixed it with the
  current route data. The trained specialist still collapsed as a global policy:
  8.25 VP, 0% reach30, status avg 0.88/max 2, and 0.00 legal PvP
  opportunities/game.
- Gating that focused specialist as a `pvp-pivot` navigation and micro overlay
  created the first real PvP windows but underperformed:
  `ml/meta_runs/pvp-pivot-gated-overlay-20260630T072135Z/azeval-pvp-overlay.json`
  scored 18.88 VP, 0% reach30, 0.19 attacks/game, and only 0.56 immediate
  PvP VP/game. Trace inspection showed the bot often learned Lantern Canyon
  corruption/setup fragments instead of a clean late farm-to-hunt pivot.
- A harness bug was fixed after this: `_azeval.test.ts` parsed
  `AZEVAL_PVP_PIVOT_ORACLE` but did not pass it into `playPlannerSelfPlayGame`,
  and the PvP VP counter only measured immediate command deltas instead of
  resolved group PvP combats. The metric now credits +3 VP once per resolved PvP
  combat to each Evil planner side.
- Corrected oracle/metric confirmation:
  `ml/meta_runs/pvp-pivot-oracle-metricfix-20260630T074334Z/azeval-pvp-oracle.json`
  ran 8 games with Fallen hunt forced after status 3. It scored 20.63 VP,
  0% reach30, 7.13 kills/game, `planner_pvp_pivot_oracle_uses_per_game=6.25`,
  `planner_pvp_attacks_per_game=0.50`, and
  `planner_pvp_vp_per_game=1.50`. This proves the PvP route can add points, but
  the current bot is creating too few resolved attack chains and still misses too
  much clean farm (`planner_missed_farmable_nav_pct=43.5%` in this diagnostic).
- Tightening the learned `pvp-pivot` gate to protect clean farm fixed the
  over-trigger but removed the pivot:
  `ml/meta_runs/pvp-pivot-lategate-overlay-20260630T074928Z/azeval-pvp-lategate.json`
  scored 18.88 VP, 0% reach30, status avg 0.63/max 2, **0% missed farm**, and
  0.00 PvP attacks/VP. This is safer but too conservative.
- The strongest new diagnostic is the explicit late-descend oracle:
  `AZEVAL_PVP_PIVOT_ORACLE=late-descend-hunt`. It preserves clean farming while
  forcing Arcane Abyss descent once VP is high, HP4+ is reached, and current
  farm EV is low. The 8-game smoke
  `ml/meta_runs/pvp-pivot-latedescend-oracle-20260630T075351Z/azeval-pvp-latedescend.json`
  scored 23.38 VP with 50.0% reach30. The 16-game proof
  `ml/meta_runs/pvp-pivot-latedescend-oracle-16g-20260630T075721Z/azeval-pvp-latedescend.json`
  scored 23.75 VP, 93.8% win, 43.8% reach30, 8.88 kills/game, status avg
  1.75/max 3, 0% missed farm, and only 0.19 PvP VP/game. Interpretation: the
  promising route is not yet player-attacking; it is late corruption/descent
  through the monster wall while preserving early clean multi-life farm.
- A 32-game teacher-data run
  `ml/meta_runs/latedescend-teacher-data-20260630T080701Z/azeval-latedescend.json`
  scored 21.63 VP, 31.3% reach30, 7.91 kills/game, 0% missed farm, and exported
  1,000 success/near route samples. Filtering to pure navigation choices yielded
  167 weighted nav samples; training from `nav_build_policy.json` reached 86.8%
  top-1 on that tiny teacher set.
- The first learned late-descend nav overlay did **not** reproduce the oracle:
  `ml/meta_runs/latedescend-navpolicy-eval-20260630T081934Z/azeval-latedescend-nav.json`
  scored 19.56 VP, 12.5% reach30, status avg 0.38/max 2, 6.88 kills/game,
  20.00 Abyss navs/game, 0.00 PvP VP, and 0% missed farm. Interpretation: the
  positive-only nav teacher overgeneralized "go Abyss" and starved build/dice
  assembly. The next learned version needs negative/contrast labels for late
  states where the correct move is still Lantern/Cultivate or other build/restore,
  not just high-tail positive labels.
- Adding a simple firepower-readiness guard to the learned `pvp-pivot` gate did
  not change the learned overlay result:
  `ml/meta_runs/latedescend-navpolicy-firegate-eval-20260630T082820Z/azeval-latedescend-nav.json`
  matched exactly at 19.56 VP, 12.5% reach30, 20.00 Abyss navs/game, and 1.94
  max dice/game. This means the overtrigger is not fixed by a scalar firepower
  threshold; it needs explicit negative labels or a richer gate.
- A quick contrast rebalance duplicated non-Abyss nav labels from the teacher set
  (`Lantern Canyon` and `Floral Patch`) and trained
  `latedescend_nav_balanced_policy.json` to 94.0% top-1. Eval
  `ml/meta_runs/latedescend-navbalanced-eval-20260630T083726Z/azeval-latedescend-nav.json`
  improved only trivially to 19.75 VP and 12.5% reach30, with 19.94 Abyss
  navs/game and only 2.00 max dice/game. Simple destination balancing is not
  enough; the contrast must be state-conditioned.
- The PvP-pivot curriculum was expanded into a state-conditioned farm/build/
  pivot collector: cheap farm labels preserve low-rung Abyss VP, build labels
  prevent underpowered Abyss overtrigger, descend labels teach late corruption,
  and `initiatePvp` labels still grab legal player attacks. The first 64-game
  run `ml/meta_runs/pvp-pivot-contrast-curriculum-20260630T085054Z` produced
  2,223 samples: 197 farm-nav, 530 build-nav, 212 descend-nav, 228 descend-
  combat, 556 hunt-nav, and 417 PvP-attack labels. As a learned gated overlay it
  scored 20.69 VP, 13% reach30, 7.63 kills/game, and 0.75 PvP VP/game; it
  overlearned speculative hunt fallback, mostly `Floral Patch`, and regressed.
- `pvp-pivot` was then tightened to mean "visible Good target outside Abyss"
  instead of speculative Spirit World wandering. With the same dynamic-hunt
  overlay and the visible-target gate, the 16-game proof
  `ml/meta_runs/pvp-pivot-dynamic-hunt-curriculum-20260630T085900Z/azeval-pvp-visibletarget-gate-16g.json`
  reached 23.88 VP, 93.8% win, 38% reach30, 9.56 kills/game, 0 missed farm, and
  only 1.06 `Floral Patch` navs/game. It recorded 0 legal PvP windows and 0 PvP
  VP in this weak heuristic field, so the current reliable gain is late
  monster/corruption conversion, not player attacking. The player-attack branch
  should remain opportunistic until a neural-field arena can show high-scoring
  Good opponents creating visible non-Abyss targets.
- A neural-field arena mode was added to `_azeval.test.ts` so all seats can be
  planner-controlled while the target keeps target-only overlays and opponents
  can be capped below Fallen. The first Good-capped neural-field control
  (`ml/meta_runs/neural-field-pvp-goodcap-20260630T092500Z/azeval-neural-field-goodcap.json`)
  scored only 6.00 target VP and 8.13 best-opponent VP, with 0 legal PvP
  windows. A stronger heuristic-field control
  (`ml/meta_runs/heuristic-strongfield-pvp-20260630T093000Z/azeval-strong-heuristic-field.json`)
  scored 23.38 target VP but still produced 0 legal PvP windows. Current fields
  therefore do not yet contain the "strong Good player outside Abyss" opponent
  needed to test player attacks as a reliable meta source.
- The visible-target learned route is now the current unrestricted non-oracle
  leader. The 64-game proof
  `ml/meta_runs/visible-target-route-proof-64g-20260630T093600Z/azeval-visible-target-route-proof-64g.json`
  reached 26.06 VP, 95.3% win, 54.7% reach30, 10.75 monster kills/game, status
  avg 2.72/max 3, 0% missed farm, and 0 PvP opportunities/VP. This is a major
  improvement over the previous 23.83-ish ceiling, but not a solved meta:
  low-tail games still land below 20 VP and the scoring source is almost
  entirely monster/corruption conversion.
- Low-tail trace capture for the visible-target leader
  (`ml/meta_runs/visible-target-lowtail-trace-20260630T095800Z/visible-target-lowtail.trace.json`)
  captured 6 low games from a 16-game rerun: VP 15/16/19/6/12/23. Four of them
  navigated to Arcane Abyss all 30 rounds, but only converted 2-7 monster kills.
  The traces show repeated Abyss navigation after `cleanKillProb=0` and farm EV
  0, plus full-action churn that can discard firepower/Spirit Animals. The next
  improvement should target low-tail full-action discipline and restore/build
  timing, not the high-tail route.
- Three obvious patch combinations were rejected:
  `visible-target-navbuild-combo-20260630T100700Z` added the old broad
  `nav_build_policy` / `unsafe-firepower-build-option` layer and regressed to
  20.50 VP / 12.5% reach30; `visible-target-hp2restore-combo-20260630T101500Z`
  narrowed that to `hp2-survival-deficit` and still regressed to 23.69 VP /
  31.3% reach30; `visible-target-preserveguards-20260630T102200Z` enabled
  firepower/survival preservation guards and regressed to 20.13 VP / 31.3%
  reach30. Do not promote these layers over the 26.06 leader.
- `AZEVAL_ABYSS_ROUTE_DISCIPLINE=1` was added as a diagnostic full-action guard:
  it forces clean immediate Abyss payoff actions and blocks voluntary cleanup
  discards that reduce Spirit Animal / firepower during an active Abyss route.
  The matched 16-game proof
  `ml/meta_runs/visible-target-abyss-discipline-20260630T103000Z/azeval-visible-target-abyss-discipline-16g.json`
  scored 23.50 VP, 31.3% reach30, 9.44 kills/game, 1.7% missed clean-combat
  opportunities, and 0 PvP attacks. This is below the matched no-discipline
  low-tail baseline at 23.88 VP, so keep the flag off by default and do not
  promote it. The result reinforces that player-attacking still needs a
  neural-field/league test with strong Good targets; the current heuristic field
  produced no visible legal PvP windows.
- `AZEVAL_PVP_PIVOT_ORACLE=late-descend-predictive-hunt` was added to test the
  actual player-attack pivot under hidden simultaneous navigation. It predicts
  likely Good-player Spirit World destinations from public state, instead of
  waiting for visible locked destinations that are not public during navigation.
  The oracle is promising but rejected as a default: the 16-game proof
  `ml/meta_runs/pvp-predictive-hunt-tight-20260630T104500Z/azeval-pvp-predictive-hunt-tight-16g.json`
  scored 24.31 VP and 1.31 PvP VP/game, beating the matched 16-game baseline
  of 23.88 VP; the equal-size 64-game proof
  `ml/meta_runs/pvp-predictive-hunt-tight-64g-20260630T105500Z/azeval-pvp-predictive-hunt-tight-64g.json`
  scored 25.31 VP, 40.6% reach30, and 1.78 PvP VP/game, below the 26.06 VP /
  54.7% reach30 leader. The pivot is real, but it needs learned timing and target
  selection that preserves monster kill density.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-pivot` plus the learned checkpoint
  `ml/meta_runs/pvp-predictive-curriculum-20260630T111500Z/pvp_predictive_hunt_policy.json`
  was the previous unrestricted champion. The curriculum shard generated 3,989 labels
  including 691 predictive-hunt nav and 838 PvP-attack labels, then warm-started
  from the visible-target dynamic-hunt overlay. The 64-game proof
  `ml/meta_runs/pvp-predictive-learned-64g-20260630T113500Z/azeval-pvp-predictive-learned-64g.json`
  scored 26.86 VP, 96.9% win, 51.6% reach30, 9.64 monster kills/game, 0.97 PvP
  attacks/game, and 2.91 PvP VP/game. This beats the previous 26.06 VP leader
  and proves the intended monster-farm-to-player-attack pivot is useful. Do not
  call the meta solved yet: reach30 and monster kills both fell, so the next
  promotion must keep PvP VP while recovering finish density.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-finish-pivot` was added as an
  experimental stricter gate and rejected. The 16-game probe
  `ml/meta_runs/pvp-predictive-finishgate-eval-20260630T113952Z/azeval-pvp-predictive-finishgate-16g.json`
  scored 23.88 VP, 13% reach30, 9.25 monster kills/game, 0.19 PvP attacks/game,
  and 0.56 PvP VP/game. This confirms that player attacks should not be reserved
  only for final closeouts. Because encounter PvP gives a Fallen attacker +3 VP
  for attacking co-located Good players, the next promotion gate must compare
  current monster-farm value against that repeatable +3 VP action.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-value-pivot` was tested and rejected:
  `ml/meta_runs/pvp-predictive-valuegate-eval-20260630T114914Z/azeval-pvp-predictive-valuegate-16g.json`
  scored 24.75 VP, 25% reach30, 8.56 monster kills/game, and 2.81 PvP VP/game.
  It preserved player-attack VP but damaged the monster route.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-flex-pivot` was tested with the old
  predictive checkpoint and rejected as a promotion:
  `ml/meta_runs/pvp-predictive-flexgate-eval-20260630T115544Z/azeval-pvp-predictive-flexgate-16g.json`
  scored 26.44 VP, 63% reach30, 9.50 monster kills/game, and 2.63 PvP VP/game,
  just below the matched 26.63 VP broad-pivot proof.
- `PVPPIVOTCURRICULUM_CONTRAST_FARM_RETURN=1` now generates explicit
  `pvp-farm-return-nav` contrast labels. The 128-game shard
  `ml/meta_runs/pvp-contrast-curriculum-20260630T120258Z` produced 4,194 samples
  with 302 farm-return, 713 predictive-hunt, and 719 PvP-attack labels. The
  trained `pvp_contrast_flex_policy.json` is not promoted: the flex eval
  `ml/meta_runs/pvp-contrast-flex-eval-20260630T120258Z/azeval-pvp-contrast-flex-16g.json`
  scored 26.50 VP with strong monster stats but only 1.50 PvP VP/game, and the
  old-micro hybrid scored 26.25 VP.
- Early-stopped contrast training is also rejected. The 12-epoch checkpoint
  `ml/meta_runs/pvp-contrast-earlystop-20260630T121746Z/pvp_contrast_flex_policy_e12.json`
  evaluated at
  `ml/meta_runs/pvp-contrast-earlystop-e12-eval-20260630T121746Z/azeval-pvp-contrast-e12-flex-16g.json`
  scored 25.88 VP with 10.50 monster kills/game, 23.75 Abyss navs/game, and 0.00
  PvP attacks/VP per game. Do not spend more full-control eval time on longer
  single-head contrast checkpoints unless the policy architecture changes.
- Current champion plus `PATCH2_NAV_GATE=route-finish-loop` is rejected as a
  non-improvement. The probe
  `ml/meta_runs/pvp-predictive-routefinish-composite-eval-20260630T121746Z/azeval-pvp-predictive-routefinish-composite-16g.json`
  exactly matched the broad 16-game proof at 26.63 VP, 63% reach30, 9.50 monster
  kills/game, and 2.81 PvP VP/game.
- Mixed original predictive PvP data plus contrast data is rejected as another
  single-head route policy. The dataset
  `ml/meta_runs/pvp-mixed-contrast-20260630T123135Z` has 8,183 samples, but the
  24-epoch checkpoint
  `ml/meta_runs/pvp-mixed-contrast-20260630T123135Z/pvp_mixed_contrast_policy_e24.json`
  evaluated at
  `ml/meta_runs/pvp-mixed-contrast-e24-eval-20260630T123135Z/azeval-pvp-mixed-contrast-e24-16g.json`
  scored 25.31 VP, 56% reach30, 9.94 monster kills/game, and 0.56 PvP VP/game.
  This confirms that simply mixing the labels still suppresses player attacks.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-pivot` with
  `ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json`
  was the prior unrestricted champion. The checkpoint is the previous predictive
  policy plus an optional `route_mode` auxiliary head trained route-head-only
  (`--policy-coef 0 --value-coef 0 --route-mode-coef 1.0`) on 1,015 route-mode
  labels. The 16-game proof
  `ml/meta_runs/pvp-route-mode-eval-20260630T124558Z/azeval-pvp-route-mode-16g.json`
  scored 26.69 VP, 63% reach30, 9.44 monster kills/game, and 3.00 PvP VP/game.
  The 64-game proof
  `ml/meta_runs/pvp-route-mode-64g-20260630T124558Z/azeval-pvp-route-mode-64g.json`
  scored 26.94 VP, 96.9% win, 53.1% reach30, 9.66 monster kills/game, 0.98 PvP
  attacks/game, and 2.95 PvP VP/game. This beat the previous 26.86 VP champion
  but left a clear stale-target PvP failure: `pvphunter` won 2 of 64 games and
  missed clean-combat opportunity rose to 5.8%.
- Route-mode threshold calibration is rejected as the next lever. In
  `ml/meta_runs/pvp-route-mode-threshold-sweep-20260630T131946Z`, thresholds
  0.40, 0.55, and 0.80 all matched the 0.50 16-game proof exactly: 26.69 VP,
  63% reach30, 9.44 monster kills/game, 1.00 PvP attacks/game, 3.00 PvP VP/game,
  and 0% missed legal PvP opportunities. The head is saturated enough in this
  slice that cutoff tuning should not get more GPU time without new trace
  evidence.
- The trace slice
  `ml/meta_runs/pvp-route-mode-threshold-sweep-20260630T131946Z/trace050`
  confirms the intended route: early multi-life Abyss farm, then Fallen PvP
  attacks into non-Fallen Good players once HP4/HP5 monster EV is weak. That
  4-game diagnostic averaged 2.00 PvP attacks/game and 6.00 PvP VP/game. The two
  next testing criteria are now low-tail rebuild discipline when Pure/farm EV is
  0, and a Fallen predicted-hunt fallback when repeated non-Abyss camps fail to
  produce a Good target.
- `pvp-predictive-mode-disciplined-pivot` is rejected. It combined Pure low-tail
  rebuild roots with the Fallen stale-target fallback. The 4-game trace improved
  to 28.50 VP, but the 16-game eval
  `ml/meta_runs/pvp-disciplined-gate-20260630T141000Z/eval16/azeval-pvp-disciplined-16g.json`
  regressed to 26.31 VP, 87.5% win, 62.5% reach30, 9.06 monster kills/game, and
  3.19 PvP VP/game. The Pure rebuild half over-rested at Floral Patch, so broad
  no-farm-EV rebuild roots should not be promoted.
- `AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-hunt-fallback-pivot` with the same
  route-mode checkpoint is the new unrestricted champion. The gate keeps the
  learned route-mode hunt-vs-Abyss decision, but when a Fallen bot repeatedly
  camps a predicted non-Abyss destination without resolving PvP, it excludes that
  stale destination from the next predicted-hunt root set and offers other
  Good-target destinations plus Arcane Abyss. The 16-game proof
  `ml/meta_runs/pvp-hunt-fallback-gate-20260630T142000Z/eval16/azeval-pvp-hunt-fallback-16g.json`
  scored 27.06 VP, 100% win, 75% reach30, 9.44 monster kills/game, and 3.38 PvP
  VP/game. The 64-game proof
  `ml/meta_runs/pvp-hunt-fallback-gate-20260630T142000Z/eval64/azeval-pvp-hunt-fallback-64g.json`
  scored 28.39 VP, 96.9% win, 78.1% reach30, 9.75 monster kills/game, 1.41 PvP
  attacks/game, and 4.22 PvP VP/game. This beats the prior 26.94 VP champion by
  +1.45 VP while increasing both monster kills and PvP scoring. Future promotion
  runs must beat this 28.39 VP / 78.1% reach30 baseline.
- A narrower Pure survival-restore fallback was tested after the promotion and
  rejected, then removed from the callable gate list. The 4-game smoke
  `ml/meta_runs/pvp-restore-fallback-gate-20260630T144000Z/trace4/azeval-pvp-restore-fallback-4g.json`
  scored only 17.25 VP, 0% reach30, 6.00 monster kills/game, and 0 PvP. This
  confirms that Pure low-tail recovery should not be another hand-authored
  navigation restore gate.
- `AZEVAL_MICRO_GATE=pvp-pivot-encounter-force` is the new promoted unrestricted
  gate when paired with
  `AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-hunt-fallback-pivot` and
  `ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json`.
  The change is intentionally narrow: if `initiatePvp` is already legal in an
  encounter, take it; otherwise leave navigation/build scoring unchanged. The
  trigger came from a shared neural-field trace where the value gate passed three
  times on a 13-VP Good target. Trace events now include `pvpTargetCount`,
  `pvpTargetVp`, `pvpBestTargetVp`, and `pvpTargets` so missed PvP windows can be
  valued, not only counted. Evidence:
  `ml/meta_runs/pvp-neuralfield-targettrace-20260630T160000Z` showed value-gate
  shared-field 12-game performance at 16.42 VP, 50.0% win, 17% reach30, 7.25 PvP
  VP/game, and 12.1% missed PvP. The force gate
  `ml/meta_runs/pvp-encounter-force-neuralfield-20260630T162000Z` improved that
  matched shared-field probe to 16.67 VP, 50.0% win, 17% reach30, 7.50 PvP
  VP/game, and 0% missed PvP. The regular 16-game heuristic-field proof
  `ml/meta_runs/pvp-encounter-force-heuristic-16g-20260630T163000Z/azeval-pvp-encounter-force-heuristic-16g.json`
  scored 28.38 VP, 93.8% win, 81% reach30, 7.94 monster kills/game, 1.75 PvP
  attacks/game, 5.25 PvP VP/game, and 0% missed PvP. The 64-game proof
  `ml/meta_runs/pvp-encounter-force-heuristic-64g-20260630T163500Z/azeval-pvp-encounter-force-heuristic-64g.json`
  scored 29.69 VP, 98.4% win, 85.9% reach30, 8.30 monster kills/game, 1.91 PvP
  attacks/game, 5.72 PvP VP/game, and 0% missed PvP. Future promotion runs must
  beat this 29.69 VP / 85.9% reach30 / 5.72 PvP VP baseline, and must include a
  shared neural-field or league-field slice when the change affects PvP target
  selection.
- The farm-to-PvP pivot is now an explicit testing requirement, not just a
  nice-to-have metric. The intended high-level route is: farm low/mid Arcane
  Abyss monster lives while their HP-to-VP exchange is efficient, then pivot into
  attacking valuable Good players once the monster ladder becomes less efficient
  or the player target is an immediate better closeout. The all-seat neural-field
  trace hook `AZEVAL_TRACE_ALL_SEATS=1` was added for this: it records every
  planned seat in shared-field traces so we can see whether bots missed legal
  PvP windows, failed to create high-VP Good targets, or looped rebuild locations
  after the early Abyss farm. The first all-seat mirror trace
  `ml/meta_runs/pvp-force-shared-allseat-trace-20260630T171000Z` showed the
  current same-stack failure mode: one copy can become Fallen and score through
  PvP, while other copies drift into rebuild loops with no target or closeout.
- PvP target quality is now a first-class eval column. Fresh evals report
  `planner_pvp_target_vp_per_game`, `planner_pvp_best_target_vp`, and
  `planner_pvp_high_value_opportunities_per_game` in addition to attacks, PvP
  VP, and missed legal windows. The target-quality smokes show why this matters:
  the heuristic-field champion smoke
  `ml/meta_runs/pvp-target-quality-smoke-20260630Tgoal/azeval.json` scored 27.25
  VP and clicked every legal PvP window, but best legal target VP was only 5; the
  shared Good-builder smoke
  `ml/meta_runs/shared-goodbuilder-target-quality-smoke-20260630Tgoal/azeval.json`
  scored 22.50 VP with 10.50 PvP VP/game, but best legal target VP was 9 and the
  Good field averaged only 8 VP; the same-stack champion 16-game mirror
  `ml/meta_runs/champion-sharedstack-target-quality-16g-20260630Tgoal/azeval.json`
  scored 14.63 VP with field-best 15.19 VP, 6.19 PvP VP/game, best legal target
  VP 13, and 1.06 high-value PvP windows/game. Acceptance rule: a league/shared
  dashboard run must say whether the field produced high-value Good targets
  (`bestTarget >= 12`, and preferably target-field VP climbing), not merely
  whether the hunter attacked somebody.
- The "attack Good players after monsters become expensive" pivot is now a
  separate HP4+ Good-target audit. `_azeval` reports
  `planner_pvp_hard_monster_opportunities_per_game`,
  `planner_pvp_hard_monster_attacks_per_game`,
  `planner_pvp_hard_monster_vp_per_game`,
  `planner_missed_pvp_hard_monster_opportunity_pct`,
  `planner_pvp_hard_monster_target_vp_per_game`, and
  `planner_pvp_hard_monster_best_target_vp`, plus the stricter Good-target pivot
  counters `planner_pvp_good_target_pivot_opportunities_per_game`,
  `planner_pvp_good_target_pivot_attacks_per_game`,
  `planner_pvp_good_target_pivot_vp_per_game`,
  `planner_missed_pvp_good_target_pivot_opportunity_pct`,
  `planner_pvp_good_target_pivot_target_vp_per_game`, and
  `planner_pvp_good_target_pivot_best_target_vp`. The first audit
  `ml/meta_runs/hunter-vs-good-mixed-targets-pivotaudit-16g-20260630Tgoal/azeval.json`
  scored 25.69 VP, 63% reach30, 4.00 monster kills/game, 13.88 PvP VP/game, and
  0% missed HP4+ PvP windows. All 4.63 PvP attacks/game happened when the monster
  was HP4+, confirming that the promoted hunter remembers the intended farm-then-
  hunt pivot. The blocker remains target-field quality: field-best opponent VP
  was only 9.75, best legal target VP was 12, and high-value windows were only
  0.06/game.
- All-seat sample mining is now available for league-field data:
  `AZEVAL_ROUTE_SAMPLE_ALL_SEATS=1` records route samples from every planner seat
  in a neural field, and `AZEVAL_ROUTE_SAMPLE_MAX_STATUS_LEVEL=0` can restrict
  rows to final Good seats. Use this carefully: the strict Good-final smoke
  `ml/meta_runs/good-seat-sample-mining-smoke-20260630Tgoal/azeval.json`
  produced 0 rows, while the relaxed all-seat smoke
  `ml/meta_runs/all-seat-sample-mining-smoke-20260630Tgoal/azeval.json` produced
  2,021 contrast rows. The trained
  `ml/meta_runs/all-seat-sample-mining-smoke-20260630Tgoal/allseat_contrast_policy.json`
  is not promotable: same-stack target VP fell to 7.88. It did, however, create a
  better capped target field than the baseline in one dimension: best legal target
  VP 14 and 1.63 high-value PvP windows/game, versus baseline best legal target
  VP 9 and 0 high-value windows. Treat this as a teacher-discovery artifact for
  target-quality data, not as a champion or final Good-builder.
- The first follow-up controls rejected the obvious shortcuts. A Good-capped
  target against unrestricted champion opponents scored only 2.50 VP / 0% win
  (`ml/meta_runs/goodcap-target-vs-pvp-force-neuralfield-20260630T170000Z`), so
  "stay Good and let others attack you" is not yet a viable learned strategy. The
  champion against Good-capped neural opponents scored 20.17 VP / 100% win but 0
  PvP VP/game (`ml/meta_runs/pvp-force-vs-goodcap-neuralfield-20260630T170000Z`),
  which means Good-capped copies are too weak to model the high-scoring Good
  players the Fallen bot should hunt. A narrow status-2/Fallen clean-ready
  re-entry navigation gate was also rejected and removed from callable code after
  it regressed the shared-field probe to 12.92 VP and 3.75 PvP VP/game
  (`ml/meta_runs/pvp-reentry-force-neuralfield-20260630T172000Z`).
- Heterogeneous neural-field stack testing is now part of the gate. `_azeval`
  accepts `AZEVAL_NEURAL_FIELD_STACKS_FILE` / `AZEVAL_NEURAL_FIELD_STACKS_JSON`
  so opponent seats can use full stack manifests instead of just base weight
  files. `_azgen` now passes the Pure-route navigation gate and preservation
  flags, and `npm run bot:shared-pure-league` runs a reusable shared-Pure
  generate/train/eval smoke. The first remote run
  `ml/meta_runs/shared-pure-league-20260630T181500Z` generated 7,199 all-seat
  Pure samples from 16 games and trained on GPU 4. It did not improve the Good
  target field: baseline Pure mirror scored 6.00 VP / 12.5% win / 0% reach30
  with field-best 9.25 VP, while the trained Pure mirror scored 5.63 VP / 12.5%
  win / 0% reach30 with field-best 8.88 VP. The hunter against that trained Pure
  field scored 12.00 VP, 62.5% win, 12.5% reach30, 1.25 PvP attacks/game, 3.75
  PvP VP/game, and 0% missed legal PvP. This rejects naive all-seat Pure
  self-play as the next Good-builder solution; it reinforces the contested Abyss
  low-scoring equilibrium instead of creating valuable Good targets.
- `pure-farm-build` is a better Good-builder teacher gate but still not a
  promotable shared-field solution. It allows Arcane Abyss only when clean
  farmable reward VP exists, otherwise routes Pure players toward damage
  assembly. The sampled run
  `ml/meta_runs/shared-pure-farmbuild-20260630T183500Z` generated 8,732 samples
  with only 3.83 planner VP, regressed trained Pure mirror from 8.75 to 7.38 VP,
  but made a target field the hunter could exploit for 24.00 VP and 16.13 PvP
  VP/game. The deterministic run
  `ml/meta_runs/shared-pure-farmbuild-deterministic-20260630T190000Z` improved
  generated data quality to 10,557 samples, 7.77 planner VP, and 0% missed
  farmable navigation, but still regressed trained Pure mirror from 8.75 to 7.88
  VP; hunter vs trained Pure scored 17.25 VP with 10.13 PvP VP/game. Acceptance
  rule: do not promote a shared Good-builder checkpoint merely because the hunter
  extracts PvP from it. The Good field itself must improve field-best VP and
  create valuable Good targets without collapsing into contested Abyss or weak
  Tidal/Floral loops.
- `npm run bot:allseat-goodbuilder` is the reusable lane for this question. The
  medium GPU run
  `ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/summary.json` mined
  5,289 all-seat contrast samples from 24 shared-stack games and trained a
  Good-builder candidate on GPU 4. The candidate is not promotable: as a shared
  unrestricted stack it scored only 1.75 VP, 0% reach30, and 0 PvP VP. But it
  does prove the intended pivot pressure. Hunter vs baseline Good scored 20.63
  VP, 12.5% reach30, 9.38 PvP VP/game, best legal target VP 9, and 0 high-value
  target windows. Hunter vs trained Good scored 21.25 VP, 37.5% reach30, 14.63
  PvP VP/game, best legal target VP 13, and 1.5 high-value windows/game. Hunter
  vs mixed Good scored 21.38 VP, 50% reach30, 13.88 PvP VP/game, and best legal
  target VP 14. Acceptance rule: future unrestricted league/dashboard runs must
  report farm-to-PvP pivot evidence explicitly: early efficient Abyss kills,
  nonzero PvP VP, best/high-value Good target metrics, and target-field VP. A
  field that only lets the hunter farm weak players is not a solved meta field.
- `good-builder-oracle` is a diagnostic teacher gate, not a promoted bot. It is
  available through `AZ*_NAV_GATE=good-builder-oracle`,
  `AZ*_MICRO_GATE=good-builder-oracle`, and
  `ml/stacks/neural-field-good-oracle-builders.json`. The first smoke exposed a
  bad teacher loop: Lantern/Cursed purchases, 0.75 VP, and 99.1% missed farmable
  Abyss navigation. After hard-forcing farmable Abyss and penalizing Cursed
  purchases, the shared Pure field reached 11.5 VP / 4.00 kills/game / 0 status
  (`ml/meta_runs/good-oracle-shared-smoke-20260630Tgoal/azeval.json`), but the
  HP4 breakpoint variant did not improve it
  (`ml/meta_runs/good-oracle-breakpoint-smoke-20260630Tgoal/azeval.json`). The
  hunter against the fixed oracle field scored 19.63 VP, 12.00 PvP VP/game, best
  legal target VP 9, and 0 high-value windows
  (`ml/meta_runs/hunter-vs-good-oracle-breakpoint-smoke-20260630Tgoal/azeval.json`).
  Acceptance rule: do not train a neural Good-builder from this oracle until the
  oracle itself beats the all-seat trained Good field on field-best VP, best
  target VP, and high-value Good windows.
- Role-split Good target fields are now part of the target-landscape probe. The
  added gates `good-builder-farmer-oracle` and `good-builder-support-oracle`
  back the manifests
  `ml/stacks/neural-field-good-antiovercontest-oracles.json`,
  `ml/stacks/neural-field-good-mixed-targets.json`, and
  `ml/stacks/neural-field-good-mixed-targets-trained-heavy.json`. The portfolio
  summary is
  `ml/meta_runs/good-target-field-portfolio-20260630Tgoal/summary.json`.
  Results: anti-overcontest hunter scored 25.19 VP / 62.5% reach30 / 12.56 PvP
  VP/game; balanced mixed targets scored 24.31 VP / 14.81 PvP VP/game; trained-
  heavy targets scored 21.88 VP while lifting field-best VP to 11.13 and
  high-value windows to 0.94/game. Acceptance rule: use these stacks as dashboard
  probes, not champions. A solved league field still needs Good builders whose
  own field-best VP rises well beyond the current 8-11 range and ideally reaches
  24+ before the Fallen hunter harvests them.
- Non-Fallen Good-builder fields are now a required target-quality variant. In
  the rules, Good targetability means "not Fallen/Evil", not "status must stay
  0"; status 1 and 2 players are still attackable by a Fallen hunter. The
  `good-nonfallen-farm-build` gate, backed by
  `ml/stacks/neural-field-good-nonfallen-targets.json`, caps target builders at
  `maxStatusLevel=2`, forbids `initiatePvp`, and allows them to spend status
  0/1 corruption budget on HP4/HP5 monster farming. The direct 16-game
  gate-assisted field scored 13.75 VP, 4.88 kills/game, status 1.94, max status
  2, and 0 cap violations
  (`ml/meta_runs/good-nonfallen-farmbuild-field-16g-20260630Tgoal/azeval.json`).
  The train smoke
  `ml/meta_runs/nonfallen-goodbuilder-train-smoke-20260630Tgoal/summary.json`
  mined 2,531 contrast samples. Its from-base checkpoint is not promotable
  (13.13 VP, 4.75 kills/game, 0 cap violations), but it improved target-quality
  diagnostics: hunter-vs-trained saw best legal target VP 17, 1.0 high-value
  Good window/game, and 7.50 HP4+ PvP VP/game. Acceptance rule: a future
  Good-target lane must report whether it is strict-Pure (`maxStatusLevel=0`) or
  non-Fallen (`maxStatusLevel=2`), and promotion must reject any non-Fallen lane
  that violates the cap or wins only by becoming Fallen.
- `npm run bot:nonfallen-goodbuilder` is the repeatable medium lane for this
  target-contract variant. It wraps `bot:allseat-goodbuilder` with
  `good-nonfallen-farm-build`, `TARGET_STATUS_CAP=2`,
  `MINE_MAX_STATUS_LEVEL=2`, `MINE_SUCCESS_VP=15`, and
  `MINE_NEAR_MIN_VP=10`. The first medium run
  `ml/meta_runs/nonfallen-goodbuilder-medium-20260630Tcontinue/summary.json`
  is a non-promotion result: 48 mining games produced only 197 contrast samples,
  all near-miss and 0 success. Direct target-field evaluation is mandatory for
  this lane because hunter metrics describe the Fallen attacker, not the Good
  target. In this run the baseline target field scored 11.81 VP, 4.31
  kills/game, status 1.88, max status 2, and 0 cap violations; the trained
  target field respected the cap but regressed to 7.06 VP and 2.38 kills/game.
  Hunter-vs-trained also regressed from 20.50 VP / 7.88 HP4+ PvP VP/game to
  14.00 VP / 4.13 HP4+ PvP VP/game. The mixed field raised field-best VP to
  13.63, best target VP to 17, high-value windows to 0.88/game, and HP4+ PvP VP
  to 8.06/game, but total hunter VP stayed only 15.50. Acceptance rule: do not
  promote or scale a non-Fallen Good-builder checkpoint unless direct target VP
  improves, status cap is clean, and hunter-vs-field improves without merely
  harvesting a weaker target field. Near-miss-only data is not enough.
- `npm run bot:nonfallen-farmq` is the counterfactual follow-up lane for HP4/HP5
  non-Fallen farm-vs-build labels. It keeps the old strict FarmQ behavior as the
  default but the runner sets `FARMQ_QUALIFY_MAX_STATUS_LEVEL=2`,
  `FARMQ_MAX_STATUS_LEVEL=2`, `FARMQ_ALLOW_FIREPOWER_FARM=1`,
  `FARMQ_ALLOW_CORRUPT_FARM=1`, and `FARMQ_FORBID_TYPES=initiatePvp`. A valid
  training shard must report `labelRoundCappedWindows=0`; the first 10-round
  horizon medium run was rejected because 250/256 label windows were capped. The
  accepted diagnostic shard
  `ml/meta_runs/nonfallen-farmq-medium-h6-20260630Tcontinue/summary.json` used
  `labelHorizon=6`, collected 200 HP4 windows from 32 games, had 0 capped label
  windows, and found an 83.5% farm-now label rate with +2.37 VP average
  farm-vs-build delta. Training `nonfallen_farmq_nav_policy.json` from that shard
  is still rejected as a promotion: direct target VP fell from 11.81 to 8.56 and
  hunter-vs-target VP fell from 20.50 to 14.31, even though best legal target VP
  rose to 18. Acceptance rule: FarmQ may be used as an auxiliary/farm-return
  signal or mixed with direct target-builder success data, but a FarmQ-only nav
  replacement must not be promoted unless it improves direct target VP, hunter VP,
  and cap cleanliness together.
- Direct-plus-FarmQ policy mixing is also rejected at the tested weight. The
  mixed run
  `ml/meta_runs/nonfallen-mixed-farmq-20260630Tcontinue/run_summary.json` used
  2,531 direct contrast rows plus three copies of the 200-row FarmQ HP4 shard.
  Direct target VP recovered only from 8.56 FarmQ-only to 9.63, still below
  baseline 11.81 and the prior direct from-base 13.13. Hunter-vs-field fell to
  11.06 VP with only 2.81 HP4+ PvP VP/game, best legal target VP 13, and 0.5
  high-value Good windows/game. This fails the route requirement the user called
  out: after efficient low-rung Abyss farming, the bot must pivot into attacking
  valuable non-Fallen Good players once monster HP/EV is poor. Future FarmQ work
  should be value-only/auxiliary or very low policy weight, and every run must
  report direct target VP, target status cap cleanliness, hunter VP, HP4+ PvP
  VP, best target VP, and high-value Good windows.
- FarmQ value-only samples are now supported, but the first auxiliary injection
  paths are rejected. `npm run bot:nonfallen-farmq` now writes `policyWeight: 0`
  by default and emits a counterfactual `farmValue` target scaled by
  `VALUE_SCALE_VP` (`3` by default). The medium H6 value-only run
  `ml/meta_runs/nonfallen-farmq-aux-medium-h6-20260630Tcontinue/run_summary.json`
  collected 200 samples, 167 positive farm-value targets, average farm target
  0.6783, and no capped label windows. Aux-only training preserved the
  action/value heads, but global leaf bonuses and a gated full-action
  `lockNavigation:Arcane Abyss` bonus all failed promotion: base+aux target VP
  was 10.81 at `ARC_FARM_VALUE_AUX_SHAPE=0.25` and 10.19 at 0.10; from-base+aux
  target VP was 10.38 at 0.25 and 10.19 at 0.05; the HP4/HP5 gated nav-action
  bonus scored 9.94. Hunter-vs-base-aux reached only 14.88 VP and 5.81 HP4+ PvP
  VP/game versus the 20.50 VP / 7.88 HP4+ PvP baseline. The learned-head
  navigation-root prior (`AZEVAL_FARM_VALUE_SOURCE=head`,
  `AZEVAL_FARM_VALUE_BONUS=4`, HP4/HP5/status gated) is also rejected:
  `frombase_target_field_eval_headprior4_diag_16g.json` scored 9.94 VP. Its
  diagnostics showed 2.31 prior applications/game, average score 0.553, and
  average Arcane logit bonus 2.21; the 4-game trace showed 100% of applications
  already chose Arcane, so this signal is mostly redundant. Acceptance rule: do
  not promote FarmQ auxiliary heads through global leaf value, full-action
  Arcane bonuses, or the tested HP4/HP5 root-prior bonus. Future improvement
  should target stronger Good-builder field strength and post-farm conversion,
  while still reporting direct target VP, cap cleanliness, hunter VP, HP4+ PvP
  VP, best target VP, and high-value Good window gates.
- Post-farm PvP-target pivot is now an explicit test lane. The gate
  `good-nonfallen-farm-target-pivot` and stack
  `ml/stacks/neural-field-good-nonfallen-pivot-targets.json` model the intended
  meta route: Good targets farm efficient early Abyss rewards, then leave Abyss
  for normal locations when the monster becomes a worse option, so Fallen hunters
  can attack them for +3 VP. The 16-game comparison in
  `ml/meta_runs/postfarm-pvp-pivot-20260630T1422Z/run_summary.json` is a positive
  pivot signal: the initial hunter result improved from 20.50 to 26.25 VP, and
  the hard-farm refinement improved it again to 26.44 VP. The refinement is
  sweepable with `ARC_GOOD_TARGET_HARD_FARM_PIVOT_VP`; the selected default is 21
  because it improved direct target play over 18 and matched 24 in the 16-game
  direct probe. Relative to the old non-Fallen Good stack, reach30 rose from 43.8%
  to 75.0%, PvP VP/game from 7.88 to 14.81, HP4+ PvP VP/game from 7.88 to 14.81,
  best legal target VP from 12 to 18, and high-value Good windows from 0.44 to
  1.13/game. The direct target also improved after the refinement: VP rose from
  10.06 to 11.69, kills from 3.50 to 4.31, and missed farmable navs fell from
  71.4% to 0%. Acceptance rule: every future league/meta run must report HP4+ PvP
  VP and target-quality metrics; a bot that stays in Abyss after monster EV is
  poor is not following the unrestricted scoring contract. Caveat: 11.69 direct
  target VP is still too low, so do not promote this stack as the final
  Good-builder policy until target own-score improves while preserving the HP4+
  PvP conversion.
- Non-Abyss Good-builder scoring remains the active bottleneck. The trace
  `direct_pivot_good_targets_cutoff21_trace4g.json` shows post-farm Good targets
  spending too many rounds on Lantern/Floral maintenance after HP4, especially
  when attack is below HP4/HP5. The existing `good-builder-oracle` micro gate is
  rejected as a fix (`direct_pivot_good_targets_microoracle_8g.json`: 4.88 VP,
  1.63 kills/game). A hand damage-rebuild filter is available only as an
  explicit probe with `ARC_GOOD_TARGET_DAMAGE_REBUILD_MIN_HP=4`; it improved
  direct Good-target VP to 12.19 and kills to 4.56, but failed the paired
  target-landscape gate because hunter VP fell to 24.94, HP4+ PvP VP fell to
  13.69, and high-value windows fell to 0.31/game. Acceptance rule: do not enable
  that hand filter by default or promote it unless it improves direct Good-target
  VP while preserving or improving the 26.44 hunter VP / 14.81 HP4+ PvP baseline.
  Full-action lookahead is also rejected as a simple switch:
  `direct_pivot_good_targets_full_lookahead_d2_4g.json` scored only 9.75 VP and
  was slower than value selection. The next lane should collect/train
  non-Abyss scoring data rather than relying on this search setting.
- The first outcome-filtered non-Abyss scoring imitation smoke is negative:
  `ml/meta_runs/nonabyss-pivot-scoring-20260630Tuserpivot-smoke`. Mining from the
  pivot target field produced 803 contrast samples, but the trained target policy
  fell from the smoke baseline's 10.25 VP / 3.63 kills/game to 8.75 VP / 3.00
  kills/game. It also reduced Arcane Abyss navs and max attack, so simple
  success/near-miss imitation is reinforcing the Lantern/Floral maintenance loop
  instead of teaching damage assembly or post-farm scoring. Do not promote this
  checkpoint or repeat this lane without counterfactual labels.
- The user's PvP reminder is now encoded as the current route contract: the bot
  should farm efficient multi-life monsters first, then pivot to attacking
  valuable Good/non-Fallen players once the monster rung is too inefficient or
  dangerous. A controlled-corruption Good-target probe was added behind
  `ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1`: when enabled,
  `good-nonfallen-farm-target-pivot` may continue Abyss farming from status 0-1
  when the kill is valuable and the target remains non-Fallen
  (`maxStatusLevel=2`). The direct 16-game/160-iteration check in
  `ml/meta_runs/postfarm-pvp-controlled-corrupt-20260630Tuserpivot/run_summary.json`
  improved direct target VP from 11.69 to 17.19, kills from 4.31 to 5.88, and
  Abyss navs from 4.81 to 17.63 with zero status-cap violations. The accepted-
  budget remote hunter check preserved the pivot shape but regressed target
  quality: 24.75 VP, 68.8% reach30, 10.13 PvP VP/game, 10.13 HP4+ PvP VP/game,
  0% missed PvP windows, and 12 best legal target VP versus the previous 26.44
  VP / 14.81 HP4+ PvP baseline. Verdict: keep this as proof that controlled
  non-Fallen corruption matters for direct target scoring, but leave the flag
  default-off because it over-keeps Good targets in Abyss and weakens the
  player-attack landscape. The no-flag smoke returned to the safer Pure lane
  (`default_gate_smoke_4g64.json`: status 0, 20.50 VP, 7.50 kills/game, 7.50
  Abyss navs/game, 0% missed clean farm). A simple VP cap on controlled
  corruption is also rejected: `ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP=12`
  matched the uncapped controlled smoke in both direct and paired 8-game checks,
  so the next fix must teach explicit target-exposure / leave-Abyss timing rather
  than only capping corruption use. Hand exposure gates were also probed and
  rejected as defaults: `ARC_GOOD_TARGET_EXPOSE_AFTER_VP=12` cut direct target
  score to 12.00 VP and reintroduced 76.3% missed clean farm, while
  `ARC_GOOD_TARGET_EXPOSE_AFTER_VP=15` improved the paired 8-game smoke to 11.25
  HP4+ PvP VP/game and best target 15 but still trailed the accepted 14.81 HP4+
  PvP baseline. Use these probes to design learned leave-Abyss/target-exposure
  labels; do not promote the hand gates.
- `scripts/run-arc-good-target-pivot-sweep.sh` is now the repeatable sweep harness
  for this lane. In
  `ml/meta_runs/good-target-pivot-hunter-sweep-20260630Tgoal/sweep_summary.json`,
  the 8-game hunter sweep high-rolled the default/expose gates to 28.00 VP and
  18.38 HP4+ PvP VP/game while controlled-expose15 stayed weak at 23.75 VP /
  11.25 HP4+ PvP VP. The accepted-budget confirmation in
  `ml/meta_runs/good-target-pivot-default-confirm-20260701Tgoal/combined_sweep_summary.json`
  did not hold the high roll: default fell to 25.81 VP and 13.31 HP4+ PvP VP at
  16 games / 160 iterations, below the accepted 26.44 VP / 14.81 HP4+ PvP
  baseline. Treat small 8-game target-pivot wins as smoke only; promotion now
  requires at least the accepted 16-game/160-iteration paired hunter check.
- July 1, 2026 stricter Good-target pivot audit:
  `ml/meta_runs/good-target-pivot-goodmetric-default-16g-20260701Tgoal/sweep_summary.json`
  confirms the default target field creates the real monster-to-Good-player
  pivot, but too rarely: hunter VP 25.81, HP4+ PvP VP/game 13.31,
  `planner_pvp_good_target_pivot_vp_per_game=2.25`,
  `planner_pvp_good_target_pivot_attacks_per_game=0.75`, best Good target 18,
  and field-best opponent VP 10.31. Missed Good-pivot opportunities were 0%.
  Read: hunter timing is not the immediate blocker; target-field quality and
  frequency of valuable Good targets are.
- `scripts/run-arc-target-exposure-traceq.sh` is the safe target-exposure label
  miner. It filters current-policy `Arcane Abyss` choices, requires positive
  exposure delta, and by default rejects labels that lose more than 1 VP. The
  16-game safe probe
  `ml/meta_runs/target-exposure-traceq-safe-16g-20260701Tgoal/compact_summary.json`
  found 24 Arcane-source windows, many exposure-scored branches, but 0 safe
  corrections/samples; the exposure branches averaged -2.17 VP and the best
  non-policy rows still lost at least 2 VP. Do not train sacrificial
  target-exposure labels from this lane unless a future run passes the VP-loss
  guard. The next Good-target improvement should come from stronger own-score
  Good builder/search policy, not forced exposure.
- `ml/meta_runs/good-target-ownscore-pivot-lane-20260701Tgoal/summary.json`
  tested that own-score direction with a compact all-seat Good-builder lane under
  `good-nonfallen-farm-target-pivot`. It mined 197 near-miss samples and trained
  `allseat_goodbuilder_policy.json`. Result: not promotable as a Good bot.
  Direct target-field VP fell from 10.25 to 6.38 and field-best VP fell from
  11.75 to 10.13. However, hunter-vs-trained-field strict Good-pivot pressure
  improved sharply in the compact eval: Good-pivot VP/game 1.88 -> 9.38,
  Good-pivot attacks/game 0.63 -> 3.13, and best Good target 14 -> 21, while
  hunter VP was flat/slightly down (25.75 -> 25.50). Treat this checkpoint as a
  target-landscape stressor, not a champion. The next training version needs
  more data and an explicit own-VP preservation objective.
- The low-tail preservation variant
  `ml/meta_runs/good-target-ownscore-preserve-smoke-20260701Tgoal/summary.json`
  added 89 value-only low-tail samples to the 197 near-miss policy samples. It
  improved the compact hunter-vs-trained-field result to 27.50 VP with 14.00
  strict Good-pivot VP/game and best Good target 18, but direct Good-target VP
  still fell from 10.00 to 6.50. The accepted-budget confirmation
  `ml/meta_runs/good-target-preserve-trainedfield-confirm-16g-20260701Tgoal/sweep_summary.json`
  rejected the checkpoint: hunter VP fell to 20.19, despite 5.81 strict
  Good-pivot VP/game and best Good target 24. Value-only low-tail preservation is
  not enough; the next fix must address the Good-builder action policy/location
  loop directly.
- `pvp-good-target-value-pivot` exists as an opt-in diagnostic gate for the
  user's reminder: farm efficient monster lives, then attack valuable Good
  players once the monster route becomes worse. Do not make it the default. The
  16-game remote check
  `ml/meta_runs/good-target-value-pivot-16g-20260701Tgoal/sweep_summary.json`
  rejected this hard gate: hunter VP 17.38, reach30 31.3%, HP4+ PvP VP/game
  3.75, strict Good-pivot VP/game 1.88, best Good target 20, and field-best VP
  11.44. It can trigger Good-target attacks, but it sacrifices too much monster
  route value and hunts too sparsely. Keep the accepted default
  `pvp-predictive-mode-hunt-fallback-pivot` unless a future learned/league gate
  beats the 26.44 VP / 14.81 HP4+ PvP baseline.
- `goodTargetActionDiscipline` is now an opt-in Good-target action filter for the
  Lantern/Cursed/Floral maintenance loop. It blocks optional non-scoring Cursed
  rows and pointless rest/cultivate/restore rows while preserving monster combat,
  reward picks, damage-building summons, and real survival/farm improvements. The
  16-game remote sweep
  `ml/meta_runs/good-target-action-discipline-16g-20260701Tgoal/sweep_summary.json`
  is the first strong direct Good-builder improvement: direct target VP 21.94
  versus the accepted 11.69 baseline, 8.00 monster kills/game, max status 2, 0
  status-cap violations, and Cursed-row usage essentially gone
  (`Lantern Canyon:row0...Cursed Spirit` 0.06/game). It is not a champion
  promotion yet: hunter VP was 26.75, but HP4+ PvP VP/game fell to 12.19 versus
  the 14.81 baseline, best Good target fell to 12, high-value windows fell to
  0.75/game, and `promotionCandidate=false`. Treat this as a major target
  own-score lane and a dashboard balance probe, not the solved meta. The next
  lane should combine this discipline with target-exposure/anti-overcontest or
  league training so high-scoring Good seats remain attackable.
- Simple late exposure thresholds do not fix the disciplined target landscape.
  The local sweep
  `ml/meta_runs/good-target-discipline-exposure-local-smoke/sweep_summary.json`
  tested `TARGET_ACTION_DISCIPLINE=1` with `default`, `expose18`, and `expose21`.
  Direct VP stayed strong for default (22.00) and expose21 (21.33), but expose18
  cut direct VP to 18.67 and reintroduced 42.9% missed farmable navs. Hunter
  target quality did not improve for either exposure label: hunter VP stayed 20,
  HP4+ PvP VP/game stayed 6, and best Good target stayed 12. Do not spend
  accepted-budget GPU on simple `ARC_GOOD_TARGET_EXPOSE_AFTER_VP=18/21` with the
  discipline flag unless a stronger local/TraceQ result first shows better target
  quality. The next exposure idea needs opponent-aware or anti-overcontest labels,
  not a single VP cutoff.
- `ml/stacks/neural-field-good-nonfallen-evade-targets.json` is now the
  target-only version of the evasive non-Fallen Good field, so sweeps can test
  target-side anti-prediction without mixing hunter roles into the target stack.
  The compact SimForge sweep
  `ml/meta_runs/good-target-discipline-evade-20260701T084521Z/sweep_summary.json`
  combined `good-nonfallen-farm-target-evade` with `goodTargetActionDiscipline`
  and rejected it as a promotion. Direct target play was excellent for this slice
  (22.63 VP, 8.25 kills/game, status 0, 0 cap violations), but the shared target
  field under hunter pressure still collapsed: hunter VP 26.25, HP4+ PvP VP/game
  10.88 versus the 14.81 accepted baseline, best Good target 12 versus 18, and
  high-value windows 0.75/game versus 1.13. Role stats show the target seats
  averaged only 7.88, 4.88, and 4.50 VP, so direct target control is not enough;
  the field needs shared-play scoring/anti-overcontest training, not just
  evasive destination ordering.
- The latest PvP-target check confirms the scoring contract should be
  monster-farm-to-Good-player-attack, but not with a hard target-VP floor. The
  new opt-in `pvp-high-value-encounter-force` diagnostic passed type/script
  validation and was tested locally against the disciplined Good-builder field.
  With the default 18-VP target floor
  (`ml/meta_runs/high-value-encounter-local-smoke/sweep_summary.json`), the
  hunter refused every legal PvP attack because the best visible Good target was
  only 12 VP, collapsing to 12.00 VP. Lowering the floor to 12
  (`ml/meta_runs/high-value12-encounter-local-smoke/sweep_summary.json`) still
  underperformed at 16.50 VP because it skipped lower-score fixed-VP attacks.
  The control `pvp-pivot-encounter-force`
  (`ml/meta_runs/encounter-force-control-local-smoke/sweep_summary.json`) scored
  22.50 VP with 10.50 PvP VP/game and 0% missed legal PvP. Read: target VP is a
  dashboard/league quality metric, not a reason to pass fixed-value attacks once
  the monster route is hard. Keep using a hard-monster / Good-target presence
  pivot until a learned value model proves a better pass/attack threshold.
- `pvp-predictive-mode-hunt-fallback-rebuild-pivot` is now the current promoted
  unrestricted champion when paired with the route-mode checkpoint and
  `pvp-pivot-encounter-force`. It fixes the old champion's low-tail failure:
  Fallen bots that cannot execute current Abyss farm should rebuild
  damage/survival instead of returning to dead Abyss. The first aggressive
  version proved the heuristic value but over-rebuilt in shared fields: 30.39 VP
  / 96.9% reach30 in
  `ml/meta_runs/champion-rebuild-pivot-64g-20260701Tgoal`, but only 14.00 VP /
  5.50 PvP VP/game in
  `ml/meta_runs/champion-rebuild-pivot-neuralfield-20260701Tgoal`. Trace
  instrumentation then showed the issue: rebuild was activating before the
  existing round-10 PvP route boundary and stealing early shared-field Abyss
  tempo. The first promoted round-14 default (`ARC_PVP_REBUILD_MIN_ROUND=14`)
  cleared both promotion gates. The 64-game heuristic proof
  `ml/meta_runs/champion-rebuild-pivot-round14-64g-20260701Tgoal/azeval-rebuild-64g.json`
  scored 30.14 VP, 100% win, 93.8% reach30, 8.22 monster kills/game, 2.11 PvP
  attacks/game, 6.33 PvP VP/game, and 0% missed legal PvP. The matched
  shared-neural proof
  `ml/meta_runs/champion-rebuild-pivot-round14-neuralfield-20260701Tgoal/azeval-rebuild-neuralfield.json`
  beat the promoted shared baseline at 17.75 VP, 50% win, 25% reach30, 8.75 PvP
  VP/game, 5.50 strict Good-pivot VP/game, and best Good target 15.
- Fresh low-tail traces then showed the remaining sub-30 heuristic games were
  HP4-wall stalls, not missed farm or missed PvP: in
  `ml/meta_runs/champion-round14-trace-heuristic-20260701Tgoal/lowtail.trace-analysis.json`,
  the four sub-30 games averaged 25.50 VP with 0% missed farm VP and HP4-wall
  issues in all four. Two of those games repeatedly let low-value speculative
  Good-target hunting (`bestGoodTargetVp` 6-9) override damage rebuild after the
  current monster farm was no longer executable. The shared trace
  `ml/meta_runs/champion-round14-trace-shared-20260701Tgoal/lowtail.trace-analysis.json`
  showed the same broader HP4 wall: 12 of 13 sub-30 traced shared games had HP4
  firepower deficits, while missed PvP stayed 0%.
- The promoted follow-up raises the speculative hunt bypass to
  `ARC_PVP_REBUILD_SKIP_TARGET_VP=12`, matching the existing Good-target pivot
  threshold. Visible legal PvP is still always taken, but low-value predicted
  hunts no longer suppress Fallen damage/survival rebuild. The 64-game heuristic
  proof
  `ml/meta_runs/champion-round14-skip12-heuristic-20260701Tgoal/azeval.json`
  improved the champion to 30.33 VP, 100% win, 96.9% reach30, 8.22 monster
  kills/game, 2.17 PvP attacks/game, 6.52 PvP VP/game, 0% missed legal PvP, and
  0% missed farm VP. The exact 12-game shared-neural guardrail
  `ml/meta_runs/champion-round14-skip12-shared12-20260701Tgoal/azeval.json`
  improved the shared baseline to 17.92 VP, 50% win, 25% reach30, 8.75 PvP
  VP/game, 5.50 strict Good-pivot VP/game, and best Good target 15. A harsher
  16-game shared diagnostic
  `ml/meta_runs/champion-round14-skip12-shared-20260701Tgoal/azeval.json`
  stayed below the 12-game guardrail at 15.56 VP but still slightly beat the
  matched 16-game trace control at 15.44 VP. Future promotion runs must beat the
  new 30.33 heuristic / 17.92 shared-field baseline.
- Do not promote hand-forced tainted status 1-2 rebuild roots. The trace behind
  `ml/meta_runs/champion-skip12-trace-shared12-20260701Tgoal/lowtail.trace-analysis.json`
  suggested that some status 1-2 HP4 stalls choose Floral too long after damage
  becomes adequate, but the blunt patch that reused Fallen rebuild destinations
  for all tainted rebuild-gate states collapsed the exact shared guardrail:
  `ml/meta_runs/champion-tainted-rebuild-shared12-20260701Tgoal/azeval.json`
  scored only 9.83 VP, 25% win, 8.3% reach30, and 1.00 PvP VP/game. It reduced
  shared-field PvP pressure too much. The next HP4 fix should be a learned
  full-action/restore-timing policy or a much narrower "ready-now, return
  Abyss" correction, not a broad tainted navigation-root override.
- Do not promote the first all-seat route-exec correction checkpoint. The
  diagnostic
  `ml/meta_runs/routeexecq-shared-allseat-champion-20260701Tdiagnostic-v3`
  found only 11 corrections in 128 windows (`avgBestVpDelta` 0.08,
  `avgBestScoreDelta` 0.18). The trained checkpoint
  `ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json`
  underperformed the current champion in every tested placement: 14.67 shared-12
  VP / 4.25 PvP VP as the PvP-pivot micro, 12.42 shared-12 VP / 4.00 PvP VP as
  the base full policy, and 16.50 shared-12 VP / 6.25 PvP VP as a broad
  `location-interactions` micro. The champion guardrail remains
  `ml/meta_runs/champion-round14-skip12-shared12-20260701Tgoal/azeval.json` at
  17.92 VP / 8.75 PvP VP. Future route-exec promotion must improve both average
  VP and farm-to-Good-player PvP conversion, not just local row imitation.
- Treat `status2-target-descend` as a league role, not a champion promotion. It
  improved the current hunter against the Good-builder mixed target field from
  21.94 VP / 15.56 PvP VP in
  `ml/meta_runs/champion-vs-goodbuilder-mixed-currentgate-20260701Tgoal/azeval16.json`
  to 24.38 VP / 18.00 PvP VP in
  `ml/meta_runs/champion-status2-descend-currentgate-20260701Tgoal/goodbuilder16.json`,
  but the same oracle applied to all seats in a shared mirror regressed the
  8-game smoke from 17.38 VP / 9.75 PvP VP to 9.50 VP / 1.88 PvP VP. The mixed
  current+status2+Good-builder stack in
  `ml/stacks/league-current-goodbuilder-status2-hunter.json` is now a required
  pressure test for PvP meta claims: current planner scored 17.08 VP and
  status-2 planner scored 17.67 VP over matched 12-game runs, while status-2
  hunter opponents won 6/12. A future promotion must beat this stack, not only
  the passive Good-builder target field.
- The owner's intended unrestricted route is not "wait for a rich target"; it is
  "farm cheap multi-life Abyss monsters, then convert through legal Good-player
  PvP when the monster rung is inefficient." The new
  `status2-conversion-descend` oracle keeps the same status-2 / HP4+ /
  low-kill-prob guard, but removes the Good-target-VP threshold. Use
  `planner_pvp_hard_monster_vp_per_game`, `planner_pvp_attacks_per_game`, and
  missed hard-monster PvP windows as the primary conversion metrics. Keep
  `planner_pvp_good_target_pivot_*` as a secondary "high-value target pressure"
  diagnostic only. The direct stack for this role is
  `ml/stacks/league-current-goodbuilder-status2-conversion-hunter.json`.
  Local wiring smoke
  `ml/meta_runs/status2-conversion-smoke-20260701Tlocal/azeval.json` proves the
  distinction: 30 VP, 10 monster kills, 1 HP4+ PvP attack for +3 VP against a
  5-VP Good target, and 0 strict Good-pivot VP because the target did not meet
  the high-value threshold.
  Remote bounded meta suite
  `ml/meta_runs/status2-conversion-meta-20260701Tlocalremote/summary.json`
  confirms the same split at larger scale. Arena vs the heuristic field passed
  the farm-to-PvP contract at 30.25 VP, 100% win, 100% reach30, 7.13 PvP
  VP/game, 6.19 HP4+ PvP VP/game, and 0% missed PvP. Forced-Abyss reached only
  24.50 VP with 0 PvP, proving the pivot is real value. But shared/all-seat meta
  failed: deterministic 11.31 VP / 4.2% reach30 and sampled 7.42 VP / 2.1%
  reach30. Verdict: `not-yet`; use this as a role/counter-pressure lane, not a
  universal champion promotion.
- `npm run bot:role-portfolio` is now the portfolio/exploitability gate for
  these role-stack claims. It runs current hunter, conversion hunter,
  Good/non-Fallen target, and Pure target roles against a heterogeneous stack,
  then reports planner-role strength plus stack-role weakness/exposure. The
  first bounded remote proof,
  `ml/meta_runs/role-portfolio-conversion-stack-20260701Tremote/summary.json`,
  rejected the current conversion stack: best role was `conversion` at only
  20.75 VP / 25% reach30 / 10.88 HP4+ PvP VP; target and Pure planner roles
  both averaged 7.88 VP; exploit gap was 12.87 VP; `allseat-goodbuilder-trained`
  remained over-exposed at 6.85 VP and 8.86 conceded PvP share per seat.
  Verdict: `solvedPortfolio=false`. This is stronger negative evidence than the
  prior arena-only result because it proves the portfolio still contains weak
  food roles.
- The eval harness now reports defender-side target pressure:
  `pvp_target_combats_per_seat`, `pvp_aggressors_faced_per_seat`, and
  `pvp_vp_conceded_share_per_seat` in `roleStats`, plus matching planner-level
  fields. Use these metrics for the user's core route contract: efficient Abyss
  farm first, then attack Good/non-Fallen players for points. A hunter result is
  not fully explained by `pvp_vp_per_seat` unless the target roles also show
  whether they were ignored, farmed, or resilient.
- `ml/stacks/league-current-disciplined-goodbuilder-status2-hunter.json` is the
  current target-pressure pressure test. It adds `goodTargetActionDiscipline` to
  the Good-builder seats while keeping current and status-2 hunters in the
  field. The 24-game confirmation with target-pressure metrics showed status-2
  planner as the stronger role in this lane:
  `ml/meta_runs/league-current-disciplined-goodbuilder-status2-hunter-20260701Tgoal/status2_planner_vs_stack24_target_pressure_oraclefix.json`
  scored 21.46 VP, 41.7% win, 29.2% reach30, and 12.38 PvP VP/game versus the
  current planner's 19.71 VP, 33.3% win, 29.2% reach30, and 10.63 PvP VP/game in
  `ml/meta_runs/league-current-disciplined-goodbuilder-status2-hunter-20260701Tgoal/current_planner_vs_stack24_target_pressure.json`.
  This is progress, not completion: the Good-builder roles were still weak on
  their own. `allseat-disciplined-goodbuilder-trained` averaged only 7.13 VP and
  conceded 19.38 PvP VP share per seat in the corrected status-2 run;
  `pure-damage-disciplined-goodbuilder`
  averaged 8.25 VP and conceded 6.54. The next promotable meta lane must build
  Good/non-Fallen policies that can score high while being hunted, not merely
  expose themselves as VP sources.
- The status-2 planner comparison now has an important harness correction:
  in neural-field mode, global `AZEVAL_PVP_PIVOT_ORACLE` applies only to the
  rotating planner seat, while stack seats use only their manifest
  `pvpPivotOracle`. Before this fix, status-2 planner runs could leak the global
  oracle into ordinary field seats. Corrected target-pressure runs should use
  the `*_oraclefix.json` outputs above or rerun the lane.
- `ml/stacks/league-current-disciplined-nonfallen-goodbuilder-status2-hunter.json`
  is the non-Fallen target-quality variant. It allows the Good-builder seats to
  reach status 2 under `good-nonfallen-farm-target-pivot` and
  `goodTargetActionDiscipline`. The corrected 24-game status-2 run
  `ml/meta_runs/league-current-disciplined-nonfallen-goodbuilder-status2-hunter-20260701Tgoal/status2_planner_vs_stack24_target_pressure_oraclefix.json`
  scored only 20.00 VP and 10.88 PvP VP/game, so it is not better than the Pure
  disciplined stack as a champion lane. It is still valuable for dashboard and
  training because target quality improved: 50.42 target VP/game, best target
  16, 1.00 high-value window/game, and 3.00 strict Good-pivot PvP VP/game. The
  Good roles remained weak (`nonfallen-disciplined-goodbuilder-trained` 7.83 VP,
  `nonfallen-disciplined-farmer-target` 5.63 VP), so this lane should feed a
  resilient Good-builder training pass rather than be treated as solved.
- `npm run bot:resilient-goodbuilder` is now the repeatable resilient-target
  training lane. It mines target-role samples from a hunter-plus-target stack
  using `AZEVAL_ROUTE_SAMPLE_ROLE_REGEX`, trains a Good-builder candidate, then
  evaluates own-score and hunter pressure with target-pressure metrics. The local
  compact run
  `ml/meta_runs/resilient-goodbuilder-compact-20260701Tlocal/summary.json`
  proves the harness works but rejects the candidate. It mined 702 contrast
  samples and trained
  `resilient_goodbuilder_policy.json`; own-score rose only to 8.25 VP, while
  hunter-vs-trained-target exploded to 30.50 VP, 25.50 PvP VP/game, 5.75
  high-value windows/game, and 17.25 strict Good-pivot PvP VP/game. The trained
  candidate conceded 8.50 PvP VP share per seat under direct hunter pressure and
  9.50 in the mixed stack. Verdict: this lane successfully creates attackable
  Good-player targets, but it is not resilient. Do not promote it; the next
  collector must add an explicit anti-farming / survivable-target objective.
- The resilient-target collector now has that first anti-farming gate. Route
  sample export accepts `AZEVAL_ROUTE_SAMPLE_MAX_CONCEDED_SHARE`,
  `AZEVAL_ROUTE_SAMPLE_PRESSURE_PENALTY`, `AZEVAL_ROUTE_SAMPLE_PRESSURE_SCALE`,
  and `AZEVAL_ROUTE_SAMPLE_PRESSURE_FAIL_LOW_TAIL`. Success/near-miss Good-target
  rows are admitted only when conceded PvP VP share is below the cap; farmed
  targets can be written as value-only low-tail rows with pressure-adjusted
  returns. The local smoke
  `ml/meta_runs/resilient-goodbuilder-pressure-smoke-20260701Tlocal/summary.json`
  verified the lane end-to-end, and the forced branch probe
  `ml/meta_runs/route-pressure-fail-probe-20260701Tlocal/mining_eval.json`
  produced 320 pressure-fail rows into `low_tail` with `policyWeight: 0`.
- The first pressure-aware GPU run on SimForge was
  `ml/meta_runs/resilient-goodbuilder-pressure-gpu6-20260701Tfull/summary.json`.
  It mined 1,500 contrast rows plus 1,000 value-only low-tail rows, including
  548 pressure-failed target rows, and trained on GPU 6 without exceeding the
  memory guard. The candidate is still rejected: own-score was only 7.58 VP;
  direct hunter-vs-trained-target scored 20.08 hunter VP with the candidate
  conceding 3.33 PvP VP share per seat; the mixed candidate stack still exposed
  it badly at 12.69 conceded share per seat. This is a partial resilience gain,
  not a solved Good-builder.
- `good-nonfallen-farm-target-evade` is now an experimental navigation gate for
  target-side anti-prediction. It keeps the early Abyss-farm rule, then under
  Evil-player pressure swaps predictable build destinations, such as Lantern
  before Floral restore lines and Cyber before Tidal damage lines when plausible.
  Local A/B on the same 6-game slice reduced hunter VP from 21.33 to 19.83 and
  candidate conceded share from 12.67 to 10.33, but own-score stayed 7.5 VP. The
  full SimForge run
  `ml/meta_runs/resilient-goodbuilder-evade-gpu7-20260701Tfull/summary.json`
  was also rejected: own-score stayed 7.58 VP, direct conceded share stayed 3.33,
  and mixed conceded share improved only from 12.69 to 11.53, still above the
  8.46 resilience threshold.
- `ml/stacks/league-current-disciplined-nonfallen-goodbuilder-evade-status2-hunter.json`
  is the evasive-teacher version of the non-Fallen target-pressure stack. Local
  8-game A/B
  `ml/meta_runs/evade-source-stack-ab-20260701Tlocal/summary.json` showed the
  source-stack change helps but is not enough: hunter VP dropped from 18.88 to
  18.13, PvP VP from 7.88 to 7.13, and strict Good-pivot VP from 2.25 to 0. The
  Good-builder teacher was much better than the farmer target in that slice
  (9.75 VP and 2.13 conceded share), so the next training pass mined only
  `goodbuilder` roles.
- The full evasive-source training pass
  `ml/meta_runs/resilient-goodbuilder-evade-source-gpu7-20260701Tfull/summary.json`
  is rejected. It trained from 666 contrast rows plus 172 low-tail rows, but the
  candidate still scored only 7.58 VP on its own, worsened direct hunter pressure
  to 22.42 hunter VP / 12.50 PvP VP, and still conceded 11.08 share in the mixed
  stack. A direct untrained source-policy check
  `ml/meta_runs/source-goodbuilder-evade-candidate-ab-20260701Tlocal/summary.json`
  scored slightly better at 8.50 VP but still conceded 12.61 in mixed play. This
  closes off "just use/mined-imitate the evasive source Good-builder" as a
  solution.

Verdict: simple behavior cloning from `pvphunter`, even mixed with route data,
is not enough. Focused PvP data plus a single gated overlay improved the bot,
but the route-mode auxiliary head is the first tested architecture that cleanly
separates "hunt Good player" from "return Abyss" and improves the 64-game
champion, the stale-target fallback was the first route-mode patch to break 28
VP over 64 games, the encounter-force micro gate was the first proof to break
29 VP while eliminating missed legal PvP, the round-14 Fallen rebuild gate was
the first promoted proof over 30 VP while improving the shared-field PvP slice,
and the skip-12 speculative-hunt cutoff is the current promoted 30.33 VP
champion. The next lane should treat
monster-farm-to-player-attack as the core unrestricted scoring contract: improve
Pure low-tail/missed-clean-combat recovery with counterfactual/full-action
labels, then evaluate in a real league-field/shared-neural dashboard lane that
contains strong Good builders worth attacking. Do not spend more GPU on broad
single-head BC mixing, route-mode threshold sweeps, broad no-farm-EV rebuild
gates, global `hybrid` selection, Good-capped mirror fields as the main PvP
test, naive current-Pure all-seat self-play, or hand-authored Pure/re-entry
restore navigation gates, or broad tainted status 1-2 rebuild-root overrides.

## Promotion Criteria

A bot checkpoint can be treated as a candidate best bot only when:

- It passes deterministic engine/legal-action tests on the same rules commit.
- It completes smoke and medium meta runs without illegal actions, infinite loops, or unbounded deadline advances.
- It beats the previous best checkpoint in seeded evaluation, or produces a clearly useful counter-strategy for the dashboard/league.
- If unrestricted rules are being evaluated, it demonstrates the farm-to-PvP
  pivot with nonzero planner PvP attacks/VP and not only monster/corruption VP.
  The report must state whether valuable Good targets existed and whether any
  legal PvP windows were missed, including `planner_pvp_target_vp_per_game`,
  `planner_pvp_best_target_vp`, and
  `planner_pvp_high_value_opportunities_per_game`. It must also report the HP4+
  pivot counters: `planner_pvp_hard_monster_attacks_per_game`,
  `planner_pvp_hard_monster_vp_per_game`, and
  `planner_missed_pvp_hard_monster_opportunity_pct`, plus the Good-target pivot
  counters `planner_pvp_good_target_pivot_attacks_per_game`,
  `planner_pvp_good_target_pivot_vp_per_game`,
  `planner_pvp_good_target_pivot_best_target_vp`, and
  `planner_missed_pvp_good_target_pivot_opportunity_pct`.
- `npm run bot:meta:evaluate` now treats that reminder as an executable
  contract. When `initiatePvp` is not forbidden and `maxStatusLevel` allows
  Fallen play, the generated `summary.json` sets
  `farm_to_pvp_contract.required=true`, reports the PvP pivot counters in the
  `arena` block, and does not reject a candidate merely because its average
  status rises while executing the legal PvP route. Pure/non-Fallen target-lane
  results remain diagnostics and must not be promoted as unrestricted champions.
  The suite accepts the promoted PvP stack knobs directly:
  `PATCH_NAV_WEIGHTS`, `PATCH_NAV_GATE`, `PATCH2_NAV_WEIGHTS`,
  `PATCH2_NAV_GATE`, `MICRO_WEIGHTS`, `MICRO_GATE`, and `PVP_PIVOT_ORACLE`.
- `ml/meta_runs/champion-farm-pvp-contract-20260701T0007Z/summary.json`
  is the first full run after this gate. It proves the retained-field
  farm-to-PvP contract but rejects the checkpoint as solved. Heuristic-field
  arena: 30.32 VP, 98% reach30, 6.22 PvP VP/game, 2.08 PvP attacks/game, 0%
  missed legal PvP, and 0% missed HP4+ PvP. Shared all-seat meta failed badly:
  deterministic 11.03 VP / 3.1% reach30, sampled 8.39 VP / 3.1% reach30. The
  summary verdict is `not-yet`; `arena_contract.ok=true` and
  `shared_meta_contract.ok=false`. Treat any retained-field-only promotion as
  overfitting to weak targets.
- The shared-field follow-up
  `ml/meta_runs/champion-shared-field-contract-20260701T0740Z/azeval.json`
  confirmed the remaining weakness against stronger neural fields: 22.19 VP,
  25% reach30, 12.38 PvP VP/game, 0% missed PvP, but only 3.44 monster
  kills/game and 10.6% missed clean-combat opportunities. Strong targets exist
  (`field_bestVP_avg=20.56`), and the hunter attacks them, but route conversion
  is still weak. A hand-authored "farm-first before hunt" gate was tried and
  removed after fair A/B: 8-game current gate
  `ml/meta_runs/champion-shared-field-currentgate-8g-20260701T0820Z/azeval.json`
  exactly matched the farm-first smokes
  `champion-shared-field-farmfirst-smoke-20260701T0754Z` and
  `champion-shared-field-farmfirst2-smoke-20260701T0817Z` (24.75 VP, 3.88
  kills, 13.88 PvP VP, 4% missed clean). The 16-game farm-first confirmation
  also matched the current 16-game baseline exactly. Do not re-add this as a
  hand gate; the next fix needs trace/counterfactual labels for the actual
  shared-field clean-combat and route-conversion states.
- `scripts/analyze-route-trace.mjs` now expands all-seat `AZEVAL_TRACE_ALL_SEATS`
  traces into one record per traced bot seat and reports PvP target quality,
  HP4+ PvP pivot counters, Good-target pivot counters, and role-group summaries.
  `_azeval` trace payloads now include `seatNames`, so future shared-field
  trace analyses can separate hunter failures from Good-builder target-field
  failures. The current pre-role full trace
  `ml/meta_runs/shared-field-trace-current-20260701T083312Z` scored 24.75
  planner VP in the 8-game eval but only 15.25 VP across the 16 traced seat
  records. It showed 0 missed PvP windows, 6.56 PvP VP/seat, and 0 missed farm,
  but every traced seat hit the HP4 wall; issue counts were 16 HP4-wall, 11
  current-barrier deficits, 8 max-barrier deficits, 9 firepower deficits, and 5
  low-value PvP-target games. The role-smoke after the trace metadata patch
  `ml/meta_runs/shared-field-trace-role-smoke-20260701T084050Z` proves the role
  grouping works: status2 hunters averaged 28.5 VP and 25.5 PvP VP, the planner
  averaged 24 VP and 16.5 PvP VP, while Good-builder roles averaged only 7.5-9
  VP and remained HP4/current-barrier/max-barrier bottlenecks. Interpretation:
  the promoted hunter is not failing to click attacks; the shared-field problem
  is weak/scorable Good targets plus HP4 route conversion under contest.
- The target-only no-PvP diagnostic
  `ml/meta_runs/target-only-evade-discipline-shared-20260701T085104Z` confirms
  that peaceful Good-field training is not enough. With `initiatePvp` forbidden,
  `maxStatusLevel=2`, `good-nonfallen-farm-target-evade`, and all-seat tracing,
  the controlled planner averaged 12.00 VP, 0% reach30, 4.25 monster kills, and
  no status-cap violations; across all 16 traced seats the field averaged only
  8.00 VP with 93.75% low-tail. There were no PvP opportunities by design, while
  every traced seat hit the HP4 wall and the trace reported 12 firepower/current
  barrier deficits plus 14 post-VP plateau churn records. This should be read as
  a target-field failure, not a reason to remove the hunt pivot: unrestricted
  champions still need to farm early Abyss lives, then attack valuable Good or
  non-Fallen players once monster farming becomes too hard, too contested, or
  lower EV than PvP.
- Three compact target-field probes on July 1, 2026 rule out the easy stack-only
  fixes. `ml/stacks/neural-field-good-nonfallen-evade-trained-heavy.json` simply
  repeats the strongest current trained non-Fallen Good builder; target-only
  smoke `ml/meta_runs/target-heavy-goodfield-smoke-20260701Tgoal` still averaged
  only 9.75 controlled VP / 7.88 all-seat trace VP, with 100% low-tail and 16
  HP4-wall records. Enabling `ARC_GOOD_TARGET_DAMAGE_REBUILD_MIN_HP=4` in
  `ml/meta_runs/target-heavy-goodfield-hp4damage-smoke-20260701Tgoal` shifted
  target navigation from mostly Floral Patch to mostly Tidal Cove and improved
  hunter exploitation to 26.25 VP / 18.75 PvP VP / best target 14, but the
  target-only field itself stayed at 9.75 controlled VP and 7.88 all-seat trace
  VP. `ml/stacks/neural-field-good-nonfallen-evade-oracle-micro.json` then tried
  the existing Good-builder action oracle as micro-teacher, but
  `ml/meta_runs/target-oraclemicro-goodfield-smoke-20260701Tgoal` collapsed to
  6.75 controlled VP / 3.75 all-seat trace VP and best target 6 under hunter
  pressure. Do not spend more GPU on repeating the current trained builder,
  toggling only the HP4 damage-rebuild env var, or using the existing
  Good-builder oracle as the target-field teacher. The next target lane needs
  learned damage/pick/HP4-conversion labels from states that actually turn
  Tidal/Cyber/Lantern visits into Spirit Animal, dice, Cultivator, barrier, and
  monster reward VP.
- A fourth compact probe,
  `ml/meta_runs/target-hp4oracle-goodfield-smoke-20260701Tgoal`, tried a new
  `good-builder-hp4-oracle` micro gate that reused the breakpoint oracle for
  non-Fallen Good targets. It is also rejected as a full micro teacher. In the
  target-only no-PvP smoke it produced 0.00 controlled VP, 0 kills, 22 Abyss
  navs/game, and only 0.75 field-best VP. The hunter still scored 27.00 VP with
  5.25 PvP VP and 75% reach30, but best target VP was only 6 and strict
  Good-pivot VP was 0.00. Read: the route must still be early Abyss farm into
  Good-player attacks, but this oracle makes the target field too weak to be
  worth attacking. Do not use it as the target policy. The next candidate should
  constrain teacher overrides to damage/pick/restore subdecisions or collect
  labels from successful Good builders while preserving real combat/reward
  execution.
- The narrower follow-up `good-builder-hp4-pick-oracle` is implemented as a
  separate diagnostic gate and stack:
  `ml/stacks/neural-field-good-nonfallen-evade-hp4-pick-oracle.json`. It only
  lets the breakpoint oracle choose builder/pick actions such as spirit picks,
  hand summons, awaken/rune decisions, and location interactions; combat and
  most payoff execution fall back to the base policy. The compact GPU smoke
  `ml/meta_runs/target-hp4pick-goodfield-smoke-20260701Tgoal` improved over the
  rejected full oracle but is not promotable: target-only scored 10.25 VP,
  4.00 kills/game, status 0, and field-best 10, while hunter-vs-field scored
  24.75 VP, 16.50 PvP VP/game, best target 15, and 3.75 strict Good-pivot VP.
  Every traced target role still hit the HP4 wall, and the all-seat trace stayed
  81.25% low-tail. Treat this as proof that constrained builder teaching is the
  right direction, not as a solved Good field.
- Distilling the HP4-pick signal into a normal Good-builder checkpoint did not
  solve the target field. `ml/meta_runs/hp4pick-distill-goodbuilder-smoke-20260701Tgoal`
  mined 798 contrast rows plus 1,347 low-tail rows from the HP4-pick stack, then
  warm-started the current Good-builder policy. The trained target regressed to
  6.75 own-score VP and 0 strict Good-pivot VP under direct hunter pressure; in
  the mixed stack it conceded 14.67 PvP VP share per candidate seat. A
  contrast-only ablation,
  `ml/meta_runs/hp4pick-distill-contrastonly-smoke-20260701Tgoal`, improved the
  own-score to 8.25 VP and restored hunter Good-pivot pressure to 8.25 VP/game,
  but still failed to beat the live HP4-pick oracle target-only baseline of
  10.25 VP. Do not promote either checkpoint, and do not spend more GPU on the
  same distillation recipe without changing the label source or architecture.
- TraceQ confirms the HP4 conversion labels exist only when the Good-target lane
  is allowed to be non-Fallen rather than strict Pure. The strict run
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-smoke-20260701Tgoal`
  inspected 23 HP4/HP5 windows and found 0 accepted corrections because every
  positive branch raised status. The matched non-Fallen run
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-nonfallen-smoke-20260701Tgoal`
  accepted all 23 corrections, exported 652 samples, and averaged +5.83 VP per
  correction while staying under the status-2 cap. A tiny warm-started train from
  those labels,
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-train-smoke-20260701Tgoal`,
  is still rejected: target-only scored 8.25 VP, below both the live HP4-pick
  oracle target baseline (10.25) and the contrast-only target (8.25 tie), while
  hunter-vs-target showed the intended but weak pivot at 23.25 hunter VP,
  15.75 PvP VP/game, and 1.50 strict Good-pivot VP/game. Keep the labels as
  evidence for a controlled non-Fallen HP4 conversion objective, not as a
  promotable checkpoint.
- A narrower TraceQ HP4 conversion overlay is now implemented as
  `good-builder-hp4-conversion-overlay`. It keeps the base Good-builder policy
  and lets the TraceQ-trained checkpoint choose only HP4 conversion actions
  (`startCombat`, `resolveMonsterReward`, and builder/pick actions) when its
  route-breakpoint score beats or ties the base action. The smoke run
  `ml/meta_runs/traceq-hp4-conversion-overlay-smoke-20260701Tgoal` is still
  rejected: target-only improved over whole-policy TraceQ to 9.75 VP / 3.25
  kills / max status 1, but did not beat the live HP4-pick oracle target
  baseline of 10.25 VP. Hunter-vs-target preserved a useful pivot signal
  (24.00 hunter VP, 16.50 PvP VP/game, 5.25 strict Good-pivot VP/game), but best
  Good target VP was only 12. In the mixed hunter/target league it fell to 14.50
  hunter VP, 6.00 PvP VP/game, and 0 strict Good-pivot VP. This rules out the
  tiny TraceQ shard as a direct overlay; future work needs a larger HP4
  conversion dataset or an auxiliary head that improves target own-score and
  target value under pressure.
- The larger follow-up answered the "too little data?" question. Collection run
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-wide-20260701Tgoal`
  captured 90 HP4/HP5 windows, accepted 89 corrections, exported 2,795 samples,
  and again showed strong branch value (`avgDeltaVp=5.24`, fixed-reentry 60
  best branches, 327 `startCombat` and 244 `resolveMonsterReward` full-action
  samples). Training that wider shard and using it through the same conservative
  overlay was still rejected in
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-wide-eval-20260701Tgoal`:
  target-only regressed to 7.88 VP / 2.63 kills / max status 1, hunter-vs-target
  kept some pivot signal at 21.50 VP / 14.25 PvP VP / 5.25 strict Good-pivot VP
  with best Good target 15, and the mixed league stayed weak at 14.88 VP /
  5.25 PvP VP / 0 strict Good-pivot VP. Conclusion: the labels prove the HP4
  route correction exists, but plain policy imitation of those labels is the
  wrong shape. Do not keep scaling the same overlay recipe; the next version
  needs an auxiliary conversion head, Q/advantage gating, or mixed objective
  that preserves target own-score and pressure survival.
- Mixing broad Good-builder preservation data with HP4 TraceQ labels was also
  tested and rejected. `ml/meta_runs/goodbuilder-preserve-traceq-mix-20260701Tgoal`
  trained from 5,289 all-seat Good-builder contrast samples plus 2,795 wide
  TraceQ samples with TraceQ policy targets down-weighted to 0.35. Direct use of
  the checkpoint collapsed target own-score to 6.75 VP / 2.25 kills / max status
  0 and only 12.75 mixed hunter VP. Using the same checkpoint as a conservative
  HP4 overlay preserved a hunter-vs-target signal (20.00 hunter VP, 12.75 PvP
  VP, 5.25 strict Good-pivot VP, best Good target 17), but target-only stayed
  weak at 7.88 VP and mixed league stayed unsolved at 15.63 hunter VP / 6.00 PvP
  VP / 0 strict Good-pivot VP. This rules out simple preservation-plus-TraceQ
  imitation. The next lane needs an explicit online/branch-time advantage gate
  or separate conversion critic, not another blended candidate policy.
- The first online/branch-time HP4 conversion oracle was also rejected as a
  promotion path. `good-builder-hp4-conversion-oracle` and
  `ml/stacks/neural-field-good-nonfallen-evade-hp4-conversion-oracle.json` let
  the route-breakpoint oracle choose only HP4 conversion actions when its local
  score beats the base Good-builder action. The compact GPU smoke
  `ml/meta_runs/hp4-conversion-oracle-smoke-20260701Tgoal` scored 7.88
  target-only VP / 2.63 kills / max status 1, below the HP4-pick baseline. The
  direct hunter-vs-target leg did remember the intended hard-monster pivot:
  20.38 hunter VP, 13.13 PvP VP/game, 5.63 strict Good-pivot VP/game, best Good
  target 17, and 0% missed Good-pivot windows. But the mixed league still failed:
  15.75 hunter VP, 7.13 PvP VP/game, 0 strict Good-pivot VP, and best Good target
  0 even though field-best VP was 27.13 from hunter roles. This confirms the
  user's correction: the champion contract is early efficient Abyss farming, then
  attacking valuable Good/non-Fallen players when monster HP becomes inefficient.
  It also shows the current blocker is not "does the hunter know to attack?";
  it is making Good-builder targets strong enough to be real competitors and
  attackable VP sources under mixed pressure.
- The carry/support target-field A/B confirms the same monster-to-player pivot
  constraint in a cleaner target-landscape probe. `good-builder-noncontest-support-oracle`
  keeps support seats out of Abyss so a Good carry can farm efficient monsters
  before hunters pivot to players. In
  `ml/meta_runs/good-target-carry-support-ab-20260701Tgoal` on GPU 4, both
  variants were rejected. Single carry/support reached 11.63 target-field VP and
  27.38 direct hunter VP, but only 7.50 HP4+ PvP VP and 4.88 strict
  Good-pivot VP; the mixed league fell to 12.38 hunter VP, 2.25 strict
  Good-pivot VP, and best Good target 12. Dual carry/support raised direct HP4+
  PvP to 13.88 and strict Good-pivot VP to 6.00, but mixed league still had only
  14.88 hunter VP, 5.25 HP4+ PvP VP, 0 strict Good-pivot VP, and no valuable
  Good target. Read: the champion route is still early Abyss farm into attacks
  on valuable non-Fallen players after monster HP becomes inefficient, but the
  league needs Good builders that independently score and defend into the
  15-25 VP band under pressure. A hunter exploiting weak 5-12 VP Good seats is
  not a promotion signal.
- Non-Fallen Good preservation is now a required constraint, not a strict-Pure
  constraint. The dual mixed trace
  `ml/meta_runs/good-target-carry-support-ab-20260701Tgoal/dual_mixed_trace_local.trace.json`
  showed status 1/2 Good carries losing route-critical Spirit Animal/firepower
  during HP4 pressure. `preserveRouteSurvival` and route hand-draw preservation
  now treat status 0/1/2 as Good and stop only at Fallen/Evil status 3. The
  regression test in `src/lib/play/ml/strictConstraints.test.ts` proves a
  status-2 Good builder cannot discard a route-critical Spirit Animal while the
  same guard does not constrain a Fallen player. GPU verification
  `ml/meta_runs/good-target-dual-nonfallen-preserve-20260701Tgoal` improved the
  dual mixed lane from 14.88 to 18.38 hunter VP, HP4+ PvP from 5.25 to 9.75,
  strict Good-pivot VP from 0 to 1.13, and best Good target from 0 to 16. This
  is accepted as a constraint fix, but the lane is still rejected as a meta
  solution: Good carries under mixed pressure averaged only 6.25 and 8.38 VP
  while conceding 16.88 and 12.19 PvP VP share per seat.
- The repeatable non-Fallen HP4 conversion lane now has a bounded GPU-box proof
  run:
  `ml/meta_runs/nonfallen-hp4-conversion-bounded-gpu7-20260701Tgoal`. TraceQ
  captured 24/24 HP4 conversion windows, found 24 corrections, exported 836
  samples, and averaged +8.54 VP per correction; best branches were
  fixed-reentry 14 and abyss-probe 10. Training the conservative conversion
  overlay reached 0.757 top-1, but the target field still failed badly:
  9.00 VP, 3.00 kills/game, field-best 10.50, max status 1, and 0 status-cap
  violations. The hunter-vs-target leg proves the intended player-attack pivot
  is available (30.25 VP, 100% reach30, 22.50 PvP VP/game, 9.75 strict
  Good-pivot VP/game), but those targets were too weak, with best Good target
  only 12. The mixed league improved over the fixed non-Fallen preservation
  baseline on hunter VP (20.00), HP4+ PvP VP (13.50), and strict Good-pivot VP
  (2.25), but still did not find a valuable Good target (best 16, threshold 18).
  Verdict: keep the lane as evidence that HP4 conversion mistakes are real and
  that hunters can pivot to Good players, but do not promote the checkpoint. The
  remaining gate is target quality under pressure, not more proof that
  `initiatePvp` can score.
- Two constrained Good-builder scorer gates were added and rejected locally as
  cheap diagnostic closures, not promotion candidates. `good-builder-score-pick-oracle`
  uses the existing Good-builder class/scoring oracle only for pick/build
  actions; `ml/meta_runs/score-pick-oracle-local-smoke-20260701Tgoal` matched the
  weak 9.00 target-field VP / field-best 9.75 pattern and made hunter-vs-target
  show 26.00 hunter VP / 13.50 PvP VP/game but 0 strict Good-pivot VP because
  targets were too low-value. It also showed 52% missed clean combat
  opportunities, so pick-only scoring does not execute payoff. The one-notch
  broader `good-builder-score-conversion-oracle` also allows `startCombat` and
  `resolveMonsterReward`; `ml/meta_runs/score-conversion-oracle-local-smoke-20260701Tgoal`
  removed the missed-clean-combat issue but worsened target score to 7.50 VP and
  still produced 0 strict Good-pivot VP. Do not spend GPU scaling deterministic
  Good-builder scorer oracles. The next target-quality work needs either a
  learned conversion/value critic or state-generation that produces real
  18-25 VP Good/non-Fallen targets, not another hand scorer over the same action
  subset.
- If a run claims league/shared-field progress, it must include either a
  heterogeneous stack manifest or an all-seat trace, and it must report field-best
  VP. A hunter score against weak Good targets is not enough; the Good field
  itself must be shown to produce valuable targets under shared competition.
  Prefer role-aware trace analysis for this gate, because aggregate all-seat
  averages hide whether the hunter, target builder, or both are failing.
- The July 1 score-floor portfolio run
  `ml/meta_runs/scorefloor-role-portfolio-20260701Tremote/summary.json` is a
  rejected diagnostic, not a promotion. It added the
  `good-nonfallen-score-floor` navigation gate and the
  `ml/stacks/league-current-goodbuilder-scorefloor-conversion-hunter.json`
  stack so non-Fallen builders prioritize cheap Abyss kills, Spirit Animal/damage
  assembly, and real Cultivator breakpoints before passive scorer loops. The
  bounded GPU-4 portfolio confirmed that PvP conversion exists
  (`farmToPvpConversionPresent=true`, best role `conversion`, 13.75 VP,
  6.00 PvP VP/game, 2.00 PvP attacks/game, 0 missed PvP), but every planner role
  stayed below the 15 VP floor and `solvedPortfolio=false`. Field roles remained
  weak: `status2-conversion-descend-hunter` 13.70 VP, `current-champion-hunter`
  11.25 VP, `good-nonfallen-scorefloor-target` 9.38 VP,
  `allseat-goodbuilder-scorefloor` 8.78 VP, and `pure-scorefloor-farmer` 6.46 VP.
  Do not treat navigation-only score-floor gating as the target-quality answer;
  the next gate is action-level HP4/HP5 conversion and reward-continuation labels.
- The follow-up HP4 score-floor action oracle
  `ml/meta_runs/hp4-scorefloor-role-portfolio-20260701Tremote/summary.json` is
  also rejected as a meta solution. A controlled one-game trace proved the oracle
  can express a better target route locally (18 VP, 6 monster kills, 6 clean
  combats, max attack 7, max barrier 4), but the bounded GPU-4 role portfolio
  stayed weak under mixed pressure: `solvedPortfolio=false`, best role
  `conversion` 13.38 VP, 5.63 PvP VP/game, `good-nonfallen-scorefloor-target`
  9.88 VP, `allseat-goodbuilder-scorefloor` 8.91 VP, and
  `pure-scorefloor-farmer` 6.46 VP. This confirms the issue is not simply "bots
  forgot to attack Good players"; PvP conversion is present. The unresolved gate
  is pressure-aware target-builder quality: Good/non-Fallen seats need to become
  18-25 VP boards without exposing themselves as cheap prey before the hunter
  pivot.
- The score-floor carry/support A/B
  `ml/meta_runs/scorefloor-carry-support-ab-20260701Tremote/summary.json`
  updates the old carry/support rejection with the current score-floor navigation
  and HP4 score-floor micro oracle. `scripts/run-arc-good-target-carry-support-ab.sh`
  now defaults to the score-floor carry/support stacks and passes
  `AZEVAL_MICRO_GATE=good-builder-hp4-scorefloor-oracle` for target planners.
  The single-carry variant is a useful diagnostic improvement, not a promotion:
  target-field VP rose to 13.50 with 4.50 kills/game, and direct hunter-vs-target
  reached 29.63 VP, 87.5% reach30, 15.75 PvP VP/game, and best Good target 17.
  It still failed the target-quality gate (`targetCreatesGoodCarry=false`,
  `hunterTargetFindsValuableGood=false`, `promotable=false`) and mixed league
  fell to 19.88 hunter VP, 12.5% reach30, best Good target 15. The dual-carry
  variant is rejected outright: 9.38 target-field VP, 25.13 direct hunter VP,
  12.75 mixed hunter VP, and no mixed Good-pivot VP. Do not add more carries as
  the next fix; the next lane should create pressure-state labels for a single
  Good carry that reaches the 18+ VP band while avoiding low-value support prey.
- A compact score-floor carry recovery probe confirms that near/low-tail samples
  without true 18+ VP successes are not enough. Local mining in
  `ml/meta_runs/scorefloor-carry-targetplanner-probe-20260701Tcont` produced
  159 near samples and 724 low-tail samples, but 0 success samples at the 18 VP
  target-quality threshold. A 4-epoch recovery checkpoint trained from that data
  reached only 10.50 VP in a 2-game target-field smoke, below the single-carry
  score-floor GPU target-field result of 13.50 VP. Do not scale this recovery
  dataset by itself; the next collector must capture actual 18-24 VP success
  prefixes from the Good carry, not just 15 VP near-misses and low tails.
- The score-floor carry success-prefix lane
  `ml/meta_runs/scorefloor-carry-successlane-20260701Tremote/summary.json`
  is accepted as target-quality progress but rejected as a meta promotion. It
  mined 1,388 success samples, 788 near-miss samples, and 2,350 low-tail samples
  from the score-floor carry/support field, then trained
  `resilient_goodbuilder_policy.json`. The trained planner target-field result
  improved to 16.25 VP, 75.0% win, 12.5% reach30, 5.75 kills/seat, status
  average 1.38, and no status-cap violations. Direct hunter-vs-trained-target
  stayed strong at 29.63 VP, 87.5% reach30, 16.13 PvP VP/game, and best Good
  target 18, proving the intended pivot from efficient Abyss farming into
  player attacks is still present. It is not enough, though: strict Good-pivot
  volume was only 0.38 VP/game, and the mixed candidate stack fell to 16.75
  hunter VP, 0% reach30, best Good target 12, and only 2.25 strict Good-pivot
  VP/game. Support seats also remained low-value prey. Treat this run as proof
  that true 18+ Good-carry prefixes can train a better scorer, not proof that
  the meta is solved. The next gate must improve mixed-league stability and
  repeated Good-player PvP conversion after monster EV drops, not just one best
  target sighting.
- The no-support isolation probe
  `ml/meta_runs/scorefloor-trained-nosupport-portfolio-20260701Tremote/summary.json`
  rejects the simplest "support prey is the whole problem" hypothesis. The
  stack `ml/stacks/league-current-scorefloor-trained-carry-no-support-hunter.json`
  replaced passive support with the trained resilient Good-builder plus the
  source score-floor carry. It still failed the role-portfolio gate:
  `solvedPortfolio=false`, best role `conversion` only 16.88 VP, 25.0%
  reach30, 8.63 PvP VP/game, 1.88 strict Good-pivot VP/game, and best Good
  target 14. The trained target planner scored only 9.00 VP in this no-support
  field, and all field roles stayed below the 15 VP floor; the source
  score-floor carry remained over-exposed at 8.81 conceded PvP share/seat.
  Conclusion: removing support prey is necessary cleanup, but not a solution.
  The next training lane must mine and train from actual mixed-pressure states
  where Good/non-Fallen builders keep scoring while hunters are present, then
  promote only if strict Good-pivot volume and best Good target both improve.
- The mixed-pressure Good-builder recovery lane
  `ml/meta_runs/mixed-pressure-goodbuilder-recovery-20260701Tremote/summary.json`
  is rejected as a promotion, but it confirms the acceptance criterion for the
  route. The collector mined 1,143 success samples, 621 near samples, and 4,983
  low-tail samples at the 13 VP recovery threshold, then warm-started from the
  success-prefix `resilient_goodbuilder_policy.json`. The trained target-field
  result stayed weak at 9.88 VP, 37.5% win, 0% reach30, 3.63 kills/seat, and 0
  PvP. Direct hunter-vs-trained-target pressure improved strict Good-player
  conversion to 26.13 hunter VP, 37.5% reach30, 18.75 PvP VP/game, 4.13 strict
  Good-pivot VP/game, and best Good target 14. That improvement did not survive
  the mixed league: the mixed candidate stack fell to 13.75 hunter VP, 0%
  reach30, 5.25 PvP VP/game, 0 strict Good-pivot VP, best PvP target 10, and
  best Good target 0. The trained candidate under mixed pressure averaged only
  9.42 VP despite 4.78 max expected attack and 4.17 Spirit Animals. Conclusion:
  mixed-pressure 13+ recovery rows can increase direct pivot volume, but they do
  not yet create valuable Good targets. The next lane must either mine true 18+
  mixed-pressure Good-builder prefixes or add counterfactual HP4 plateau labels
  for dice acquisition, restore timing, and safe Abyss re-entry. A meta candidate
  is not promotable unless it repeatedly converts from low-rung Abyss farming to
  valuable Good/non-Fallen player attacks once monster EV drops; best-target
  sightings and generic PvP VP are not enough.
- The follow-up HP4 conversion probes reject direct TraceQ fine-tuning as the
  next promotion lane and expose a field-construction trap. The wide score-floor
  HP4 conversion pass
  `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-wide-20260701Tremote/summary.json`
  found real counterfactual signal: 68 windows, 50 corrections, 886 samples,
  average correction delta +1.90 VP, mostly `restore-loop` and
  `hp4-survival-oracle`. Training all labels as a broad conversion overlay
  collapsed target-field scoring to 6.00 VP; direct hunter pressure still reached
  23.88 VP with 7.13 strict Good-pivot VP/game and best Good target 17, but mixed
  league fell to 13.25 VP, 0.38 strict Good-pivot VP/game, and best Good target 12. Filtering the train set to cash/restore/re-entry labels in
  `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-20260701Tremote/summary.json`
  kept 447/886 samples but did not fix target quality: target-field stayed 6.00
  VP, mixed hunter improved only to 15.13 VP, and best Good target stayed 12.
  A stricter state/action gate for `good-builder-hp4-conversion-overlay`
  (`VP>=8`, round `>=5`, HP4+, non-Fallen, and only Abyss/Lantern/Floral
  re-entry/restore/cash actions) is now in code and was checked in
  `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-gated-20260701Tremote/summary.json`;
  it still produced 6.00 target-field VP, 14.75 mixed hunter VP, 0.38 strict
  Good-pivot VP/game, and best Good target 12. A composition probe using the
  HP4-trained weights as the main policy while restoring the score-floor micro
  oracle also failed early:
  `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-mainmicro-20260701Tremote/summary.json`
  was stopped after a 7.38 VP target-field rejection. Finally, the raw control
  `ml/meta_runs/scorefloor-raw-threecopy-control-20260701Tremote/summary.json`
  ran the original score-floor success policy in the same three-identical-builder
  target field and also scored only 6.00 VP, with Tidal row0 overcontested at
  20.13 uses/game. Conclusion: do not use three identical Good-builder clones as
  the target-quality field. It creates a false low-tail/overcontest setting and
  teaches the wrong Tidal setup loop. Future target-quality evals must preserve
  role diversity and noncontest support/carry structure, then judge whether the
  carry reaches the 18+ VP band and whether hunters repeatedly pivot into those
  valuable Good/non-Fallen players.
- The diverse support-field HP4 conversion check
  `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-supportfield-20260701Tremote/summary.json`
  is the correct follow-up shape for those labels. It used the score-floor carry
  plus noncontest supports rather than three clones. In that field, the same
  cash/restore HP4 overlay preserved target quality: target-field VP was 16.50,
  win rate 75.0%, reach30 12.5%, 5.88 kills/game, status average 1.38, max
  status 2, and no status-cap violations. Direct hunter-vs-target remained at
  the success-lane level: 29.63 hunter VP, 87.5% reach30, 16.13 PvP VP/game,
  strict Good-pivot VP/game 0.38, and best Good target 18. Mixed league improved
  hunter VP from the score-floor success-lane baseline 16.75 to 17.38, but it
  did not improve the actual promotion gate: strict Good-pivot VP stayed 2.25
  and best Good target stayed 12. Conclusion: `TARGET_FIELD_MODE=scorefloor-carry-support`
  is now the right default for HP4 target-quality checks, and the HP4 overlay is
  not damaging in that field, but the meta is still not solved. The next lane
  must create or expose 18+ VP Good targets under mixed hunter pressure; simply
  improving target-field monster farming is insufficient.
- The target-exposure TraceQ probe
  `ml/meta_runs/target-exposure-scorefloor-hp4-supportpolicy-20260701Tremote/compact_summary.json`
  gives the first concrete label source for that next lane. It ran the
  score-floor carry plus HP4 cash/restore overlay policy from VP12-28,
  HP4+ Arcane Abyss states and compared forced exposure destinations. It found
  32 windows, 17 corrections, 17 samples, and 53.1% correction rate. Corrections
  were almost entirely `expose-lantern` (16) with one `expose-floral`; average
  raw VP delta was -1.19 and correction VP delta was 0, so this is not a direct
  score-improvement lane yet. But it created a large visibility signal:
  exposure-window delta 177 and average correction exposure VP 86.24, including
  repeated VP15 Lantern exposure rows and a VP23 Lantern exposure row. Treat this
  as a teacher-discovery artifact for "make valuable Good carries visible after
  Abyss farming." It should train/evaluate an exposure/navigation head only if
  the downstream mixed-league gate improves strict Good-pivot VP and best Good
  target; exposure labels alone are not promotion evidence.
- The first exposure-head follow-up
  `ml/meta_runs/target-exposure-scorefloor-hp4-supportpolicy-navtrain-20260701Tlocal/summary.json`
  is rejected. It trained a narrow `good-target-exposure` navigation patch from
  the 17 TraceQ samples (16 Lantern, 1 Floral) and evaluated it in the same
  support-field contract. Target-field VP fell from the support-field baseline
  16.50 to 14.25, direct hunter-vs-target stayed strong at 29.88 VP and 16.13
  PvP VP/game, and mixed hunter-vs-field stayed effectively flat at 17.13 VP,
  9.38 PvP VP/game, 2.25 strict Good-pivot VP/game, and best Good target 12. A
  quick `pvp-good-target-value-pivot` hunter gate smoke was worse: 9.88 VP and
  0.38 PvP VP/game, because it stayed in Abyss when the valuable Good target was
  not visible/predictable enough. The mixed exposure check was reproduced on the
  SimForge arc-bot workspace with `CUDA_VISIBLE_DEVICES=7` and matched the local
  result exactly (`remoteMatchesLocalMixed=true`). Conclusion: the strategic contract remains
  "farm Abyss until monster EV drops, then attack valuable Good/non-Fallen
  players," but this must be trained as a coordinated rendezvous problem. Do not
  promote or scale the 17-sample exposure head; mine paired target-exposure plus
  hunter-prediction labels where the Good carry reaches 18+ VP and the hunter
  actually converts those windows in mixed fields.
- The first real mixed-pressure rendezvous mining pass
  `ml/meta_runs/scorefloor-rendezvous-pressure-20260701Tremote/summary.json`
  used the score-floor carry/support/hunter field, stricter 18/15/14 VP
  thresholds, and the HP4 cash/restore overlay while mining from actual hunter
  pressure. This succeeded as a data miner: 1,375 success samples, 564 near-miss
  samples, 2,289 low-tail rows, and no pressure-fail rows. But full-policy
  fine-tuning was rejected. Target-field VP fell to 13.00, direct
  hunter-vs-target stayed strong at 28.92 VP but only found best Good target 12,
  and mixed hunter-vs-field was 19.75 VP with 1.50 strict Good-pivot VP/game and
  best Good target 12. The pressure-source baseline in the same run was 19.50
  VP, 1.75 Good-pivot VP/game, and best Good target 15, so the full fine-tune did
  not improve the actual rendezvous metric. Conclusion: the data miner is useful,
  but full-policy training over mixed-pressure rows still teaches too much
  low-value route drift/Tidal looping.
- A narrower success-only navigation patch from that same run,
  `ml/meta_runs/scorefloor-rendezvous-navpatch-20260701Tlocal/summary.json`,
  trained on only 284 `lockNavigation` success rows. It was less destructive than
  the full fine-tune but still rejected: target-field VP was 14.38, mixed hunter
  VP was 19.50, strict Good-pivot VP/game stayed 2.25, and best Good target
  stayed 12. It beat the older support mixed VP baseline but failed both stronger
  pressure-source comparison and the 18+ valuable-Good-target gate. The next
  attempt should not use raw high-tail imitation alone; it needs counterfactual
  labels for "which target route choice raises exposed Good target VP to 18+"
  and/or a route-mode target-quality head that explicitly optimizes future
  hunter-convertible Good VP rather than immediate route imitation.
- Target-quality TraceQ is now an explicit test lane rather than an inference
  from generic exposure. `src/lib/play/ml/_tracestatecounterfactual.test.ts`
  records `valuableGoodTarget*` metrics, weights them with
  `TRACEQ_SCORE_TARGET_QUALITY_*`, and can require
  `TRACEQ_REQUIRE_TARGET_QUALITY_DELTA=1`. The repeatable runner is
  `npm run bot:target-quality-traceq`, which wraps the SimForge GPU
  full-control runner and defaults to VP18+ Good/non-Fallen target exposure.
  A broad first run,
  `ml/meta_runs/target-quality-traceq-scorefloor-hp4-20260701Tlocal/compact_summary.json`,
  found 32 windows, 22 strict VP18+ target-quality corrections, 22 samples,
  68.8% correction rate, and mostly Lantern exposure. After fixing the remote
  `SOURCE_DESTINATION` forwarding/SSH quoting bug, the focused Arcane Abyss
  rerun
  `ml/meta_runs/target-quality-traceq-scorefloor-hp4-focused-20260701Tlocal/compact_summary.json`
  found 32 filtered HP4+ Abyss windows, 3 corrections, 3 samples, 9.4%
  correction rate, target-quality-window delta 43, and correction target-quality
  VP delta 53.67. The concrete pivot cases are VP23/monster HP5 -> expose
  Lantern and VP19/monster HP4 -> expose Floral/Lantern. Conclusion: the desired
  strategic handoff is real, but this exact filtered slice is too sparse for a
  direct navigation patch. Future promotion runs must either mine a larger
  target-quality corpus or add a target-quality/predicted-hunter-conversion
  auxiliary head; do not promote a target-quality patch unless mixed eval improves
  strict Good-pivot VP/game and best Good target above the current 12-15 band.
- The first automated target-quality patch lane is
  `npm run bot:target-quality-patch`, implemented by
  `scripts/run-arc-target-quality-patch-lane.sh`. It mines broad VP18+
  target-quality TraceQ rows, trains only if the sample floor is met, writes
  baseline/candidate target and mixed stack manifests, then evaluates target
  field, hunter-vs-target, and mixed hunter conversion in one artifact. The
  bounded SimForge GPU4 run
  `ml/meta_runs/target-quality-navpatch-eval-20260701Tlocal/summary.json` is
  rejected but informative. Its TraceQ shard had 32 windows, 22 corrections, 22
  samples, mostly Lantern (18) plus Floral (4), and 117.18 correction
  target-quality VP delta. The trained patch improved direct hunter strict
  Good-pivot VP from 0.38 to 4.50 while preserving direct hunter VP
  (29.63 -> 29.88), proving the label can create attack conversion. But it also
  damaged the Good carry target field (16.50 -> 14.25 VP, reach30 12.5% -> 0%)
  and the mixed eval still found only a 12-VP best Good target, so
  `promotable=false`. Conclusion: do not promote the one-sided nav patch. The
  next target-quality run must constrain exposure so it does not replace too much
  Abyss farming, or train paired target/hunter policies where the Good carry
  remains 18+ while the hunter learns to convert that specific exposure.
- The stricter VP18 exposure-gate rerun
  `ml/meta_runs/target-quality-navpatch-vp18gate-eval-20260701Tlocal/summary.json`
  reused the same trained patch with `SKIP_TRACE=1` and
  `ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP=18`. This reduced but did not remove the
  damage: target-field VP improved from the permissive patch's 14.25 to 15.50,
  but still missed the 16.50 no-patch baseline and still had 0% reach30. Direct
  hunter conversion remained useful but smaller than the permissive gate:
  strict Good-pivot VP was 2.63 and best Good target was 19. Mixed play still
  failed the real promotion gate: hunter VP 17.38, strict Good-pivot VP 2.25,
  best Good target 12, `mixedFindsValuableGood=false`, and `promotable=false`.
  Conclusion: the problem is not only early over-application. The target side
  needs a marginal farm-vs-expose value gate, and the hunter side needs paired
  rendezvous/conversion labels, because a stricter one-sided nav patch still
  does not make an 18+ Good target survive in mixed play.
- The farm-EV-gated VP18 rerun
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-eval-20260701Tlocal/summary.json`
  is the current cleanest test of the user's intended route contract: farm cheap
  multi-life Arcane Abyss monsters first, then attack valuable Good/non-Fallen
  players once monster reward EV drops. It reused the same patch with
  `ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP=18`,
  `ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP=1`, and
  `ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP=2`. This preserved the
  target field within tolerance (16.50 -> 16.25 VP, same max status cap) and
  kept direct hunter conversion strong (29.63 VP, 15.75 PvP VP/game, strict
  Good-pivot VP 0.38 -> 2.63, best Good target 18 -> 19). It is still rejected:
  mixed play stayed at hunter VP 17.38, strict Good-pivot VP 2.25, best Good
  target 12, `mixedFindsValuableGood=false`, and `promotable=false`. Conclusion:
  the local farm-vs-expose gate is now pointed in the right direction, but the
  full meta is not solved until mixed fields create durable 18+ Good targets and
  hunters reliably convert those targets instead of farming weak support seats.
- `scripts/run-arc-target-quality-patch-lane.sh` now exposes
  `MIXED_FIELD_MODE` plus hunter-side PvP threshold knobs, so mixed failures can
  be separated into composition, target protection, and conversion problems. The
  `candidate-baseline-carry` composition probe
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-eval-20260701Tlocal/summary.json`
  replaced the weak support seat with a second Good carry. It did not solve the
  handoff: mixed hunter VP fell to 15.25, PvP VP 5.63, strict Good-pivot VP
  0.75, best Good target 12, and `promotable=false`. The candidate and baseline
  Good carries averaged only 9.25 and 9.38 VP under mixed pressure, so weak
  support-seat dilution is not the only cause.
- The strict high-value hunter probe
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-highvaluehunter-eval-20260701Tlocal/summary.json`
  used `MIXED_FIELD_MODE=candidate-baseline-carry`,
  `HUNTER_MICRO_GATE=pvp-high-value-encounter-force`,
  `HUNTER_PVP_ORACLE=status2-target-descend`, and 18-VP hunter target thresholds.
  It is rejected harder: direct hunter-vs-candidate fell to 14.13 VP with 0 PvP
  VP, mixed hunter fell to 8.63 VP with 0 PvP VP, and best Good target stayed 12. Because the mixed Good carries still averaged only 8.75 and 8.63 VP with
  zero PvP target combats, hard target protection does not create the valuable
  Good target. The next accepted lane must handle contested monster-resource
  pressure and paired target/hunter timing, not merely delay PvP until 18+ VP.
- The soft-value hunter probes confirm the intended strategic contract but not
  the current implementation. With `HUNTER_PATCH_GATE=pvp-good-target-value-pivot`
  and soft 12-VP target thresholds,
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvaluehunter-eval-20260701Tlocal/summary.json`
  and
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvalue-conversion-eval-20260701Tlocal/summary.json`
  both recovered direct hunter conversion to 24.00 VP, 10.13 PvP VP/game, and
  best Good target 21, but mixed play still stayed at 8.38 hunter VP, 0 PvP VP,
  0 strict Good-pivot VP, and best Good target 0. Lowering the soft target
  threshold to 9 in
  `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvalue9-conversion-eval-20260701Tlocal/summary.json`
  improved direct conversion again (27.38 VP, 13.50 PvP VP/game, strict
  Good-pivot VP 3.00, best Good target 21), while mixed play remained unchanged
  at 8.38 hunter VP, 0 PvP VP, and best Good target 0. Conclusion: threshold
  tuning can make a hunter punish one valuable Good player, but it does not yet
  produce the full route of farming cheap Abyss lives, letting a Good/non-Fallen
  carry become valuable, and then pivoting into that player once monsters become
  inefficient. The next lane needs mixed-state target creation/rendezvous labels
  or predicted-destination policy, not another scalar PvP threshold.
- `good-target-rendezvous-exposure` now makes the Good target exposure gate use
  the same predicted destination ranking that the hunter uses. This did not help
  the over-huntered `candidate-baseline-carry` field:
  `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-softvalue9-eval-20260701Tlocal/summary.json`
  preserved target quality and direct conversion but mixed stayed 8.38 VP with
  0 PvP VP, while the VP12 variant
  `ml/meta_runs/target-quality-rendezvous-vp12-farmev1-softvalue9-eval-20260701Tlocal/summary.json`
  improved direct Good-pivot VP to 6.00 but still had 0 mixed PvP and failed
  target preservation. The key positive result came from the new
  `MIXED_FIELD_MODE=single-hunter-baseline-carry`: the 8-game run
  `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-singlehunter-softvalue9-eval-20260701Tlocal/summary.json`
  promoted with mixed 21.75 VP, 12.00 PvP VP/game, 62.5% reach30, and best Good
  target 22. A larger mixed-only confirmation
  `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-singlehunter-softvalue9-eval-20260701Tlocal/hunter_vs_candidate_mixed_g32.json`
  regressed to 17.06 VP, 7.88 PvP VP/game, 40.6% reach30, and repeated 6-9 VP
  low tails. Conclusion: the old zero-PvP mixed failure was partly an
  over-huntered field artifact, but the meta is still unsolved. Promotion now
  requires both a realistic field-composition gate and a larger mixed run that
  removes the low-tail route collapses, not just an 8-game positive slice.
- The low-tail Good-player hunt patch turns those route collapses into explicit
  player attacks. `src/lib/play/ml/selfplay.ts` now supports
  `ARC_PVP_LOW_TAIL_HUNT_*` knobs for `pvp-good-target-value-pivot`: once the
  hunter is Fallen, low-VP, past the configured round, and the monster is HP4+,
  it may blind-cycle likely Good-player destinations unless a cheap multi-life
  Abyss reward or reliable monster finish is still better. The paired lane
  `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-singlehunter-lowtail12-eval-20260701Tlocal/summary.json`
  used `HUNTER_LOW_TAIL_HUNT_MAX_VP=12`,
  `HUNTER_LOW_TAIL_HUNT_MIN_ROUND=10`, and
  `HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP=4`. The 8-game mixed slice improved to
  29.25 VP, 19.50 PvP VP/game, 5.63 strict Good-pivot VP/game, best Good target
  22, 87.5% reach30, and `promotable=true`. The larger mixed-only confirmation
  `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-singlehunter-lowtail12-eval-20260701Tlocal/hunter_vs_candidate_mixed_g32.json`
  held at 29.06 VP, 19.88 PvP VP/game, 5.81 strict Good-pivot VP/game, best
  Good target 22, 91% reach30, and 0% missed PvP opportunities. This validates
  the route contract for the current single-hunter test field: farm efficient
  low-rung Abyss lives first, then pivot into Good-player attacks once monster EV
  drops or clean farming stalls. It is a strong promotion candidate for the PvP
  pivot gate, but still needs role-portfolio and dashboard comparison before
  calling the whole meta solved.
- If a run claims the meta is close to solved, it must also pass
  `npm run bot:role-portfolio` or an equivalent larger role-portfolio run:
  `solvedPortfolio=true`, no weak planner roles below the VP floor, no weak stack
  roles below the VP floor, no over-exposed stack roles, and exploit gap within
  threshold.
- The first role-portfolio check after the low-tail Good-player hunt patch
  failed, even though the hunter itself is strong. In
  `ml/meta_runs/role-portfolio-lowtail12-singlehunter-20260701Tlocal/summary.json`,
  the current/conversion hunters reached 30 VP with 20.25 PvP VP/game, but
  `target` averaged 12.63 VP and `pure` averaged 10.88 VP, so
  `solvedPortfolio=false`. Follow-up target-only traces
  `ml/meta_runs/role-portfolio-hp4survival-target-20260701Tlocal`,
  `ml/meta_runs/role-portfolio-relicguard-target-20260701Tlocal`, and
  `ml/meta_runs/role-portfolio-cult2lantern-target-20260701Tlocal` showed the
  same 12.88 VP target average. The patches improved diagnostics and route
  hygiene (relics are better preserved for Tidal Support/Cultivator trades, and
  2-Cultivator states can see Lantern conversion), but they did not lift the
  Good/non-Fallen scoring route above the floor. Do not mark the meta solved
  until a Good/Pure score-floor lane learns the HP4/HP5 conversion: 4-5 reliable
  damage, max/current barrier conversion, and timely Abyss re-entry.
- The July 1 PvP-pivot curriculum filter comparison confirms that unrestricted
  bots must explicitly pivot from monster farming into Good-player attacks after
  the monster route gets inefficient. The runner now supports
  `TRAIN_SAMPLE_FILTER`; the accepted smoke is
  `ml/meta_runs/pvp-pivot-filter-nobuild-20260701Tlocalremote/summary.json`.
  It kept 210/271 samples, excluding only `pvp-build-nav`, and passed the lane
  verdict: role-stack VP 15.75 -> 20.13, role-stack PvP VP/game 7.50 -> 8.63,
  best role-stack PvP target 9 -> 12, score-floor-target VP 20.75 -> 30.00,
  score-floor-target PvP VP/game 15.00 -> 22.13, and 0% missed PvP windows.
  The rejected filters are useful guardrails: `hunt-attack-farmreturn` regressed
  to 11.75 role-stack VP / 3.00 PvP VP, and `late-only` regressed to 15.25 /
  4.13. Promotion rule: keep `no-build` as the focused PvP conversion recipe,
  but require a larger role-portfolio confirmation before calling the meta
  solved.
- If a run uses Good-player target fields, it must declare the target status
  contract: strict-Pure (`maxStatusLevel=0`) or non-Fallen Good
  (`maxStatusLevel=2`). Non-Fallen lanes must report status average, max status,
  and status-cap violations, because status 1/2 players are still legal Good
  targets but status 3/Fallen players are not.
- The July 1 continuation portfolio with the promoted PvP `no-build` checkpoint
  confirms the route contract but does not solve the meta:
  `ml/meta_runs/role-portfolio-pvp-nobuild-20260701Tcont/summary.json` reported
  `farmToPvpConversionPresent=true` and 0% missed PvP windows, but
  `solvedPortfolio=false`. `current` and `conversion` reached only 20.13 VP
  with 8.63 PvP VP/game, while the Good/non-Fallen `target` role reached 9.75
  VP and the strict-Pure role reached 7.13 VP. This is the current gate: the bot
  must first farm efficient low-rung multi-life Abyss rewards, then pivot into
  Good-player attacks after monster EV drops, and the Good/Pure target roles must
  be strong enough to create real targets for that pivot.
- Do not spend the next lane on another broad learned HP4 micro overlay. Both
  `ml/meta_runs/nonfallen-hp4-scorefloor-arb-existing-20260701Tcont/summary.json`
  and
  `ml/meta_runs/nonfallen-hp4-scorefloor-oracle-train-20260701Tcont/summary.json`
  found TraceQ corrections in every sampled window, but the target field still
  averaged 5.88 VP and the verdict stayed non-promotable. The next gate should
  focus on target-quality, leaving/re-entering Abyss, reward conversion, and
  paired hunter/target rendezvous rather than another wide action overlay.
- Local target diagnostics after that rejection are not promotion evidence, but
  they identify the next failure shape. The baseline 2-game target trace
  `ml/meta_runs/target-role-trace-local-20260701Tcont/result.json` averaged 6
  VP, 2 monster kills, and 2 Abyss navs. Enabling controlled non-Fallen corrupt
  farming plus stricter restore gating
  (`ml/meta_runs/target-role-trace-local-controlled-restoregate-20260701Tcont/result.json`)
  reached only 9.5 VP, 3.5 kills, and status 2. A tiny legal beam
  `ml/meta_runs/routeoracle-nonfallen-small-local-20260701Tcont/summary.json`
  reached 15 VP and 5 kills before decision budget, with frontier reasons
  `current-barrier-deficit`, `firepower-ready-but-not-clean`, and
  `insufficient-remaining-reward-vp`. Treat this as a route-label problem:
  Good/non-Fallen targets must learn HP4/HP5 barrier restoration and final
  reward conversion before the PvP hunter can be judged fairly.
- The GPU target-only follow-up
  `ml/meta_runs/role-target-controlled-restoregate-20260701Tcont/summary.json`
  is a partial positive but still rejected. Controlled non-Fallen farming lifted
  the target role from 9.75 VP in the portfolio to 13.88 VP with 5.25 monster
  kills, 7.50 Abyss navs, status 2, and no status-cap violations, but it failed
  the 15 VP floor and had 0% reach30. Keep the status-2 farming option available
  as a labeled lane, but do not promote it as the Good-target solution.
- Its run directory includes config, logs, checkpoint weights, evaluation JSON, and enough metadata to reproduce the run.
- Browser/dashboard verification can display the run and compare it against at least one previous run or balance patch.

Every final report should include:

- repo path and commit/hash or rsync source,
- host and GPU id,
- command lines,
- `RUN_ID`,
- output artifact paths,
- one sentence on what passed,
- one sentence on remaining risk.
