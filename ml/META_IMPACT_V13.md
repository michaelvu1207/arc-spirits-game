# Meta Impact Readout — Rules v1.3 (2026-07-07; FINAL numbers at bottom of §1)

Rules v1.3 FINAL: (a) monster lives on every rung scale with player count (1p→1, 2-3p→2,
4+p→3); (b) finite deck — spending the final monster's last life SAVES THE SPIRIT WORLD
and ends the game with final scoring; (c) PvP VP = 2 for engaging + 2 per Good player
corrupted (was flat +3). Earlier drafts of this doc measured interim variants
(roll-scaled PvP, 1-life 2p) — superseded sections are marked.

Method: metaBattery (400 FFA games/table-size across 4 seed-disjoint shards + 30-game
matchup slices, maxRounds 150), VP-by-source audits, and a full 800-game gauntlet
re-baseline of the shipped champion. Raw shards: `ml/battery_v13/` (interim),
`ml/battery_v13_final/` (final ruleset).

## 1. Champion re-baseline (the number that matters)

| ladder8c2-gen60 (live net)              | Elo     | win       | meanVP   |
| --------------------------------------- | ------- | --------- | -------- |
| gauntlet-v8 (old rules)                 | **727** | 96.1%     | 27.4     |
| v9 interim (roll-scaled PvP, 1-life 2p) | 158     | 51.8%     | 11.5     |
| **v9 FINAL ruleset**                    | **195** | **60.9%** | **16.4** |

The old champion still beats every heuristic (Elo 177–309 pairwise) but is far from its
v8 saturation, and its mirror vs itself is ~fair. **The v9 number to beat is Elo 195.**
v9's anchor pool = 8 heuristics + ladder8c2-gen60 (83-dim, active). Baseline recorded in
ml/gauntlet_results/history.jsonl (rev rules-v1.3-FINAL-rebaseline).

Final-ruleset heuristic field (400 games/table): still no heuristic wins meaningfully
(pvphunter best at 0-3%), PvP remains net NEGATIVE for the heuristic implementation
(-0.4 to -0.7 VP/game — it spams attacks and bleeds corruption debt), and monster
rewards remain ~100% of heuristic VP gains. The 2+2 corruption-bounty line is wide open
for the retrained net to exploit.

## 2. Heuristic field, before → after (FFA, win% / avgVP)

pvphunter (the only heuristic that PvPs) — its VP roughly halves at every table size:

| table | old rules      | rules v1.3    |
| ----- | -------------- | ------------- |
| 2p    | 6.7% / 11.5 VP | 0.0% / 4.9 VP |
| 3p    | 0.0% / 7.2 VP  | 1.1% / 5.1 VP |
| 4p    | 0.0% / 5.4 VP  | 0.9% / 3.3 VP |
| 6p    | 0.0% / 5.3 VP  | 0.0% / 2.6 VP |

Economy lines (hard/rushpatient/cultivator/etc.): essentially unchanged, ~5–7 avgVP,
0% win at all table sizes under both rule sets.

## 3. Interpretation

- **DIVERSITY_FINDINGS' "85% pvphunter" world is long gone** — the v1.2 corruption-debt
  rule already killed the flat-+3 faucet for the _heuristic_ implementation (it corrupts
  itself into VP-bleed). v1.3 halves its take again: it spams weak-roll attacks
  (7–10/game) that now pay floor(roll/2) ≈ 1–2 VP each, minus corruption debt.
- **No heuristic reaches 30 VP under v1.3** (nor under current old rules, save 6.7%
  pvphunter at 2p). Heuristics are not the meta ceiling — the neural champion converts
  the same rules into 11.5 meanVP, so the interesting question is what a _retrained_ net
  can reach. If a strong retrained net ALSO plateaus far below 30, the win condition may
  be out of reach under v1.3 and the design knobs (PvP divisor, corruption bonus,
  monster reward VP) should be revisited — flag for Michael after Phase 3.
- The intended v1.3 incentive (build dice → big rolls → 4–6 VP/attack + corruption
  bonuses) is invisible to the fixed heuristics; only training can discover whether it's
  strong. That's the retrain's central hypothesis to test.

## 4. Monster-VP share vs Michael's target curve (2026-07-07)

Target: of the 30 VP needed to win — 1p 100% from monster, 2p 85%, 3p 70%, 4p 60%,
5p 60%, 6p 50%.

**Capacity** (final rulings 2026-07-07: the deck is FINITE — every rung including the
final one carries player-count lives (1p→1, 2-3p→2, 4+p→3), and spending the final
monster's last life SAVES THE SPIRIT WORLD, ending the game with final scoring): the
ladder pays 3/3/2/2/3/4/6/10 = 33 VP per traversal, so the total pool is 33 × lives(p):

| players | lives | pool | share one player needs for 30 |
| ------- | ----- | ---- | ----------------------------- |
| 1       | 1     | 33   | 91% (solo) ✓                  |
| 2       | 2     | 66   | 45% ✓                         |
| 3       | 2     | 66   | 45% ✓                         |
| 4       | 3     | 99   | 30% ✓                         |
| 5       | 3     | 99   | 30% ✓                         |
| 6       | 3     | 99   | 30% ✓                         |

Michael's invariant — someone must be able to reach 30 VP from monsters alone — now
holds at every table size.

**Realized** (VP-by-source audit, heuristic field, 40 games/table size, 30r):

| seats | avgVP | monster share of gains | PvP share                             | target monster share |
| ----- | ----- | ---------------------- | ------------------------------------- | -------------------- |
| 1     | 7.1   | 100%                   | 0%                                    | 100%                 |
| 2     | 6.6   | 100%                   | **net negative**                      | 85%                  |
| 3     | 6.3   | 100%                   | net negative                          | 70%                  |
| 4     | 6.9   | 100%                   | net negative (pvphunter −4.9 VP/game) | 60%                  |
| 5     | 5.8   | 100%                   | net negative                          | 60%                  |
| 6     | 4.9   | 100%                   | net negative                          | 50%                  |

Two structural gaps vs the curve:

1. **PvP contributes nothing at any table size** — for the only line that uses it, the
   roll-scaled payout (weak pools → 1–2 VP/attack) is outweighed by Fallen corruption
   debt. The non-monster share the curve wants at 3p+ (30–50%) has no working faucet.
2. **Absolute pace is too slow to win**: heuristics realize ~3 kills / 7–9 monster VP in
   30 rounds; the old champion realizes 11.5 total under v1.3. Nobody reaches 30.

## 5. Retrain results + balance readout (2026-07-08, Phase 2-4)

Two 60-gen league-PPO runs (ladder8c2 recipe, promotion via gauntlet-v9, frozen old
champion stamped at its v9 Elo 195): `league_v13w` warm-started from the old champion,
`league_v13s` from scratch. Both trained in ~80 minutes wall clock on the box.

| candidate                           | v9 Elo (800g) | real win% | meanVP | mixed-field probe                            |
| ----------------------------------- | ------------- | --------- | ------ | -------------------------------------------- |
| old champion (baseline)             | 195           | 60.9%     | 16.4   | 9.9 VP / 65% / 0% reach-30                   |
| v13w gen20 (warm)                   | 643           | 94.3%     | 28.2   | 14.9 VP / 94% / 3% reach-30                  |
| v13w gen28 (warm)                   | 649           | 94.0%     | 28.7   | 14.4 VP / 87% / 1% reach-30                  |
| **v13s gen48 (scratch) → CHAMPION** | 592           | 93.6%     | 29.0   | **27.1 VP / 100% / 49% reach-30, ends ~r24** |

**Phase-4 champion: v13s-gen48** (`ml/champions/v13-1/`). This was the first
rules-v1.3 champion and became the frozen gauntlet-v10 anchor; it was superseded later
the same day by v13-2-gen44, which is the current live bundle (see sections 7-8).
Rationale at this phase: head-to-head dominance over the other finalists and the
healthiest win profile (races to 30 rather than grinding all-Fallen cap endings); its
lower anchor-pool Elo is a placement artifact. Warm-start proved viable but anchored to
slower play — from-scratch won.

**Balance readout (the design question):**

- The game is dramatically more winnable: trained play reaches 30 VP in ~half of games
  (vs ~0% for anything under the old rules' realized play), and games END (round ~24 or
  all-Fallen/cap), thanks to the finite deck + save-the-world ending.
- **BUT the trained meta is a corruption monoculture again**: every finalist plays
  Fallen-aggro (avg end status 3.0). The 2-engage/+2-corruption payout, played WELL
  (target selection, descent timing), is the strongest line — heuristic pvphunter's
  net-negative PvP was incompetence, not evidence of balance. The training-side
  collapse penalty (-3.0) did not change the equilibrium.
- Design knobs if a diverse meta is wanted (Michael's call): PvP engage fee 2→1 or
  corruption bounty 2→1, a tempo cost for descending to Fallen, or monster-side buffs
  (reward VP up). Each is eval-visible → gauntlet-v10 fork.

## 6. Gate status

- `test:bot:engine`, `test:bot:ml-smoke`: PASS under v1.3.
- Full unit suites: arc-spirits-game 985 passed; arc-league-run2 816 passed.
- gauntlet-v9 fork committed in `src/lib/play/ml/gauntlet/manifest.ts`; re-baseline
  appended to `ml/gauntlet_results/history.jsonl`.

## 7. Serving-config study (2026-07-08, post-v13-2)

All numbers: v13-2 champion, 800-game frozen gauntlet-v10 (Elo) + 400-game 4-copy
mirror probe (`_mirror.test.ts`, reach-30 = % of games where anyone hits 30 VP).

| config                  | Elo | mirror reach-30 | note                                                |
| ----------------------- | --- | --------------- | --------------------------------------------------- |
| argmax                  | 453 | 19.5%           | eval ceiling; clones starve                         |
| nav-only t=0.3          | 445 | 35.8%           |                                                     |
| nav-only t=0.65         | 432 | 43.5%           | SHIPPED live default                                |
| all-phase t=0.3         | 412 | 32.8%           |                                                     |
| search16 policy-rollout | 447 | —               | rollout fix recovers the regression, still ≤ argmax |
| search32 policy-rollout | 431 | —               | more sims do NOT help                               |
| search16 argmax         | 399 | —               | search REGRESSES: stale heuristic rollouts          |
| all-phase t=0.65        | 385 | 41.3%           | old live default                                    |
| search16 t=0.65         | 374 | —               | ARC_EXPERT_BOTS=1 config — do not enable            |
| all-phase t=1.0         | 341 | —               | training distribution                               |

Findings: (1) the ~70-Elo live-serving cost was almost entirely NON-navigation
sampling noise; clone collision is a route-choice problem, so nav-only temperature
keeps the mirror-health benefit at near-argmax strength (+47 Elo shipped, config
`ARC_LIVE_BOT_TEMP_SCOPE`). (2) The Gumbel search tier scores BELOW the raw policy
under rules v1.3. The stale medium-heuristic rollout policy was most of it (fixing
it: 399→447), but even policy rollouts at 2× sims never beat raw argmax (431/447
vs 453) — the net's own one-step values outperform 6-round rollout estimates, so
search is a dead end at this net size; don't enable ARC_EXPERT_BOTS for strength.

## 8. V14 push (2026-07-08/09) — NO PROMOTION; champion survives, exploiter archived

4 fresh scratch seeds (`ml/league_v14a-d`, y2 recipe, 120 gens, workers 30 ea) with
v13-2 in the frozen PFSP field at its true Elo 453 (extraFrozen). Best candidate:
**v14b-gen120** (finals pool: 14.5 VP/33% vs incumbent 12.5/24%; direct h2h vs 3×
v13-2: 27% win as focus, holds v13-2 to 22%).

BUT the general-strength measures both favor the incumbent:

- gauntlet-v10: v14b **394** vs v13-2 **453** (win 78.6% vs 83.1%)
- heuristic-field probe (400 games, human proxy): v14b 27.6 VP/91%/77% r30 vs
  v13-2 **29.4/96%/82%**, and ~2 rounds slower.

Verdict: v14b's h2h edge is LEARNED EXPLOITATION of its frozen training target,
not general superiority — the mirror image of the anchor-specialist lesson (4th
anchor/direct divergence; the probe decides, but only against opponents the
candidate did NOT train on). v13-2 stays champion. v14b archived at
`ml/exploiters/v14b-gen120.json`: (a) frozen exploiter-anchor for future leagues
(v15 field = heuristics + v13-1 + v13-2 + v14b), (b) evidence the champion has an
exploitable seam — the v13-2 exploiter-probe human layer is now MEASURED (a
dedicated net gains ~+5% win vs it).

Design note: line choice is FIELD-CONDITIONAL. Both nets play Fallen-aggro
(status ~3.0) vs weak heuristic fields but soften to 'mixed' (status ~2.0-2.4) in
all-strong pools — and v14b beat v13-2 head-to-head with the LESS corrupted line.
The corruption monoculture is the optimal answer to exploitable opponents, not
an unconditional dominant strategy.

## 9. v15 corrected-contract successor (2026-07-11)

The July v15 campaign found and fixed a PPO no-op caused by `0 * -inf` entropy
terms on post-filtered behavior support, then reran the corrected public-information
contract. Public monster stats and deterministic reward/drop previews remain visible;
only uncommitted RNG outcomes are hidden.

Matched aux-off/aux-on seeds, isolated farm/reward/route heads, h256/h512 width,
and the existing rollout-search settings all failed to beat v13-2 across full and
mixed-field gates. Aggressive warm-start PPO also regressed. The successful arm
warm-started v13-2 but reduced update drift (LR 1e-4, two epochs, clip 0.1,
entropy 0.002, cosine schedule, target KL 0.01, KL-reference coefficient 0.05),
with self-play reduced to 0.1 for more PFSP/frozen-field exposure.

`ml/champions/v15-1/main-0-gen10.json` scored 476 Elo over the 800-game
gauntlet-v10 versus v13-2's 453. In the direct learned field it produced 48% wins,
14.9 VP, and 12% reach-30 versus v13-2's 35.5%, 12.74 VP, and 8.5%. The exact
live nav-only temperature-0.65 configuration scored 474 Elo, and the candidate
led a held-out historical neural field at 57% wins. It is therefore the new bundled
champion. Final certification also passed: a fresh 16-generation exploiter scored
an estimated -814 Elo relative gain (failure threshold +50), and the candidate's
seat-normalized score did not drop in the two-hunter collusion probe (0.993 vs
0.990 with one hunter). Human play remains the next external layer.
