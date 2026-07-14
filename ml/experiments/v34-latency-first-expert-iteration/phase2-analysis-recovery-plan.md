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
2. Create an isolated, shallow provenance-only Git object database on SimForge.
   It must contain the authentic commit objects from implementation commit
   `fe8dcdb66357263b808f6b169e34f2eb6732d48f` through the committed recovery
   authorization, mark `fe8dcdb` as the shallow boundary, and set `HEAD` to the
   recovery-authorization commit. Re-hashing every imported raw commit object
   must reproduce its original commit ID.
3. Do not add `.git` to, check out over, symlink over, or copy a working tree onto
   the authoritative remote artifact root. Bind the provenance database only for
   the analyzer process with `GIT_DIR=<isolated>/.git` and
   `GIT_WORK_TREE=<authoritative-root>`. Keep the analyzer's normal repository
   path and all artifact paths unchanged. This is intentionally a commit-graph
   database: the analyzer independently hash-verifies every working-tree input,
   while Git is used only for the frozen `merge-base --is-ancestor` check.
4. Before launch, require:
   - the isolated Git context has exactly the preregistered commit chain, its
     `HEAD` is the recovery-authorization commit, and the implementation commit
     is an ancestor of that `HEAD` under the same exported Git environment the
     analyzer will inherit;
   - every strength-locked and guardian-locked file hash matches;
   - all seven immutable completion paths and their referenced authoritative
     report files remain available and hash-bound;
   - authoritative `phase2-analysis.json` is absent;
   - the corrected-attempt stdout path is absent;
   - the failed attempt's stdout remains zero bytes;
   - guardian, teacher, final-development, hidden, multiplayer, human-reference,
     and promotion authorization flags remain closed.
5. Run the same analyzer exactly once more, with the same executable, argv,
   repository path, seven conditions, registered order, output path, and stdout
   redirection. The only launch change is the predeclared `GIT_DIR` and
   `GIT_WORK_TREE` environment needed by the already-frozen ancestry subprocess.
6. If this corrected launch fails for any reason, permit no further analyzer
   attempt. Record the failure and close the V34 Lane A analysis as invalid.
7. If it succeeds, copy and hash the JSON and stdout locally, commit them before
   reading any value, then inspect the archived analysis and proceed only through
   its predeclared guardian authorization logic.
8. Retain the isolated Git database until the analysis artifacts and provenance
   manifest are committed. Remove it afterward only if its recursive hashes,
   exact commit identities, shallow boundary, environment variables, and
   successful ancestry command are preserved in the incident record.

## Scientific rationale

This correction does not condition on an outcome: no outcome-loading function
was reached, no analysis file exists, and all inputs and thresholds remain
immutable. It repairs only the missing Git-provenance context required by the
already-frozen analyzer. The single corrected attempt is declared and reviewed
before execution; it is not an outcome-dependent retry.
