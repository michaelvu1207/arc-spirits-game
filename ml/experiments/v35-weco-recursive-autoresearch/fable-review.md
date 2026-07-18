# Claude Fable Review

Model: `fable`

Effort: `high`

Date: 2026-07-14

The plan is strong on safety boundaries and evaluation discipline. The important
gaps are mostly in the statistics and in a few places where the hardest design work
is deferred with a hand-wave.

## Most important gaps

1. **Private-tier reuse across campaigns will overfit selection.** Phase 2 runs 3
   campaigns × 50–100 steps against the same private tier, and the "2 of 3 campaigns
   positive" gate treats them as independent — they aren't if they share seeds. Also,
   picking the best of many lineages inflates the lower confidence bound (winner's
   curse). Concrete fix: quantify the private query cap (a number, not "strict"),
   rotate private seed families between campaigns, and require a one-shot confirmation
   run on fresh private seeds for any selected finalist before it counts toward a gate.

2. **The scalar surrogate is the hardest part and it's deferred.** "Define a monotone
   encoding whose priority order cannot be reversed" is genuinely difficult —
   lexicographic-into-one-float composites are brittle and hackable. Simpler and safer:
   hard gates for feasibility + one primary metric as the scalar (e.g., late-game-
   weighted win-rate LCB), everything else a gate. Relatedly, the plan's stated first
   target is late-game play, but the dev signal the optimizer actually sees is
   dominated by solo round-35 win rate — the exact metric the plan warns will
   rediscover early-VP strategies. Fix: build the public/dev tier primarily from
   round-15+ snapshot tasks so the iteration signal _is_ late-game performance, with
   overall win-rate as a non-regression gate.

3. **Budget commitments precede the measurements that justify them.** Phase 0 measures
   variance/power, but the plan already fixes 20 steps, 3 replicates, one GPU, one day.
   If resolving the minimum meaningful effect needs 500+ games per private eval, 20
   steps may be either unaffordable or unable to distinguish arms. State explicitly
   that Phase 1 arm sizes are provisional pending Phase 0 power analysis.

4. **"Equal budgets" is ambiguous in the baseline comparison.** The matrix equalizes
   _outer steps_, but Weco consumes outer-model tokens/dollars that random and
   evolutionary search don't. Success criteria say "equal total budgets." Pick one
   (equal evaluator calls vs. equal total dollars) and state it.

## Key risks

5. **The config-only pilot may be a poor test of Weco.** An LLM mutating a bounded
   JSON is expensive black-box hyperparameter search; a Bayesian optimizer will
   plausibly beat it, failing the Phase 1 gate for reasons unrelated to Weco's actual
   value. Either soften the gate to "parity with simple search + pipeline validated
   end-to-end," or include one small code file such as the reranker in the pilot.
   Also verify Weco's CLI actually supports the 10-file mutable surface Phase 2 assumes.

6. **File hashes don't stop in-process tampering.** If candidate code executes in the
   same process as the evaluator, it can monkeypatch reward extraction regardless of
   read-only mounts and hash checks. The plan needs explicit process isolation:
   candidate runs in a separate sandboxed process/container, and the trusted side
   recomputes the score from signed replays out-of-band. Since Weco ships terminal
   output to its cloud, the runner should emit only a whitelisted JSON schema and never
   echo candidate stdout or raw stack traces. Phase 0 should include an adversarial
   candidate that deliberately tries to print private seeds.

7. **The trusted adapter is itself attack surface.** Add schema hard ranges and fuzz
   the adapter as a Phase 0 deliverable.

## Smaller improvements

8. State explicitly that no V35 GPU work starts until the V34 recovery completes, or
   name the dedicated GPU.
9. Give complexity gates measurable proxies. Treat Michael's games as qualitative
   sanity checks and use simulator snapshot suites for statistically supported
   round-15+ claims.
10. Re-score the current harness incumbent under the V35 surrogate so the comparison
    is not confounded by objective definition.

Overall: safety architecture and phasing are well thought out; resolve items 1–4
before implementation because they determine whether the gates can produce a
trustworthy answer.
