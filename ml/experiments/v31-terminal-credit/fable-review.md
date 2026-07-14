# V31 Claude Fable review

Model: Claude Fable  
Effort: high  
Reviewed: `ml/experiments/v31-terminal-credit/protocol.json`  
Status: incorporated before training

The preregistration discipline is strong: frozen seeds, one-shot hidden gate,
compute-matched arms, and an anchor-only control. The issues below are ordered
by importance.

## Major

1. The design is powered for effects it almost certainly cannot produce. The
   trust gate keeps every arm close to the teacher, yet the development gate
   asks a 1,024-game block to establish a Bonferroni-adjusted positive lower
   bound for a two-point effect. Raise development games to 3,072-4,096, or
   explicitly treat a null as uninformative about small effects.
2. The hidden 60% absolute-win bar can reject a real relative improvement merely
   because the hidden block is harder. Drop it or make it report-only; relative
   paired gates are the relevant claim in this non-promoting stage.
3. PPO clipping is centered on the teacher even though the student initializes
   from V30, so the treatment mixes terminal credit with asymmetric restoration
   toward the teacher on strategic rows. At minimum report initial ratios and
   clip fractions by advantage sign. Prefer clipping current policy ratios
   relative to the frozen V30 anchor while retaining teacher probability as the
   off-policy behavior denominator.
4. Anchor parity versus V23 can fail because the entity-v2 line was already
   weaker, which says nothing about V31 training. Only anchor-only versus the V30
   initial checkpoint should invalidate the causal interpretation; V23 remains
   strength context.

## Moderate

5. Pin the exact strategic-row predicate and source commit.
6. Explain hybrid selection explicitly. Greedy hybrid rows must be excluded
   from policy credit; student/teacher probabilities must use the same masked
   support and temperature.
7. Do not reuse the V30 one-shot gate half for per-epoch decisions. Restrict V31
   trust monitoring to the 256-game V30 selection half.

## Minor

- Pick one multiplicity convention rather than gate redundantly on Bonferroni
  intervals and Holm-corrected McNemar tests.
- State whether V31 may consume V30's stricter 0.40 strategic-p99 safety margin.
- Add strategic policy entropy telemetry.
- Acknowledge that V23 uses native obs-v1 inference while causal V31 comparisons
  use the shared v2 binary path.

The most important changes before launch are the larger development sample and
removing the arbitrary hidden absolute threshold; otherwise the likely outcome
is an underpowered null that spends the reserved block without resolving the
mechanism.
