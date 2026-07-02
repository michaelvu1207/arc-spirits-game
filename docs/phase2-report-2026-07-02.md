# Phase 2 Report — The Superhuman Push (2026-07-02, evening session)

Follow-up to docs/campaign-report-2026-07-02.md. Plan: `~/.claude/plans/
ok-can-you-take-happy-quail.md` (research-driven phases A–F). Every phase ran
to a falsifiable verdict in one session.

## Headline

**The fair gen-24 champion survived everything.** Four independent improvement
mechanisms and a 10×-budget adversary all returned verdicts in its favor. It
now holds the strongest certification this machinery can issue, and the
evidence points to it sitting at the practical optimum for the current rules.

## Phase verdicts

| Phase | Result |
|---|---|
| A — Throughput | **Done.** League data phase 102s→~14s per 960 champion games (concurrent matchup pools, worker-import amortization). Sharded gauntlet: 800 games in ~2 min with digit-exact Elo parity (validated on two candidates). |
| B — Play-time search | **Negative, diagnosed.** Gumbel-16 in 4 configs: 570–643 Elo vs argmax 1014. Nav mixing exonerated (T0 ≈ T0.8); heuristic-rollout leaves are biased against the PvP line (VP 29.8→20); self-model rollouts recover half the gap (643) but small-budget Q noise still loses to the converged policy. Expert tier ships opt-in (`ARC_EXPERT_BOTS=1`), off by default. |
| C — Expert iteration | **Flat at two budgets.** Round 1 (16 sims @ 25% of strategic decisions, 21 gens): 515/506/503/503/501 vs bar 550. Round 2 (64 sims @ 8%, 12 gens): 497/498/498. Stable, zero drift, zero gain. Search-derived targets cannot improve this policy. |
| D — Exploiter at scale | **Champion PASS at −676.** Fresh 40-gen league-exploiter (256 games/gen, 10× the prior budget): 1.96% pairwise over 400 verdict games. More budget made the exploiter *relatively worse* (−655 @ 16 gens → −676 @ 40). |
| F — Certification suite | **Assembled + run** (scripts/certify-champion.sh). Gauntlet-v3 rebaseline 525/85.4%/29.1 · exploiter PASS −676 · 2v1 collusion PASS (0.98 vs 0.99 seat-score, no coordinated-pair vulnerability) · mirror sanity: see finding below. Human layers pending. |

Phase E (v2 transformer retry) stays gated-closed: nothing in today's evidence
suggests capacity is the binding constraint.

## New instruments (all committed on ml-bot-pipeline)

- `gauntlet-v3` — champion added to the anchor pool; v2 was saturated (99% win
  = no headroom to measure post-champion progress). New scale: champion = 525.
- Sharded gauntlet (`GAUNTLET_SHARD` + `scripts/fast-gauntlet.sh` +
  `merge-gauntlet-shards.mjs`) and sharded league promotion
  (`scripts/league-gauntlet.sh`).
- Concurrent league matchup pools (`matchupConcurrency`).
- `gumbelPlanner.ts` — Gumbel root search, full-seat determinization,
  info-safe (invariance-tested), self-model rollouts.
- ExIt plumbing end-to-end: driver `searcher` → recorded `pi` → mode
  alphazero. League config `search` block.
- PPO: `--kl-ref-coef` (piKL anchor), `--lr-schedule cosine`; v1 placement
  aux head (4-way CE) exported/loaded across the stack.
- `scripts/certify-champion.sh` — gauntlet + exploiter + collusion + mirror
  in one report.

## Design finding for Michael (mirror probe)

Champion-vs-champion ×4: **seat 1 wins 44.5%** (symmetric would be 25%);
seat-score 0.707. At equal skill, acting first + the seat-order tiebreak is a
large structural advantage. Worth a look alongside the corruption rebalance —
e.g., rotating start seat per round, or a VP tiebreak that doesn't default to
seat order.

## Interpretation and what's genuinely left

Internal self-improvement is exhausted at current budgets: the champion is a
fixed point of every trainer we have under the current rules. What remains is
*external* pressure:

1. **Michael's 20 games** (stop-condition a) — the market exploit proved human
   play sees what internal metrics cannot. Dev server + `ARC_EXPERT_BOTS=1`
   available for the search tier.
2. **BC-of-Michael + response training** once his game logs exist.
3. **The rebalance decision** — the pipeline retrains under new rules with one
   config flip; the corruption attractor and the seat-order edge are the two
   documented levers.
4. (Cheap, optional) an independently-seeded from-scratch league to confirm
   the 1014-line reproduces across populations — convention-drift check.

## Records

- `ml/gauntlet_results/probe-scaled-40gen.json` — the −676 PASS.
- `ml/league_exit_round1_history.jsonl`, `ml/league_exit_round2_config.json`.
- Box gauntlet history (`/tmp/arc-bot/league/ml/gauntlet_results/history.jsonl`)
  carries all v3 promotion checks; volatile-box artifacts pulled and committed
  per milestone discipline.
