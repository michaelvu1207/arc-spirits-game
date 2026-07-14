# V34 strength-tooling amendment

Status: draft; all Phase 2, guardian, teacher, final, multiplayer, human, and promotion seeds remain
operationally closed until the corresponding immutable authorization and tooling lock exist.

## Why this amendment exists

The first V34 source lock freezes calibration and systems screening. It intentionally does not hash
future Phase 2, guardian, teacher, or qualification tooling. `phase2-authorization.json` is therefore
necessary but not sufficient to run strength games. Before seed `957000000` is touched, add a second
strength-tooling lock that binds the original source lock, systems evidence, this reviewed amendment,
the amended protocol, every runner/analyzer/test, the live catalog, and each served checkpoint.

## Phase 2 execution contract

- Require a valid original source-lock -> preflight -> preview calibration -> systems authorization
  -> systems eligibility -> Phase 2 authorization hash chain.
- Run raw plus every systems-eligible registered arm on exactly seeds `957000000..957004095`.
  Systems-rejected registered slots remain failed slots in the frozen six-arm family; they are never
  silently removed from multiplicity accounting.
- Freeze raw at 24 workers. Use each candidate's systems-selected worker count. Use only currently
  free GPUs from the protocol's `[0, 5, 6, 7]`, never GPU 4, and never exceed 96 actor workers; the
  present host allocation uses GPUs 5, 6, and 7 because GPU 0 is occupied by CARLA. If an eligible
  GPU is occupied, wait or reduce the wave rather than sharing it without evidence.
- Freeze the V34 common decode exactly: one seat, round cap 30, max status 2, hybrid sampled policy,
  temperature 0.55, absolute-balanced guardians, obs-v2 policy, binary inference, the frozen
  checkpoint/catalog, and the arm parameters recorded in the protocol.
- Treat raw as a full condition subject to every completion, retry, abort, and provenance rule.
  Store one immutable complete report per condition with all 4,096 per-seed summaries, inference
  provenance, cycle metrics, guardian identity, strategic telemetry, and wall time. Reports must have
  exact seed coverage and one row per seed. No strength statistic is read until every scheduled
  condition has a complete report.
- One identical-seed infrastructure retry is allowed per condition. Before retry launch, write an
  immutable justification using only error/operational telemetry; attempts are never spliced and
  outcome-triggered retries are forbidden. A missing, duplicate, stalled, malformed, condition-level
  provenance-mismatched, or replay-mismatched report aborts analysis. A valid complete report that
  contains an explicitly counted per-decision safety/provenance failure makes that arm fail its gate.
- `stalled` means `GameSummary.stalled === true`; its allowed count is zero. Preflight must prove at
  least 16 GiB scratch headroom and enough persistent headroom for every immutable condition report.

## Frozen simultaneous Phase 2 statistic

For candidate `j` and seed `i`, calculate paired candidate-minus-raw differences for:

1. win by round 30 in percentage points;
2. final VP;
3. post-round-15 VP per round;
4. censored first round reaching 30 VP, where failure is round 31 and lower is better.

Use complete-seed cluster resampling with 10,000 draws from `numpy.random.Generator(PCG64(34022026))`.
Pin and record the exact Python and NumPy versions in the strength lock. For draw `b`, endpoint `e`,
observed mean `m_e`, bootstrap mean `m_be`, and original paired standard error `se_e`, compute
`t_be = (m_be - m_e) / se_e`, then `T_b = max_e(abs(t_be))`. Exclude zero-standard-error endpoints
from `T_b`; they pass only when their point estimate satisfies the gate. The two-sided simultaneous
critical value is the 95th nearest-rank quantile of the 10,000 `T_b` values, with a conservative floor of
`NormalDist().inv_cdf(1 - 0.05 / (2 * 24))`. This Bonferroni-normal floor preserves the preregistered
24-endpoint penalty when systems-rejected slots have no strength observations. Zero-standard-error
endpoints pass only when their point estimate satisfies the gate; otherwise they fail closed.

An arm is a Phase 2 core pass only when all original gates hold: win gain at least +3 points and its
simultaneous lower bound strictly above 0; final-VP and post-15-rate lower bounds at least 0; censored
round-to-30 upper bound at most 0; binding latency still valid; and zero stalls, information failures,
  replay mismatches, serving failures, or per-decision provenance mismatches. Core pass does not select a winner.
If no arm passes, close Lane A and continue Lane B from raw. If one or more pass, emit an immutable
guardian authorization naming every passing arm and no others.

This family is intentionally conservative: at the 24-endpoint critical floor, Phase 2 is expected to
reliably detect roughly +5 to +6 win-rate points rather than an arm exactly at the +3 point boundary.
A null result closes Lane A; it is not evidence that smaller benefits are impossible.

## Guardian confirmation contract

- Amend the protocol before guardian seeds open with the exact guardian order derived and hash-bound
  from the frozen catalog (currently):
  Bubblepop, Embers, Fjorn, Human Avatar, Lumina, Myrtle, Pixia, Prox, Taron, Void Avatar.
- Run raw and every Phase 2 core-pass arm on exactly seeds `957300000..957308191`, using only this
  independent range and the same decode/serving contract. Do not pool Phase 2 outcomes.
- Guardian assignment must be a deterministic function of engine seed alone, independent of arm,
  worker, GPU, or execution order. For each arm and guardian, pair win indicators on identical seeds;
  verify every condition maps each seed to the same guardian and balanced counts differ by at most one.
- Use 10,000 complete-seed cluster draws from `PCG64(34032026)`. Build one-sided simultaneous 95%
  lower bounds across every core-pass-arm by guardian comparison. Use the empirical centered max
  loss statistic with a conservative floor `NormalDist().inv_cdf(1 - 0.05 / 60)`, preserving the
  maximum six-arm by ten-guardian family even if fewer arms reach confirmation.
- Every guardian comparison must have point delta at least -5 percentage points and simultaneous
  lower bound strictly above -10 points, with zero stalls/safety/provenance failures.
- Reject every arm that fails any guardian cell. Among the surviving arms, freeze exactly one unchanged
  online arm by largest Phase 2 paired win gain, then lower 8-worker binding p95, then lexicographically
  smaller arm id. If the Phase 2 leader fails guardian confirmation, the highest-ranked surviving arm
  advances; guardian outcomes never reorder survivors. If none survive, close Lane A.

The unadjusted guardian point gate is deliberately conservative and may falsely reject a neutral arm
across as many as 60 cells; the project accepts that cost rather than weakening the preregistered gate.
Systems binding evidence remains valid only when its source/report hashes still match. Phase 2 and
guardian runs also record per-decision latency as non-binding regression telemetry.

## Required implementation before Phase 2

1. Amend and validate `protocol.json` with the statistical definitions, raw worker count, guardian
   names, guardian RNG/family, attempt rules, and a second-lock requirement.
2. Implement `run-v34-phase2-screen.sh`, `analyze_v34_phase2.py`, and adversarial synthetic tests.
3. Implement Phase 2 authorization verification and a strength-tooling lock whose commit must be an
   ancestor of the executing tree and whose file hashes must match at launch and analysis.
4. Implement `run-v34-guardian-confirmation.sh`, `analyze_v34_guardian.py`, and synthetic tests before
   any guardian authorization can be consumed.
5. Test exact arms/parameters, seed coverage, report schemas, seed-only guardian assignment, pair
   alignment, max-stat reproducibility under the pinned Python/NumPy versions,
   ghost-slot penalty, zero-variance behavior, malformed/missing attempt handling, stalls, and every
   provenance/hash link.
6. Run the full preflight again on SimForge and source-lock the tooling before strength games.

## Lane B and later gates

Do not treat Phase 2 tooling as permission to consume teacher seeds. Lane B needs a separate frozen
teacher-data and training contract: exact 100k snapshot bands, information-safe replayable snapshot
schema, offline search, disagreement/entropy gates, fixed generation-0 replay anchor, PPO/distillation,
generation advancement, multiplayer canary, width comparison, and composition transfer. Likewise,
final development/hidden, multiplayer/exploiter, Michael replay/live, and promotion each require
their own fail-closed runners and authorizations. Hidden and production-promotion flags remain false
until every preceding artifact and gate verifies.
