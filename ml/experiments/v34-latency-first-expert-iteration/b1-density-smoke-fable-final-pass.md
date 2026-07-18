## Rereview result

The schema blocker is fixed. `b1-parent-policy-config.json` now passes all three gates that must agree
on it: the collector's exact policy-config validator, the adapter's canonical equality check, and the
provider-binding validator.

The live dependencies asserted by the plan also match:

- `RemotePolicy` supports the exact constructor, info, binary-wire, and memo behavior. Candidate logits
  and reach30 are requested in one frame, and the adapter's immediately following p30 call is a memo hit.
- `infer_server.py` serves every required identity/head field and supports the exact planned CLI.
- `model_v2.py` confirms that the served reach scalar is the trained horizon-30 head.
- Constant-zero recovery is validated but not written into feature rows; public recovery diagnostics
  alone assign the recovery band.
- Sixteen shards of 32 cover exactly `962000000..962000511`, and the four smoke quotas are the exact
  ceiling of 110% of their scaled generation quotas.

Non-blocking notes: enforce the absent-socket precondition in the execution-lock verifier; commit the
reviewed modified files before creating the authorization basis; an identical-file reload is harmless;
and fp batch-composition variation does not violate the plan's within-run stored-logit replay claim.

PASS
