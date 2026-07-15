# V35 Runtime Parity Attempt 2 Amendment

Status: proposed only; not authorized until reviewed and committed.

## Incident

Attempt 1 is permanently closed. Its legacy functional inference server failed
before readiness because the Unix-domain socket path was 161 bytes, exceeding
Linux's 107-byte socket payload limit. No evaluator process started, no report
was created, no parity seed was consumed, and no gameplay outcome or comparison
exists. GPU 7 returned to 0 MiB/0% and the lease was released.

The immutable incident is
`artifacts/runtime-parity-attempt-1-incident.json`. Attempt 1 may not be resumed
or overwritten.

## Sole execution correction

Keep the accepted plan, commits, source archives, trace schema, checkpoint,
candidate, seeds, ABBA order, GPU UUID mask, comparator, gates, and no-retry
policy unchanged. Change only the inference socket location:

- rejected: `<long shared attempt path>/<job>/infer.sock`;
- corrected: `<unique process-owned /tmp scratch>/sockets/<job>.sock`.

The corrected paths are below the Linux limit and remain inside the runner's
mode-0700 scratch directory. Reports, stdout, stderr, contracts, and hashes stay
in the sealed shared attempt directory; only the socket moves.

## Attempt separation

- New output: `artifacts/runtime-parity/attempt-2`.
- New authorization file and SHA-256.
- New runner SHA-256 binding the short-socket correction.
- Original comparator and source archives remain byte-identical.
- Attempt 2 receives one execution only and has no retry authority.

Before launch, machine verification must prove attempt 1 contains zero
`report.json` files, both proposed seed ranges remain unconsumed, attempt 2 does
not exist, GPU 7 is free, the old lease is absent, and disk floors still pass.

Passing attempt 2 would authorize only the already-planned public latency
precheck. Strength, private, and promotion flags remain closed.
