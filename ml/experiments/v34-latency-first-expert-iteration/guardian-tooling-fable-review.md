# Fable review of V34 guardian tooling plan

Review command:

```bash
claude -p --model fable --effort high --tools "Read" --no-session-persistence \
  "Review the plan at ml/experiments/v34-latency-first-expert-iteration/guardian-tooling-plan.md. Identify important gaps, risks, and concrete improvements. Be concise."
```

The review was performed before any Phase 2 outcome was inspected.

## Verdict

The plan is consistent with the frozen guardian section of `strength-protocol.json`: seeds,
guardians, gates, fixed-family floor, RNG seed, and ranking rule all match. The lock layering is sound.
Fable found one statistical defect, one launch-blocking assumption to verify, and several ambiguities
that must be pinned before the tooling lock.

## Required corrections

1. The one-sided bootstrap sign was reversed. A simultaneous lower confidence bound needs the critical
   value from `(bootstrap_mean - observed_mean) / SE`, followed by
   `observed_mean - critical * SE`. The two-sided Phase 2 absolute statistic hid this distinction.
2. `seed % 10` must be proved from the source-locked engine and evaluator before locking. It cannot
   merely be asserted by a fixture that duplicates the planned formula.
3. Post-abort recovery semantics must be explicit. The plan needs to say whether consumed guardian
   seeds permanently close Lane A or whether a separately preregistered recovery family exists.
4. Pin paired SE as sample standard deviation with a specific `ddof` divided by `sqrt(n)`.
5. An empty sampled cell should be a structural analysis abort.
6. Quantify the false-closure risk of the frozen unadjusted -5-point cell gate under realistic paired
   disagreement rates so a conservative closure is not misreported as proof of regression.
7. Candidate non-stall safety/provenance faults escalating to a whole-gate abort are a deliberate
   strictification of the per-arm wording and should be recorded as such.
8. Resource checks must occur before attempt creation so a busy shared host does not consume an
   attempt.
9. The guardian chain must declare the new artifacts authoritative because the immutable historical
   strength protocol permanently retains closed seed flags and `guardianResult: null`.

## Answers to the plan questions

- Global complete-seed resampling best matches the committed language; do not stratify by guardian.
- Candidate measured-stall rejection and raw-stall whole-gate abort are consistent and fail-closed,
  provided infrastructure failures cannot masquerade as stalls.
- The 64-seed, eight-worker same-process replay is a valid carry-over of the Phase 2 serving contract.
- Pre-outcome tooling lock plus post-authorization execution lock is sound.
- Empirical maximum over observed cells plus the fixed-60 normal floor is valid and conservative; the
  floor is expected to dominate in realistic cases.
- The watchdog and storage thresholds are sound. The RAM gate must not consume an attempt when it
  fails before launch.
- K=0 semantics are clear; missing/malformed-condition triggers were clear, but their irreversible
  consequence needed to be stated.

## Disposition

All required corrections were incorporated into `guardian-tooling-plan.md` before guardian
implementation began. Since the frozen protocol contains no reserve guardian range, a structural fault
after registered guardian-seed consumption closes Lane A and routes the program to Lane B from raw.

## Amended-plan re-review

A second fresh Fable high-effort review confirmed that all nine required corrections above were
resolved. It found no statistical or runner-design blocker. It requested two final clarifications:

1. Explicitly record candidate non-stall safety/provenance whole-gate abort as a deliberate
   strictification of the frozen per-arm wording.
2. State that the experiment has exactly one shared raw condition plus `K` candidates, with raw run
   once and paired against every authorized arm.

Both clarifications were added before implementation. Fable confirmed the nearest-rank index,
fixed-60 floor, zero-SE semantics, K=0 closure, retry inventory, and same-process replay are internally
consistent with the frozen protocol.
