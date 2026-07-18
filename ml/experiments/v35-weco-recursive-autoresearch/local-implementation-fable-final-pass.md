# Fable high review: V35 local/private implementation, attempt 2

Date: 2026-07-14

Verdict: **PASS**

Supersedes: `local-implementation-fable-review-attempt1.md`

Fable verified that the corrected plan now has:

- no hosted autoresearch path or unresolved implementation decision;
- an out-of-process, action-index-only candidate sandbox while the trusted process owns legality, RNG,
  replay production, timing, scoring, and signing;
- sealed seed derivation, a ten-query immutable private broker, fixed private scheduling, and no
  candidate-visible private cache;
- chained signatures over replay, evaluator/engine, seed-family commitment, candidate, cost ledger, and
  previous-ledger hashes with a mode-0600 key outside worker mounts;
- a hard GPU-7 lease and fail-closed rejection of every other device, plus sequential tenant scrubbing;
- terminal-dominant late-game scoring, snapshot/full-game correlation calibration, champion snapshot
  regeneration, and an engine-hoarding attack;
- one measured local CPU/GPU cost currency and identical infrastructure for all optimizer baselines;
- at least three rejection-memory-isolated, disjoint-seed, bootstrap/Holm-corrected Phase 4 pairs with the
  evolved researcher sandboxed behind the same private broker;
- technical human-only promotion credentials/final result custody and mandatory campaign invalidation,
  seed/key rotation, incident preservation, and re-audit after a leak or tamper event.

Fable concluded there were no remaining blockers to implementation.

PASS
