# V35 Runtime Parity Execution — Claude Fable Review

Date: 2026-07-15

Command:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at ml/experiments/v35-weco-recursive-autoresearch/runtime-parity-execution-plan.md ..."
```

## Initial verdict: REJECT

Fable accepted the exact per-seed trace comparison as a valid safe-direction
test, but identified six enforcement gaps:

1. the trusted comparator was not itself hash-bound;
2. evaluator/server output was not explicitly forbidden from reaching a TTY;
3. the GPU lease was not backed by UUID-form `CUDA_VISIBLE_DEVICES` masking;
4. asynchronous batching could make a failure ambiguous without an
   intra-runtime control;
5. the four required cross-runtime and within-runtime comparisons were not
   enumerated;
6. the timing-free trace schema was implicit rather than an explicit,
   mechanically hash-bound contract.

## Corrections

The plan now binds the comparator, redirects all outcome-bearing output at
spawn, masks every process to the physical GPU-7 UUID, records one-visible-GPU
environment evidence, compares functional and operational traces within both
runtimes on eight shared seeds, enumerates all four pairings, and specifies the
trace event schema and excluded timing/outcome fields. It also requires a
complete archive-diff allowlist and per-game seed-derived RNG.

## Final verdict: ACCEPT

On re-review, Fable confirmed all six blocking gaps were closed and found no
remaining blocking fix. Passing this preflight can authorize only the separate
public outcome-blind latency precheck; it is not strength or promotion evidence.
