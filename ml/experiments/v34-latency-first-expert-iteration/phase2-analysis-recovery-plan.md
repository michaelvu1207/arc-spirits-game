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
  completion integrity. The frozen Python parent routes each verifier's stdout
  and stderr to `subprocess.DEVNULL`; only seven zero exit statuses were observed.
  The pass/fail bit is independent of cross-arm performance, and the verifier
  performs no cross-arm endpoint construction, bootstrap, gate evaluation,
  ranking, or selection.
- The committed attempt-window side-channel inventory enumerates and hashes every
  file created under the authoritative root, `/tmp`, and the remote user's home.
  The only attempt-created artifact is the zero-byte stdout. Three contemporaneous
  Brave cache entries are unrelated background-browser files; no scheduler,
  service, container, screen, shell-history, or analyzer-process sink persisted
  verifier or analyzer values. No potentially outcome-derived file exists to
  quarantine.
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
   authorization that hash-binds the incident, side-channel inventory, plan,
   accepting final Fable review, analyzer and recorder sources, exact
   executable/argv/cwd/output/stdout paths, sole permitted Git environment
   changes, automated-versus-human outcome-access attestation, maximum of one
   corrected analyzer process, preregistered reservation/attempt-started/
   exec-confirmed marker paths, and the no-further-retry/Lane-A-closure rule. A
   rejecting or qualified review cannot produce authorization until the plan is
   amended and re-reviewed.
3. Create an isolated, shallow provenance-only Git object database on SimForge.
   It must contain the authentic commit objects from implementation commit
   `fe8dcdb66357263b808f6b169e34f2eb6732d48f` through the committed recovery
   authorization and set `HEAD` to the recovery-authorization commit. Derive the
   complete shallow-boundary set from the frozen parent graph: every imported
   boundary commit whose omitted parent is outside the authorized graph must
   appear in `.git/shallow`, and no other entry may appear. Re-hashing every
   imported raw commit object must reproduce its original commit ID. Import every
   intermediate first-parent and merge side-parent needed for the exact
   preregistered graph.
4. Do not add `.git` to, check out over, symlink over, or copy a working tree onto
   the authoritative remote artifact root. Bind the provenance database only for
   the analyzer process with `GIT_DIR=<isolated>/.git`. Do not set
   `GIT_WORK_TREE`; the committed `phase2-analysis-git-dir-only-probe.json`
   proved that the frozen
   `git -C <repo> merge-base --is-ancestor ... HEAD` succeeds with `GIT_DIR` alone from a
   non-Git directory. Keep the analyzer's normal repository path and all artifact
   paths unchanged. This is intentionally a commit-graph database: the analyzer
   independently hash-verifies every working-tree input, while Git is used only
   for the frozen ancestry check.
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
     and the graph-derived complete `.git/shallow` set are exact; both the
     positive ancestry command and
     the reverse negative control
     `merge-base --is-ancestor <recovery-authorization-HEAD> fe8dcdb` return
     statuses 0 and 1 respectively;
   - every strength-locked and guardian-locked file hash matches;
   - all seven immutable completion paths and their referenced authoritative
     report files remain available, readable, and hash-bound without displaying
     their contents;
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
     `GIT_DIR`, `GIT_NO_REPLACE_OBJECTS=1`,
     `GIT_CONFIG_SYSTEM=/dev/null`, and `GIT_CONFIG_GLOBAL=/dev/null`;
     `GIT_WORK_TREE` is forbidden. Explicitly reject common-dir,
     object-directory, alternates, shallow-file, namespace, index,
     replace-ref-base, and injected `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/
     `GIT_CONFIG_VALUE_*` overrides;
   - exact `PATH`, Git, Node, and pinned Python executable identities are recorded;
     the Git database is read-only and its recursive hashes are captured before
     launch;
   - the exact frozen ancestry command succeeds under the exact final exported
     environment and the reverse command returns 1; system and global Git config
     are disabled, not merely assumed irrelevant;
   - the pinned Python can import the frozen analyzer and its dependencies without
     executing `main`; the exact output directory is writable via an atomic
     create/fsync/unlink sentinel; the final JSON and attempt-2 stdout paths remain
     absent; all seven completion and referenced input paths pass `test -r`; the
     Python executable, Node, Git, filesystem, file-descriptor limit, `/tmp`, RAM,
     and persistent-disk checks are recorded with sufficient headroom;
   - the one-shot launcher is syntax-checked and dry-runs every pre-exec validation
     against dummy non-outcome paths, including exclusive stdout creation and the
     `Popen` exec-confirmation handshake, without invoking the analyzer or reading
     Phase 2 values;
   - the Git environment variables are scoped to the one analyzer process and
     are absent from all later commands.
6. Create immutable Git-context and immediate-prelaunch manifests containing all
   checks above, copy and hash-verify them locally, and commit them before launch.
   Then atomically create, copy, hash, and commit the preregistered **reservation**
   marker. Reservation alone does not claim that an analyzer process was exec'd.
7. Invoke a preregistered one-shot launcher. It must first require the committed
   reservation and recheck the prelaunch-manifest hash. It then atomically creates
   the attempt-started marker and opens the unique attempt-2 stdout with
   `O_CREAT|O_EXCL`; either durable artifact permanently consumes the sole launch
   slot. It starts the analyzer with a `Popen`-style handshake where return from
   process creation proves successful `execve`, then atomically records an
   exec-confirmed manifest with PID, start time, executable identity, argv hash,
   environment hash, and stdout inode. The launcher waits for and records the
   analyzer exit status without reading its output.
8. Run the same analyzer exactly once more, with the same executable, argv,
   repository path, seven conditions, registered order, output path, and stdout
   semantics. Redirect stdout exclusively to the preregistered attempt-2 path.
   The only environment change is the predeclared Git context needed by the
   already-frozen ancestry subprocess plus disabled system/global Git config.
   A reservation-only state with neither attempt-started marker nor stdout proves
   that no analyzer launch was consumed and may resume this same committed
   invocation. Once either started artifact exists, no second analyzer process is
   permitted. If started exists but exec-confirmed does not, conservatively record
   a pre-exec launcher failure and close Lane A without retry.
9. If the corrected analyzer process fails for any reason, permit no further
   analyzer attempt. Record the failure and close the V34 Lane A analysis as
   invalid.
10. If it succeeds, copy and hash the JSON, stdout, launcher record, started
   marker, and exec-confirmed manifest locally, commit them before
   reading any value, then inspect the archived analysis and proceed only through
   its predeclared guardian authorization logic.
11. Retain the isolated Git database until the analysis artifacts and provenance
   manifest are committed. Remove it afterward only if its recursive hashes,
   exact commit identities, shallow boundary, environment variables, and
   successful ancestry command are preserved in the incident record. Verify its
   recursive hashes are unchanged after the analyzer exits.

## Scientific rationale

This correction does not condition on an observed outcome: machine integrity
verifiers read rows while their streams were kernel-discarded; only their seven
zero exit statuses were observed, and those integrity bits are independent of
which arm performs best. Python never reached `load_conditions`, no comparative
endpoint/bootstrap/gate/ranking/selection ran, no analysis file exists, and all
inputs and thresholds remain immutable. With frozen seeds, condition artifacts,
inputs, analyzer source, and thresholds, the analysis is deterministic: the
corrected process mechanically completes the same draw attempt 1 would have
produced rather than drawing a second stochastic sample. It repairs only the
missing Git-provenance context required by the already-frozen analyzer.

The governing principle is that a failure provably prior to outcome exposure may
be corrected only by a reviewed and preregistered amendment whose decision is
outcome-independent. The single corrected analyzer process is declared and
reviewed before execution; it is not an outcome-dependent retry.
