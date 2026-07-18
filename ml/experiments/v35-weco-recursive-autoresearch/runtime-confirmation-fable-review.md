# Claude Fable high-effort review: V35 runtime confirmation

Command:

```text
claude -p --model fable --effort high --tools "Read" --no-session-persistence "Review the plan at /Users/maikyon/Documents/Programming/ArcSpirits/arc-spirits-game/ml/experiments/v35-weco-recursive-autoresearch/runtime-confirmation-plan.md. Identify important gaps, risks, and concrete improvements. Be concise."
```

Exit code: `0`

## Findings

Fable judged the plan disciplined and the parity-first sequence sound, then identified seven material gaps:

1. The champion's roughly 19-times development latency makes a 1.25-times-baseline gate structurally unlikely to pass when R1 intentionally preserves search allocation. Add a cheap latency-only precheck and decide the latency contract before consuming fresh seeds.
2. A fixed 8,192 pairs plus an observed-effect threshold and roughly ten conjunctive gates lacks a full pass-power calculation. Power-size the conjunction; the corrected lower bound should carry the inferential burden. Keeping Bonferroni after fresh-seed selection is conservative and must be deliberate.
3. Pin the actual repaired-runtime commit and re-verify candidate/checkpoint hashes instead of confirming a dirty tree relative to `0239cb8`.
4. Bit-identical same-batch output and operational batching sweeps are different claims. Define R2 parity over selected actions/replay hashes and pin the CUDA environment.
5. State explicitly that 8,192 paired seeds means 16,384 games, and project wall time/disk before launch.
6. Define a signed, missing-pair-only resume protocol rather than burning a block on an infrastructure interruption.
7. Enumerate/hash guardians, define complexity units, and commit a complete seed ledger rather than leaving those terms open.

All seven findings are incorporated into the amended plan. No outcome-bearing evaluation was launched as part of the review.
