# Claude Fable review of the V34 Lane B collector, attempt 1

Model: Claude Fable

Effort: high

Date: 2026-07-14

Scope: outcome-blind review of the Lane B plan, closed execution protocol,
collector, collector tests, snapshot primitives, and quota freezer. No experiment
outcome, Phase 2 result, replay result, target shard, or held-out artifact was
opened.

## Verdict

Two blocking gaps; all other reviewed areas passed.

1. The collector accumulated every feature and target row in memory and built
   each complete output shard as one JavaScript string. This was not viable for
   the 512-game density smoke or a 4,096-game generation. Fable required
   per-game or bounded runs plus a deterministic multi-shard merge.
2. Hash-bearing arrays and row ordering used `localeCompare`, making structural
   hashes and deduplication dependent on the Node/ICU build. Fable required
   locale-independent code-unit ordering before any registered execution.

## Non-blocking items to bind or test

- Ratify the fail-closed exclusion of choices containing an immediately
  terminal candidate.
- Bind the exact raw-policy selector semantics, including immediate win/VP
  guards, status-cap escape behavior, and filtered-support probabilities.
- Make trace-prefix verification directly check the feature's policy-config
  hash.
- Exercise sampled selection, not only argmax.
- Require B2 teacher tooling to load only the bound trace prefix even though the
  collection stores a complete per-game trace shard.

Fable otherwise accepted the current information separation, redacted policy
previews, full legal-action reconstruction, recovery precedence, PCG64 quota
selection, atomic new-only publication, and the real-engine/synthetic-freezer
tests.

## Disposition

This review did not authorize a density smoke or any registered seed. The two
blocking gaps and the inexpensive config-hash/sample-mode requests are being
fixed before a second Fable review.
