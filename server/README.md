# Arc Spirits room server (M0b)

A long-lived Node process that replaces the HTTP/serverless play transport with a
WebSocket server holding **one authoritative in-memory `PublicGameState` per room**. The
deterministic rules engine (`src/lib/play`) is invoked in-process; state is snapshotted
back to Supabase so the server stays stateless-restartable.

## Run

```bash
npx tsx server/index.ts          # PORT=8787 by default
node server/smoke.mjs            # end-to-end smoke against a local instance
npx tsx server/botGameBench.ts   # in-process 4-bot game wall-clock (vs HTTP baseline)
npx tsc -p server --noEmit       # standalone typecheck
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
| `SNAPSHOT_INTERVAL_MS`      | dirty-snapshot cadence (default 5000)          |
| `ROOM_IDLE_EVICT_MS`        | idle no-socket eviction (default 60000)        |
| `ARC_WS_BOT_TICK_MS`        | in-process bot/deadline tick cadence (default 1300, matches the old client timer) |
| `ARC_EXPERT_BOTS`           | `1` upgrades neural bots to the search tier (mirrors botSim) |
| `ARC_LIVE_BOT_TEMP`         | live bot sampling temperature (default 0.65; 0 = argmax) |
| `ARC_WS_ALLOW_DEBUG_SEED`   | `1` enables `POST /debug/seed[-bots]` (smoke only) |

Secrets are only ever read into `process.env`; nothing is logged.

## Architecture

```
index.ts        http server (GET /healthz, dev POST /debug/seed[-bots]) + WS upgrade + shutdown
connections.ts  RoomRegistry: socket lifecycle, per-connection viewer-filtered views,
                join auth, delta broadcast, heartbeat-timeout, snapshot/evict sweep
roomHost.ts     RoomHost: in-memory state, serialized command queue, deadline stamping,
                snapshot persistence, and the live tick loop (deadline + bots)
bots.ts         in-process bot driving — reuses the engine policy (botPolicy + neuralBot),
                applies through the host queue (no per-command DB write)
deadline.ts     stampPhaseDeadline / applyNavLockDeadline / deadlinePassed (ported)
view.ts         buildViewForViewer (buildRoomViewV2 + synchronous bot-seat-flag stamping)
identity.ts     viewer/actor derivation (ported from service.ts)
supabase.ts     service-role + anon clients, session/member/bot reads, snapshot write
catalog.ts      PlayCatalog loader (port of fetchAssetsData + buildPlayCatalog)
botGameBench.ts in-process 4-bot game wall-clock bench (vs the HTTP baseline)
env.ts          zero-dep dotenv loader
protocol.ts     the committed wire contract (do not edit)
```

## Bots + deadlines (M0e)

`RoomHost.start()` runs an in-process timer (`ARC_WS_BOT_TICK_MS`, default 1300 — the old
client `/bots/tick` cadence). Each tick, per room: (1) enforce a passed wall-clock
deadline (`applyDeadlineAdvance`, fires even with zero connected sockets); (2) advance
every seated bot through the current phase via the SAME engine policy the HTTP path uses
(`botSeatNeedsToAct` + `planNeuralPhaseActions`/`planUniformLegalPhaseActions`), applied
through the in-memory queue — no per-command Supabase write; (3) **bot-blocked
fast-forward**: when a non-navigation phase is held up ONLY by bots (no human still
choosing) and they made no progress, enforce the deadline immediately instead of idling to
the wall clock. Same final game state the deadline would have produced, minus the dead
wait — this is what turns a minutes-long bot game into seconds. Navigation keeps its normal
deadline / back-out grace so a human's lock window is never cut short. Any revision advance
from the tick broadcasts a delta to every connection.

Identity mirrors the HTTP routes: `memberToken` (member UUID) → the upgrade
`arc_spirits_play_member_<CODE>` cookie → `authToken` (Supabase bearer → user →
membership by user). Snapshots read/write `arc_spirits_2d.play_game_sessions`
(`public_state` jsonb, `revision`, `status`, `started_at`/`ended_at`); members come from
`arc_spirits_2d.play_session_members`. No revision CAS is used — the room host is the
single in-memory writer, so it always persists the freshest revision.
