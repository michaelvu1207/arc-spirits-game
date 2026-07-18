import { test, expect, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGuestIdentity } from './helpers';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS process-ownership helper shared with the release gates
import { spawnOwned, stopOwned } from '../scripts/procOwn.mjs';

/**
 * SESSION JOURNEY (web + wire-member mixed party) — the browser half of the
 * cross-platform session contract:
 *
 *   1. GUEST QUICK PLAY — a cold browser with no account taps Quick Play: the
 *      anonymous identity is created on the spot (resolvePlayIdentity → the local
 *      auth emulator answers the browser's CORS preflight + signup), the
 *      matchmaking queue accepts the validated guest, bots backfill, and the
 *      browser lands in a matchmade room. Because the party contains an ANONYMOUS
 *      guest, the room is truthfully CASUAL/UNRATED and PRIVATE — an anonymous
 *      identity is never represented as a verified ranked identity, and the party
 *      room never leaks into the public browser.
 *   2. MIXED-PARTY POSTGAME + REMATCH — one browser member (cookie session) + one
 *      cookieless WIRE member (Authorization: Bearer — the exact native-client
 *      contract) finish a game; the wire member opens the rematch lobby FIRST, the
 *      browser's postgame advertises it live ("Join Rematch · N in lobby"), and
 *      clicking it lands the browser in the SAME (private) lobby. Reload-restore
 *      of the finished room (account identity) is asserted along the way.
 *
 * STACK: relies on the Playwright-managed dev server (localhost:4173) and reads
 * its /api/play/config to find the Supabase(-compatible) store; when that store
 * is unreachable (the checked-in .env placeholder) the suite SKIPS loudly with
 * the local-stack instructions — and on release gates, where a skip must never
 * read as evidence, ARC_REQUIRE_JOURNEY_STORE=1 turns that skip into a hard
 * failure. Local stack (zero Supabase):
 *
 *   npx tsx server/pgrestEmu.ts --listen 8095 --rpc &
 *   PUBLIC_SUPABASE_URL=http://127.0.0.1:8095 PUBLIC_SUPABASE_ANON_KEY=local-emu \
 *     SUPABASE_SERVICE_ROLE_KEY=local-emu ARC_PLAY_CATALOG_FILE=$PWD/ml/catalog.json \
 *     PUBLIC_WS_SERVER_URL=ws://127.0.0.1:8787 npm run dev -- --port 4173 --strictPort &
 *   npm run test:e2e -- session-journey
 *
 * The room server is booted by this spec itself (random port), pointed at the
 * SAME store the dev server advertises, so WS deltas and HTTP share one history.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = 8810 + Math.floor(Math.random() * 180);
const WS_URL = `ws://127.0.0.1:${PORT}`;

/** Playable seats + party size, mirrored from src/lib/play/types.ts — the
 *  matchmade seating proof below pins members to EXACTLY these. */
const SEAT_COLORS = ['Red', 'Blue', 'Orange', 'Green', 'Purple', 'Yellow'];
const RANKED_LOBBY_SIZE = 4;

let server: ReturnType<typeof spawnOwned> | null = null;
let supabaseUrl = '';
let supabaseAnonKey = '';
let storeReachable = false;

async function fetchJson(
	url: string,
	init?: RequestInit
): Promise<{ status: number; body: unknown }> {
	// Every raw fetch in this suite is BOUNDED — a wedged store/dev server fails the
	// step with a diagnosable abort instead of hanging the whole run.
	const res = await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
	const text = await res.text();
	try {
		return { status: res.status, body: JSON.parse(text) };
	} catch {
		return { status: res.status, body: text };
	}
}

test.beforeAll(async () => {
	// Discover the dev server's public store config, then probe it.
	try {
		const cfg = await fetchJson('http://localhost:4173/api/play/config');
		supabaseUrl = String((cfg.body as { supabaseUrl?: string }).supabaseUrl ?? '');
		supabaseAnonKey = String((cfg.body as { supabaseAnonKey?: string }).supabaseAnonKey ?? '');
		const probe = await fetchJson(`${supabaseUrl}/rest/v1/play_game_sessions?limit=1`, {
			headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey }
		});
		storeReachable = probe.status < 500;
	} catch {
		storeReachable = false;
	}
	if (!storeReachable) return;

	// OWNED process group (scripts/procOwn.mjs): `node .bin/tsx` avoids an extra
	// npx wrapper process, and detached+group teardown means the room server can
	// never reparent to launchd if this runner dies or wedges.
	server = spawnOwned(
		'node',
		[join(REPO, 'node_modules', '.bin', 'tsx'), join(REPO, 'server', 'index.ts')],
		{
			cwd: REPO,
			label: 'journey room server',
			env: {
				...process.env,
				PORT: String(PORT),
				PUBLIC_SUPABASE_URL: supabaseUrl,
				PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
				SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-emu',
				ARC_WS_CATALOG_FILE: join(REPO, 'ml', 'catalog.json')
			}
		}
	);
	// BOUNDED health wait that FAILS EXPLICITLY: every probe carries its own abort
	// timeout, and never coming up is a loud error (previously the loop fell through
	// and the suite hung later on an un-diagnosable dead server).
	let healthy = false;
	for (let i = 0; i < 100 && !healthy; i += 1) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
				signal: AbortSignal.timeout(1000)
			});
			healthy = res.ok;
		} catch {
			/* not up yet */
		}
		if (!healthy) await new Promise((r) => setTimeout(r, 250));
	}
	if (!healthy) {
		throw new Error(
			`room server did not become healthy on :${PORT}\n${server.ownedLog.slice(-2000)}`
		);
	}

	// Warm the heavy SvelteKit dev route graph (matchmaking → createRankedSession →
	// botPolicy → neural weights) so the FIRST in-test request isn't racing a
	// multi-second on-demand compile against a navigation timeout. Unauthenticated
	// hits are enough — they still force Vite to compile the whole module graph.
	// EVERY warmup is bounded: a wedged dev-server compile aborts the fetch instead
	// of hanging beforeAll forever (the warmup is best-effort by design).
	await Promise.all(
		['/api/play/matchmaking/queue', '/api/play/sessions', '/api/play/config'].map((path) =>
			fetch(`http://localhost:4173${path}`, {
				method: path === '/api/play/config' ? 'GET' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: path === '/api/play/config' ? undefined : '{}',
				signal: AbortSignal.timeout(30_000)
			}).catch(() => {})
		)
	);
});

test.afterAll(async () => {
	// TERM → bounded wait → KILL, AWAITING the ACTUAL exit. The old code checked
	// `ChildProcess.killed` — which flips true the moment a signal is SENT — so it
	// never escalated and never waited, leaking room-server process pairs to
	// launchd. stopOwned signals the whole process group and resolves only when
	// the child has really exited.
	if (server) await stopOwned(server, { termTimeoutMs: 5000 });
});

test.beforeEach(() => {
	// A missing store must be an EXPLICIT decision, never quiet green: release runs
	// (ARC_REQUIRE_JOURNEY_STORE=1) FAIL here — a skipped journey is not a passed
	// journey — while local runs still skip loudly with the setup instructions.
	if (!storeReachable && process.env.ARC_REQUIRE_JOURNEY_STORE === '1') {
		throw new Error(
			'ARC_REQUIRE_JOURNEY_STORE=1 but no reachable play store behind the dev server — ' +
				'the session journey CANNOT be skipped on a release gate. Start the local stack ' +
				'(see the spec header) or fix the store config.'
		);
	}
	test.skip(
		!storeReachable,
		'SKIPPING the session journey (no reachable play store behind the dev server). ' +
			'This is NOT release evidence — run the local pgrestEmu stack (see spec header), ' +
			'or set ARC_REQUIRE_JOURNEY_STORE=1 to make this a hard failure.'
	);
});

// ── wire member: the native client's exact HTTP contract (Bearer identity, cmdId) ──

/** Create a VALIDATED anonymous account straight against the auth emulator — the
 *  identity a cookieless native client plays under. Returns its Bearer token. */
async function createWireIdentity(displayName: string): Promise<string> {
	const res = await fetchJson(`${supabaseUrl}/auth/v1/signup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', apikey: supabaseAnonKey },
		body: JSON.stringify({ data: { display_name: displayName } })
	});
	const token = (res.body as { access_token?: string })?.access_token;
	expect(token, `anonymous signup failed (${res.status})`).toBeTruthy();
	return token as string;
}

/** The CANONICAL uid behind a wire Bearer token — resolved from the auth service
 *  itself, so membership assertions pin exact identities, never display names. */
async function wireUserId(token: string): Promise<string> {
	const res = await fetchJson(`${supabaseUrl}/auth/v1/user`, {
		headers: { authorization: `Bearer ${token}`, apikey: supabaseAnonKey }
	});
	const id = (res.body as { id?: string })?.id;
	expect(id, `could not resolve wire uid (${res.status})`).toBeTruthy();
	return id as string;
}

/**
 * The browser's ACTUAL canonical identity (the uid the auth store holds),
 * NAVIGATION-DURABLE: the probe often runs right after a route change (the URL
 * loop exits the instant the address matches, while the document/execution
 * context may still be swapping), and `page.evaluate` then dies with
 * "Execution context was destroyed" — a FALSE gate failure that says nothing
 * about identity. The SAME exact probe is retried (bounded) across context
 * destruction, and a not-yet-rehydrated store (uid still null right after a
 * hard navigation) is re-read until the deadline. The EVIDENCE is unchanged:
 * the exact uid string the live page's auth store holds — never a weaker
 * "some identity exists" or a wire-side substitute.
 */
async function browserCanonicalUid(page: import('@playwright/test').Page): Promise<string | null> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const uid = await page.evaluate(
				() =>
					(window as unknown as { __arcAuth?: { user?: { id?: string } } }).__arcAuth?.user?.id ??
					null
			);
			if (uid) return uid;
			// The store may still be rehydrating after a (hard) navigation — a null
			// here is only FINAL once the deadline passes.
			if (Date.now() > deadline) return null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const navigationDestroyed =
				/context.*destroyed|because of a navigation|frame.*detached|navigating/i.test(message);
			if (!navigationDestroyed || Date.now() > deadline) throw err;
			await page.waitForLoadState('domcontentloaded').catch(() => {});
		}
		await page.waitForTimeout(150);
	}
}

/** EXACT membership rows of one room, straight from the store, scoped by session. */
async function roomMembers(
	sessionId: string
): Promise<{ user_id: string | null; is_bot: boolean; seat_color: string | null; role: string }[]> {
	const res = await fetchJson(
		`${supabaseUrl}/rest/v1/play_session_members?session_id=eq.${sessionId}&select=user_id,is_bot,seat_color,role&order=created_at.asc`,
		{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
	);
	return res.body as { user_id: string | null; is_bot: boolean; seat_color: string | null; role: string }[];
}

async function sessionIdFor(code: string): Promise<string> {
	const res = await fetchJson(
		`${supabaseUrl}/rest/v1/play_game_sessions?room_code=eq.${code}&select=id`,
		{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
	);
	const id = (res.body as { id?: string }[])[0]?.id;
	expect(id, `no session row for room ${code}`).toBeTruthy();
	return id as string;
}

async function wirePost(
	path: string,
	token: string,
	body: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
	const data =
		/\/(commands|claim-seat|start)$/.test(path) && body.cmdId == null
			? {
					...body,
					cmdId: `e2ew-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
				}
			: body;
	const res = await fetchJson(`http://localhost:4173${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(data)
	});
	return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

/** Seed ranked bot candidates (the live project seeds them via scripts/seed-bots.ts).
 *  UNIQUE per run: fixed bot ids get reserved by prior runs' still-active games (the
 *  backfill rightly refuses to double-seat a bot), which starved reruns into a queue
 *  timeout. Fresh disclosed bot accounts every run keep back-to-back runs green on
 *  the same store. */
function uuid(): string {
	return globalThis.crypto.randomUUID();
}

async function seedRankedBots(): Promise<void> {
	const runTag = Date.now().toString(36).slice(-5);
	for (const i of [1, 2, 3, 4]) {
		const res = await fetchJson(`${supabaseUrl}/rest/v1/player_ratings`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'Content-Profile': 'arc_spirits_2d',
				apikey: supabaseAnonKey
			},
			body: JSON.stringify({
				user_id: uuid(),
				display_name: `E2E Bot ${runTag}-${i}`,
				mu: 25,
				sigma: 8.333,
				games_played: 3,
				bot_profile: 'balanced',
				rating_version: 1
			})
		});
		expect(
			res.status,
			`bot seed ${i} failed (${res.status}): ${JSON.stringify(res.body)}`
		).toBeLessThan(300);
	}
}

/**
 * This test file intentionally reuses one durable store across two complete runs.
 * Earlier match tests seed one more bot identity than a four-seat room consumes;
 * those disclosed leftovers must not turn the progressive-enhancement SEARCH test
 * into an immediate match on run two. Retire only test-owned bot candidates and
 * their still-queued rows. Later tests seed fresh, uniquely named candidates.
 */
async function retireRankedBotCandidates(): Promise<void> {
	const ratings = await fetchJson(
		`${supabaseUrl}/rest/v1/player_ratings?select=user_id,bot_profile`,
		{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
	);
	for (const row of (ratings.body as { user_id: string; bot_profile: string | null }[]) ?? []) {
		if (!row.bot_profile) continue;
		const retired = await fetchJson(
			`${supabaseUrl}/rest/v1/player_ratings?user_id=eq.${row.user_id}`,
			{
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					'Content-Profile': 'arc_spirits_2d',
					apikey: supabaseAnonKey
				},
				body: JSON.stringify({ bot_profile: null })
			}
		);
		expect(retired.status, `retire bot candidate ${row.user_id}`).toBeLessThan(300);
	}
	const queued = await fetchJson(
		`${supabaseUrl}/rest/v1/match_queue?is_bot=eq.true&status=eq.queued`,
		{
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				'Content-Profile': 'arc_spirits_2d',
				apikey: supabaseAnonKey
			},
			body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() })
		}
	);
	expect(queued.status, 'retire queued bot candidates').toBeLessThan(300);
}

/**
 * DETERMINISTIC-LANE posture: the functional journey proves the session CONTRACT,
 * so heavy media is isolated from it entirely —
 *   - graphics explicitly OFF (the persistent /play splat never mounts), and
 *   - every heavy asset class BLOCKED at the network layer, .spz/.ply included
 *     (the old regex omitted them, so the 7+ MiB splat still streamed + decoded
 *     under the "blocked assets" claim).
 * The real splat runs in the PERFORMANCE lane instead (scripts/perf-journey.mjs),
 * where its cost is measured, not accidentally mixed into contract timeouts.
 */
async function deterministicPosture(page: Page): Promise<void> {
	// persistedState format: `<json>::v<version>` (persistedState.svelte.ts).
	await page.addInitScript(() => localStorage.setItem('asp:splat-quality', '"off"::v1'));
	await page.route(/\.(png|jpg|jpeg|webp|mp3|ogg|glb|splat|spz|ply|ktx2)(\?.*)?$/, (route) =>
		route.abort()
	);
}

// ── queue traffic instrumentation + failure evidence ─────────────────────────
// The matchmaking acceptance is judged on the REQUEST/RESPONSE record, never
// inferred from the URL: which polls went out, at what cadence, what the server
// answered, and under which attempt token (SANITIZED — a cancel capability never
// lands in an artifact verbatim).

/** Sanitize a search/attempt token for artifacts: prefix + length only. */
function sanitizeToken(token: unknown): string | null {
	return typeof token === 'string' && token.length > 0
		? `${token.slice(0, 8)}…(len ${token.length})`
		: null;
}

interface QueuePollRecord {
	requestAt: number;
	respondedAt: number | null;
	status: number | null;
	attemptId: string | null; // sanitized
	body: {
		status?: string;
		searchId?: string | null; // sanitized
		queued?: number;
		needed?: number;
	} | null;
}

function trackQueueTraffic(page: Page): QueuePollRecord[] {
	const polls: QueuePollRecord[] = [];
	const inFlight = new Map<unknown, QueuePollRecord>();
	page.on('request', (req) => {
		if (!req.url().includes('/api/play/matchmaking/queue') || req.method() !== 'POST') return;
		let attemptId: string | null = null;
		try {
			attemptId = sanitizeToken(JSON.parse(req.postData() ?? '{}').attemptId);
		} catch {
			/* no body */
		}
		const record: QueuePollRecord = {
			requestAt: Date.now(),
			respondedAt: null,
			status: null,
			attemptId,
			body: null
		};
		inFlight.set(req, record);
		polls.push(record);
	});
	page.on('response', (res) => {
		const record = inFlight.get(res.request());
		if (!record) return;
		inFlight.delete(res.request());
		record.respondedAt = Date.now();
		record.status = res.status();
		void res
			.json()
			.then((body: Record<string, unknown>) => {
				record.body = {
					status: typeof body.status === 'string' ? body.status : undefined,
					searchId: sanitizeToken(body.searchId),
					queued: typeof body.queued === 'number' ? body.queued : undefined,
					needed: typeof body.needed === 'number' ? body.needed : undefined
				};
			})
			.catch(() => {});
	});
	return polls;
}

/** Snapshot everything a failed queue journey needs to be diagnosed: the
 *  sanitized poll sequence, the caller's queue row (status + claimed session),
 *  the matched/error UI state, and the current URL. Attached to the test as a
 *  JSON artifact BEFORE the failure is thrown (test-results/ survives the run). */
async function attachQueueEvidence(
	page: Page,
	polls: QueuePollRecord[],
	label: string
): Promise<string> {
	let uid: string | null = null;
	try {
		uid = await page.evaluate(
			() =>
				(window as unknown as { __arcAuth?: { user?: { id?: string } } }).__arcAuth?.user?.id ??
				null
		);
	} catch {
		/* page navigating / context gone */
	}
	let queueRow: unknown = null;
	if (uid) {
		try {
			const res = await fetchJson(
				`${supabaseUrl}/rest/v1/match_queue?user_id=eq.${uid}&select=status,claimed_session_id,is_bot,queued_at,updated_at`,
				{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
			);
			queueRow = res.body;
		} catch {
			queueRow = 'unreachable';
		}
	}
	const evidence = {
		label,
		url: page.url(),
		uid,
		queueRow,
		matchFoundVisible: await page
			.getByTestId('queue-match-found')
			.isVisible()
			.catch(() => false),
		queueErrorText: await page
			.getByTestId('queue-error')
			.textContent()
			.catch(() => null),
		polls
	};
	const rendered = JSON.stringify(evidence, null, 2);
	await test
		.info()
		.attach(`queue-evidence-${label}`, { body: rendered, contentType: 'application/json' })
		.catch(() => {});
	return rendered;
}

test.describe('session journey (web)', () => {
	test('guest Quick Play: anonymous identity → casual UNRATED matchmade room (was 401 wall)', async ({
		page
	}) => {
		test.setTimeout(180_000);
		// ── Acceptance bounds, SEPARATELY NAMED because they judge different
		// claims. A slow matched-room navigation must never be mislabeled a queue
		// failure (the original 8/10 gate defect: the queue HAD matched — the
		// URL-only watcher threw "queue never matched" while the room route loaded).
		const QUEUE_MATCH_BOUND_MS = 45_000; // enqueue → a MATCHED queue response
		const QUEUE_POLL_GAP_BOUND_MS = 8_000; // nominal 2.5s cadence; catches starved timers
		const MATCHED_TO_ROOM_NAV_BOUND_MS = 45_000; // matched response → room URL commit

		await seedRankedBots();
		await deterministicPosture(page);
		await page.addInitScript(() => localStorage.setItem('arc-player-name', 'Web Journey Guest'));
		const polls = trackQueueTraffic(page);
		await page.goto('/play?e2e');

		// Quick Play is an ANCHOR styled as a card (pre-hydration fallback). The JS
		// CTA path is only under test once the page SAYS it is hydrated — a cold
		// click before that exercises the native-fallback contract, which has its
		// own dedicated test below and must not leak into this one as a cold reload.
		await expect(page.getByTestId('play-home')).toHaveAttribute('data-hydrated', 'true', {
			timeout: 30_000
		});
		await page.getByTestId('quick-play').click();
		// No misleading auth wall — the guest gets a real anonymous identity: the
		// session-expired/sign-in gate never appears, and the searching UI TRUTHFULLY
		// labels the guest party casual/unrated, not "ranked". (The casual note's own
		// "Sign in to play ranked" LINK is the truthful upsell, not a wall — so the
		// assertion targets the wall's testid, not a text fragment both share.)
		await expect(page.getByTestId('queue-session-expired')).toHaveCount(0);
		await expect(page.getByTestId('queue-casual-note')).toBeVisible({ timeout: 20_000 });

		// ── PHASE 1 · MATCHMAKING ACCEPTANCE ─────────────────────────────────────
		// Judged on the queue REQUEST/RESPONSE record: polls at a sane cadence, all
		// under ONE attempt token, ending in a MATCHED response. The room URL plays
		// no part in this phase.
		const matchDeadline = Date.now() + QUEUE_MATCH_BOUND_MS;
		let matched: QueuePollRecord | undefined;
		for (;;) {
			matched = polls.find((p) => p.body?.status === 'matched');
			if (matched) break;
			if (
				await page
					.getByTestId('queue-error')
					.isVisible()
					.catch(() => false)
			) {
				const evidence = await attachQueueEvidence(page, polls, 'queue-error');
				throw new Error(
					`MATCHMAKING ACCEPTANCE failed — the queue rendered an error: ` +
						`${await page.getByTestId('queue-error').textContent()}\n${evidence}`
				);
			}
			if (Date.now() > matchDeadline) {
				const evidence = await attachQueueEvidence(page, polls, 'no-match');
				throw new Error(
					`MATCHMAKING ACCEPTANCE failed — no MATCHED queue response within ` +
						`${QUEUE_MATCH_BOUND_MS}ms (and no rendered error).\n${evidence}`
				);
			}
			await page.waitForTimeout(200);
		}
		// One attempt token across every poll of this search (the generation-safe
		// cancellation contract), echoed back by the server on each response.
		const attemptIds = new Set(polls.map((p) => p.attemptId).filter(Boolean));
		expect(attemptIds.size, 'every poll of one search carries ONE attempt token').toBe(1);
		expect(matched.body?.searchId, 'the matched response echoes the search handle').toBeTruthy();
		// Poll cadence up to the match: the nominal 2.5s timer must never be starved
		// into multi-second gaps by anything on the page (the splat scan regression).
		const requestTimes = polls
			.filter((p) => p.requestAt <= (matched.respondedAt ?? Number.MAX_SAFE_INTEGER))
			.map((p) => p.requestAt)
			.sort((a, b) => a - b);
		for (let i = 1; i < requestTimes.length; i += 1) {
			const gap = requestTimes[i] - requestTimes[i - 1];
			if (gap > QUEUE_POLL_GAP_BOUND_MS) {
				const evidence = await attachQueueEvidence(page, polls, 'poll-cadence');
				throw new Error(
					`MATCHMAKING ACCEPTANCE failed — queue poll gap ${gap}ms exceeds ` +
						`${QUEUE_POLL_GAP_BOUND_MS}ms (event loop starved).\n${evidence}`
				);
			}
		}
		// The matched UI state ("Match found — …") is visible unless the navigation
		// already committed past it.
		const matchedUiSeen = await page
			.getByTestId('queue-match-found')
			.isVisible()
			.catch(() => false);
		const alreadyInRoom = /\/play\/[A-Z0-9]{6}/.test(page.url());
		expect(matchedUiSeen || alreadyInRoom, 'matched UI (or an already-committed room)').toBe(true);

		// ── PHASE 2 · NAVIGATION ACCEPTANCE (its own bound; NEVER "queue never
		// matched" — the queue is PROVEN matched above) ──────────────────────────
		try {
			await page.waitForURL(/\/play\/[A-Z0-9]{6}/, { timeout: MATCHED_TO_ROOM_NAV_BOUND_MS });
		} catch {
			const evidence = await attachQueueEvidence(page, polls, 'nav-timeout');
			throw new Error(
				`NAVIGATION ACCEPTANCE failed — the queue MATCHED (see the matched response ` +
					`in the evidence) but the matched-to-room navigation did not commit within ` +
					`${MATCHED_TO_ROOM_NAV_BOUND_MS}ms. This is NOT a matchmaking failure.\n${evidence}`
			);
		}
		const code = page.url().match(/\/play\/([A-Z0-9]{6})/)?.[1] ?? '';
		expect(code).not.toBe('');
		// The harness posture survives the matched navigation: the room URL still
		// carries ?e2e (it used to be dropped, un-gating art preload + cutscenes).
		expect(new URL(page.url()).searchParams.has('e2e'), 'room URL keeps ?e2e').toBe(true);

		// The browser's ACTUAL canonical identity: the uid the auth store holds after
		// the quick-play flow resolved the anonymous account. Every membership claim
		// below is pinned to this exact uid — "some human exists" is not evidence.
		// (Navigation-durable probe: the room route may still be committing here.)
		const browserUid = await browserCanonicalUid(page);
		expect(browserUid, 'browser never resolved a canonical uid').toBeTruthy();

		// Resolve THIS room's session row first — every assertion below is scoped to
		// it. (An unscoped membership query would match leftovers from any earlier
		// run against a shared store and prove nothing about this journey.)
		const session = await fetchJson(
			`${supabaseUrl}/rest/v1/play_game_sessions?room_code=eq.${code}&select=id,mode,visibility`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		const sessionRow = (session.body as { id: string; mode: string; visibility?: string }[])[0];
		expect(sessionRow?.id, `no session row for room ${code}`).toBeTruthy();

		// EXACT membership picture of the matched room: the browser's canonical uid is
		// the SOLE non-bot human, seated exactly once — and every other participant is
		// EXPLICITLY disclosed as a bot on its membership row. PLAYABLE SEATING is
		// part of the claim, not an inference: seat/role are queried per member, the
		// human and EVERY disclosed bot must occupy a distinct playable seat, and no
		// unseated participant may stand in for a seated one.
		const members = await fetchJson(
			`${supabaseUrl}/rest/v1/play_session_members?session_id=eq.${sessionRow.id}&select=user_id,is_bot,seat_color,role&order=created_at.asc`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		const rows = members.body as {
			user_id: string | null;
			is_bot: boolean;
			seat_color: string | null;
			role: string;
		}[];
		expect(rows, 'a full matchmade party').toHaveLength(RANKED_LOBBY_SIZE);
		const humans = rows.filter((r) => !r.is_bot);
		expect(humans, 'exactly ONE non-bot human in the matched room').toHaveLength(1);
		expect(humans[0].user_id).toBe(browserUid);
		// The human HOSTS the matchmade room (bots cannot press Start) and sits at a
		// real playable seat.
		expect(humans[0].role).toBe('host');
		expect(SEAT_COLORS).toContain(humans[0].seat_color);
		const seats: string[] = [];
		for (const row of rows) {
			if (row.user_id !== browserUid) {
				expect(row.is_bot, `undisclosed non-browser participant ${row.user_id}`).toBe(true);
			}
			// EVERY participant — human and disclosed bot alike — occupies a playable
			// seat; an unseated membership cannot satisfy the "playable party" claim.
			expect(
				SEAT_COLORS,
				`participant ${row.user_id} is unseated (seat_color=${row.seat_color})`
			).toContain(row.seat_color ?? '');
			seats.push(row.seat_color as string);
		}
		// …each at a DISTINCT seat: exactly the first N playable seats, once each.
		expect([...seats].sort()).toEqual([...SEAT_COLORS.slice(0, RANKED_LOBBY_SIZE)].sort());

		// ── HONEST BOT RESERVATION (the same-store repeatability proof) ─────────
		// This room's bots must be DISJOINT from every OTHER live room's seated
		// bots — on gate run 2 that set includes run 1's still-active room, so a
		// green run 2 is only evidence if the bots are provably fresh, not the
		// previous run's cast re-seated. Plain two-step queries (live sessions →
		// their bot memberships): embedded-relation filters are not part of the
		// store contract.
		const myBotIds = rows.filter((r) => r.is_bot).map((r) => r.user_id as string);
		const liveSessions = await fetchJson(
			`${supabaseUrl}/rest/v1/play_game_sessions?status=in.(lobby,active)&select=id`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		const otherLiveIds = ((liveSessions.body as { id: string }[]) ?? [])
			.map((r) => r.id)
			.filter((id) => id !== sessionRow.id);
		const reservedElsewhere = new Set<string>();
		for (let i = 0; i < otherLiveIds.length; i += 50) {
			const chunk = otherLiveIds.slice(i, i + 50);
			const seated = await fetchJson(
				`${supabaseUrl}/rest/v1/play_session_members?session_id=in.(${chunk.join(',')})&is_bot=eq.true&select=user_id`,
				{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
			);
			for (const r of (seated.body as { user_id: string | null }[]) ?? []) {
				if (r.user_id) reservedElsewhere.add(r.user_id);
			}
		}
		expect(
			myBotIds.filter((id) => reservedElsewhere.has(id)),
			'this room reuses NO bot seated in any other live room'
		).toEqual([]);
		// …and every bot is a FRESH ELIGIBLE SEED: a disclosed player_ratings bot
		// account, never an invented identity.
		const ratings = await fetchJson(
			`${supabaseUrl}/rest/v1/player_ratings?user_id=in.(${myBotIds.join(',')})&select=user_id,bot_profile`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		const eligible = new Map(
			(((ratings.body as { user_id: string; bot_profile: string | null }[]) ?? [])).map((r) => [
				r.user_id,
				r.bot_profile
			])
		);
		for (const id of myBotIds) {
			expect(eligible.get(id), `bot ${id} is a seeded eligible bot account`).toBeTruthy();
		}

		// Truthful metadata: an ANONYMOUS party is casual/unrated, and the matchmade
		// party room is PRIVATE (never in the public browser).
		expect(sessionRow?.mode).toBe('casual');
		expect(sessionRow?.visibility).toBe('private');

		// …and the public server browser must NOT list the party room.
		const browse = await fetchJson('http://localhost:4173/api/play/sessions');
		const listed = ((browse.body as { rooms?: { roomCode: string }[] }).rooms ?? []).map(
			(r) => r.roomCode
		);
		expect(listed).not.toContain(code);
	});

	test('progressive enhancement: the native /play?action=ranked fallback starts EXACTLY ONE search (and keeps the e2e posture)', async ({
		page
	}) => {
		test.setTimeout(90_000);
		// No bot seeding on purpose: this test proves the SEARCH lifecycle, not a
		// match — retire prior-run test candidates so the queue simply holds one live
		// row until it is cancelled even when this is run two against the same store.
		await retireRankedBotCandidates();
		await deterministicPosture(page);
		await page.addInitScript(() => localStorage.setItem('arc-player-name', 'Prog Enhance Guest'));
		const polls = trackQueueTraffic(page);
		const leaves: (string | null)[] = [];
		page.on('request', (req) => {
			if (req.url().includes('/api/play/matchmaking/leave') && req.method() === 'POST') {
				try {
					leaves.push(sanitizeToken(JSON.parse(req.postData() ?? '{}').searchId));
				} catch {
					leaves.push(null);
				}
			}
		});

		// The EXACT landing a pre-hydration anchor click produces: the Quick Play
		// card's href — /play?action=ranked with the page's harness params carried
		// (the anchor used to hardcode /play?action=ranked, silently dropping ?e2e).
		await page.goto('/play?action=ranked&e2e');
		await expect(page.getByTestId('ranked-view')).toBeVisible({ timeout: 30_000 });
		// ?action is stripped (refresh/back must not re-trigger), ?e2e survives.
		await expect
			.poll(() => new URL(page.url()).searchParams.has('action'), { timeout: 15_000 })
			.toBe(false);
		expect(new URL(page.url()).searchParams.has('e2e')).toBe(true);

		// Two poll periods later: polling is live, and EVERY poll belongs to ONE
		// attempt — a double-start (onMount action + a hydrated click both firing)
		// would show a second attempt token here.
		await expect.poll(() => polls.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
		const attemptIds = new Set(polls.map((p) => p.attemptId).filter(Boolean));
		expect(attemptIds.size, 'exactly ONE search attempt is polling').toBe(1);

		// The store agrees: exactly one live queue row for this browser identity.
		const uid = await browserCanonicalUid(page);
		expect(uid, 'browser resolved a canonical uid').toBeTruthy();
		const liveRow = await fetchJson(
			`${supabaseUrl}/rest/v1/match_queue?user_id=eq.${uid}&select=status`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		expect((liveRow.body as { status: string }[]).map((r) => r.status)).toEqual(['queued']);

		// Cancel ends exactly that one search: the leave carries the SAME attempt
		// token the polls used, and the row lands cancelled.
		await page.getByRole('button', { name: /cancel search/i }).click();
		await expect
			.poll(
				async () =>
					(
						(await fetchJson(`${supabaseUrl}/rest/v1/match_queue?user_id=eq.${uid}&select=status`, {
							headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey }
						})) as { body: { status: string }[] }
					).body.map((r) => r.status),
				{ timeout: 15_000 }
			)
			.toEqual(['cancelled']);
		expect(leaves).toHaveLength(1);
		expect(leaves[0]).toBe([...attemptIds][0]);
	});

	test('ranked disconnect deadline transfers authority once while the account keeps a read-only private view', async () => {
		test.setTimeout(90_000);
		const staleToken = await createWireIdentity('Ranked Stale');
		const freshToken = await createWireIdentity('Ranked Fresh');
		const staleUid = await wireUserId(staleToken);

		const created = await wirePost('/api/play/sessions', staleToken, {
			displayName: 'Ranked Stale'
		});
		expect(created.status).toBe(200);
		const code = String((created.body.projection as { roomCode?: string })?.roomCode ?? '');
		const pool = (created.body.projection as { guardianPool?: string[] })?.guardianPool ?? [];
		const staleMemberId = String((created.body.member as { id?: string })?.id ?? '');
		const joined = await wirePost(`/api/play/sessions/${code}/join`, freshToken, {
			displayName: 'Ranked Fresh'
		});
		expect(joined.status).toBe(200);
		const freshMemberId = String((joined.body.member as { id?: string })?.id ?? '');

		expect((await wirePost(`/api/play/sessions/${code}/claim-seat`, staleToken, { seatColor: 'Red' })).status).toBe(200);
		expect((await wirePost(`/api/play/sessions/${code}/claim-seat`, freshToken, { seatColor: 'Blue' })).status).toBe(200);
		expect((await wirePost(`/api/play/sessions/${code}/commands`, staleToken, {
			command: { type: 'selectGuardian', guardianName: pool[0] }
		})).status).toBe(200);
		expect((await wirePost(`/api/play/sessions/${code}/commands`, freshToken, {
			command: { type: 'selectGuardian', guardianName: pool[1] }
		})).status).toBe(200);
		expect((await wirePost(`/api/play/sessions/${code}/start`, staleToken)).status).toBe(200);

		const sessionId = await sessionIdFor(code);
		const before = await fetchJson(
			`${supabaseUrl}/rest/v1/play_game_sessions?id=eq.${sessionId}&select=revision`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		const beforeRevision = Number((before.body as { revision: number }[])[0]?.revision ?? -1);
		const ranked = await fetchJson(
			`${supabaseUrl}/rest/v1/play_game_sessions?id=eq.${sessionId}`,
			{
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					'Content-Profile': 'arc_spirits_2d',
					apikey: supabaseAnonKey
				},
				body: JSON.stringify({
					mode: 'ranked', visibility: 'private', ranked_season_id: 'season-zero-2026'
				})
			}
		);
		expect(ranked.status).toBeLessThan(300);
		for (const [memberId, lastSeen] of [
			[staleMemberId, new Date(Date.now() - 180_000).toISOString()],
			[freshMemberId, new Date().toISOString()]
		] as const) {
			const updated = await fetchJson(
				`${supabaseUrl}/rest/v1/play_session_members?id=eq.${memberId}`,
				{
					method: 'PATCH',
					headers: {
						'content-type': 'application/json',
						'Content-Profile': 'arc_spirits_2d',
						apikey: supabaseAnonKey
					},
					body: JSON.stringify({ last_seen_at: lastSeen })
				}
			);
			expect(updated.status).toBeLessThan(300);
		}

		const staleView = await fetchJson(`http://localhost:4173/api/play/sessions/${code}/view`, {
			headers: { authorization: `Bearer ${staleToken}` }
		});
		expect(staleView.status).toBe(200);
		const readOnly = staleView.body as {
			member: { id: string | null; role: string; seatColor: string | null };
			projection: { revision: number; viewer: { role: string; seatColor: string | null } };
		};
		expect(readOnly.member).toMatchObject({ id: staleMemberId, role: 'spectator', seatColor: null });
		expect(readOnly.projection.viewer).toMatchObject({ role: 'spectator', seatColor: null });
		expect(readOnly.projection.revision).toBe(beforeRevision + 1);

		const ticket = await wirePost(`/api/play/sessions/${code}/ws-ticket`, staleToken);
		expect(ticket.status).toBe(200);
		expect(ticket.body.role).toBe('spectator');
		const denied = await wirePost(`/api/play/sessions/${code}/commands`, staleToken, {
			command: { type: 'commitRound' }
		});
		expect(denied.status).toBe(401);

		const freshView = await fetchJson(`http://localhost:4173/api/play/sessions/${code}/view`, {
			headers: { authorization: `Bearer ${freshToken}` }
		});
		expect(freshView.status).toBe(200);
		expect((freshView.body as { member: { role: string; seatColor: string } }).member)
			.toMatchObject({ role: 'player', seatColor: 'Blue' });

		const memberRows = await fetchJson(
			`${supabaseUrl}/rest/v1/play_session_members?id=eq.${staleMemberId}&select=is_bot,bot_profile,user_id`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		expect((memberRows.body as { is_bot: boolean; user_id: string }[])[0])
			.toMatchObject({ is_bot: true, user_id: staleUid });
		const participation = await fetchJson(
			`${supabaseUrl}/rest/v1/ranked_participation?session_id=eq.${sessionId}&member_id=eq.${staleMemberId}&select=abandonment_kind`,
			{ headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: supabaseAnonKey } }
		);
		expect((participation.body as { abandonment_kind: string }[]).map((row) => row.abandonment_kind))
			.toEqual(['disconnect_deadline']);

		const retry = await fetchJson(`http://localhost:4173/api/play/sessions/${code}/view`, {
			headers: { authorization: `Bearer ${staleToken}` }
		});
		expect((retry.body as { projection: { revision: number } }).projection.revision)
			.toBe(readOnly.projection.revision);
	});

	test('queue API discloses backfilled bots — never dressed as ordinary waiting humans', async () => {
		await seedRankedBots();
		const token = await createWireIdentity('Disclosure Probe');
		let sawDisclosedBot = false;
		const deadline = Date.now() + 20_000;
		while (!sawDisclosedBot && Date.now() < deadline) {
			const res = await wirePost('/api/play/matchmaking/queue', token);
			expect(res.status).toBe(200);
			if (res.body.status === 'matched') break;
			const players = (res.body.players ?? []) as { isBot?: boolean }[];
			sawDisclosedBot = players.some((p) => p.isBot === true);
			if (!sawDisclosedBot) await new Promise((r) => setTimeout(r, 500));
		}
		await wirePost('/api/play/matchmaking/leave', token);
		expect(sawDisclosedBot, 'no queue poll ever disclosed a bot entry').toBe(true);
	});

	test('aborted anonymous signup surfaces an auth/transport error — never the misleading ranked sign-in wall', async ({
		page
	}) => {
		await deterministicPosture(page);
		await page.addInitScript(() => localStorage.setItem('arc-player-name', 'Offline Guest'));
		// Kill the auth emulator's signup endpoint from this page's perspective — the
		// exact offline/auth-outage shape of the probe.
		await page.route('**/auth/v1/signup*', (route) => route.abort());
		await page.goto('/play?e2e');
		await page.getByTestId('quick-play').click();

		await expect(page.getByTestId('queue-error')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('queue-error')).toContainText(/offline|unavailable|connection/i);
		// The old lie is gone: no "sign in to play ranked" wall, no session-expired state.
		await expect(page.getByText(/sign in to play ranked/i)).toHaveCount(0);
		await expect(page.getByTestId('queue-session-expired')).toHaveCount(0);
	});

	test('persistent live party: invite → private room → mixed-client finish → group-preserving rematch', async ({ page }) => {
		test.setTimeout(180_000);
		await deterministicPosture(page);
		await page.goto('/play?e2e');
		await ensureGuestIdentity(page, 'Party Leader');
		const leaderUid = await browserCanonicalUid(page);
		expect(leaderUid).toBeTruthy();
		const memberToken = await createWireIdentity('Party Member');
		const outsiderToken = await createWireIdentity('Party Outsider');
		const memberUid = await wireUserId(memberToken);
		const outsiderUid = await wireUserId(outsiderToken);

		const partyRes = await page.context().request.post('/api/play/social/party', { data: {} });
		expect(partyRes.ok()).toBe(true);
		const partyId = String((await partyRes.json() as { party: { id: string } }).party.id);
		const inviteRes = await page.context().request.post('/api/play/social/invites', {
			data: { kind: 'party', targetUserId: memberUid }
		});
		expect(inviteRes.ok()).toBe(true);
		const partyInvite = await inviteRes.json() as { token: string; inviteId: string };
		expect((await wirePost(`/api/play/social/invites/${partyInvite.token}`, outsiderToken)).status).toBe(404);
		expect((await wirePost(`/api/play/social/invites/${partyInvite.token}`, memberToken)).status).toBe(200);
		// Honest retry by the same member converges, a second identity cannot replay it.
		expect((await wirePost(`/api/play/social/invites/${partyInvite.token}`, memberToken)).status).toBe(200);

		await wirePost('/api/play/social/presence', memberToken, {
			clientId: 'godot-e2e-client', platform: 'godot', state: 'in_game',
			visibility: 'party', roomCode: 'SECRET'
		});
		const socialBefore = await page.context().request.get('/api/play/social');
		const before = await socialBefore.json() as {
			party: { id: string; members: Array<{ userId: string; presence: { roomCode: string | null } | null }> }
		};
		expect(before.party.id).toBe(partyId);
		expect(before.party.members.map((m) => m.userId).sort()).toEqual([leaderUid, memberUid].sort());
		expect(before.party.members.find((m) => m.userId === memberUid)?.presence?.roomCode).toBe('SECRET');

		const roomRes = await page.context().request.post('/api/play/social/party/room', { data: {} });
		expect(roomRes.ok()).toBe(true);
		const partyRoom = await roomRes.json() as {
			roomCode: string; memberId: string;
			view: { projection: { guardianPool: string[] } };
		};
		expect(partyRoom.roomCode).toMatch(/^[A-Z0-9]{6}$/);
		const browse = await fetchJson('http://localhost:4173/api/play/sessions');
		expect(((browse.body as { rooms?: Array<{ roomCode: string }> }).rooms ?? []).some((r) => r.roomCode === partyRoom.roomCode)).toBe(false);
		expect((await wirePost(`/api/play/sessions/${partyRoom.roomCode}/join`, outsiderToken, { displayName: 'Party Outsider' })).status).toBe(404);
		const memberRoom = await fetchJson('http://localhost:4173/api/play/social/party/room', {
			headers: { authorization: `Bearer ${memberToken}` }
		});
		expect(memberRoom.status).toBe(200);
		expect((memberRoom.body as { roomCode: string }).roomCode).toBe(partyRoom.roomCode);

		// A scoped room invite grants only this private room membership; before the
		// capability is redeemed the outsider cannot even confirm the room exists.
		const roomInviteRes = await page.context().request.post('/api/play/social/invites', {
			data: { kind: 'room', roomCode: partyRoom.roomCode, targetUserId: outsiderUid }
		});
		const roomInvite = await roomInviteRes.json() as { token: string };
		const invitedOutsider = await wirePost(`/api/play/social/invites/${roomInvite.token}`, outsiderToken);
		expect(invitedOutsider.status).toBe(200);
		expect(invitedOutsider.body.roomCode).toBe(partyRoom.roomCode);

		// Seat only the two persistent-party humans; the room-invited spectator is not
		// allowed to become part of the later rematch cohort merely by being present.
		await page.context().request.post(`/api/play/sessions/${partyRoom.roomCode}/claim-seat`, {
			data: { seatColor: 'Red', cmdId: `social-seat-${Date.now().toString(36)}` }
		});
		await wirePost(`/api/play/sessions/${partyRoom.roomCode}/claim-seat`, memberToken, { seatColor: 'Blue' });
		const guardians = partyRoom.view.projection.guardianPool;
		await page.context().request.post(`/api/play/sessions/${partyRoom.roomCode}/commands`, {
			data: { command: { type: 'selectGuardian', guardianName: guardians[0] }, cmdId: `social-g1-${Date.now().toString(36)}` }
		});
		await wirePost(`/api/play/sessions/${partyRoom.roomCode}/commands`, memberToken, {
			command: { type: 'selectGuardian', guardianName: guardians[1] }
		});
		await page.context().request.post(`/api/play/sessions/${partyRoom.roomCode}/start`, {
			data: { cmdId: `social-start-${Date.now().toString(36)}` }
		});
		await page.context().request.post(`/api/play/sessions/${partyRoom.roomCode}/commands`, {
			data: { command: { type: 'adjustVictoryPoints', amount: 30 }, cmdId: `social-vp-${Date.now().toString(36)}` }
		});
		for (let i = 0; i < 8; i += 1) {
			const response = await page.context().request.post(`/api/play/sessions/${partyRoom.roomCode}/commands`, {
				data: { command: { type: 'forceAdvancePhase' }, cmdId: `social-fa-${i}-${Date.now().toString(36)}` }
			});
			if (((await response.json()) as { projection?: { status?: string } }).projection?.status === 'finished') break;
		}
		const privatePostgame = await page.context().request.get(`/api/play/sessions/${partyRoom.roomCode}/postgame`);
		expect(privatePostgame.ok()).toBe(true);
		expect(await privatePostgame.json()).toMatchObject({ status: 'finished' });

		const rematch = await wirePost(`/api/play/sessions/${partyRoom.roomCode}/rematch`, memberToken);
		expect(rematch.status).toBe(200);
		const rematchCode = String(rematch.body.roomCode ?? '');
		const socialAfter = await page.context().request.get('/api/play/social');
		const after = await socialAfter.json() as { party: { activeRoomCode: string; members: unknown[] } };
		expect(after.party.activeRoomCode).toBe(rematchCode);
		const restored = await fetchJson('http://localhost:4173/api/play/social/party/room', {
			headers: { authorization: `Bearer ${memberToken}` }
		});
		expect((restored.body as { roomCode: string }).roomCode).toBe(rematchCode);
		const rematchMembers = await roomMembers(await sessionIdFor(rematchCode));
		expect(rematchMembers.map((row) => row.user_id).sort()).toEqual([leaderUid, memberUid].sort());

		// Revocation is immediate and target-bound; a blocked identity cannot mint a
		// new targeted relationship capability back at the blocker.
		const revokeInviteRes = await page.context().request.post('/api/play/social/invites', {
			data: { kind: 'party', targetUserId: outsiderUid }
		});
		const revokeInvite = await revokeInviteRes.json() as { token: string; inviteId: string };
		expect((await page.context().request.delete('/api/play/social/invites', { data: { inviteId: revokeInvite.inviteId } })).ok()).toBe(true);
		expect((await wirePost(`/api/play/social/invites/${revokeInvite.token}`, outsiderToken)).status).toBe(404);
		await page.context().request.post('/api/play/social/blocks', { data: { userId: outsiderUid } });
		expect((await wirePost('/api/play/social/invites', outsiderToken, { kind: 'friend', targetUserId: leaderUid })).status).toBe(404);

		// The web surface exposes the complete persistent-party lifecycle, not just
		// creation. Leave through the rendered dock and prove the canonical snapshot
		// no longer has a party for this identity.
		await page.getByRole('button', { name: 'Party & Friends' }).click();
		await expect(page.getByTestId('social-leave-party')).toBeVisible();
		await page.getByTestId('social-leave-party').click();
		await expect(page.getByTestId('social-create-party')).toBeVisible();
		const leftSnapshot = await page.context().request.get('/api/play/social');
		expect((await leftSnapshot.json() as { party: unknown }).party).toBeNull();
	});

	test('mixed party: finish → live postgame → replay share → rematch converges into one hidden lobby', async ({
		page,
		browser
	}) => {
		test.setTimeout(180_000);
		await deterministicPosture(page);
		await page.goto('/play?e2e');

		// Browser member: validated anonymous account via the app's own flow (cookie
		// session). Wire member: validated anonymous account over the raw HTTP
		// contract (Authorization: Bearer — no cookies, no room credentials).
		await ensureGuestIdentity(page, 'Browser Host');
		const wireToken = await createWireIdentity('Wire Guest');
		// The EXACT canonical identities of this party — every membership assertion
		// below is pinned to these uids, never to counts or display names.
		// (Navigation-durable probe — same exact-uid evidence.)
		const browserUid = await browserCanonicalUid(page);
		expect(browserUid, 'browser never resolved a canonical uid').toBeTruthy();
		const wireUid = await wireUserId(wireToken);

		const created = (await page
			.context()
			.request.post('/api/play/sessions', { data: { displayName: 'Browser Host' } })
			.then(async (r) => JSON.parse(await r.text()))) as {
			projection: { roomCode: string; guardianPool: string[] };
			member: { id: string };
		};
		const code = created.projection.roomCode;
		const joined = await wirePost(`/api/play/sessions/${code}/join`, wireToken, {
			displayName: 'Wire Guest'
		});
		expect(joined.status).toBe(200);

		// Repeated same-user join RECOVERY: a second join converges idempotently on
		// the SAME membership (no duplicate member rows, no failure).
		const rejoined = await wirePost(`/api/play/sessions/${code}/join`, wireToken, {
			displayName: 'Wire Guest'
		});
		expect(rejoined.status).toBe(200);
		expect((rejoined.body.member as { id?: string })?.id).toBe(
			(joined.body.member as { id?: string })?.id
		);

		// Seats + guardians + start (browser via its cookie context, guest via wire).
		await page.context().request.post(`/api/play/sessions/${code}/claim-seat`, {
			data: { seatColor: 'Red', cmdId: `e2e-h-${Date.now().toString(36)}` }
		});
		await wirePost(`/api/play/sessions/${code}/claim-seat`, wireToken, { seatColor: 'Blue' });
		const pool = created.projection.guardianPool;
		await page.context().request.post(`/api/play/sessions/${code}/commands`, {
			data: {
				command: { type: 'selectGuardian', guardianName: pool[0] },
				cmdId: `e2e-hg-${Date.now().toString(36)}`
			}
		});
		await wirePost(`/api/play/sessions/${code}/commands`, wireToken, {
			command: { type: 'selectGuardian', guardianName: pool[1] }
		});
		await page.context().request.post(`/api/play/sessions/${code}/start`, {
			data: { cmdId: `e2e-s-${Date.now().toString(36)}` }
		});

		// A NOSY SPECTATOR joins the (public, active) room mid-game — a real
		// membership, but never seated. Used below to prove the rematch party gate.
		const spectatorToken = await createWireIdentity('Nosy Spectator');
		const spectatorJoin = await wirePost(`/api/play/sessions/${code}/join`, spectatorToken, {
			displayName: 'Nosy Spectator'
		});
		expect(spectatorJoin.status).toBe(200);

		// Drive to the terminal state: VP to target, then force the round wrap.
		// (Integrity/host tools — admissible here because the dev server runs with
		// NODE_ENV!=production; the production boundary rejects them.)
		await page.context().request.post(`/api/play/sessions/${code}/commands`, {
			data: {
				command: { type: 'adjustVictoryPoints', amount: 30 },
				cmdId: `e2e-vp-${Date.now().toString(36)}`
			}
		});
		for (let i = 0; i < 8; i += 1) {
			const res = await page.context().request.post(`/api/play/sessions/${code}/commands`, {
				data: {
					command: { type: 'forceAdvancePhase' },
					cmdId: `e2e-fa${i}-${Date.now().toString(36)}`
				}
			});
			const body = (await res.json()) as { projection?: { status?: string } };
			if (body.projection?.status === 'finished') break;
		}
		const summary = await fetchJson(`http://localhost:4173/api/play/sessions/${code}/postgame`);
		expect((summary.body as { status: string }).status).toBe('finished');

		// EXACT membership picture of the finished room (never a count): the browser
		// and wire identities each hold exactly ONE membership and are SEATED (Red /
		// Blue); the spectator holds exactly one UNSEATED membership; nobody else and
		// no bot is present.
		const spectatorUid = await wireUserId(spectatorToken);
		const originalMembers = await roomMembers(await sessionIdFor(code));
		const byUid = (uid: string | null) => originalMembers.filter((m) => m.user_id === uid);
		expect(byUid(browserUid)).toHaveLength(1);
		expect(byUid(browserUid)[0].seat_color).toBe('Red');
		expect(byUid(wireUid)).toHaveLength(1);
		expect(byUid(wireUid)[0].seat_color).toBe('Blue');
		expect(byUid(spectatorUid)).toHaveLength(1);
		// Unseated = no seat mirror (null on real PostgREST; the emulator omits a
		// column that was never written — both mean "holds no seat").
		expect(byUid(spectatorUid)[0].seat_color ?? null).toBeNull(); // joined, never seated
		expect(originalMembers.filter((m) => m.is_bot)).toHaveLength(0);
		expect(originalMembers).toHaveLength(3);

		// Reload-restore: the browser opens the finished room and is recognized by
		// its ACCOUNT session — the postgame screen mounts with the rematch affordance.
		await page.goto(`/play/${code}?e2e&ws=${encodeURIComponent(WS_URL)}`);
		await expect(page.getByTestId('postgame')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('postgame-rematch')).toBeVisible();
		await page.getByTestId('postgame-review-open').click();
		const review = page.getByTestId('postgame-review');
		await expect(review).toBeVisible();
		await expect(review).toContainText('Recorded evidence');
		await expect(review).toContainText('Possible next experiment');
		await expect(review).toContainText('not a claim that a different move would certainly change');
		await review.getByRole('button', { name: 'Close match review' }).click();
		await expect(review).toBeHidden();

		// The participant creates a stable public replay through the REAL postgame
		// control. An unauthenticated context can step every authoritative public
		// revision, but the response contains no room/member identity or owner-private
		// state. Revocation is immediate (no stale cache), and re-sharing reactivates
		// the SAME capability instead of minting an unbounded trail of links.
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		const shareResponsePromise = page.waitForResponse((response) =>
			response.url().endsWith('/api/play/replays') && response.request().method() === 'POST'
		);
		await page.getByTestId('postgame-share-replay').click();
		const shareResponse = await shareResponsePromise;
		expect(shareResponse.ok()).toBe(true);
		const share = await shareResponse.json() as { code: string; url: string };
		expect(share.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
		await expect(page.getByTestId('postgame-share-replay')).toContainText('Replay link ready');

		const publicContext = await browser.newContext();
		const publicApi = await publicContext.request.get(`http://localhost:4173/api/play/replays/${share.code}`);
		expect(publicApi.ok()).toBe(true);
		const publicReplay = await publicApi.json() as {
			gameId: string; mode: string; frames: Array<{ revision: number }>; snapshots: unknown[];
			pivotalRounds: Array<{ playerColor: string; revision?: number }>;
		};
		expect(publicReplay.mode).toBe('command-revision');
		expect(publicReplay.frames.length).toBeGreaterThan(3);
		expect(publicReplay.pivotalRounds.some((moment) => moment.playerColor === 'Red' && moment.revision != null)).toBe(true);
		const replayWire = JSON.stringify(publicReplay);
		for (const forbidden of ['"handDraws"', '"pendingDraw"', '"manualPrompts"', '"memberId"', code]) {
			expect(replayWire).not.toContain(forbidden);
		}
		const publicPage = await publicContext.newPage();
		await publicPage.goto(`http://localhost:4173${share.url}`);
		await expect(publicPage.getByTestId('replay-viewer')).toBeVisible();
		await expect(publicPage.getByTestId('replay-revision-scrubber')).toBeVisible();
		await expect(publicPage.getByRole('button', { name: /Red pivotal round/i })).toBeVisible();
		const highlightDownload = publicPage.waitForEvent('download');
		await publicPage.getByTestId('replay-highlight-export').click();
		expect((await highlightDownload).suggestedFilename()).toBe(`arc-spirits-${share.code}-highlight.svg`);

		const revoked = await page.context().request.delete(`/api/play/replays/${share.code}`, { data: {} });
		expect(revoked.ok()).toBe(true);
		expect((await publicContext.request.get(`http://localhost:4173/api/play/replays/${share.code}`)).status()).toBe(404);
		const reactivated = await page.context().request.post('/api/play/replays', { data: { gameId: publicReplay.gameId } });
		expect(reactivated.ok()).toBe(true);
		expect((await reactivated.json() as { code: string }).code).toBe(share.code);
		expect((await publicContext.request.get(`http://localhost:4173/api/play/replays/${share.code}`)).ok()).toBe(true);
		await publicContext.close();

		// Canonical progression is reconciled from the trusted match-result ledger,
		// never from PostGameView/localStorage. Re-reads and repeat purchase are
		// idempotent; equip survives a page reload (cross-process/store truth).
		const progression1 = await page.context().request.get('/api/play/progression');
		expect(progression1.ok()).toBe(true);
		const p1 = (await progression1.json()) as {
			credits: number; rankXp: number; ownedItemIds: string[];
			guardianMastery: Array<{ guardianName: string; gamesPlayed: number }>;
		};
		expect(p1.credits).toBeGreaterThan(80);
		expect(p1.rankXp).toBeGreaterThan(0);
		expect(p1.guardianMastery.some((entry) => entry.guardianName === pool[0] && entry.gamesPlayed === 1)).toBe(true);
		const purchase = await page.context().request.post('/api/play/progression/purchase', {
			data: { itemId: 'border-tidal-veil' }
		});
		expect(purchase.ok()).toBe(true);
		const bought = (await purchase.json()) as { credits: number; ownedItemIds: string[] };
		expect(bought.credits).toBe(p1.credits - 70);
		expect(bought.ownedItemIds).toContain('border-tidal-veil');
		const repeatPurchase = await page.context().request.post('/api/play/progression/purchase', {
			data: { itemId: 'border-tidal-veil' }
		});
		expect((await repeatPurchase.json() as { credits: number }).credits).toBe(bought.credits);
		const equip = await page.context().request.post('/api/play/progression/equip', {
			data: { itemId: 'border-tidal-veil' }
		});
		expect(equip.ok()).toBe(true);
		expect((await equip.json() as { equippedBorderId: string }).equippedBorderId).toBe('border-tidal-veil');
		await page.reload({ waitUntil: 'domcontentloaded' });
		const restoredProgression = await page.context().request.get('/api/play/progression');
		expect((await restoredProgression.json() as { equippedBorderId: string }).equippedBorderId).toBe('border-tidal-veil');
		const profilePage = await page.context().newPage();
		await profilePage.goto('/account');
		const loadout = profilePage.getByTestId('cosmetic-loadout');
		await expect(loadout).toBeVisible();
		await expect(loadout).toContainText('Guardian Expression');
		await expect(loadout).toContainText(pool[0]);
		await expect(profilePage.getByTestId('cosmetic-border-tidal-veil').getByRole('button')).toHaveText('Equipped');
		await profilePage.close();

		// The WIRE member opens the rematch lobby FIRST…
		const wireRematch = await wirePost(`/api/play/sessions/${code}/rematch`, wireToken);
		expect(wireRematch.status).toBe(200);
		const rematchCode = String(wireRematch.body.roomCode ?? '');
		expect(rematchCode).toMatch(/^[A-Z0-9]{6}$/);

		// REMATCH HIJACK regression: the spectator holds a REAL membership in the
		// original public room but was never seated in the finished game — the party
		// gate refuses them (creation and join), and their postgame summary carries
		// no rematch pointer at all.
		const hijack = await wirePost(`/api/play/sessions/${code}/rematch`, spectatorToken);
		expect(hijack.status).toBe(403);
		const spectatorSummary = await fetchJson(
			`http://localhost:4173/api/play/sessions/${code}/postgame`,
			{ headers: { authorization: `Bearer ${spectatorToken}` } }
		);
		expect((spectatorSummary.body as { rematch?: unknown }).rematch ?? null).toBeNull();

		// …the rematch lobby is HIDDEN: not browsable, and a generic outsider join is
		// refused without even confirming the room exists.
		const browse = await fetchJson('http://localhost:4173/api/play/sessions');
		const listed = ((browse.body as { rooms?: { roomCode: string }[] }).rooms ?? []).map(
			(r) => r.roomCode
		);
		expect(listed).not.toContain(rematchCode);
		const outsiderToken = await createWireIdentity('Party Crasher');
		const crash = await wirePost(`/api/play/sessions/${rematchCode}/join`, outsiderToken, {
			displayName: 'Party Crasher'
		});
		expect(crash.status).toBe(404);

		// …the browser's postgame advertises it live, and clicking joins the SAME lobby.
		await expect(page.getByTestId('postgame-rematch')).toContainText(/join rematch/i, {
			timeout: 20_000
		});
		await page.getByTestId('postgame-rematch').click();
		await page.waitForURL(new RegExp(`/play/${rematchCode}`), { timeout: 30_000 });

		// THE URL IS NOT THE PROOF. SvelteKit reuses the room-page component for the
		// A→B param navigation, so the page must RE-TARGET the live store: the
		// RENDERED lobby shows room B's code (exactly one such element — no zombie
		// room-A view underneath)…
		await expect(page.getByTestId('room-code')).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByTestId('room-code')).toHaveText(rematchCode, { timeout: 30_000 });
		// …and the STORE's live connection stack serves B and only B: the play
		// store's room/channel are room B's, room A holds no transport or channel,
		// and at most one WS transport owns the page (zero here — the client-side
		// param navigation drops the dev-only ?ws override, so B runs on the
		// HTTP/broadcast path; what matters is that room A's transport is GONE).
		await expect
			.poll(
				async () =>
					(await page.evaluate(
						() =>
							(
								window as unknown as {
									__arcPlayDiag?: () => {
										roomCode: string | null;
										transportRoom: string | null;
										openTransports: number;
										channelTopic: string | null;
									};
								}
							).__arcPlayDiag?.() ?? null
					)) as {
						roomCode: string | null;
						transportRoom: string | null;
						openTransports: number;
						channelTopic: string | null;
					} | null,
				{ timeout: 30_000 }
			)
			.toMatchObject({ roomCode: rematchCode, channelTopic: `room:${rematchCode}` });
		const diag = (await page.evaluate(
			() =>
				(
					window as unknown as { __arcPlayDiag?: () => Record<string, unknown> }
				).__arcPlayDiag?.() ?? null
		)) as {
			roomCode: string | null;
			transportRoom: string | null;
			openTransports: number;
			channelTopic: string | null;
		} | null;
		expect(diag).not.toBeNull();
		expect(diag!.roomCode).toBe(rematchCode);
		expect(diag!.channelTopic).toBe(`room:${rematchCode}`);
		expect(diag!.transportRoom === null || diag!.transportRoom === rematchCode).toBe(true);
		expect(diag!.transportRoom).not.toBe(code); // room A's transport is gone
		expect(diag!.openTransports).toBeLessThanOrEqual(1); // exactly one owner (or HTTP-only)

		// One lobby, both party members (and only that party) inside. Rematch status
		// is MEMBER-ONLY postgame data (Bearer identity here); an outsider's summary
		// of the same public room carries no rematch pointer at all.
		const status = await fetchJson(`http://localhost:4173/api/play/sessions/${code}/postgame`, {
			headers: { authorization: `Bearer ${wireToken}` }
		});
		const rematch = (status.body as { rematch?: { roomCode: string; joinedCount: number } })
			.rematch;
		expect(rematch?.roomCode).toBe(rematchCode);
		expect(rematch?.joinedCount).toBe(2);

		// joinedCount is a CLAIM — the store's membership rows are the proof. The
		// rematch lobby contains EXACTLY the two original party identities, once
		// each, and nobody else: no spectator, no outsider, no bot.
		const rematchMembers = await roomMembers(await sessionIdFor(rematchCode));
		expect(rematchMembers).toHaveLength(2);
		const rematchUids = rematchMembers.map((m) => m.user_id).sort();
		expect(rematchUids).toEqual([browserUid, wireUid].sort());
		expect(rematchMembers.filter((m) => m.user_id === browserUid)).toHaveLength(1);
		expect(rematchMembers.filter((m) => m.user_id === wireUid)).toHaveLength(1);
		expect(rematchMembers.filter((m) => m.is_bot)).toHaveLength(0);
		expect(rematchMembers.some((m) => m.user_id === spectatorUid)).toBe(false);
		const outsiderUid = await wireUserId(outsiderToken);
		expect(rematchMembers.some((m) => m.user_id === outsiderUid)).toBe(false);

		const outsiderView = await fetchJson(
			`http://localhost:4173/api/play/sessions/${code}/postgame`,
			{
				headers: { authorization: `Bearer ${outsiderToken}` }
			}
		);
		expect((outsiderView.body as { rematch?: unknown }).rematch ?? null).toBeNull();
	});
});
