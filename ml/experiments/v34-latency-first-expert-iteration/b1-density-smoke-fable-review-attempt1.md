I reviewed the plan against the artifacts it binds (collector, adapter, config, inference server). The
plan is internally coherent and unusually well-hardened, but it binds a collector + adapter + config
combination that cannot launch as written.

## Blocking gap

The config schemaVersion is mutually incompatible between the collector and the adapter. The collector
requires `arc-v34-bound-raw-policy-v1`, while the adapter and config used
`arc-v34-raw-policy-config-v1`. No config could pass both validators. Reconcile this in code and update
the bound hashes before launch.

## Non-blocking gaps and risks

- Name the wrapper that produces retry exit classes 90 and 92; the collector itself exits 1.
- Detect a possible mid-run SIGHUP checkpoint reload with a final served-info handshake or disable reload.
- Pin the adapter's four required environment variables to exact values.
- Require the inference socket path to be absent because the server unlinks it at startup.
- Confirm that the apparent two-call logits/p30 adapter path is a one-round-trip memo hit, or optimize it.
- Move the GPU-7 emptiness evidence into the consumed-lock launch path to reduce the claim race.

Everything else reviewed matched the plan, including checkpoint identity, dimensions, config values,
hybrid ordering, sampling derivation, density arithmetic, and recovery thresholds.

BLOCK
