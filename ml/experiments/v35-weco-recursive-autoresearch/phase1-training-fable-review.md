# Claude Fable high-effort review: V35 Phase 1 training

Date: 2026-07-14

The reviewer verified that the V35 public evidence cited by the plan matches the saved artifacts and
found the plan strong overall, but required these concrete corrections before seed consumption:

1. Add a non-regression gate against the frozen V2 base, not only the matched PPO control.
2. Preselect a single replicate checkpoint with the V32 outcome-blind symmetric-KL medoid rule.
3. Make any generation-12 extension global across all nine roots and make generation 12 the sole endpoint.
4. Freeze the mechanical definitions for row sampling, band normalization, weighted telemetry,
   engine-cycle decisions, and calibrated reach-30 residual credit; disambiguate head loss from policy
   credit and add reach-30 ECE/Brier gates.
5. Freeze code/config/environment hashes and define whole-generation infrastructure resume semantics.
6. Pin the guardian follow-up, status-3 comparators, quick-eval game count, and nonoverlapping seed math.
7. State that the single P30 dose is one-shot, inference is conditional on realized roots, near-boundary
   false negatives are accepted, and a second semantic/LR retry is not allowed unless preregistered.

All requested changes are incorporated in `phase1-training-plan.md`. No training seed was consumed while
the review was pending.

## Final re-review

Verdict: **PASS**.

Fable confirmed that all seven prior corrections are resolved: frozen-base gates, outcome-blind medoid
selection, a global sole generation-12 endpoint, mechanical row/weight/credit/calibration definitions,
code/config/environment freezing and whole-generation resume semantics, pinned guardian/status/seed
contracts, and one-shot/no-post-hoc-retry commitments. It found no new blocking gap.
