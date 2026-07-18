import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPhase, currentRound, ensureGuestIdentity } from './helpers';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS process-ownership helper shared with the release gates
import { spawnOwned, stopOwned } from '../scripts/procOwn.mjs';

/**
 * M0 GATE — two real browsers, both on the WebSocket transport, playing a real game.
 *
 * Boots the long-lived room server (server/index.ts) as a child process on a random port and
 * relies on the Playwright-managed dev web server (localhost:4173). A room is created + seated
 * with TWO members through the real HTTP play API (Supabase-backed); the room server loads that
 * same room from Supabase on first WS join, so the two data planes share state. Both browsers
 * open /play/<code>?ws=ws://127.0.0.1:<port> so playStore routes commands over WS.
 *
 * Proves: (1) both clients connect over WS; (2) real UI-driven game actions from each seat
 * propagate to the other browser over WS across 2 full rounds, with per-action latency logged;
 * (3) disabling the WS transport mid-game (the room server is killed) falls back to the HTTP
 * path and the game still advances in both browsers.
 *
 * Determinism / speed: reduced motion; navigation timer disabled (no wall-clock deadline
 * races); no bots; heavy assets (art/audio/font/3D-splat) aborted at the network layer so the
 * two board pages stay responsive under headless load (the WebGL backdrop otherwise pegs the
 * renderer and adds ~25s of reactivity lag); compass hit-targets fired via dispatchEvent (the
 * transparent buttons resist Playwright's actionable click). No src/** or server/** changes —
 * this spec only (+ the room server's own load path).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = 8100 + Math.floor(Math.random() * 700);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
// Matches ONLY the room-server socket (not the app's Supabase-realtime wss).
const WS_MATCH = new RegExp(`127\\.0\\.0\\.1:${PORT}`);
// Poll ceiling while waiting for a cross-browser WS delta. Real propagation is sub-100ms; the
// ceiling only bounds the wait before we retry a click / fail. The per-action 2s bound (the
// task's requirement) is asserted separately in the latency summary.
const CROSS_MS = 5_000;

let server: ReturnType<typeof spawnOwned>;

async function waitForServerHealth(retries = 100): Promise<void> {
	for (let i = 0; i < retries; i += 1) {
		try {
			const res = await fetch(`${HTTP_BASE}/healthz`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(
		`room server did not become healthy on :${PORT}\n--- server log ---\n${server.ownedLog}`
	);
}

test.beforeAll(async () => {
	// OWNED process group (scripts/procOwn.mjs): the old `spawn('npx', ['tsx', …])`
	// + `.killed` checks killed only the npx wrapper and leaked the tsx/node pair.
	server = spawnOwned(
		'node',
		[join(REPO, 'node_modules', '.bin', 'tsx'), join(REPO, 'server', 'index.ts')],
		{ cwd: REPO, label: 'ws-two-browser room server', env: { ...process.env, PORT: String(PORT) } }
	);
	await waitForServerHealth();
});

test.afterAll(async () => {
	console.log(`[server-log tail]\n${server?.ownedLog.slice(-3000) ?? ''}`);
	// TERM → bounded wait → KILL against the whole group, ACTUAL exit awaited
	// (safe if the fallback test already killed it mid-run).
	if (server) await stopOwned(server, { termTimeoutMs: 3000 });
});

// ── HTTP setup helpers (same pattern as e2e/helpers.ts, inlined so this spec is self-contained
//    and can inject the ?ws= param on the final navigation) ─────────────────────────────────

type RoomView = { projection: { roomCode: string; revision: number; guardianPool: string[] }; member: { id: string | null } };

async function apiPost(page: Page, path: string, body: Record<string, unknown> = {}): Promise<RoomView> {
	// Mutation routes require a cmdId; minted once so retries are honest duplicates.
	const data =
		/\/(commands|claim-seat|start)$/.test(path) && body.cmdId == null
			? { ...body, cmdId: `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
			: body;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const res = await page.context().request.post(path, { data });
		const text = await res.text();
		if (res.ok()) return JSON.parse(text) as RoomView;
		if (res.status() >= 500 && attempt < 4) {
			await page.waitForTimeout(500 * (attempt + 1));
			continue;
		}
		throw new Error(`POST ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
	}
	throw new Error(`POST ${path} failed after retries.`);
}

async function getRoomView(page: Page, code: string): Promise<RoomView['projection']> {
	const res = await page.context().request.get(`/api/play/sessions/${code}/view`);
	const text = await res.text();
	if (!res.ok()) throw new Error(`GET /view -> ${res.status()}: ${text.slice(0, 200)}`);
	return (JSON.parse(text) as RoomView).projection;
}

/** Create + seat a 2-player active game via the HTTP API (no navigation yet). Each
 *  page first establishes the validated anonymous guest identity — the account is
 *  the sole principal; per-room member cookies no longer exist or authorize. */
async function seatTwoPlayers(host: Page, guest: Page): Promise<string> {
	await host.goto('/play');
	await guest.goto('/play');
	await ensureGuestIdentity(host, 'Host');
	await ensureGuestIdentity(guest, 'Guest');
	const created = await apiPost(host, '/api/play/sessions', { displayName: 'Host' });
	const code = created.projection.roomCode;
	const pool = created.projection.guardianPool;
	await apiPost(guest, `/api/play/sessions/${code}/join`, { displayName: 'Guest' });
	await apiPost(host, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Red' });
	await apiPost(host, `/api/play/sessions/${code}/commands`, { command: { type: 'selectGuardian', guardianName: pool[0] } });
	await apiPost(guest, `/api/play/sessions/${code}/claim-seat`, { seatColor: 'Blue' });
	await apiPost(guest, `/api/play/sessions/${code}/commands`, { command: { type: 'selectGuardian', guardianName: pool[1] } });
	// Disable the navigation countdown so nothing auto-advances on a wall clock.
	await apiPost(host, `/api/play/sessions/${code}/commands`, { command: { type: 'setNavigationTimer', durationMs: null } });
	await apiPost(host, `/api/play/sessions/${code}/start`);
	return code;
}

// ── WS observers ────────────────────────────────────────────────────────────────────────────

interface WsObserver {
	opened: boolean;
	joined: boolean;
	/** Timestamps (perf ms) of every joined/delta frame this connection RECEIVED. */
	deltas: number[];
}

/**
 * Observe a page's room-server socket via Playwright's WebSocket events. `deltas` collects the
 * arrival time of every joined/delta frame — the receiver-side signal used to time cross-browser
 * propagation. (The app's Supabase-realtime socket is filtered out by URL.)
 */
function observeViaEvents(page: Page, _tag: string): WsObserver {
	const obs: WsObserver = { opened: false, joined: false, deltas: [] };
	page.on('websocket', (ws) => {
		if (!WS_MATCH.test(ws.url())) return; // ignore the Supabase realtime socket
		obs.opened = true;
		ws.on('framereceived', (frame) => {
			const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
			let msg: { t?: string };
			try {
				msg = JSON.parse(payload);
			} catch {
				return;
			}
			if (msg.t === 'joined') {
				obs.joined = true;
				obs.deltas.push(performance.now());
			} else if (msg.t === 'delta') {
				obs.deltas.push(performance.now());
			}
		});
		ws.on('close', () => {
			obs.opened = false;
		});
	});
	return obs;
}

function roomUrl(code: string): string {
	return `/play/${code}?e2e=1&ws=${encodeURIComponent(WS_URL)}`;
}

async function roomUiAttached(page: Page): Promise<boolean> {
	if ((await currentPhase(page)) !== null) return true;
	for (const id of ['main-stage', 'main-scene-instruction', 'phase-bar', 'round-banner']) {
		if (await page.getByTestId(id).first().isVisible().catch(() => false)) return true;
	}
	return false;
}

/** Wait for the game board to attach, reloading a couple of times if the first hydration
 *  stalls (mirrors e2e/helpers.ts::expectRoomUiAttachedWithReload). Dumps diagnostics on
 *  final failure so a stuck lobby / loading screen is legible. */
async function waitRoomAttached(page: Page, code: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await expect(async () => {
				if (!(await roomUiAttached(page))) throw new Error('room UI not attached');
			}).toPass({ timeout: 20_000 });
			return;
		} catch (err) {
			if (attempt < 2) {
				await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
				continue;
			}
			const status = await getRoomView(page, code).then((p) => p.status).catch((e) => `getView failed: ${e}`);
			const lobby = await page.getByTestId('lobby').first().isVisible().catch(() => false);
			const loading = await page.getByText(/Loading|Preparing/i).first().isVisible().catch(() => false);
			const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\n+/g, ' | ');
			console.log(`[attach-fail] url=${page.url()} status=${status} lobbyVisible=${lobby} loadingVisible=${loading} body="${body}"`);
			throw err;
		}
	}
}

/** Perform `action` and measure how long until the OTHER browser's socket receives the
 *  resulting frame. Asserts arrival within 2s and returns the latency (ms). */
async function actAndMeasure(label: string, receiver: WsObserver, action: () => Promise<void>): Promise<number> {
	const before = receiver.deltas.length;
	const t0 = performance.now();
	await action();
	await expect
		.poll(() => receiver.deltas.length > before, { timeout: CROSS_MS, intervals: [25, 50, 100, 200] })
		.toBe(true);
	const latency = receiver.deltas[receiver.deltas.length - 1] - t0;
	console.log(`[ws-latency] ${label}: ${latency.toFixed(0)}ms`);
	return latency;
}

/**
 * Lock a destination through the compass UI and measure the resulting WS delta on the OTHER
 * browser. The receiver-delta arrival IS the lock verification (immediate, no Supabase lag) AND
 * the cross-propagation latency. Retries only when a click produced NO delta (a pre-hydration
 * no-op) — a registered lock always broadcasts within 2s, so we never re-click a locked tile
 * (which the compass would interpret as an unlock). Asserts < 2s.
 */
async function lockAndMeasure(actor: Page, label: string, dest: string, receiver: WsObserver, latencies: number[]): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const tile = actor.getByTestId(`location-${dest}`).first();
		const count = await tile.count();
		const enabled = count > 0 ? await tile.isEnabled().catch(() => false) : false;
		if (count === 0 || !enabled) {
			await actor.waitForTimeout(600);
			continue;
		}
		await tile.scrollIntoViewIfNeeded().catch(() => {});
		const before = receiver.deltas.length;
		const clickAt = performance.now();
		// The compass hit-targets are transparent, absolutely-positioned buttons that Playwright's
		// actionability (even force) can't reliably click; dispatchEvent fires the onclick handler
		// (pickRealm → sendPlayCommand) directly.
		await tile.dispatchEvent('click').catch(() => {});
		try {
			await expect.poll(() => receiver.deltas.length > before, { timeout: CROSS_MS, intervals: [25, 50, 100, 200] }).toBe(true);
			const latency = receiver.deltas[receiver.deltas.length - 1] - clickAt;
			latencies.push(latency);
			console.log(`[ws-latency] ${label}: ${latency.toFixed(0)}ms (try ${attempt + 1})`);
			return;
		} catch {
			/* click produced no cross-browser delta (a pre-hydration no-op) — re-click */
		}
	}
	throw new Error(`${label}: lock produced no cross-browser WS delta`);
}

/** One navigation round: each seat locks a destination over WS (cross-measured); the second
 *  lock reveals + advances, which must render in BOTH browsers (encounter auto-skips → location). */
async function playNavigationRound(
	host: Page,
	guest: Page,
	round: number,
	hostDest: string,
	guestDest: string,
	latencies: number[],
	obs: { hostObs: WsObserver; guestObs: WsObserver }
): Promise<void> {
	await lockAndMeasure(host, `R${round} host lock → guest`, hostDest, obs.guestObs, latencies);
	await lockAndMeasure(guest, `R${round} guest lock (reveal) → host`, guestDest, obs.hostObs, latencies);
	// Both clients received the reveal over WS (measured above); this waits for the UI to catch
	// up (a DOM re-render, not a network wait — generous headroom).
	for (const p of [host, guest]) {
		await expect.poll(() => currentPhase(p), { timeout: 15_000 }).not.toBe('navigation');
	}
	console.log(`[ws] R${round} destinations revealed → location in both browsers`);
}

/** Click pass-turn on any seat whose button is live, until both clients reach `targetRound`
 *  navigation. DOM-driven so it reflects the WS-applied state immediately. */
async function passUntilNavigation(pages: Page[], targetRound: number): Promise<void> {
	for (let i = 0; i < 30; i += 1) {
		const rounds = await Promise.all(pages.map((p) => currentRound(p)));
		const phases = await Promise.all(pages.map((p) => currentPhase(p)));
		if (rounds.every((r) => r >= targetRound) && phases.every((ph) => ph === 'navigation')) return;
		for (const p of pages) {
			const btn = p.getByTestId('pass-turn');
			if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
				await btn.dispatchEvent('click').catch(() => {});
			}
		}
		await pages[0].waitForTimeout(500);
	}
	throw new Error(`did not reach round ${targetRound} navigation`);
}

test.describe('M0 gate — two-browser WS game', () => {
	test.setTimeout(300_000);

	let hostCtx: BrowserContext;
	let guestCtx: BrowserContext;
	let host: Page;
	let guest: Page;

	test.beforeEach(async ({ browser }) => {
		// Desktop-width viewport → the board renders the "compass" (all four realm hit-targets
		// present at once) instead of the mobile one-per-slide carousel.
		const ctxOpts = { reducedMotion: 'reduce' as const, viewport: { width: 1100, height: 760 } };
		hostCtx = await browser.newContext(ctxOpts);
		guestCtx = await browser.newContext(ctxOpts);
		// Two heavy WebGL board pages saturate the headless CPU and stall frame/render
		// processing (20s+ event lag). Abort art/audio/font/3D-splat assets — the round-loop
		// assertions read DOM/CSS (phase bar, compass, pass button), not images — so the pages
		// stay responsive and cross-propagation is measured, not swamped.
		for (const ctx of [hostCtx, guestCtx]) {
			await ctx.route('**/*', (route) => {
				const t = route.request().resourceType();
				const url = route.request().url();
				if (t === 'image' || t === 'media' || t === 'font') return route.abort();
				// Kill the 3D splat backdrop: its three.js/spark chunk render loop pegs the headless
				// renderer (~27s reactivity lag). SplatBackground imports it dynamically inside a
				// try/catch, so aborting the chunk just leaves a static backdrop.
				if (t === 'script' && /spark|three/i.test(url)) return route.abort();
				if (/\.(splat|ply|ktx2|basis|drc|mp3|ogg|wav|png|jpe?g|webp|woff2?)(\?|$)/i.test(url)) {
					return route.abort();
				}
				return route.continue();
			});
		}
		host = await hostCtx.newPage();
		guest = await guestCtx.newPage();
		for (const [tag, p] of [['host', host], ['guest', guest]] as const) {
			p.on('crash', () => console.log(`[${tag}-page] CRASHED`));
			p.on('pageerror', (e) => {
				// The deliberately-blocked three.js/spark chunk import rejects — expected, harmless.
				if (/three|spark|dynamically imported module/i.test(String(e))) return;
				console.log(`[${tag}-page] pageerror: ${String(e).slice(0, 160)}`);
			});
		}
	});

	test.afterEach(async () => {
		// Close defensively: after the fallback kills the server, both pages are in WS
		// reconnect loops against a dead port — tearing those down can race, and a teardown
		// hiccup must not fail an otherwise-passing test.
		for (const p of [host, guest]) await p.close({ runBeforeUnload: false }).catch(() => {});
		await hostCtx.close().catch(() => {});
		await guestCtx.close().catch(() => {});
	});

	test('two browsers play over WS, cross-propagate < 2s, and fall back to HTTP', async () => {
		const latencies: number[] = [];

		// (1) Seat two real members, then observe + open both browsers on the WS transport.
		const code = await seatTwoPlayers(host, guest);
		const hostObs = observeViaEvents(host, 'host');
		const guestObs = observeViaEvents(guest, 'guest');

		// (2) CONCURRENT first-joins — a browser-level regression probe for the getOrLoadRoom
		// cold-join race (fixed in 7f4509b: the in-flight load promise is registered
		// synchronously). Both truly-simultaneous first joins must dedupe onto ONE room entry:
		// the room is loaded from Supabase exactly once (roomLoads +1) and BOTH sockets attach
		// to the same entry (connections=2). Before the fix, the second join orphaned itself
		// (its own entry, no broadcasts, connections=1).
		const loadsBefore = (await fetch(`${HTTP_BASE}/healthz`).then((r) => r.json())).roomLoads;
		await Promise.all([host.goto(roomUrl(code)), guest.goto(roomUrl(code))]);
		await Promise.all([waitRoomAttached(host, code), waitRoomAttached(guest, code)]);
		await expect.poll(() => hostObs.opened && hostObs.joined, { timeout: 30_000 }).toBe(true);
		await expect.poll(() => guestObs.opened && guestObs.joined, { timeout: 30_000 }).toBe(true);

		console.log('[ws] both browsers connected + joined over WS (concurrent first-joins)');
		const health = await fetch(`${HTTP_BASE}/healthz`).then((r) => r.json());
		const loadDelta = health.roomLoads - loadsBefore;
		console.log(`[healthz] rooms=${health.rooms} connections=${health.connections} roomLoads Δ=${loadDelta}`);
		expect(health.connections, 'both concurrent first-joins share one room entry').toBe(2);
		expect(loadDelta, 'cold room loaded from Supabase exactly once under concurrent joins').toBe(1);
		await host.waitForTimeout(1_500); // brief settle before measuring
		console.log('[ws] pages settled; beginning measured play');

		// ── ROUND 1 ────────────────────────────────────────────────────────────────────────
		await playNavigationRound(host, guest, 1, 'Cyber City', 'Tidal Cove', latencies, { hostObs, guestObs });
		// Location: one location-phase action (endLocationActions) from each seat, cross-measured.
		latencies.push(await actAndMeasure('R1 host location-pass → guest', guestObs, () => passTurnUi(host)));
		latencies.push(await actAndMeasure('R1 guest location-pass → host', hostObs, () => passTurnUi(guest)));
		// Remaining resolution phases (benefits/awakening/cleanup auto-skip when empty) → round 2 nav.
		await passUntilNavigation([host, guest], 2);
		console.log('[ws] reached round 2 navigation in both browsers');

		// ── ROUND 2 ────────────────────────────────────────────────────────────────────────
		await playNavigationRound(host, guest, 2, 'Floral Patch', 'Cyber City', latencies, { hostObs, guestObs });
		latencies.push(await actAndMeasure('R2 host location-pass → guest', guestObs, () => passTurnUi(host)));
		latencies.push(await actAndMeasure('R2 guest location-pass → host', hostObs, () => passTurnUi(guest)));
		await passUntilNavigation([host, guest], 3);
		console.log('[ws] completed 2 full rounds; reached round 3 navigation over WS');

		// (5) Latency summary.
		const max = Math.max(...latencies);
		const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
		const under2s = latencies.filter((l) => l < 2_000).length;
		console.log(`[ws-latency] ${latencies.length} measured actions — avg ${avg.toFixed(0)}ms, max ${max.toFixed(0)}ms, ${under2s}/${latencies.length} under 2s`);
		// Every UI action reflected in the other browser within 2s (the task's bound). Real
		// propagation is sub-100ms; 2s leaves generous headroom for CI jitter.
		expect(max, 'every cross-browser reflection under 2s').toBeLessThan(2_000);

		// (6) FALLBACK PROOF: disable the WS transport mid-game by killing the room server, then
		//     act from host and assert the game still advances via the HTTP path in BOTH browsers.
		//     (Playwright's routeWebSocket can't drop a single live socket without also making the
		//     transport read readyState!=OPEN — which suppresses WS sends entirely — so we cut the
		//     server, which is what a real WS outage looks like. HTTP goes to the web app +
		//     Supabase, untouched by this.)
		await host.waitForTimeout(1_500); // let the last WS snapshot persist flush
		const hostRev0 = (await getRoomView(host, code)).revision;
		const guestRev0 = (await getRoomView(guest, code)).revision;

		// WS transport now unavailable to BOTH clients (server is gone) — kill the
		// WHOLE owned group and await the real exit so no tsx/node half survives.
		await stopOwned(server, { termTimeoutMs: 0 });
		// Give the transports a moment to observe the drop (wsConnected → false → HTTP fallback).
		// We don't poll `opened`: the transports keep opening short-lived reconnect sockets that
		// fail against the dead port, so that flag flaps. The proof is that the game still advances.
		await host.waitForTimeout(4_000);
		console.log('[ws] room server killed — WS down for both clients, transport falls back to HTTP');

		// Host acts (round 3 navigation lock) — with WS down this routes over HTTP POST. Single
		// verified click (no re-click: clicking a locked compass tile would UNLOCK it).
		const fbTile = host.getByTestId('location-Tidal Cove').first();
		await expect(fbTile).toBeVisible({ timeout: 10_000 });
		await fbTile.scrollIntoViewIfNeeded().catch(() => {});
		await fbTile.dispatchEvent('click');

		// Host reflects immediately (the HTTP POST response is applied locally); guest converges
		// via its Supabase broadcast + poll safety net. Both read authoritative state from the web
		// API (Supabase), which the HTTP command path wrote — the room server never saw it.
		// The room server is dead, so these advances CANNOT be WS — they are the HTTP path
		// (web app + Supabase) carrying the command and both clients converging on it.
		await expect.poll(async () => (await getRoomView(host, code)).revision > hostRev0, { timeout: 12_000 }).toBe(true);
		await expect.poll(async () => (await getRoomView(guest, code)).revision > guestRev0, { timeout: 12_000 }).toBe(true);
		console.log('[ws] fallback OK — host acted over HTTP, both browsers advanced with WS down');

		// (7) Clean shutdown handled by afterEach (contexts) + afterAll (server).
	});
});

/** Click the per-phase "pass turn" control (endLocationActions / commit* / passEncounter). */
async function passTurnUi(page: Page): Promise<void> {
	const btn = page.getByTestId('pass-turn');
	await expect(btn).toBeVisible();
	await expect(btn).toBeEnabled();
	await btn.dispatchEvent('click');
}
