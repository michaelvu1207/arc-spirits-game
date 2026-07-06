# Arc Spirits — Godot Port Master Plan

**Audience:** a Fable orchestrator agent executing this port with Opus subagents.
**Repo:** `~/Documents/Programming/ArcSpiritsPlan2/arc-spirits-spectate` (branch `ml-bot-pipeline`; production = push to `main`, Vercel auto-deploys arcspirits.com).
**Authored:** 2026-07-05 by the prior Fable session (bootstrap commit `3b380e3`). Owner: Michael.

---

## 0. Orchestrator contract (read first)

You (Fable) orchestrate and verify. **Opus subagents (`model: 'opus'`) write all intermediate logic and code.** Your responsibilities, non-delegable:

1. **Decompose** each milestone into subagent tasks with tight, self-contained specs (paths, exact interfaces, acceptance checks *in the prompt*). Subagents get no conversation context — the prompt is everything they know.
2. **Verify everything yourself.** Never accept a subagent's self-report. After every task: run the test suites, run the screenshot/diff loops, run the benchmarks, read the diff. A subagent saying "done and tested" is a claim, not evidence.
3. **Gate milestones.** Each milestone below has an explicit exit gate. Do not start milestone N+1 until N's gate is green and committed. Report gate results to Michael with numbers, not adjectives.
4. **Parallelize** independent subagent tasks (multiple Agent calls in one message), but serialize anything touching shared files.
5. **Protect the invariants** (§3). If a subagent's change violates one, reject and re-spec — don't patch around it.
6. Commit at every green gate; small commits per component are fine. Push to `main` only when the *web* app remains deployable (the Godot dir and server dir are inert to the Vercel build — verify with `npm run build` before any push that touched shared code).

Subagent prompt template (adapt per task):
> Context paragraph (what this repo/system is, 3–5 sentences) · Exact task · Files to create/modify (absolute paths) · Interfaces/contracts it must match (paste them) · What it must NOT touch · Acceptance: commands that must pass · Return: summary of changes + any deviations, in the final message.

---

## 1. Mission & success criteria

Port the Arc Spirits client from SvelteKit/web to **Godot 4.5 (GDScript)** for Steam (macOS/Windows) + mobile (iOS/Android), as a **one-to-one visual and functional port** of the current web client, on top of a **faster transport architecture**, with **benchmarks proving every "faster" claim**.

Success =
- **S1 Parity:** every game screen indistinguishable side-by-side from the web client (golden screenshot-diff harness, per-screen diff budget ≤1.5% pixels at 1280×720, rationale §8).
- **S2 Functional:** a full 4-player game (humans + live neural bots) playable start→finish in the Godot client against the production rules engine; every command the web client can send, the Godot client can send.
- **S3 Faster, measured:** benchmark table (§6) showing action round-trip p50 <100ms on the WS path (vs current HTTP ~300–1000ms), state-update-to-render <50ms, 60fps sustained on a mid-tier phone profile, cold-start-to-lobby <3s desktop / <5s mobile.
- **S4 Nothing regresses:** web client stays live and deployable throughout; engine test suite (~873 passing tests) stays green; bot/ML stack untouched and functional.

---

## 2. Current system map (verified facts, 2026-07-05)

- **Engine (the crown jewel, DO NOT RESTRUCTURE):** pure deterministic reducer in `src/lib/play/` — `runtime.ts` (`applyGameCommand`/`reduceCommand`), `phases.ts`, `combat.ts`, `legality.ts`, `effects/`, `rng.ts` (deterministic from `{seed, cursor}`). ~900 tests. Simulates thousands of games/sec (already profile-optimized: hand-written clones, `mutate:true` fast path).
- **Resolution auto-skip just shipped** (`4fd36fd`): `phases.ts` `seatHasResolutionWork`/`autoAdvanceResolution` — engine auto-readies workless seats in benefits/awakening/cleanup; central post-command hook in `applyGameCommand`. This is the *pattern to generalize* for RoomView v2 affordances.
- **ML/bot stack (DO NOT TOUCH):** `src/lib/play/ml/` (obs encoder reads state fields directly; action space in `encode.ts`), `src/lib/play/server/botPolicy.ts` (heuristic), neural checkpoints in `ml/champions/` (live bot: ladder8c2 `main-0-gen60`). Bots run server-side; any state-shape change breaks encode/checkpoints/replays.
- **Current transport (the lag root cause):** `src/lib/stores/playStore.svelte.ts` — commands are HTTP POST to Vercel serverless (`/api/play/sessions/<code>/commands`), full state load + CAS write to Supabase per command, **no optimistic apply** (`sendPlayCommand` awaits the round trip). Sync = Supabase Realtime broadcast `{revision}` (~150ms) + 3s fallback poll; client refetches the **full** `/view` projection each revision; `reconcile.ts` does fine-grained in-place merge.
- **Server logic:** `src/lib/play/server/service.ts` (~1700+: command pipeline, deadline enforcement, `stampPhaseDeadline`, debug rooms). Rooms persisted as full-state snapshots in Supabase (`public_state`) — NOT event-sourced; reducer changes are safe for existing rooms.
- **Web client to be replaced (do NOT refactor, surgical fixes only):** `src/lib/components/play2d/` — ~36 components; `MainStage.svelte` ~2.6k lines, `GameBoard2D.svelte` ~1.5k.
- **Visual identity inputs:** fonts `static/fonts/{Opsilon,Vincendo}-{Regular,Italic}.ttf`; splat backgrounds, spirit art, icons under `static/`; styling is per-component Svelte CSS (StyleBoxFlat-compatible: flat panels, borders, radii, gradients).
- **Godot bootstrap (`godot/`, commit `3b380e3`):** Godot 4.5.1 at `/Applications/Godot.app/Contents/MacOS/Godot`. Text-authored scenes, programmatic UI, `--headless --import`, screenshot verify via `godot --path . -- --screenshot=/abs/path.png` (pattern in `godot/scripts/main.gd`). Locked: **mobile renderer on all platforms**, 1280×720 `canvas_items` stretch, GDScript.
- **E2E web harness:** `e2e/` Playwright (`mobile-layout.spec.ts` shows debug-room + `runRoomCommand` patterns) — reuse for golden captures.
- **Playtest bar:** deploys to arcspirits.com happen by pushing to `main`. Michael plays live games vs the neural bots there.

---

## 3. Non-negotiable invariants

1. **Engine core frozen.** No restructuring of `PublicGameState`, RNG, or reducer semantics. Additive-only changes (new derived/projection fields, new pure helpers) are allowed; they must keep all engine + ML tests green.
2. **ML compatibility.** `src/lib/play/ml/**`, `botPolicy.ts` behavior, checkpoints, and the obs/action contracts are untouched. Run `npx vitest run src/lib/play/ml/_canApply.test.ts src/lib/play/ml/_corruptionfreeze.test.ts` plus the full suite after any engine-adjacent change.
3. **Web client stays live.** Every push to `main` must pass `npx vitest run`, `npx svelte-check`, `npm run build`. The web client keeps working against the new transport (it is the *first consumer* of RoomView v2 — that's the compatibility proof).
4. **TS engine stays authoritative.** The Godot client contains **zero game rules**. If a Godot screen needs to know "can I do X / do I have work," that answer ships in the projection (affordances), never re-derived client-side. This rule prevented-in-reverse the two worst client bugs to date (corruption freeze, cleanup flashing).
5. **Every performance claim has a benchmark** (§6) with before/after numbers committed alongside the change.
6. **Every visual claim has a golden diff** (§8). No component is "done" without its side-by-side.

---

## 4. Target architecture

```
┌──────────────┐   WebSocket (JSON, RoomView v2 deltas)   ┌─────────────────┐
│ Godot client │◄────────────────────────────────────────►│  Room server     │
│ (view/input/ │                                          │  (Node, runs the │
│  animation)  │   commands → ack ≤100ms                  │  TS engine +     │
└──────────────┘                                          │  bots in-process)│
┌──────────────┐   same protocol (compat proof)           │                 │
│ Web client   │◄────────────────────────────────────────►│  Supabase =      │
│ (SvelteKit)  │                                          │  persistence +   │
└──────────────┘                                          │  lobby discovery │
                                                          └─────────────────┘
```

- **Room server:** long-lived Node process, one authoritative in-memory state per room, engine invoked in-process (`applyGameCommand`), snapshot to Supabase on an interval + on terminal events (crash-recovery from snapshots — same storage as today). Bots tick in-process (removes the client-driven bot timers in `+page.svelte`). Deadline enforcement moves in-process (replaces opportunistic HTTP-triggered enforcement).
- **RoomView v2 (the contract, versioned + typed):** current projection **plus** per-seat `affordances` block computed engine-side: `legalCommandTypes`, `hasResolutionWork`, `canPass`, pending-work descriptors (claim/awaken/overflow/corruption), phase labels. Generalizes `seatHasResolutionWork`. Delivered as full view on join, **deltas** (RFC6902-style or the existing `reconcile` shape) per revision after.
- **Deployment:** room server runs alongside the existing stack (Fly.io/Railway/small VPS — orchestrator proposes; Vercel keeps serving the web app + lobby API). Web client gains a feature flag: WS transport when available, HTTP fallback otherwise.
- **Offline-vs-bots (Steam, later milestone):** the pure reducer runs in an embedded QuickJS inside Godot, or a bundled Node sidecar on desktop. Deferred to M6 — do not let it shape earlier milestones.

---

## 5. Benchmark program (build in M0, run at every gate)

Create `bench/` (repo root) with runnable scripts; every gate report includes this table with **p50/p95 over ≥200 samples**, before vs after:

| Metric | How measured | Baseline (capture in M0) | Target |
|---|---|---|---|
| Action RTT (command→ack) | `bench/action-latency.mjs` vs prod HTTP path AND vs WS server | ~300–1000ms (verify!) | **<100ms p50, <200ms p95** (same-region) |
| Update propagation (commit→other-client render-ready) | timestamped broadcast → view-applied log | ~150ms + full refetch | <100ms p50 |
| Payload per update | bytes on wire per revision | full projection (measure) | delta ≤15% of full view (typical) |
| Server cmd processing | in-process timing around `applyGameCommand`+persist | measure | <10ms p50 in-memory path |
| Godot frame time (each ported screen, fixture-driven) | Godot `--print-fps` / custom frame-time probe, 30s | n/a | 60fps sustained; <8ms p95 frame @1280×720 |
| Cold start → lobby | scripted timer | web mobile: measure | <3s desktop, <5s mobile |
| Full bot game wall-clock (server-side, 4 neural bots) | `bench/bot-game.mjs` | measure vs today's Supabase path | ≥5× faster than today's path |

Rules: benchmarks are scripts in the repo, not one-off shell history; each writes JSON results to `bench/results/<date>-<name>.json`; gate reports diff against the committed baseline. Run mobile frame benchmarks on a real device once exports exist (M5); until then the mobile proxy is the mobile renderer on desktop with a 4× render-scale stress flag.

---

## 6. Milestones & gates

### M0 — Baseline + room server + RoomView v2 (the foundation; also fixes web mobile lag)
Subagent tasks: (a) `bench/` harness + **capture baselines against production** before any change; (b) Node WS room server package (`server/` dir) importing the engine from `src/lib/play/` (no code duplication — same repo, shared tsconfig path); protocol: join/auth (reuse member tokens), command, ack, view, delta, error; (c) RoomView v2 types + engine-side affordances (additive projection code, generalizing `seatHasResolutionWork`); (d) web client WS transport behind a flag + optimistic-feel fix (apply ack view immediately; keep broadcast path as fallback); (e) server-side bot ticking + deadline enforcement in-process.
**Gate:** full vitest suite green · svelte-check/build green · a real 2-browser game played over WS end-to-end · benchmark table shows RTT target met · web client on HTTP fallback still works · deployed room server reachable from arcspirits.com web client (flagged on for Michael to feel the difference).

### M1 — Parity harness + pilot component
Subagent tasks: (a) fixture library: capture ~12 canonical `RoomView` JSONs (lobby, navigation open/locked/reveal, location menu, combat, reward claim, awaken offers, benefits claim, cleanup discard, corruption, postgame) via the debug-room API + Playwright, checked into `godot/fixtures/`; (b) web golden capture script (Playwright, 1280×720, per-fixture PNG → `godot/goldens/web/`); (c) Godot fixture-render mode (`-- --fixture=X.json --screenshot=...`); (d) diff tool (`bench/visual-diff.mjs`, pixelmatch or similar, per-screen % + composite side-by-side image output); (e) design-token extraction: crawl `play2d/*.svelte` CSS → `godot/tokens.json` → generated Godot Theme `.tres` + font import (Opsilon/Vincendo); (f) pilot: port **PhaseBar** through the full loop.
**Gate:** PhaseBar diff ≤1.5% · side-by-side composite shown to Michael · tokens.json + theme generation committed and documented.

### M2 — Shell + lobby flow
Menu shell, server browser, room create/join/seat claim/guardian picker, connection status — against the live room server. Components: `MenuShell`, `ServerBrowser`, `GuardianPicker`, lobby chrome.
**Gate:** create room in Godot, join same room from web browser, both see each other in lobby; screens within diff budget; cold-start benchmark recorded.

### M3 — Core game screens (the bulk; parallelize by component)
Port in dependency order, each through the golden loop: `SpiritWorldBoard`+navigation (incl. reveal choreography), `MainStage` decomposed into per-phase scenes (location interaction menu, abyss actions, draw tray, reward arc, combat overlay, decision cards incl. Arc Mage picker, awaken offers/discard picker, cleanup rune discard, corruption discard), HUD (`TraitTracker`, `MatSlots`, `MonsterPanel`, `Leaderboard`, `InfoLegend`, `NavTimer`, `RoundBanner`, dice/rune tokens), chat.
Orchestration note: decompose MainStage by *fixture*, not by Svelte file structure — one Opus task per fixture screen, spec = fixture JSON + web golden + token names. Serialize tasks that share scenes/theme; parallelize disjoint screens.
**Gate (incremental per screen + final):** all fixtures within diff budget · frame-time benchmark per screen · a scripted bot game renders correctly screen-by-screen (Godot spectator vs 4 server bots).

### M4 — Full playable loop + input polish
Wire every command path; reconnect/resume; deadline timers; SFX hooks; the wrap-up auto-skip UX verified (idle players see one stable waiting view — engine already guarantees it); mobile input ergonomics (touch targets ≥44pt, safe-area).
**Gate:** Michael plays a complete live game vs the production neural bots in the Godot client. A second full game with web client + Godot client at the same table (cross-client). Zero rule divergence (server-authoritative makes this structural, verify anyway).

### M5 — Exports + device benchmarks
Export presets (`export_presets.cfg`, text-authored): macOS (signed/notarized), Windows, iOS, Android; Steamworks integration scaffold (steam appid gated — needs Michael's app credentials; stub behind interface until then). Run the full benchmark table on real devices (Michael's phone) + a Steam Deck-class target if available.
**Gate:** installable builds on macOS + one phone; device benchmark table committed; 60fps on phone profile or a written remediation list.

### M6 — Better-than-web improvements (only after parity)
Now spend the "improved overall" budget: game-juice pass (tweens/particles/transitions using Godot strengths — propose to Michael with short capture clips before applying broadly), offline-vs-bots (QuickJS-embedded reducer or desktop sidecar), delta-payload tuning, asset compression/atlases, loading-time work.
**Gate:** each improvement = benchmark or capture proving it, plus Michael's sign-off on feel changes.

---

## 7. Parity harness details (§ referenced as §8 by S1)

- Budget: ≤1.5% differing pixels per screen at 1280×720 (fonts rasterize differently browser-vs-Godot; geometry/color/spacing must match, sub-pixel AA noise is accepted). Fail → composite image (web | godot | diff heat) written to `godot/goldens/failures/` for inspection.
- Goldens are versioned; regenerating a web golden requires a note in the commit (the web UI may change under this project — e.g. hotfixes; regen deliberately, never silently).
- Effects mapping notes: backdrop blur → shader or pre-blurred asset; CSS radial veils → `GradientTexture2D`/shader; text-shadow → Label shadow settings; splats → same images.

## 8. Risk register

- **Scope creep into the engine.** Mitigation: invariant #1; affordances are additive projection only.
- **Subagent hallucinated APIs (Godot 4.5 GDScript).** Mitigation: orchestrator runs `--headless --import` + a scene smoke run after every Godot task (parse/runtime errors surface immediately); keep `godot/README.md` workflow notes current.
- **RoomView v2 drift between web and Godot consumers.** Mitigation: single TS type source; generate a JSON schema; Godot side validates fixtures against it in CI.
- **WS server ops** (a new always-on service). Mitigation: snapshot-restore from Supabase (same storage as today) makes it stateless-restartable; keep the HTTP path as fallback until M4 exit.
- **iOS/Steam credentialing stalls.** Mitigation: everything before M5 needs zero external accounts; flag needs to Michael early in M5 (`needs input`).
- **Parity budget fights on gradient-heavy screens.** Mitigation: pilot (PhaseBar) then the *hardest* screen (destination reveal) early in M3 to calibrate the budget before mass-porting.

## 9. Operational reference

- Godot: `/Applications/Godot.app/Contents/MacOS/Godot` (4.5.1) · import: `--headless --import` (run from `godot/`) · screenshot run: `--path godot -- --screenshot=/abs/p.png` · fixture mode (M1+): `-- --fixture=name --screenshot=...`.
- Tests: `npx vitest run` (full), plus targeted: `src/lib/play/phases.test.ts`, `ml/_canApply.test.ts`, `ml/_corruptionfreeze.test.ts`, `server/botPolicy.test.ts`. Typecheck `npx svelte-check --tsconfig ./tsconfig.json`. Build `npm run build`.
- E2E (needs local dev server + Supabase env): `e2e/` Playwright; debug rooms via `POST /api/play/debug`; command driver `runRoomCommand` in `e2e/helpers.ts`.
- Deploy web: push `ml-bot-pipeline:main` (remote moved to `michaelvu1207/arc-spirit-spectate`; old URL redirects). Verify 200 on arcspirits.com after ~2min.
- Prior art to read before M0: commit `4fd36fd` (resolution auto-skip — the affordance pattern), `15e89f1` (corruption-freeze fix — why rules must not live client-side), `src/lib/play/reconcile.ts` (delta-application precedent), `playStore.svelte.ts` (current transport, `POLL_MS`, broadcast handling).
- Michael's standing prefs: measure before optimizing; small playable increments he can feel on the live site; surface taste decisions (visual/feel changes) to him with evidence rather than deciding silently.
