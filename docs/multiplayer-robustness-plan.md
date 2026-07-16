# Multiplayer Robustness Plan — disconnects, refreshes, leaving

> Authored 2026-06-16.
> Scope: the `play` multiplayer system — SvelteKit 2 + Svelte 5 on Vercel, Supabase
> Postgres, SSE-polling sync. Goal: a game can never permanently stall on a player who
> disconnects, refreshes, or leaves — and state never corrupts when they do.
>
> **Status: P0 implemented & verified (2026-06-16)** — `npm run check` 0 errors,
> `vitest` 339 passing (incl. `src/lib/play/deadlineEnforcement.test.ts`). No DB
> migration required (the new `phaseDeadline` lives inside the `public_state` jsonb;
> `last_seen_at` already existed). P1/P2 remain to do. See §5 / §8 for details, and the
> changelog at the bottom.

---

## 1. TL;DR

The entire liveness / timeout / bot system is **client-driven, and specifically
host-browser-driven, with no server authority.** Every stall traces back to one root cause:

- The only thing that can advance a phase past a silent player is the **host's browser**
  calling the host-only `forceAdvancePhase`.
- The 60s navigation deadline is stamped server-side but **enforced only by the host's
  browser** (the pure reducer can't read the clock). The other phases have **no deadline at
  all**.
- **Bots are driven by the host's browser** `setInterval`. Host tab closes → all bots freeze.
- **Seats can't be released mid-game** (`releaseSeat` is lobby-only), reclaimed, or bot-filled.
- `last_seen_at` is **written but never read**, and is bumped for *all* members on every
  command — so today it can't even tell us who is online.

**The fix:** make the server authoritative for timeouts and bot driving by *piggybacking on
existing server touchpoints*. Vercel has no always-on process, but every connected client
already pings the server ~1s via the SSE poll (`loadRoomView`) and on every command
(`runRoomCommand`). We hang **opportunistic enforcement** off those two hooks: per-phase
deadlines + a host-independent bot nudge, made concurrency-safe by the **existing CAS on
`revision`** (single winner). Plus a **zero-clients floor** (lazy fast-forward on the next
visit) for the case where nobody is polling at all.

This removes the host as a single point of failure for stalls with **near-zero new
infrastructure**.

---

## 2. How it works today (verified against code)

| Concern | Mechanism | File |
|---|---|---|
| Sync | Server-side `setInterval(1000)` per client → `loadRoomView()` → SSE `snapshot` only when `revision` changes. One interval **per connected client**. No heartbeat, no resume. | `routes/api/play/sessions/[roomCode]/events/+server.ts` |
| Commands | `runRoomCommand()` = optimistic-concurrency **CAS loop** on `revision` (≤6 immediate retries, no backoff). Deliberately ignores client `expectedRevision`. | `lib/play/server/service.ts:448` |
| CAS persist | `UPDATE … WHERE id=? AND revision=?`; returns `null` on miss → retry. | `service.ts:289‑304` |
| Identity | Per-room `httpOnly` cookie holds `memberId` (30d). Refresh rehydrates via `+page.server.ts` load. | `lib/play/server/cookies.ts` |
| Presence | `last_seen_at` bumped as a **side effect** of `loadRoomView` (the SSE poll) **and** for *all* members in `syncMemberMirrors` on every command. **Nothing reads it.** | `service.ts:181, 201` |
| Phase gate | `allActiveSeatsReady()` requires **every** seat in `activeSeats` (frozen at game start) to have `phaseReady=true`. | `lib/play/phases.ts:30‑32` |
| Nav deadline | `navigationDeadline = Date.now()+60000` stamped server-side; **enforced only by host's browser** firing host-only `forceAdvancePhase`. | `service.ts:487`, `GameBoard2D.svelte`, `runtime.ts` |
| Straggler rescue | Pure `forceAdvancePhase` (phases.ts:246) shoves phases + auto-readies. **The pending-draw / pending-reward drain is NOT in the pure fn** — it lives in the `forceAdvancePhase` *command* case in `runtime.ts:1422‑1435`. | `phases.ts:246`, `runtime.ts:1422` |
| Bots | Members tagged by `🤖 ` display-name prefix (no `is_bot` column). Driven by **host browser** `setInterval(1300)` → `POST /bots/tick` (host-cookie-gated). | `lib/play/server/botSim.ts`, `[roomCode]/+page.svelte:122` |
| Seats | `claimSeat` / `releaseSeat` are **lobby-only**. `activeSeats` never shrinks. Bots can only be added in lobby. | `runtime.ts:662‑708` |

DB schema (Supabase schema `arc-spirits-game-history`, RLS on):
`play_game_sessions(id, room_code, game_id, status, revision, scenario, public_state jsonb,
created_at, updated_at, started_at, ended_at)`,
`play_session_members(id, session_id, display_name, role, seat_color, selected_guardian,
private_state, created_at, joined_at, updated_at, last_seen_at)`,
`play_game_session_events(id, session_id, revision, actor_member_id, command_type,
command_payload, created_at)`. No `is_bot` / `disconnected_at` / `left_at` columns.

---

## 3. Failure matrix (what breaks today)

| Event | Navigation | Encounter / Location / Cleanup | Bots present | Host leaves |
|---|---|---|---|---|
| **Tab close / crash / network drop (seated player)** | Phase waits for their lock forever unless host force-advances. Host gone → stall forever. | `allActiveSeatsReady` never true → **stall forever**. Seat can't be freed or bot-filled mid-game. | If a **bot** seat is blocked and host is gone, bots are frozen → stall. | Host's seat un-readies **and** all bots freeze **and** force/nav-expire die. Solo host-vs-bots → frozen until they return. |
| **Refresh / reload** | Rehydrates via cookie (OK). In-flight command may be lost; brief dual-stream window; `phaseReady` flags not reset. | Same. | Host refresh: bot `setInterval` lost during reconnect window; may tick on stale state. | — |
| **Deliberate leave** | `leaveRoom()` calls lobby-only `releaseSeat`, which **fails mid-game** and the error is swallowed → seat dangles. | Same → ghost seat blocks advance permanently. | — | No host migration; room becomes a zombie. |
| **All clients disconnect** (1-human-vs-bots: human closes tab) | **Frozen forever** — no poll, no command, nothing drives anything. | Same. | Same. | Same. |

Plus a correctness gap independent of phase: the **accumulator** commands
(`adjustVictoryPoints/blood/barrier/maxTokens/status`, all raw `+= amount`) are
**non-idempotent**; a manual retry after a lost-but-applied response double-applies (could
hand a player an undeserved win, since `findWinner` keys on `victoryPoints >= VP_TO_WIN`).
Note: `resolveMonsterReward` (nulls `pendingReward`, re-fails `no_reward`) and
`resolveLocationInteraction` (guarded by `actionsUsedThisRound`) are **already idempotent on
retry** — don't waste effort "fixing" them.

---

## 4. Core design: opportunistic server-authoritative enforcement

The single highest-leverage change. Generalize the host-only `forceAdvancePhase` into a
**host-independent, clock-gated** enforcement that any connected client's existing 1s SSE
poll triggers.

```
                 every SSE poll (~1s, any client)         every command
                          │                                    │
                          ▼                                    ▼
                  loadRoomView(room)                  runRoomCommand(room) ── top of attempt loop
                          │                                    │
                          └──────────────┬─────────────────────┘
                                         ▼
                          enforceRoomDeadlines(room)            ← server-clock only
                          if status==='active'
                             && phaseDeadline != null
                             && SERVER now > phaseDeadline:
                                drainPendingBeforeAdvance()      ← shared w/ host command
                                forceAdvancePhaseMachine()       ← reuse straggler logic
                                bump revision
                                re-stamp next phase's deadline
                                persist UNDER EXISTING revision CAS
                          (advance AT MOST one phase per call)
```

**Why it's safe under concurrency (verified):** `persistSessionUpdate` already does
`eq('id').eq('revision', session.revision)` and returns `null` on miss. Two simultaneous
polls past the same deadline both load `revision=Y`, both compute the same transition, both
`UPDATE … WHERE revision=Y`; Postgres serializes them, exactly one row matches, the loser
gets `null` and no-ops. **Single winner, no double-advance** — provided (a) enforce advances
**at most one phase per call** (no while-loop racing the whole round), and (b) the transition
bumps `revision`.

**Two non-negotiable corrections** the adversarial review surfaced:

1. **Server clock only.** Stamp *and* compare `phaseDeadline` with server `Date.now()` only —
   never the client's echoed value. The client copy is display-only (countdown UI). Kills
   clock skew naturally since enforce runs server-side.
2. **Zero-clients floor (see §5 P0-c).** Opportunistic enforcement structurally cannot fire
   when nobody polls. For a 1-human-vs-bots game, the human closing their tab = zero pollers =
   frozen forever — *reproducing the very stall we're removing.* A floor is mandatory, not
   optional.

**Subtlety — multi-phase commands:** a single command can cross multiple phase entries
(`passEncounter → enterLocation`; `enterEncounter` auto-skips to location when no aggressors;
`commitCleanup → beginNavigation`). So: every phase-entry reducer sets `phaseDeadline = null`,
and the **server boundary stamps the FINAL phase after the whole command resolves** (not gated
only on `== null` for an intermediate phase). Otherwise an intermediate phase inherits a stale
deadline (instant spurious advance) or a null one (never expires).

**Subtlety — drain or leak:** the pure `forceAdvancePhase` does **not** return drawn spirits
to bags. Extract `runtime.ts:1422‑1435` into a shared `drainPendingBeforeAdvance(state,
catalog)` and call it from **both** the host command and the enforce path, or a disconnect
mid-summon leaks spirits out of their bag and corrupts bag counts + history.

---

## 5. Phased implementation

### P0 — Make the game un-stallable

**P0-a · Per-phase deadline + opportunistic enforcement** — *closes the silent/disconnected/
missing-player stall in every phase; removes host as a stall SPOF.*

- `engine/types.ts`: add `phaseDeadline: number | null` to `PublicGameState` +
  `SpectatorProjection`. Add `PHASE_DURATION_MS` (navigation 60s exists;
  encounter/location/cleanup default ~120s — see P2 activity-extension). Pure helper
  `phaseDurationMs(phase)`.
- `engine/phases.ts`: every phase-entry fn (`beginNavigation`, `enterEncounter`,
  `enterLocation`, `enterCleanup`) sets `phaseDeadline = null`.
- `engine/runtime.ts`: extract `runtime.ts:1422‑1435` (autoClaim reward + return hand draws +
  clear queue) into shared `drainPendingBeforeAdvance(state, catalog)`; call it from the host
  `forceAdvancePhase` command and the new enforce path.
- `server/service.ts`: new `enforceRoomDeadlines(roomCode)` — load raw state; if
  `status==='active' && phaseDeadline!=null && Date.now() > phaseDeadline`: clone →
  `drainPendingBeforeAdvance` → `forceAdvancePhaseMachine` → bump revision → re-stamp next
  phase deadline → persist under the existing revision CAS; CAS miss ⇒ return (a poller won).
  Append a synthetic event row (`actor_member_id=null`, `command_type='enforceDeadline'`) for
  audit. **Advance at most one phase per call.**
- `server/service.ts`: stamp `phaseDeadline` at the boundary **after the full command
  resolves**, keyed to the final phase (same place `navigationDeadline` is stamped today, but
  fixed for multi-phase commands). Call `enforceRoomDeadlines` at the **top of each
  `runRoomCommand` attempt** and inside `loadRoomView` before projecting.
- `client/GameBoard2D.svelte`: drop the `isHost` gate on the nav-expire auto-fire (server is
  now authoritative); keep the manual force button host-only as an escape hatch. Generic
  per-phase countdown from `phaseDeadline`.

**P0-b · Fix `last_seen_at` to be a real liveness signal** — *enables presence-aware early
advance and future UX; verified nothing reads it today, so safe.*

- `server/service.ts`: in `syncMemberMirrors` **stop** writing `last_seen_at` for all members
  (keep `seat_color`/`selected_guardian`/`role`). Keep `updateLastSeen(member.id)` in
  `loadRoomView` (polling member) and **add** `updateLastSeen(actingMember.id)` in
  `runRoomCommand`. Now `last_seen_at` ticks ~1s only while that member's SSE is open and goes
  stale ~1s after disconnect.

**P0-c · Zero-clients floor (lazy-on-reconnect)** — *closes the all-clients-gone hole that the
opportunistic design cannot reach.*

- Because `+page.server.ts` load → `loadRoomView` already runs `enforceRoomDeadlines`, make
  the **first returning visitor fast-forward all overdue phases**: loop the one-phase-per-call
  enforce until caught up (bounded by phase count × rounds, e.g. max ~50 iterations as a
  guard). Zero infrastructure.
- Residual behavior, stated honestly: a room with **zero pollers stays frozen until someone
  returns**, then snaps to current. For a small private game this is acceptable. (Option B in
  §7 eliminates even this.)

> P0 alone makes the game recover from every disconnect/leave scenario as long as *anyone*
> ever reconnects, and never corrupts state. P1/P2 reduce how often a human notices.

### P1 — Keep bots and connections alive

**P1-a · Host-independent bot driving** — *bots act without the host's tab.*

- `server/service.ts` + `botSim.ts`: `driveRoomBots(roomCode)` called from the same
  `loadRoomView`/`runRoomCommand` hook as enforcement. If `status==='active'` and any seated
  bot `botSeatNeedsToAct`, issue **one** bot seat's `planBotPhaseActions` via `runRoomCommand`,
  then return (one seat per call). Debounce with a `botTickedAt` wall-clock in `public_state`
  (≥1300ms) so N pollers don't all drive — single effective driver per ~1.3s, self-limited by
  CAS.
- `client/[roomCode]/+page.svelte`: remove the host-only `setInterval(1300)` bot loop.
  `bots/tick/+server.ts`: drop the host-only check (or keep as an any-member fast-path) since
  `driveRoomBots` is self-gating and idempotent under CAS.
- Note: bots share the zero-clients hole; the P0-c floor covers them too.

**P1-b · SSE keepalive + active client reconnect + surface drops** — *survive Vercel timeouts;
stop showing a frozen board.*

- `events/+server.ts`: send a comment heartbeat `: ping` every ~15s even when `revision` is
  unchanged, to defeat the idle-proxy timeout.
- **Prerequisite the drafts missed:** there is **no `vercel.json` and no `maxDuration`** — the
  serverless function has a short default duration cap that will hard-kill even an *active* SSE
  stream regardless of heartbeats. Set `maxDuration` for the events route (via `vercel.json` or
  `export const config`), **and/or** accept periodic forced reconnect and lean on the client.
- `client/playStore.svelte.ts`: replace the passive `error` handler (only sets
  `isConnected=false`) with **bounded backoff + jitter reconnect** (1s, 2s, 4s, cap ~15s; reset
  on `open`); add a **watchdog** (no snapshot/heartbeat for >20s ⇒ force reconnect); **stop
  silently dropping** the error snapshot (lines 71‑73) and surface a "Reconnecting…" banner.
  `disconnect()` before each retry to avoid stacked `EventSource`s. Full-state snapshots make
  `Last-Event-ID` unnecessary.

**P1-c · Idempotency for the actually-non-idempotent commands + CAS jitter** — *correctly
scoped.*

- Only the **accumulators** (`adjustVictoryPoints/blood/barrier/maxTokens/status`) need this.
  Add optional `clientRequestId` (uuid) to `GameCommand` + a `client_request_id` column on
  `play_game_session_events` with a partial `UNIQUE(session_id, client_request_id) WHERE NOT
  NULL`. Client generates one id per logical action, reuses it on manual retry. In
  `runRoomCommand`, before the CAS loop, look up by `(session_id, client_request_id)`; if
  found, short-circuit to the current projection. System commands (enforce/bot/force) carry
  `NULL`.
- Add small **backoff + jitter** between the 6 CAS attempts (currently immediate) — polls now
  also write (enforce + bots), so guard real commands against 409 starvation.

### P2 — Make it feel good

**P2-a · Activity-based deadline extension** — *don't steal a thinking human's turn.* On every
accepted command from a not-yet-ready seat, **reset/extend that phase's deadline** at the
server boundary, so only *truly idle* seats get force-advanced. Combine with P0-b presence: if
the only un-ready seats are provably absent (`last_seen_at` stale), advance early (~10s)
instead of waiting the full window. Keep clock reads at the boundary, never in the reducer.

**P2-b · Graceful mid-game leave (vacate-to-bot / auto-ready)** — *closes the ghost-seat
block.* Add a mid-game `vacateSeat` command (distinct from lobby-only `releaseSeat`). It must
**not** shrink `activeSeats` (load-bearing for `findWinner` and history snapshots) — instead
flag the seat absent so the P0 enforce path auto-readies it each phase. Gate any seat→bot
conversion on a **confirmed stale `last_seen_at`** (>~10s) to avoid replacing a mid-reconnect
player; the 30d cookie lets a returning player reclaim their seat. Fix `leaveRoom` to call
`vacateSeat` mid-game. Optional: `navigator.sendBeacon` on `beforeunload` for fast vacate.

**P2-c · Host migration + presence UX** — *lowest priority; P0+P1 already remove host as a
stall SPOF.* Once enforcement and bots are host-independent, host powers shrink to
`startGame` + manual force + bot management. Add single-winner host migration inside the
enforce/CAS path: when the host is confirmed offline, promote the longest-seated online member
(gate on current host still offline to avoid two hosts). Surface per-seat presence
(online/away/offline + isBot) in the projection for presence dots and an "auto-advancing in
Ns" badge. Add an `is_bot` column (backfill from the `🤖 ` prefix) only if/when presence UI or
the cron floor actually ships.

---

## 6. Risks, gotchas & edge cases to test

- **Write-on-read:** enforcement/bot-driving now mutate inside `loadRoomView` (a read path), so
  every spectator poll can write. Acceptable at this scale, but: one-phase / one-bot-seat per
  call, debounce bots (`botTickedAt`), ensure **no edge cache** fronts `/events` or
  `+page.server.ts`, and ship CAS jitter so the amplified write load doesn't 409-starve real
  commands.
- **Multi-phase command stamping** — test `enterEncounter` auto-skip→location and
  `commitCleanup`→`beginNavigation`: assert the freshly-entered phase always has a fresh,
  future `phaseDeadline` (never stale, never null).
- **Disconnect mid-summon** — open a `pendingDraw`, expire the deadline, run enforce: assert
  **bag totals are conserved** (the `drainPendingBeforeAdvance` wiring).
- **Two polls race the same deadline** — assert single advance, revision increments by one.
- **Host == sole player** disconnects — collapses into the zero-clients case; verify
  lazy-on-reconnect fast-forwards correctly on their return.
- **Absent-human seat with a null player object** — `botSeatNeedsToAct` returns false for null
  players, so prefer the `forceAdvancePhase` auto-ready path (sets `phaseReady` directly) over
  routing an absent human through the bot policy.
- **Accumulator double-apply** — simulate a lost-but-applied response + manual retry with the
  same `clientRequestId`; assert VP applied once.

---

## 7. Decisions for you

1. **Zero-clients floor (§5 P0-c):**
   - **(A) Lazy-on-reconnect — recommended.** Zero infra. A room with nobody connected stays
     frozen until someone reopens it, then snaps to current. Fine for private rooms.
   - **(B) `pg_cron` sweeper** (~15-30s) hitting a service-secret-gated `/api/play/sweep` that
     calls the **TS** `enforceRoomDeadlines` + bot nudge (never reimplement phase logic in
     plpgsql). Only worth it if games must **complete unattended**.
2. **Phase durations** — navigation 60s exists; propose encounter/location/cleanup ~120s with
   P2 activity-extension. Tune to taste.
3. **Idempotency scope** — confirm we only harden the accumulator commands (the audit shows
   reward/location are already idempotent).

---

## 8. Suggested order of work

1. **P0-a + P0-b + P0-c** together (one coherent change: server-authoritative enforcement +
   real presence signal + recovery floor). This is the whole "un-stallable" win.
2. **P1-a** (host-independent bots) — small, high value, removes the other host SPOF.
3. **P1-b** (reconnect + keepalive + maxDuration) — UX; stops frozen boards.
4. **P1-c** (accumulator idempotency + CAS jitter) — cheap correctness insurance.
5. **P2** polish (activity extension → graceful leave → host migration / presence UX) as time
   allows.

Each phase is independently shippable and testable against the existing vitest engine suite +
playwright e2e flows.

---

## 9. Changelog

### 2026-07-10 (release hardening) — account-identity trust model + WS tickets + deny-by-default admission

Replaced the unaccepted long-lived per-room `memberSecret` design with a single
coherent trust model and closed the reproduced transport/policy holes. The public
`play_session_members.id` is now a display label ONLY, on every path.

- **Validated Supabase identity is the sole durable human principal.** Every HTTP
  route authenticates via `locals.safeGetSession()` (cookie same-origin; Bearer
  cross-origin) and re-resolves membership per request, so sign-out / account
  transition drops room authority immediately and no browser-stored value can hand
  one user's membership to another. Anonymous accounts (auto-created for one-tap
  guest play) count as validated identities but are never presented as verified
  ranked identities. `createRoom`/`joinRoom`/solo/debug/rematch all require a
  validated user; membership is canonical + idempotent per (session, user)
  (`membership.ts` + the partial unique index in `20260710_identity_trust.sql`) —
  duplicate/concurrent create/join/matchmaking/recovery/rematch converge on one row.
  The credential echo endpoint, room-secret cookies/header, raw `member_secret`
  lookups and the column/mint function are all removed (migration drops them
  if-exists); legacy browser keys are purged on sight. Legacy UNOWNED human rooms
  (no account) have no safe claim path, so they are closed for `security_upgrade`
  (`roomLifecycle.ts`) rather than impersonated.
- **WebSocket join = short-lived, one-use, room-scoped ticket** (`wsTickets.ts`,
  `play_ws_tickets`). The raw ticket is handed out exactly once by the
  authenticated no-store `/ws-ticket` endpoint straight into the join frame; only a
  SHA-256 digest is stored, bound to exact (room, user, member, permission),
  consumed atomically (one conditional UPDATE — replays lose), short expiry, fresh
  ticket per reconnect. The ENTIRE lifecycle is database-clock governed: the app
  submits only the digest + bindings to `mint_ws_ticket` (created/expiry fixed by
  the store's wall clock — `clock_timestamp()`, never the transaction-start
  `now()` — with a 30-second lifetime baked into the SQL body, stored
  expiry returned), redemption runs through `consume_ws_ticket` (no time
  parameter), and hygiene through `cleanup_ws_tickets()` — a skewed application
  clock can neither stretch a lifetime, mint dead-on-arrival, resurrect an expired
  digest, nor sweep a valid one. The TABLE enforces the same invariants for every
  writer via row triggers (rolling-upgrade posture: a legacy service-role instance
  still issuing direct app-clock INSERT/UPDATE/DELETE during a migration-first
  deploy gets its mint clamped to the DB-clock 30-second lifetime, cannot mutate
  bindings/expiry or reset consumption, cannot consume a DB-expired digest, and
  cannot delete anything the database still honors — proven by real-PostgreSQL
  regressions replaying the exact legacy DML shapes). Missing mint/consume
  functions fail CLOSED (no application-timed INSERT/UPDATE fallback). Expired /
  forged / replayed / wrong-room / wrong-user /
  bot-bound / public-UUID inputs FAIL the join fatally — never a silent spectator
  downgrade. Spectator tickets cannot command. No durable credential ever leaves
  the server; the RAW ticket appears in exactly two places — the single
  authenticated `Cache-Control: no-store` mint response and the immediate
  WebSocket join frame it feeds — and nowhere else: never in URLs, logs, storage,
  projections, any other response, fixtures or (verified) compressed Playwright
  traces.
- **One deny-by-default, transport-neutral admission policy** (`commandPolicy.ts`)
  runs on BOTH the HTTP and WebSocket boundaries before any reducer/ledger/outbox
  work; a rejection leaves revision, state hash, ledger, outbox and rating
  unchanged. Casual/ranked players and bots may submit only rules-driven commands
  for their mode + authority; production external callers can never submit
  debugGrant, arbitrary counter/status/resource changes, free spirit flips, dice/mat
  spawning-moving-clearing, commitRound, unsupported market/manual shortcuts, or
  other internal tools (dev/test opt-in only, never in ranked). Ranked rejects every
  host/admin/debug/freeform rescue path including `forceAdvancePhase`; ranked
  finalization QUARANTINES any transcript that somehow contains a forbidden
  integrity command (recorded, never rated). Both transports require the same
  bounded validated cmdId + payload schema. Bot identities are refused over the wire
  (they are server-only actors).
- **Authoritative, central room visibility/admission** (`roomAdmission.ts`). Public
  casual rooms are listable/joinable by policy; private, rematch and ranked rooms
  never leak through browse, postgame, generic join, chat, view, seat, or spectator
  paths (non-members get 404 — existence is not confirmed). Original rematch parties
  converge idempotently on ONE hidden room; outsiders cannot discover or enter it.
  Every authoritative view/queue result truthfully carries mode, visibility, rated
  and bot flags (stamped server-side on both transports). Guest Quick Play is casual
  and unrated; ranked requires a permanent verified identity for every human in the
  party.
- **WS + browser boundary hardening.** The client pins the WS destination to the
  build-time `PUBLIC_WS_SERVER_URL` + exact `/ws` path (query/localStorage overrides
  are dev-only and can never redirect auth); the server accepts the upgrade ONLY on
  `/ws`, enforces a configured browser-Origin allowlist (origin-less native/test
  clients still need tickets), caps frame size (`maxPayload`), and validates the
  runtime frame schema. A socket belongs immutably to one room (a second join is
  fatal and unregisters). Every outgoing ack/delta/resync recomputes viewer, role,
  seat and private fields from the CURRENT authoritative state, so release/takeover/
  reconnect/cross-room joins cannot leak stale owner info; fatal join errors close
  and unregister the connection. Cookie-authenticated mutations get coherent
  Origin + CSRF + content-type protection (`httpGuards.ts` in `hooks.server.ts`) —
  a text/plain smuggle or a foreign (even same-site-sibling) Origin is refused,
  rather than trusting CORS.
- **Emulator + E2E now exercise real anonymous canonical identity.** `pgrestEmu`
  answers browser CORS preflights and models GoTrue anonymous signup; the browser
  E2E establishes a real anonymous account (`resolvePlayIdentity`) before driving
  the API in its own context. The obsolete Quick Play selector + member-cookie auth
  are gone; benches/smoke/fixtures use Bearer identities + one-use tickets. Fixed
  the playStore svelte-check status-narrowing error and both server TypeScript
  errors.
- **Durable adversarial regressions added.** `commandPolicy.test.ts` (tier matrix,
  ranked/prod prohibitions, cmdId/frame/payload schema), `identityTrust.test.ts`
  (ticket one-use/expiry/binding/format, canonical + concurrent membership, admission
  rules, legacy quarantine, CSRF/Origin/content-type), `server/wsBoundary.test.ts`
  (ticket join replay/expiry/wrong-room/account-transition/bot binding, immutable
  socket↔room, frame schema, spectator-can't-command, prod/ranked forbidden
  commands, per-frame viewer recomputation after seat takeover), a ranked
  transcript-quarantine test in `roomHostAuthority.test.ts`, and the rewritten
  `session-journey` E2E (guest Quick Play → casual/unrated/private matchmade room
  never in the public browser; mixed web+wire party finish → member-only postgame →
  hidden rematch convergence with outsider 404 + repeated-join recovery).

Verification: `npm run check` 0 errors; server `tsc` 0 errors; production build OK;
vitest 1139 passed / 68 skipped (incl. new suites, ranked quarantine, real-Postgres
finalize); authority smoke 49/49 (adds ticket boundary + truthful-metadata checks);
legacy WS smoke 31/31; both `session-journey` browser tests + `ws-two-browser`
(real-browser ticket WS join, ~16ms avg cross-propagation, HTTP fallback) pass on
the local pgrestEmu stack; credential scans (source + compressed trace archives)
clean; `git diff --check` clean. Migrations authored, NOT applied externally.

### 2026-07-10 (review follow-up) — ranked finalize: absent-row fencing + frozen terminal outbox payload

Independent review of the ranked-finalize correction below found two unclosed
defects; both are now closed structurally:

- **P0 — FOR UPDATE cannot fence an ABSENT rating row.** Two first-ever ranked
  matches sharing a previously unrated user had no `player_ratings` row to lock:
  both transactions validated the absent base, and their `ON CONFLICT` upserts
  serialized only at write time — the second silently overwrote the first
  (`games_played` stuck at 1, one match's rating lost). `finalize_match` now takes
  a TRANSACTION-SCOPED ADVISORY LOCK per rated user (deterministic user_id order,
  `pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.player_ratings:'||uid, 0))`)
  BEFORE checking any base, fencing absent rows structurally; the loser then fails
  base verification (`stale_ratings`) and its caller re-reads + recomputes. The
  FOR UPDATE locks remain as a second fence against direct writers (bot seeding).
- **The fake's "absent-base race test" was a false proof.** `FakePlayDb`/`PgrestEmu`
  run each rpc body in ONE JS turn — atomicity STRONGER than a real transaction
  schedule — so interleaved-transaction races structurally cannot arise there. Both
  fakes and `matchFinalize.test.ts` now say so explicitly (HONESTY LIMIT), and the
  fake suite's shared-user test is relabeled as caller-retry-protocol coverage only.
- **Real-PostgreSQL acceptance.** New `matchFinalize.pg.test.ts` boots a throwaway
  local cluster (initdb/pg_ctl unix socket; self-skips without the binaries),
  applies the migration twice (idempotency) over deliberately incomplete
  hand-created tables, and proves with DETERMINISTIC held-open transactions
  (pg_stat_activity lock-wait probes, not sleeps): the unrated-shared-user schedule
  blocks at the advisory lock and converges via stale_ratings retry; the
  already-rated schedule likewise; a distilled NO-advisory-lock replica of the
  pre-fix strategy demonstrably LOSES a match on the same schedule (negative
  control — the suite detects the defect); and wall-clock races through the real
  `finalizeMatchUnserialized` converge exactly-once. Requires the new `pg`
  devDependency.
- **P1 — the outbox finalized from drain-time state.** The `matchFinalize` outbox
  effect stored only the session reference; `ended_at` was null at pre-commit, so a
  delayed recovery stamped the RECOVERY wall-clock as the finish time and could
  consume a later state. `computeRequiredEffects` now FREEZES the exact terminal
  inputs (winner, round, per-seat member/name/VP — `FinalizeStateInputs`) plus the
  committed finish timestamp into the payload at the finished transition (riding
  the same atomic commit); drains finalize from the frozen payload. Outbox rows
  written by earlier deploys (no `terminal`) keep the old drain-time behavior.
  New `effectsOutbox.test.ts` proves adversarially: mutated current state
  (different winner/VPs/round) and rewritten session stamps at drain time do not
  leak into `match_results`/ratings; the frozen finish time is recorded; legacy
  rows fall back as documented.
- **Migration hardening for hand-created tables.** The four ranked tables were
  only ever created BY HAND in live projects (no earlier migration defined them),
  so `create table if not exists` cannot be trusted to fix their shape: the
  migration now `alter table … add column if not exists` for every non-key column
  (incl. `player_ratings.bot_profile`, written only by the optional seed script).
  Key columns and the not-null-no-default rating numerics are deliberately
  excluded (a "table" missing those was never a functioning ranked table; failing
  loudly beats fabricating ratings).

### 2026-07-10 (later still) — P0 ranked finalize: cross-process exactly-once terminal effects

The remaining P0 in the authority correction: the terminal ranked effect
(matchFinalize) read ratings, upserted increased ratings, inserted rating events,
and only THEN inserted the match_results anchor — five separate statements. A
crash in that interval, or a concurrent outbox drain from a recovery worker /
second server instance (which the in-process promise map and the upstream room
CAS do not protect), could rerun the match: games_played and mu/sigma applied
twice, duplicate rating events / result / player rows. The repository migrations
also never defined the ranked tables or the unique constraints the code's
exactly-once comments assumed. Closed structurally:

- **One finalize transaction.** New migration
  `supabase/migrations/20260710_ranked_finalize.sql` defines the ranked tables
  (create-if-not-exists; live projects keep their rows — pre-existing duplicates
  are deduplicated) with the exactly-once keys — `match_results
  UNIQUE(session_id)`, `match_result_players UNIQUE(session_id, seat_color)`,
  `player_rating_events UNIQUE(session_id, user_id)`, `player_ratings
  UNIQUE(user_id)` — and a `finalize_match(...)` function that claims the session
  via the anchor key, locks the target rating rows (FOR UPDATE, deterministic
  order), verifies the caller's OpenSkill updates were computed from the CURRENT
  rows (a mismatch raises `stale_ratings`, rolls everything back, and the caller
  re-reads + recomputes — this is what serializes two sessions rating the same
  user), and applies events + ratings + anchor + player rows atomically. A crash
  at any point is a full rollback; a competing finalizer converges on
  `already_finalized` (repairing missing player rows only, never re-touching
  ratings). Partial states left by the LEGACY sequence are detected (existing
  session events, or `player_ratings.last_session_id` = this session) and never
  re-applied.
- **Fail closed.** Without the RPC the effect logs `store_not_ready` and reports
  not-durable — the `$effects` outbox row is retained and retried; game flow is
  untouched (finalize still never throws into it). The legacy non-atomic sequence
  survives only behind the same explicit `ARC_ALLOW_NONATOMIC_COMMIT=1` opt-in as
  the commit fallback, hardened with the partial-attempt markers so local
  crash-and-retry cannot double-apply (truly concurrent independent finalizers
  remain its documented residual — the reason it is opt-in only).
- **Replay codes are race-safe.** `replay_codes` gains a UNIQUE
  (game_id, navigation_count) index (history schema; guarded + deduplicated);
  the select→insert path now treats a unique violation as "another drain won"
  and adopts the winner's code — one logical code per round, always.
- **Fake/emulator parity + adversarial proof.** `fakePlayDb.ts` and
  `pgrestEmu.ts` emulate the new unique keys and the `finalize_match`
  transaction (rpc mode), plus statement/RPC-level failure injection
  (error / crash-before / crash-after). New `matchFinalize.test.ts` (20 tests):
  independent finalizers racing from scratch, crashes before/after the
  transaction, crashes at EVERY intermediate legacy write, shared-user
  cross-session stale-base races, legacy partial-state convergence, fail-closed
  readiness, and concurrent replay-code drains. `roomHostAuthority.test.ts`
  gains the end-to-end pipeline test: ranked finish committed with its outbox
  row, SIGKILL before effects, two instances recover concurrently — rated
  exactly once, outbox settled.

### 2026-07-10 (later) — P0 review corrections: fail-closed, identity-bound, crash-recoverable

Seven review findings against the authority batch below, each closed structurally:

- **Strict monotonicity is structural.** `commit.ts` rejects `next <= expected` and
  incoherent event revisions BEFORE any wire write; the `commit_room_command` RPC
  raises on `p_next_revision <= p_expected_revision` / `p_public_state.revision`
  mismatch / out-of-range event revisions; a new `play_game_sessions_revision_monotonic`
  BEFORE-UPDATE trigger (20260710 migration) refuses ANY revision decrease or an
  equal-revision `public_state` rewrite. Fake + PostgREST emulator enforce the same.
  Regression: current=expected=next with changed state is proven rejected at every
  layer (commit.test.ts + authoritySmoke store-layer checks).
- **cmdId idempotency is identity-bound.** The ledger dedup compares the committed
  (actor_member_id, command_type, payload−cmdId) fingerprint: an honest retry →
  `duplicate` with the original revision; the same cmdId re-used with a different
  actor/type/payload → a stable `idempotency_conflict` rejection (HTTP 409 / WS ack
  error), never a silent substitution. Enforced in the RPC (incl. the
  unique-violation race path), the TS fallback, the RoomHost in-memory memo, and the
  service pre-check. `/commands`, `/claim-seat`, `/start` now REQUIRE a cmdId (web,
  Godot, bench and e2e clients all send one).
- **Required side effects are crash-recoverable (durable outbox).** Member mirrors,
  match finalization and round-history snapshots ride the SAME atomic commit as a
  synthetic `$effects` ledger event (`effectsOutbox.ts`), with history-snapshot rows
  prebuilt (the pre-commit round state does not survive the commit). The writer
  drains after commit (ack follows the attempt; the owed-record is already durable);
  recovery drains on RoomHost.load (restart), on duplicate-retry handling (both
  transports) and on every later commit — so a SIGKILL between commit and effects
  can no longer lose them, and each effect lands exactly once. (As first shipped,
  matchFinalize's exactly-once rested on a check-then-insert existence guard plus
  an in-process promise map — NOT cross-process safe; SUPERSEDED the same day by
  the atomic `finalize_match` transaction, see the ranked-finalize entry above.)
- **Atomicity fails closed.** The pre-migration non-atomic fallback engages ONLY
  behind the explicit `ARC_ALLOW_NONATOMIC_COMMIT=1` opt-in (local/migration tests).
  Without it a missing `commit_room_command` RPC is a readiness error —
  `store_not_ready` on the WS ack, HTTP 503 — and nothing is written or acknowledged.
  Deployment ordering: APPLY the 20260710 migration BEFORE serving traffic.
- **The state is the sole seat authority.** `viewerForMember`/`actorForMember` no
  longer fall back to the `member.seat_color` mirror; the RoomHost re-derives the
  actor's seat from the CURRENT state on EVERY commit attempt (including after a
  CAS-miss reload), so a stale/forged seat identity — a release/takeover race or a
  lagging mirror — can never act as a seat the state no longer grants (member `role`
  still rides from the member row, preserving legitimate hosts).
- **Duplicate acks are coherent.** A duplicate retry answers the CURRENT durable
  revision + view (invariant: `ack.revision === ack.view.projection.revision`) with
  the original commit carried in a new optional `duplicateOfRevision` field
  (protocol.ts). HTTP duplicates already returned the current view. Proven for late
  retries after unrelated commits over same instance, restart, and WS→HTTP fallback.
- **Docs corrected.** The Godot README/controllers no longer instruct avoiding WS
  joins on game rooms; the pre-batch snapshot-flush clobber is preserved as
  explicitly HISTORICAL. server/README documents the fail-closed contract + the
  outbox.

Verification after the corrections: `commit.test.ts` 25, `roomHostAuthority.test.ts`
40 (crash-injection outbox recovery, seat races, identity conflicts, readiness,
late-duplicate coherence), `authoritySmoke.ts` 39 real-wire checks (fail-closed
pass, both commit modes, store-layer monotonicity), full web vitest green.

### 2026-07-10 — P0 multiplayer authority & recovery (durable single history)

Closed the transport fork the WS room server introduced: HTTP commands committed via
the DB revision CAS while the WS host held separate in-memory truth and wrote
snapshots WITHOUT a revision check — permitting two histories, equal/stale-revision
overwrites, acks that preceded durability (crash = rollback of an acked action), a
non-durable cmdId (WS→HTTP fallback could double-apply), and WS-omitted side effects.

- **One durable authority.** New `src/lib/play/server/commit.ts` — the shared
  revision-CAS commit + `play_game_session_events` ledger both transports use. The
  WS `RoomHost` is now a write-through cache: engine apply (clone) → durable commit →
  only then ack/broadcast/side-effects; CAS miss ⇒ reload durable row + re-apply.
  `server/supabase.ts`'s unconditional `persistSnapshot` is deleted. Ticks (deadline
  + all bot commands) batch into one CAS commit; the tick/join/resync paths poll the
  session head so HTTP-committed mutations reach WS clients within one tick.
- **Durable exactly-once cmdId.** The wire `cmdId` is embedded in the ledger payload;
  retries (same socket, new socket, across restart, WS→HTTP fallback) are answered
  from the ledger instead of re-applied. (As first shipped the WS ack echoed the
  ORIGINAL revision beside a current view, and dedup ignored the actor/payload —
  both corrected the same day, see above.) HTTP `/commands`, `/claim-seat`, `/start`
  accepted an optional `cmdId` (now required); the web client mints ONE id per logical action and reuses it
  across the WS attempt + HTTP fallback (`playStore.sendPlayCommand`); the Godot
  `http_api.gd` sends cmdIds and safely retries once on transport/gateway failures.
  Migration `supabase/migrations/20260710_command_ledger.sql` (NOT yet applied) adds
  a generated `cmd_id` column + partial unique index + atomic `commit_room_command`
  RPC. (As first shipped, the code probed for the RPC and silently fell back to plain
  CAS+insert — leaving the crash-between-statements residual; SUPERSEDED the same day:
  the fallback is now an explicit local/test opt-in and production fails closed, see
  the corrections entry above.)
- **Fencing.** Bots, deadlines, close/reopen, recovery and normal commands all write
  through the CAS: revision can only grow, a stale instance reloads instead of
  clobbering, room close cannot be reopened by a late command. Terminal side effects
  now run on BOTH transports (`matchFinalize.ts` / `historySnapshots.ts` /
  `memberMirrors.ts` extracted client-injected from ranked.ts/service.ts). (As
  first shipped their exactly-once was a `match_results` existence guard +
  in-process serialization — cross-process UNSAFE for the ranked rating writes;
  SUPERSEDED the same day by the atomic `finalize_match` transaction, see the
  ranked-finalize entry above.)
- **Fork detector.** `SpectatorProjection.stateHash` — canonical jsonb-safe content
  hash (`src/lib/play/stateHash.ts`) stamped by `buildSessionProjection`; equal
  (revision, stateHash) across mixed clients ⇔ same history.
- **Verification.** `src/lib/play/server/commit.test.ts` (16) + fake store
  `fakePlayDb.ts`; `server/roomHostAuthority.test.ts` (26: simultaneous commands,
  duplicate cmdId incl. restart + cross-transport, stale-writer fencing, close/reopen,
  deadline double-driver, exactly-once side effects, privacy, seeded transcript
  equivalence WS≡HTTP, measured ack-latency floor). `server/authoritySmoke.ts` — real
  wire smoke (28 checks, both commit modes) over the new local PostgREST emulator
  (`server/pgrestEmu.ts`): measured p50/p95 command→durable-ack and →spectator-delta,
  SIGKILL recovery, two live instances on one history; `--live` runs it against the
  .env Supabase. Legacy `server/smoke.mjs` 31/31 on the write-through host. Godot
  `net_smoke` gained `--room/--member` (local-stack runs) + duplicate-cmdId and
  stateHash checks — 12/12 against the local authority stack.

### 2026-06-16 — P0 implemented (un-stallable)

- **`types.ts`** — added `phaseDeadline: number | null` to `PublicGameState` +
  `SpectatorProjection`; added `ENCOUNTER_SECONDS=90` / `LOCATION_SECONDS=120` /
  `CLEANUP_SECONDS=90` and a pure `phaseDurationMs(phase)` helper.
- **`phases.ts`** — every phase-entry fn (`beginNavigation`, `enterEncounter`,
  `enterLocation`, `enterCleanup`) now nulls `phaseDeadline`, so the server always
  re-stamps the freshly-entered phase.
- **`runtime.ts`** — extracted the location reward/draw drain into shared
  `drainPendingBeforeAdvance(state, catalog)` (now used by both the host
  `forceAdvancePhase` command and enforcement); added exported pure
  `applyDeadlineAdvance(state, catalog)` (= forced advance minus the host check, bumps
  revision); added `phaseDeadline` to lobby state, `ensureStateShape` backfill, and the
  projection.
- **`server/service.ts`** — added `stampPhaseDeadline` (server-clock-only stamp of the
  current phase, mirrors `navigationDeadline`), `maybeEnforceDeadline` (single-winner CAS
  advance when `Date.now() > phaseDeadline`), and exported `enforceRoomDeadlines`. Wired
  into `loadRoomView` (every SSE poll + the page-load/reconnect path = the P0-c lazy floor)
  and the top of `runRoomCommand`. **P0-b:** `syncMemberMirrors` no longer writes
  `last_seen_at`; `runRoomCommand` now bumps it for the acting member — so `last_seen_at`
  is a real per-player liveness signal (verified nothing reads it yet).
- **`deadlineEnforcement.test.ts`** (new) — 7 tests: each phase advances past a silent
  seat, `phaseDeadline` nulled on entry, revision bumped, no-op when inactive, and the
  bag-conservation leak guard (an open summon's draws are returned, not leaked).

**Decisions baked in:** server clock only (no client timestamp trusted); one phase
advanced per call (re-stamps a future deadline) so a long-idle room steps forward one
phase per poll; the host's client-side `onNavExpire` was left host-gated (NOT dropped) —
server enforcement makes it redundant, and dropping it would make non-hosts spam a
host-only command. Zero-clients floor = option A (lazy-on-reconnect), which falls out for
free because the page-load path calls `loadRoomView`.
