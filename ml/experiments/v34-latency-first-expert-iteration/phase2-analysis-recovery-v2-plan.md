# V34 Phase 2 analysis recovery v2 amendment

## Why v1 remains unconsumed

The Fable-accepted v1 recovery reached a committed reservation but never crossed
the durable attempt boundary. Its launcher rejected while validating the
prelaunch environment hash, before creating `attempt-started`, stdout, stderr,
`exec-confirmed`, the exit record, or `phase2-analysis.json`. No analyzer process
started and no Phase 2 value was displayed. The committed v1 authorization,
prelaunch, and reservation are permanently abandoned and must not be changed or
reused.

The v1 prelaunch hash included every inherited environment value. Independent
SSH connections necessarily change outcome-irrelevant transport/session values:
`SSH_CLIENT`, `SSH_CONNECTION`, and `XDG_SESSION_ID`; PTY launches may also vary
`SSH_TTY`, `TERM`, `COLUMNS`, and `LINES`. The analyzer does not read these
variables, but the over-broad v1 hash made it impossible to archive a prelaunch
manifest in one connection and invoke the already-reserved launcher in another.

## One v2 operational correction

1. Preserve the exact frozen analyzer executable, argv, cwd, condition order,
   condition artifacts, source hashes, seeds, thresholds, result path, and
   stdout semantics. Preserve the inherited child environment; v2 does **not**
   remove, add, or rewrite any non-Git environment variable. Naturally varying
   transport/session values may differ between SSH processes; v2 passes those
   real values unchanged and ignores them only for equality comparison.
2. Continue to reject every inherited `GIT_*` variable. Add only the same four
   already-accepted Git variables: exact isolated `GIT_DIR`,
   `GIT_NO_REPLACE_OBJECTS=1`, `GIT_CONFIG_SYSTEM=/dev/null`, and
   `GIT_CONFIG_GLOBAL=/dev/null`. Keep `GIT_WORK_TREE` forbidden.
3. Define the analysis-relevant environment fingerprint as the canonical hash of
   the full child environment after removing only this exact preregistered set:
   `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `SSH_AUTH_SOCK`, `TERM`, `COLUMNS`,
   `LINES`, `_`, `SHLVL`, `OLDPWD`, `XDG_SESSION_ID`, `XDG_RUNTIME_DIR`, and
   `DBUS_SESSION_BUS_ADDRESS`. These are transport, terminal, shell-bookkeeping,
   or per-login plumbing. Four fresh outcome-blind PTY/non-PTY connections were
   compared by value hash: only `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `TERM`,
   and `XDG_SESSION_ID` varied; `SSH_AUTH_SOCK`, `COLUMNS`, and `LINES` were absent,
   while `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` were stable. The frozen
   analyzer and locked verifiers do not read any excluded variable or terminal
   sizing. The full child environment is still passed unchanged to the analyzer.
   The prelaunch manifest records the excluded set, exact PATH, full variable
   count, relevant fingerprint, and an audit-only full hash.
4. Pin fingerprint serialization exactly: remove the excluded keys; sort remaining
   keys by Python Unicode code-point order; encode a JSON array of `[key,value]`
   pairs with `ensure_ascii=true`, separators `(',', ':')`, no spaces, and one
   terminal newline as UTF-8; then compute SHA-256. The audit-only full hash uses
   the identical serialization before key removal.
5. Use new v2 schemas and new immutable paths for authorization, prelaunch,
   reservation, attempt-started, stdout, stderr, exec-confirmed, exit record, and
   isolated Git database. Do not overwrite, rename, or delete any v1 artifact.
6. Bind the v1 reservation incident, this plan, an accepting Fable review, the v2
   launcher/preflight sources, exact excluded-variable set, analyzer command,
   files, paths, and no-retry rule in a new committed v2 authorization.
7. Build and validate a new authentic read-only commit-only Git database from
   `fe8dcdb` through the v2 authorization commit, with the complete derived
   shallow-boundary set and all v1 Git-context controls. Commit its manifest.
8. Generate and commit a v2 prelaunch manifest. A later SSH connection may invoke
   the v2 launcher only if the analysis-relevant environment fingerprint, exact
   PATH, exact Git additions, tool identities, bound files, Git context, and all
   outcome-blind preflight checks still match.
9. Commit a v2 reservation before invocation. Reservation alone remains
   non-consuming. The v2 launcher retains the same exclusive attempt-started and
   stdout/stderr creation, `Popen` exec handshake, exec-confirmed record, and
   conservative Lane-A closure after the durable start boundary.
10. Record the analysis-relevant fingerprint, audit-only full child-environment
    hash, exact excluded-variable set, PATH, and Git additions in both the
    attempt-started and exec-confirmed records. The full hash may differ between
    connections and is evidence only; the relevant fingerprint must match.
11. Permit at most one corrected analyzer process across the recovery. The v1
   count is zero because no process started; once any v2 started artifact exists,
   no analyzer retry is allowed for any reason.
12. Treat stdout as an audit-only stream; it is not a registered measured endpoint.
    `phase2-analysis.json` is the sole measured analysis output.
13. On v2 success, copy, hash, and commit analysis JSON, streams, start/exec/exit
    records, prelaunch, reservation, and post-run Git-context inventory before
    opening any value. On any post-start failure, close Lane A.

## Authorization revision discipline

V2 authorization revision 1 was committed but detected, before prelaunch, to bind
a generator that still hardcoded the v1 Git-context HEAD/ref. It created no
prelaunch, reservation, start marker, stream, analyzer process, or result and is
permanently abandoned. A superseding v2 authorization revision must use entirely
new authorization/prelaunch/reservation/marker/stream/Git-context paths and bind
the corrected generator. The generator must derive the expected HEAD and symbolic
ref from the hash-bound Git-context manifest; it may not contain a commit/ref
constant. It must reverse-bind that post-authorization manifest by requiring the
manifest's embedded authorization path, byte size, and SHA-256 to match the exact
supplied authorization, and likewise bind the supplied Git-context inventory.
The superseding authorization must hash-bind revision 1's incident, this amended
plan, the corrected generator, and the preserved revision-1 Git-context manifest
and inventory. It must state mechanically that revision 1 created that isolated
Git-context lineage, but created no prelaunch-or-later attempt artifact and started
zero analyzer processes. The new database, manifest, inventory, authorization,
prelaunch, reservation, markers, streams, and exit paths must all be lineage-unique
and must not reuse revision-1 v2 artifacts. This operational correction does not
alter the analyzer or the accepted environment contract.

## Scientific validity

This v2 amendment changes only how equality is checked for variables that identify
the SSH transport/session and that the analyzer never consumes. It does not mutate
the analyzer's inherited environment, data, randomness, executable, command, or
outputs; naturally varying excluded values are passed through as received. The
decision is outcome-blind: no v1 analyzer process existed and no
Phase 2 value was observed. Therefore v2 remains the same deterministic mechanical
completion of the frozen Phase 2 draw, not a new sample or an outcome-conditioned
retry.
