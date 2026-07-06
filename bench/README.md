# Arc Spirits transport benchmarks

BEFORE baselines for the serverless-HTTP + Supabase-Realtime play transport, captured
so the WS room server can be measured against the same scripts (AFTER numbers).

Every script talks to the **public play HTTP API** the real clients use, writes a JSON
result to `bench/results/<YYYY-MM-DD>-<name>.json`, and prints a summary table. All accept
`--base=<url>` (default `https://arcspirits.com`) so the same script can later target the
WS server: `node bench/action-latency.mjs --base=http://localhost:8787`.

No build step — plain Node ESM (`.mjs`). Requires Node 18+ (uses global `fetch`).
`@supabase/supabase-js` (already a repo dependency) is used only by `update-propagation`.

## How auth works (needed by the WS server task)

Headless Node has no cookie jar, so these scripts authenticate the way the **Capacitor
shell** does — not the web cookie way:

1. `POST /api/play/sessions {displayName}` (create) or `POST .../join` returns a `RoomView`
   whose `member.id` is the caller's session-member id. (It also sets an httpOnly cookie,
   which we ignore.)
2. Every subsequent call passes that id back in the **`x-play-member`** request header.
   `/view` additionally accepts it as a `?member=<id>` query param.

Server side this is `getRoomMemberId(cookies, roomCode, request)` →
`getRoomMemberHeader` (header `x-play-member`) in `src/lib/play/server/cookies.ts`. The
commands / claim-seat / start / bots / view endpoints all honour it. No login, no Supabase
auth token — the member id **is** the room credential (unguessable UUID, scoped to one room).

Room/bot setup mirrors `e2e/helpers.ts` and `src/lib/play/server/botSim.ts`:
create → `bots/fill {targetSeats,difficulty}` → `start` → `bots/tick` (host-only).

## Scripts

| script | measures | key flags |
|---|---|---|
| `action-latency.mjs` | command → server ack round-trip (HTTP + Supabase CAS write) | `--samples=200` |
| `update-propagation.mjs` | client-A commit → client-B Realtime broadcast + `/view` refetch | `--samples=100` |
| `payload-size.mjs` | bytes of the full `/view` projection refetched per revision (raw + gzip) | — |
| `bot-game.mjs` | full 4-bot game wall-clock + server per-tick processing | `--seconds=900 --navMs=2000 --interval=0` |

```bash
node bench/action-latency.mjs
node bench/update-propagation.mjs
node bench/payload-size.mjs
node bench/bot-game.mjs
```

### What each script does

- **action-latency** — creates a lobby room and sends N `setNavigationTimer` toggles
  (host-only, lobby-only, always legal, every call bumps the revision), recording per-command
  wall-clock ms. It exercises the real load→reduce→CAS-write→broadcast path. Lobby state is
  smaller than mid-game, so this is a **floor** for command latency.
- **update-propagation** — a second logical client subscribes to the Supabase Realtime
  channel `room:<CODE>` (event `sync`) exactly like `playStore.svelte.ts`. Client A commits;
  we time from A's ack (new revision known) to B receiving the broadcast, refetching `/view`,
  and parsing a projection at revision ≥ committed. Excludes the store's 80 ms refresh-debounce.
- **payload-size** — captures the `/view` byte size at an empty lobby and at a live game
  (4 bots, round 1), raw and gzipped. This is the per-revision refetch cost a delta WS
  protocol would shrink.
- **bot-game** — drives a 4-neural-bot game to a natural finish headlessly via `/bots/tick`
  (no browser needed — a tick is a plain authenticated POST). Reports the full-game wall-clock
  and the server per-tick processing distribution. See the finding below.

## Baseline finding: full bot game is server-per-tick-bound, not transport-bound

A full 4-bot game **is** measurable headlessly. Phases auto-advance as soon as every bot has
acted (`autoAdvanceResolution` + the all-locked navigation grace in `src/lib/play/phases.ts`),
so the game does **not** wait out the per-phase wall-clock deadlines — it runs a round every
few ticks to a natural finish (`VP_TO_WIN=30` or `MAX_ROUNDS=30`, `src/lib/play/types.ts`).

The dominant cost is **server per-tick processing, not the network**: each `/bots/tick` loads
state, runs the neural policy for up to 4 bot seats, and writes **each** resulting command as
its own sequential Supabase compare-and-set round-trip (many commands per tick). One tick
therefore costs several seconds server-side, and a whole game is minutes of compute. That is
the bot-driving cost the host browser pays today and a clear target for the in-process WS
server (tick bots in memory, no per-command DB write). The transport-relevant number is
`perTickMs`; `run.fullGameSeconds` is the end-to-end wall-clock when the game finishes.

## Prod etiquette

Sequential requests, one client, throwaway rooms. There is no rate limit on `/commands`
(only room-create 8/min and join 30/min per IP). Rooms auto-close when abandoned.
