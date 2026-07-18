/**
 * EXACT-SCOPE OPERATION FENCING — same-account adversarial races, run against the
 * REAL play store wiring (module state, navigation/refresh/chat/command paths and
 * the live WsTransport) with fetch, WebSocket and the SvelteKit environment faked.
 *
 * The identity-generation fence (playStore.identity.test.ts) is necessary but not
 * sufficient: every one of these repros happens WITHOUT any account change.
 *
 *   - ROOM A → B: a room-A response (held at the HEADERS or at the DELAYED
 *     `response.json()` BODY) completing after the player entered room B must not
 *     replace room B, regress its member picture, or clear its loading state.
 *   - SAME-ROOM REVISION REGRESSION: an older view landing after a newer one is
 *     discarded WHOLE — projection AND member/seat picture.
 *   - RESET RE-ENTRY RACE: the post-reset re-entry failing after the player
 *     already entered a different room must not null that newer room.
 *   - STALE TRANSPORT CALLBACKS: view/status frames surfacing from a REPLACED
 *     WebSocket transport (late delivery) must not flip the current connection's
 *     flags or apply the dead room's view.
 *   - LOST-ACK WS→HTTP: the HTTP fallback reuses the SAME cmdId and the ORIGINAL
 *     room + revision captured at operation start — never the room/revision the
 *     store has moved on to.
 *   - SAME-UID TOKEN REFRESH: rotating the access token (same account) is not an
 *     identity change — in-flight and subsequent operations keep working and the
 *     active room is preserved.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
// A configured WS origin so startTransport actually runs against the fake socket.
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_WS_SERVER_URL: 'ws://rooms.test:8787/ws' }
}));
vi.mock('$lib/supabase', () => ({
	supabase: {
		channel: () => {
			const ch = {
				on: () => ch,
				subscribe: () => ch,
				unsubscribe: () => {}
			};
			return ch;
		},
		removeChannel: () => {}
	}
}));
vi.mock('$lib/auth/auth.svelte', () => ({
	auth: { session: null as { access_token: string } | null }
}));

import {
	createPlayRoom,
	getPlayState,
	hydratePlayRoom,
	joinPlayRoom,
	loadPlayRoom,
	loadRoomChat,
	resetPlayIdentityState,
	retargetPlayRoom,
	RoomNavigationCancelled,
	sendPlayCommand,
	sendRoomChat
} from './playStore.svelte';
import { auth } from '$lib/auth/auth.svelte';
import type { GameCommand } from '$lib/play/types';
import type { RoomView } from '$lib/play/server/service';

// ── minimal DOM surface the store touches (no jsdom needed) ───────────────────────
(globalThis as Record<string, unknown>).window = {
	addEventListener: () => {},
	location: { search: '' }
};
(globalThis as Record<string, unknown>).document = {
	addEventListener: () => {},
	visibilityState: 'visible'
};
(globalThis as Record<string, unknown>).localStorage = {
	length: 0,
	key: () => null,
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {}
};

// ── fake WebSocket (registry of every socket the transport opens) ─────────────────
class FakeSocket {
	static instances: FakeSocket[] = [];
	readonly url: string;
	readyState = 0; // CONNECTING
	sent: Record<string, unknown>[] = [];
	onopen: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	/** Snapshot of the last real message handler, surviving teardown's nulling —
	 *  models a queued/late delivery arriving after the transport moved on. */
	lateMessageHandler: ((ev: { data: unknown }) => void) | null = null;
	#onmessage: ((ev: { data: unknown }) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}
	get onmessage() {
		return this.#onmessage;
	}
	set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
		this.#onmessage = handler;
		if (handler) this.lateMessageHandler = handler;
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3; // CLOSED
	}
	// test drivers
	open() {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}
	message(payload: unknown) {
		this.#onmessage?.({ data: JSON.stringify(payload) });
	}
	/** Deliver through the SNAPSHOT handler — a late frame from a replaced socket. */
	lateMessage(payload: unknown) {
		this.lateMessageHandler?.({ data: JSON.stringify(payload) });
	}
	drop() {
		this.readyState = 3;
		this.onclose?.();
	}
}

// ── controllable fetch (headers-held and BODY-held variants) ──────────────────────
type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: () => Promise.resolve(structuredClone(body))
	} as unknown as Response;
}

interface Held {
	url: string;
	init: RequestInit | undefined;
	release: (body: unknown, ok?: boolean) => void;
	/** Reject the held fetch outright (abort/network death — NO response at all). */
	fail: (err: unknown) => void;
}

let routes: { match: (url: string) => boolean; handler: Handler; once?: boolean }[] = [];
let unmatched: string[] = [];

function route(match: (url: string) => boolean, handler: Handler, once = false) {
	routes.push({ match, handler, once });
}

/** Held routes are PREPENDED so they win over previously-registered defaults. */
function routeFirst(match: (url: string) => boolean, handler: Handler) {
	routes.unshift({ match, handler, once: true });
}

/** Hold the whole response — the DELAYED-HEADERS window. */
function hold(match: (url: string) => boolean): Held {
	const held: Partial<Held> = {};
	const gate = new Promise<{ body: unknown; ok: boolean }>((resolve, reject) => {
		held.release = (body, ok = true) => resolve({ body, ok });
		held.fail = (err) => reject(err);
	});
	routeFirst(match, (url, init) => {
		held.url = url;
		held.init = init;
		return gate.then(({ body, ok }) => jsonResponse(body, ok));
	});
	return held as Held;
}

/** Answer the HEADERS immediately but hold the `response.json()` BODY — the
 *  delayed-body window the header-only fence misses. */
function holdBody(match: (url: string) => boolean, ok = true, status = 200): Held {
	const held: Partial<Held> = {};
	const gate = new Promise<unknown>((resolve) => {
		held.release = (body) => resolve(body);
	});
	routeFirst(match, (url, init) => {
		held.url = url;
		held.init = init;
		return {
			ok,
			status,
			json: () => gate.then((body) => structuredClone(body))
		} as unknown as Response;
	});
	return held as Held;
}

function memberView(roomCode: string, revision: number, memberId = 'm-self'): RoomView {
	return {
		projection: { roomCode, revision, status: 'active' },
		member: { id: memberId, role: 'host', seatColor: 'Red', displayName: 'Self' }
	} as unknown as RoomView;
}

function roomDefaults(roomCode: string, revision: number, memberId = 'm-self') {
	route(
		(url) => url.includes(`/sessions/${roomCode}/view`),
		() => jsonResponse(memberView(roomCode, revision, memberId))
	);
	route(
		(url) => url.includes(`/sessions/${roomCode}/chat`),
		() => jsonResponse({ messages: [] })
	);
	route(
		(url) => url.includes(`/sessions/${roomCode}/ws-ticket`),
		() => jsonResponse({ ticket: `pwt_${'t'.repeat(43)}` })
	);
}

beforeEach(() => {
	routes = [];
	unmatched = [];
	FakeSocket.instances = [];
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const index = routes.findIndex((entry) => entry.match(url));
		if (index === -1) {
			unmatched.push(url);
			return Promise.resolve(jsonResponse({ message: `no route for ${url}` }, false, 500));
		}
		const entry = routes[index];
		if (entry.once) routes.splice(index, 1);
		return Promise.resolve(entry.handler(url, init));
	});
});

afterEach(() => {
	getPlayState().disconnect();
	vi.unstubAllGlobals();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Bring the newest fake socket through open → ticket mint → joined(view). */
async function joinNewestSocket(view: RoomView) {
	const socket = FakeSocket.instances.at(-1)!;
	socket.open();
	await flush(); // ticket fetch (headers)
	await flush(); // ticket body parse
	expect(socket.sent.some((frame) => frame.t === 'join')).toBe(true);
	socket.message({ t: 'joined', view: { ...view, affordances: {} } });
	return socket;
}

describe('room A → B transitions (same account)', () => {
	test('a held room-A LOAD (delayed headers) cannot replace room B, and its finally cannot clear B\'s state', async () => {
		const heldA = hold((url) => url.includes('/sessions/ROOMA1/view'));
		const pendingA = loadPlayRoom('ROOMA1');
		const outcomeA = pendingA.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush();
		expect(heldA.url).toContain('/sessions/ROOMA1/view');

		// The player gives up on A and enters room B, which lands first.
		roomDefaults('ROOMB1', 3, 'm-in-b');
		await loadPlayRoom('ROOMB1');
		expect(getPlayState().room?.roomCode).toBe('ROOMB1');

		// Now the slow room-A response arrives — at a HIGHER revision than B, so
		// only the navigation fence (not any revision rule) can reject it.
		heldA.release(memberView('ROOMA1', 99, 'm-in-a'));
		expect(await outcomeA).toMatch(/superseded/i);
		expect(getPlayState().room?.roomCode).toBe('ROOMB1');
		expect(getPlayState().room?.revision).toBe(3);
		expect(getPlayState().member?.id).toBe('m-in-b');
		expect(getPlayState().isLoading).toBe(false);
		expect(getPlayState().error).toBeNull(); // the stale op surfaced no error either
	});

	test('a held room-A view with a DELAYED response.json() body is fenced at the body boundary', async () => {
		// Headers arrive while room A is still current; the BODY only lands after
		// the store re-targeted room B — the exact window a headers-only fence misses.
		const heldBody = holdBody((url) => url.includes('/sessions/ROOMA2/view'));
		const pendingA = loadPlayRoom('ROOMA2');
		const outcomeA = pendingA.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush(); // headers consumed; json() pending
		expect(heldBody.url).toContain('/sessions/ROOMA2/view');

		roomDefaults('ROOMB2', 7, 'm-in-b2');
		await loadPlayRoom('ROOMB2');

		heldBody.release(memberView('ROOMA2', 50, 'm-in-a2'));
		expect(await outcomeA).toMatch(/superseded/i);
		expect(getPlayState().room?.roomCode).toBe('ROOMB2');
		expect(getPlayState().member?.id).toBe('m-in-b2');
	});

	test('a room-A CHAT poll (delayed body) landing after entering room B never merges into B\'s thread', async () => {
		roomDefaults('ROOMA3', 1);
		hydratePlayRoom(memberView('ROOMA3', 1));
		await flush();

		const heldChat = holdBody((url) => url.includes('/sessions/ROOMA3/chat'));
		const chatFetch = loadRoomChat('ROOMA3');
		await flush();
		expect(heldChat.url).toContain('/sessions/ROOMA3/chat');

		roomDefaults('ROOMB3', 2, 'm-b3');
		await loadPlayRoom('ROOMB3');

		heldChat.release({
			messages: [
				{
					id: 'msg-a',
					memberId: 'm-else',
					displayName: 'Other',
					body: 'room A talk',
					createdAt: '2026-07-10T00:00:00Z'
				}
			]
		});
		expect(await chatFetch).toEqual([]);
		expect(getPlayState().chatMessages).toEqual([]);
		expect(getPlayState().chatError).toBeNull();
	});

	test('an HTTP command sent in room A resolving after entering room B applies nothing to B', async () => {
		roomDefaults('ROOMA4', 4);
		hydratePlayRoom(memberView('ROOMA4', 4));
		await flush();

		const heldCmd = hold((url) => url.includes('/sessions/ROOMA4/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		const outcome = pending.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush();
		expect(heldCmd.url).toContain('/sessions/ROOMA4/commands');

		roomDefaults('ROOMB4', 2, 'm-b4');
		await loadPlayRoom('ROOMB4');

		heldCmd.release(memberView('ROOMA4', 5));
		expect(await outcome).toMatch(/superseded/i);
		expect(getPlayState().room?.roomCode).toBe('ROOMB4');
		expect(getPlayState().room?.revision).toBe(2);
	});
});

describe('same-room revision regression', () => {
	test('an OLDER view (projection AND member picture) landing after a newer one is discarded whole', async () => {
		roomDefaults('REGR01', 8);
		hydratePlayRoom(memberView('REGR01', 8));
		await flush();
		expect(getPlayState().member?.seatColor).toBe('Red');

		// A slow command round-trip from revision 5 finally lands: its projection is
		// older AND its member snapshot says we hold no seat. Neither may apply.
		const heldCmd = hold((url) => url.includes('/sessions/REGR01/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		const swallowed = pending.then(
			() => 'applied',
			() => 'rejected'
		);
		await flush();
		heldCmd.release({
			projection: { roomCode: 'REGR01', revision: 5, status: 'active' },
			member: { id: 'm-self', role: 'player', seatColor: null, displayName: 'Self' }
		});
		await swallowed;
		expect(getPlayState().room?.revision).toBe(8);
		expect(getPlayState().member?.seatColor).toBe('Red'); // seat NOT regressed
	});
});

describe('reset re-entry race', () => {
	test('a FAILED post-reset re-entry cannot null a room the player entered afterwards', async () => {
		roomDefaults('RESET1', 5);
		hydratePlayRoom(memberView('RESET1', 5));
		await flush();

		// Sign-out: the re-entry (as the new identity) is held in flight…
		const heldReentry = hold((url) => url.includes('/sessions/RESET1/view'));
		resetPlayIdentityState();
		await flush();
		expect(heldReentry.url).toContain('/sessions/RESET1/view');

		// …while the (new) account already navigated into a different room.
		roomDefaults('FRESH2', 1, 'm-new');
		await loadPlayRoom('FRESH2');
		expect(getPlayState().room?.roomCode).toBe('FRESH2');

		// The old re-entry now FAILS (private room / signed out). Its catch used to
		// do `room = null` unconditionally — clearing the newer room.
		heldReentry.release({ message: 'Room not found.' }, false);
		await flush();
		expect(getPlayState().room?.roomCode).toBe('FRESH2');
		expect(getPlayState().member?.id).toBe('m-new');
	});
});

describe('stale WebSocket transport callbacks', () => {
	test('late view/status frames from a REPLACED transport neither apply the dead room nor flip the current connection flags', async () => {
		roomDefaults('WSROOM', 2);
		hydratePlayRoom(memberView('WSROOM', 2));
		const socketA = await joinNewestSocket(memberView('WSROOM', 2));

		// Re-target to room B — the store replaces the transport (new socket).
		roomDefaults('WSNEXT', 1, 'm-next');
		await loadPlayRoom('WSNEXT');
		await joinNewestSocket(memberView('WSNEXT', 1, 'm-next'));
		expect(getPlayState().room?.roomCode).toBe('WSNEXT');

		// A late delivery surfaces through room A's dead socket: a joined frame
		// (which re-fires onStatus connected:true on the old transport) and a huge-
		// revision delta for room A. Without instance scoping this would flip the
		// current connection's wsConnected and stomp room B with room A's view.
		socketA.lateMessage({ t: 'joined', view: { ...memberView('WSROOM', 500), affordances: {} } });
		socketA.lateMessage({
			t: 'delta',
			toRevision: 501,
			patch: { ...memberView('WSROOM', 501), affordances: {} }
		});
		await flush();
		expect(getPlayState().room?.roomCode).toBe('WSNEXT');
		expect(getPlayState().room?.revision).toBe(1);
		expect(getPlayState().member?.id).toBe('m-next');

		// The current room still has exactly one projection socket, but mutations use
		// the single HTTP authority. Late frames from A cannot divert either path.
		const socketB = FakeSocket.instances.at(-1)!;
		const heldCommand = hold((url) => url.includes('/sessions/WSNEXT/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		await flush();
		expect(socketB.sent.some((f) => f.t === 'command')).toBe(false);
		expect(heldCommand.url).toContain('/sessions/WSNEXT/commands');
		heldCommand.release(memberView('WSNEXT', 2, 'm-next'));
		const view = await pending;
		expect(view.projection.revision).toBe(2);
	});
});

describe('single HTTP command authority with a live projection socket', () => {
	test('the command bypasses WS and carries one cmdId plus the ORIGINAL captured revision', async () => {
		roomDefaults('WSFALL', 5);
		hydratePlayRoom(memberView('WSFALL', 5));
		const socket = await joinNewestSocket(memberView('WSFALL', 5));

		const heldHttp = hold((url) => url.includes('/sessions/WSFALL/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		await flush();
		expect(socket.sent.some((f) => f.t === 'command')).toBe(false);
		expect(heldHttp.url).toContain('/sessions/WSFALL/commands');
		const body = JSON.parse(String(heldHttp.init?.body)) as Record<string, unknown>;
		expect(body.cmdId).toMatch(/^c/);
		expect(body.expectedRevision).toBe(5);

		// A concurrent projection delta may move the rendered room while the request
		// is in flight; the already-issued mutation remains bound to revision 5.
		socket.message({
			t: 'delta',
			toRevision: 6,
			patch: { ...memberView('WSFALL', 6), affordances: {} }
		});
		expect(getPlayState().room?.revision).toBe(6);

		heldHttp.release(memberView('WSFALL', 7));
		const view = await pending;
		expect(view.projection.revision).toBe(7);
	});
});

describe('component-lane cancellation (unmount abort)', () => {
	test('an ABORTED create resolving late installs nothing: room untouched, no new transport, no error, loading released', async () => {
		// Deterministic base state: the player is in BASE01 (one live transport).
		roomDefaults('BASE01', 1);
		hydratePlayRoom(memberView('BASE01', 1));
		await flush();
		const socketsBefore = FakeSocket.instances.length;

		const heldCreate = hold((url) => url.endsWith('/api/play/sessions'));
		const controller = new AbortController();
		const pending = createPlayRoom('Ghost Host', { signal: controller.signal });
		const outcome = pending.then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();
		expect(heldCreate.url).toContain('/api/play/sessions');
		expect(getPlayState().isLoading).toBe(true);

		// The component unmounts (user backed out) while the create is in flight…
		controller.abort();
		// …and the server response (a fully created room) lands afterwards.
		roomDefaults('CANCL1', 1, 'm-ghost');
		heldCreate.release(memberView('CANCL1', 1, 'm-ghost'));

		const err = await outcome;
		expect(err).toBeInstanceOf(RoomNavigationCancelled); // the dead .then(goto) never runs
		expect(getPlayState().room?.roomCode).toBe('BASE01'); // never installed
		expect(FakeSocket.instances).toHaveLength(socketsBefore); // never connected
		expect(getPlayState().error).toBeNull(); // no error to a dead page
		expect(getPlayState().isLoading).toBe(false); // its own loading released
	});

	test('an ABORTED load cannot install/connect either, and a cancelled op cannot clear a NEWER navigation\'s loading', async () => {
		roomDefaults('BASE02', 1);
		hydratePlayRoom(memberView('BASE02', 1));
		await flush();

		const heldOld = hold((url) => url.includes('/sessions/CANCL2/view'));
		const controller = new AbortController();
		const pendingOld = loadPlayRoom('CANCL2', { signal: controller.signal });
		const outcomeOld = pendingOld.then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();

		// A NEWER navigation starts (held) — it now owns the loading flag…
		const heldNew = hold((url) => url.includes('/sessions/CANCL3/view'));
		const pendingNew = loadPlayRoom('CANCL3');
		await flush();
		expect(getPlayState().isLoading).toBe(true);

		// …the old component unmounts and its response lands: superseded/cancelled,
		// and the newer navigation's loading is NOT cleared by the stale finally.
		controller.abort();
		heldOld.release(memberView('CANCL2', 9, 'm-old'));
		await outcomeOld;
		expect(getPlayState().room?.roomCode).toBe('BASE02'); // CANCL2 never installed
		expect(getPlayState().isLoading).toBe(true); // newer op still owns it

		roomDefaults('CANCL3', 2, 'm-new');
		heldNew.release(memberView('CANCL3', 2, 'm-new'));
		await pendingNew;
		expect(getPlayState().room?.roomCode).toBe('CANCL3');
		expect(getPlayState().isLoading).toBe(false);
	});
});

describe('same-room chat coalescing + sequencing', () => {
	test('overlapping SAME-room loads coalesce onto ONE request (poll + drawer-open cannot overlap)', async () => {
		roomDefaults('CHATC1', 1);
		hydratePlayRoom(memberView('CHATC1', 1));
		await flush();
		await flush(); // let connect()'s own initial chat load fully settle

		// Count every chat request from here on (wrapping the harness's fetch stub).
		let chatFetches = 0;
		const stubbed = globalThis.fetch;
		vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
			if (String(input).includes('/sessions/CHATC1/chat')) chatFetches += 1;
			return stubbed(input as string, init);
		});

		const heldChat = holdBody((url) => url.includes('/sessions/CHATC1/chat'));
		const first = loadRoomChat('CHATC1');
		await flush();
		const second = loadRoomChat('CHATC1'); // drawer opens while the poll is in flight
		await flush();
		expect(chatFetches).toBe(1); // coalesced — no second request exists

		heldChat.release({
			messages: [
				{
					id: 'msg-1',
					memberId: 'm-else',
					displayName: 'Other',
					body: 'hello',
					createdAt: '2026-07-10T00:00:00Z'
				}
			]
		});
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b); // both callers observe the one operation's result
		expect(chatFetches).toBe(1);
		expect(getPlayState().chatMessages).toHaveLength(1);
		expect(getPlayState().chatLoading).toBe(false);
	});

	test('an OLDER load\'s delayed-body FAILURE cannot clobber a newer load\'s clean state, and its finally cannot clear the newer loading', async () => {
		roomDefaults('CHATC2', 1);
		hydratePlayRoom(memberView('CHATC2', 1));
		await flush();

		// Old operation: chat load for the room the player is about to leave —
		// headers answered, FAILING body held.
		const heldOldFailure = holdBody((url) => url.includes('/sessions/CHATC2/chat'), false, 500);
		const oldLoad = loadRoomChat('CHATC2');
		await flush();
		expect(heldOldFailure.url).toContain('/sessions/CHATC2/chat');

		// Newer operation: the player re-targets and a fresh chat load starts (held).
		roomDefaults('CHATC3', 2, 'm-c3');
		await loadPlayRoom('CHATC3');
		await flush();
		await flush(); // connect()'s own initial chat load settles first
		const heldNew = holdBody((url) => url.includes('/sessions/CHATC3/chat'));
		const newLoad = loadRoomChat('CHATC3');
		await flush();
		expect(heldNew.url).toContain('/sessions/CHATC3/chat'); // a real, fresh request
		expect(getPlayState().chatLoading).toBe(true); // the NEWER load owns this

		// The old failure lands now: no error write, no loading clear, no merge.
		heldOldFailure.release({ message: 'room A chat exploded' });
		expect(await oldLoad).toEqual([]);
		expect(getPlayState().chatError).toBeNull();
		expect(getPlayState().chatLoading).toBe(true); // stale finally did NOT blank it

		// The newer load completes normally.
		heldNew.release({
			messages: [
				{
					id: 'msg-b',
					memberId: 'm-c3',
					displayName: 'Me',
					body: 'newer room talk',
					createdAt: '2026-07-10T00:01:00Z'
				}
			]
		});
		await newLoad;
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['msg-b']);
		expect(getPlayState().chatError).toBeNull();
		expect(getPlayState().chatLoading).toBe(false);
	});

	test('after an identity reset, a new chat call never coalesces onto the fenced-out in-flight load', async () => {
		roomDefaults('CHATC4', 1);
		hydratePlayRoom(memberView('CHATC4', 1));
		await flush();

		const heldStale = holdBody((url) => url.includes('/sessions/CHATC4/chat'));
		const staleLoad = loadRoomChat('CHATC4');
		await flush();

		// Account switches; the store re-enters the room as the new identity.
		roomDefaults('CHATC4', 1, 'm-new-acct');
		resetPlayIdentityState();
		await flush();
		await flush(); // the re-entry's connect() chat load settles

		// The new identity's chat load must be a FRESH request (the held one is
		// fenced out and will discard everything), not a coalesced ride-along.
		const heldFresh = holdBody((url) => url.includes('/sessions/CHATC4/chat'));
		const freshLoad = loadRoomChat('CHATC4');
		await flush();
		expect(heldFresh.url).toContain('/sessions/CHATC4/chat'); // fresh request issued

		heldStale.release({
			messages: [
				{
					id: 'stale-msg',
					memberId: 'm-else',
					displayName: 'Old',
					body: 'old account chat',
					createdAt: '2026-07-10T00:00:00Z'
				}
			]
		});
		expect(await staleLoad).toEqual([]); // fenced out, merged nothing

		heldFresh.release({
			messages: [
				{
					id: 'fresh-msg',
					memberId: 'm-new-acct',
					displayName: 'New',
					body: 'new account chat',
					createdAt: '2026-07-10T00:02:00Z'
				}
			]
		});
		await freshLoad;
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['fresh-msg']);
	});
});

describe('A → B route re-target gap', () => {
	test('retargetPlayRoom removes room A SYNCHRONOUSLY: no action can target A during the gap, and B still converges (store + transport)', async () => {
		roomDefaults('ROOMA1', 1);
		hydratePlayRoom(memberView('ROOMA1', 1));
		await flush();
		await joinNewestSocket(memberView('ROOMA1', 1)); // live WS for room A
		const socketA = FakeSocket.instances.at(-1)!;
		const socketsBefore = FakeSocket.instances.length;

		const heldB = hold((url) => url.includes('/sessions/ROOMB1/view'));
		const pending = retargetPlayRoom('ROOMB1');

		// SYNCHRONOUS removal — before ANY await resolves, room A is gone as an
		// authoritative target: nothing rendered can act against it.
		expect(getPlayState().room).toBeNull();
		expect(getPlayState().member).toBeNull();
		expect(socketA.readyState).toBe(3); // A's transport is closed, not lingering

		// A fresh action attempted during the gap refuses instead of hitting room A.
		await expect(
			sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand)
		).rejects.toThrow(/No room is loaded/);
		await expect(sendRoomChat('ghost message')).rejects.toThrow(/No room is loaded/);

		// Room B lands: the store, member picture and a NEW transport all converge.
		roomDefaults('ROOMB1', 1, 'm-b');
		heldB.release(memberView('ROOMB1', 1, 'm-b'));
		await pending;
		await flush();
		expect(getPlayState().room?.roomCode).toBe('ROOMB1');
		expect(getPlayState().member?.id).toBe('m-b');
		expect(FakeSocket.instances.length).toBeGreaterThan(socketsBefore); // B's own socket
		expect(FakeSocket.instances.at(-1)!.url).toContain('ws://rooms.test');
	});
});

describe('abort compensation (server effect landed anyway)', () => {
	test('the AbortSignal is passed INTO the network request itself', async () => {
		roomDefaults('BASE03', 1);
		hydratePlayRoom(memberView('BASE03', 1));
		await flush();

		const heldCreate = hold((url) => url.endsWith('/api/play/sessions'));
		const controller = new AbortController();
		const outcome = createPlayRoom('Signal Carrier', { signal: controller.signal }).then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();
		// The fetch carries the component's own signal — an unmount aborts the
		// REQUEST, not just the local fence.
		expect((heldCreate.init as RequestInit | undefined)?.signal).toBe(controller.signal);
		controller.abort();
		heldCreate.release(memberView('SIGROOM', 1, 'm-sig'));
		expect(await outcome).toBeInstanceOf(RoomNavigationCancelled);
	});

	test('a cancelled CREATE whose response landed compensates through the OP contract: abandon-entry carries the op id the request itself carried', async () => {
		roomDefaults('BASE04', 1);
		hydratePlayRoom(memberView('BASE04', 1));
		await flush();

		const abandonBodies: string[] = [];
		route(
			(url) => url.includes('/abandon-entry'),
			(url, init) => {
				abandonBodies.push(String(init?.body ?? ''));
				return jsonResponse({ ok: true, compensated: 'room' });
			}
		);
		const heldCreate = hold((url) => url.endsWith('/api/play/sessions'));
		const controller = new AbortController();
		const outcome = createPlayRoom('Ghost Host', { signal: controller.signal }).then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();
		// The create request itself carried the pre-minted entry-op id.
		const sentOp = (JSON.parse(String(heldCreate.init?.body ?? '{}')) as { opId?: string }).opId;
		expect(sentOp).toMatch(/^peo_[A-Za-z0-9_-]{43}$/);

		controller.abort(); // unmount wins the race…
		heldCreate.release(memberView('ORPHN1', 1, 'm-ghost')); // …but the room was created

		expect(await outcome).toBeInstanceOf(RoomNavigationCancelled);
		await flush();
		// The server-side effect is compensated exactly once, OP-BOUND: the abandon
		// names the exact operation (the server unwinds exactly what it created),
		// and nothing local changed.
		expect(abandonBodies).toHaveLength(1);
		expect(JSON.parse(abandonBodies[0])).toEqual({ opId: sentOp });
		expect(getPlayState().room?.roomCode).toBe('BASE04');
		expect(getPlayState().error).toBeNull();
	});

	test('AMBIGUOUS COMMIT: an aborted CREATE whose fetch DIES with no response still abandons its op — the server can unwind a commit the client never saw', async () => {
		roomDefaults('BASE05', 1);
		hydratePlayRoom(memberView('BASE05', 1));
		await flush();

		const abandonBodies: string[] = [];
		route(
			(url) => url.includes('/abandon-entry'),
			(url, init) => {
				abandonBodies.push(String(init?.body ?? ''));
				return jsonResponse({ ok: true, compensated: 'room' });
			}
		);
		const heldCreate = hold((url) => url.endsWith('/api/play/sessions'));
		const controller = new AbortController();
		const outcome = createPlayRoom('Ambiguous Host', { signal: controller.signal }).then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();
		const sentOp = (JSON.parse(String(heldCreate.init?.body ?? '{}')) as { opId?: string }).opId;

		controller.abort();
		// The fetch REJECTS with no response body — pre-fix the client had no
		// roomCode and could compensate nothing; the generated room stayed live.
		heldCreate.fail(new DOMException('The user aborted a request.', 'AbortError'));

		expect(await outcome).toBeInstanceOf(RoomNavigationCancelled);
		await flush();
		expect(abandonBodies).toHaveLength(1);
		expect(JSON.parse(abandonBodies[0])).toEqual({ opId: sentOp });
		expect(getPlayState().error).toBeNull(); // no error surfaced to a dead page
	});

	test('an aborted JOIN abandons ITS OWN op — never a blanket roomCode leave that could remove a pre-existing membership', async () => {
		roomDefaults('BASE06', 1);
		hydratePlayRoom(memberView('BASE06', 1));
		await flush();

		const abandonBodies: string[] = [];
		const leaveCalls: string[] = [];
		route(
			(url) => url.includes('/abandon-entry'),
			(url, init) => {
				abandonBodies.push(String(init?.body ?? ''));
				return jsonResponse({ ok: true, compensated: 'none' });
			}
		);
		route(
			(url) => url.includes('/leave'),
			(url) => {
				leaveCalls.push(url);
				return jsonResponse({ left: true, closed: false });
			}
		);
		const heldJoin = hold((url) => url.includes('/sessions/TARGT1/join'));
		const controller = new AbortController();
		const outcome = joinPlayRoom('TARGT1', 'Rejoiner', { signal: controller.signal }).then(
			() => 'applied',
			(err: Error) => err
		);
		await flush();
		const sentOp = (JSON.parse(String(heldJoin.init?.body ?? '{}')) as { opId?: string }).opId;
		expect(sentOp).toMatch(/^peo_[A-Za-z0-9_-]{43}$/);

		controller.abort();
		heldJoin.release(memberView('TARGT1', 1, 'm-rejoin'));

		expect(await outcome).toBeInstanceOf(RoomNavigationCancelled);
		await flush();
		// OP-BOUND compensation only: the server decides from the op stamp whether
		// a membership was actually ADDED — a pre-existing one is never removed.
		expect(abandonBodies).toHaveLength(1);
		expect(JSON.parse(abandonBodies[0])).toEqual({ opId: sentOp });
		expect(leaveCalls).toEqual([]);
	});
});

describe('chat SEND participates in operation ordering', () => {
	test('an older load\'s late FAILURE cannot surface an error (or spinner state) over a newer successful send', async () => {
		roomDefaults('CHATS1', 1);
		hydratePlayRoom(memberView('CHATS1', 1));
		await flush();
		await flush(); // connect()'s initial chat load settles

		// Older operation: a chat LOAD whose failing body is held.
		const heldFail = holdBody((url) => url.includes('/sessions/CHATS1/chat'), false, 500);
		const oldLoad = loadRoomChat('CHATS1');
		await flush();
		expect(heldFail.url).toContain('/sessions/CHATS1/chat');

		// Newer operation: the user SENDS a message, and it succeeds.
		routes.unshift({
			match: (url) => url.includes('/sessions/CHATS1/chat'),
			handler: (url, init) =>
				init?.method === 'POST'
					? jsonResponse({
							message: {
								id: 'sent-1',
								memberId: 'm-self',
								displayName: 'Self',
								body: 'newest words',
								createdAt: '2026-07-10T00:03:00Z'
							}
						})
					: jsonResponse({ messages: [] })
		});
		const sent = await sendRoomChat('newest words');
		expect(sent.id).toBe('sent-1');
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['sent-1']);
		expect(getPlayState().chatError).toBeNull();
		expect(getPlayState().chatLoading).toBe(false);

		// The OLDER load's failure lands now — pre-fix it stamped chatError over the
		// send's clean state. It must surface nothing.
		heldFail.release({ message: 'older load exploded' });
		expect(await oldLoad).toEqual([]);
		expect(getPlayState().chatError).toBeNull();
		expect(getPlayState().chatLoading).toBe(false);
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['sent-1']); // untouched
	});

	test('an older load that SUCCEEDS after a newer send still merges monotonically — messages are never lost to the ordering', async () => {
		roomDefaults('CHATS2', 1);
		hydratePlayRoom(memberView('CHATS2', 1));
		await flush();
		await flush();

		const heldOld = holdBody((url) => url.includes('/sessions/CHATS2/chat'));
		const oldLoad = loadRoomChat('CHATS2');
		await flush();

		routes.unshift({
			match: (url) => url.includes('/sessions/CHATS2/chat'),
			handler: (url, init) =>
				init?.method === 'POST'
					? jsonResponse({
							message: {
								id: 'sent-2',
								memberId: 'm-self',
								displayName: 'Self',
								body: 'mine',
								createdAt: '2026-07-10T00:05:00Z'
							}
						})
					: jsonResponse({ messages: [] })
		});
		await sendRoomChat('mine');

		// The older load's messages land late: they MERGE (monotonic, id-keyed) —
		// the ordering protects error/loading state, never drops messages.
		heldOld.release({
			messages: [
				{
					id: 'earlier-1',
					memberId: 'm-else',
					displayName: 'Other',
					body: 'earlier words',
					createdAt: '2026-07-10T00:04:00Z'
				}
			]
		});
		await oldLoad;
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['earlier-1', 'sent-2']);
		expect(getPlayState().chatError).toBeNull();
	});

	test('a NEWER send that FAILS still settles the loading state it fenced an older load out of — no spinner hangs forever', async () => {
		roomDefaults('CHATS3', 1);
		hydratePlayRoom(memberView('CHATS3', 1));
		await flush();
		await flush(); // connect()'s initial chat load settles (empty thread)

		// Older operation: a chat LOAD on an EMPTY thread — it set chatLoading=true
		// and its body is held.
		const heldOld = holdBody((url) => url.includes('/sessions/CHATS3/chat'));
		const oldLoad = loadRoomChat('CHATS3');
		await flush();
		expect(getPlayState().chatLoading).toBe(true);

		// Newer operation: the user SENDS — and the send FAILS. It claimed the op
		// number (fencing the older load's finally out of the loading flag), so it
		// must settle the state itself. Pre-fix: the throw skipped the clear and
		// the spinner hung forever with nothing in flight.
		routes.unshift({
			match: (url) => url.includes('/sessions/CHATS3/chat'),
			handler: (url, init) =>
				init?.method === 'POST'
					? jsonResponse({ message: 'send exploded' }, false, 500)
					: jsonResponse({ messages: [] }),
			once: true
		});
		await expect(sendRoomChat('doomed words')).rejects.toThrow(/send exploded/);
		expect(getPlayState().chatLoading).toBe(false); // settled by the failed send

		// The older load's late success still merges MONOTONICALLY and cannot
		// resurrect the spinner or clobber anything.
		heldOld.release({
			messages: [
				{
					id: 'old-1',
					memberId: 'm-else',
					displayName: 'Other',
					body: 'older words',
					createdAt: '2026-07-10T00:06:00Z'
				}
			]
		});
		await oldLoad;
		expect(getPlayState().chatMessages.map((m) => m.id)).toEqual(['old-1']);
		expect(getPlayState().chatLoading).toBe(false);
	});
});

describe('same-UID token refresh', () => {
	test('rotating the access token is NOT an identity change: the room survives and in-flight work applies', async () => {
		(auth as { session: { access_token: string } | null }).session = {
			access_token: 'token-before-refresh'
		};
		roomDefaults('TOKEN1', 9);
		hydratePlayRoom(memberView('TOKEN1', 9));
		await flush();

		const heldCmd = hold((url) => url.includes('/sessions/TOKEN1/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		await flush();

		// The token rotates mid-flight (same account, same uid) — no reset fires
		// (the layout only resets on a uid change), so nothing is fenced.
		(auth as { session: { access_token: string } | null }).session = {
			access_token: 'token-after-refresh'
		};
		heldCmd.release(memberView('TOKEN1', 10));
		const view = await pending;
		expect(view.projection.revision).toBe(10);
		expect(getPlayState().room?.roomCode).toBe('TOKEN1');
		expect(getPlayState().room?.revision).toBe(10);
		expect(getPlayState().member?.id).toBe('m-self');
	});
});
