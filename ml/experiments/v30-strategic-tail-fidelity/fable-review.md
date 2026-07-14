# Claude Fable review — V30 strategic-tail fidelity

The design is sound overall: fresh disjoint splits, doubled selection/gate halves, a mean-only control, one-shot gate discipline, and useful equivalence/gradient tests.

Important improvements:

1. Do not early-stop or rank on strategic p99 KL. V29 selected at 0.383 and gated at 0.556; selecting p99 across epochs and arms compounds tail-estimator noise and winner's curse. Use strategic CVaR@5% or p95 for selection and report p99 separately.
2. Add a selection safety margin. Requiring selection p99 only to equal the 0.5 gate threshold is too weak; require about 0.40–0.45 or a bootstrap upper bound below 0.5.
3. Minibatch CVaR is noisy because a 512-row batch has only about 128 strategic rows. Log realized strategic counts and top-k sizes; stratified batching is optional.
4. Assert that fresh generation settings exactly match V27's existing training block before merging them.
5. Add a stronger CVaR coefficient arm so a null result distinguishes an ineffective objective from an underweighted one.
6. Pin all stochastic seeds, not only row order.
7. Add an informational bootstrap interval for strategic p99 after the one-shot gate, without using it for the decision.
8. Include round 23–30 metrics in the gate artifact because late-game performance is the eventual target.

The doubled-data mean-control arm is the correct primary control because the V29 failure is at least as consistent with inadequate trajectory coverage as with loss shaping. Prefer it under a robust tie rule and do not let a CVaR treatment win on a noisy tail estimate.
