# Fable high-effort plan review

Model: Claude Fable

Effort: high

Tools: Read only

Session persistence: disabled

The plan's fairness contract, seed hygiene, and fail-closed posture are strong. The review identified
the following blockers before protocol freeze:

1. The four-game, one-worker smoke cannot reject on an unscaled 4,096-game projection. An arm near
   the binding latency limit could pass at 16–24 workers while projecting above six hours at one.
   Smoke must use an explicitly optimistic maximum-worker normalization or reject only errors and
   egregious decision latency.
2. The final composition rule is not registered. Online-search gain measured with the V32 actor does
   not automatically transfer to a distilled policy, and trying both compositions on final
   development would add unbudgeted multiplicity. Register a separate transfer range and rule.
3. PPO training seeds and per-generation development ranges are missing. Reusing one expert-policy
   development set for three sequential gates would overfit selection.
4. A4's 98.33% family confidence assumes three arms while the plan registers five. Define the family
   and correct multiplicity.
5. The guardian confirmation range is registered but has no procedure.

Important risks and improvements:

- Add a policy-rank-weight-1.0 argmax control so any gain is not confounded with replacing sampled
  temperature-0.55 decisions by deterministic argmax.
- Audit round-30 critic calibration on post-candidate preview states, not only batched-vs-serial
  equivalence.
- Gate hidden qualification on a confidence lower bound and define the permitted development-hidden
  delta rather than combining a noisy 80% point threshold with an undefined collapse test.
- State the human-gate confidence level and use enough games for the intended bar.
- Run a non-binding multiplayer canary after generation 1.
- Make inference latency a hard capacity-arm gate, not a tie break.
- Define teacher snapshot counts, visit-entropy threshold, positive-Elo threshold, replay-anchor
  reference, and capacity subranges.
- Treat the historical 53.91% V23-behavior validation win rate as context only; register a current
  V34 baseline estimate because no current 4,096-seed anchor has yet been measured.
- Require at least 256 searched decisions per binding latency condition.

Highest-leverage fixes: correct smoke projection logic, register final composition transfer, and add
the weight-1.0 control before any V34 seed opens.
