/**
 * ATOMIC IDENTITY TRANSITION — regressions for the sign-out / account-switch race,
 * run against the REAL play store wiring (module state, connect/refresh/chat/command
 * paths), with fetch and the Svelte/SvelteKit environment faked.
 *
 * The real repro this suite encodes: hold account A's authenticated `/view`
 * response in flight, sign out (resetPlayIdentityState re-enters the room as a
 * spectator), then release the held response. Pre-fix, the store applied it and
 * silently restored A's member/host state while auth said "signed out". Every
 * async path — the view refresh, the command round-trip (both transports' shared
 * HTTP funnel), the chat poll, room load — must discard results from a previous
 * identity generation instead.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
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
	getPlayState,
	hydratePlayRoom,
	loadPlayRoom,
	loadRoomChat,
	resetPlayIdentityState,
	sendPlayCommand
} from './playStore.svelte';
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

// ── controllable fetch ─────────────────────────────────────────────────────────────
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
}

/** Route table: the FIRST matching entry handles a request; `hold` entries capture
 *  the request and let the test release its response later (the race window). */
let routes: { match: (url: string) => boolean; handler: Handler; once?: boolean }[] = [];
let unmatched: string[] = [];

function route(match: (url: string) => boolean, handler: Handler, once = false) {
	routes.push({ match, handler, once });
}

function hold(match: (url: string) => boolean): Held {
	const held: Partial<Held> = {};
	const gate = new Promise<{ body: unknown; ok: boolean }>((resolve) => {
		held.release = (body, ok = true) => resolve({ body, ok });
	});
	route(
		match,
		(url, init) => {
			held.url = url;
			held.init = init;
			return gate.then(({ body, ok }) => jsonResponse(body, ok));
		},
		true
	);
	return held as Held;
}

// Minimal projections (only the fields the store's staleness/identity logic reads),
// cast to the full wire type.
function memberView(roomCode: string, revision: number): RoomView {
	return {
		projection: { roomCode, revision, status: 'active' },
		member: { id: 'm-account-A', role: 'host', seatColor: 'Red', displayName: 'Account A' }
	} as unknown as RoomView;
}

function spectatorView(roomCode: string, revision: number): RoomView {
	return { projection: { roomCode, revision, status: 'active' }, member: null } as unknown as RoomView;
}

beforeEach(() => {
	routes = [];
	unmatched = [];
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

/** Default routes for the post-reset re-entry (spectator view + empty chat). */
function routeSpectatorDefaults(roomCode: string, revision: number) {
	route(
		(url) => url.includes(`/sessions/${roomCode}/view`),
		() => jsonResponse(spectatorView(roomCode, revision))
	);
	route(
		(url) => url.includes(`/sessions/${roomCode}/chat`),
		() => jsonResponse({ messages: [] })
	);
}

describe('atomic identity transition (generation fence)', () => {
	test('REPRO: a held account-A /view response cannot repopulate member/host state after sign-out', async () => {
		const heldView = hold((url) => url.includes('/sessions/RACE01/view'));
		route(
			(url) => url.includes('/sessions/RACE01/chat'),
			() => jsonResponse({ messages: [] })
		);

		// Account A is a live member of the room; connect() fires the refresh whose
		// response we hold open — the exact race window.
		hydratePlayRoom(memberView('RACE01', 5));
		await flush();
		expect(heldView.url).toContain('/sessions/RACE01/view');

		// Sign-out: the durable identity changed. The re-entry (new generation) sees
		// the room as a spectator.
		routeSpectatorDefaults('RACE01', 6);
		resetPlayIdentityState();
		await flush();
		expect(getPlayState().member).toBeNull();
		expect(getPlayState().room?.revision).toBe(6);

		// Release the OLD response — a member view at a NEWER revision, so the
		// same-room staleness guard alone would happily apply it. The fence must not.
		heldView.release(memberView('RACE01', 10));
		await flush();
		expect(getPlayState().member).toBeNull();
		expect(getPlayState().room?.revision).toBe(6); // the stale view never landed
	});

	test('COMMAND path: an in-flight command round-trip rejects on identity change and applies nothing', async () => {
		routeSpectatorDefaults('RACE02', 3);
		hydratePlayRoom(memberView('RACE02', 3));
		await flush();

		const heldCommand = hold((url) => url.includes('/sessions/RACE02/commands'));
		const pending = sendPlayCommand({ type: 'passTurn' } as unknown as GameCommand);
		// Swallow the expected rejection immediately so no unhandled-rejection races the fence.
		const outcome = pending.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush();
		expect(heldCommand.url).toContain('/commands');

		resetPlayIdentityState();
		await flush();
		heldCommand.release(memberView('RACE02', 9));
		expect(await outcome).toMatch(/account changed/i);
		expect(getPlayState().member).toBeNull();
		expect(getPlayState().room?.revision).toBe(3);
	});

	test('CHAT path: a held member-gated chat poll from the previous account never merges', async () => {
		routeSpectatorDefaults('RACE03', 4);
		hydratePlayRoom(memberView('RACE03', 4));
		await flush();

		const heldChat = hold((url) => url.includes('/sessions/RACE03/chat'));
		const chatFetch = loadRoomChat('RACE03');
		await flush();

		resetPlayIdentityState();
		await flush();
		heldChat.release({
			messages: [
				{
					id: 'msg-1',
					memberId: 'm-account-A',
					displayName: 'Account A',
					body: 'private',
					createdAt: '2026-07-10T00:00:00Z'
				}
			]
		});
		expect(await chatFetch).toEqual([]);
		expect(getPlayState().chatMessages).toEqual([]);
	});

	test('ROOM LOAD path: a held loadPlayRoom started under the old account rejects instead of applying', async () => {
		const heldLoad = hold((url) => url.includes('/sessions/RACE04/view'));
		const pending = loadPlayRoom('RACE04');
		const outcome = pending.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush();

		resetPlayIdentityState();
		heldLoad.release(memberView('RACE04', 2));
		expect(await outcome).toMatch(/account changed/i);
		expect(getPlayState().room?.roomCode).not.toBe('RACE04');
	});

	test('CONTROL: after the reset settles, the new identity operates normally under the new generation', async () => {
		routeSpectatorDefaults('RACE05', 7);
		hydratePlayRoom(memberView('RACE05', 7));
		await flush();
		resetPlayIdentityState();
		await flush();
		expect(getPlayState().member).toBeNull();

		// The new account loads a room and IS applied — the fence only kills stale work.
		route(
			(url) => url.includes('/sessions/FRESH1/view'),
			() =>
				jsonResponse({
					projection: { roomCode: 'FRESH1', revision: 1, status: 'lobby' },
					member: { id: 'm-account-B', role: 'player', seatColor: null, displayName: 'Account B' }
				})
		);
		route(
			(url) => url.includes('/sessions/FRESH1/chat'),
			() => jsonResponse({ messages: [] })
		);
		const view = await loadPlayRoom('FRESH1');
		expect(view.member?.id).toBe('m-account-B');
		expect(getPlayState().member?.id).toBe('m-account-B');
		expect(unmatched).toEqual([]);
	});
});
