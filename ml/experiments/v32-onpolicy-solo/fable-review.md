# Claude Fable high-effort review

Reviewed `plan.md` on 2026-07-14 before V32 optimizer creation. The reviewer judged the fail-closed structure, seed hygiene, matched arms, frozen decision protocol, and stop rules strong, and identified these material gaps:

1. Specify whether temperature-0.55 rollouts are genuinely on policy and audit reconstruction of the exact tempered acting distribution.
2. Verify that the proposed late-round row quota is feasible; do not make weak policies fail simply because late rows are unavailable.
3. Add a policy-movement manipulation check so a very conservative, underdosed null is not misclassified as evidence against the mechanism; consider more generations.
4. Specify the reach-30 advantage blend's scale/normalization order, strategic-decision definition, and held-out calibration surface.
5. Distinguish the reach-30 critic-loss coefficient from the reach-30 policy-credit coefficient.
6. Use a third replicate or explicitly acknowledge that two replicates have poor power for a +3-point effect.
7. Resolve the contradictory phrase “byte-identical ... tolerance 1e-6,” test policy-invariant shaping at the configured gamma, and define the finalist latency measurement.

All seven points are incorporated in the reviewed draft. In particular, empirical V30 row counts caused the late-row quota to be replaced by normalized round-dependent policy-loss weights, three replicates and an outcome-blind dose extension were added, and critic warm-up now freezes every trunk/policy parameter.
