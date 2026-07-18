# Fable review of V34 strength-tooling amendment

Reviewer: Claude Fable, high effort, read-only. Review completed before strength-tooling lock.

The review accepted the fail-closed second-lock design, fixed RNG seeds, conservative ghost-slot
penalty, and overall approach, then identified ambiguities to resolve before strength seeds:

1. Define selection when the Phase 2 leader fails guardian confirmation.
2. Separate report-level provenance corruption (abort) from counted per-decision failures (arm fail).
3. Specify the exact per-draw studentized max statistic and zero-standard-error handling.
4. Require seed-only guardian assignment and catalog-derived, hash-bound guardian order.
5. Pin Python/NumPy versions and exact reproducibility fixtures.
6. Acknowledge Phase 2 power near the +3-point boundary and guardian false-rejection cost.
7. Reconcile GPU availability with the protocol, name the 8-worker latency tie-break, apply every rule
   to raw, define stalls, write retry justification before retry, and gate disk/scratch headroom.

All items were incorporated into `strength-tooling-plan.md`. The review did not authorize any seed
range or production promotion.
