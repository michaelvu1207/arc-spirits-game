# Claude Fable re-review of the V34 Lane B collector

Model: Claude Fable

Effort: high

Date: 2026-07-14

Scope: outcome-blind re-review after the two attempt-1 blockers. No experiment
outcome, Phase 2 result, replay result, target shard, or held-out artifact was
opened.

## Verdict

One remaining blocking gap; all other reviewed areas passed.

The option-head result retained its independent `samplingSeed` for audit
provenance, but the complete option object was also passed into the subsequent
decision policy context. That exposed a value derived from the source game seed
and option ordinal to the model. Fable required stripping `samplingSeed` from
the policy-context copy while retaining it in the feature row, plus a focused
test.

## Verified fixes

- Per-game bounded runs and deterministic 128-way merge passes removed the
  scale blocker and the multi-level merge is tested.
- Hash-bearing ordering is locale-independent.
- Forced closure and structural hashes use the complete legal-action set; the
  status cap affects selection support only.
- Config, policy binding, live checkpoint, provider module, and trace-prefix
  provenance are bound and rechecked.
- Terminal-candidate exclusion and prefix-only teacher loading are ratified in
  the closed protocol.
- Sample-mode determinism and target-deletion invariance are exercised.

## Disposition

The option-context leak and its missing assertion were fixed immediately. No
density smoke or registered seed was authorized by this review.
