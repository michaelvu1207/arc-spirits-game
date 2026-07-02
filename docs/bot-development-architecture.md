# Arc Spirits Bot Development Architecture

This repo should treat bot development as a product surface, not a pile of one-off scripts. The organizing rule is:

> The game engine owns the rules. Bots receive a versioned observation plus legal actions and return one legal action id.

## Repository Strategy

Keep one repository for now.

- The game reducer, legal action surface, encoders, bundled inference, live room bot driver, and dashboard should stay together while the rules are still changing quickly.
- Use the SimForge GPU box workspace as a synced training checkout, not as a second source of truth.
- Split a second repository later only when outside contributors need to build bots without the full SvelteKit app. At that point publish a small package containing `arc-bot-v1`, catalog snapshots, fixtures, and a CLI runner.

Recommended future split:

- `arc-spirits-game`: app, reducer, catalog, Supabase, live play, dashboard, authoritative bot contract.
- `arc-spirits-bot-lab`: optional external training playground that consumes exported contract fixtures and submits checkpoints/run artifacts back to the game repo.

## Training Strategy

We should not treat Arc Spirits bot development as "train one model from general
self-play and hope it discovers everything." The current system is a reasonable
bootstrap stack: heuristic/self-play data, AlphaZero-ish planner targets,
one-step candidate scoring, a value head, and local diagnostics/oracles. That is
not enough for discovering the best strategies in a complex multiplayer game.

The target architecture is layered:

1. Rule-perfect simulator. The reducer, legal action surface, catalog snapshots,
   and deterministic fixtures are the foundation. No model can fix a bad
   simulator or an incomplete action contract.
2. Search/planning. Use MCTS/ISMCTS or AlphaZero-style search over navigation
   and key tactical decisions so medium-horizon plans like low-rung multi-life
   Abyss farming are visible.
3. Self-play reinforcement learning. Train from many games, but with auxiliary
   heads and shaped targets so the model does not miss obvious medium-term value.
4. Curriculum. Generate legal-prefix states for early farmable monsters,
   low-rung multi-life Abyss, reward-pick decisions, farm-vs-build crossroads,
   and farm-vs-race-pressure states.
5. League training. Keep historical checkpoints and named strategies in a
   population. New candidates must beat the current champion, not forget known
   counters, and survive focused direct duels.
6. Evolution/population search. Use sweeps for hyperparameters, reward-shaping
   weights, curriculum mixes, strategy diversity, and search budgets. Evolution
   complements RL; it does not replace it.
7. Dashboard evaluation. Every run should produce strategy landscape data:
   units/classes, reward sources, farms missed, counters, exploitability,
   checkpoint Elo, and balance deltas.

The immediate model direction is:

```text
AlphaZero-style self-play
+ auxiliary farm-value head
+ explicit reward-pick policy head
+ explicit farm-to-PvP target-quality evaluation
+ league opponents
+ curriculum states
+ evolutionary sweeps over training/search parameters
+ dashboard evaluation
```

For unrestricted bots, "best strategy" does not mean staying in Arcane Abyss
forever. The route contract is efficient early monster farming, then a learned
pivot into attacking valuable Good players when the current monster rung is too
low-value, too contested, or no longer cleanly survivable.

That pivot is only legal after a player is Evil/Fallen. Pure and non-Fallen
score-floor lanes are still important route-proof benchmarks, but they are not
the unrestricted champion lane. The unrestricted lane should explicitly learn:

```text
farm low-rung multi-life Abyss VP
+ build enough damage/barrier for HP4 pressure
+ descend when the monster route is no longer the best expected VP path
+ hunt Good players at non-Abyss locations
+ take every legal HP4+ PvP attack window unless a terminal win is already secured
```

July 1, 2026 evidence: the current hunter conversion lane can cash this pivot in
small GPU smokes (21.25 VP with 9.75 PvP VP/game and 0% missed PvP opportunities
against fixed score-floor targets), but the Good/Pure score-floor lane still
fails as a general champion proxy. It farms weakly, often remains passive, and
does not reliably reach true farm-to-Fallen-to-PvP conversion states without a
dedicated conversion curriculum.

The first concrete contract for that lane is now implemented:

- `src/lib/play/ml/auxTargets.ts` writes a state-level `farmValue` target on
  recorded samples and, when the state is resolving a monster reward, a
  candidate-level `rewardPi` target weighted by immediate VP from legal reward
  choices.
- `src/lib/play/ml/driver.ts` and `src/lib/play/ml/selfplay.ts` both use that
  shared target builder, so heuristic bootstrap data and AlphaZero self-play data
  speak the same sample format.
- `ml/model.py` has optional `farm_value_head` and `reward_pick_head` modules.
  `ml/train.py` trains them only when `--farm-value-coef` and
  `--reward-pick-coef` are nonzero, keeping old runs reproducible by default.
- Exported checkpoints include `farm_value`, `reward_pick`, and `aux_heads`
  metadata. TypeScript inference ignores those training-only fields and still
  consumes the normal candidate scorer/value head.
- `ml/discover_meta.sh` exposes the same knobs as
  `FARM_VALUE_COEF`/`AZ_FARM_VALUE_COEF` and
  `REWARD_PICK_COEF`/`AZ_REWARD_PICK_COEF`, and records them in run metadata.

Pure heuristic bots are not the end state, but they should not be deleted yet.
They are sparring partners, teacher policies, sanity baselines, and regression
tests. Remove them from live product selection; keep them in research harnesses
until learned populations consistently beat them across meta, arena, league,
and curriculum gates.

## Current Code Map

| Area                 | Path                                                                         | Role                                                                          |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Authoritative rules  | `src/lib/play/runtime.ts`, `src/lib/play/phases.ts`, `src/lib/play/types.ts` | Pure reducer, phase machine, command/state types                              |
| Live multiplayer     | `src/lib/play/server/`                                                       | Supabase sessions, ranked/casual rooms, bot ticking                           |
| Bot contract         | `src/lib/play/bots/contract.ts`                                              | `arc-bot-v1`, legal action ids, observations, decisions, live bot profile key |
| Legal action surface | `src/lib/play/ml/actions.ts`                                                 | Enumerates real game commands and filters them through the reducer            |
| TS inference         | `src/lib/play/ml/net.ts`, `src/lib/play/ml/neuralBot.ts`                     | Loads exported weights and chooses legal actions for live bots/eval           |
| Training targets     | `src/lib/play/ml/auxTargets.ts`, `src/lib/play/ml/farmValue.ts`              | Farm-value and reward-pick auxiliary targets for samples/dashboard metrics    |
| Python training      | `ml/model.py`, `ml/train.py`                                                 | PyTorch policy/value/aux-head training, exports JSON weights                  |
| Meta discovery       | `ml/discover_meta.sh`, `src/lib/play/ml/_az*.test.ts`                        | AlphaZero-style self-play/planner smoke and league experiments                |
| Route proof          | `scripts/run-arc-route-proof-matrix.sh`, `scripts/run-arc-routeexecq-fullcontrol.sh`, `src/lib/play/ml/_routeexecutioncounterfactual.test.ts`, `src/lib/play/ml/_scalingnavigationcounterfactual.test.ts` | Pure/economy proof matrix, row-exec counterfactuals, scaling-navigation counterfactuals, and gated specialist diagnostics |
| Testing gates        | `scripts/bot-test-gate.mjs`, `docs/bot-testing-criteria.md`                  | Local, Browser, and GPU acceptance commands                                   |
| GPU sync             | `scripts/sync-arc-bot-to-gpu.sh`, `scripts/arc-bot-gpu-preflight.sh`         | SimForge workspace refresh and safety checks                                  |
| Browser gate         | `e2e/play-p0.spec.ts`, `e2e/mobile-perf-smoke.spec.ts`, `e2e/helpers.ts`      | Real room sync, cookie/member identity, mobile hydration/perf smoke           |

## Live Bot Policy

Live room bots should no longer be selected from heuristic difficulty names. The only public live bot profile is:

```text
neural
```

That key is defined in `src/lib/play/bots/contract.ts`. Old profile strings such as `medium`, `fast`, `pvphunter`, or `culrush` normalize to `neural` at the live-room boundary.

The old heuristic planner in `src/lib/play/server/botPolicy.ts` is now legacy research scaffolding. It can still be useful for historical baseline tests and cold-start comparisons, but it should not be the live product path.

Current practical compromise: live bot creation normalizes public profile names to
`neural`, while research tests may still import heuristic profiles as baselines or
training opponents. Delete those baselines only after the ML league has a
non-heuristic cold-start path with equal or better coverage.

The AlphaZero meta loop has two control modes:

- `AZ_CONTROL=navigation`: historical mode. MCTS owns navigation only; within-round
  execution is delegated to a profile executor.
- `AZ_CONTROL=full`: current experimental meta-learning mode. Navigation still gets
  MCTS visit targets, and planner seats choose every other legal command with the
  neural candidate policy/value lookahead. This produces training signal for market,
  combat, reward, encounter, awakening, and cleanup decisions.

Use `navigation` only when reproducing older runs. Use `full` for any claim about bots
discovering complete strategies by themselves.

Full-control has multiple non-navigation selectors:

- `AZ_FULL_SELECTION=value`: current strongest competitive checkpoint. Scores each legal
  command with one-ply value/shaping from the resulting state.
- `AZ_FULL_SELECTION=hybrid`: policy-first selector with hard tactical VP/PvP grabs. It
  lowers corruption in some probes but currently underperforms on VP.
- `AZ_FULL_SELECTION=lookahead`: bounded sequence-aware selector. It evaluates all root
  legal commands shallowly, then expands only the best root/child beams using
  `AZ_FULL_LOOKAHEAD_DEPTH`, `AZ_FULL_LOOKAHEAD_BEAM`, and
  `AZ_FULL_LOOKAHEAD_ROOT_BEAM`. Use it for the next algorithmic lane when one-ply
  full-control plateaus.

Full-control AlphaZero training can write either hard or soft policy targets for
non-navigation decisions:

- `AZ_FULL_TARGET_TEMP` controls the softmax temperature used to convert value or
  lookahead scores into the stored `pi` target. Lower values approach one-hot
  imitation; higher values teach broader action rankings.
- The soft-target lane is now a serious contender. The first `0.5` soft-target
  checkpoint beat the previous champion in direct learned-policy duels, and its
  continuation won the top-three direct AlphaZero duel. It still underperforms on
  sampled/deterministic meta scores, so treat it as a league leader rather than a
  solved champion.

Full-control AlphaZero can also train against a frozen learned-policy pool:

- `AZ_POLICY_POOL` is a comma-separated list of checkpoint files used as opponent
  policies.
- In policy-pool mode, all seats still use the full-command planner path, but only
  the rotating learner seat is written as training data. This avoids contaminating
  the learner target with frozen opponent moves.
- `AZ_POLICY_POOL_MIX` controls how much of a generation pass uses the frozen pool.
  `1` means pool-only learner-seat targets; `0.5` mixes pool games with normal
  all-seat self-play targets to reduce overfitting to the frozen population.
- Use policy-pool runs to test exploitability and robustness against known learned
  strategies. Do not promote a policy-pool checkpoint unless it also wins direct
  `AZDUEL` against the current learned leader.

Full-control also supports controlled ablations for balance diagnosis:

- `AZ_FORBID_TYPES` removes command types from planner-seat legal actions, for
  example `AZ_FORBID_TYPES=initiatePvp` to test a no-PvP lane.
- `AZ_MAX_STATUS_LEVEL` rejects planner-seat actions whose resulting state exceeds
  the given status level, for example `AZ_MAX_STATUS_LEVEL=0` for Pure-only
  self-play/eval. Test-specific forms are `AZMETA_*` and `AZEVAL_*`.

These knobs are not balance patches; they are measurement tools. Use them to ask
whether a suspected strategy is structurally necessary, then compare against the
unrestricted champion before changing rules.

Current evidence from the June 27, 2026 GPU pass: the meta is not solved. The
previous unrestricted full-control champion
`ml/meta_runs/full-control-extend-g6-20260627T084758Z/best_policy.json` still has
the best deterministic/sampled meta balance among the early gates, but it lost in
direct learned-policy checks. The current direct-duel leader is
`ml/meta_runs/softpi-continue-g5-20260627T124642Z/best_policy.json`; it won the
top-three AlphaZero duel at 43.8% win rate, 11.27 avg VP, and 1.79 avg place
against `softpi` and the previous champion. Its full gate was strong against the
heuristic field at 82.5% arena win / 19.63 planner VP, but weaker in deterministic
meta at 7.78 VP and sampled meta at 4.67 VP.

A no-PvP probe still converged to high-status `fallen-corruption` through
monster/combat play, and a Pure-only training lane collapsed to 6.3% arena win /
2.81 planner VP after one iteration. That suggests corruption pressure is the
discovered dominant path under the current rules; Pure-only economy is not
competitive yet.

The June 27, 2026 Abyss sanity pass sharpened that diagnosis. A strong heuristic
farm baseline (`godly`) averaged 12.8 VP from monster rewards with 4.40 kills/game
and no PvP in a fresh 8-game VP-source audit. The current learned leader,
`softpi-continue-g5-20260627T124642Z`, can score when forcibly routed to the
Abyss: forced-Abyss eval reached 19.5 VP, 6.75 kills/game, and 75.0% win. But it
did this with average status 3, and the Pure-only forced-Abyss diagnostic
collapsed to 0.75 VP, 0.25 kills/game, and 0% win. Conclusion: the learned
controller has not discovered the clean non-corrupt monster/economy line; current
strength still depends on corruption.

This exposes a scoring boundary in full-control ML: `startCombat` creates
`pendingReward` but does not immediately add VP. `resolveMonsterReward` is the
action that lands the points. One-ply value selection must credit the claimable
VP in a newly pending reward, otherwise a killing combat can look like a low-value
action even though the next command cashes it.

The first mixed-opponent policy-pool runs did not dethrone `softpi-continued`.
`policy-pool-g7-20260627T134916Z` trained one learner seat against frozen
`champion`, `softpi`, and `softpi-continued` policies. Its best checkpoint improved
over `softpi` and `champion` in the four-way direct duel, but still lost to
`softpi-continued`: 27.5% win for policy-pool best versus 37.5% for
`softpi-continued`. Additional pool iterations lowered training loss while
regressing meta and arena strength, and a conservative one-step lower-LR pool
update still had weak meta strength.

The first mixed self-play/pool-play run
`policy-pool-mix-g6-20260627T142617Z` was stronger: it reached 9.13 deterministic
meta VP and won a four-way direct duel at 40.0% versus `softpi-continued` at 35.0%.
However, the focused 60-game duel reversed the signal: `softpi-continued` beat
`mix` 27.5% to 22.5% with higher VP. That makes `AZ_POLICY_POOL_MIX` promising
but not solved.

The first AlphaZero population matrix,
`ml/meta_runs/azleague-top5-20260627T150358Z/azleague.json`, rated the top five
candidate checkpoints through focused pairwise full-command duels. It ranked
`softpi-continued` first at Elo 1074 and 65.6% team-VP win rate. The old champion
fell to last at Elo 944. The middle of the table still has counter-matchups:
`poolbest` countered `softpi`, `softpi` edged `mix`, and `mix` remains closer to
the leader in broad games than in focused games. Current promotion rule: a new
candidate must lead the population matrix and not lose a focused direct duel
against `softpi-continued`.

The June 27 seeded-shard pass fixed two important measurement bugs before running
more GPU work:

- `ml/run_gen.sh` and `ml/league_gen.sh` were still writing `obs_dim=48` and
  `act_dim=40`. The current encoder contract is `62/52` after the June 29
  damage-contract bump.
- `_azgen` did not accept a shard seed offset, so sharded AlphaZero generation
  replayed duplicate games. `AZ_SEED0` now controls the game seed base, and
  `ml/discover_meta.sh` / `ml/az_loop.sh` set a unique seed per iteration and
  shard.

The corrected continuation run
`ml/meta_runs/az-cont-seeded-g6-20260627T160800Z` generated non-duplicate
full-control AlphaZero data: 58,195 samples in iteration 1, 56,534 in iteration
2, and 53,721 in iteration 3. It still did not solve the meta. Its best
all-planner checkpoint was iteration 3 at 8.41 average VP, 0% reach30, 2.84
average status, and `fallen-corruption` strategy inference. Arena results
against `pvphunter,medium,cultivator,survivor,paragon` stayed strong but
corruption-heavy: iteration 2 reached 87.5% win, 21.54 VP, 20.8% reach30, and
2.88 average status; iteration 3 reached 87.5% win, 20.17 VP, 25.0% reach30,
and 2.92 average status. Verdict: the current learned bot can beat the fixed
heuristic field, but it is not globally solved and not clean.

The Pure AWR/BC bootstrap
`ml/meta_runs/pure-bc-awr-g5-20260627T160014Z` generated 32,093 constrained
paragon samples and trained to 0.827 top-1 accuracy. Selection-matrix eval showed
the model learned fragments, not a scoring strategy. With `GEN/EVAL_FORBID`
`initiatePvp` and `maxStatusLevel=0`, policy selection averaged only 0.92-1.17
VP across fields, value selection averaged 0 VP, and hybrid selection improved
to 3.79 VP vs mixed, 4.50 VP vs `pvphunter`, and 4.83 VP vs `paragon`. That is
still far below the heuristic clean baseline, so Pure ML needs sequence-aware
teacher/search targets rather than more plain BC.

Next algorithmic lane: train/evaluate Pure and unrestricted candidates with
`AZ_FULL_SELECTION=lookahead` or another sequence-aware non-navigation teacher.
One-ply value is plateauing: it can cash obvious VP and corruption pressure, but
it does not learn the long build sequence needed for clean economy.

The first bounded lookahead lane,
`ml/meta_runs/lookahead-d1-g5-20260627T165133Z`, tested that hypothesis with
`AZ_FULL_SELECTION=lookahead`, depth 1, beam 4, root beam 8, two iterations, and
the seeded full-control champion as init weights. It did not beat one-ply value.
Best all-planner meta was 7.69 VP, 0% reach30, 2.90 average status, and
`fallen-corruption`. Arena eval still beat the fixed heuristic field but remained
corruption-dependent: iteration 1 had 93.8% win / 19.19 VP / 25.0% reach30 /
2.81 status; iteration 2 had 75.0% win / 21.44 VP / 18.8% reach30 / 3.00 status.
Conclusion: shallow sequence lookahead alone is not enough. The next lane should
change the training target or curriculum, not just increase this exact depth-1
selector.

The failed Pure hybrid lane exposed a separate harness bug. In
`ml/meta_runs/pure-hybrid-az-g6-20260627T170502Z`, the Pure constrained
hybrid selector stayed non-corrupt but spent thousands of decisions on
`refillMarket`, with almost no combat or monster reward claims. Root cause:
`refillMarket` is a legal location command even when it only changes table state,
while the previous material-progress signature did not treat `phaseReady`,
pending rewards/draw queues, action-use gates, or real player-material changes
as part of progress. That let selectors confuse legal table churn with strategic
movement and made low VP look like a learning failure.

The current recovery decision is to keep the full legal action contract, but make
bot selectors progress-aware:

- `materialSig` tracks phase readiness, navigation lock/destination, pending
  rewards/draws, action-use gates, spirit identity/composition, dice tiers, mats,
  augments, and monster HP/lives, while intentionally ignoring market contents.
- `scoreByValue` and bounded lookahead credit claimable pending monster-reward VP,
  so `startCombat -> pendingReward -> resolveMonsterReward` is visible to a
  one-ply teacher.
- `policy`, `hybrid`, `value`, `lookahead`, and live neural selection prefer progress
  candidates over non-progress candidates whenever a meaningful action exists.
  `refillMarket` remains legal and observable, but it should no longer dominate
  decision counts in normal meta runs.

This does not prove Pure/economy is solved. It only repairs the measurement
boundary so the next Pure/economy curriculum or GPU run is answering the real
question. Before any long run, pass the no-op/progress selector gate in
`docs/bot-testing-criteria.md` and inspect generated decision-type counts for
market-refill dominance.

Post-fix probe evidence:

- `ml/meta_runs/noop-guard-probe-20260627T174200Z/meta_purehybrid_postfix.json`
  reran the previous Pure hybrid checkpoint after the progress guard. Average VP
  stayed bad at 0.38, but `refillMarket` disappeared from the top decision
  counts. The policy chose almost no Abyss route: 0.13 Abyss navigations,
  combats, and kills per seat-game.
- `ml/meta_runs/noop-guard-probe-20260627T174200Z/meta_purehybrid_forced_abyss_postfix.json`
  forced every planner seat to Arcane Abyss for all 30 rounds. Average VP rose
  only to 1.50. The bot started 16 combats and claimed 8 monster rewards across
  16 seat-games, with almost no attack dice. Conclusion: the Pure hybrid
  checkpoint is not merely choosing the wrong destination; it also fails to
  execute a competent farm sequence when placed at the Abyss.
- A local 8-game VP-source audit with `godly,medium,cultivator,pvphunter`
  baselines produced non-PvP monster-reward averages of 8.75-9.13 VP for
  `godly`/`medium`, while `pvphunter` reached 28.5 VP through 18.38 PvP VP and
  10.13 monster-reward VP per game. Use this as a sanity anchor: learned Pure
  policies near 0-2 VP are genuinely failing, but a clean farm baseline should
  be measured from VP-source artifacts rather than assumed to be 15 VP by round
  10.
- The deterministic blind-Abyss route harness
  `src/lib/play/ml/_abyssroute.test.ts` answered the owner's concrete
  expectation check. Over 8 games, forcing every seat to Arcane Abyss and
  injecting 0/1/2 arcane attack dice scored 3.47/6.72/7.38 VP per seat-game.
  All variants ended at status 3 around round 5-6. That means the engine is not
  accidentally hiding 30 VP from a trivial early farm line; the missing learned
  skill is the longer barrier/damage/reward economy sequence.
- The same harness can now inject prebuilt route states with
  `ABYSSROUTE_MAX_BARRIERS`, `ABYSSROUTE_SPIRIT_ANIMALS`, and `ABYSSROUTE_OUT`.
  This separates rules feasibility from training discovery. A literal
  "one or two Spirit Animals, no extra build" probe scored only 4.08 VP with
  2 Spirit Animal traits and default barrier. But the mature build probe
  reached the owner's expected scoring neighborhood: 2 Spirit Animal traits,
  10 arcane dice, and 20 max barrier averaged 29.63 VP, 8.10 kills, and
  29.63 reward VP per seat-game. Conclusion: the game can support a high-scoring
  monster-farm route, but current ML does not discover the build/timing path.
- The first Abyss curriculum lane converted those mature farm states into normal
  `obs/cands/chosen/pi/ret` JSONL through `src/lib/play/ml/_abysscurriculum.test.ts`.
  A 6-game-per-build dataset over 6/10 arcane dice, 12/16/20 max barrier, and
  2 Spirit Animal traits produced 6,348 samples. A curriculum-only checkpoint
  reached 98.6% top-1 label accuracy and executed the prebuilt farm slice at
  28.63 average VP, proving the contract can learn the micro-route from data.
  But normal-start forced-Abyss eval stayed weak at 10.5 VP and status 3.
- Fine-tuning Act52 directly on the curriculum is not a promotion path. Full
  curriculum fine-tune improved the prebuilt slice to 28.66 VP but damaged value
  arena strength: Act52 value-selection arena was 66.7% win / 26.33 VP / status 3
  in a 6-game check, while the fine-tune fell to 16.7% win / 14.33 VP / status
  2.67. Policy-only fine-tune avoided value-head training but still regressed
  normal-start value arena to 50.0% win / 16.0 VP, because navigation MCTS still
  consumes the shared policy scorer.
- Removing `lockNavigation` samples with
  `ABYSSCURRICULUM_SKIP_RECORD_TYPES=lockNavigation` taught mature farm
  micro-actions, but it did not fix interference. The micro-only policy reached
  29.35 prebuilt-slice VP, yet normal-start policy/value arenas collapsed to
  0.0/0.0 VP and 33.3%/0.0 VP in the quick checks. Mixed replay with 32,439
  Act52 samples plus 4,912 micro-curriculum samples also regressed. Even a
  one-epoch, lr=1e-5 mixed replay update scored only 22.5 VP and 33.3% win in
  value arena, below the original Act52 baseline.
- Current conclusion: Abyss curriculum data is useful evidence and a useful
  training slice, but the shared candidate scorer entangles navigation priors,
  non-navigation command logits, and value-guided selection too tightly. The
  next architecture lane should split or gate action-type heads, at minimum
  separating navigation scoring from full-command micro-action scoring, before
  more curriculum fine-tuning is promoted.
- The June 28, 2026 route-proof matrix
  `ml/meta_runs/route-proof-full-hardcap-20260628T0101Z/summary.json` confirms
  that this is still the right priority. Strict Pure full-control lookahead
  averaged 5.63 VP, 1.88 monster kills/game, status max 0, and 0% reach30 over
  32 games. A farm navigation oracle and a +20 farm-value bonus produced the
  same result, and removing `pvphunter` from the opponent field slightly lowered
  VP to 5.25. Tainted tolerance improved to 9.03 VP but violated the max-status-1
  cap 52 times; no-PvP status-3 corruption jumped to 16.63 VP and 6.25 kills/game.
  Conclusion: do not make the paused pure/economy mixed lane the next major run.
  The next training work should target farm micro-control, reward conversion,
  and damage/barrier build timing under the action-complete contract.
- The follow-up microdiagnostic
  `ml/meta_runs/route-proof-microdiag-20260628T0212Z/summary.json` narrows that
  further. Strict Pure saw 42 legal Abyss combat opportunities per game and
  34.38 firepower-capable opportunities, but only 1.50 clean survivable combat
  opportunities, with 0% missed clean fights and max barrier averaging 4.00.
  No-PvP corruption scored higher because it could accept the unsafe fights and
  convert 5.13 kills/game. Therefore the next route-solving work is not more
  farm navigation or reward-pick pressure; it is a survivability/build-timing
  curriculum and policy head that learns when to build max barrier, restore
  barrier, acquire mitigation, or enable simultaneous attack before farming.
- `src/lib/play/ml/_survivalcounterfactual.test.ts` is the new data gate for
  that lane. It finds Pure normal-start states with firepower to kill the monster
  but insufficient clean survivability, then branches legal navigation into
  Abyss-now versus non-Abyss build/rest rollouts. The first local smoke labeled
  4/4 unsafe-firepower windows as `buildNowCorrect`; all rollout-best branches
  chose Lantern Canyon and produced +1 clean future fight opportunity and +3 VP
  by the 6-round horizon. Treat these labels as the seed for a survivability
  curriculum: build max barrier, restore barrier, mitigation, or simultaneous
  attack before farming. Setting `SURVIVALQ_DATA_OUT` writes the same labels as
  normal `obs/cands/chosen/pi/ret/farmValue` JSONL; the smoke export produced
  4 contract-compatible `55/52` navigation correction samples.
- The first SimForge survival-Q pass,
  `ml/meta_runs/survivalq-20260628T0226Z/survivalq.json`, scanned 24
  unsafe-firepower windows. Build-first was correct in 12/24, with +0.50 clean
  fight opportunities and +1.33 VP on average by horizon 10. The exported
  `data/survivalq.jsonl` contains 24 trainable `55/52` samples: 12 labels keep
  going to Arcane Abyss, 11 label Lantern Canyon, and 1 labels Cyber City. That
  confirms the survival curriculum must be counterfactual/selective, not a blunt
  "always rest/build instead of farm" rule.
- The first survival-Q fine-tune,
  `ml/meta_runs/survivalq-finetune-20260628T0233Z/best_policy.json`, is not a
  promotion candidate. It generated 128 counterfactual samples and trained six
  low-LR epochs from the aux-head checkpoint, but the matched strict-Pure
  route-proof comparison regressed: baseline aux-head scored 5.63 VP,
  1.88 kills/game, and 2.13 clean fight windows/game, while survival-Q scored
  5.25 VP, 1.75 kills/game, and 1.81 clean fight windows/game. A follow-up
  strict-cap repro showed that the quick comparison's status leakage was
  opponent-forced, not planner-owned: `planner_status_cap_violation_events=3`,
  `planner_own_status_cap_violation_events=0`, and
  `planner_external_status_cap_violation_events=3`, all from
  `external:Green:initiatePvp`. Conclusion: survival-Q labels are useful, but
  small one-shot fine-tunes are still diagnostic, not the main path; route-proof
  summaries must separate self-pure execution from PvP-field pressure.
- The status-attribution refresh,
  `ml/meta_runs/route-proof-status-attrib-baseline-20260628T0255Z/summary.json`
  and
  `ml/meta_runs/route-proof-status-attrib-survivalq-20260628T0255Z/summary.json`,
  confirms that route-proof summaries now expose
  `planner_own_status_cap_violation_events`,
  `planner_external_status_cap_violation_events`,
  `planner_deadline_status_cap_violation_events`, and source breakdowns. In the
  8-game strict-Pure slice both baseline and survival-Q scored only 4.50 VP and
  1.50 kills/game with zero status-cap events. That keeps the clean-route result
  negative while making future failures diagnosable as self-corruption,
  opponent-forced corruption, or auto-advance effects.
- The first contract-sufficiency audit,
  `src/lib/play/ml/_contractaudit.test.ts`, now checks actual
  `obs/cands/chosen` JSONL samples for exact or near-identical contradictory
  route labels. The fresh gate generated 24 survival-Q rows with three
  destination labels and found zero exact/near conflicts. The larger audit
  `ml/meta_runs/survivalq-finetune-20260628T0233Z/contract_audit_summary.json`
  covered 128 rows with five destination labels and also found zero conflicts;
  the nearest different-label observation distance was 0.0277. Interpretation:
  for the survival/build navigation slice, the current `55/52` contract is not
  obviously aliasing route-critical labels. The remaining clean-route failure is
  more likely insufficient high-quality route-Q data, search/rollout quality,
  or training objective interference than a proven feature-collapse bug.
- The first heldout route-Q imitation diagnostic,
  `ml/route_imitation.py`, strengthens that read. A fresh 24-window survival-Q
  slice reached 0.947 train top-1, 0.800 heldout top-1, and 1.000 heldout top-3.
  The larger 128-row dataset at
  `ml/meta_runs/survivalq-finetune-20260628T0233Z/route_imitation_summary.json`
  reached 0.896 train top-1, 0.844 heldout top-1, and 1.000 heldout top-3
  against a 0.500 heldout majority baseline. Conclusion: the scorer can imitate
  these route-Q labels when trained directly. The failed survival-Q fine-tune
  was caused by recipe/interference and tiny data, not by an unlearnable label
  surface.
- The larger route-Q navigation specialist
  `ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json` proves
  that imitation alone is not enough. It trained from 512 survival/build
  counterfactual windows and passed wider heldout imitation with 0.811 top-1 /
  0.969 top-3 against a 0.551 majority baseline. But when used as
  `NAV_WEIGHTS` with the baseline aux-head policy, the matched strict-Pure
  route-proof slice regressed to 2.63 VP and 0.88 kills/game from the previous
  4.50 VP / 1.50 kills/game baseline. It stayed clean, but missed 95.2% of
  farm-opportunity VP. Conclusion: the route-Q specialist learned the local
  "build instead of unsafe Abyss" label, but not the cyclic route policy
  "build until safe, then return to low-rung farming." The next implementation
  should use state-conditioned arbitration, DAgger-style failure collection, or
  route-level options rather than replacing the whole navigation prior with
  local survival-Q imitation.
- The first state-conditioned route-Q arbitration proves the clean route exists
  at a meaningful but not champion level. With
  `NAV_GATE=unsafe-firepower`, the route-Q prior is used only in the
  unsafe-firepower states it was trained on; otherwise navigation stays on the
  baseline aux-head policy. In
  `ml/meta_runs/route-proof-routeq-navprior-gated-32g-20260628T0330Z/summary.json`,
  the mixed `pvphunter,medium,cultivator,survivor` field reached 10.41 VP,
  3.47 kills/game, 81.3% win, 4.0% missed farm-opportunity VP, and zero
  planner-owned corruption events over 32 games. Two external PvP events from
  `pvphunter` pushed max status to 1. In
  `ml/meta_runs/route-proof-routeq-navprior-gated-no-pvphunter-32g-20260628T0340Z/summary.json`,
  the no-`pvphunter` field reached 10.59 VP, 3.53 kills/game, 96.9% win, max
  status 0, and zero owned/external/deadline cap events. Conclusion: strict
  Pure monster economy is no longer unproven; it is learned at the Tier-2
  clean-route threshold. It is still not a solved competitive/champion route:
  reach30 remains 0%, average VP is only ~10.5, and PvP pressure can still
  disrupt it.
- The build-diagnostic route proof
  `ml/meta_runs/route-proof-routeq-builddiag-20260628T034942Z/summary.json`
  added two dashboard-facing fields to eval artifacts:
  `planner_navigation_destinations_per_game` and
  `planner_location_interactions_per_game`. In the no-`pvphunter` gated proof,
  the clean bot scored 10.88 VP / 3.63 kills/game / 0 status and mostly used
  `Arcane Abyss` plus `Lantern Canyon` cultivate/restore, `Lantern Canyon`
  any-basic -> Cursed Spirit, and `Floral Patch` rest/restore rows. It barely
  visited `Tidal Cove` and peaked at only 1.63 attack dice, 2.13 Spirit Animal,
  1.75 Cultivator, and 4.50 max barrier. Conclusion: the next ceiling is not
  the farm-navigation gate. It is route execution: learning when to summon,
  buy/attach damage augments, restore barrier, and return to farming so the
  route can progress from 10 VP to reach30.
- The route-execution counterfactual lane now tests exactly that missing layer.
  `src/lib/play/ml/_routeexecutioncounterfactual.test.ts` branches
  `resolveLocationInteraction` row choices at normal-start Pure location
  windows and can export normal `55/52` JSONL samples. The 128-window SimForge
  slice in `ml/meta_runs/routeexecq-20260628T035831Z/summary.json` showed that
  Tidal Cove's Animal augment trade is often the best damage-scaling row, while
  the heuristic executor always free-summoned there. Heldout imitation passed
  strongly (`route_imitation_summary.json`: train top-1 0.990, val top-1 0.920,
  val top-3 1.000), so the current contract can represent row-choice labels.
  Runtime support now includes `microGate=location-interactions`, which lets a
  micro scorer act only on `resolveLocationInteraction` candidates.
- The first location-row micro proof is positive but not solved. The diagnostic
  checkpoint `ml/meta_runs/routeexecq-micro-20260628T0405Z/best_policy.json`
  was trained from 128 route-execution samples and evaluated only through
  `microGate=location-interactions`. In
  `ml/meta_runs/route-proof-routeexecq-micro-no-pvphunter-32g-20260628T044654Z/summary.json`,
  strict Pure no-`pvphunter` improved from the prior 10.59 VP / 3.53 kills /
  3.9% missed farm VP to 13.69 VP / 4.56 kills / 0.0% missed farm VP over 32
  games, with status 0 and 96.9% win. Reach30 stayed 0%, so this is route
  progress, not meta completion. The checkpoint should be retrained with a
  matching warm-start path and broader data before any promotion.
- The trainer now has the missing warm-start machinery. `ml/train.py` supports
  `--init-from`, and `ml/model.py` can build to checkpoint-inferred hidden
  widths. This matters because the aux-head route policy uses a `256,256` trunk
  and `128` value head, while the trainer default is `128,128` / `64`. The first
  scratch row specialist improved proof performance despite being narrower; the
  compatible warm-start specialist
  `ml/meta_runs/routeexecq-micro-warm-20260628T050546Z/best_policy.json`
  trained correctly from the aux-head checkpoint but scored only 12.75 VP /
  4.25 kills/game in the 8-game clean proof. Keep it as evidence that
  architectural compatibility alone is not enough; the data distribution and
  arbitration still matter.
- A policy-distribution route-execution collector was added via
  `ROUTEEXECQ_WEIGHTS`, `ROUTEEXECQ_NAV_WEIGHTS`, and
  `ROUTEEXECQ_NAV_GATE=unsafe-firepower`. The first 128-window run,
  `ml/meta_runs/routeexecq-policy-20260628T051141Z/summary.json`, sampled only
  `Floral Patch` and `Lantern Canyon` windows and found `avgBestScoreDelta=0`;
  the heuristic already chose the same rest/cultivate rows. Conclusion: the
  route-execution collector now supports gated-route navigation, but it still
  does not reproduce the full-control proof's Cyber/Tidal decision distribution.
  The next data collector should branch row choices inside the actual
  full-control evaluator/self-play loop, not only after navigation-planner
  rollouts with heuristic micro-execution.
- The scratch row-specialist line is robust to a larger navigation search budget.
  `ml/meta_runs/route-proof-routeexecq-micro-hibudget-16g-20260628T051529Z/summary.json`
  used 64 iterations / horizon 24 and held 13.31 VP, 4.44 kills/game, status 0,
  and 1.4% missed farm VP over 16 no-`pvphunter` games. The ceiling remains
  reach30: even with higher budget, reach30 stayed 0%.
- The same row-specialist in a 16-game mixed `pvphunter,medium,cultivator,survivor`
  check reached 13.13 VP, 4.38 kills/game, 87.5% win, and 0.0% missed farm VP,
  but `pvphunter` still caused one external status-cap event (`maxStatus=1`,
  owned events 0). This keeps the mixed-field strict-Pure verdict at "not yet":
  the route is stronger, but opponent disruption remains real and reach30 is
  still 0%.
- The next clean-route implementation should follow the recommendation ladder:
  prove or falsify the route with a strong constrained planner, generate
  counterfactual farm/build Q labels only where the branch wins, audit whether
  the current `55/52` observation/action contract can imitate route-critical
  oracle actions, then train a clean specialist with broad replay or split
  navigation/micro heads. Do not run the paused pure/economy mixed lane as the
  next major GPU job until those route-proof gates are positive.
- The first split-policy implementation added `microPolicy` support in
  `playPlannerSelfPlayGame` and environment knobs `AZ*_MICRO_WEIGHTS` plus
  `AZ*_MICRO_GATE`. Navigation/search stays on `AZ*_WEIGHTS`; full-control
  non-navigation decisions can use a separate micro scorer. `microGate=all`
  tests a broad split, while `microGate=abyss-round` only swaps in the micro
  scorer after the seat locks Arcane Abyss.
- Quick split-policy evidence: Act52 navigation plus
  `act52-abyss-micro-policyonly` as the micro scorer with value selection
  exactly preserved the Act52 quick arena baseline: 66.7% win, 26.33 VP,
  status 3, and 67% reach30 over the 6-game gate. That confirms the earlier
  regression was mostly navigation/search interference from overwriting the
  shared scorer. However, policy and hybrid split variants still underperformed:
  broad policy split scored 1.5 VP / 0% win, gated policy scored 11.5 VP /
  33.3% win, and gated hybrid scored 10.0 VP / 16.7% win. Lookahead split
  reached 18.83 VP / 66.7% win but still trailed Act52 value. Conclusion:
  split/gated infrastructure is correct and useful, but the current micro
  scorer is not a promotion candidate. The next improvement needs either a
  genuinely separate trained head inside one checkpoint or a better
  state-conditioned arbitration rule, not simply routing all policy decisions
  to the curriculum scorer.
- A narrower action-type arbitration pass added two more gates. With
  `microGate=abyss-farm-actions`, the micro scorer can only pick
  `startCombat`, `resolveMonsterReward`, and Abyss draw/summon commands. This
  produced a promising 6-game quick result at 83.3% win / 27.5 VP / 83.3%
  reach30, beating the Act52 quick baseline. The wider check did not prove
  promotion: at 12 games / 16 iterations it was 66.7% win / 21.67 VP versus
  Act52 at 50.0% / 20.67, but at 12 games / 24 iterations it fell to 16.7% /
  8.25 versus Act52 at 25.0% / 8.75. The all-planner meta smoke stayed weak at
  6.67 VP and `abyss-monster-farm`.
- `microGate=abyss-reward-actions`, which leaves combat timing to Act52 and
  only specializes reward/draw resolution, was more stable but not meaningfully
  better: 12-game / 16-iteration arena was 50.0% win / 20.92 VP, only a tiny
  bump over Act52's 20.67 VP, and 12-game / 24-iteration arena matched the
  Act52 8.75 VP baseline. Current verdict: action-type arbitration is a useful
  diagnostic and may be part of the final architecture, but it has not produced
  a solved or promotable bot.
- The Act52 full-control SimForge run
  `ml/meta_runs/act52-full-g6-20260627T181633Z` trained 32,439 AlphaZero samples
  at the current `obs_dim=55`, `act_dim=52` contract. Its strict eval suite
  `ml/meta_runs/act52-full-g6-20260627T181633Z-eval32/summary.json` returned
  `verdict=not-yet`: deterministic meta 10.28 VP / status 2.66
  (`fallen-corruption`), sampled meta 4.44 VP, and mixed-field arena 33.3% win /
  7.83 VP. Forced-Abyss value selection reached 15.38 VP only by ending Fallen;
  Pure forced-Abyss value selection scored 2.25 VP.
- Full-command `lookahead` selection on the same checkpoint exposes useful
  latent signal but is not sufficient as the solved bot. It improved mixed-field
  arena to 75.0% win / 12.88 VP / 4.38 monster kills per game, but average status
  remained 1.75. All-planner lookahead meta stayed low at 5.44 VP.
- The Pure constrained lookahead run
  `ml/meta_runs/act52-pure-lookahead-g5-20260627T182701Z` is negative evidence:
  with `initiatePvp` forbidden and `maxStatusLevel=0`, both meta iterations
  scored 0 VP and never navigated to or fought at the Abyss. The next clean-line
  architecture should therefore add curriculum/prebuilt-state training or
  reward shaping that reaches farmable states, not simply extend the same
  constrained self-play loop.

A second rules nuance from the recovery review: early Abyss farming is not
literally "3 VP per monster" under the current engine. Monster kills create a
`pendingReward`; `resolveMonsterReward` chooses up to `chooseAmount` tokens from
that monster's reward track. Early tracks can include 1-2 VP and summon/economy
tokens, with higher VP appearing later, and the monster rung/lives system matters
in multiplayer. Balance claims about a clean Abyss route must therefore use
forced-Abyss or VP-source artifacts that report actual reward VP, kills, rungs,
status, and rounds.

Correction to the earlier "mature boss build" framing: in a 4-player game the
current monster has one life per active seat. A low-rung monster can therefore be
killed repeatedly before the ladder advances, so the useful clean-farm threshold
is not "clear the whole ladder." It is "kill the current low-HP monster without
corrupting, then keep taking the highest-value reward picks." If one player
monopolizes those lives, the early rungs can be enough to approach or pass 30 VP
with much less than a 10-dice / 20-barrier boss build. If every seat farms Abyss,
the lives and reward VP are shared, so per-seat VP is much lower. This makes
monster farming a contest for a shared table resource, not just a private build
check.

The ML action surface used to hide part of that line. The reducer allowed any
legal `resolveMonsterReward` pick set and wildcard `choices`, but
`src/lib/play/ml/actions.ts` only exposed first-k and last-k reward picks. It now
enumerates all non-empty pick combinations for small reward tracks and expands
wildcard rune/relic choices, while keeping a bounded fallback for unusually large
tracks. `encodeAction` also uses existing param slots for reward pick indices and
choice indices, so the candidate scorer can distinguish `3 VP + Abyss Summon`
from `1 VP + rune`.

The next architecture boundary is now explicit: `src/lib/play/ml/farmValue.ts`
defines the shared farm-value signal used by diagnostics, planner experiments,
training artifacts, and eventually the dashboard. It computes clean kill
probability, claimable reward VP, remaining monster lives, status, and opponent
race pressure. Planner runs may opt into `AZ*_FARM_VALUE_BONUS` to add an
Arcane Abyss root-prior bonus proportional to that score, but this is a teacher
and experiment knob, not a live bot rule. Promotion still requires broad meta
and arena proof.

Post-fix evidence: the reward-choice surface fix is necessary but not sufficient.
Act52's all-planner 4-game probe still scored 0 VP and missed 100.0% of farmable
Abyss navigation opportunities, while its heuristic-field arena remained 23.13
VP / 62.5% win / status 2.75. A split navigation-prior lane using
`act52-cleanfarm-nav-mixed10-smoke` improved the all-planner probe to 6.56 VP and
55.3% missed farmable navs, but collapsed in the heuristic-field arena to 8.25 VP
/ 0.0% win. Even a hard `AZEVAL_FARM_NAV_ORACLE=force` check lost that arena at
6.75 VP / 0.0% win. So the correct next architecture is not a blind
clean-kill-probability gate. It needs a value-aware farm decision that considers
expected reward VP, remaining monster lives, opponent race pressure, survival
risk, and opportunity cost.

A first farm-value-prior smoke confirms the boundary is useful but insufficient
by itself. With Act52, `AZMETA_FARM_VALUE_BONUS=20` raised a 4-game all-planner
probe from 0.00 to 2.06 VP and removed the measured missed farm opportunity, and
the matching 4-game arena rose from 0.0% / 2.25 VP to 25.0% / 8.25 VP. That is
positive evidence for farm value as a training signal and negative evidence for
promoting a prior-only policy.

Current full-suite baseline after adopting this approach:
`ml/meta_runs/act52-current-meta-eval-20260627T210828Z/summary.json` returned
`verdict=not-yet`. Deterministic all-planner meta scored 7.93 VP, 0% reach30,
status 3.00, inferred `fallen-corruption`. Sampled meta scored 4.11 VP, 0%
reach30, status 1.98, inferred `cursed-spirit-corruption`. Arena versus
`pvphunter,medium,cultivator,survivor` was strong but not clean: 75.0% win,
19.68 VP, status 2.85. Pure forced-Abyss still failed at 4.2% win, 2.88 VP,
status 0. This is exactly why the next lane must be curriculum + league +
auxiliary value heads rather than another single-checkpoint self-play loop.

To support that next lane, self-play/eval artifacts now report missed farm
opportunity VP. The value is computed from clean kill probability times the
highest claimable VP on the current monster reward track, then accumulated when a
farmable navigation decision skips Arcane Abyss. In a tiny post-fix Act52 meta
probe, the bot missed 49.00 expected reward-VP per seat-game while scoring 0 VP.
That gives the future dashboard and training loop a concrete target: reduce
missed farm-opportunity VP without losing arena strength.

The June 27 owner-question recovery pass proved this with fresh reducer output:
forced early Abyss with 0 dice and 0/1/2 Spirit Animal traits scored only
3.38 / 4.69 / 3.56 VP and reached status 3 around round 6. A mature injected
build using the same reducer, `10x arcane dice + 2 Spirit Animal + 20 max
barrier`, scored 31.19 VP in 10 rounds. The current problem is therefore not
"Abyss scoring is impossible"; it is that learned bots do not reliably discover
the normal-start build and fight-timing sequence.

The new normal-start clean-farm diagnostic makes that more concrete. In
`src/lib/play/ml/_cleanfarm.test.ts`, the 4-game local pass over
`paragon,farmer,farmer2,hard` found that every seat reached a clean farmable
state, usually around rounds 4-5, but the profiles skipped Arcane Abyss on
85.7-90.7% of farmable navigation decisions. Average VP stayed at 5.25-7.56 and
no profile reached boss-farmable readiness. The failure is therefore not simply
"cannot build enough damage"; it is also "does not recognize and exploit the
farmable window."

The learned Act52 checkpoint has a sharper context-dependent version of the same
bug. In a small heuristic-field arena it already takes farmable Abyss windows
and scores 23.13 VP, but in a 4-game all-planner meta probe it reached farmable
states constantly, missed 100.0% of farmable Abyss navigation decisions, never
fought, and scored 0 VP. Forcing only clean-farmable navigation to Arcane Abyss
raised that probe to 3.38 VP, and a 2-epoch warm-start fine-tune on 1,957
oracle-corrected samples raised it to 6.19 VP without the oracle. That fine-tune
is not promotable: it regressed the heuristic-field arena to 15.00 VP / 50.0%
win. The useful conclusion is that clean-farm navigation targets are real signal,
but they must be mixed with broad replay or isolated into a navigation head so
they do not overwrite other arena competence.

A first replay-mix smoke used all 32,439 Act52 samples plus the oracle slice
oversampled 10x. It moved the all-planner probe to 5.44 VP / 54.8% missed
farmable navs, but still regressed the heuristic-field arena to 16.13 VP / 50.0%
win / status 3.0. So naive replay mixing reduces the overwrite problem but does
not solve it. A promotable version needs either a larger seeded GPU mix with
checkpoint selection on both gates, or a separate navigation correction head that
does not perturb the full-command value/policy behavior that produced Act52's
arena strength.

Recovery strategy after that pass:

- Keep the current engine rules unless product design explicitly changes monster
  combat order, Spirit Animal semantics, monster HP persistence, or reward VP.
- Add no more long GPU self-play runs until a normal-start clean-farm oracle or
  reachable-prefix curriculum proves the farmable build is reachable from legal
  starts.
- Use `npm run test:bot:clean-farm` before treating a clean-farm strategy change
  as progress. The gate should report clean farmability, missed farmable Abyss
  navigation rate, boss-farmability, reward VP, kills, and first farmable round.
- Use `AZ*_FARM_NAV_ORACLE=force` only for curriculum/eval probes. It proves the
  value of clean-farm navigation targets, but a pure oracle fine-tune has already
  shown broad-arena regression.
- Use `AZ*_MICRO_GATE=abyss-farm-overlay` only as conservative instrumentation:
  the main policy owns normal play, and the micro policy can override only a
  reward claim or killing combat with concrete pending reward VP.
- Treat the first overlay evidence as negative for promotion. It matched Act52
  in the 12-game i16 arena slice and still scored 6.67 VP / 4.2% reach30 in
  all-planner meta.
- The next architecture step is a farmability oracle/evaluator that reports
  expected fight value from barrier, expected damage, monster rung, pending
  reward VP, status risk, and round tempo, then uses that as both a dashboard
  metric and a training/eval gate.

Evaluation guardrail: quality evals now use strict checkpoint loading. `_azmeta`,
`_azeval`, `_azduel`, and `_azleague` must fail on missing or stale dimensions
instead of silently using random bootstrap weights. Random fallback remains only
for `_azgen` iteration-zero data generation.

## Shared Bot Contract

`arc-bot-v1` has three pieces:

1. Observation: seat, public game state, and a list of legal actions.
2. Legal action: stable `actionId` plus the exact `GameCommand`.
3. Decision: contract version plus the chosen `actionId`.

The action id is a canonical JSON encoding of the command under the contract version, so dashboards, run logs, training data, and bot submissions can all refer to the same move without depending on array indexes.

Rules for future bot runners:

- Never mutate game state directly.
- Never emit commands outside the advertised legal action list.
- Record contract version, rules commit, catalog hash, checkpoint id, and run id with every dataset/evaluation.
- Treat any reducer rejection as a failed run, not as a recoverable model mistake.

## Dashboard Data Shape

The dashboard should read run artifacts first, then a database table later if needed.

Minimum run artifact:

```json
{
	"run_id": "agent-20260627T000000Z",
	"contract": "arc-bot-v1",
	"rules_commit": "git-sha",
	"catalog_hash": "sha256",
	"patch_id": "balance-baseline",
	"checkpoint": "ml/weights/policy.json",
	"games": 1000,
	"metrics": {
		"win_rate": 0.42,
		"avg_vp": 23.1,
		"avg_rounds": 31.4,
		"illegal_actions": 0,
		"stall_count": 0
	},
	"units": [],
	"strategies": [],
	"artifacts": {
		"log": "ml/meta_runs/.../log.txt",
		"weights": "ml/weights/...",
		"eval": "ml/meta_runs/.../eval.json"
	}
}
```

Dashboard views:

- Runs: compare checkpoints across balance patches.
- Meta: win rate, VP, placement, round length, strategy clusters.
- Units: pick rate, top-4/win rate, average VP contribution, nerf/buff deltas.
- Policies: checkpoint lineage, ELO, head-to-head matrix, illegal/stall rate.
- Balance impact: before/after patch deltas with confidence intervals.

The dashboard should show separate columns for:

- full meta score: all-seat learned policy strength under deterministic and sampled
  selection;
- baseline arena score: strength against retained historical heuristic baselines;
- direct AlphaZero duel score: learned checkpoint vs learned checkpoint with all
  seats using the full-command planner path.

Do not collapse those into one number yet; the June 27 run showed that the
direct-duel leader can have weaker sampled meta scores than the old champion.

## Training Reality Check

Millions of simulations are reasonable only if the loop stays headless and batched:

- The reducer is pure enough for fast Node/Vitest self-play.
- The legal action set is large, so candidate scoring is a better fit than a fixed action head.
- Full deep RL will be expensive because the game has long horizons, sparse wins, hidden combinatorics, and many parameterized commands.
- The practical path is curriculum/self-play/league training: smoke runs locally, medium runs on one GPU, then larger SimForge runs once illegal-action and stall gates are zero.

Do not expect a model to become strong just because it runs longer. Promotion should be based on seeded head-to-head results and dashboard-visible balance/meta changes.

The reasonable expectation is not "press train and discover the best strategy
forever"; it is a staged evidence loop:

1. deterministic legal-action tests catch impossible moves;
2. local smoke proves generation/training/eval still run;
3. GPU smoke proves the same code runs on the SimForge box;
4. medium seeded leagues identify candidate strategies;
5. dashboard comparisons decide whether a strategy is overperforming under a
   specific balance patch.

## Clean Route Research Loop

The clean monster/economy lane is intentionally separate from the unrestricted
champion lane. A strict Pure specialist can be valuable as a balance diagnostic
even if current rules still reward corruption/PvP more strongly.

Use this ladder before promoting any Pure/economy checkpoint:

1. Probe whether the route exists from normal starts with the reducer-legal beam
   oracle, `npm run test:bot:clean-route-beam`, then verify trained execution
   with `npm run bot:route-proof` or the combined proof/audit path
   `npm run bot:clean-route-proof`.
2. Generate counterfactual labels only where a branch wins after rollout:
   `npm run test:bot:farm-counterfactual`,
   `npm run test:bot:survival-counterfactual`, and
   `npm run test:bot:route-execution-counterfactual`.
3. Audit representation with `npm run test:bot:contract-audit` and
   `npm run test:bot:route-imitation`.
4. Collect full-control failure states with
   `npm run bot:routeexecq:fullcontrol`; use `POSITIVE_ONLY_DATA=1` only for
   correction-only curriculum, and keep it off for diagnostics.
5. Collect upstream scaling-navigation labels with
   `npm run test:bot:scaling-navigation-counterfactual` and larger SimForge
   `SCALEQ_SOURCE=full-control` runs when row-choice labels plateau.
6. Run the focused HP-4 wall gate with
   `npm run test:bot:hp4-wall-counterfactual` before training any HP-4
   curriculum. Promote only positive branch deltas; zero-delta windows are
   evidence for a stronger oracle/DAgger prover, not supervised labels.
7. Run `npm run test:bot:hp4-wall-oracle` and larger
   `SCALEQ_ROLLOUT_POLICY=breakpoint-oracle` slices to collect VP-positive
   HP-4 scaling labels. Keep score-only, VP-flat rows diagnostic until they
   improve route proof.
8. Train clean specialists through gated navigation/micro policies, then verify
   them against no-`pvphunter`, mixed-field, high-budget, and direct-duel gates.

`npm run test:bot:clean-route-proof` is the local smoke for this ladder. It
generates farm-Q rows, audits those same rows for contract aliasing, and runs
heldout route-imitation before any GPU-sized specialist training. The GPU suite
`npm run bot:clean-route-proof` adds the full route-proof matrix and writes a
single `clean_route_suite_summary.json` verdict so training can be explicitly
allowed or rejected by evidence. The suite is intentionally diagnostic: too few
farm-Q rows, contract conflicts, imitation misses, or route-proof timeouts should
produce `diagnose-before-training` with artifact paths, not a missing summary.
Farm-Q rows now carry the explicit branch tradeoffs used by the dashboard:
reward VP, PvP VP, monster lives consumed, race margin, reach30 movement, and
PvP exposure deltas.

`npm run test:bot:clean-route-beam` is the local smoke for the legal route
prover. It is intentionally separate from learned policy evaluation: it branches
the target seat's actual legal commands under max-status-0/no-PvP constraints
while non-target seats use existing profiles. The June 29 wider local slice
`ml/clean_route_beam_4g_b24_summary.json` used 4 games, beam 24, action beam 24,
and 240 target decisions. It found average best VP 16.00, max best VP 22, 5.50
monster kills/game, status 0/max 0, 0 target PvP events, and 0% reach30. This
is stronger evidence than a trained-policy miss that the clean route is not yet
certified, but it is not a mathematical impossibility proof; the next prover
work should inspect late VP18-22 frontiers and whether HP5+ damage/barrier
timing is blocking the final reward claims.

The first full suite,
`ml/meta_runs/clean-route-proof-suite-20260628T203700Z/clean_route_suite_summary.json`,
proves the current clean route enough to allow specialist training, but not
promotion. Strict Pure reached Tier 2: 21.00 VP, 93.8% win, 7.19 kills/game,
status 0/max 0, 0% reach30. Removing `pvphunter` lifted the same route to 22.44
VP and 100% win, but still 0% reach30. Farm oracle and farm bonus both tied
strict Pure exactly, while tainted tolerance and no-PvP corruption underperformed
strict Pure. The architectural conclusion is now sharper: the next clean-route
training lane should target HP4 wall execution, restore timing, max-barrier /
Cultivator acquisition, damage assembly, and re-entry after VP plateaus. It
should not be another broad farm-now prior or soft-purity fine-tune.

The guarded June 29 rerun
`ml/meta_runs/clean-route-proof-suite-20260629T093420Z/clean_route_suite_summary.json`
confirmed that conclusion under the GPU 6/7 memory-guarded runner. Strict Pure
again scored 21.00 VP, status 0, 7.19 kills/game, and 0% reach30; the no-
`pvphunter` field reached 22.44 VP, 100% win, and still 0% reach30. Farm oracle
and oracle+bonus both added exactly 0.00 VP, while status tolerance and no-PvP
corruption underperformed strict Pure. The fresh farm-Q slice remained useful
and selective (181/256 farm-now labels, validation top-1 0.781, top-3 1.000),
but the route trace found the HP4 wall in every strict/no-`pvphunter` game.
Current implementation priority: collect and train HP4+ wall execution labels
for current-barrier restoration, max-barrier/Cultivator acquisition, damage
assembly from HP1/HP2 farming into HP4 kills, and post-VP route re-entry. Do not
spend the next major GPU run on a broader farm-Q or farm-navigation prior.

Operational footnote: `scripts/run-arc-route-proof-matrix.sh` now defaults the
known specialist gates to the clean-suite settings
(`PATCH_NAV_GATE=hp2-survival-deficit`,
`NAV_GATE=unsafe-firepower-build-option`). If a test deliberately wants
all-state specialist control, set those gates explicitly in the command. Do not
compare a checkpoint against route-proof artifacts generated by accidentally
running the HP2 patch or route-Q prior with `all` gates; those runs collapse VP
for configuration reasons, not strategy reasons.

The current route-exec implementation writes both dashboard and training fields:
`sourceWasBest`, `routeExecCorrections`, `routeExecQDeltaScore`,
`routeExecQDeltaVp`, `routeExecQDeltaStatus`, `routeExecQDeltaReach30`,
`correctionBestActions`, and `correctionSourceActions`. These fields let the
dashboard distinguish three cases that used to blur together: the source already
chose correctly, a better correction exists, or the branch score is too small to
teach safely.

Current June 28, 2026 clean-route verdict: the route is Tier-2 learned, not
Tier-3 solved. Gated route-Q navigation plus a location-row micro scorer reaches
roughly 13 VP, 4.3-4.6 monster kills/game, 0 owned corruption, and 0 missed farm
VP in both no-`pvphunter` and mixed-field slices. It still has 0% reach30. The
late route-exec row collector confirmed that row choice alone is not the main
ceiling: the scaling-focused full-control run
`ml/meta_runs/routeexecq-scaling-fullcontrol-20260628T0610Z/summary.json`
found only 2 corrections in 62 late windows.

The new upstream scaling-navigation collector found a much richer signal:
`ml/meta_runs/scaleq-fullcontrol-20260628T0645Z/summary.json` produced 64
mid-route navigation windows with 36 corrections, mostly shifting overused
Arcane Abyss/Lantern decisions toward Floral Patch and Tidal Cove for future
damage/barrier scaling. However, the first direct specialist is not promotable.
Ungated deployment collapsed to 2.25 VP, and the farm-preserving
`NAV_GATE=midroute-scaling` proof
`ml/meta_runs/route-proof-scaleq-nav-midroute-farmpreserve-no-pvphunter-16g-20260628T0700Z/summary.json`
still regressed to 7.50 VP, 2.50 kills/game, 0% reach30, and heavy Floral Patch
resting. That is a useful diagnostic result, not a clean-route improvement.

The composite specialist plumbing now keeps the proven route-Q survival/build
navigator as the primary `NAV_WEIGHTS` policy and adds a sparse scaling option
through `SCALE_NAV_WEIGHTS`. The first corrected composite proof,
`ml/meta_runs/route-proof-routeq-plus-scaleq-routeoption-no-pvphunter-16g-20260628T0730Z/summary.json`,
preserved but did not improve the clean-loop baseline: 13.69 VP, 4.56 kills/game,
status 0, 0% missed farm VP, and 0% reach30. It did produce one 24 VP clean game,
which is useful evidence that higher clean routes are reachable, but the average
did not move.

Trace capture turned that outlier into an actionable failure. The 24 VP trace
showed a clean route that farms the HP-1 and HP-2 multi-life rungs, then stalls
at the HP-4 / damage-4 rung because current barrier is too low and the route-Q
prior still allows repeated Arcane Abyss navigation. The trace-derived
`unsafe-firepower-build-option` gate filters those unsafe-firepower windows away
from Abyss and toward build/rest/scaling locations. That produced the first real
average lift:

- no-`pvphunter`:
  `ml/meta_runs/route-proof-routeq-buildoption-plus-scaleq-trace-no-pvphunter-16g-20260628T0800Z/summary.json`
  reached 16.56 VP, 5.56 kills/game, status 0, and five 20+ VP traces.
- mixed field:
  `ml/meta_runs/route-proof-routeq-buildoption-plus-scaleq-trace-mixed-16g-20260628T0810Z/summary.json`
  reached 15.19 VP, 5.13 kills/game, status 0, and no owned/external corruption
  events, though it still had one 3 VP failure.

The best trace reached 28 VP cleanly by restoring at Lantern Canyon until
current barrier reached 5/10, then farming the HP-4 rung twice. This is not a
solved meta because reach30 remains 0%, but it proves the clean route ceiling is
now above the old 13 VP loop from normal starts. The next research lane should
turn these traces into DAgger/counterfactual data for reliable HP-4+ conversion,
then test at larger game counts and in the learned-policy league.

The next trace pass found and fixed the largest mixed-field collapse. In
`ml/meta_runs/route-proof-routeq-buildoption-fulltrace-mixed-16g-20260628T0820Z/route-proof/strict-pure.trace.json`,
the 3 VP failure traded the only useful attacker at Lantern Canyon
(`anyBasic -> Cursed Spirit`), dropping firepower from kill-capable to zero.
`PRESERVE_ROUTE_FIREPOWER=1` now rejects non-scoring planner actions that destroy
current monster firepower. That turned the reproduced 3 VP game into 24 VP and
raised the best strict-Pure proof to:

- no-`pvphunter`:
  `ml/meta_runs/route-proof-buildoption-preservefire-no-pvphunter-16g-20260628T0840Z/summary.json`
  with 17.31 VP, 5.81 kills/game, status 0, and 0% reach30.
- mixed field:
  `ml/meta_runs/route-proof-buildoption-preservefire-mixed-16g-20260628T0830Z/summary.json`
  with 17.25 VP, 5.81 kills/game, status 0, and 0% reach30.

The next trace pass added `PRESERVE_ROUTE_SURVIVAL=1`, first to stop optional
full-control actions from spending route-critical Spirit Animal / Cultivator /
barrier structure after an early farm commitment, then to redirect
damage-ready-but-unsafe windows toward restoration roots. The promoted v2 proof
is:

- mixed field:
  `ml/meta_runs/route-proof-restoreguard-v2-preservefire-survivaldamage-16g-20260628T0917Z/summary.json`
  with 21.25 VP, 7.38 kills/game, status 0, 87.5% win rate, and 0% reach30.
- no-`pvphunter`:
  `ml/meta_runs/route-proof-restoreguard-v2-preservefire-survivaldamage-16g-20260628T0917Z/summary.json`
  with 22.31 VP, 7.75 kills/game, status 0, 100% win rate, and 0% reach30.

This is now the current clean-route baseline. It proves a meaningful strict-Pure
monster-economy route from normal legal starts, but it still does not prove a
30-point route. The remaining proof target is no longer "can a clean route score
from normal starts?" but "can it reliably convert HP-4+ and HP-5+ rungs into
30 VP, then survive larger mixed and learned-policy league evals?"

A follow-up `survival-rebuild` navigation prior was added as an opt-in
diagnostic through `SCALE_NAV_GATE=survival-rebuild` and
`PRESERVE_ROUTE_SURVIVAL=1`. It is not a promoted route:

- `ml/meta_runs/route-proof-survivalrebuild-preserve-16g-20260628T0813Z/summary.json`
  used broad survival roots. It reached 17.63 VP in the no-`pvphunter` slice but
  regressed to 16.31 VP in the mixed field and produced many Floral Patch rest
  loops.
- `ml/meta_runs/route-proof-survivalrebuild-v2-preserve-16g-20260628T0828Z/summary.json`
  split survival roots by damage deficit. It kept status clean and reduced
  Floral loops, but shifted too much traffic to Tidal Cove and landed at 16.50
  mixed / 17.25 no-`pvphunter`, still 0% reach30.

The route-prover now says the clean line is real but incomplete: low-rung farming
works, but after the HP-1 and HP-2 rungs are exhausted, the bot often stalls on
the HP-4 wall. The low-tail traces are specific: some seeds reach HP-4 with max
attack 2 and no dice, while others reach one die / 3 Spirit Animal and only about
67% HP-4 firepower. Many of those states keep repeating Lantern Canyon
`anyBasic -> Cursed Spirit` plus `cultivate+restoreBarrier`, which restores or
maintains the route but does not create the next damage/max-barrier breakpoint.
The HP-4 wall diagnostic now has a smoke gate,
`npm run test:bot:hp4-wall-counterfactual`, and full-control branch rollouts use
the same target-seat continuation stack as route proof: neural lookahead,
configured micro policy/gate, strict status/PvP constraints, and the firepower
/ survival preservation guards.

The current June 28, 2026 full-control HP-4 run produced zero positive labels in
both `ml/hp4wall_scalingq_fullcontrol_v2_summary.json` and
`ml/hp4wall_routeexecq_fullcontrol_v2_summary.json`. Scaling windows average
21 VP with 3.33 expected attack, 2 dice, 2 Spirit Animal, 10 max barrier, and
44% HP-4 firepower; the branch scorer mostly prefers `Cyber City` over source
`Tidal Cove`, but every branch stays flat at the label horizon. Route-exec
windows are later, around 24 VP with 79% firepower but max barrier 4 and too few
rounds remaining; the source row is already the best row in all sampled windows.
The next implementation target should therefore be a stronger oracle/DAgger
route prover for "build damage now vs restore vs farm" and HP-4 clean-survival
breakpoints, plus states from the 15-18 VP traces, not another
destination-only navigation gate or zero-delta supervised fine-tune.

That oracle prover now exists as `SCALEQ_ROLLOUT_POLICY=breakpoint-oracle` /
`ROUTEEXECQ_ROLLOUT_POLICY=breakpoint-oracle`, with a local smoke gate at
`npm run test:bot:hp4-wall-oracle`. A 64-window full-control scaling slice,
`ml/hp4wall_scalingq_oracle_fullcontrol_v2_64w_summary.json`, found sparse but
real HP-4 conversion signal: 3 score-positive corrections, 2 of them
VP-positive. The two VP-positive rows both start from source `Tidal Cove` and
convert to either `Lantern Canyon` or `Cyber City` for +2 VP / +1 kill at status
0. The matching route-exec oracle slice,
`ml/hp4wall_routeexecq_oracle_fullcontrol_v2_summary.json`, still found 0
corrections, so the next clean-route training data should come from larger
VP-positive HP-4 scaling/navigation oracle slices, not row-choice labels.

The first larger VP-positive HP-4 scaling run,
`ml/meta_runs/hp4-scalingq-oracle-vppos-512w-20260628T100244Z/summary.json`,
used `SCALEQ_ROLLOUT_POLICY=breakpoint-oracle`,
`SCALEQ_LABEL_VP_THRESHOLD=1`, and `SCALEQ_POSITIVE_ONLY_DATA=1`. It scanned
1,440 windows, evaluated 512 HP-4 windows, and exported 37 VP-positive
correction rows. The labels were learnable in isolation: route imitation reached
0.926 train top-1, 0.800 heldout top-1, and 0.900 heldout top-3 on the tiny
heldout split.

The resulting specialist did not improve route proof. In
`ml/meta_runs/route-proof-hp4-scaleq-oracle-vppos-512w-20260628T103500Z/summary.json`,
using it as `SCALE_NAV_WEIGHTS` tied the current strict-Pure baseline exactly:
21.25 VP / 7.38 kills / status 0 / 0% reach30 in the mixed field and 22.31 VP /
7.75 kills / status 0 / 0% reach30 without `pvphunter`. Treat this as negative
promotion evidence, not a failed implementation: the machinery can collect and
train sparse breakpoint labels, but the route needs broader DAgger states from
the 15-18 VP failures and a direct objective for converting HP-4+ into 30 VP.

The follow-up `route-closer` navigation gate is also diagnostic only. It narrows
the scaling prior to high-VP HP-4+ states and chooses root destinations according
to the deficit: damage/firepower, max barrier, or current barrier. The matched
16-game proof,
`ml/meta_runs/route-proof-routecloser-16g-20260628T105859Z/summary.json`,
regressed the mixed field to 21.00 VP / 7.25 kills / 0% reach30 and introduced
one external `pvphunter` status event. The no-`pvphunter` slice regressed to
22.06 VP / 7.63 kills / 0% reach30. This falsifies "late navigation root
selection alone closes the route." The next useful surface is full-action
closer control inside Tidal/Cyber/Lantern windows: which summoned spirits to
keep, which augments/runes to pick, when to attach/replace, and when to return
to Abyss after a restore/build action.

That full-action hypothesis now has one diagnostic falsification. The
`MICRO_GATE=route-closer-oracle` experiment injected the breakpoint oracle over
the full legal action set only in late strict-Pure HP-4+ stall states. An 8-game
smoke looked promising at 22.00 mixed VP and 23.25 no-`pvphunter` VP, but the
matched 16-game proof
`ml/meta_runs/route-proof-routecloser-microoracle-16g-20260628T111920Z/summary.json`
regressed to 20.75 mixed VP and 21.75 no-`pvphunter` VP, with 0% reach30 in both
slices. This falsifies the current oracle as a route closer. The useful
conclusion is narrower: late full-action control matters, but it needs
trace-driven DAgger/counterfactual labels and a trainable closer head rather
than another hard-coded oracle pass.

The first trainable closer pass also failed to improve route proof, but for a
more precise reason. `BRANCH_SCOPE=full` was added to the route-execution
counterfactual harness so it can branch the full filtered legal action set, not
only `resolveLocationInteraction` rows. The runner now also preserves an
explicit empty `MICRO_WEIGHTS=`; before that fix it silently loaded the old
routeexecq micro checkpoint and generated low-scoring source games instead of
the route-proof baseline.

With the source fixed, the VP15+/round12+/HP4+ closer run
`ml/meta_runs/routeexecq-fullcloser-vp15hp4-64w-20260628T120112Z/summary.json`
found 64 late full-action windows and 0 branch-score corrections. The labels
were easy to imitate, but the resulting `MICRO_GATE=route-closer-full`
checkpoint tied the matched no-micro baseline exactly in
`ml/meta_runs/route-proof-fullcloser-micro-8g-20260628T120551Z/summary.json`
versus
`ml/meta_runs/route-proof-baseline-nomicro-8g-i32-20260628T121036Z/summary.json`:
18.63 mixed-field VP and 21.50 no-`pvphunter` VP, both at 0% reach30. This
falsifies "the current local full-action selector is the missing 30-point
closer." The next useful surface is upstream route timing and farm-window
conversion, or a longer-horizon/reach30 branch objective that can create
corrections where the 6-round local scorer finds none.

The immediate longer-horizon follow-up did not rescue the full-action closer:
`ml/meta_runs/routeexecq-fullcloser-reach15-32w-20260628T121923Z/summary.json`
used horizons `6,10,15`, label horizon 15, reach30 bonus 12, and kill weight
0.5, but still found 32 windows, 0 corrections, and 0 samples.

A current-stack scaling-navigation pass did find sparse long-horizon signal.
`ml/meta_runs/scalingq-reach15-currenthp4-64w-20260628T123325Z/summary.json`
found 3 VP-positive corrections in 64 windows. The wider
`ml/meta_runs/scalingq-reach15-currenthp4-128w-20260628T124112Z/summary.json`
found 25 corrections in 128 windows, with source VP averaging 18.08 and max
source VP 24. Correction labels were mostly `Lantern Canyon` and `Arcane Abyss`,
including several +4/+6 VP rows. The exact 25-sample contract audit passed with
0 exact and 0 near observation conflicts, so this was not an obvious 55/52
aliasing failure.

However, the training/eval gate remained negative. Route imitation did not pass
the heldout threshold on the tiny split (0.667 top-1 / 0.833 top-3), manual
training produced only 0.400 top-1 after 12 epochs, and the matched route proof
`ml/meta_runs/route-proof-scalingq-reach15-currenthp4-8g-20260628T125425Z/summary.json`
tied the no-micro baseline exactly: 18.63 mixed VP and 21.50 no-`pvphunter` VP,
both at 0% reach30. Treat this as useful DAgger evidence, not a promoted
checkpoint. The next clean-route route-Q pass needs more high-value correction
states and validation-selected imitation before another proof run.

That larger validation-gated route-Q pass now exists. The 256-window current
stack collector,
`ml/meta_runs/scalingq-reach15-currenthp4-256w-20260628T130201Z/summary.json`,
scanned 770 navigation windows, kept 256 HP-4 route windows, and found 29
positive correction samples. Heldout route imitation passed at 1.000 train
top-1, 0.875 validation top-1, and 1.000 validation top-3, proving the current
55/52 contract can represent these labels.

Production training needed a stronger diagnostic schedule: the default 16-epoch
checkpoint only reached 0.345 training top-1, while 160-epoch warm-start and
scratch retrains both reached 1.000. Even then, route proof did not improve.
The isolated 16-game proof
`ml/meta_runs/route-proof-scalingq-reach15-currenthp4-warm160-16g-trace-20260628T133147Z/summary.json`
regressed to 18.06 mixed VP and 20.13 no-`pvphunter` VP, with missed farm VP
above 28%. The fair matched current-stack proof,
`ml/meta_runs/route-proof-scalingq-reach15-currenthp4-warm160-currentstack-16g-20260628T134151Z/summary.json`,
restored the route-exec micro policy and tied the current best exactly:
21.25 mixed VP, 22.31 no-`pvphunter` VP, status 0, and 0% reach30.

This closes the current scaling-navigation lane as non-promoted. The useful
diagnosis changed: with the route-exec micro present, missed farm VP is low
again (1.8% mixed, 2.7% no-`pvphunter`), but missed firepower opportunities are
about 30%. The next clean-route specialist should focus on firepower-ready but
not clean HP-4 states: clean-survival restoration timing, max/current barrier
thresholds, and when a probabilistic HP-4 attack is better than another
build/restore action.

That firepower-ready HP-4 specialist was implemented and rejected. The new
`routeCloserMicroPolicy` option in `src/lib/play/ml/selfplay.ts` layers a second
full-action specialist above the existing `microPolicy`: `MICRO_WEIGHTS` can
continue to handle `MICRO_GATE=location-interactions`, while
`ROUTE_CLOSER_MICRO_WEIGHTS` is used only inside the narrowed late restore-finish
route-closer states. Use `MICRO_GATE=route-closer-full` for intentionally broad
HP-4 wall experiments.
`_azeval.test.ts`, `_azmeta.test.ts`, `scripts/run-arc-route-proof-matrix.sh`,
and `scripts/run-arc-meta-eval-suite.sh` now forward that separate checkpoint.

The matched full-action collector
`ml/meta_runs/routeexecq-firepowerhp4-typed-96w-20260628T141556Z/summary.json`
kept 96 strict-Pure HP-4 windows and found 23 corrections. Most labels were
Lantern/Cyber/Floral sequencing choices rather than direct `startCombat`
choices. Manual training exported
`ml/meta_runs/routeexecq-firepowerhp4-typed-96w-20260628T141556Z/best_policy.json`,
but route proof rejected it:
`ml/meta_runs/route-proof-routecloserhp4-typed96-16g-20260628T143113Z/summary.json`.
Mixed-field VP dropped from the current best 21.25 to 20.50, no-`pvphunter` VP
dropped from 22.31 to 21.56, reach30 stayed 0%, and missed firepower stayed
about 31%.

Architecture implication: a layered micro contract is useful and should remain,
but small late HP-4 action patches are not solving the low-roll route. The next
research lane should move earlier: trace the 12-15 VP low-roll games and train
or search over current-barrier/re-entry timing before HP-4, especially Lantern
overuse, Tidal summon timing, and Cyber/Floral restoration decisions that affect
current barrier before returning to Arcane Abyss.

The trace-backed read is now sharper. The current-stack trace
`ml/meta_runs/route-proof-currentstack-lowtrace-8g-20260628T144402Z/summary.json`
shows that the worst lows arrive at HP-4 without firepower:
15 VP / attack 2 / Spirit Animal 2 in mixed game 0, and 12 VP / attack 3 /
Spirit Animal 3 in mixed game 5. The bot then loops build locations instead of
converting HP-4. A hand-draw/summon-resolution smoke
`ml/meta_runs/routeexecq-hp4-damagedeficit-summon-smoke2-20260628T145506Z/summary.json`
found no score-positive corrections even when `spawnHandSpirit` beat
`discardHandDraws` as a local label, so the issue is not just a discard bug.

The next evidence-backed lane is HP-4 damage-deficit navigation/re-entry. The
smoke `ml/meta_runs/scalingq-hp4-damagedeficit-smoke-20260628T145846Z/summary.json`
found 22 windows and 4 corrections with sources mostly at Tidal Cove but branch
bests mostly at Cyber City. This should become a larger validation-gated route-Q
collector before any promotion attempt. It should explicitly separate:
damage-deficit HP-4 (`firepower < 0.5`), firepower-not-clean HP-4
(`firepower >= 0.5`, `clean < 0.5`), and already-clean farm windows, because the
failed route-closer specialist mixed the latter two symptoms too late in the
route.

That larger collector has now run. The 160-window HP-4 damage-deficit pass,
`ml/meta_runs/scalingq-hp4-damagedeficit-160w-20260628T150730Z/summary.json`,
found 50 corrections and passed route imitation with 0.925 validation top-1 /
1.000 validation top-3. The learned checkpoint nevertheless tied the current
route-proof baseline exactly in
`ml/meta_runs/route-proof-damagedeficit-scaleq-16g-20260628T153453Z/summary.json`:
21.25 mixed VP, 22.31 no-`pvphunter` VP, status 0, and 0% reach30.

A live-gate probe exposed why this lane is still not enough. The collector
often preferred Floral Patch, so the `route-option-scaling` root set was
temporarily widened to include it. The proof
`ml/meta_runs/route-proof-damagedeficit-scaleq-floralroot-16g-20260628T154603Z/summary.json`
changed the route shape toward Floral Patch but did not raise VP, and in the
mixed field it allowed external `pvphunter` status events (max status 1, 724 cap
violations). That change was reverted. Architecture implication: keep the
current route-option-scaling root contract narrow until an external-PvP risk
guard exists. The next research surface is earlier than HP-4 re-entry: prevent
the low-roll state where the bot reaches HP-4 at 12-15 VP with attack 2-3 and
no firepower.

The next earlier surface was HP2 survivability. A trace read showed that the
bot can reach HP2 with enough firepower but not enough clean survivability, then
spend turns restoring while other seats deplete monster lives. The HP2
survival-deficit collector
`ml/meta_runs/scalingq-hp2-survivaldeficit-160w-20260628T161431Z/summary.json`
found a strong local counterfactual: Lantern Canyon sources, Floral Patch
corrections, 43 corrections in 160 windows, and a passing imitation model.

The naive integration result was negative. Using that checkpoint as the broad
`unsafe-firepower-build-option` navigation policy caused catastrophic over-rest:
`ml/meta_runs/route-proof-hp2-survival-nav-16g-20260628T164217Z/summary.json`
fell to 11.94 mixed VP and 12.00 no-`pvphunter` VP. The first narrow
`hp2-survival-deficit` gate also underperformed:
`ml/meta_runs/route-proof-hp2-survival-narrow-16g-20260628T165350Z/summary.json`
scored 20.31 mixed VP and 21.13 no-`pvphunter` VP, with one external PvP status
event in the mixed field.

The useful implementation is an ordered navigation-patch stack. `selfplay.ts`
now supports `patchNavigationPolicy` and `patch2NavigationPolicy`, both checked
before the main route-Q policy and the scale-Q policy. `_azeval.test.ts` and
`scripts/run-arc-route-proof-matrix.sh` expose them as `PATCH_NAV_WEIGHTS` /
`PATCH_NAV_GATE` and `PATCH2_NAV_WEIGHTS` / `PATCH2_NAV_GATE`. The live HP2
patch is deliberately narrower than the earlier gate: Pure HP2 only, rounds
6-18, VP 9-18, firepower-capable but not clean killable,
restore/survival-needed, and expected attack below 3.25.

The low-attack HP2 patch is clean but small. With the patch layer, route-Q,
scale-Q, route-exec micro, and both preserve guards, the 16-game proof
`ml/meta_runs/route-proof-hp2patch-routeq-scaleq-16g-20260628T173108Z/summary.json`
reached 21.63 mixed VP and 22.50 no-`pvphunter` VP, both strict-Pure clean. The
matched 32-game proof
`ml/meta_runs/route-proof-hp2patch-routeq-scaleq-32g-20260628T174111Z/summary.json`
scored 20.97 / 22.41 VP against the previous current stack's matched
`ml/meta_runs/route-proof-currentstack-32g-20260628T180202Z/summary.json`
20.78 / 22.31 VP. Status remained 0, but reach30 stayed 0%.

Architecture implication: keep the patch layer because it gives a safe way to
stack local specialists without replacing the broader route policy. Do not treat
the HP2 Floral patch as route solved. It is a clean candidate feature for the
league/value arbiter, and the next major route work still needs a stronger
post-low-rung extension loop.

The 16-game HP2 low-tail trace
`ml/meta_runs/route-proof-hp2patch-lowtrace-16g-20260628T191401Z/route-proof/strict-pure.trace-analysis.json`
made that next loop concrete. The stack averaged 21.63 VP with 0 status and
7.50 kills/game, but still reached 30 VP in 0% of games. Every traced game hit
an HP4 wall; 15/16 had current-barrier deficit there, 8/16 had max-barrier or
Cultivator deficit, and missed farm was tiny at 0.37 VP/game. The lowest game
reached HP4 with adequate survival shell (7/8 barrier, 2 Cultivator) but only
3.33 attack, then visited Tidal Cove 21 times and repeatedly selected
`discardHandDraws`. In other words, the navigation prior was aiming at damage
assembly, but full-action selection discarded the generated route-improving
hand-draw opportunities.

The current implementation response is a narrow route guard inside
`filterPlannerActions`: when either route-preservation flag is enabled,
`discardHandDraws` is rejected in strict-Pure committed monster-route states if
a legal `spawnHandSpirit` alternative improves the route build score. This keeps
the shared legal-action contract intact and prevents a trace-proven self-sabotage
without reintroducing live heuristic bots.

The matched guard proof
`ml/meta_runs/route-proof-handdrawguard-hp2patch-lowtrace-16g-20260628T200524Z/summary.json`
showed only a small lift: 21.69 VP versus 21.63, 7.56 kills/game versus 7.50,
low tail 2/16 instead of 3/16, still 0% reach30. That means the guard fixes one
form of self-sabotage but does not solve the route. The remaining 12 VP trace
is a safe sub-threshold farm problem: HP4, 7/8 barrier, monster damage 4, 44.4%
clean/firepower kill odds, positive expected reward, but below the old 0.5
farmability cutoff.

Two deterministic root patches were tested and rejected. The safe-probe patch
sent that state to Abyss, but the failed attempt dropped current barrier and the
route still stalled:
`ml/meta_runs/route-proof-safeprobe-handdrawguard-hp2patch-16g-20260628T201320Z/summary.json`
tied the hand-draw guard at 21.69 VP. The re-entry/root patch shifted more
navigation into Floral Patch and Abyss and reached 21.81 VP in
`ml/meta_runs/route-proof-reentryroots-handdrawguard-hp2patch-16g-20260628T202047Z/summary.json`,
but failed strict Pure with external PvP status pressure (max status 1, 337 cap
violations) and still had the 12 VP low. These root patches are not promoted.
The next route work should be trained/search-derived HP4 wall/re-entry policy,
not another hard-coded destination root.

Architecture implication: the clean-route stack now needs three independent
signals to improve together, not another farm-now patch in isolation:

- Navigation: when to leave Abyss for Floral/Lantern/Cyber/Tidal.
- Full-action execution: keep useful hand draws and route-critical spirits
  instead of discarding them after the navigation policy finds the right place.
- Re-entry timing: return to Abyss once the HP4 clean threshold is actually met,
  rather than looping a build destination after the last VP gain.

These signals are candidates for a league/value arbiter, not proof that the
route is solved. The next major route work still needs a stronger planner or
arbiter that turns HP2/HP4 local corrections into consistent 30-VP Abyss
farming.

Three follow-up HP4/re-entry experiments make that boundary explicit. The
full-action HP4 wall collector
`ml/meta_runs/routeexecq-hp4-wall-reentry-oracle-20260628T214500Z/summary.json`
scanned 192 windows but found only 8 corrections, average VP delta 0.09, and no
reach30 delta, so it refused to train. The scaling-navigation re-entry collector
`ml/meta_runs/scalingq-hp4-reentry-oracle-20260628T220000Z/summary.json`
scanned 256 windows but found only 2 corrections, average VP delta 0.02, and no
checkpoint. Finally, forcing the built-in
`MICRO_GATE=route-closer-oracle` in
`ml/meta_runs/route-proof-routecloser-oracle-currentstack-16g-20260628T222500Z/summary.json`
underperformed the current clean-route stack: strict Pure scored 20.75 VP and
no-`pvphunter` scored 21.75 VP, both still at 0% reach30. Conclusion: the next
HP4 lane should not be another generic branch collector or route-closer root
patch. It should be a trace-state counterfactual prover that snapshots exact
low-tail states around the last VP gain / HP4 wall, then replays deliberate
scripts for immediate Abyss probe, restore/Cultivator/max-barrier loop, damage
assembly, and timed re-entry against the current policy baseline.

That prover now exists as
`src/lib/play/ml/_tracestatecounterfactual.test.ts`, with a local smoke exposed
through `npm run test:bot:trace-state-counterfactual`. It captures exact
current-stack navigation states through the self-play probe hook, replays
`policy`, `abyss-probe`, `restore-loop`, `max-barrier-loop`,
`damage-assembly`, and `fixed-reentry` continuations, and reports VP/reach30/
status deltas against the `policy` continuation. Treat it as the next HP4 proof
surface before training another specialist.

The June 29 clean-inclusive finish-line run proved that signal exists but is
still too sparse for promotion. In
`ml/meta_runs/traceq-finishline-hp4-clean-inclusive-20260629T063436Z/summary.json`,
TraceQ captured 256 VP21-29 / HP4-HP10 windows, exported 267 samples, and found
7 restore-loop corrections with average correction delta `+3.14` VP and `+5`
reach30 delta in branch replay. The trained checkpoint was evaluated in
`ml/meta_runs/route-proof-finishline-cleaninclusive-16g-20260629T065824Z/summary.json`
and scored only 21.06 mixed-field VP / 21.94 no-`pvphunter` VP, both at 0%
reach30. The follow-up finish-loop activation proof
`ml/meta_runs/route-proof-finishline-cleaninclusive-finishloop-16g-20260629T071611Z/summary.json`
tied those numbers exactly, so the miss is not just the activation predicate. Do
not promote it. The useful conclusion is that restore/re-entry is a real
late-route subproblem, but current normal-start coverage does not yet turn those
rare corrected states into reliable 30-point games.

Important evidence hygiene update, June 29, 2026: TraceQ branch rollouts now cap
at `TRACEQ_MAXROUNDS` and summaries report `branchRolloutsCapAtMaxRounds`,
`roundCappedBranches`, `roundCappedWindows`, and `labelRoundCappedWindows`.
The capped rerun
`ml/meta_runs/traceq-finishline-hp4-clean-inclusive-capped-20260629T081724Z/summary.json`
used the same 48-game / 256-window finish-line slice with
`TRACEQ_MAXROUNDS=30`, `TRACEQ_HORIZONS=6,12,20`, and
`TRACEQ_LABEL_HORIZON=20`. It found 2 corrections (`0.8%`), 65 samples,
average VP delta `-0.13`, average correction delta `+2.00`, and `0` reach30
delta. All 256 label windows were max-round capped
(`roundCappedBranches=1536`, `labelRoundCappedWindows=256`). Treat the earlier
`+5` reach30 delta as optimistic continuation evidence, not proof of a legal
30-round finish-line route.

The legal-action finish oracle narrows that conclusion further. `ROUTE_FINISH_ORACLE=1`
layers a diagnostic full-action scorer above the current micro policy, and
`PATCH2_NAV_GATE=route-finish-loop` can constrain late navigation roots without
replacing the HP2 patch, route-Q, or scale-Q stack. The initial proof
`ml/meta_runs/route-proof-finishloop-oracle-16g-20260629T073324Z/summary.json`
raised no-`pvphunter` to 22.19 VP but still reached 30 in 0% of games. A
high-tail trace showed that offering both Lantern Canyon and Floral Patch during
restore deficits wasted turns on Floral rest rows. The Lantern-only restore
variant
`ml/meta_runs/route-proof-finishloop-oracle-lanternonly-16g-20260629T075035Z/summary.json`
improved to 22.44 VP / 7.81 kills/game with 0% reach30. A naive multi-kill
barrier-buffer variant
`ml/meta_runs/route-proof-finishloop-oracle-buffer-16g-20260629T075751Z/summary.json`
regressed to 22.19 VP by over-restoring and missing farm windows. Keep
`route-finish-loop` on the Lantern-only restore rule; treat the buffer run as
negative evidence.

Implementation note: the optional `routeCloserMicroPolicy` overlay in
`src/lib/play/ml/selfplay.ts` is intentionally narrower than
`MICRO_GATE=route-closer-full`. The overlay now targets only late restore-finish
states (round 16+, 24-29 VP, HP4-HP10, Pure, not already clean-farmable, and
enough remaining monster reward lives to reach 30, with either a current-barrier
restore deficit or survival-ready clean/firepower access). The broader HP4-wall
predicate remains useful for diagnostics and future fully trained specialists,
but it is too broad for tiny finish-line checkpoints.

The prover now also exports normal `arc-bot-v1` decision samples via
`TRACEQ_DATA_OUT`, and `scripts/run-arc-tracestateq-fullcontrol.sh` can train a
gated specialist when `TRAIN=1`. The first positive lane was not HP4. It was the
HP2-to-HP4 transition where the bot had enough firepower but not enough current
barrier and should restore/re-enter instead of overbuilding. The baseline
transition pass
`ml/meta_runs/tracestateq-hp2hp4-transition-data-20260628T230500Z/summary.json`
found 12 restore-loop corrections in 64 windows. Training on the larger
128-window shard in
`ml/meta_runs/tracestateq-hp2hp4-restore-train-20260628T231500Z/summary.json`
produced
`ml/meta_runs/tracestateq-hp2hp4-restore-train-20260628T231500Z/best_policy.json`.
When evaluated as `PATCH_NAV_GATE=hp2-survival-deficit`, the same diagnostic
dropped from 12 corrections to 2 and avg VP delta from 0.89 to 0.05 in
`ml/meta_runs/tracestateq-hp2hp4-restore-eval-20260628T233000Z/summary.json`.

That does **not** solve the full clean route. The matched 32-game route proof
`ml/meta_runs/route-proof-tracestate-restore-patch-32g-20260628T234000Z/summary.json`
scored strict Pure 20.81 VP and no-`pvphunter` 22.34 VP, both status 0 and 0%
reach30. So the current conclusion is: low-rung multi-life Abyss farming is real
and the HP2 restore miss is fixable, but the remaining route bottleneck is the
low-tail / late closure from low-20s to 30, not the simulator reward flow.

A low-tail trace run then narrowed that bottleneck further. With the HP2 TraceQ
patch active,
`ml/meta_runs/route-proof-tracestate-restore-lowtail-trace-32g-20260629T000000Z/route-proof/strict-pure.trace-analysis.json`
captured 11 games ending at 12-18 VP. They had zero missed farm VP, but every
one hit an HP4 wall and post-VP plateau navigation churn. Two HP4 first-wall
navigation specialists were trained from exact trace-state counterfactuals:

- `ml/meta_runs/tracestateq-lowtail-firsthp4-restore-train-20260629T002500Z/best_policy.json`
  from breakpoint-oracle continuations.
- `ml/meta_runs/tracestateq-lowtail-firsthp4-policy-20260629T013500Z/best_policy.json`
  from real policy continuations.

Both fixed their narrow first-wall diagnostics, but both failed route promotion.
The oracle-shard checkpoint scored 20.44 / 22.09 VP in
`ml/meta_runs/route-proof-hp2-hp4-traceq-patches-32g-20260629T012000Z/summary.json`;
the policy-shard checkpoint scored 20.63 VP in
`ml/meta_runs/route-proof-hp2-hp4-policytraceq-strict-32g-20260629T021000Z/summary.json`.
Both are below the HP2-only route proof, so `hp4-first-wall` is diagnostic-only
for now. The next HP4 lane should not be another isolated navigation patch. It
needs a full-action/DAgger route-execution lane that labels navigation, combat
timing, and reward/continuation decisions together.

That full-action lane is now wired to the same layered route stack as route
proof. `src/lib/play/ml/_routeexecutioncounterfactual.test.ts` and
`scripts/run-arc-routeexecq-fullcontrol.sh` accept `PATCH_NAV_WEIGHTS` /
`PATCH_NAV_GATE` and `PATCH2_NAV_WEIGHTS` / `PATCH2_NAV_GATE`, so the HP2
TraceQ restore patch can be replayed before route-Q navigation, scale-Q
navigation, and micro policy during both source-game generation and branch
rollouts.

The matched HP4 full-action proof did **not** produce a trainable DAgger lane.
With the HP2 patch active, the policy-continuation shard
`ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-20260629T020332Z/summary.json`
found 4 corrections in 64 HP4 windows; the breakpoint-oracle continuation
`ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-oracle-20260629T021217Z/summary.json`
found 8 corrections but 0 average correction VP; the VP-positive scoring shard
`ml/meta_runs/routeexecq-hp4-fullaction-hp2stack-vppos-20260629T021952Z/summary.json`
found only 3 point-paying corrections. None produced reach30 delta. The
corrections are mostly local build/micro choices, not an Abyss combat/reward
route. Do not train from these shards alone; the next proof needs either a much
broader late-route state distribution or exact low-tail trace-state DAgger that
generates many VP-positive combat, reward, and re-entry labels.

The trace-state DAgger infrastructure now has that exact-state sample path:
`TRACEQ_SAMPLE_MODE=both` exports the initial navigation label plus downstream
full-action labels from the best scripted continuation, and
`TRACEQ_FULL_SAMPLE_TYPES` can focus those full-action samples on combat,
monster reward, location-row, summon, market, rune, awaken, decision, and
augment actions. The first low-tail HP4 shards did not validate the lane:
`ml/meta_runs/traceq-lowtail-hp4-dagger-both-smoke-20260629T031033Z/summary.json`,
`ml/meta_runs/traceq-lowtail-hp4-dagger-both-oracle-smoke-20260629T031340Z/summary.json`,
`ml/meta_runs/traceq-lowtail-hp4-dagger-status3-smoke-20260629T031615Z/summary.json`,
and
`ml/meta_runs/traceq-lowtail-hp4-dagger-both-seed6500100-smoke-20260629T031931Z/summary.json`
all produced 12 windows, 0 corrections, 0 samples, 0 avg VP delta, and 0
reach30 delta. The scripted continuations can raise shaping/firepower signals,
but they do not produce clean HP4 kills or reward claims from these exact
low-tail states. Treat this as evidence against scaling the current scripted
trace-state DAgger lane. The next architecture move should be a stronger
survival/max-barrier oracle that first proves point-paying HP4 kills, or a
balance/status ablation that asks whether strict Pure HP4 survival is simply
under-supported by current rules.

The first stronger survival/max-barrier oracle is now implemented as the
`hp4-survival-oracle` TraceQ branch. The focused SimForge run
`ml/meta_runs/traceq-hp4-survival-oracle-20260629T104319Z/summary.json` captured
64 VP9-24 / HP4+ strict-Pure windows, compared policy, restore, max-barrier,
damage, fixed re-entry, and the new survival-oracle continuation, and exported
20 mixed navigation/full-action samples. It found 2 true VP-positive
corrections, both from `hp4-survival-oracle`, with +2.00 VP on the corrected
rows but only +0.06 VP averaged over the whole shard and 0 reach30 delta. This
moves the conclusion from "no scripted HP4 closer exists" to "a legal HP4/HP5
point-paying closer exists but is sparse and late." Do not train a major clean
specialist from this shard alone; the next architecture step is broader exact
low-tail/high-VP coverage or a deeper objective/search oracle that can create
30-point completions.

The broader exact-state coverage run
`ml/meta_runs/traceq-hp4-survival-oracle-wide-20260629T105620Z/summary.json`
filled 256 VP12-29 / round10-24 / HP4+ windows from 40 source games. It found
19 VP-positive corrections and exported 428 mixed navigation/full-action
samples, with corrections split between restore-loop 11 and
`hp4-survival-oracle` 8. The label is demonstrably learnable: the
candidate-aware contract audit passed at `55/52` with zero exact/near conflicts,
and route imitation reached validation top-1 0.898 / top-3 0.972 versus a 0.343
majority baseline. But the route-level verdict is still negative: average delta
was only +0.09 VP, corrected rows were +2.00 VP, and reach30 delta remained 0.
Architecture implication: HP4 restore/survival is a real narrow skill, not an
impossible or unrepresentable label, but the current objective still cannot
close the 30-VP route. Any training from this shard must be gated as a
specialist patch and followed by normal-start route proof; the next proof
question is how to create reach30-completing trajectories, not whether the model
can imitate local +2 VP fixes.

The route-level specialist ablation confirms that boundary. The trained
checkpoint
`ml/meta_runs/traceq-hp4-survival-oracle-wide-20260629T105620Z/best_policy.json`
was tested four ways: combined nav+micro
(`route-proof-hp4-survival-specialist-20260629T113600Z`), micro-only
(`route-proof-hp4-survival-microonly-20260629T114636Z`), nav-only
(`route-proof-hp4-survival-navonly-20260629T115643Z`), and a narrow
`route-finish-loop` navigation guard
(`route-proof-route-finish-loop-20260629T120741Z`). None reached 30. The best
strict result was the route-finish-loop guard at 21.56 VP / 0% reach30, while
the best no-`pvphunter` result matched the prior 22.44 VP / 0% reach30 ceiling.
Nav-only created 28 VP games, proving the route can reach the doorstep, but the
traces show VP26-28 states arriving too late or losing turns to current-barrier
restoration. Architecture implication: do not promote the HP4 survival
specialist. The next clean-route proof needs finish-line state collection with
reach30-completing labels, probably scoped to VP26-28, HP4 reward lives, current
barrier restoration timing, and immediate Abyss re-entry once clean-farmable.

The first finish-line prover shows that such labels exist and are representable,
but they still do not transfer into a solved route. The focused run
`ml/meta_runs/traceq-finishline-reach30-20260629T122717Z/summary.json` targeted
VP24-29 / round16-29 / HP4+ states and compared policy against
`finish-line-oracle`, `hp4-survival-oracle`, restore-loop, and fixed-reentry. It
captured 128 windows from 46 source games, exported 136 mixed navigation and
full-action samples, found 14 VP-positive corrections, and produced one positive
reach30 delta. All corrections came from `finish-line-oracle`. The dataset
passed the candidate-aware `55/52` contract audit with zero exact/near conflicts,
and route imitation reached validation top-1 0.971 / top-3 1.000 versus a 0.171
majority baseline.

The trained finish-line specialist
`ml/meta_runs/traceq-finishline-reach30-20260629T122717Z/best_policy.json` still
failed normal-start promotion. With the prior route-finish root,
`ml/meta_runs/route-proof-finishline-specialist-20260629T124508Z/summary.json`
scored 20.94 VP strict and 22.06 VP no-`pvphunter`, both 0% reach30. A
Floral-first large-deficit restore-root ablation
`ml/meta_runs/route-proof-finishline-floralroot-20260629T125751Z/summary.json`
also failed at 21.19 / 22.06 VP and 0% reach30, so that ablation was not kept as
the default `route-finish-loop` behavior. Architecture implication: keep
`finish-line-oracle` as a search/TraceQ diagnostic, but do not keep grinding tiny
finish-line fine-tunes. The next proof needs a broader VP24-to-30 route-exec
collector that optimizes the full kill/restore/re-enter cycle under round
pressure.

That broader route-exec pass has now been run. In
`ml/meta_runs/routeexecq-vp24-cycle-20260629T131405Z/summary.json`, the
current-best stack scanned 2,914 states, kept 256 VP24-29 / HP4 windows, and
found only 9 corrections. The labels were local and small (+0.05 average VP, no
reach30 delta), so late VP24+ full-action micro is not the next major training
lane by itself.

The important new proof is the 64-game current-best route matrix
`ml/meta_runs/route-proof-currentbest-hp4finish-64g-20260629T134118Z/summary.json`.
It reached 21.95 VP strict Pure with status 0/max 0, 95.3% win rate, 7.64
kills/game, and 6.3% reach30. The no-`pvphunter` slice reached 23.27 VP, 100%
win rate, 8.06 kills/game, and 3.1% reach30. This changes the architecture
status: strict Pure monster-economy is no longer an unproven normal-start route.
It is a proven but inconsistent route.

`scripts/analyze-route-trace.mjs` now reports high-tail finish conversion in
addition to low-tail issue counts. On the same proof's VP28+ traces, strict Pure
had 4 finishers and 6 near-misses; no-`pvphunter` had 2 finishers and 6
near-misses. In both slices, finishers averaged 0.83 more kills than VP28
near-misses. The next architecture step should be a success-prefix / contrast
collector that exports trainable `55/52` samples from normal-start trajectories
that do reach 30, compared against VP28-29 near-misses at matching HP4
reward-life states. Treat another small finish-line fine-tune or local
route-exec shard as lower leverage unless it creates those labels.

That collector now exists as an opt-in route-proof export. `ROUTE_SAMPLE_EXPORT=1`
causes AZEVAL route proof to write each variant's high-tail decisions into
separate `success/`, `near_miss/`, and `contrast/` trainable subdirectories, each
with its own `meta.json`. It can also write an opt-in `low_tail/` shard with
`ROUTE_SAMPLE_LOW_MAX_VP`; those rows default to `policyWeight=0`, meaning they
train value/regression without imitating the low-tail action. Do not point
training at the parent `.data` directory; the parent is an index, while the
subdirectories are the loader-safe datasets.

The first exported current-best proof
`ml/meta_runs/route-proof-sample-export-currentbest-20260629T143125Z/summary.json`
reproduced the current 64-game proof and produced enough data to train: strict
Pure exported 450 success rows plus 655 near-miss rows, and no-`pvphunter`
exported 219 success rows plus 652 near-miss rows. The combined contrast dataset
`ml/meta_runs/route-success-contrast-combined-20260629T151223Z/data` contains
1,976 rows from 18 high-tail games. Heldout imitation passed on the strict
contrast shard (`val_top1=0.844`, `val_top3=0.967`), so the current `55/52`
candidate contract can express these decisions.

The first specialist trained from the combined shard is not a promoted global
base, but it is a useful architectural signal. In the 32-game proof
`ml/meta_runs/route-proof-successcontrast-specialist-20260629T151330Z/summary.json`,
strict Pure improved to 23.13 VP and 8.22 kills/game with 6.3% reach30, while
no-`pvphunter` reached 23.34 VP and 8.28 kills/game with 3.1% reach30. The
64-game strict confirmation
`ml/meta_runs/route-proof-successcontrast-specialist-strict64-20260629T153347Z/summary.json`
held much of the average lift at 23.05 VP and 8.28 kills/game, but reach30 fell
to 3.1% and the low tail worsened, including a 3 VP game. Architecture
implication: success/near-miss contrast is a real lever for average VP and kill
density, but global replacement is too blunt. The next iteration should either
gate this specialist to validated high-tail route states or train with explicit
lower-tail regression samples.

The first narrow gate falsified the simplest high-tail overlay. In
`ml/meta_runs/route-proof-successcontrast-gated-closer-20260629T155715Z/summary.json`,
the base stack stayed global and the success/near-miss specialist was used only
through `ROUTE_CLOSER_MICRO_WEIGHTS`. This regressed strict Pure to 21.52 VP,
3.1% reach30, and 7.42 kills/game, and regressed no-`pvphunter` to 22.95 VP,
1.6% reach30, and 7.91 kills/game. Architecture implication: the contrast
checkpoint is not a drop-in late full-action micro policy. Its useful signal
probably lives in navigation/re-entry timing or in global build shaping, and any
next use should either be a navigation-level finish gate or a retrain that mixes
high-tail contrast with lower-tail regression samples.

The first navigation-level finish use did not move the line either. In
`ml/meta_runs/route-proof-successcontrast-navfinish-strict64-20260629T163748Z/summary.json`,
the success/near-miss specialist replaced the existing HP4 finish-loop
`PATCH2_NAV_GATE=route-finish-loop` policy. Strict Pure tied the current
reference exactly at 21.95 VP, 95.3% win, 7.64 kills/game, 8.09 Abyss
navs/game, status 0, and 6.3% reach30. Architecture implication: the current
contrast checkpoint should not replace the HP4 finish-loop patch. Future
finish-loop experiments need either a third, non-confounding navigation patch
slot or a broader retrain that includes lower-tail and VP24-30 re-entry
regression labels.

The farm-Q counterfactual lane is now connected to that stack but not promoted.
`_farmcounterfactual.test.ts` can export contract-compatible JSONL via
`FARMQ_DATA_OUT`, and the 128-window slice
`ml/meta_runs/farmq-data-audit-20260628T182818Z/summary.json` proved that
clean-farmable is a selective label, not a binary rule: only 70.3% of windows
preferred Arcane Abyss now at the 10-round label horizon. The contract audit and
route-imitation diagnostics passed (`55/52`, zero alias conflicts, validation
top-1 0.774 vs 0.710 majority). A small farm-Q checkpoint,
`ml/meta_runs/farmq-nav-128w-20260628T183330Z/best_policy.json`, was then tested
as `PATCH_NAV_GATE=clean-farm-q` with the HP2 patch in `PATCH2_NAV_GATE`.
The 16-game proof improved mixed VP to 21.75, but the matched 32-game proof
`ml/meta_runs/route-proof-farmq-hp2patch-routeq-scaleq-32g-20260628T184548Z/summary.json`
scored 20.94 / 22.41 VP, slightly below the HP2-only 20.97 / 22.41. Conclusion:
farm-Q is useful arbiter/DAgger infrastructure, but the first small farm-Q patch
is not the current-best route stack.

Farm-Q branch rollouts also cap at `FARMQ_MAXROUNDS` as of June 29, 2026, and
write the same cap counters in their summaries. Late clean-farm labels should be
used for training only when their real-round cap status is explicit.

All SimForge GPU runners used for this lane now sync their `ml/meta_runs`
artifact directory back even when the remote job exits nonzero after producing
evidence. This includes route proof, route-exec Q, scaling Q, meta eval, and the
pure/economy mixed lane. The scripts still propagate the remote failure after
syncing, so failed diagnostics remain visible while their summaries are not lost.
For local checkpoints that need to be pushed to the GPU box without syncing the
entire artifact tree, `scripts/sync-arc-bot-to-gpu.sh` accepts
`ARC_BOT_SYNC_META_RUNS=run_a,run_b` and rsyncs only those `ml/meta_runs`
directories.

## June 29 Damage-Contract Pass

The 22 VP plateau was not a rules ceiling. The route can score 30 in individual
games, but the average stayed near 22 because the learned policy was still too
often failing damage assembly and HP4 finish conversion.

The largest confirmed contract issue was damage-source visibility. Before this
pass, `encodeAction` could tell the model that a market spirit existed, but not
which class it represented; `encodeObs` also did not expose the player's current
damage-class composition. That made obvious lines such as "take Spirit Animal
now to unlock several farmable monster lives" harder to learn than they should
be. The current encoder contract is now `62/52`: seven observation slots track
current damage-class composition, and catalog-aware action slots identify market
spirit classes for `takeSpirit` and `replaceSpirit`.

The SimForge damage-contract bootstrap generated:

- `ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/data/cleanfarm/cleanfarm.jsonl`
  with 238 clean-farm rows and 73 reward-pick rows.
- `ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/data/abyss/abyss.jsonl`
  with 28,616 Abyss curriculum rows.
- `ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/data/farmq.jsonl`
  and `data/routeexecq.jsonl` with 64 rows each.

`ml/train.py` now recursively loads JSONL files under a data directory. This
matters because the first training attempt silently loaded only 128 top-level
rows while ignoring nested `success/`, `near_miss/`, and curriculum folders.
The corrected full bootstrap trained on 28,982 samples with `obs_dim=62` and
`act_dim=52`.

Rejected runs from this pass:

- Full bootstrap as the global policy, no nav specialist:
  `ml/meta_runs/route-proof-damage-bootstrap-strict16-20260629T190526Z`,
  6.38 VP. It overfit toward camping Abyss without enough build timing.
- Balanced bootstrap v1:
  `ml/meta_runs/route-proof-damage-balanced-v1-strict16-20260629T190936Z`,
  3.13 VP. Downsampling alone destroyed route execution.
- Nav-build specialist applied to all navigation:
  `ml/meta_runs/route-proof-damage-navbuild-v1-strict16-20260629T191613Z`,
  2.38 VP. The gate overcorrected away from farm.
- High-tail route-finish continuation used as a global policy:
  `ml/meta_runs/route-proof-damage-routefinish-v1-strict16-20260629T194535Z`,
  16.94 VP. Finish labels are useful, but not as a full replacement for
  opening/damage assembly.

The best current damage-contract lane is the full bootstrap policy plus the
nav-build specialist only behind `NAV_GATE=unsafe-firepower-build-option`.
`ml/meta_runs/route-proof-damage-navbuild-unsafe-strict32-20260629T192613Z`
scored 22.53 VP, 93.8% win, 3.1% reach30, 8.22 kills/game, 8.44 Abyss navs/game,
and clean status. This is a small lift over the prior strict reference, not a
solved bot. Treat it as the current 62/52 candidate baseline and confirm it with
a larger 64-game / higher-budget run before promotion.

The larger confirmation exists now:
`ml/meta_runs/route-proof-damage-navbuild-unsafe-strict64-hibudget-20260629T195417Z`
ran 64 games, 64 iterations, horizon 24, strict Pure/no-PvP. It improved the
current strict route-proof average to 23.83 VP, 96.9% win, 1.6% reach30,
8.78 kills/game, and 9.25 Abyss navs/game with status 0. This is the current
best strict Pure 62/52 route-proof baseline, but it is still not a solved bot:
reach30 is lower than the old high-water run, and the trace analysis still shows
HP4 wall/current-barrier deficit in every high-tail traced game.

The route-sample export
`ml/meta_runs/route-samples-damage-navbuild-unsafe-20260629T193536Z` produced
125 success, 383 near-miss, 1,489 low-tail value-only, and 508 contrast samples.
Those samples should be used for a gated finish micro or auxiliary target, not
as a global policy replacement.

Finish-overlay ablations after the 64-game confirmation did not transfer:

- `ml/meta_runs/route-proof-damage-finishoracle-strict32-hibudget-20260629T201640Z`
  enabled the hand-written route-finish oracle. It tied the 32-game control at
  22.59 VP and 3.1% reach30.
- `ml/meta_runs/route-proof-damage-routefinish-micro-strict32-hibudget-20260629T052045Z`
  used the existing high-tail route-finish checkpoint only as a late
  `ROUTE_CLOSER_MICRO_WEIGHTS` overlay. It also tied at 22.59 VP and 3.1%
  reach30.
- `ml/meta_runs/traceq-damage-nearmiss-vp28-29-20260630T053132Z` finally found
  teachable near-miss signal by filtering source games to VP28-29. It captured
  32 exact windows, 9 corrections, and 215 samples; branch comparison added
  +9 reach30 outcomes. The corrections were mostly `max-barrier-loop` (7) and
  `finish-line-oracle` (2).
- The trained near-miss specialist did not transfer under the narrow
  `route-finish-loop` gate:
  `ml/meta_runs/route-proof-damage-nearmiss-specialist-strict32-hibudget-20260630T054651Z`
  tied at 22.59 VP and 3.1% reach30.
- The same specialist under broad `route-closer` / `route-closer-full` gates
  regressed badly:
  `ml/meta_runs/route-proof-damage-nearmiss-specialist-routecloser32-20260630T055729Z`
  fell to 19.91 VP, 84.4% win, 0% reach30, 6.91 kills/game, and only
  6.97 Abyss navs/game. It over-routed to Floral Patch/Cyber City and reduced
  farm density.
- A later finish-navigation oracle pass
  `ml/meta_runs/route-proof-damage-finishnavoracle-strict32-hibudget-20260630T061223Z`
  raised reach30 to 12.5%, but average VP was only 22.66, below the 23.83
  strict baseline. Keep it as a diagnostic only.
- The first unrestricted pivot checks showed that the current stack does not
  attack players at all. Lookahead unrestricted
  `ml/meta_runs/meta-pivot-lookahead-20260630T062300Z/azeval-unrestricted.json`
  scored 18.88 VP with 0.00 PvP attacks/game and 0.00 PvP VP/game. Hybrid
  unrestricted
  `ml/meta_runs/meta-pivot-hybrid-20260630T063251Z/azeval-unrestricted-hybrid.json`
  scored 8.78 VP with the same 0.00 PvP attacks/game. The bot can become
  Fallen/status-3, but it mostly stays in Arcane Abyss, where PvP is illegal.
- Explicit opportunity instrumentation narrowed this further:
  `ml/meta_runs/pvp-opportunity-lookahead-20260630T063924Z` reported 0.00
  legal PvP opportunities/game, and
  `ml/meta_runs/pvp-pivot-oracle-fallenhunt-20260630T064718Z` reported 0.00
  Fallen-hunt oracle uses/game. The only traced Fallen finish became Fallen
  during the location phase while already reaching 30 VP, so there was no next
  navigation phase available for a hunt pivot.
- PvP imitation bootstraps were rejected:
  `ml/meta_runs/pvp-curriculum-pvphunter-bc-20260630T065341Z` trained on 6,435
  `pvphunter` samples and collapsed to 0.56 VP, while
  `ml/meta_runs/pvp-mix-route-pvphunter-bc-20260630T065655Z` mixed 54,722 route
  + PvP samples and still collapsed to 6.31 VP. Both had 0.00 legal PvP
  opportunities/game. Naive BC learns setup fragments without the timing needed
  to score.
- A focused PvP-pivot collector was added in
  `src/lib/play/ml/_pvppivotcurriculum.test.ts`, generating labels for class
  setup, intentional descent, hunt navigation, and `initiatePvp`. The first
  focused mix (`ml/meta_runs/pvp-pivot-focused-mix-20260630T071003Z`) generated
  2,351 focused samples but collapsed to 8.25 VP as a global policy. Gating it
  as a `pvp-pivot` nav/micro overlay
  (`ml/meta_runs/pvp-pivot-gated-overlay-20260630T072135Z`) improved PvP from
  zero to a few windows but still scored only 18.88 VP with 0% reach30.
- Two harness fixes matter for future reads: `_azeval.test.ts` now passes
  `pvpPivotOracle` through to `playPlannerSelfPlayGame`, and PvP VP is counted
  from resolved PvP combat ids rather than only immediate command deltas. The
  corrected 8-game oracle check
  (`ml/meta_runs/pvp-pivot-oracle-metricfix-20260630T074334Z`) scored 20.63 VP,
  0% reach30, 0.50 PvP attacks/game, 1.50 resolved PvP VP/game, and 6.25
  Fallen-hunt oracle uses/game. This confirms the intended route should include
  attacking Good players after the monster ladder becomes inefficient, but the
  current implementation under-produces resolved attack chains and gives up too
  much clean farm while setting up the pivot.
- Tightening the learned `pvp-pivot` gate protected the early monster farm but
  removed the pivot: `ml/meta_runs/pvp-pivot-lategate-overlay-20260630T074928Z`
  scored 18.88 VP, 0% reach30, 0 missed farm, and 0 PvP attacks/VP.
- The explicit late-descend oracle is now the best teacher target from this
  batch. `AZEVAL_PVP_PIVOT_ORACLE=late-descend-hunt` forces Abyss descent only
  after high VP / HP4+ / low farm-EV states, then hunts if Fallen. It scored
  23.38 VP with 50.0% reach30 in the 8-game smoke
  (`ml/meta_runs/pvp-pivot-latedescend-oracle-20260630T075351Z`) and 23.75 VP,
  43.8% reach30, 8.88 kills/game, 0% missed farm, and 0.19 PvP VP/game in the
  16-game proof
  (`ml/meta_runs/pvp-pivot-latedescend-oracle-16g-20260630T075721Z`). This nearly
  matches the best strict-Pure average while dramatically improving finishes.
  The current evidence says to train late corrupt monster descent first; resolved
  player-attacking remains a secondary unfinished head, not the primary unlock.
- The first positive-only distillation failed. A 32-game teacher export
  (`ml/meta_runs/latedescend-teacher-data-20260630T080701Z`) produced 1,000
  high-tail/near-tail route samples and 167 pure navigation samples. A
  `nav_build_policy.json` warm-start trained on those nav samples reached 86.8%
  top-1, but eval
  (`ml/meta_runs/latedescend-navpolicy-eval-20260630T081934Z`) fell to 19.56 VP,
  12.5% reach30, 6.88 kills/game, and 20.00 Abyss navs/game. It preserved
  clean-farm opportunities but overgeneralized the positive label and went Abyss
  too often before enough damage/dice were assembled.
- A scalar firepower-readiness guard on the learned `pvp-pivot` gate did not
  change that result:
  `ml/meta_runs/latedescend-navpolicy-firegate-eval-20260630T082820Z` matched
  the prior learned overlay exactly at 19.56 VP, 12.5% reach30, 20.00 Abyss
  navs/game, and 1.94 max dice/game. The fix must be data/contrast or a richer
  gate, not just a one-line threshold.
- A quick destination-balanced contrast pass duplicated non-Abyss labels and
  trained `latedescend_nav_balanced_policy.json` to 94.0% top-1, but
  `ml/meta_runs/latedescend-navbalanced-eval-20260630T083726Z` reached only
  19.75 VP, 12.5% reach30, 19.94 Abyss navs/game, and 2.00 max dice/game.
  Simple rebalance barely moved the needle; the missing signal is
  state-conditioned contrast, especially when a VP18+ / HP4-ish state still
  needs dice/max-barrier assembly before descent.
- The PvP-pivot curriculum was widened into a farm/build/pivot contrast
  collector and then tightened again around visible targets. The first contrast
  overlay (`ml/meta_runs/pvp-pivot-contrast-curriculum-20260630T085054Z`) trained
  on 2,223 focused samples but regressed to 20.69 VP because speculative hunt
  fallback produced too much `Floral Patch` wandering and only 0.75 PvP VP/game.
  The gate now treats `pvp-pivot` as "visible Good target outside Abyss" for
  Fallen navigation instead of "any Good player exists somewhere." With that
  visible-target gate, the same dynamic-hunt overlay scored 23.88 VP, 93.8% win,
  38% reach30, 9.56 kills/game, and 0 missed farm over 16 games in
  `ml/meta_runs/pvp-pivot-dynamic-hunt-curriculum-20260630T085900Z/azeval-pvp-visibletarget-gate-16g.json`.
  It recorded 0 legal PvP windows in the current weak heuristic field, so this
  is not proof that player-attacking is solved. It is proof that speculative
  PvP wandering should be disallowed and that player attacks need a neural-field
  arena with high-scoring Good opponents before they can be evaluated fairly.
- `_azeval.test.ts` now supports a neural-field arena (`AZEVAL_NEURAL_FIELD=1`)
  with target-only overlays and per-seat opponent status caps. The first
  Good-capped learned-opponent control
  (`ml/meta_runs/neural-field-pvp-goodcap-20260630T092500Z`) failed as an
  opponent model: target VP was 6.00, best-opponent VP was only 8.13, and legal
  PvP windows stayed at 0. A strong heuristic-field control
  (`ml/meta_runs/heuristic-strongfield-pvp-20260630T093000Z`) restored target VP
  to 23.38 but still created 0 legal PvP windows. The current evidence is that
  player attacking is a valid opportunistic branch, but the bot ecosystem lacks
  strong Good opponents that leave Abyss in attackable locations.
- The visible-target learned route is the current unrestricted non-oracle
  leader. The 64-game proof
  `ml/meta_runs/visible-target-route-proof-64g-20260630T093600Z/azeval-visible-target-route-proof-64g.json`
  scored 26.06 VP, 95.3% win, 54.7% reach30, 10.75 kills/game, 0% missed farm,
  and 0 PvP opportunities/VP. This decisively clears the old 23.83-ish average
  ceiling, but it is not a solved meta because low-tail games still land below
  20 and the route is effectively late monster/corruption conversion rather than
  a proven player-attack meta.
- Low-tail trace capture under the 26.06 leader
  (`ml/meta_runs/visible-target-lowtail-trace-20260630T095800Z`) found six
  VP<=23 games in a 16-game rerun. Four went Arcane Abyss all 30 rounds yet
  converted only 2-7 kills; traces show repeated Abyss navigation after
  `cleanKillProb=0`, farm EV 0, and firepower/Spirit Animal loss from full-action
  churn. Three quick patch attempts were rejected: broad nav-build layering
  (`visible-target-navbuild-combo-20260630T100700Z`) fell to 20.50 VP, narrow
  hp2 restore layering (`visible-target-hp2restore-combo-20260630T101500Z`) fell
  to 23.69 VP, and preserve firepower/survival guards
  (`visible-target-preserveguards-20260630T102200Z`) fell to 20.13 VP. Future
  work should train or hand-code a low-tail action discipline patch rather than
  reusing those broad layers.
- A narrower opt-in full-action discipline switch now exists as
  `AZEVAL_ABYSS_ROUTE_DISCIPLINE=1`. It forces immediate clean Abyss payoff
  actions while at Arcane Abyss and blocks voluntary cleanup discards that shed
  Spirit Animal / firepower on an active Abyss route. The first matched 16-game
  proof (`ml/meta_runs/visible-target-abyss-discipline-20260630T103000Z`) scored
  23.50 VP, 31.3% reach30, 9.44 kills/game, and 0 PvP attacks, below the matched
  no-discipline baseline at 23.88 VP. Keep this as a diagnostic only. The result
  says the remaining low-tail issue is not just "take the clean payoff when it is
  visible"; it is restore/build timing plus the missing transition into attacking
  high-scoring Good opponents once the monster route becomes inefficient.
- Navigation-time "visible target" hunting is structurally too weak because
  destinations are hidden until all players lock. A new diagnostic oracle,
  `AZEVAL_PVP_PIVOT_ORACLE=late-descend-predictive-hunt`, predicts likely Good
  target destinations from public state and only hunts once the planner is Fallen
  and monster conversion has weakened. This proves player attacks are a real
  scoring lane but not yet a promoted default. The 16-game proof
  (`ml/meta_runs/pvp-predictive-hunt-tight-20260630T104500Z`) improved the
  matched 16-game baseline from 23.88 to 24.31 VP and added 1.31 PvP VP/game.
  The 64-game proof
  (`ml/meta_runs/pvp-predictive-hunt-tight-64g-20260630T105500Z`) scored 25.31
  VP, 40.6% reach30, 9.48 kills/game, and 1.78 PvP VP/game, but still lost to
  the current 26.06 VP leader because it reduced Abyss density from 23.36 to
  14.70 navs/game and monster kills from 10.75 to 9.48. Use this oracle as
  teacher/contrast data for a learned pivot, not as the best bot.
- The learned predictive PvP overlay was the first unrestricted 64-game leader
  to beat the 26.06 VP visible-target route. A new `pvp-predictive-pivot`
  navigation gate activates only in the same
  narrow public-state conditions as the oracle, allowing a learned policy to hunt
  predicted Good-player build/restore locations before destinations are revealed.
  This is intentionally a Good-player attack lane: in the engine, a Fallen/Evil
  attacker that votes to attack co-located Good players during encounter combat
  receives a flat +3 VP even if the combat roll does not kill anyone. The route
  boundary should therefore compare remaining monster-farm value against a
  repeatable +3 VP player-attack action, not treat PvP as a rare last-hit trick.
  The 128-game curriculum shard
  (`ml/meta_runs/pvp-predictive-curriculum-20260630T111500Z`) produced 3,989
  labels: 383 cheap-farm nav, 1,032 build nav, 425 descend nav, 459 descend
  combat, 691 predictive-hunt nav, and 838 PvP-attack labels. Warm-starting from
  the dynamic-hunt overlay produced
  `ml/meta_runs/pvp-predictive-curriculum-20260630T111500Z/pvp_predictive_hunt_policy.json`.
  In the 16-game proof
  (`ml/meta_runs/pvp-predictive-learned-eval-20260630T112500Z`) it scored 26.63
  VP, 63% reach30, and 2.81 PvP VP/game. In the 64-game proof
  (`ml/meta_runs/pvp-predictive-learned-64g-20260630T113500Z`) it scored 26.86
  VP, 96.9% win, 51.6% reach30, 9.64 monster kills/game, and 2.91 PvP VP/game,
  beating the previous 26.06 VP visible-target leader. This confirms the intended
  meta shape: early/mid monster farming plus a learned late player-attack pivot.
  It is not a final proof of solved play because reach30 fell from 54.7% to
  51.6%, so the next improvement target is preserving the new PvP VP while
  restoring monster-finish density.
- A stricter `pvp-predictive-finish-pivot` gate was tested and rejected. The
  16-game probe
  (`ml/meta_runs/pvp-predictive-finishgate-eval-20260630T113952Z`) scored only
  23.88 VP, 13% reach30, 9.25 monster kills/game, and 0.56 PvP VP/game. This
  proves that "only pivot to PvP as a final closer" is too timid. The next gate
  should be value-based: continue farming cheap low-rung Abyss lives, then pivot
  once the current monster rung is difficult or low-value enough that a predicted
  Good-player encounter is the better 3-VP action.
- Two hand-gated variants after that did not beat the champion. The
  `pvp-predictive-value-pivot` probe
  (`ml/meta_runs/pvp-predictive-valuegate-eval-20260630T114914Z`) kept PvP at
  2.81 VP/game but fell to 24.75 VP and 8.56 monster kills/game, mostly by
  over-spending navigation on build/restore destinations. The
  `pvp-predictive-flex-pivot` probe
  (`ml/meta_runs/pvp-predictive-flexgate-eval-20260630T115544Z`) let the
  predictive PvP overlay choose `Arcane Abyss` as a root candidate and recovered
  the 9.50 monster kills/game shape, but scored 26.44 VP versus the matched
  broad-pivot 26.63 VP because it gave up a little PvP.
- A contrast curriculum was added as an opt-in data generator mode:
  `PVPPIVOTCURRICULUM_CONTRAST_FARM_RETURN=1`. The 128-game shard
  (`ml/meta_runs/pvp-contrast-curriculum-20260630T120258Z`) produced 4,194
  samples, including 302 `pvp-farm-return-nav`, 713 predictive hunt, and 719 PvP
  attack labels. The trained checkpoint
  `pvp_contrast_flex_policy.json` improved the monster side under
  `pvp-predictive-flex-pivot` (10.06 kills/game, 20.50 Abyss navs/game, 69%
  reach30) but dropped PvP to 1.50 VP/game and scored 26.50 VP. A hybrid with
  contrast navigation plus the old micro policy scored 26.25 VP. Keep the
  contrast collector as diagnostic material, but do not promote this checkpoint.
- Early-stopping the contrast training did not fix the over-conservative failure
  mode. The 12-epoch checkpoint
  (`ml/meta_runs/pvp-contrast-earlystop-20260630T121746Z/pvp_contrast_flex_policy_e12.json`)
  under `pvp-predictive-flex-pivot` scored 25.88 VP with 10.50 monster kills/game
  and 23.75 Abyss navs/game, but collapsed to 0.00 PvP attacks/VP per game
  (`ml/meta_runs/pvp-contrast-earlystop-e12-eval-20260630T121746Z`). Because the
  earliest contrast variant already eliminates PvP, the 24-epoch sibling should
  be treated as a diagnostic artifact, not a promotion candidate. The issue is
  representational: a single navigation policy head is conflating "return to
  Abyss" with "never hunt."
- Composing the current champion with the existing `route-finish-loop` patch did
  not improve it. The probe
  (`ml/meta_runs/pvp-predictive-routefinish-composite-eval-20260630T121746Z`)
  used `pvp-predictive-pivot` as `PATCH_NAV_GATE` and `route-finish-loop` as
  `PATCH2_NAV_GATE`, and exactly matched the 16-game broad-pivot proof at 26.63
  VP, 63% reach30, 9.50 kills/game, and 2.81 PvP VP/game. Treat this as a
  rejected non-improvement, not a new champion.
- Mixing the original predictive PvP shard with the contrast shard also failed.
  The mixed dataset
  (`ml/meta_runs/pvp-mixed-contrast-20260630T123135Z`) contains 8,183 samples:
  3,989 original predictive-hunt labels plus 4,194 contrast labels. The 24-epoch
  warm-started checkpoint under `pvp-predictive-flex-pivot`
  (`ml/meta_runs/pvp-mixed-contrast-e24-eval-20260630T123135Z`) scored 25.31 VP,
  56% reach30, 9.94 kills/game, and only 0.56 PvP VP/game. The mixed single-head
  policy still turns into "mostly return Abyss," so longer mixed single-head
  training should not be promoted without an architectural change.
- The first actual route-mode head became the prior unrestricted 64-game
  champion. `routeMode` is an optional obs-only auxiliary target/head exported in
  policy weights; old checkpoints still load without it. It is trained with
  `--policy-coef 0 --value-coef 0 --route-mode-coef 1.0` on top of the previous
  predictive checkpoint, so the candidate scorer remains the old champion and
  only the `hunt Good player` versus `return Arcane Abyss` decision is learned.
  The fresh route-mode shard
  (`ml/meta_runs/pvp-route-mode-20260630T124558Z`) produced 4,194 samples with
  1,015 route-mode labels: 713 hunt and 302 return-Abyss. The 16-game proof
  (`ml/meta_runs/pvp-route-mode-eval-20260630T124558Z`) scored 26.69 VP, 63%
  reach30, 9.44 kills/game, and 3.00 PvP VP/game, beating the matched
  broad-pivot 26.63 VP probe. The 64-game proof
  (`ml/meta_runs/pvp-route-mode-64g-20260630T124558Z`) scored 26.94 VP, 96.9%
  win, 53.1% reach30, 9.66 kills/game, 0.98 PvP attacks/game, and 2.95 PvP
  VP/game, beating the previous 26.86 VP champion. This initially promoted
  `AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-pivot` with
  `pvp_route_mode_head_policy.json` as the best bot. Do not call the meta
  solved yet: `pvphunter` still won 2 of 64 games, reach30 is only 53.1%, and
  missed clean-combat opportunity rose to 5.8%, so route-mode is an improvement,
  not proof that no avenue remains.
- The follow-up route-mode threshold sweep did not find a better cutoff.
  Thresholds 0.40, 0.55, and 0.80 all exactly matched the 16-game 0.50 proof:
  26.69 VP, 63% reach30, 9.44 monster kills/game, 1.00 PvP attacks/game, 3.00
  PvP VP/game, and 0% missed legal PvP opportunities
  (`ml/meta_runs/pvp-route-mode-threshold-sweep-20260630T131946Z`). This means
  the route-mode head is making saturated hunt-vs-Abyss calls in the current
  eval slice; more threshold tuning is unlikely to help.
- A 4-game traced eval at the promoted 0.50 threshold
  (`ml/meta_runs/pvp-route-mode-threshold-sweep-20260630T131946Z/trace050`) is
  the clearest current route read. Successful games farm HP1/HP2, reach the HP4
  or HP5 wall, become Fallen, then co-locate with non-Fallen Good players for
  resolved +3 VP `initiatePvp` attacks. The trace averaged 2.00 PvP attacks/game
  and 6.00 PvP VP/game, proving the bot is not meant to farm Abyss forever. The
  remaining low tails are different: one Pure game looped Arcane Abyss at 15 VP
  with farm EV 0 instead of rebuilding damage, and one Fallen game stalled at 27
  VP by camping a predicted PvP location after the target pool dried up.
- A broad `pvp-predictive-mode-disciplined-pivot` gate that combined Pure
  low-tail rebuild roots with the Fallen hunt fallback is rejected. It improved
  the 4-game trace from 26.50 to 28.50 VP by lifting the Pure low tail from 15
  to 20 and fixing the 27-VP Fallen camp, but its 16-game proof regressed to
  26.31 VP, 87.5% win, 62.5% reach30, 9.06 kills/game, and 3.19 PvP VP/game
  (`ml/meta_runs/pvp-disciplined-gate-20260630T141000Z/eval16`). Trace read:
  the Pure rebuild half over-used Floral Patch and created a new 20-VP rest
  loop, so do not promote broad no-farm-EV rebuild roots.
- Splitting out only the Fallen stale-target fallback produced the new
  unrestricted champion. The new gate is
  `AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-hunt-fallback-pivot` with the same
  `ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json`
  checkpoint. It keeps the current route-mode hunt-vs-Abyss decision, but if a
  Fallen bot repeatedly camps a predicted non-Abyss target and no PvP resolves,
  the next root set excludes that stale destination and offers other Good-target
  destinations plus Arcane Abyss. The 4-game trace
  (`ml/meta_runs/pvp-hunt-fallback-gate-20260630T142000Z/trace4`) scored 27.25
  VP, 75% reach30, 8.00 kills/game, and 6.75 PvP VP/game, fixing the VP27 dry
  camp while leaving the Pure low-tail route untouched. The 16-game proof
  (`ml/meta_runs/pvp-hunt-fallback-gate-20260630T142000Z/eval16`) scored 27.06
  VP, 100% win, 75% reach30, 9.44 kills/game, and 3.38 PvP VP/game. The 64-game
  proof (`ml/meta_runs/pvp-hunt-fallback-gate-20260630T142000Z/eval64`) scored
  28.39 VP, 96.9% win, 78.1% reach30, 9.75 kills/game, 1.41 PvP attacks/game,
  and 4.22 PvP VP/game. This beats the prior 26.94 VP champion by +1.45 VP while
  increasing both monster kills and PvP scoring. It is now the current best bot.
- A narrower Pure survival-restore fallback was also tested and rejected, then
  removed from the callable gate list. It tried to send Pure players to
  Floral/Lantern only when firepower was ready but current barrier was below the
  clean survival threshold. The 4-game smoke
  (`ml/meta_runs/pvp-restore-fallback-gate-20260630T144000Z/trace4`) collapsed to
  17.25 VP, 0% reach30, 6.00 kills/game, and 0 PvP. Even this narrow restore rule
  prevented the corruption/PvP conversion and trapped the bot in Pure, so Pure
  low-tail recovery should be learned from counterfactual/full-action labels
  rather than added as another hand navigation gate.
- The current unrestricted champion is now the hunt-fallback navigation stack
  plus the `pvp-pivot-encounter-force` micro gate. The trace-only fields
  `pvpTargetCount`, `pvpTargetVp`, `pvpBestTargetVp`, and `pvpTargets` were added
  after the shared neural-field trace found three passed encounters against a
  13-VP Good target. The force gate does not change navigation or build actions;
  it only chooses `initiatePvp` when that command is already legal in an
  encounter. In the shared-stack neural-field A/B, the value gate scored 16.42 VP
  with 7.25 PvP VP/game and 12.1% missed legal PvP, while
  `pvp-pivot-encounter-force` scored 16.67 VP, 7.50 PvP VP/game, and 0% missed
  legal PvP (`ml/meta_runs/pvp-encounter-force-neuralfield-20260630T162000Z`).
  In the regular heuristic-field proof, the 16-game run scored 28.38 VP, 81%
  reach30, and 5.25 PvP VP/game
  (`ml/meta_runs/pvp-encounter-force-heuristic-16g-20260630T163000Z`), and the
  64-game proof scored 29.69 VP, 98.4% win, 85.9% reach30, 8.30 monster
  kills/game, 1.91 PvP attacks/game, 5.72 PvP VP/game, and 0% missed legal PvP
  (`ml/meta_runs/pvp-encounter-force-heuristic-64g-20260630T163500Z`). This beats
  the previous 28.39 VP champion by +1.30 VP and directly confirms the intended
  pivot: farm efficient Abyss lives, then attack co-located Good players once the
  monster route is no longer the best closeout.
- Fresh target-quality columns now distinguish "PvP was legal and clicked" from
  "the league contained high-VP Good targets." The compact heuristic-field smoke
  `ml/meta_runs/pvp-target-quality-smoke-20260630Tgoal/azeval.json` scored 27.25
  VP, 75% reach30, 8.25 monster kills/game, 1.25 PvP attacks/game, and 3.75 PvP
  VP/game, but its best legal Good target had only 5 VP and it saw 0 high-value
  (12+ VP) PvP windows. The shared Good-builder smoke
  `ml/meta_runs/shared-goodbuilder-target-quality-smoke-20260630Tgoal/azeval.json`
  scored 22.50 VP with 10.50 PvP VP/game and 0 missed legal PvP, but field-best
  opponent VP was only 8 and best legal target VP was 9. The stronger same-stack
  champion mirror
  `ml/meta_runs/champion-sharedstack-target-quality-16g-20260630Tgoal/azeval.json`
  scored only 14.63 VP, field-best 15.19 VP, 6.19 PvP VP/game, best legal target
  VP 13, and 1.06 high-value PvP windows/game. Read: attacking Good players is
  part of the strongest route, but the league is not solved until it can sustain
  multiple strong roles without collapsing into a shared low-scoring equilibrium.
- PvP can only attack Good players at non-Abyss locations, so the intended
  unrestricted route is specifically: farm cheap/mid Arcane Abyss lives, become
  Fallen when the monster ladder is no longer efficient, then hunt Good players
  at Floral Patch, Tidal Cove, Cyber City, or Lantern Canyon while they restore
  or build. `_azeval` now reports HP4+ pivot counters
  (`planner_pvp_hard_monster_*`) so this does not get lost inside generic PvP
  totals, and stricter Good-target pivot counters
  (`planner_pvp_good_target_pivot_*`) for legal attacks into non-Evil players
  worth at least 12 VP while the monster is HP4+. In the first 16-game audit
  `ml/meta_runs/hunter-vs-good-mixed-targets-pivotaudit-16g-20260630Tgoal/azeval.json`,
  the hunter scored 25.69 VP, 63% reach30, 4.00 monster kills/game, and 13.88
  PvP VP/game; every PvP attack happened in an HP4+ monster window and missed
  HP4+ PvP was 0%. This confirms the hunter is remembering the farm-then-hunt
  branch. The unsolved problem is still target quality: field-best Good VP was
  only 9.75 and high-value windows were 0.06/game.
- The cheap existing Good heuristics are not a hidden solution. A 32-game audit
  (`HAUD_PROFILES=paragon,culrush,rushpatient,cultivator,survivor,hard,medium,pvphunter`)
  scored `pvphunter` at 28.4 VP / 88% reach30, while the best non-corrupt profile
  was `survivor` at only 8.8 VP and every Good/economy profile stayed below 9 VP.
  This rules out simply seeding the neural league with the old hand-authored Good
  bots.
- `_azeval` can now mine all neural-field seats with
  `AZEVAL_ROUTE_SAMPLE_ALL_SEATS=1` and optionally filter by
  `AZEVAL_ROUTE_SAMPLE_MAX_STATUS_LEVEL`. The first strict Good-final mining
  smoke (`ml/meta_runs/good-seat-sample-mining-smoke-20260630Tgoal/azeval.json`)
  produced 0 rows, proving that high-value Good target windows are often
  transient rather than final-state Good wins. Relaxing the final-status filter
  in `ml/meta_runs/all-seat-sample-mining-smoke-20260630Tgoal/azeval.json`
  produced 2,021 all-seat contrast rows from 8 shared-stack games, which trained
  `allseat_contrast_policy.json`.
- The all-seat contrast checkpoint is not promotable, but it is a useful
  target-field teacher. As the shared stack it regressed target-seat VP to 7.88
  while lifting field-best VP to 17.13. As a capped Good-builder field
  (`ml/stacks/neural-field-allseat-good-builders.json`), the hunter scored 16.50
  VP with 12.75 PvP VP/game, best legal target VP 14, and 1.63 high-value PvP
  windows/game. The baseline Good-builder field scored a stronger 20.63 hunter
  VP but best legal target VP only 9 and 0 high-value windows. A mixed field
  (`ml/stacks/neural-field-mixed-good-builders.json`) scored 19.13 hunter VP and
  field-best 9.50, but also lost high-value windows. Read: all-seat mining has
  found a target-quality signal, not a stable Good-builder archetype yet.
- A medium GPU all-seat Good-builder lane
  (`ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/summary.json`, 24
  mining games, 5,289 contrast samples, GPU 4) sharpened this conclusion. The
  trained all-seat policy is not usable as a shared unrestricted stack: it
  collapsed to 1.75 VP, 0% reach30, 0 PvP VP, 1.88 Abyss navs/game, and 0.63
  monster kills/game. However, as a target field it improved the hunter's
  farm-to-PvP conversion. Against the baseline Good field, the hunter scored
  20.63 VP, 12.5% reach30, 9.38 PvP VP/game, best legal target VP 9, and 0
  high-value windows. Against the trained Good field, the hunter scored 21.25
  VP, 37.5% reach30, 14.63 PvP VP/game, best legal target VP 13, and 1.5
  high-value windows/game. Against the mixed field, the hunter scored 21.38 VP,
  50% reach30, 13.88 PvP VP/game, and best legal target VP 14. Read: the
  player's reminder is correct; the unrestricted route should pivot from
  efficient Abyss farming into attacking valuable Good players. The missing
  piece is a Good-builder policy that also scores well on its own instead of
  only serving as prey.
- A hand-scored `good-builder-oracle` teacher was added as an opt-in
  navigation/micro gate plus stack manifest
  (`ml/stacks/neural-field-good-oracle-builders.json`) and rejected as the next
  scaling lane. The first version over-cultivated at Lantern Canyon, bought
  Cursed augments, missed 99.1% of farmable Abyss navigation, and scored only
  0.75 VP. After forcing farmable Abyss roots and penalizing Cursed purchases,
  the shared Pure field improved to 11.5 VP, 4.00 monster kills/game, 0 status,
  and 2.9% missed farmable navigation
  (`ml/meta_runs/good-oracle-shared-smoke-20260630Tgoal/azeval.json`); the
  relaxed HP4 breakpoint sibling stayed at 11.38 VP with 0% missed farmable
  navigation
  (`ml/meta_runs/good-oracle-breakpoint-smoke-20260630Tgoal/azeval.json`).
  Against this oracle field, the hunter reached only 19.63 VP, 12.00 PvP
  VP/game, best legal target VP 9, and 0 high-value windows
  (`ml/meta_runs/hunter-vs-good-oracle-breakpoint-smoke-20260630Tgoal/azeval.json`),
  below the trained all-seat Good target field. Read: one-step Good class/value
  scoring can repair the obvious "miss farmable Abyss" bug, but it still learns a
  contested low-scoring field. Do not train from this oracle until it can produce
  high-VP Good targets on its own.
- The next portfolio pass added role-split Good target fields:
  `good-builder-farmer-oracle`, `good-builder-support-oracle`,
  `ml/stacks/neural-field-good-antiovercontest-oracles.json`,
  `ml/stacks/neural-field-good-mixed-targets.json`, and
  `ml/stacks/neural-field-good-mixed-targets-trained-heavy.json`. The 16-game
  portfolio summary lives at
  `ml/meta_runs/good-target-field-portfolio-20260630Tgoal/summary.json`.
  Anti-overcontest improved the hunter's total route result:
  `hunter-vs-good-antiovercontest-16g` scored 25.19 VP, 62.5% reach30, 12.56
  PvP VP/game, best target VP 13, and 0.38 high-value windows/game. The balanced
  mixed target field scored 24.31 VP with the best PvP conversion so far in this
  lane: 14.81 PvP VP/game, best target VP 13, and 0.63 high-value windows/game.
  The trained-heavy mix raised target-field best VP to 11.13 and high-value
  windows to 0.94/game, but hunter VP dropped to 21.88. Verdict: heterogeneous
  Good target fields are better dashboard/league probes than a single Good
  mirror, but they still are not solved. Field-best Good VP remains around 8-11,
  so no Good-builder archetype is competitive on its own yet.
- A follow-up Good-target oracle pass found two diagnostic failures, neither of
  which is promotable. Tightening `good-builder-support-oracle` to take clean
  cheap farm instead of support-building through it kept missed farmable
  navigation at 0% but scored only 7.88 VP in
  `ml/meta_runs/good-antiovercontest-supportfarm-smoke-20260630Tgoal/azeval.json`.
  An explicit market-action scoring tweak for Spirit Animal/damage acquisition
  was rejected after it collapsed to 4.88 VP in
  `ml/meta_runs/good-antiovercontest-actionfix-smoke-20260630Tgoal/azeval.json`.
  Keep these as diagnostics: the next Good-builder improvement should come from
  stronger target-field training/search, not another one-step hand gate unless a
  trace shows a specific legal-action omission.
- Follow-up league diagnostics did not find a simple counter-strategy or hand
  gate. `_azeval` now has `AZEVAL_TRACE_ALL_SEATS=1`, which records every
  planned seat in neural-field traces. The all-seat mirror trace
  (`ml/meta_runs/pvp-force-shared-allseat-trace-20260630T171000Z`) showed the
  current same-stack failure mode: copies diverge after the early Abyss farm,
  some become Fallen and find PvP windows, while others loop rebuild locations
  with no target and no closeout. A Good-capped target against unrestricted
  champion opponents collapsed to 2.50 VP / 0% win
  (`ml/meta_runs/goodcap-target-vs-pvp-force-neuralfield-20260630T170000Z`), so
  "just stay Good" is not a viable counter-strategy with this stack. The champion
  against Good-capped neural opponents scored 20.17 VP / 100% win but 0 PvP
  VP/game (`ml/meta_runs/pvp-force-vs-goodcap-neuralfield-20260630T170000Z`),
  proving that Good-capped copies are not strong enough to model the target-rich
  high-level field. A narrow status-2/Fallen clean-ready re-entry navigation
  gate was tested and removed from callable code after it regressed the matched
  shared-field probe to 12.92 VP and 3.75 PvP VP/game
  (`ml/meta_runs/pvp-reentry-force-neuralfield-20260630T172000Z`).
- The neural-field harness now supports real heterogeneous bot stacks, not just
  different base weight files. `_azeval` can load
  `AZEVAL_NEURAL_FIELD_STACKS_FILE` / `AZEVAL_NEURAL_FIELD_STACKS_JSON`, where
  each opponent stack may carry its own base weights, navigation prior, patch
  gates, micro policy/gate, status cap, command bans, and route-preservation
  constraints. `playPlannerSelfPlayGame` now honors per-seat navigation patches,
  per-seat micro gates, and per-seat preservation flags. `_azgen` also now passes
  `AZ_NAV_GATE`, `AZ_PRESERVE_ROUTE_FIREPOWER`, `AZ_PRESERVE_ROUTE_SURVIVAL`,
  and `AZ_ABYSS_ROUTE_DISCIPLINE`, so shared-field training can use the same
  route contract as eval. The reusable entrypoint is
  `npm run bot:shared-pure-league`, backed by
  `scripts/run-arc-shared-pure-league-smoke.sh`.
- The first current-contract Good-builder lane closed off the naive fix. The
  old 22-23 VP Pure builder checkpoints were pre-62-observation-contract and
  cannot be used in the current league, so the compatible Good-builder manifest
  `ml/stacks/neural-field-good-builders.json` uses the current
  `damage-contract-bootstrap` base plus `nav_build_policy`. In heuristic-field
  strict-Pure proof this stack reached 23.83 VP, but in a learned Pure mirror it
  collapsed. The remote run
  `ml/meta_runs/shared-pure-league-20260630T181500Z` generated 7,199 all-seat
  Pure samples from 16 games and trained a warm-started Pure policy on GPU 4.
  Baseline Pure mirror scored 6.00 VP / 12.5% win / 0% reach30 with field-best
  9.25 VP; the trained Pure mirror regressed to 5.63 VP / 12.5% win / 0%
  reach30 with field-best 8.88 VP. The current hunter against that trained Pure
  field scored 12.00 VP, 62.5% win, 12.5% reach30, 1.25 PvP attacks/game, 3.75
  PvP VP/game, and 0% missed legal PvP. Verdict: naive all-seat Pure self-play
  reinforces the weak shared Abyss-overcontest equilibrium and does not create
  the high-scoring Good-player target landscape.
- A second Good-builder pass added the `pure-farm-build` navigation gate, which
  sends Pure players to Arcane Abyss only when a clean farm reward is available
  and otherwise narrows damage assembly to Tidal Cove/Cyber City. This improved
  the target field, but still did not solve shared Good play. The sampled run
  `ml/meta_runs/shared-pure-farmbuild-20260630T183500Z` produced weak data
  (8,732 samples, planner VP 3.83); baseline Pure mirror scored 8.75 VP, hunter
  vs baseline Pure scored 18.88 VP with 10.88 PvP VP/game, trained Pure mirror
  regressed to 7.38 VP, and hunter vs trained Pure reached 24.00 VP with 16.13
  PvP VP/game. Deterministic generation improved the data quality in
  `ml/meta_runs/shared-pure-farmbuild-deterministic-20260630T190000Z`
  (10,557 samples, planner VP 7.77, 0% missed farmable navs), but the trained
  Pure mirror still scored only 7.88 VP against a baseline 8.75 VP, and hunter
  vs trained Pure scored 17.25 VP with 10.13 PvP VP/game. Interpretation: the
  farm-to-PvP route is correct, but the next target-field builder must learn
  anti-overcontest Good scoring and non-Abyss damage/passive VP, not plain
  all-seat Pure imitation.
- A follow-up target-builder pass corrected an important rules assumption:
  "Good target" is not the same as "Pure target." The engine only treats status
  3/Fallen as Evil, so status 0/1/2 players are still non-Fallen Good targets
  for a Fallen hunter. The new `good-nonfallen-farm-build` navigation gate and
  `ml/stacks/neural-field-good-nonfallen-targets.json` let target builders spend
  status 0/1 corruption budget on HP4/HP5 monster kills while capping status at
  2 and forbidding `initiatePvp`. Direct gate-assisted evaluation reached 13.75
  VP, 4.88 kills/game, status 1.94, max status 2, and 0 cap violations in
  `ml/meta_runs/good-nonfallen-farmbuild-field-16g-20260630Tgoal/azeval.json`.
  Mining then produced 2,531 contrast rows in
  `ml/meta_runs/nonfallen-goodbuilder-train-smoke-20260630Tgoal/mining_eval.json`.
  The all-seat warm-start checkpoint regressed and is rejected, but the
  from-base checkpoint held 13.13 VP / 4.75 kills/game with 0 cap violations and
  created the strongest target-quality probe so far: hunter-vs-trained scored
  16.31 VP with 7.50 PvP VP/game, HP4+ PvP VP equal to 7.50, best legal target
  VP 17, and 1.0 high-value Good window/game
  (`ml/meta_runs/nonfallen-goodbuilder-train-smoke-20260630Tgoal/hunter_vs_from_base_16g.json`).
  This is not promotable, but it is the right next GPU lane: scale non-Fallen
  Good-builder training with better HP4 corrupt-farm conversion labels and test
  it in heterogeneous league fields.
- The first medium version of that lane is now a negative result, but it
  clarified the next data requirement. `npm run bot:nonfallen-goodbuilder`
  wraps the all-seat Good-builder harness with `good-nonfallen-farm-build`,
  `maxStatusLevel=2`, `forbidTypes=initiatePvp`, `MINE_SUCCESS_VP=15`, and
  `MINE_NEAR_MIN_VP=10`. The run
  `ml/meta_runs/nonfallen-goodbuilder-medium-20260630Tcontinue/summary.json`
  mined 48 games on GPU 4 and found only 197 contrast rows, all near-miss rows
  and 0 success rows. Direct capped target evaluation proved the target contract
  was obeyed, but the trained policy regressed: baseline target field scored
  11.81 VP / 4.31 kills/game / status 1.88 / max status 2 / 0 cap violations,
  while the trained target field scored 7.06 VP / 2.38 kills/game / status 1.94
  / max status 2 / 0 cap violations. The hunter-vs-trained field also regressed
  from 20.50 VP and 7.88 HP4+ PvP VP/game to 14.00 VP and 4.13 HP4+ PvP
  VP/game. The mixed field did improve target-quality diagnostics (field-best
  13.63 VP, best legal target 17, 0.88 high-value windows/game, 8.06 HP4+ PvP
  VP/game), but not total hunter performance. Verdict: do not scale this exact
  near-miss-only behavior-cloning lane. The next non-Fallen lane needs
  counterfactual/state-selection labels for HP4 corrupt-farm conversion,
  anti-overcontest departure from Abyss, and non-Abyss Good scoring, not simply
  more near-miss imitation.
- `npm run bot:nonfallen-farmq` now provides that first counterfactual probe.
  It extends FarmQ so strict clean/Pure remains the default, while the
  non-Fallen runner can qualify status<=2 HP4/HP5 windows where firepower or
  controlled corruption can kill the monster, with `initiatePvp` forbidden and
  max status capped at 2. The first uncapped medium diagnostic
  `ml/meta_runs/nonfallen-farmq-medium-h6-20260630Tcontinue/run_summary.json`
  collected 200 HP4 windows from 32 games, with `labelHorizon=6`,
  `labelRoundCappedWindows=0`, 83.5% "farm now" labels, +2.37 VP average
  farm-vs-build delta, and 181/200 windows driven by firepower rather than clean
  kill probability. This proves a real HP4 firepower-farm signal. Training it as
  a standalone navigation replacement is rejected, though:
  `nonfallen_farmq_nav_policy.json` reduced direct target-field VP from 11.81 to
  8.56 and hunter-vs-target VP from 20.50 to 14.31. It did raise best legal
  target VP from 12 to 18, so the signal is useful as a target-quality/auxiliary
  label, but too blunt as the main nav policy. Next training should mix FarmQ
  with direct target-builder success data or use it as an auxiliary farm-return
  head, not replace Good-builder navigation outright.
- The first direct-plus-FarmQ mix also failed as a promotion, which narrows the
  next architecture. `ml/meta_runs/nonfallen-mixed-farmq-20260630Tcontinue`
  mixed 2,531 direct non-Fallen Good-builder contrast rows with three copies of
  the 200-row FarmQ HP4 shard, then warm-started from the full base policy. It
  improved direct target VP versus FarmQ-only (8.56 -> 9.63), but stayed below
  both the baseline target field (11.81) and the previous direct from-base
  checkpoint (13.13). More importantly, it weakened the intended farm-to-PvP
  contract: hunter-vs-field fell to 11.06 VP, 2.81 HP4+ PvP VP/game, best legal
  target VP 13, and 0.5 high-value Good windows/game. The bot should farm
  efficient HP1/HP2/HP4 monster lives first, then attack valuable non-Fallen Good
  players when monster EV is worse; this mixed policy did not preserve that
  pivot. Treat FarmQ as a scalar farm-return auxiliary/route-mode signal or a
  very low-weight policy prior, not as another single-head cross-entropy action
  target.
- FarmQ value-only wiring is now implemented, but the first auxiliary uses are
  also rejected as promotions. The collector can write `policyWeight: 0` rows and
  a counterfactual `farmValue = clamp(farmQDeltaVp / 3, 0, 1)` target; the
  non-Fallen runner now defaults to value-only FarmQ samples. The medium H6 shard
  in `ml/meta_runs/nonfallen-farmq-aux-medium-h6-20260630Tcontinue/run_summary.json`
  has 200 samples, 167 nonzero farm-value targets, average target 0.6783,
  `labelRoundCappedWindows=0`, and the same 83.5% farm-now / +2.37 VP signal.
  Training with `policyCoef=0`, `valueCoef=0`, and `farmValueCoef=1` correctly
  left action/value heads unchanged, but global leaf-value injection regressed:
  base+aux scored 10.81 VP at `ARC_FARM_VALUE_AUX_SHAPE=0.25` and 10.19 VP at
  0.10, versus the 11.81 baseline target field. Applying the same aux head to
  the prior direct from-base target-builder regressed from 13.13 VP to 10.38
  (0.25) and 10.19 (0.05). A narrower HP4/HP5 `lockNavigation:Arcane Abyss`
  action bonus was added behind `ARC_FARM_NAV_AUX_SHAPE`, but the first gated
  proof still scored only 9.94 VP. Hunter-vs-base-aux kept some pivot pressure
  (5.81 HP4+ PvP VP/game, best target 14) but trailed the 20.50 VP / 7.88 HP4+
  PvP baseline. The learned-head navigation-root prior was then added through
  `AZEVAL_FARM_VALUE_SOURCE=head` plus HP4/HP5/status gates. It also scored
  9.94 VP in the matched 16-game from-base target eval. Diagnostics showed the
  prior was real (2.31 applications/game, average head score 0.553, average
  Arcane logit bonus 2.21), but a 4-game trace showed 100% of applications
  already chose Arcane Abyss. Conclusion: FarmQ is real data, but do not inject
	it as policy CE, mixed CE, global leaf value, full-action Arcane bonus, or the
	tested HP4/HP5 root-prior bonus. The remaining bottleneck is not "notice HP4
	Arcane now"; it is stronger target-builder play and post-farm conversion into
	valuable Good-player targets.
- The first explicit post-farm PvP-target pivot is positive as a dashboard/league
  instrument, but not yet a champion promotion. The new
  `good-nonfallen-farm-target-pivot` navigation gate keeps cheap HP1/HP2 and
  still-efficient HP4 monster farming, then moves non-Fallen Good players onto
  normal locations once monster EV falls behind the PvP closeout. The hunter
  predictor also now filters Good targets only when their Abyss farm is still
  worth continuing, instead of blindly excluding every target with any farmable
  reward. In
  `ml/meta_runs/postfarm-pvp-pivot-20260630T1422Z/run_summary.json`, the same
  Fallen hunter against the old non-Fallen Good stack scored 20.50 VP, 43.8%
  reach30, 7.88 PvP VP/game, 7.88 HP4+ PvP VP/game, best legal target VP 12, and
  0.44 high-value windows/game. Against
  `ml/stacks/neural-field-good-nonfallen-pivot-targets.json`, the first version
  scored 26.25 VP, 68.8% reach30, 14.63 PvP VP/game, 14.63 HP4+ PvP VP/game, best
  legal target VP 16, and 0.81 high-value windows/game. A traced direct-target
  probe then found the new gate abandoned reliable HP4 reward-2 farm too early
  around VP15. The hard-farm refinement is controlled by
  `ARC_GOOD_TARGET_HARD_FARM_PIVOT_VP`; a cutoff sweep selected the tighter
  default of 21 because it beat cutoff 18 and matched cutoff 24. It raises direct
  target VP from 10.06 to 11.69, kills from 3.50 to 4.31, and drops missed
  farmable navs from 71.4% to 0%, while the hunter result holds at 26.44 VP,
  75.0% reach30, 14.81 PvP VP/game, 14.81 HP4+ PvP VP/game, best legal target VP
  18, and 1.13 high-value windows/game. This
  directly confirms the intended strategic shape: farm efficient Abyss rewards
  first, then attack Good players once the monster is hard. The caveat is direct
  Good-target strength: 11.69 VP is still too low, so this is a
  target-landscape/pivot probe, not the final Good-builder policy.
- A follow-up non-Abyss Good-builder scoring probe clarified the next bottleneck.
  `direct_pivot_good_targets_cutoff21_trace4g.json` shows the target stalls after
  the HP4 farm cycle: strong seats alternate Arcane farm with Lantern restore,
  while weak seats sit at HP4/HP5 with attack below monster HP and repeated
  Lantern/Floral non-VP turns. The existing `good-builder-oracle` micro gate is
  not a fix; `direct_pivot_good_targets_microoracle_8g.json` collapsed to 4.88
  VP and only 1.63 kills/game. A hand-authored damage-rebuild root filter was
  added behind `ARC_GOOD_TARGET_DAMAGE_REBUILD_MIN_HP` and tested at `4`. It
  raises direct Good-target VP from 11.69 to 12.19 and kills from 4.31 to 4.56,
  but weakens the paired hunter arena from 26.44 VP / 14.81 HP4+ PvP VP / 1.13
  high-value windows to 24.94 VP / 13.69 HP4+ PvP VP / 0.31 high-value windows.
  Therefore it remains optional and disabled by default. The next improvement
  should be a learned/non-Abyss scoring lane, not this hand root filter.
- A first learned smoke for that lane,
  `ml/meta_runs/nonabyss-pivot-scoring-20260630Tuserpivot-smoke`, mined 803
  success/near-miss contrast samples from the pivot target field and warm-started
  a target policy from the current Good-builder checkpoint. It failed the direct
  target gate: VP fell from 10.25 to 8.75 and kills from 3.63 to 3.00 in the
  matched 8-game smoke, with lower Arcane navs and lower max attack. This rejects
  naive outcome-filtered imitation. The next collector needs counterfactual
  labels for damage assembly, safe non-Abyss VP, and when to re-enter Abyss, not
  just samples from games that happened to finish higher.
- The Good-target route should not be Pure-only. In the current rules,
  Pure/Tainted/Corrupt (`statusLevel < 3`) are still Good/non-Fallen PvP targets,
  so a target can spend limited corruption to finish efficient HP4 monster lives
  and remain attackable later. The diagnostic flag
  `ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1` lets
  `good-nonfallen-farm-target-pivot` treat status 0-1 controlled-corruption
  kills as valid farm when they preserve the `maxStatusLevel=2` contract. In
  `ml/meta_runs/postfarm-pvp-controlled-corrupt-20260630Tuserpivot/run_summary.json`,
  the direct 16-game/160-iteration target check improved from the accepted
  11.69 VP baseline to 17.19 VP, with 5.88 kills/game, 17.63 Abyss navs/game,
  and zero cap violations. The full-budget remote paired hunter check still
  showed the intended player-attack conversion (10.13 PvP VP/game, all of it in
  HP4+ windows, 0% missed PvP windows), but it regressed the accepted target
  landscape from 26.44 VP / 14.81 HP4+ PvP VP to 24.75 VP / 10.13 HP4+ PvP VP,
  with best legal target VP falling from 18 to 12. Therefore the flag is
  default-off. This reinforces the route contract but rejects promotion:
  controlled non-Fallen corruption improves direct target scoring, yet
  over-keeps Good targets in Abyss and weakens the later player-attack
  landscape. The no-flag smoke returned to the safer Pure lane
  (`default_gate_smoke_4g64.json`: status 0, 20.50 VP, 7.50 kills/game, 0%
  missed clean farm). A simple controlled-corruption VP cap is rejected:
  `ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP=12` matched the uncapped controlled
  smoke, so target exposure needs an explicit leave-Abyss/timing signal rather
  than a cap on when corruption can be spent. Direct hand exposure gates are not
  sufficient either: expose-after-12 reintroduced 76.3% missed clean farm and
  only 12.00 direct VP, while expose-after-15 improved the paired smoke target
  quality to best target 15 / 11.25 HP4+ PvP VP/game but still trailed the
  accepted 14.81 HP4+ PvP baseline. The next implementation should collect
  counterfactual labels for leave-Abyss timing and non-Abyss scoring, not hardcode
  an exposure threshold.
- A reusable target-pivot sweep harness now lives at
  `scripts/run-arc-good-target-pivot-sweep.sh`. It runs direct Good-target and/or
  paired hunter evaluations for default, controlled-corruption, cap, and exposure
  variants, then writes `sweep_summary.json`. The first compact hunter sweep
  (`ml/meta_runs/good-target-pivot-hunter-sweep-20260630Tgoal`) produced a
  tempting 8-game high roll for default/expose gates (28.00 VP / 18.38 HP4+ PvP
  VP), but the accepted-budget confirmation
  (`ml/meta_runs/good-target-pivot-default-confirm-20260701Tgoal`) regressed to
  25.81 VP / 13.31 HP4+ PvP VP, below the accepted 26.44 / 14.81 baseline. This
  closes the simple-gate sweep: no current hard gate beats the accepted pivot
  field. The harness promotion check now also requires nonzero
  `planner_pvp_good_target_pivot_vp_per_game` and a Good-target best target of at
  least 18 VP, so future wins must prove the actual monster-to-Good-player pivot.
  Future progress should come from learned target-exposure labels.
- The stricter July 1, 2026 rerun
  `ml/meta_runs/good-target-pivot-goodmetric-default-16g-20260701Tgoal` showed
  the default target field does produce the intended Good-player pivot, but only
  `2.25` Good-pivot VP/game over `0.75` attacks/game; field-best opponent VP was
  still only `10.31`. A follow-up safe exposure miner,
  `scripts/run-arc-target-exposure-traceq.sh`, proved that naive
  Arcane-to-non-Abyss exposure labels are currently sacrificial:
  `ml/meta_runs/target-exposure-traceq-safe-16g-20260701Tgoal` found 24
  Arcane-source windows and 0 safe corrections after rejecting labels that lose
  more than 1 VP. The next target-field improvement should train or search for
  better own-score Good builders, not force targets to expose themselves for the
  hunter.
- The first compact own-score retraining attempt,
  `ml/meta_runs/good-target-ownscore-pivot-lane-20260701Tgoal`, is useful but
  rejected. It mined only 197 near-miss samples and produced a policy that made
  the hunter's target landscape richer (`planner_pvp_good_target_pivot_vp_per_game`
  1.88 -> 9.38, best Good target 14 -> 21 in the compact paired eval), but it
  harmed the Good targets themselves (direct target VP 10.25 -> 6.38). This means
  the route signal exists, but the training objective is underspecified: the next
  Good-field run needs more samples plus own-VP preservation / low-tail recovery,
  not pure contrast imitation.
- The low-tail preservation follow-up,
  `ml/meta_runs/good-target-ownscore-preserve-smoke-20260701Tgoal`, added 89
  value-only low-tail samples. The compact paired run high-rolled to 27.50 hunter
  VP with 14.00 strict Good-pivot VP/game and best Good target 18, but direct
  Good-target VP still fell to 6.50. The accepted-budget confirmation
  `ml/meta_runs/good-target-preserve-trainedfield-confirm-16g-20260701Tgoal`
  rejected it at 20.19 hunter VP. The lesson is precise: preserving value labels
  does not fix the Good-builder policy loop by itself; the next lane must change
  location/action policy quality for the targets.
- A hard hunter-side value gate,
  `pvp-good-target-value-pivot`, was added only as an opt-in diagnostic for the
  intended strategy: farm cheap/mid Abyss lives, then attack high-value Good
  players when monster EV is worse. The 16-game remote eval
  `ml/meta_runs/good-target-value-pivot-16g-20260701Tgoal` rejected it: hunter VP
  17.38, HP4+ PvP VP/game 3.75, strict Good-pivot VP/game 1.88, best Good target
  20. The gate proves the code can represent the reminder, but it hunts too
  sparsely and gives up route value. The default remains
  `pvp-predictive-mode-hunt-fallback-pivot` until a learned/league gate beats the
  26.44 VP / 14.81 HP4+ PvP baseline.
- `goodTargetActionDiscipline` is the first successful direct Good-builder
  action fix. It is an opt-in filter that suppresses the observed
  Lantern/Cursed/Floral maintenance loop without deleting scoring, combat, reward,
  summon, or real survival-improvement actions. In
  `ml/meta_runs/good-target-action-discipline-16g-20260701Tgoal`, direct target
  VP jumped to 21.94 with 8.00 kills/game and essentially no Cursed-row churn.
  The paired hunter result was not promotable: 26.75 VP is slightly above the
  26.44 accepted hunter VP, but HP4+ PvP fell to 12.19, best Good target fell to
  12, and high-value windows fell to 0.75/game. This becomes the new
  Good-builder own-score foundation, but not the solved unrestricted meta. The
  next architecture step is to combine disciplined high-scoring Good targets with
  exposure/anti-overcontest/league pressure so those targets become attackable at
  VP18+ instead of mostly scoring in isolation.
- A quick disciplined exposure sweep
  `ml/meta_runs/good-target-discipline-exposure-local-smoke` rejected plain
  `ARC_GOOD_TARGET_EXPOSE_AFTER_VP=18/21`. It did not improve hunter target
  quality over disciplined default; hunter VP stayed 20 and best Good target
  stayed 12 in the local smoke, while expose18 damaged direct farming. The next
  exposure mechanism should be opponent-aware or learned from counterfactual
  target/hunter interaction, not a static VP cutoff.
- A high-value encounter-force diagnostic,
  `pvp-high-value-encounter-force`, was added to test whether the hunter should
  pass on low-score Good targets and wait for richer PvP. Local smoke rejected
  that framing. With an 18-VP floor
  (`ml/meta_runs/high-value-encounter-local-smoke`), the hunter made 0 attacks
  and scored 12.00 VP because the best visible Good target was only 12 VP. With a
  12-VP floor (`ml/meta_runs/high-value12-encounter-local-smoke`), it still fell
  to 16.50 VP by skipping too many fixed-value attacks. The same setup with the
  existing `pvp-pivot-encounter-force` control
  (`ml/meta_runs/encounter-force-control-local-smoke`) scored 22.50 VP, 10.50
  PvP VP/game, and 0% missed legal PvP. This changes the interpretation:
  "valuable Good target" should mean "a legal non-Fallen player attack after
  Abyss EV/survivability worsens," while opponent VP remains a dashboard metric
  for target-field quality rather than a hard pass/attack cutoff.
- The next low-tail experiment added
  `pvp-predictive-mode-hunt-fallback-rebuild-pivot`, an opt-in navigation gate
  for Fallen states where the route-mode stack wants to return to Abyss but the
  current monster farm is no longer executable. In those states it offers
  damage/survival rebuild roots instead of dead Abyss. The aggressive version
  proved the heuristic-field upside at 30.39 VP but failed shared-field
  validation, because trace instrumentation showed rebuild activating before the
  established round-10 PvP route boundary. Raising the default rebuild boundary
  to round 14 produced the first promoted 30+ VP stack. In
  `ml/meta_runs/champion-rebuild-pivot-round14-64g-20260701Tgoal`, it scored
  30.14 VP, 100% win, 93.8% reach30, 8.22 monster kills/game, and 6.33 PvP
  VP/game. In the matched shared neural-field guardrail
  `ml/meta_runs/champion-rebuild-pivot-round14-neuralfield-20260701Tgoal`, it
  beat the old shared baseline 17.75 VP vs 16.67, with 8.75 PvP VP/game and 5.50
  strict Good-pivot VP/game. The next trace pass found that rare sub-30
  heuristic games and many shared-field losses were HP4-wall failures, not
  missed PvP or missed farm windows. Raising the speculative hunt bypass from
  `ARC_PVP_REBUILD_SKIP_TARGET_VP=6` to `12` stopped low-value predicted
  Good-target chases from suppressing damage/survival rebuild while preserving
  visible PvP attacks. The promoted skip-12 stack scored 30.33 VP, 100% win, and
  96.9% reach30 in
  `ml/meta_runs/champion-round14-skip12-heuristic-20260701Tgoal`, and improved
  the exact shared guardrail to 17.92 VP in
  `ml/meta_runs/champion-round14-skip12-shared12-20260701Tgoal`. This is now the
  current unrestricted champion: base full policy + route-mode nav checkpoint +
  `pvp-predictive-mode-hunt-fallback-rebuild-pivot` +
  `pvp-pivot-encounter-force` + round-14 rebuild + skip-12 speculative hunt
  cutoff.
- A follow-up hand-authored tainted status 1-2 rebuild-root override was
  rejected. It tried to reuse Fallen rebuild destinations before full Fallen in
  HP4 wall states, based on traces where status 1-2 bots stayed in Floral after
  becoming nearly combat-ready. The exact shared guardrail collapsed to 9.83 VP
  and only 1.00 PvP VP/game in
  `ml/meta_runs/champion-tainted-rebuild-shared12-20260701Tgoal`, so this class
  of broad navigation-root patch should not be pursued. The remaining HP4 issue
  needs a learned/contrastive full-action fix or a very narrow ready-now Abyss
  correction that does not suppress shared-field PvP pressure.
- The all-seat route-execution correction lane is also rejected as a promotion
  source in its current form. The diagnostic
  `ml/meta_runs/routeexecq-shared-allseat-champion-20260701Tdiagnostic-v3`
  produced 128 shared-field windows but only 11 corrections, with source VP
  9.8, `avgBestVpDelta` 0.08, and `avgBestScoreDelta` 0.18. A warm-started
  checkpoint trained from that data in
  `ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain` did not beat
  the champion in any tested placement. As the current PvP-pivot micro overlay
  it scored 14.67 shared-12 VP, 8.3% reach30, and 4.25 PvP VP/game. As the base
  full policy with the proven PvP micro kept intact, it collapsed further to
  12.42 shared-12 VP and 4.00 PvP VP/game. As a broad location-interaction
  micro overlay, it recovered to 16.50 shared-12 VP but still trailed the
  17.92 shared guardrail and reduced PvP VP from 8.75 to 6.25. The useful signal
  was mostly "choose early Tidal Cove summon / Floral rest rows" in contested
  shared games, but the trained policy over-applies that row preference and
  weakens the late Good-player attack conversion. Future route-exec collectors
  need stronger positive deltas, contrastive "do not over-rest" negatives, and
  an explicit preservation gate for the Abyss-to-PvP pivot before they should
  be retrained.
- A role-specific status-2 descend hunter is now an important league candidate,
  but not a universal champion. Trace analysis for
  `ml/meta_runs/champion-vs-goodbuilder-mixed-currentgate-20260701Tgoal`
  showed low-tail games stuck at the HP4+ wall with weak damage or status-2
  Floral Patch churn, while legal PvP windows were not missed. The experimental
  `status2-target-descend` PvP oracle only forces status-2 / HP4+ / low-kill-prob
  states toward Arcane Abyss when plausible Good targets exist. Against the
  Good-builder mixed field it improved the current champion from 21.94 VP,
  56.3% reach30, and 15.56 PvP VP/game to 24.38 VP, 62.5% reach30, and 18.00
  PvP VP/game in
  `ml/meta_runs/champion-status2-descend-currentgate-20260701Tgoal/goodbuilder16.json`.
  However, applying the same behavior to every seat in a shared mirror collapsed
  the 8-game shared smoke from 17.38 VP / 9.75 PvP VP to 9.50 VP / 1.88 PvP VP.
  Treat this as a counter-strategy/role in the league, not as the default bot.
  The eval harness now supports per-seat `pvpPivotOracle` in stack manifests,
  and the reproducible role mixes live in
  `ml/stacks/league-goodbuilder-status2-hunter.json` and
  `ml/stacks/league-current-goodbuilder-status2-hunter.json`. In the fuller
  current+status2+Good-builder stack, both current and status-2 planner variants
  remained unsolved: 17.08 VP and 17.67 VP respectively over 12 games, while
  status-2 hunter opponents won 6/12. The dashboard should surface this as a
  real counter family and league pressure, not a solved meta.
- The next PvP pressure lane should prefer `status2-conversion-descend` over
  `status2-target-descend` when testing the owner's actual scoring contract.
  `status2-target-descend` asks "is there already a high-VP Good target worth
  hunting?" The conversion oracle asks the more important question: "has the
  monster rung become weak EV, and is any Good/non-Fallen player available to
  convert into +3 PvP VP?" The new default for HP4/resilient Good-builder scripts
  is therefore `status2-conversion-descend`; high-value target metrics remain
  dashboard diagnostics, not the primary promotion gate.
  The one-game local smoke
  `ml/meta_runs/status2-conversion-smoke-20260701Tlocal/azeval.json` reached
  30 VP with 1 HP4+ PvP attack against a 5-VP Good target while strict
  Good-pivot VP stayed 0, confirming that conversion and high-value pressure
  must be graphed separately.
  The remote bounded suite
  `ml/meta_runs/status2-conversion-meta-20260701Tlocalremote/summary.json`
  strengthened that conclusion: heuristic-field arena was excellent
  (30.25 VP, 100% reach30, 7.13 PvP VP/game, 6.19 HP4+ PvP VP/game), and
  forced-Abyss underperformed at 24.50 VP / 0 PvP. Shared meta still collapsed
  to 11.31 deterministic VP and 7.42 sampled VP, so conversion-descend is a
  necessary pressure role but not a shared-policy solution.
  A new role-portfolio gate, `npm run bot:role-portfolio`, now evaluates the
  heterogeneous stack directly instead of only one planner role. The first remote
  run,
  `ml/meta_runs/role-portfolio-conversion-stack-20260701Tremote/summary.json`,
  rejected the current conversion stack with `solvedPortfolio=false`: conversion
  was the best planner role but only reached 20.75 VP / 25% reach30, target and
  Pure planner roles were 7.88 VP, exploit gap was 12.87 VP, and
  `allseat-goodbuilder-trained` was still an exposed food role at 6.85 VP and
  8.86 conceded PvP share per seat. This makes the next architecture target
  explicit: create Good/Pure roles that independently score into the 15-25+ VP
  band and do not feed hunter PvP.
- Target-pressure accounting was added to the self-play/eval contract so the
  dashboard can distinguish "hunter failed to find Good players" from "Good
  players were farmed but still won or survived." `roleStats` now includes
  `pvp_target_combats_per_seat`, `pvp_aggressors_faced_per_seat`, and
  `pvp_vp_conceded_share_per_seat`; planner summaries also include matching
  per-game fields. These are instrumentation-only metrics and do not change
  gameplay. They complete the measurable route contract the user called out:
  early multi-life Abyss farm, then Good/non-Fallen player attacks once monster
  farm is inefficient.
- `ml/stacks/league-current-disciplined-goodbuilder-status2-hunter.json` is the
  first reproducible role stack using those target-pressure metrics. It keeps
  current and status-2 hunter roles, but adds `goodTargetActionDiscipline` to
  both Good-builder seats. The 24-game confirmation showed that the status-2
  hunter is a useful counter-role in this stronger target-pressure lane:
  `status2_planner_vs_stack24_target_pressure_oraclefix.json` reached 21.46 VP,
  41.7% win, and 12.38 PvP VP/game, beating `current_planner_vs_stack24_target_pressure.json`
  at 19.71 VP, 33.3% win, and 10.63 PvP VP/game. However, the target-pressure
  stats also prove the meta is not solved: `allseat-disciplined-goodbuilder-trained`
  averaged 7.13 VP while conceding 19.38 PvP VP share per seat in the corrected
  status-2 run, and `pure-damage-disciplined-goodbuilder` averaged 8.25 VP while
  conceding 6.54. The eval harness was corrected so that, in neural-field mode,
  global `AZEVAL_PVP_PIVOT_ORACLE` applies only to the planner seat while stack
  seats use only their manifest `pvpPivotOracle`; trust the `*_oraclefix.json`
  runs or rerun older status-2 comparisons.
- `ml/stacks/league-current-disciplined-nonfallen-goodbuilder-status2-hunter.json`
  is the follow-up non-Fallen target-quality probe. It lets Good-builder seats
  use `good-nonfallen-farm-target-pivot`, status cap 2, and
  `goodTargetActionDiscipline`. The corrected 24-game status-2 run
  `status2_planner_vs_stack24_target_pressure_oraclefix.json` reached 20.00 VP
  and 10.88 PvP VP/game, so it is not the stronger champion lane. It did,
  however, improve the attack-landscape metrics to 50.42 target VP/game, best
  target 16, 1.00 high-value window/game, and 3.00 strict Good-pivot PvP VP/game.
  The Good seats still failed as competitors (`nonfallen-disciplined-goodbuilder-trained`
  7.83 VP, `nonfallen-disciplined-farmer-target` 5.63 VP), which means this is a
  data/dashboard lane for resilient Good-builder training rather than a solved
  meta result.
- A dedicated resilient-target training harness now exists as
  `scripts/run-arc-resilient-goodbuilder-lane.sh` / `npm run
  bot:resilient-goodbuilder`. It adds `AZEVAL_ROUTE_SAMPLE_ROLE_REGEX` support
  to mine only Good-builder/target-role decisions from mixed hunter leagues,
  trains a candidate, and evaluates both own-score and target-pressure outcomes.
  The first compact local run
  `ml/meta_runs/resilient-goodbuilder-compact-20260701Tlocal/summary.json`
  rejected the straightforward imitation approach. The candidate improved the
  direct target field only slightly (8.25 VP) and made hunters dramatically
  stronger against it: 30.50 hunter VP, 25.50 PvP VP/game, 5.75 high-value
  windows/game, and 17.25 strict Good-pivot PvP VP/game. The candidate conceded
  8.50 PvP VP share per seat under direct hunter pressure and 9.50 in the mixed
  stack. This confirms that the next Good-builder architecture needs an explicit
  anti-farming / survivability objective in the collector or loss, not just
  target-role success/near-miss imitation.
- That collector objective is now explicit in the route-sample contract. The
  mining harness can cap accepted target samples by conceded PvP VP share with
  `AZEVAL_ROUTE_SAMPLE_MAX_CONCEDED_SHARE`, subtract a pressure penalty from the
  value target with `AZEVAL_ROUTE_SAMPLE_PRESSURE_PENALTY` and
  `AZEVAL_ROUTE_SAMPLE_PRESSURE_SCALE`, and redirect pressure-failed target rows
  to value-only low-tail data with
  `AZEVAL_ROUTE_SAMPLE_PRESSURE_FAIL_LOW_TAIL=1`. `npm run
  bot:resilient-goodbuilder` enables this by default (`max_conceded_share=8`,
  `pressure_penalty=0.75`), so Good/non-Fallen policies are trained to score
  while surviving hunter pressure instead of becoming easy +3 VP targets.
  The first SimForge GPU run with this pressure-aware collector,
  `ml/meta_runs/resilient-goodbuilder-pressure-gpu6-20260701Tfull/summary.json`,
  proved the target signal moved in the right direction but not far enough:
  direct hunter-vs-target concession fell to 3.33 PvP VP share per candidate
  seat, but the mixed candidate league still conceded 12.69 and the candidate
  own-score remained only 7.58 VP.
- A target-side anti-prediction gate,
  `good-nonfallen-farm-target-evade`, now exists for controlled experiments. It
  preserves early Abyss farming, then in non-farm build states reorders the
  Good target's likely destinations under Evil-player pressure so hunters cannot
  simply follow the first predicted repair/damage location. The gate is useful
  but insufficient: `ml/meta_runs/resilient-goodbuilder-evade-gpu7-20260701Tfull/summary.json`
  improved mixed conceded share from 12.69 to 11.53, while own-score stayed 7.58
  VP and the mixed-farming gate still failed. Treat it as evidence that target
  evasion matters, not as a champion policy.
- The evasive-teacher stack
  `ml/stacks/league-current-disciplined-nonfallen-goodbuilder-evade-status2-hunter.json`
  uses the same hunter roles but gives both non-Fallen target teachers the
  evasive navigation gate. It reduced local source-stack hunter pressure
  (`ml/meta_runs/evade-source-stack-ab-20260701Tlocal/summary.json`), but the
  full clean mining pass from only `goodbuilder` roles
  (`ml/meta_runs/resilient-goodbuilder-evade-source-gpu7-20260701Tfull/summary.json`)
  produced a weaker learned candidate: 7.58 own VP, 22.42 direct hunter VP
  against it, and 11.08 mixed conceded share. The untrained source Good-builder
  policy with the evasive gate scored 8.50 VP but still conceded 12.61 in mixed
  play. This means the problem is not merely polluted target data. The Good bot
  needs score-conversion policy correction after the early farm, while preserving
  anti-prediction under hunter pressure.
- The HP4-pick conversion TraceQ pass sharpened the target-builder contract. A
  strict-Pure source run,
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-smoke-20260701Tgoal`, found
  23 HP4/HP5 windows and 0 usable corrections because the best branches gained
  status. The matched non-Fallen run,
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-nonfallen-smoke-20260701Tgoal`,
  accepted all 23 corrections, exported 652 samples, and averaged +5.83 VP per
  correction while preserving the status-2 cap. The follow-up tiny train
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-train-smoke-20260701Tgoal`
  is not promotable: target-only scored 8.25 VP and 3.00 kills/game, and
  hunter-vs-target scored 23.25 VP with 15.75 PvP VP/game but only 1.50 strict
  Good-pivot VP/game. This is strong route evidence, not a champion. The next
  Good-target model should use these labels as a narrow HP4 conversion auxiliary
  or overlay while preserving the live HP4-pick behavior and anti-pressure
  metrics; do not replace the whole policy with this tiny trace shard.
- That narrow overlay was tested and rejected as a direct promotion path.
  `good-builder-hp4-conversion-overlay` is now a named micro gate: it keeps the
  base Good-builder policy, loads the TraceQ checkpoint only as a micro policy,
  filters to HP4 conversion actions, and accepts the overlay action only when
  the route-breakpoint score is at least the base action's score. The compact
  run `ml/meta_runs/traceq-hp4-conversion-overlay-smoke-20260701Tgoal` improved
  target-only over whole-policy TraceQ (9.75 VP, 3.25 kills, max status 1) and
  preserved hunter-vs-target pivot pressure (24.00 hunter VP, 16.50 PvP VP,
  5.25 strict Good-pivot VP), but it did not beat the live HP4-pick target
  baseline and collapsed in the mixed league (14.50 hunter VP, 0 strict
  Good-pivot VP, best target 9). Keep the gate as an experiment harness. The
  architectural next step is a larger, pressure-aware non-Fallen HP4 conversion
  dataset or a separate auxiliary head, not another whole-policy or tiny-shard
  overlay.
- Scaling that dataset did not rescue plain imitation. The wide collector
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-wide-20260701Tgoal` found
  abundant signal: 90 windows, 89 corrections, 2,795 samples, average +5.24 VP,
  and hundreds of combat/reward conversion examples. The trained wide overlay
  `ml/meta_runs/traceq-goodtarget-hp4pick-conversion-wide-eval-20260701Tgoal`
  still regressed the Good field to 7.88 VP and 2.63 kills/game, while mixed
  hunter pressure stayed at only 14.88 VP and 0 strict Good-pivot VP. This
  changes the architecture recommendation: the HP4 conversion signal should not
  be distilled as a replacement candidate policy, even through a conservative
  micro overlay. It should become a value/Q auxiliary, advantage gate, or
  multi-objective learner that can say "take this HP4 conversion action now"
  without overwriting the Good-builder's broader own-score and anti-pressure
  behavior.
- A first preservation mix did not fix that failure mode.
  `ml/meta_runs/goodbuilder-preserve-traceq-mix-20260701Tgoal` mixed 5,289
  Good-builder contrast samples with 2,795 wide TraceQ samples whose policy loss
  was down-weighted to 0.35. Direct use of the checkpoint regressed to 6.75
  target VP and 12.75 mixed hunter VP. Conservative overlay use kept some
  hunter-vs-target pressure (best Good target 17 and 5.25 strict Good-pivot
  VP/game), but target-only stayed at 7.88 VP and mixed league remained weak at
  15.63 hunter VP with 0 strict Good-pivot VP. The practical implication is that
  "preserve with more imitation data" is still the wrong abstraction. The
  conversion signal needs to be consulted as an online advantage/critic at the
  HP4 decision, or trained into a separate head with a hard gate, while the
  broad Good-builder action policy remains anchored.
- The first direct online/branch-time version of that idea also failed as a
  promotion candidate. `good-builder-hp4-conversion-oracle` keeps the broad
  Good-builder policy anchored and invokes the route-breakpoint oracle only over
  HP4 conversion actions when the oracle action scores at least as well as the
  base action. In `ml/meta_runs/hp4-conversion-oracle-smoke-20260701Tgoal`, the
  target field stayed weak at 7.88 VP / 2.63 kills. Direct hunter-vs-target did
  show the intended monster-to-player pivot (13.13 PvP VP/game, 5.63 strict
  Good-pivot VP/game, best Good target 17, no missed Good-pivot windows), but the
  mixed league lost the Good-target signal entirely: 15.75 hunter VP, 7.13 PvP
  VP/game, 0 strict Good-pivot VP, and best Good target 0 while field-best VP came
  from hunter roles. The architecture lesson is sharper now: the top-level route
  should farm efficient multi-life monsters, then attack valuable Good/non-Fallen
  players once the current monster rung is inefficient, but our next build lane
  must make those Good/non-Fallen targets genuinely score under pressure rather
  than merely exposing weak 7-10 VP targets.
  The next architecture step is not another hard hunter target floor. It is a
  Good/non-Fallen league lane that can score while under hunter pressure, so
  attackable Good strategies become real competitors instead of passive VP
  sources.
- A carry/support A/B tested that conclusion by removing support-seat Abyss
  contest instead of adding more hunter aggression. The new
  `good-builder-noncontest-support-oracle` gate, carry/support stacks, and
  `scripts/run-arc-good-target-carry-support-ab.sh` were run as
  `ml/meta_runs/good-target-carry-support-ab-20260701Tgoal` on GPU 4. Both
  variants improved the shape of the direct hunter probe without producing a
  promotable league. Single carry/support scored 11.63 target-field VP and let
  the hunter reach 27.38 VP, but only 4.88 strict Good-pivot VP direct and 2.25
  in the mixed league. Dual carry/support improved direct HP4+ PvP to 13.88 and
  strict Good-pivot VP to 6.00, but mixed league still had 0 strict Good-pivot VP
  and no valuable Good target. This keeps the route contract explicit: the best
  unrestricted bot should farm cheap multi-life Abyss rungs, then pivot to
  attacking valuable Good/non-Fallen players when the monster rung is no longer
  the best clean VP source. The missing piece is not remembering to attack; it is
  training Good-player strategies that score, survive, and become legitimate
  leaders under shared hunter pressure.
- The first concrete fix from that diagnosis was not another model checkpoint; it
  was aligning route-preservation constraints with the non-Fallen contract.
  `preserveRouteSurvival`, route hand-draw preservation, and Abyss route
  discipline now treat status 0/1/2 as Good and stop only at Fallen/Evil status
  3. The bug mattered because Good-target lanes intentionally allow controlled
  corruption to status 1/2, but the old strict-Pure guard stopped protecting
  Spirit Animal/Cultivator/barrier once a target left status 0. The regression
  test lives in `src/lib/play/ml/strictConstraints.test.ts`. GPU verification
  `ml/meta_runs/good-target-dual-nonfallen-preserve-20260701Tgoal` improved the
  dual mixed lane from 14.88 to 18.38 hunter VP, HP4+ PvP from 5.25 to 9.75, and
  restored nonzero strict Good-pivot VP (1.13, best Good target 16). It is still
  not a promotion candidate because Good carries remain weak under mixed
  pressure (6.25 and 8.38 VP, with heavy PvP conceded share). The next lane
  should use this fixed constraint boundary while training HP4/HP5 conversion and
  non-Abyss scoring; do not reintroduce strict-Pure-only preservation for
  non-Fallen Good strategies.
- The bounded repeatable HP4 conversion lane,
  `scripts/run-arc-nonfallen-hp4-conversion-lane.sh`, now confirms the same
  architectural split. Run
  `ml/meta_runs/nonfallen-hp4-conversion-bounded-gpu7-20260701Tgoal` found a
  strong fixed-state correction signal (24/24 TraceQ corrections, 836 samples,
  +8.54 VP per correction), but the learned conservative overlay did not create
  a strong Good-player economy from normal starts (9.00 target-field VP,
  field-best 10.50). The hunter side did exactly what the champion contract
  requires against exposed targets: direct hunter-vs-target reached 30.25 VP,
  22.50 PvP VP/game, and 9.75 strict Good-pivot VP/game. In the mixed league it
  still fell to 20.00 VP with only 2.25 strict Good-pivot VP and best Good target
  16. Read: the system remembers to attack Good/non-Fallen players once monster
  EV drops; the unsolved architecture problem is producing legal Good targets
  that score into the 18-25 VP band while surviving shared hunter pressure. More
  imitation of fixed HP4 labels is not enough without pressure-aware target
  scoring, non-Abyss VP lines, and a conversion critic/advantage gate that
  preserves own-score.
- A quick deterministic-scoring follow-up closed off another tempting route. The
  existing Good-builder oracle already values World Ender, World Guardian,
  Healer, Spirit Animal, Cultivator, and non-Cursed picks, so two constrained
  micro gates were added: `good-builder-score-pick-oracle` for pick/build
  actions only, and `good-builder-score-conversion-oracle` for the same actions
  plus `startCombat` / `resolveMonsterReward`. Local smokes
  `ml/meta_runs/score-pick-oracle-local-smoke-20260701Tgoal` and
  `ml/meta_runs/score-conversion-oracle-local-smoke-20260701Tgoal` rejected both.
  Pick-only stayed at 9.00 target-field VP and missed 52% of clean combat
  opportunities; score-conversion fixed missed clean combat but dropped
  target-field VP to 7.50. Both produced 0 strict Good-pivot VP against the
  hunter because field-best targets stayed under 10 VP. Architecture lesson:
  hand-scoring passive VP classes is not enough when the normal-start target
  distribution rarely reaches the 18-25 VP band. The next builder lane should
  create or mine high-value Good target states and train a value/advantage
  critic over pressure survival and own-score, rather than adding another
  deterministic scorer gate.

Next experiments should focus on:

1. Building a narrower Pure/early-Fallen low-tail full-action discipline patch
   for the new 30.33 VP leader. The rejected broad and restore-only gates prove that hand
   navigation roots are too blunt; the next version must use counterfactual
   full-action labels, protect Spirit Animal/firepower, avoid indefinite Floral
   Patch rest loops, and require a concrete path to an immediate clean kill or a
   controlled corruption-to-Fallen pivot.
2. Treating shared neural-field / league evaluation as a separate required gate.
   The 30.33 VP champion is very strong against the retained heuristic field, but
   a shared-stack neural-field arena is much harsher: the best 12-game shared
   probe reached only 16.67 VP because all strong seats contest the same Abyss
   and Floral/PvP routes. This is the right arena for "attack good players" and
   should become a dashboard lane, not a replacement for the heuristic regression
   gate. Do not use Good-capped mirrors or naive current-Pure self-play as the
   target field; they are too weak. The route contract for unrestricted bots is
   now explicitly "efficient monster farm first, then attack legal non-Fallen
   Good players when monster EV or clean survivability falls behind the PvP
   closeout." Opponent VP is still important for dashboard target quality, but
   fixed-VP attacks should not be skipped just because the visible Good target is
   not yet a runaway scorer. The current Good-builder/non-Fallen lanes are
   target-landscape probes, not final best-bot lanes: they intentionally cap
   status or forbid `initiatePvp`. A champion run must remove those restrictions
   and pass the `farm_to_pvp_contract` emitted by `npm run bot:meta:evaluate`.
   The meta suite now wires the promoted PvP stack knobs (`PATCH_NAV_*`,
   `PATCH2_NAV_*`, `MICRO_*`, and `PVP_PIVOT_ORACLE`) through both the all-seat
   meta probes and the arena eval, so use it for real champion checks rather
   than evaluating the base policy alone.
   The first full contract run,
   `ml/meta_runs/champion-farm-pvp-contract-20260701T0007Z`, rejected the current
   champion as solved despite a strong retained-field result. Arena passed
   (30.32 VP, 98% reach30, 6.22 PvP VP/game, 0% missed legal PvP), but all-seat
   shared meta failed (11.03 deterministic VP, 8.39 sampled VP, both 3.1%
   reach30). The evaluator now separates `arena_contract` from
   `shared_meta_contract`; promotion requires both. The next architecture lane is
   shared-field robustness and strong target generation, not another
   heuristic-field-only PvP threshold sweep.
   The immediate shared-field follow-up,
   `ml/meta_runs/champion-shared-field-contract-20260701T0740Z`, shows the
   current hunter does use PvP correctly against strong targets (12.38 PvP
   VP/game, 0% missed PvP, field-best 20.56), but still under-converts the route
   (22.19 VP, 25% reach30, 3.44 kills/game, 10.6% missed clean combat). A
   hand-authored farm-first hunt gate was tested and removed because fair A/B
   showed it was a no-op. The next improvement should mine trace/counterfactual
   labels from shared-field states where the bot has legal clean combat or a
   monster/PvP sequencing choice, rather than adding another broad navigation
   override.
   The role-aware trace pass
   `ml/meta_runs/shared-field-trace-role-smoke-20260701T084050Z` adds a sharper
   split: hunters already attack every legal PvP window in the traced shared
   field, while Good-builder target roles remain 7.5-9 VP HP4-wall victims.
   Shared-field progress must therefore improve target-builder score/resilience
   and HP4 conversion under contest, not merely force more `initiatePvp`.
3. Designing a better late gate or explicit rule for VP28-29 HP4 states; the
   current `route-finish-loop` gate is too narrow, while broad `route-closer`
   destroys farm density.
4. Adding restore-timing and Cultivator/max-barrier labels so the bot converts
   HP4 lives instead of stalling at 28-29.
5. Training the late-descend oracle into a learned policy/overlay with contrast
   labels, not positive-only labels. The collector should pair VP18+ / HP4+ /
   low-farm-EV states where the right move is Arcane Abyss with similar states
   where the correct move is Lantern/Cultivate, Floral/restore, or damage
   assembly. Preserve the oracle's 0% missed-farm property without inflating
   Abyss navs/game.
6. Expanding the neural-field arena beyond same-stack mirrors: include
   current-contract stack manifests, historical checkpoints that still match the
   current observation contract, and non-Fallen high-scoring builders trained
   with shared-field anti-overcontest labels so the PvP target landscape
   resembles a league rather than four copies of one policy.
7. Build a Good-builder teacher for shared play before spending more GPU on Pure
   self-play. The next data generator needs labels for "leave Abyss because other
   players are already consuming the cheap lives", Spirit Animal/damage assembly
   outside the contested monster line, World Guardian / passive VP lines, safe
   non-Abyss scoring, and target-rich board states where a Fallen hunter can
   later attack high-VP Good players. Otherwise all-seat Pure training just
   learns the low-scoring contested Abyss equilibrium.
   The target-only evasive stack
   `ml/stacks/neural-field-good-nonfallen-evade-targets.json` confirms the split:
   `good-nonfallen-farm-target-evade` plus `goodTargetActionDiscipline` scored
   22.63 VP when directly controlled, but its shared target-field roles still
   averaged only 7.88 / 4.88 / 4.50 VP under hunter pressure. Direct Good-builder
   score is therefore necessary but not sufficient; promotion needs shared-field
   target-role VP and high-value Good windows at the same time.
   The no-hunter shared diagnostic
   `ml/meta_runs/target-only-evade-discipline-shared-20260701T085104Z` makes the
   same point without PvP pressure: the controlled target planner averaged 12.00
   VP and the all-seat trace averaged only 8.00 VP, with every traced seat hitting
   the HP4 wall. So the next lane should not be "make everyone peaceful"; it
   should train shared-play Good builders that can score into the 18-25 VP range
   while staying legal Good/non-Fallen targets, then train unrestricted hunters to
   pivot from Abyss into those players when monster EV falls behind attack EV.
   The July 1 target-field follow-up rules out four easy detours. Repeating the
   current trained Good builder in
   `ml/stacks/neural-field-good-nonfallen-evade-trained-heavy.json` stayed at
   9.75 controlled target VP / 7.88 all-seat trace VP. Turning on
   `ARC_GOOD_TARGET_DAMAGE_REBUILD_MIN_HP=4` moved navigation toward Tidal Cove
   and improved hunter exploitation, but still did not improve target-only VP.
   Adding the existing Good-builder oracle as micro in
   `ml/stacks/neural-field-good-nonfallen-evade-oracle-micro.json` regressed to
   6.75 controlled target VP / 3.75 all-seat trace VP. The new
   `good-builder-hp4-oracle` breakpoint micro in
   `ml/stacks/neural-field-good-nonfallen-evade-hp4-oracle.json` was even more
   decisive as a rejection: `target-hp4oracle-goodfield-smoke-20260701Tgoal`
   scored 0 controlled target VP and 0 kills with 22 Abyss navs/game, while a
   hunter against that field reached 27 VP mostly because the targets were weak,
   with best target VP only 6 and strict Good-pivot VP 0. The next builder work
   therefore needs a narrower learned damage-pick/HP4-conversion teacher, not
   the old Good-builder oracle, not the breakpoint oracle as a full micro policy,
   not target stack duplication, and not a navigation-only HP4 damage toggle.
   That narrower shape now exists as
   `good-builder-hp4-pick-oracle` /
   `ml/stacks/neural-field-good-nonfallen-evade-hp4-pick-oracle.json`. Its compact
   smoke `target-hp4pick-goodfield-smoke-20260701Tgoal` recovered target execution
   versus the full oracle (10.25 target-only VP, 4.00 kills/game, field-best 10),
   and the hunter found the intended PvP conversion against it (24.75 VP,
   16.50 PvP VP/game, best target 15, 3.75 strict Good-pivot VP). It still leaves
   every target role at the HP4 wall with 81.25% all-seat low-tail, so the next
   version should train this constrained signal into a policy with explicit HP4
   damage assembly and restore timing labels instead of widening it back into a
   full-action oracle.
   Two distillation ablations then rejected the simplest version of that plan.
   `hp4pick-distill-goodbuilder-smoke-20260701Tgoal` trained from 798 contrast
   rows plus 1,347 low-tail/pressure rows and regressed to 6.75 target VP, 0
   strict Good-pivot VP under direct hunter pressure, and 14.67 PvP VP conceded
   share in the mixed stack. `hp4pick-distill-contrastonly-smoke-20260701Tgoal`
   removed the low-tail rows and recovered to 8.25 target VP with 8.25 strict
   Good-pivot VP/game against the hunter, but still did not beat the 10.25 VP
	   live HP4-pick oracle. The next version should not be "same labels, longer
	   train." It needs a stronger HP4 conversion label source: explicit damage
	   assembly, current-barrier restore timing, and reward-claim continuation from
	   states that actually cross HP4/HP5 into 15-25 VP Good-player targets.
	   The `good-nonfallen-score-floor` follow-up made the intended route explicit:
	   farm cheap low-rung Abyss, treat Spirit Animal and dice as valid damage
	   floors, cultivate only at actual Cultivator breakpoints, and create
	   Good/non-Fallen targets that hunters can attack once monster EV falls behind
	   PvP EV. The bounded GPU-4 portfolio
	   `ml/meta_runs/scorefloor-role-portfolio-20260701Tremote/summary.json`
	   rejected navigation-only gating: `farmToPvpConversionPresent=true`, but
	   `solvedPortfolio=false`, best planner `conversion` only 13.75 VP, and every
		   field role below the 15 VP floor. This separates the problems: the bot is
		   remembering to attack Good players for points, but Good/Pure target builders
		   still fail to convert 3-5 attack plus early multi-life monster rewards into
		   18-25 VP boards. The next implementation should generate action-level
		   teachers for HP4/HP5 kill continuation, barrier/cultivator timing, and
		   monster-reward VP picks instead of adding another navigation-only lane.
		   The narrower `good-builder-hp4-scorefloor-oracle` follow-up confirmed that
		   boundary. In a controlled trace it produced an 18 VP / 6-kill Good-target
		   route with 7 attack and 4 barrier, so the local route exists. In the mixed
		   GPU portfolio
		   `ml/meta_runs/hp4-scorefloor-role-portfolio-20260701Tremote/summary.json`,
		   though, it still failed the league gate: `solvedPortfolio=false`, best
		   planner `conversion` 13.38 VP, target role 9.88 VP, all-seat Good-builder
		   8.91 VP, and pure farmer 6.46 VP. The next architecture step should be a
		   pressure-aware Good/non-Fallen target-builder lane that learns when to keep
		   farming multi-life Abyss rewards, when to stop exposing itself as a target,
		   and when its own board is strong enough to become valuable prey for the
		   hunter pivot. Stronger local HP4 scoring alone is not enough.
		   The score-floor carry/support A/B then tested whether the missing piece was
		   simply over-contest: one or two score-floor Good carries used
		   `good-nonfallen-score-floor` plus `good-builder-hp4-scorefloor-oracle`,
		   while support seats stayed out of Abyss. The GPU run
		   `ml/meta_runs/scorefloor-carry-support-ab-20260701Tremote/summary.json`
		   improved the single-carry direct probe (13.50 target-field VP; hunter
		   29.63 VP, 87.5% reach30, 15.75 PvP VP/game, best Good target 17), but it
		   still failed promotion because the mixed league fell to 19.88 hunter VP
		   and best Good target 15. Dual carry was worse (9.38 target-field VP and
		   12.75 mixed hunter VP). This closes off "add more score-floor carries" as
		   the next answer. The useful next lane is a learned pressure-state generator
		   for a single Good carry: preserve the 24-VP high-tail route, collect
		   low-tail contrast states where it collapses to 9-14 VP, and train an
		   advantage/critic gate that prefers actions leading to 18+ VP Good boards
		   without creating 0-VP support prey.
		   A tiny local recovery pass on
		   `ml/meta_runs/scorefloor-carry-targetplanner-probe-20260701Tcont` showed
		   what not to do next: mining with an 18 VP success threshold produced 159
		   near samples and 724 low-tail samples but zero true successes, and the
		   resulting 4-epoch checkpoint scored only 10.50 VP in target-field smoke.
		   The next collector therefore needs to deliberately preserve and sample the
		   rare 18-24 VP Good-carry prefixes before training; near/low-tail recovery
		   alone just pulls the policy toward the current 9-15 VP plateau.
		   The follow-up success-prefix lane did find those prefixes. In
		   `ml/meta_runs/scorefloor-carry-successlane-20260701Tremote/summary.json`,
		   the collector mined 1,388 success samples, 788 near samples, and 2,350
		   low-tail samples, then trained a candidate that improved own target-field
		   score to 16.25 VP with 5.75 kills/seat and no status-cap violations. That
		   moves the bottleneck: the system can now learn from true 18+ Good-carry
		   prefixes, but it still cannot stabilize the full landscape. Direct hunter
		   pressure kept the farm-to-player pivot visible (29.63 hunter VP,
		   16.13 PvP VP/game, best Good target 18), while strict Good-pivot volume
		   was only 0.38 VP/game and the mixed candidate stack fell to 16.75 hunter
		   VP with best Good target 12. The next architecture step is therefore not
		   more monster-only optimization. It is mixed-league target stabilization:
		   remove or replace 0-VP support prey, mine from actual mixed pressure
		   states, and promote only when hunters repeatedly convert from high-EV
		   Abyss farming into valuable Good-player attacks once monster EV drops.
		   A no-support isolation probe confirmed that removing passive support is
		   not enough by itself. The stack
		   `ml/stacks/league-current-scorefloor-trained-carry-no-support-hunter.json`
		   swapped support seats for the trained resilient builder plus the source
		   score-floor carry, but
		   `ml/meta_runs/scorefloor-trained-nosupport-portfolio-20260701Tremote/summary.json`
		   still rejected the portfolio: best role `conversion` reached only
		   16.88 VP with 1.88 strict Good-pivot VP/game and best Good target 14,
			   while the trained target planner fell to 9.00 VP. This means the support
			   seats are noise, but not the root cause. The root cause remains mixed
			   pressure: Good/non-Fallen builders need policy targets that keep them
			   scoring through shared Abyss competition and hunter presence, not just
			   isolated target-field success prefixes.
			   The next mixed-pressure recovery lane confirmed that distinction. In
			   `ml/meta_runs/mixed-pressure-goodbuilder-recovery-20260701Tremote/summary.json`,
			   mining at a lower 13 VP recovery threshold found 1,143 success samples,
			   621 near samples, and 4,983 low-tail samples, but the trained target
			   still scored only 9.88 VP in its own field. Direct hunter pressure did
			   show the desired phase change from low-rung Abyss farming into Good-player
			   attacks (26.13 hunter VP, 18.75 PvP VP/game, 4.13 strict Good-pivot
			   VP/game), but the mixed candidate stack erased it: 13.75 hunter VP, 0
			   reach30, 0 strict Good-pivot VP, best PvP target 10, and no best Good
			   target. Architecture implication: the bot contract and dashboard should
			   treat "attack valuable Good/non-Fallen players after monster EV drops" as
			   a first-class route metric, not as generic PvP. Future training should
			   either mine true 18+ mixed-pressure Good-builder prefixes or add
			   counterfactual HP4 plateau labels for dice acquisition, restoration, and
			   safe Abyss re-entry before expecting the hunter pivot to appear in league.
			   The HP4-label follow-up refined this again. In
			   `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-wide-20260701Tremote/summary.json`,
			   TraceQ did find a real local correction set: 68 HP4 windows, 50
			   corrections, 886 samples, and +1.90 VP average correction delta, mostly
			   restore/re-entry scripts. But every direct fine-tune failed as a target
			   policy. The broad overlay scored 6.00 target-field VP, the
			   cash/restore/re-entry filtered overlay
			   (`ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-20260701Tremote/summary.json`)
			   also scored 6.00 target-field VP, and the stricter gated overlay
			   (`ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-gated-20260701Tremote/summary.json`)
			   stayed at 6.00 target-field VP with only 0.38 mixed strict Good-pivot
			   VP/game. A composition probe that used the HP4-trained checkpoint as the
			   main policy while restoring the score-floor micro oracle
			   (`ml/meta_runs/nonfallen-hp4-conversion-scorefloor-mainmicro-20260701Tremote/summary.json`)
			   was stopped after a 7.38 VP target-field rejection. The decisive control
			   was `ml/meta_runs/scorefloor-raw-threecopy-control-20260701Tremote/summary.json`:
			   the original score-floor success policy also scored only 6.00 VP when
			   evaluated as three identical Good-builder clones, with Tidal row0
			   overcontested at 20.13 uses/game. Architecture implication: target
			   quality is not policy-only; it is a field-composition contract. The bot
			   lab should stop training/evaluating Good targets as cloned identical
			   builders unless the experiment is explicitly about overcontest
			   robustness. Promotion fields need diverse Good roles (one scoring carry,
			   noncontest support/economy roles, and hunters) so that "valuable Good
			   target exists" is a realistic strategic landscape rather than a clone
			   pile-up artifact.
			   The support-field rerun confirmed the field contract. With
			   `TARGET_FIELD_MODE=scorefloor-carry-support`,
			   `ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-supportfield-20260701Tremote/summary.json`
			   restored target quality for the same cash/restore HP4 overlay: 16.50
			   target-field VP, 5.88 kills/game, max status 2, and no cap violations.
			   It also slightly improved mixed hunter VP over the score-floor
			   success-lane baseline (17.38 vs 16.75), but it did not improve the true
			   promotion signal: mixed strict Good-pivot VP stayed 2.25 and best Good
			   target stayed 12. Architecture implication: HP4 restore/re-entry labels
			   can preserve the Good carry when evaluated in a realistic field, but the
			   next unlock is target exposure under pressure, not more clone-field
			   target scoring. The dashboard should show field mode next to every
			   target-quality metric so clone overcontest is never mistaken for policy
			   weakness again.
			   A focused exposure TraceQ probe then found the first concrete label
			   source for that unlock. In
			   `ml/meta_runs/target-exposure-scorefloor-hp4-supportpolicy-20260701Tremote/compact_summary.json`,
			   VP12-28 / HP4+ / Arcane Abyss states produced 32 exposure windows and
			   17 corrections, almost all `expose-lantern`. These corrections did not
			   increase immediate VP (average raw VP delta -1.19, correction VP delta
			   0), but they created a large visibility signal: exposure-window delta
			   177, average correction exposure VP 86.24, repeated VP15 Lantern
			   exposure rows, and one VP23 Lantern exposure row. Architecture
			   implication: target exposure should be a separate navigation/route-mode
			   head, not blended into HP4 restore/re-entry scoring. It is only useful
			   if a downstream mixed-league eval shows hunters repeatedly pivoting into
			   the now-visible 18+ Good carry; otherwise it is just visibility theater.
			   The first trained exposure-head follow-up confirmed that warning.
			   `ml/meta_runs/target-exposure-scorefloor-hp4-supportpolicy-navtrain-20260701Tlocal/summary.json`
			   fit the 17 exposure samples as a narrow `good-target-exposure`
			   navigation patch, but it was not promotable: target-field VP fell from
			   16.50 to 14.25, direct hunter-vs-target stayed strong at 29.88 VP and
			   16.13 PvP VP/game, and mixed hunter-vs-field stayed flat at 17.13 VP,
			   2.25 strict Good-pivot VP/game, and best Good target 12. The existing
			   `pvp-good-target-value-pivot` hunter gate was also rejected in the same
			   field at 9.88 VP and 0.38 PvP VP/game because it over-stayed Abyss when
			   no valuable Good target was visible. The mixed exposure smoke was
			   reproduced on the SimForge arc-bot workspace with `CUDA_VISIBLE_DEVICES=7`
			   and matched the local result exactly. Architecture implication: "farm
			   Abyss until monster EV drops, then attack valuable Good/non-Fallen
			   players" is the correct strategic contract, but the model needs paired
			   target-exposure and hunter-prediction/rendezvous labels. A one-sided
			   exposure head creates visibility theater unless the hunter can predict
			   or observe the exposed 18+ VP Good carry and convert it.
			   The next mixed-pressure rendezvous mining pass provided a better data
			   source but still rejected raw imitation as the training recipe.
			   `ml/meta_runs/scorefloor-rendezvous-pressure-20260701Tremote/summary.json`
			   mined from the actual score-floor carry/support/hunter field with
			   18/15/14 VP thresholds and found 1,375 success samples plus 564
			   near-miss samples, but full-policy fine-tuning reduced target-field VP
			   to 13.00 and mixed Good-pivot quality to best Good target 12.
			   `ml/meta_runs/scorefloor-rendezvous-navpatch-20260701Tlocal/summary.json`
			   then trained only a success-row navigation patch; it was less
			   destructive but still failed the gate with 14.38 target-field VP,
			   19.50 mixed hunter VP, 2.25 strict Good-pivot VP/game, and best Good
			   target 12. Architecture implication: the bot lab now has usable
			   mixed-pressure high-tail data, but high-tail imitation optimizes
			   "repeat this route" rather than "create an 18+ hunter-convertible Good
			   target." The next learner should add a counterfactual target-quality
			   head or labels that score future exposed Good target VP and downstream
			   hunter conversion, not just final own VP and action imitation.
			   That target-quality lane is now implemented as an explicit TraceQ
			   metric rather than a generic exposure proxy. The TraceQ branch metrics
			   track `valuableGoodTargetWindows`, `valuableGoodTargetVp`, and
			   `bestValuableGoodTargetVp`; the runner exposes
			   `TRACEQ_SCORE_TARGET_QUALITY_*`, `TRACEQ_TARGET_QUALITY_MIN_VP`, and
			   `TRACEQ_REQUIRE_TARGET_QUALITY_DELTA`. The first broad run,
			   `ml/meta_runs/target-quality-traceq-scorefloor-hp4-20260701Tlocal/compact_summary.json`,
			   found 22 VP18+ corrections out of 32 windows, mostly Lantern exposure,
			   but initially exposed a runner bug: remote `SOURCE_DESTINATION` was not
			   forwarded/escaped. After fixing that in
			   `scripts/run-arc-tracestateq-fullcontrol.sh`, the focused HP4+
			   Arcane-Abyss run
			   `ml/meta_runs/target-quality-traceq-scorefloor-hp4-focused-20260701Tlocal/compact_summary.json`
			   found 3 strict corrections out of 32 filtered windows. The concrete
			   strategic cases match the intended game plan: a VP23 Good target at
			   monster HP5 should expose Lantern instead of re-entering Abyss, and a
			   VP19 Good target at monster HP4 should expose Floral/Lantern so hunters
			   can pivot from monsters to players. Architecture implication: the pivot
			   is real, but the strict filtered signal is sparse. The next production
			   learner should combine this target-quality label with larger mixed-field
			   mining and a hunter-conversion/prediction head; do not train or promote
			   a one-sided 3-sample navigation patch.
			   The first automated patch lane sharpened that conclusion. In
			   `ml/meta_runs/target-quality-navpatch-eval-20260701Tlocal/summary.json`,
			   `scripts/run-arc-target-quality-patch-lane.sh` mined the broader
			   VP18+ target-quality shard, trained a 22-sample `good-target-exposure`
			   navigation patch, then evaluated the exact same score-floor carry/support
			   field with and without the patch. The result split cleanly: direct
			   hunter-vs-target conversion improved (strict Good-pivot VP 0.38 -> 4.50,
			   hunter VP 29.63 -> 29.88), but the Good carry itself got weaker
			   (target-field VP 16.50 -> 14.25, reach30 12.5% -> 0) and mixed play still
			   found only a 12-VP best Good target. Architecture implication: target
			   exposure is useful, but the one-sided nav patch over-applies the
			   rendezvous behavior and under-farms. The next model should not simply
			   imitate exposure destinations; it should predict the marginal value of
			   "one more farmable monster life" versus "become visible to a hunter,"
			   and it should pair target exposure labels with hunter conversion labels
			   so the carry remains valuable while the hunter learns the rendezvous.
			   A stricter injection check confirmed this is not just a low-VP gate
			   problem. `ml/meta_runs/target-quality-navpatch-vp18gate-eval-20260701Tlocal/summary.json`
			   reused the same patch with `ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP=18`.
			   It recovered some target-field quality (15.50 VP instead of 14.25) and
			   direct hunter best Good target reached 19, but target-field VP still
			   trailed the 16.50 baseline and mixed play still found only a 12-VP best
			   Good target. Architecture implication: a static VP threshold is too
			   blunt. The target needs a learned or counterfactual marginal EV decision
			   over "farm one more monster life" vs "expose now," and the league needs
			   paired labels that reward the hunter only when that exposure is actually
			   converted in mixed play.
			   The farm-EV-gated VP18 reuse
			   (`ml/meta_runs/target-quality-navpatch-vp18-farmev1-eval-20260701Tlocal/summary.json`)
			   tested that marginal-value idea with
			   `ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP=1` and
			   `ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP=2`. It preserved
			   the Good target field within tolerance (16.50 -> 16.25 VP, max status
			   still 2) and kept direct hunter conversion strong (29.63 VP, 15.75 PvP
			   VP/game, strict Good-pivot VP 0.38 -> 2.63, best Good target 18 -> 19).
			   That confirms the strategic boundary should be value-based: consume
			   cheap multi-life Abyss rewards, then pivot to the repeatable +3 VP
			   Good-player attack when the current monster rung is worse. It still
			   failed mixed promotion because the candidate carry averaged only 9.75 VP
			   under mixed pressure, the hunter's best Good target stayed 12, and weak
			   support seats absorbed too much PvP pressure. Architecture implication:
			   the next learner should be a paired target/hunter lane that protects or
			   de-emphasizes support seats, raises the carry to 18+ VP in contested
			   fields, and trains the hunter to rendezvous with that specific valuable
			   target after the monster-farm EV gate flips.
			   The next two probes ruled out the simplest fixes. The
			   `candidate-baseline-carry` composition probe
			   (`ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-eval-20260701Tlocal/summary.json`)
			   replaced the weak support with a second Good carry; mixed hunter VP fell
			   to 15.25, strict Good-pivot VP to 0.75, and best Good target stayed 12.
			   The strict high-value hunter probe
			   (`ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-highvaluehunter-eval-20260701Tlocal/summary.json`)
			   forced attacks only at 18+ target VP and waited for 18+ before
			   status-2 descent; direct candidate conversion collapsed to 14.13 VP and
			   mixed hunter VP to 8.63 with 0 PvP VP. More importantly, the mixed Good
			   carries still averaged only 8.75 and 8.63 VP with zero PvP target
				   combats. Architecture implication: mixed failure is not just weak
				   support-seat dilution or premature low-value PvP. Two hunter seats also
				   contest the monster economy and prevent the Good carry from becoming
				   valuable. The next model should train a contested-resource target policy
				   plus a soft hunter value gate, rather than a hard high-target-only rule.
				   The soft-value hunter follow-ups make that sharper. The 12-VP
				   `pvp-good-target-value-pivot` probes
				   (`ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvaluehunter-eval-20260701Tlocal/summary.json`
				   and
				   `ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvalue-conversion-eval-20260701Tlocal/summary.json`)
				   restored direct hunter-vs-candidate conversion to 24.00 VP with
				   10.13 PvP VP/game and best Good target 21, but mixed play still had
				   0 PvP VP and no valuable Good target. Lowering the soft target
				   threshold to 9
				   (`ml/meta_runs/target-quality-navpatch-vp18-farmev1-dualcarry-softvalue9-conversion-eval-20260701Tlocal/summary.json`)
				   improved the direct lane to 27.38 VP and 13.50 PvP VP/game, while
				   mixed play remained 8.38 VP with 0 PvP. Architecture implication:
				   the desired policy is explicitly sequential -- farm efficient
				   multi-life Abyss rewards, then pivot into valuable Good/non-Fallen
				   players when the monster rung is inefficient -- but the current root
				   gate has no shared mixed-field rendezvous model. The next lane should
				   train paired mixed-state policies that predict where valuable targets
				   will be and reward creating/meeting those targets while preserving
				   carry growth.
				   The `good-target-rendezvous-exposure` follow-up shared the destination
				   predictor between target exposure and hunter pursuit. In the original
				   `candidate-baseline-carry` mixed mode it did not move the needle: VP18
				   stayed at 8.38 mixed hunter VP with 0 PvP, and VP12 improved direct
				   Good-pivot VP to 6.00 while still producing 0 mixed PvP and harming
				   target quality. The important discovery was field composition. The old
					   mixed stack included hunter roles while the eval also injected the main
					   hunter, creating an over-huntered field that starved Good target
					   creation. `MIXED_FIELD_MODE=single-hunter-baseline-carry` removed those
					   extra hunters; the 8-game run promoted at 21.75 mixed VP, 12.00 PvP
					   VP/game, 62.5% reach30, and best Good target 22. A 32-game mixed-only
					   confirmation then regressed to 17.06 VP, 7.88 PvP VP/game, 40.6%
					   reach30, and repeated 6-9 VP tails. Architecture implication: the
					   league/eval contract must model realistic hunter density, and the next
					   learner should focus on low-tail recovery after failed hunts while
					   keeping the single-hunter PvP pivot.
					   The low-tail recovery patch added that missing recovery rule to
					   `pvp-good-target-value-pivot`. With
					   `ARC_PVP_LOW_TAIL_HUNT_MAX_VP=12`,
					   `ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND=10`, and
					   `ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP=4`, a Fallen low-VP hunter at
					   HP4+ is allowed to blind-cycle likely Good-player destinations once
					   cheap multi-life Abyss farming and reliable monster finishes are no
					   longer better. The confirmation run
					   `ml/meta_runs/target-quality-rendezvous-vp18-farmev1-singlehunter-lowtail12-eval-20260701Tlocal/hunter_vs_candidate_mixed_g32.json`
					   reached 29.06 VP, 91% reach30, 19.88 PvP VP/game, 5.81 strict
					   Good-pivot VP/game, best Good target 22, and 0% missed PvP
					   opportunities. Architecture implication: the intended route contract
					   is now represented in the evaluator: consume efficient low-rung
					   multi-life Abyss rewards, then attack Good players for repeatable
					   +3 VP once the monster rung becomes inefficient. The remaining work is
					   not "remember to attack players"; it is to generalize this into a
					   learned policy/league gate, verify role-portfolio robustness, and make
					   the dashboard show when balance changes move reward VP versus PvP VP.
					   The first role-portfolio follow-up confirms that split. The low-tail
					   hunter is strong in the single-hunter field (`current` and `conversion`
					   both reached 30 VP in
					   `ml/meta_runs/role-portfolio-lowtail12-singlehunter-20260701Tlocal`),
					   but the Good/Pure score-floor controls are weak: `target` averaged
					   12.63 VP and `pure` averaged 10.88 VP. Three target-only trace probes
					   (`role-portfolio-hp4survival-target-20260701Tlocal`,
					   `role-portfolio-relicguard-target-20260701Tlocal`, and
					   `role-portfolio-cult2lantern-target-20260701Tlocal`) all stayed at
					   12.88 VP. The concrete failure is HP4/HP5 conversion, not the PvP
					   pivot: the route farms early monster lives, then struggles to assemble
					   both 4-5 reliable damage and enough max/current barrier to keep farming
					   cleanly. Architecture implication: the next lane should be explicit
					   HP4/HP5 conversion training with counterfactual labels for
					   Spirit Animal/Animal augment damage, Cultivator/Support max-barrier
					   conversion, relic preservation, restore timing, and re-entering Abyss.
					   Keep heuristic tweaks only as diagnostics; the dashboard should expose
					   this as separate monster VP, PvP VP, damage breakpoint, max barrier,
					   and route-collapse metrics.
					   The July 1 PvP-pivot curriculum comparison turns the "attack Good
					   players after monsters get inefficient" rule into a trainable lane.
					   `src/lib/play/ml/_pvppivotcurriculum.test.ts` now records
					   `teacherKind` on samples, and
					   `scripts/run-arc-pvp-pivot-curriculum-lane.sh` can train filtered
					   slices. Three GPU-4/5/7 smoke lanes used the same 271-sample
					   curriculum. `hunt-attack-farmreturn` was too narrow and regressed
					   role-stack PvP (11.75 VP, 3.00 PvP VP/game). `late-only` still
					   over-stayed Abyss (15.25 VP, 4.13 PvP VP/game). The promoted
					   `no-build` filter removed broad preparation labels while keeping
					   class, cheap-farm, descend, farm-return, hunt, and attack labels:
					   `ml/meta_runs/pvp-pivot-filter-nobuild-20260701Tlocalremote/summary.json`
					   improved role-stack VP from 15.75 to 20.13, PvP VP/game from 7.50
					   to 8.63, found a 12-VP target, missed 0% of legal PvP windows, and
					   reached 30.00 VP with 22.13 PvP VP/game against score-floor targets.
					   Architecture implication: do not train a pure "attack now" patch.
					   Train the whole conversion ladder, but exclude generic build-loop
					   labels that teach the bot to postpone the monster-to-player pivot.
					   The continuation portfolio run with that promoted `no-build`
					   checkpoint
					   (`ml/meta_runs/role-portfolio-pvp-nobuild-20260701Tcont/summary.json`)
					   confirms the rule but rejects the portfolio. `current` and
					   `conversion` both averaged 20.13 VP with 8.63 PvP VP/game and 0%
					   missed PvP windows, while `target` averaged 9.75 VP and `pure`
					   averaged 7.13 VP; `solvedPortfolio=false`. This means the
					   monster-to-Good-player pivot exists, but the league still lacks
					   strong Good/Pure score-floor players for the hunter to exploit.
					   The route contract should stay sequential: farm efficient low-rung
					   multi-life Abyss lives, stop over-staying when the HP4/HP5 monster
					   line is inefficient, then attack valuable Good/non-Fallen players
					   for VP. The next architecture lane must make Good/Pure players
					   valuable first, not merely make the hunter more aggressive.
					   The HP4 learned-overlay follow-up is also rejected. Both
					   `ml/meta_runs/nonfallen-hp4-scorefloor-arb-existing-20260701Tcont/summary.json`
					   and
					   `ml/meta_runs/nonfallen-hp4-scorefloor-oracle-train-20260701Tcont/summary.json`
					   found TraceQ corrections in 100% of sampled windows, but the
					   target field remained at 5.88 VP and non-promotable. Treat broad
					   learned HP4 micro overlays as a dead end for now. The next lane
					   should model target quality, reward conversion, leave/re-enter
					   Abyss timing, and paired hunter/target rendezvous directly.
					   Local continuation diagnostics sharpen that blocker. The baseline
					   2-game target trace
					   (`ml/meta_runs/target-role-trace-local-20260701Tcont/result.json`)
					   averaged only 6 VP with 2 monster kills and 2 Abyss navs. Controlled
					   non-Fallen corrupt farming plus stricter restore gating
					   (`ml/meta_runs/target-role-trace-local-controlled-restoregate-20260701Tcont/result.json`)
					   improved the shape to 9.5 VP, 3.5 kills, status 2, and maxBarrier
					   6.5, but still did not close. A tiny legal beam
					   (`ml/meta_runs/routeoracle-nonfallen-small-local-20260701Tcont/summary.json`)
					   reached 15 VP and 5 kills before decision budget, then stopped on
					   current-barrier deficit / firepower-ready-but-not-clean / insufficient
					   remaining reward VP. Architecture implication: the next labels should
					   be route-level HP4/HP5 conversion labels for Good/Pure targets, not
					   a wider micro overlay. The model needs to learn when to spend
					   non-Fallen corruption, when to restore current barrier, when to build
					   max barrier/damage, and when to cash the remaining monster rewards
					   before becoming a PvP target.
					   The GPU target-only role check with controlled non-Fallen farming
					   (`ml/meta_runs/role-target-controlled-restoregate-20260701Tcont/summary.json`)
					   confirms the same direction: the target role improved to 13.88 VP,
					   5.25 monster kills, 7.50 Abyss navs, status 2, and no status-cap
					   violations, but still missed the 15 VP floor and had 0% reach30.
					   Keep controlled status-2 farming as a curriculum lane; do not treat
					   it as the solved Good-player target policy.
	8. Adding a second, narrower hunt/PvP collector only for late-descend games that
				   become Fallen and still cannot close through monsters. It should choose only
		   non-Abyss destinations with visible Good targets and avoid destinations where
   another Evil player can block the unanimous group attack.
9. Preserving damage assembly in any high-tail retrain; do not repeat the global
   route-finish replacement.
10. Treating `traceq-damage-nearmiss-vp28-29` as a teacher-discovery artifact,
   not a promoted specialist, until a route-proof run beats 23.83 VP and improves
   reach30.

## Cleanup Plan

1. Keep `botPolicy.ts` quarantined as `legacy heuristic baseline`.
2. Move any remaining tests that require it under explicit baseline/meta names.
3. Make all live bot creation, seeding, and matchmaking write `bot_profile = 'neural'`.
4. Make training/eval produce `arc-bot-v1` run artifacts.
5. Build the dashboard against those artifacts.
6. Delete heuristic baselines only after the ML league can generate cold-start data without them.
