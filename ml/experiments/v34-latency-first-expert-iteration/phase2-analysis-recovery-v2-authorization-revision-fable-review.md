# Fable review of the V34 Phase 2 recovery v2 authorization revision

Reviewed commit: `f779543c5834136c6821d687135284b5770139d5`

## Verdict: ACCEPT — subject to three blocking gaps

The supersession is outcome-blind and scientifically defensible. Revision 1 died at stage `post-authorization-before-prelaunch`: the incident record attests every downstream artifact flag false (no prelaunch, reservation, attempt-started, streams, exec-confirmed, analyzer process, or analysis JSON), `phase2OutcomeValueDisplayed: false`, and the v1 disposition in the authorization confirms zero analyzer processes ever started. There is no Phase 2 outcome in existence to condition on — `phase2-analysis.json` is checked absent and attempt-1 stdout is bound at 0 bytes. The defect itself (generator hardcoding the v1 HEAD/ref) is a pure mechanical inconsistency: the old generator could never pass against the v2 Git database under any outcome, so detecting and correcting it carries no outcome information. I read no Phase 2 result artifacts in this review.

The correction touches only preflight provenance checking. The analyzer executable, argv, cwd, seeds, data, result path, and the accepted v2 environment-fingerprint contract are unchanged (the launcher pins all of these independently). Deriving `expected_head`/`expected_ref` from the manifest (`ml/prepare_v34_phase2_analysis_recovery.py:167-170`) is what plan step 7 always implied — the DB must extend through the authorization commit, which cannot be a source constant without recreating exactly this incident on every revision. Revision 1's abandonment is mechanically self-enforcing: its `boundFiles` pin the old generator and pre-amendment plan, both of which changed, so `validate_bound_files` will reject revision 1 forever. This remains the same single deterministic completion of the frozen Phase 2 draw, not a resample.

Blocking gaps that must be closed before the superseding prelaunch:

1. The corrected generator must enforce the reverse binding from the post-authorization Git-context manifest to the exact supplied authorization record (path, bytes, and SHA-256), rather than checking only `gitDir`.
2. Revision-1 Git-context artifacts must not be reused. The superseding revision needs new context/inventory/database paths and a new read-only DB whose HEAD is the superseding authorization commit.
3. The superseding authorization must hash-bind the revision-1 authorization incident, amended plan, and corrected generator, with a machine-checkable disposition that revision 1 produced nothing downstream and started zero analyzer processes.
