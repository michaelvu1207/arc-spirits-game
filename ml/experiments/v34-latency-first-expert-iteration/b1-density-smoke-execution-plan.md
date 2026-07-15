# V34 Lane B B1 unregistered density-smoke execution plan

Status: draft; no smoke, storage write, registered seed, outcome inspection, or promotion is authorized
by this document. Every Phase 2 outcome remains sealed. The only prospective game range here is the
unregistered `962000000..962000511` range.

## 1. Objective and fixed safety boundary

Prove that the final outcome-blind snapshot collector can supply at least 110% of each B1 generation
quota after the frozen 48-row/source-game and 4-row/public-state-hash caps. This is a systems and row-
density gate, not a strength evaluation. The analyzer may read feature rows and public recovery flags;
it must never open future-target shards or any Phase 2 report.

The smoke cannot authorize a registered collection, teacher search, training, development comparison,
hidden evaluation, human gate, or deployment. A shortfall keeps registered B1 closed and may be changed
only by a new Fable-reviewed protocol.

## 2. Exact unregistered seed ledger

Use one contiguous, non-substitutable range:

```json
{
	"id": "b1-density-smoke-unregistered-v1",
	"registration": "unregistered",
	"seed0": 962000000,
	"games": 512,
	"seedMax": 962000511,
	"contiguousInclusive": true,
	"substitutionAllowed": false,
	"backfillAllowed": false
}
```

This range is outside all V34 `956`, `957`, and closed `958`-`961` ledgers. It is never added to the
registered ledger. Sixteen fixed shards of 32 consecutive seeds allow concurrent actors while preserving
the same complete set: shard `i` starts at `962000000 + 32*i` for `i=0..15`.

## 3. Frozen raw-parent policy

Checkpoint:

- `ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt`
- 3,354,466 bytes
- SHA-256 `aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b`
- v2 manifest SHA-256 `fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad`
- obs-v2 width 3,419, candidate width 104, trained reach horizons 20/25/30, no option head

`scripts/v34-parent-snapshot-policy.mjs` must verify the live checkpoint file, manifest, served SHA,
served path, binary wire, dimensions, `cuda:0`, trained reach head, and horizon 30. It returns raw logits
and sigmoid p30. There is no recovery head: the adapter returns an explicitly bound constant zero that is
not stored as the public recovery classifier and is never used for band assignment. Recovery bands use
only `snapshot.ts` public-state diagnostics.

The adapter uses its own narrow `ready-synchronized-worker-binary-v1` client. The async factory waits for
the worker's Unix-socket connection-ready message before any synchronous framed request. Each decision
sends one binary request for raw logits plus reach30 and applies the p30 sigmoid client-side. The frozen
general production `RemotePolicy` is not executed or changed by Lane B: its constructor timed out in a
no-game preflight on both local Node 25 and SimForge Node 20 even though direct framed requests succeeded.
The ready-synchronized client has an in-process fake-server wire test and must pass a live no-game
handshake before authorization. The final no-game server preflight must use the same stripped five-key
child environment as the smoke (`ARC_V34_PARENT_CHECKPOINT`, `ARC_V34_INFER_SOCKET`,
`ARC_V34_INFER_TIMEOUT_MS`, `ARC_V34_EXPECT_DEVICE`, and `CUDA_VISIBLE_DEVICES`) rather than inheriting
the operator shell environment.

The exact config is `b1-parent-policy-config.json`:

- obs-v2, `hybrid-v1`, sampled temperature 0.55;
- production ordering: status cap 2 with all-actions escape, immediate win/VP guard on that constrained
  surface, then selectable-progress support;
- monster-reward learning disabled;
- option head disabled;
- absolute-balanced guardian schedule;
- 30 rounds, deterministic closure limit 64, overall tick limit 50,000;
- domain-separated SHA-256 bot sampling stream 0.

The sampler is intentionally a new independently seeded parent-policy stream, not a claim of byte-for-
byte driver-RNG replay. It uses the same raw logits, filtered-support softmax, and temperature, but each
decision draw is derived from source seed, decision ordinal, seat, and stream. This makes each retained
row independently reconstructable and prevents game RNG from entering policy sampling.

Weak-engine recovery is the existing inclusive AND predicate with exact thresholds:

```json
{
	"minRoundInclusive": 16,
	"maxExpectedAttack": 3.25,
	"maxAttackDice": 3,
	"maxAwakenedSpirits": 2,
	"maxBarrier": 5,
	"maxInitiative": 3
}
```

Overall recovery remains the frozen ANY-OF: status level at least 2, weak engine, or no positive VP in
the previous three completed rounds. The smoke report records reason overlaps and exact-boundary counts
as descriptive sensitivity evidence only; it cannot retune thresholds.

## 4. Immutable authorization chain

Avoid the circular dependency between an authorization hash and the S3 prefix with three new-only files.

1. `b1-smoke-authorization-basis.json`
   - Exact-key schema with one canonical `authorizationBasis` object and its SHA-256.
   - Bind source implementation `ff2aa7cc4e69f0f7da530a0d0df418c26839314e`, source/strength locks,
     closed Lane B protocol plus canonical hash, collector, adapter, config, inference server/wire
     contract, model, engine/reducer/actions/encoders, catalog, freezer, merger/analyzer, checkpoint, manifest,
     tests, and final Fable PASS records.
   - Bind exact host, artifact root, `/dev/shm` attempt root, argv arrays, environment allowlist,
     logs, outputs, markers, shard ledger, policy binding, and retry semantics.
   - Keep the consumed marker, structured orchestrator success/failure evidence, and a verified copy of
     the final feature-only report under the durable evidence directory outside `/dev/shm`. The
     orchestrator publishes these files itself with exclusive new-only writes; an external launcher
     must not pre-create or redirect into the absent attempt root.
   - The exact environment values are the absolute checkpoint path, absent absolute socket path,
     `ARC_V34_INFER_TIMEOUT_MS=30000`, `ARC_V34_EXPECT_DEVICE=cuda:0`, and
     `CUDA_VISIBLE_DEVICES=7`; no other `ARC_V34_*`, `ARC_DEVICE`, or CUDA visibility variable is
     allowed.
   - Bind a strict no-game provider-preflight record produced on a dedicated, released preflight
     socket. The execution provider binding is derived by changing only the bound client socket path
     to the still-absent attempt socket; every checkpoint, manifest, config, server, client, head, and
     device field must remain byte-for-byte canonical. This avoids creating the attempt directory or
     execution socket before the new-only launch check.
   - Derive the only S3 prefix as
     `arc-spirits/v34/lane-b/<basisSha256>/`.
   - Open only `storagePreflightOpen`; every game, registered, training, evaluation, promotion, and
     deployment flag remains false.

2. `b1-storage-preflight.json`
   - Under the derived prefix only, create an unregistered random probe, upload with SHA-256 metadata,
     read/download, compare bytes and SHA-256, delete the probe, and verify absence.
   - Record exact commands, exits, byte/hash evidence, throughput, timestamp, and `/dev/shm` free bytes.
   - Require at least twice the projected smoke peak in scratch. The later registered capacity gate stays
     `max(128 GiB, 1.5 * projected three-generation bytes)` and action traces at most 25% of that budget.
   - For this smoke, bind a 16 MiB probe and an outcome-blind conservative 64 GiB projected peak, so
     launch requires at least 128 GiB free on `/dev/shm`. These are protocol bounds, not estimates
     selected from any game result.
   - S3 versioning/Object Lock are absent, so later durable artifacts require content-addressed keys,
     conditional new-only uploads, checksum metadata, download verification, and an immutable manifest.

3. `b1-density-smoke-execution-lock.json`
   - Bind the basis and successful preflight records by path/bytes/SHA.
   - Verify every live bound file and exact policy/provider binding before opening the smoke.
   - Open only `densitySmokeOpen`; every registered or later flag remains false.
   - Require absent output/log/marker paths and atomically create one consumed marker immediately before
     `execFile`-style launch. Shell interpolation is forbidden.

Historical source/strength lock flags are not authority for Lane B. Only this narrow chain may authorize
the unregistered smoke.

## 5. Remote execution topology

Use exactly physical GPU 7 and no other GPU. Confirm GPU 7 is empty immediately before launch and set
`CUDA_VISIBLE_DEVICES=7`; the inference process must report logical `cuda:0`. Do not touch GPU 4 or GPUs
5-6 even if they appear idle.

Start one bound server with absolute paths:

```text
<python> <root>/ml/infer_server.py
  --weights <absolute-checkpoint>
  --socket <attempt-root>/infer.sock
  --device cuda:0
  --window-ms 2
  --max-batch 512
  --stats-interval 5
```

The execution-lock verifier requires the socket path to be absent before launch. After all shard
processes finish but before server shutdown, a new adapter connection performs a final info handshake
and must reproduce the initial served checkpoint SHA/path/format/dimensions/device/head/horizon binding.
This detects any mid-run SIGHUP checkpoint reload. The narrow snapshot client requests logits and p30 in
the same wire frame and therefore issues exactly one scoring round trip per decision.

Run sixteen collector processes concurrently, one per fixed shard, all against that socket. Every process
writes to a distinct new-only shard directory and stdout/stderr file. Each collector uses the same adapter,
config, catalog, server, and provider binding. Abort the whole attempt on the first nonzero collector exit;
never splice partial shards.

After all 512 games complete:

1. Shut down the server once and record its serving/shutdown evidence.
2. Verify all 16 `collection.json` records and exact seed union.
3. Bounded-merge only `features/snapshots.jsonl` into one strictly sorted feature file. Do not open target
   files.
4. Run the committed freezer once with smoke quotas `recovery=1375`, `late=6875`, `mid=3438`,
   `early=2063`, generation-1 PCG64 order, and global caps. A successful exact selection proves each floor.
5. Delete only the disposable shard target artifacts by their lexically bound paths without opening or
   hashing them, then run the freezer's `verify --ledger` path and require all bound feature, selection,
   output, and ledger hashes to remain valid. The freezer `freeze` command still runs exactly once. This
   is the target-deletion invariance check. Also run at least 1,000 deterministic trace-prefix
   verifications selected by the execution-lock RNG; these checks read feature/trace data only.
6. Produce a target-blind report with raw rows/band, globally selectable floors, per-game rows, structural
   duplicates, recovery reason overlaps/boundaries, trace share, peak scratch, throughput, runtime, server
   batches, and provenance. Validate it in scratch, then copy it new-only to the bound durable report path
   and verify matching bytes and SHA-256 before declaring success.

The registered B1 collection remains closed even if the smoke passes. Opening it requires a separate
immutable registered authorization after smoke evidence is committed and Fable-reviewed.

## 6. Failure and retry

No outcome-dependent retry, partial repair, seed substitution, backfill, or attempt splicing. A semantic,
replay, hidden-information, provenance, or safety fault closes this smoke protocol. An identical full-range
attempt 2 is possible only for immutable attempt-1 `server-start`/90 or trapped `process-interrupted`/92
evidence when no collection report exists, using a new Fable-reviewed retry lock and unique paths. There is
no third attempt. The bound orchestrator is the sole producer of these failure classes: it maps failure
before the server readiness line to exit 90, traps SIGINT/SIGTERM after launch but before any
`collection.json` to exit 92, and maps every other error to exit 1. A retry verifier rejects 90/92 if any
primary shard `collection.json` exists.

## 7. Required pre-launch verification

- Adapter/config/collector/unit tests and full engine check pass.
- A no-game live handshake proves the exact provider binding on SimForge.
- That handshake starts the server under the exact stripped five-key child environment bound for the
  smoke.
- The Fable high review of this plan is `PASS`, and the final reviewed file hashes are bound.
- Lane B protocol still validates with all 38 registered ranges closed.
- The seed inventory verifier proves `962000000..962000511` disjoint.
- The storage probe and execution-lock verifier pass.
- GPU 7 and `/dev/shm` checks pass; GPUs 4-6 are untouched.
- The orchestrator records GPU-7 UUID/memory/utilization immediately before spawning the server and
  fails unless memory and utilization are both zero; this check is inside the consumed-lock launch path.
- No Phase 2 outcome or target shard is inspected.

Only then may the single unregistered density smoke begin.
