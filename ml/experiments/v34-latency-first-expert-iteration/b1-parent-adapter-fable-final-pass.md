Verdict: no blocker remains.

The ready synchronization fixes the preflight failure correctly: the async factory waits for the worker's
socket-connected `ready` message before the constructor issues the first blocking round trip. The ready
promise has a timeout, propagates fatal/worker errors, and closes on failure.

The binary request and response layouts match `ml/infer_server.py` byte-for-byte for B=1. The fixed
22-byte request header correctly carries magic, want bits 1|32, id length, B, obs/action dimensions, and
one candidate count before id/float payloads. Response section order is logits then reach30, with strict
magic, flags, id, counts, and total-length checks. The fake-server test faithfully mirrors the real layout.

Each decision makes exactly one scoring round trip for logits plus p30; the sigmoid is client-side. The
separate JSON info handshake is connect-time only. Connect/validation failures close the bridge, provider
close is idempotent, and post-ready socket failure wakes the request with an error. Identity checks remain
fail-closed, and the plan's final re-handshake covers checkpoint reloads.

The authorization plan remains draft, opens only storage preflight and then the unregistered density
smoke, and keeps every registered/training/promotion flag false. No game has run.

PASS
