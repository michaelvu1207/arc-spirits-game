# V29 strategic-arm amendment review

Claude Fable reviewed the diagnostic-driven amendment at high effort before any
V29 optimizer existed. It identified two blocking issues:

- ranking arms by gate-half metrics would leak the supposedly untouched gate;
- selecting the strategic-balanced arm by aggregate KL would conflict with its
  training objective and could stop while strategic fidelity was improving.

The protocol now ranks arms only on paired selection-half metrics, selects the
strategic arm's epoch by strategic selection KL, and evaluates the gate half
exactly once on the frozen selection winner. A failed one-shot gate ends V29;
there is no fallback to a runner-up.
