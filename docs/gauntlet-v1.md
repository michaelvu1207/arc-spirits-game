# Gauntlet v1 — the frozen bot-strength measure

`gauntlet-v1` is the ONE fixed evaluation for Arc Spirits bots. It exists to end
moving-metric drift: every candidate — heuristic or neural, today or months from now —
is scored on the exact same games against the exact same anchors, so numbers are
comparable across time.

Spec as code: `src/lib/play/ml/gauntlet/manifest.ts`. Runner:
`src/lib/play/ml/gauntlet/_gauntlet.test.ts`.

## What is frozen

- **Seeds**: 200 base seeds (`9_000_000..9_000_199`) × 4 seat rotations = 800 paired
  games. The engine seed is shared across a base seed's 4 rotations; only the
  candidate's seat changes.
- **Anchor pool** (10 active):
  - 8 heuristic profiles: `medium`, `hard`, `insane`, `survivor`, `cultivator`,
    `rushpatient`, `paragon`, `pvphunter`. (`insane` was chosen over `godly` as the
    search-tier ceiling: godly's doubled rollout budget roughly doubled full-gauntlet
    wall-clock for near-zero extra discrimination.)
  - 2 checkpoints (the strongest 62/52 nets at freeze time, 2026-07-01):
    `traceq-damage-nearmiss` =
    `ml/meta_runs/traceq-damage-nearmiss-vp28-29-20260630T053132Z/best_policy.json`
    (also shipped as the live `policy-weights.json`, byte-identical at freeze — the
    gauntlet pins the immutable meta_runs path, and the live copy is deliberately not
    a separate anchor) and `routeexecq-shared-allseat` =
    `ml/meta_runs/routeexecq-shared-allseat-candidate-20260701Ttrain/best_policy.json`.
  - Recorded but NOT scoreable: `act52-full-g6` (obs_dim 55, dim-incompatible with the
    62-dim encoder). It stays in the manifest for auditability.
- **Fields**: each base seed gets 3 distinct anchors drawn by a fixed-seed partial
  Fisher–Yates — the same fields every run, forever.
- **Rules**: 4p FFA, `maxRounds=120`, placement by final VP (ties share the better
  place), a *win* = actually reaching the 30-VP target (engine `winnerSeat`).
- **Scoring**: Elo vs each anchor is the closed-form logistic conversion of the
  pairwise placement score (Laplace-smoothed), independent of game order. The headline
  number is the aggregate Elo over all anchor encounters.

## The versioning rule

**Any change to any of the above requires a bump to `gauntlet-v2`** — new directory,
new version string, and a full re-baseline of every tracked bot. This includes
"harmless" changes: a different anchor, more seeds, a maxRounds tweak, a scoring
refinement, or an engine/balance change that alters game outcomes. If in doubt, bump.
Scores from different gauntlet versions must never appear in the same comparison
without being labeled.

Smoke runs (`GAUNTLET_GAMES < 800`) are marked `smoke: true` in the result JSON and
are for plumbing checks only — never quote them as gauntlet scores.

## How to run

```bash
# a weights candidate (must match the current 62/52 encoder contract)
GAUNTLET=1 GAUNTLET_WEIGHTS=path/to/policy.json \
  npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts --disable-console-intercept

# a SERVED candidate (ml/infer_server.py socket) — e.g. an arc-entity-scorer-v2
# checkpoint scored DIRECTLY, no distilled proxy; anchors stay in-process v1
GAUNTLET=1 GAUNTLET_INFER_SOCKET=/tmp/arc-infer.sock GAUNTLET_POLICY_OBS_VERSION=2 \
  npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts --disable-console-intercept

# a heuristic candidate (any BOT_PROFILES name)
GAUNTLET=1 GAUNTLET_PROFILE=pvphunter \
  npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts --disable-console-intercept

# smoke (multiples of 4 keep seed pairs intact)
GAUNTLET=1 GAUNTLET_GAMES=8 GAUNTLET_WEIGHTS=src/lib/play/ml/policy-weights.json \
  npx vitest run src/lib/play/ml/gauntlet/_gauntlet.test.ts --disable-console-intercept
```

Results land in `ml/gauntlet_results/<candidate-slug>.json`
(`GAUNTLET_OUT` overrides).

## Results table

| Candidate | Kind | Gauntlet Elo | Mean place | Win rate | Mean VP | Games | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| _example: ml--policy-weights_ | weights | — | — | — | — | 800 | — | — |

Append full-800 runs only. Keep the JSON files; this table is the human-readable
ledger.

## Changelog (transport/runner only — the frozen measure has never changed)

- **2026-07-02 — socket candidates.** The runner accepts
  `GAUNTLET_INFER_SOCKET=<path>` (+ `GAUNTLET_POLICY_OBS_VERSION=2` for
  arc-entity-scorer-v2 checkpoints): the candidate plays through `RemotePolicy`
  exactly as the actor pool does, so served v2 nets are scored DIRECTLY instead of
  via a distilled v1 proxy. Seeds, anchors, rules, and scoring are untouched — this
  is a transport addition, not a measure change, hence no version bump. Result JSON
  gains `via: 'socket' | 'in-process'` and `policyObsVersion`, and socket runs record
  the SERVER-reported checkpoint path as `candidate.ref` — never compare a
  `via: 'socket'` score with a distilled-proxy score of "the same" checkpoint without
  labeling both.

## gauntlet-v2 (2026-07-02)
Version bumped because the RULES changed under the measure (rules v1.1: market
command family closed — docs/rules-v1.1.md). Seeds, anchor pool, and metric are
UNCHANGED from v1. v1 numbers (incl. the 221 baseline, 268/287 champions, and
the 920/1056 rediscovery scores) measured the exploitable ruleset and are not
comparable to v2 numbers. First v2 baselines: see ml/gauntlet_results/ entries
with gauntletVersion gauntlet-v2.
