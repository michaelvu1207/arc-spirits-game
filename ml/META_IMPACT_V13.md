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

| ladder8c2-gen60 (live net) | Elo | win | meanVP |
|---|---|---|---|
| gauntlet-v8 (old rules) | **727** | 96.1% | 27.4 |
| v9 interim (roll-scaled PvP, 1-life 2p) | 158 | 51.8% | 11.5 |
| **v9 FINAL ruleset** | **195** | **60.9%** | **16.4** |

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

| table | old rules | rules v1.3 |
|---|---|---|
| 2p | 6.7% / 11.5 VP | 0.0% / 4.9 VP |
| 3p | 0.0% / 7.2 VP | 1.1% / 5.1 VP |
| 4p | 0.0% / 5.4 VP | 0.9% / 3.3 VP |
| 6p | 0.0% / 5.3 VP | 0.0% / 2.6 VP |

Economy lines (hard/rushpatient/cultivator/etc.): essentially unchanged, ~5–7 avgVP,
0% win at all table sizes under both rule sets.

## 3. Interpretation

- **DIVERSITY_FINDINGS' "85% pvphunter" world is long gone** — the v1.2 corruption-debt
  rule already killed the flat-+3 faucet for the *heuristic* implementation (it corrupts
  itself into VP-bleed). v1.3 halves its take again: it spams weak-roll attacks
  (7–10/game) that now pay floor(roll/2) ≈ 1–2 VP each, minus corruption debt.
- **No heuristic reaches 30 VP under v1.3** (nor under current old rules, save 6.7%
  pvphunter at 2p). Heuristics are not the meta ceiling — the neural champion converts
  the same rules into 11.5 meanVP, so the interesting question is what a *retrained* net
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
|---|---|---|---|
| 1 | 1 | 33 | 91% (solo) ✓ |
| 2 | 2 | 66 | 45% ✓ |
| 3 | 2 | 66 | 45% ✓ |
| 4 | 3 | 99 | 30% ✓ |
| 5 | 3 | 99 | 30% ✓ |
| 6 | 3 | 99 | 30% ✓ |

Michael's invariant — someone must be able to reach 30 VP from monsters alone — now
holds at every table size.

**Realized** (VP-by-source audit, heuristic field, 40 games/table size, 30r):

| seats | avgVP | monster share of gains | PvP share | target monster share |
|---|---|---|---|---|
| 1 | 7.1 | 100% | 0% | 100% |
| 2 | 6.6 | 100% | **net negative** | 85% |
| 3 | 6.3 | 100% | net negative | 70% |
| 4 | 6.9 | 100% | net negative (pvphunter −4.9 VP/game) | 60% |
| 5 | 5.8 | 100% | net negative | 60% |
| 6 | 4.9 | 100% | net negative | 50% |

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

| candidate | v9 Elo (800g) | real win% | meanVP | mixed-field probe |
|---|---|---|---|---|
| old champion (baseline) | 195 | 60.9% | 16.4 | 9.9 VP / 65% / 0% reach-30 |
| v13w gen20 (warm) | 643 | 94.3% | 28.2 | 14.9 VP / 94% / 3% reach-30 |
| v13w gen28 (warm) | 649 | 94.0% | 28.7 | 14.4 VP / 87% / 1% reach-30 |
| **v13s gen48 (scratch) → CHAMPION** | 592 | 93.6% | 29.0 | **27.1 VP / 100% / 49% reach-30, ends ~r24** |

**Champion: v13s-gen48** (`ml/champions/v13-1/`, bundled to the live
policy-weights.json). Rationale: head-to-head dominance over the other finalists and the
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
