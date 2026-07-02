# Arc Spirits Bot Campaign — Report, 2026-07-02

One session (2026-07-01 evening → 07-02 morning) took bot development from an
inherited, circling effort to a verified fair-rules champion, with every claim
gauntlet-measured and every avenue in BOT_TAKEOVER_PLAN.md executed.

## The champion

**`ml/champions/fair/main-0-gen24.json` — gauntlet-v2 Elo 1014, 99% win rate,
29.8 mean VP over 800 games under verified-fair rules. Live in the game since
commit 1c7766a.**

Lineage: random 75K-param init → 24 generations of guarded league PPO (PFSP vs
8 heuristics, no teacher, no gates, no checkpoint knowledge) under rules v1.1.

## The scoreboard (gauntlet-v2, honest rules)

| Agent | Elo | Win % | Note |
|---|---|---|---|
| **Fair champion (gen-24)** | **1014** | **99.0** | live |
| Fair gen-20 (promoted in-run) | 720 | 96.0 | |
| pvphunter (best heuristic) | 382 | 79.3 | honest heuristic bar |
| Old "1056" champion (market era) | 220 | 67.4 | exploit removed |
| BC-distilled student (221-era) | ~218* | | *scored under v1 |
| Old 268 champion (market era) | −256 | 5.3 | collapsed without exploit |
| v2 transformer lane (best) | ~−460 | 0.3 | distilled proxy, see below |

## Stop conditions (BOT_TAKEOVER_PLAN.md)

- **(b) Exploitability — PASSED.** Fresh exploiter, 16-generation budget:
  −655 Elo vs the +50 threshold (2.17% head-to-head over 200 games).
  `ml/gauntlet_results/probe-fair24.json`.
- **(c) No superior found — met within tonight's recipes.** Continuation
  training from the champion regresses (261/210/249 across three consecutive
  promotion checks in the market era; same pattern post-fix). The v2
  transformer lane (BC-seeded at 94.8% imitation, champion as frozen peer,
  12 generations) never exceeded 8% pairwise vs its field.
- **(a) Beats Michael over ≥20 games — pending, human-gated.** The live game
  serves the champion; play at will. This is the only open condition.

## The rules watershed (the session's most important event)

Michael's human playtest caught what no internal metric could: the engine
exposed an ungated market command family (`takeSpirit`/`replaceSpirit`/
`refillMarket`) — no location commitment, no phase, no cost, no limit, and no
UI path (humans could not perform these actions at all). Every RL lineage
found it and built ~99% of its economy on it, parked at the Arcane Abyss.

Because every agent cheated equally, the gauntlet, the league, and the
exploitability probe were all internally consistent — the hole was invisible
from inside the system. **Rules v1.1 (commit 09449c0) closed it; gauntlet
bumped to v2; all v1 numbers are non-comparable.** See docs/rules-v1.1.md and
the audit at scripts/audit-location-integrity.mjs.

## What the campaign demonstrated

1. **Strategy discovery from scratch, twice.** Random nets with zero prior
   knowledge independently discovered the game's dominant lines — including
   the corruption attractor under old rules and a 29.8-mean-VP line under
   fair rules — in ~20–25 generations each (~minutes on the free box).
2. **Imitation caps at its teacher; RL is where gains live.** BC/distilled
   nets score at their data source's level (218 vs 221); every imitation-
   descended league plateaued far below the from-scratch lines.
3. **Leagues need peers.** A warm-started main above its whole field drifts
   (287→plateau; 1056-warm-start→208). `extraFrozen` champion-peer seeding
   fixed the mechanism.
4. **The v2 entity-transformer showed no advantage tonight.** With a
   94.8%-imitation BC seed and 12 PPO generations, it collapsed rather than
   climbed. Open directions if revisited: near-lossless BC (the 221-era
   distill hit 99.6% agreement — target that before PPO), much gentler
   post-BC updates, longer lanes on the A100s.

## Balance evidence for the design decision

Under BOTH rulesets, every learner converges on corruption (learner-seat
Fallen ~77–86%; winner-corrupt ~100% by gen 3 in the first league run). The
corruption attractor is structural, not a training artifact. The data for the
2-line rebalance decision is in docs/balance-report-league-run-1.md plus the
league corruption tables (`ml/dashboard.py league`).

## Infrastructure shipped (all committed on ml-bot-pipeline)

Deterministic actor pool · v1/v2 inference server with binary wire ·
entity encoder v2 (info-safety proven) · set-transformer + BC/distill/PPO
trainers with divergence guards · league manager (PFSP, exploiters, v1/v2
lanes, crash-safe) · frozen gauntlet (v2) · exploitability probe ·
balance dashboard · simforge1 deploy kit · rules-integrity audit.
Plus two live-game fixes from playtest (location clicks, summon tray) and
rules v1.1 itself.

## Operational notes

- All compute on simforge1 `/tmp/arc-bot` (volatile — champions/results are
  committed here after every milestone). Shares are clean of project files.
- Nightly heartbeat: `scripts/nightly-gauntlet.sh` appends to
  `ml/gauntlet_results/history.jsonl`.
- To resume training: the league CLI + configs under `ml/league*/config.json`
  reproduce every run in this report.
