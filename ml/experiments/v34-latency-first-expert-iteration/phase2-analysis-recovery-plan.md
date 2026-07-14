# V34 Phase 2 analysis recovery plan

## Incident classification

The first analyzer launch exited with code 1 at
`validate_strength_lock(..., verify_git=True)` because the SimForge artifact root is
not a Git checkout. The failing check was
`git -C <repo> merge-base --is-ancestor <implementationCommit> HEAD`.

This was a pre-comparative-analysis execution-environment failure:

- `phase2-analysis.json` was not created.
- Redirected stdout is zero bytes.
- The traceback proves `analyze_phase2()` stopped in `validate_strength_lock()`
  before `load_conditions()`, `validate_report()`, endpoint construction,
  bootstrap sampling, gate evaluation, or authorization selection.
- The locked JavaScript completion verifiers ran first. They machine-read the
  outcome-bearing report/replay rows and aggregates to recompute deterministic
  completion integrity, but all output was discarded. They perform no cross-arm
  endpoint construction, bootstrap, gate evaluation, ranking, or selection.
- No human or agent has opened or observed a Phase 2 report, completion outcome,
  or analysis value since the launch, and no recovery decision was conditioned
  on performance.

The failed launch and its exact command, exit code, stderr, output absence, and
source-order evidence must be recorded and committed before any recovery launch.

## One permitted protocol amendment

This amendment is not literal compliance with the original "analyzer exactly
once" wording. It permits one corrected launch only because attempt 1 failed
before comparative analysis and exposed no values. It must be Fable-reviewed,
committed, and immutably authorized before use.

1. Preserve all frozen protocols, locks, condition manifests, reports, seeds,
   ordering, analyzer source, Python environment, and command arguments.
2. After an accepting Fable review, create and commit an immutable recovery
   authorization that hash-binds the incident, plan, Fable review, analyzer and
   recorder sources, exact executable/argv/cwd/output/stdout paths, sole permitted
   Git environment change, automated-versus-human outcome-access attestation,
   maximum of one corrected attempt, atomic consumed-marker path, and
   unconditional no-further-retry/Lane-A-closure rule. A rejecting or qualified
   review cannot produce authorization until the plan is amended and re-reviewed.
3. Create an isolated, shallow provenance-only Git object database on SimForge.
   It must contain the authentic commit objects from implementation commit
   `fe8dcdb66357263b808f6b169e34f2eb6732d48f` through the committed recovery
   authorization, mark `fe8dcdb` as the shallow boundary, and set `HEAD` to the
   recovery-authorization commit. Re-hashing every imported raw commit object
   must reproduce its original commit ID. Import every intermediate first-parent
   and merge side-parent needed for the exact preregistered graph.
4. Do not add `.git` to, check out over, symlink over, or copy a working tree onto
   the authoritative remote artifact root. Bind the provenance database only for
   the analyzer process with `GIT_DIR=<isolated>/.git` and
   `GIT_WORK_TREE=<authoritative-root>`. Keep the analyzer's normal repository
   path and all artifact paths unchanged. This is intentionally a commit-graph
   database: the analyzer independently hash-verifies every working-tree input,
   while Git is used only for the frozen `merge-base --is-ancestor` check.
5. Before launch, require:
   - the isolated Git context has exactly the preregistered commit graph, its
     `HEAD` is the recovery-authorization commit, and the implementation commit
     is an ancestor of that `HEAD` under the same exported Git environment the
     analyzer will inherit;
   - `git rev-list --parents HEAD` equals the frozen parent graph; every object is
     a loose `commit`, re-hashes to its expected SHA-1 ID, and the database has no
     packs, alternates, grafts, replace refs, commit-graph, promisor configuration,
     remotes, namespaces, unexpected refs, extra objects, or symlinks;
   - `HEAD`, its sole branch ref, the SHA-1 object format, shallow-repository flag,
     and `.git/shallow` contents are exact; both the positive ancestry command and
     the reverse negative control
     `merge-base --is-ancestor <recovery-authorization-HEAD> fe8dcdb` return
     statuses 0 and 1 respectively;
   - every strength-locked and guardian-locked file hash matches;
   - all seven immutable completion paths and their referenced authoritative
     report files remain available and hash-bound;
   - authoritative `phase2-analysis.json` and the unique corrected stdout path
     `artifacts/phase2-analysis-attempt-2.stdout` are absent;
   - the failed attempt's stdout remains zero bytes;
   - guardian, teacher, final-development, hidden, multiplayer, human-reference,
     and promotion authorization flags remain closed;
   - the authoritative root still has no `.git` entry, so the locked JavaScript
     recorder and strength-chain verifier take the same optional-Git branch they
     took on attempt 1; only the Python analyzer's unconditional `git -C`
     subprocess consumes the exported provenance context;
   - all inherited `GIT_*` variables are rejected except exact absolute
     `GIT_DIR`, exact absolute `GIT_WORK_TREE`, and
     `GIT_NO_REPLACE_OBJECTS=1`; explicitly reject common-dir, object-directory,
     alternates, shallow-file, namespace, index, replace-ref-base, and injected
     config overrides;
   - exact `PATH`, Git, Node, and pinned Python executable identities are recorded;
     the Git database is read-only and its recursive hashes are captured before
     launch;
   - the Git environment variables are scoped to the one analyzer process and
     are absent from all later commands.
6. Create immutable Git-context and immediate-prelaunch manifests containing all
   checks above, copy and hash-verify them locally, and commit them before launch.
   Then atomically and exclusively create the preregistered one-shot consumed
   marker, copy/hash/commit it, and treat its existence as permanent consumption
   of the only corrected attempt.
7. Run the same analyzer exactly once more, with the same executable, argv,
   repository path, seven conditions, registered order, output path, and stdout
   semantics. Redirect stdout exclusively to the preregistered attempt-2 path.
   The only environment change is the predeclared Git context needed by the
   already-frozen ancestry subprocess. Require the committed consumed marker to
   exist; its existence forbids another corrected attempt.
8. If this corrected launch fails for any reason, permit no further analyzer
   attempt. Record the failure and close the V34 Lane A analysis as invalid.
9. If it succeeds, copy and hash the JSON and stdout locally, commit them before
   reading any value, then inspect the archived analysis and proceed only through
   its predeclared guardian authorization logic.
10. Retain the isolated Git database until the analysis artifacts and provenance
   manifest are committed. Remove it afterward only if its recursive hashes,
   exact commit identities, shallow boundary, environment variables, and
   successful ancestry command are preserved in the incident record. Verify its
   recursive hashes are unchanged after the analyzer exits.

## Scientific rationale

This correction does not condition on an observed outcome: machine integrity
verifiers read rows but emitted nothing, Python never reached `load_conditions`,
no comparative endpoint/bootstrap/gate/ranking/selection ran, no analysis file
exists, and all inputs and thresholds remain immutable. It repairs only the
missing Git-provenance context required by the already-frozen analyzer. The
single corrected attempt is declared and reviewed before execution; it is not an
outcome-dependent retry.
