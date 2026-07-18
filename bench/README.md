# Arc Spirits transport benchmarks

BEFORE baselines for the serverless-HTTP + Supabase-Realtime play transport, captured
so the WS room server can be measured against the same scripts (AFTER numbers).

Every script talks to the **public play HTTP API** the real clients use, writes a JSON
result to `bench/results/<YYYY-MM-DD>-<name>.json`, and prints a summary table. All accept
`--base=<url>` (default `https://arcspirits.com`) so the same script can later target the
WS server: `node bench/action-latency.mjs --base=http://localhost:8787`.

No build step — plain Node ESM (`.mjs`). Requires Node 18+ (uses global `fetch`).
`@supabase/supabase-js` (already a repo dependency) is used only by `update-propagation`.

## Local release gates

`npm run gate:human-loop` owns an isolated loopback auth/store emulator, builds
and previews the production web bundle, starts the authoritative room server,
then drives `e2e/play-full.spec.ts`. The two human players run in separate
Chromium processes, and every in-game choice is a rendered control activation;
setup alone uses authenticated APIs. The gate refuses skips and proves all owned
ports close on exit. It never contacts or mutates production.

`npm run gate:mixed-full-games` owns the same isolated production-preview stack
and pairs one Chromium player with one native Godot player in each room. Setup is
authenticated API traffic; every in-game action is a rendered control activation.
It runs three fresh games through the natural round-30 terminal, records both
clients' revision/state-hash traces, rejects any command failure or test-only phase
advance, and writes `bench/results/<date>-mixed-full-games.json`. The gate never
contacts production and proves all owned ports close when it exits.

## How auth works

Headless Node has no cookie jar, so these scripts authenticate the way the **Capacitor
shell** does — a VALIDATED Supabase identity carried as a Bearer token:

1. `createIdentity(base)` reads `/api/play/config` for the store's URL + anon key and
   creates an **anonymous account** (`POST <supabase>/auth/v1/signup`) — the same
   one-tap guest identity the web client mints. The returned `access_token` is the
   only credential.
2. Every play call sends `Authorization: Bearer <token>`. The public `member.id` in
   responses is a seat label only — it never authorizes anything, there are no room
   secrets/cookies, and nothing rides a URL.
3. The WS bench additionally mints a short-lived ONE-USE join ticket per connection
   from `POST /api/play/sessions/<code>/ws-ticket` (authenticated, no-store) and
   joins `ws(s)://…/ws` with `{t:'join', roomCode, ticket}`.

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
