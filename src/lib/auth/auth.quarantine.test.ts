/**
 * Fail-closed identity quarantine (auth.svelte.ts) — when an OAuth link exchange
 * installed a session for the WRONG canonical identity and the local sign-out
 * could not be PROVEN clean, the store must block ALL authenticated activity
 * (nothing reads signed-in) until a cleanup verifiably succeeds — across syncs
 * AND across reloads (persisted marker), never silently re-adopting the wrong
 * session.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn(async () => {}) }));
// The native shell module pulls Capacitor-shaped imports — inert here.
vi.mock('./nativeOAuth', () => ({
	isNativeShell: () => false,
	runNativeOAuth: vi.fn(),
	capacitorOAuthDeps: () => ({})
}));

function memLocalStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k),
		clear: () => data.clear(),
		key: () => null,
		get length() {
			return data.size;
		}
	} as unknown as Storage;
}

function fakeClient(signOutImpl: () => Promise<{ error: { message: string } | null }>) {
	return {
		auth: {
			signOut: vi.fn(signOutImpl)
		}
	} as unknown as SupabaseClient;
}

const wrongUser = { id: 'uid-wrong', is_anonymous: false } as unknown as User;
const wrongSession = { access_token: 'tok-wrong' } as unknown as Session;

async function freshStore() {
	vi.resetModules();
	const mod = await import('./auth.svelte');
	return mod.auth;
}

beforeEach(() => {
	(globalThis as { localStorage?: Storage }).localStorage = memLocalStorage();
});

describe('auth store fail-closed quarantine', () => {
	test('an UNCLEAN quarantine blocks every signed-in surface and persists; syncs with a lingering wrong session stay blocked until the cleanup verifiably lands', async () => {
		const auth = await freshStore();
		let signOutFails = true;
		const client = fakeClient(async () =>
			signOutFails ? { error: { message: 'offline' } } : { error: null }
		);

		// Normal life first: a session installs.
		auth.sync(client, wrongSession, wrongUser, null);
		expect(auth.isSignedIn).toBe(true);

		// The OAuth flow escalates: the wrong session could not be provably cleared.
		await auth.enterAuthQuarantine();
		expect(auth.isQuarantined).toBe(true);
		// BLOCKED: nothing authenticated may run under the (possibly wrong) session.
		expect(auth.isSignedIn).toBe(false);
		expect(auth.user).toBeNull();
		expect(auth.session).toBeNull();
		// Persisted, so a reload cannot silently re-adopt the wrong session.
		expect(localStorage.getItem('arc-auth-quarantine')).toBe('1');

		// The next layout sync still carries the wrong session (storage was never
		// cleared): it is REFUSED wholesale and the cleanup retried (still failing).
		auth.sync(client, wrongSession, wrongUser, null);
		await Promise.resolve();
		expect(auth.isSignedIn).toBe(false);
		expect(auth.isQuarantined).toBe(true);

		// The cleanup finally lands (signOut resolves clean): the quarantine lifts.
		signOutFails = false;
		auth.sync(client, wrongSession, wrongUser, null);
		await vi.waitFor(() => expect(auth.isQuarantined).toBe(false));
		expect(localStorage.getItem('arc-auth-quarantine')).toBeNull();
		// This sync still installed nothing (fail-closed for the wrong session)…
		expect(auth.isSignedIn).toBe(false);
		// …and the NEXT sync (post-cleanup state) flows normally again.
		auth.sync(client, null, null, null);
		expect(auth.isSignedIn).toBe(false);
		expect(auth.isQuarantined).toBe(false);
	});

	test('a sync arriving with NO session is the proof the cleanup landed: the quarantine lifts without another signOut', async () => {
		const auth = await freshStore();
		const client = fakeClient(async () => ({ error: { message: 'offline' } }));
		auth.sync(client, wrongSession, wrongUser, null);
		await auth.enterAuthQuarantine();
		expect(auth.isQuarantined).toBe(true);

		// Storage came back verifiably EMPTY (e.g. the cleanup landed elsewhere).
		auth.sync(client, null, null, null);
		expect(auth.isQuarantined).toBe(false);
		expect(localStorage.getItem('arc-auth-quarantine')).toBeNull();
	});

	test('COLD-PATH persistence: a reload while quarantined boots BLOCKED and refuses the persisted wrong session', async () => {
		localStorage.setItem('arc-auth-quarantine', '1'); // left by a prior process
		const auth = await freshStore();
		expect(auth.isQuarantined).toBe(true);

		const client = fakeClient(async () => ({ error: { message: 'still offline' } }));
		// The reload's first sync would otherwise install the wrong session straight
		// from cookie storage — it must be refused.
		auth.sync(client, wrongSession, wrongUser, null);
		await Promise.resolve();
		expect(auth.isSignedIn).toBe(false);
		expect(auth.isQuarantined).toBe(true);
	});
});
