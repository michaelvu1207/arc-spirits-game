# Claude Fable high-effort plan review

Command:

`claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/plan.md. Identify important gaps, risks, and concrete improvements. Be concise."`

Exit code: `0`

The plan is unusually rigorous on integrity (freezing, signing, blinding, one-shot authorizations) — the gaps are mostly where that rigor collides with operational reality or leaves the scientific comparison underspecified. Findings in rough priority order:

1. No survivable failure path in Phase 2. The campaign has roughly 432 GPU runs plus 108 evaluations, so a blanket no-recovery rule makes infrastructure closure likely. Freeze a bounded, outcome-blind recovery policy for enumerated infrastructure failures, using fresh tokens, incident receipts, identical seeds, and guardian approval.
2. Uniform versus late-scheduled may be dose-confounded. Either match cumulative dose or explicitly scope the claim to schedule and dose jointly.
3. Confirm the power artifact covers the conjunction of Holm inference and hard point/replicate gates, not the sign-flip test alone.
4. Add exact-stack bitwise CUDA replay determinism to preflight and freeze the consequence of mismatch.
5. Rehearse the one-shot analyzer end to end on a synthetic or label-shuffled manifest.
6. Freeze the exact eligibility boolean and deterministic tie-break if both treatments pass.
7. Use the running maximum of observed outcome-blind bytes and runtime at generation boundaries; generation-one replicate-a extrapolation can understate later costs.
8. Freeze sample sizes and decision rules for fresh confirmation and Michael gates.

The review also recommended recomputing the Wilson bound from frozen parameters instead of trusting only a literal, and confirming all 18 replicate proposal trees are source-locked. It verified the basic arithmetic: 18 replicates, 3 arms, 54 chains, 108 evaluations, and 262,144 exact sign assignments.

Disposition: all eight substantive findings were incorporated into `plan.md`. Implementation and a final explicit acceptance review remain required before authorization.

## Second review after custody and recovery hardening

The same prescribed command was rerun after implementing the bounded recovery,
local review-attester, executor launch-permit, durable signing-reservation, and
one-shot analyzer boundaries. Exit code: `0`.

Fable verified that the receipt/token arithmetic, Wilson threshold (6,631 of
8,192), Michael threshold (15 of 20), and 262,144 exact sign assignments are
correct. It found the integrity machinery unusually thorough, then identified
these remaining pre-authorization gaps:

1. Quantitative confirmation thresholds were not frozen for every Phase 5 gate.
2. Completed model-quality divergence versus infrastructure failure needed an
   explicit non-retry classification.
3. Endogenous realized reach-30 dose needed sealed per-arm telemetry.
4. Phase 1 needed a frozen duration/cost go/no-go threshold.
5. Pre-seed review amendment and re-review policy was ambiguous.
6. Long campaign closure remained brittle under storage/runtime failures.
7. The one-shot analyzer and local review launch were maximum-sunk-cost single
   points of failure.
8. The Michael gate is intentionally high-power only for a very strong bot, and
   the P30 planning-effect power margin needs sensitivity context.
9. CUDA replay determinism must use the exact production hardware, driver,
   runtime, and batch shapes.
10. Shared-storage headroom needs reservation plus a growth allowance, and the
    fault matrix needs ENOSPC, clock-skew, and custody-host-death cases.

Disposition: review findings are being incorporated before the final explicit
`VERDICT: ACCEPT` review. This artifact is evidence of review, not launch
authorization.
