# Arc Spirits room server

A long-lived Node process serving the play WebSocket transport. Since the 2026-07-10
multiplayer-authority batch the in-memory `PublicGameState` per room is a **latency
cache, not an authority**: every mutation (player command, bot move, deadline
enforcement) commits through the SAME durable revision-CAS protocol the HTTP path
uses (`src/lib/play/server/commit.ts`) **before** it is acknowledged or broadcast.
One durable, monotonically revisioned history per room — regardless of transport,
instance count, retries, or process kills. `cmdId` is a durable, IDENTITY-BOUND
exactly-once boundary: an honest retry after a lost ack (including WS→HTTP
fallback) is answered from the ledger with the current view + `duplicateOfRevision`;
the same cmdId re-used with a different actor/type/payload rejects as
`idempotency_conflict`. The terminal/mirror/history side effects ride each commit
as a durable `$effects` outbox event and are drained (and crash-recovered) on both
transports.

**Deployment ordering: apply `supabase/migrations/20260710_command_ledger.sql`
AND `supabase/migrations/20260710_ranked_finalize.sql` BEFORE serving live
traffic.** The server FAILS CLOSED without them — commands are rejected with
`store_not_ready` (HTTP 503 on the SvelteKit path) because the pre-migration
non-atomic commit cannot promise exactly-once, and the terminal ranked effect
refuses to run without the `finalize_match` transaction (the durable outbox row
is retained and retried; game flow is unaffected) because the legacy five-statement
finalize could double-apply ratings across a crash or concurrent drains. Both
fallbacks exist only behind the explicit `ARC_ALLOW_NONATOMIC_COMMIT=1` opt-in
(local dev / migration tests) and never engage silently.

## Run

```bash
npx tsx server/index.ts             # PORT=8787 by default
node server/smoke.mjs               # end-to-end smoke against a local instance
npx tsx server/authoritySmoke.ts    # authority/recovery smoke + measured latency
                                    #   (local store emulator, both commit modes;
                                    #    add --live for the .env Supabase)
npx tsx server/botGameBench.ts      # in-process 4-bot game wall-clock (vs HTTP baseline)
npx tsc -p server --noEmit          # standalone typecheck
npm test                            # vitest — includes server/roomHostAuthority.test.ts
```

Both smokes can run with **zero Supabase reachability** via the local PostgREST
emulator (`server/pgrestEmu.ts`):

```bash
npx tsx server/pgrestEmu.ts --listen 8095 --rpc &   # --rpc = post-migration (production posture)
PUBLIC_SUPABASE_URL=http://127.0.0.1:8095 SUPABASE_SERVICE_ROLE_KEY=local-emu \
PUBLIC_SUPABASE_ANON_KEY=local-emu ARC_WS_CATALOG_FILE=$PWD/ml/catalog.json \
node server/smoke.mjs
# pre-migration store (no --rpc) additionally needs ARC_ALLOW_NONATOMIC_COMMIT=1,
# otherwise commands fail closed with store_not_ready (by design).
```

## Env contract

Read from `.env` / `.env.local` (repo root) then `server/.env` (override), or the real
shell env (which always wins). Same var names the SvelteKit app uses:

| var                         | purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `PUBLIC_SUPABASE_URL`       | Supabase project URL                           |
| `SUPABASE_SERVICE_ROLE_KEY` | session/member reads + snapshot writes         |
| `PUBLIC_SUPABASE_ANON_KEY`  | read-only asset catalog + authToken user lookup |
| `PORT`                      | listen port (default 8787)                     |
| `ROOM_IDLE_EVICT_MS`        | idle no-socket eviction (default 60000)        |
| `ARC_WS_CATALOG_FILE`       | optional canned PlayCatalog JSON (offline/dev; e.g. `ml/catalog.json`) |
| `ARC_WS_BOT_TICK_MS`        | in-process bot/deadline tick cadence (default 1300, matches the old client timer) |
| `ARC_EXPERT_BOTS`           | `1` upgrades neural bots to the search tier (mirrors botSim) |
| `ARC_LIVE_BOT_TEMP`         | live bot sampling temperature (default 0.65; 0 = argmax) |
| `ARC_WS_ALLOW_DEBUG_SEED`   | `1` enables `POST /debug/seed[-bots]` (smoke only) |
| `ARC_ALLOW_NONATOMIC_COMMIT` | `1` opts into the pre-migration non-atomic commit fallback. Honored ONLY under a development/test `NODE_ENV`; `NODE_ENV=production` (and any other tier) refuses it UNCONDITIONALLY and a missing `commit_room_command` RPC stays a `store_not_ready` readiness error |
| `ARC_WS_AUTH_LEASE_MS`      | authenticated-socket lease (default 900000). Validated at startup: a non-integer or out-of-bounds value (30000–86400000) REFUSES to boot in production and falls back to the default elsewhere — a malformed value can never mean "infinite lease" |

Secrets are only ever read into `process.env`; nothing is logged.

## Architecture

```
index.ts        http server (GET /healthz → {ok,rooms,connections,roomLoads,uptime},
                dev POST /debug/seed[-bots]) + WS upgrade + shutdown
connections.ts  RoomRegistry: socket lifecycle, per-connection viewer-filtered views,
                single-load dedup for concurrent cold joins (in-flight promise map),
                join auth (durable-truth refresh on join/resync), delta broadcast,
                heartbeat-timeout, idle eviction (nothing to flush: acked = durable)
roomHost.ts     RoomHost: write-through cache over the durable revision-CAS commit
                (src/lib/play/server/commit.ts) — ack-after-durable, identity-bound
                cmdId dedup, per-attempt actor re-derivation from state, reload-and-
                reapply on CAS miss, batched tick commits (deadline + bots), durable
                effects outbox drain (mirrors / match finalize / round history)
bots.ts         in-process bot planning — reuses the engine policy (botPolicy + neuralBot);
                the tick batches every bot command into ONE durable commit
deadline.ts     stampPhaseDeadline / applyNavLockDeadline / deadlinePassed (ported)
view.ts         buildViewForViewer (buildRoomViewV2 + synchronous bot-seat-flag stamping)
identity.ts     viewer/actor derivation (ported from service.ts)
supabase.ts     service-role + anon clients, session/member/bot reads, session-head poll
                (NO unconditional snapshot writer — every write is CAS-fenced)
catalog.ts      PlayCatalog loader (assets fetch, or ARC_WS_CATALOG_FILE override)
pgrestEmu.ts    local PostgREST emulator (test infra; both commit modes)
authoritySmoke.ts  live authority/recovery smoke + measured ack/delta latency
roomHostAuthority.test.ts  vitest acceptance suite (fencing, exactly-once, recovery,
                mixed-transport revision+stateHash, privacy, latency floor)
botGameBench.ts in-process 4-bot game wall-clock bench (persistence disabled)
env.ts          zero-dep dotenv loader
protocol.ts     the committed wire contract (do not edit)
```

## Durable authority (2026-07-10)

Every mutation follows one protocol, shared verbatim with the SvelteKit HTTP path:

1. re-derive the actor's seat from the CURRENT authoritative state (the state is
   the sole seat authority — a presented/mirrored seat is advisory only), then
   apply the command with the deterministic engine (deep-clone, never in place);
2. commit atomically via the `commit_room_command` RPC:
   `UPDATE play_game_sessions … WHERE id=? AND revision=?` + the
   `play_game_session_events` ledger rows carrying the client `cmdId` + a durable
   `$effects` outbox event listing the side effects this commit owes. Strict
   monotonicity is enforced at every layer (commit.ts, the RPC, and a DB trigger):
   the next revision must EXCEED the fenced base — an equal-revision rewrite is
   structurally impossible. Without the migration the commit FAILS CLOSED
   (`store_not_ready`) unless `ARC_ALLOW_NONATOMIC_COMMIT=1` explicitly opts into
   the non-atomic pre-migration fallback (local/test only);
3. only then ack / broadcast, after draining the effects outbox (member mirrors,
   match finalization, round-history snapshots — all idempotent; a failure leaves
   the durable outbox row for recovery, which also runs on room load and on
   duplicate-retry handling, so a SIGKILL between commit and effects never loses
   them). Match finalization itself is ONE `finalize_match` database transaction
   (anchor claim on `match_results` UNIQUE(session_id) + locked, verified rating
   bases), so ranked ratings/events/results converge exactly once across crashes,
   retries and concurrent drains from independent processes.

A CAS miss means another writer (HTTP request, another instance, room close) owns
that revision: the host reloads the durable row, RE-DERIVES the actor's seat from
the fresh state (a concurrent release/takeover defeats a stale seat identity) and
re-applies. The tick loop also polls the session head each cycle, so HTTP-committed
mutations reach WS clients within one tick, and joins/resyncs force the same
convergence. Revision can only grow; equal/stale-revision overwrites are
structurally impossible (validated in commit.ts, raised in the RPC, and refused by
the `play_game_sessions_revision_monotonic` trigger). A duplicate cmdId retry acks
the CURRENT revision/view plus `duplicateOfRevision` (the ack's revision always
matches its view); a cmdId re-used with a different actor/command rejects as
`idempotency_conflict`. `projection.stateHash` (canonical content hash, jsonb-safe)
lets any two clients verify they are on the same history at the same revision.

## Bots + deadlines (M0e)

`RoomHost.start()` runs an in-process timer (`ARC_WS_BOT_TICK_MS`, default 1300 — the old
client `/bots/tick` cadence). Each tick, per room: (1) enforce a passed wall-clock
deadline (`applyDeadlineAdvance`, fires even with zero connected sockets); (2) advance
every seated bot through the current phase via the SAME engine policy the HTTP path uses
(`botSeatNeedsToAct` + `planNeuralPhaseActions`/`planUniformLegalPhaseActions`); (3)
**bot-blocked fast-forward**: when a non-navigation phase is held up ONLY by bots (no
human still choosing) and they made no progress, enforce the deadline immediately instead
of idling to the wall clock. Same final game state the deadline would have produced, minus
the dead wait — this is what turns a minutes-long bot game into seconds. Navigation keeps
its normal deadline / back-out grace so a human's lock window is never cut short. The
WHOLE tick (deadline + every bot command) is batched into ONE durable CAS commit; any
revision advance then broadcasts a delta to every connection. Two ticking writers (a
second instance, or the HTTP opportunistic enforcement) are fenced by the CAS — exactly
one wins, the loser reloads.

Identity: the ONLY join credential is a short-lived, ONE-USE, room-scoped ticket
(`src/lib/play/server/wsTickets.ts`) minted by the authenticated SvelteKit endpoint
`POST /api/play/sessions/<code>/ws-ticket`; the server stores only a SHA-256 digest,
consumes it atomically (replays lose), and verifies its exact (room, user, member,
permission) binding against current rows. No durable credential — no account token,
no room secret, no cookie — ever crosses this boundary; failures close the socket
fatally (never a silent spectator downgrade). The upgrade is accepted ONLY at the
exact `/ws` path, browser Origins must pass the `ARC_WS_ALLOWED_ORIGINS` allowlist
(origin-less native/test clients still need tickets), frames are capped at
`MAX_CLIENT_FRAME_BYTES`, and every command passes the SAME deny-by-default
admission policy as HTTP (`src/lib/play/server/commandPolicy.ts`) before the
reducer. State reads/writes go to `arc_spirits_2d.play_game_sessions`
(`public_state` jsonb, `revision`, `status`, `started_at`/`ended_at`); members come from
`arc_spirits_2d.play_session_members`; the command ledger is
`arc_spirits_2d.play_game_session_events`. Every write is fenced by the revision CAS —
the old single-writer/no-CAS snapshot model is gone (it allowed a stale instance or a
crash-rollback to fork the room).
