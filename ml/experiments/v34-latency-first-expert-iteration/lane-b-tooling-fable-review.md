# Claude Fable review of the V34 Lane B amendment

Model: Claude Fable
Effort: high
Date: 2026-07-14
Status: findings incorporated and re-reviewed; no registered Lane B seed was opened.

## Findings

The amended plan is rigorous, but Fable identified these gaps before a tooling lock can be created:

1. B1 forbids future outcomes in snapshot rows while B3 expects value/reach/hazard labels on teacher rows.
   Put those labels in a segregated target channel that is provably absent from observations and teacher
   search inputs.
2. The three 961 stage-development blocks total 30,000 games, while the later text names 90,000 final
   development games. State explicitly that these are distinct schedules.
3. PFSP training legitimately consumes outcomes for reward and opponent weighting, while blinded paired
   evaluation campaigns must not expose outcomes. Add the explicit scope distinction.
4. A 2,048-row teacher audit can be underpowered at the 5% disagreement floor. Freeze a pilot-based power
   calculation and a minimum number of disagreement rows before registered execution.
5. The 131,072-row maximum supply before filtering leaves little margin for a 100,000-row exact dataset.
   Freeze per-band smoke-density thresholds and abort rules.
6. Freeze within-band subsampling seeds and rules.
7. Define the structural public-state hash exactly.
8. Bind the timing/storage pilot to unregistered snapshots.
9. State that every generation reruns the teacher audit against its current parent and uses that parent as
   the downstream continuation policy.
10. Put exact wall/disk limits and a concrete durable path/object prefix in the execution lock.
11. Define the width-winner handoff: whether multiplayer receives one replicate or a deterministic retrain,
    and require the selected-width checkpoint to re-pass B3 gates.
12. Freeze exploiter training seeds, provenance, and manifests before using exploiters as a field.

Fable verified the batch arithmetic, band and audit totals, canary seat balance, probe ranges, and stated
Bonferroni family sizes. It judged the information-safety approach sound once the target-channel conflict
is fixed, the CRN teacher comparison conceptually valid but underpowered without a pilot-derived audit
size, the loss coefficients conservative enough, the superseding 959 authorization necessary, multiplayer
training before hidden evaluation necessary, and the pilot-driven storage gate appropriate.

## Incorporation status

All findings were incorporated. The second review found four additional specification issues, which were
also incorporated, and the final Fable validation passed with no critical blocker.
