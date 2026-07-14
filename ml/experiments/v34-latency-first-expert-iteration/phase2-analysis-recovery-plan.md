# V34 Phase 2 analysis recovery plan

## Incident classification

The first analyzer launch exited with code 1 at
`validate_strength_lock(..., verify_git=True)` because the SimForge artifact root is
not a Git checkout. The failing check was
`git -C <repo> merge-base --is-ancestor <implementationCommit> HEAD`.

This was a pre-outcome execution-environment failure:

- `phase2-analysis.json` was not created.
- Redirected stdout is zero bytes.
- The traceback proves `analyze_phase2()` stopped in `validate_strength_lock()`
  before `load_conditions()`, `validate_report()`, endpoint construction,
  bootstrap sampling, gate evaluation, or authorization selection.
- The locked JavaScript completion verifiers ran first, but their output was
  discarded and they only verify immutable completion/provenance structure.
- No human or agent has opened a Phase 2 report, completion outcome, or analysis
  value since the launch.

The failed launch and its exact command, exit code, stderr, output absence, and
source-order evidence must be recorded and committed before any recovery launch.

## One permitted correction

1. Preserve all frozen protocols, locks, condition manifests, reports, seeds,
   ordering, analyzer source, Python environment, and command arguments.
2. Create an isolated temporary Git checkout on SimForge from a locally produced
   Git bundle. Its `HEAD` must be the committed recovery authorization and must
   descend from implementation commit
   `fe8dcdb66357263b808f6b169e34f2eb6732d48f`.
3. Do not add `.git` to or check out over the authoritative remote artifact root.
   The temporary checkout is only the analyzer `--repo` and provenance context.
4. Before launch, require:
   - the implementation commit is an ancestor of the temporary `HEAD`;
   - every strength-locked and guardian-locked file hash matches;
   - all seven immutable completion paths and their referenced authoritative
     report files remain available and hash-bound;
   - authoritative `phase2-analysis.json` is absent;
   - the corrected-attempt stdout path is absent;
   - the failed attempt's stdout remains zero bytes;
   - guardian, teacher, final-development, hidden, multiplayer, human-reference,
     and promotion authorization flags remain closed.
5. Run the same analyzer exactly once more, with the same seven conditions in
   the same registered order. The only semantic command change is `--repo` to
   the valid isolated Git checkout; `--out` and redirected stdout use absolute
   paths in the authoritative artifact root.
6. If this corrected launch fails for any reason, permit no further analyzer
   attempt. Record the failure and close the V34 Lane A analysis as invalid.
7. If it succeeds, copy and hash the JSON and stdout locally, commit them before
   reading any value, then inspect the archived analysis and proceed only through
   its predeclared guardian authorization logic.
8. Retain the temporary checkout and bundle until the analysis artifacts and
   provenance manifest are committed. Remove them afterward only if their hashes
   and exact commit identity are preserved in the incident record.

## Scientific rationale

This correction does not condition on an outcome: no outcome-loading function
was reached, no analysis file exists, and all inputs and thresholds remain
immutable. It repairs only the missing Git-provenance context required by the
already-frozen analyzer. The single corrected attempt is declared and reviewed
before execution; it is not an outcome-dependent retry.
