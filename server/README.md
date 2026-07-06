# Arc Spirits room server (M0b)

A long-lived Node process that replaces the HTTP/serverless play transport with a
WebSocket server holding **one authoritative in-memory `PublicGameState` per room**. The
deterministic rules engine (`src/lib/play`) is invoked in-process; state is snapshotted
back to Supabase so the server stays stateless-restartable.

## Run

```bash
npx tsx server/index.ts          # PORT=8787 by default
node server/smoke.mjs            # end-to-end smoke against a local instance
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
| `ARC_WS_ALLOW_DEBUG_SEED`   | `1` enables `POST /debug/seed` (smoke only)    |

Secrets are only ever read into `process.env`; nothing is logged.

## Architecture

```
index.ts        http server (GET /healthz, dev POST /debug/seed) + WS upgrade + shutdown
connections.ts  RoomRegistry: socket lifecycle, per-connection viewer-filtered views,
                join auth, delta broadcast, heartbeat-timeout, snapshot/evict sweep
roomHost.ts     RoomHost: in-memory state, serialized command queue, deadline stamping,
                snapshot persistence, tick() seam
view.ts         buildViewForViewer (buildRoomViewV2 + synchronous bot-seat-flag stamping)
identity.ts     viewer/actor derivation (ported from service.ts)
supabase.ts     service-role + anon clients, session/member/bot reads, snapshot write
catalog.ts      PlayCatalog loader (port of fetchAssetsData + buildPlayCatalog)
env.ts          zero-dep dotenv loader
protocol.ts     the committed wire contract (do not edit)
```

Identity mirrors the HTTP routes: `memberToken` (member UUID) → the upgrade
`arc_spirits_play_member_<CODE>` cookie → `authToken` (Supabase bearer → user →
membership by user). Snapshots read/write `arc_spirits_2d.play_game_sessions`
(`public_state` jsonb, `revision`, `status`, `started_at`/`ended_at`); members come from
`arc_spirits_2d.play_session_members`. No revision CAS is used — the room host is the
single in-memory writer, so it always persists the freshest revision.

## What M0e adds

`RoomHost.tick()` is the seam for **deadline enforcement** (auto-advance a phase past its
server-clock `phaseDeadline` via `applyDeadlineAdvance`) and **bot ticking**. The sweep
already calls `tick()` on every room each cycle and `onServerAdvance()` is wired to
broadcast; M0e fills the body. Bots are NOT implemented here.
