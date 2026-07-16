/**
 * ATOMIC IDENTITY TRANSITION — the CROSS-ORIGIN (Capacitor native shell) posture.
 *
 * Cross-origin there is no session cookie: the validated account travels as the
 * `Authorization: Bearer` access token read from the auth store AT CALL TIME. The
 * same generation fence must hold: a response authorized by the previous account's
 * token can never repopulate state or reach a caller after sign-out / account
 * switch, and requests issued AFTER the switch must carry the NEW account's token.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/supabase', () => ({
	supabase: {
		channel: () => {
			const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} };
			return ch;
		},
		removeChannel: () => {}
	}
}));
// The Capacitor shell: every API call is absolute + cross-origin.
vi.mock('$lib/play/apiBase', () => ({
	API_BASE_URL: 'https://api.example',
	isCrossOrigin: true,
	apiUrl: (path: string) => `https://api.example${path}`
}));

const authState = vi.hoisted((): { session: { access_token: string } | null } => ({
	session: { access_token: 'token-account-A' }
}));
vi.mock('$lib/auth/auth.svelte', () => ({ auth: authState }));

import {
	getPlayState,
	hydratePlayRoom,
	postPlayJson,
	resetPlayIdentityState
} from './playStore.svelte';

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: () => Promise.resolve(structuredClone(body)) } as unknown as Response;
}

interface Captured {
	url: string;
	authorization: string | null;
	credentials: string | undefined;
}

let captured: Captured[] = [];
let holdNext: { release: (body: unknown) => void } | null = null;

beforeEach(() => {
	captured = [];
	holdNext = null;
	authState.session = { access_token: 'token-account-A' };
	vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		captured.push({
			url: String(input),
			authorization: headers['Authorization'] ?? null,
			credentials: init?.credentials
		});
		if (holdNext) {
			const gate = holdNext;
			holdNext = null;
			return new Promise<Response>((resolve) => {
				gate.release = (body) => resolve(jsonResponse(body));
			});
		}
		if (String(input).includes('/chat')) return Promise.resolve(jsonResponse({ messages: [] }));
		return Promise.resolve(
			jsonResponse({
				projection: { roomCode: 'XRACE1', revision: 2, status: 'active' },
				member: null
			})
		);
	});
});

afterEach(() => {
	getPlayState().disconnect();
	vi.unstubAllGlobals();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cross-origin (Bearer) identity transition', () => {
	test('every request carries the CURRENT account token + include-credentials; a held old-token response is fenced out', async () => {
		hydratePlayRoom({
			projection: { roomCode: 'XRACE1', revision: 1, status: 'active' },
			member: { id: 'm-A', role: 'host', seatColor: 'Red', displayName: 'A' }
		} as unknown as Parameters<typeof hydratePlayRoom>[0]);
		await flush();
		// The refresh/chat fired under account A: Bearer A, cross-origin credentials.
		expect(captured.length).toBeGreaterThan(0);
		for (const req of captured) {
			expect(req.authorization).toBe('Bearer token-account-A');
			expect(req.credentials).toBe('include');
		}

		// Hold a mutation issued under account A…
		captured = [];
		const gate = { release: (_body: unknown) => {} };
		holdNext = gate;
		const pending = postPlayJson<{ ok: boolean }>('/api/play/sessions/XRACE1/commands', {
			command: { type: 'passTurn' }
		});
		const outcome = pending.then(
			() => 'applied',
			(err: Error) => err.message
		);
		await flush();
		expect(captured[0].authorization).toBe('Bearer token-account-A');

		// …switch accounts (auth store already synchronized — layout order), reset…
		authState.session = { access_token: 'token-account-B' };
		resetPlayIdentityState();
		await flush();

		// …release the old response: the caller gets a rejection, never account A's data.
		gate.release({});
		expect(await outcome).toMatch(/account changed/i);

		// The post-reset re-entry and any new mutation speak for account B.
		const reentry = captured.filter((req) => req.authorization != null).slice(1);
		for (const req of reentry) {
			expect(req.authorization).toBe('Bearer token-account-B');
		}
		const fresh = await postPlayJson<{ projection: { roomCode: string } }>(
			'/api/play/sessions/XRACE1/join',
			{ displayName: 'B' }
		);
		expect(fresh.projection.roomCode).toBe('XRACE1');
		expect(captured.at(-1)!.authorization).toBe('Bearer token-account-B');
	});
});
