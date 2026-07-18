/**
 * Native OAuth round trip — deep-link parsing and flow orchestration, with the
 * Capacitor surfaces injected as fakes (simulator-free coverage of the guest-claim
 * contract: linkIdentity → system browser → deep-link code → in-client PKCE
 * exchange, SAME uid throughout — VERIFIED, not assumed). Also covers the delivery
 * state machine as a PERSISTED PENDING-FLOW machine, adversarially:
 *
 *   - ACTUAL simulated process restarts: the in-memory ledger/latch are wiped
 *     (resetNativeOAuthStateForTests) while the injected storage — where the
 *     non-secret pending record lives, like the PKCE verifier — survives. Cold
 *     resume must complete the EXACT flow that began (mode, expected uid), and a
 *     redelivered launch URL after a SECOND restart must exchange nothing.
 *   - Exact-once across duplicate warm+cold delivery, including across restarts.
 *   - STALE FLOWS: a consumed code arriving warm can neither settle a newer flow
 *     nor fake a success without an exchange; a stale flow-A callback at cold
 *     start fails flow B loudly (verifier-bound exchange) — never phantom success.
 *   - Cold LINK verifies the uid BEFORE and AFTER, exactly like the warm path.
 *   - Pending state clears on success, authoritative failure, cancellation and
 *     timeout; the browser sheet is closed best-effort on timeout/cancel too.
 *   - Listener readiness before the browser opens, full teardown on every failure
 *     path, no secret ever persisted or embedded in an error message.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
	NATIVE_OAUTH_CALLBACK,
	NATIVE_OAUTH_PENDING_KEY,
	parseOAuthDeepLink,
	resetNativeOAuthStateForTests,
	resumeColdStartOAuth,
	runNativeOAuth,
	type NativeOAuthDeps,
	type NativeOAuthPendingFlow,
	type NativeOAuthStorage,
	type OAuthAuthSurface
} from './nativeOAuth';

describe('parseOAuthDeepLink', () => {
	test('accepts exactly this app’s callback and extracts the one-time code (and the flow-ownership marker when present)', () => {
		expect(parseOAuthDeepLink('com.arcspirits.app://auth/callback?code=abc123')).toEqual({
			ok: true,
			code: 'abc123',
			flow: null
		});
		// Trailing slash tolerated; extra params ignored.
		expect(parseOAuthDeepLink('com.arcspirits.app://auth/callback/?code=x&state=s')).toEqual({
			ok: true,
			code: 'x',
			flow: null
		});
		// The flow marker (callback-ownership binding) is surfaced when present.
		expect(parseOAuthDeepLink('com.arcspirits.app://auth/callback?flow=n0nce&code=x')).toEqual({
			ok: true,
			code: 'x',
			flow: 'n0nce'
		});
	});

	test('surfaces the provider error instead of a code', () => {
		const parsed = parseOAuthDeepLink(
			'com.arcspirits.app://auth/callback?error=access_denied&error_description=User+cancelled'
		);
		expect(parsed).toEqual({ ok: false, error: 'User cancelled', flow: null });
	});

	test('a matching callback with NEITHER code nor error is an explicit failure', () => {
		const parsed = parseOAuthDeepLink('com.arcspirits.app://auth/callback');
		expect(parsed?.ok).toBe(false);
	});

	test('everything else is NOT ours: wrong scheme, wrong path, hostile lookalikes, garbage', () => {
		for (const foreign of [
			'https://evil.example/auth/callback?code=stolen',
			'com.arcspirits.app://not/the/callback?code=x',
			'com.arcspirits.app://auth/callback/deeper?code=x',
			'com.arcspirits.evil://auth/callback?code=x',
			'com.arcspirits.app.evil://auth/callback?code=x',
			'not a url',
			''
		]) {
			expect(parseOAuthDeepLink(foreign), foreign).toBeNull();
		}
	});
});

// ── flow orchestration with fakes ─────────────────────────────────────────────────

/** In-memory localStorage-shaped store. SHARED across fake flows to model the
 *  storage that SURVIVES a process death (the pending record + PKCE verifier). */
function memStorage(): NativeOAuthStorage & { dump: () => Record<string, string> } {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
		dump: () => Object.fromEntries(data)
	};
}

function pendingRecord(overrides: Partial<NativeOAuthPendingFlow> = {}): NativeOAuthPendingFlow {
	return {
		v: 1,
		nonce: 'seeded-flow-nonce',
		mode: 'signIn',
		provider: 'google',
		expectedUid: null,
		createdAt: Date.now(),
		expiresAt: Date.now() + 60_000,
		...overrides
	};
}

/** Seed a pending-flow record — what a process that died mid-flow left behind. */
function seedPending(storage: NativeOAuthStorage, overrides: Partial<NativeOAuthPendingFlow> = {}) {
	storage.setItem(NATIVE_OAUTH_PENDING_KEY, JSON.stringify(pendingRecord(overrides)));
}

function readPending(storage: NativeOAuthStorage): NativeOAuthPendingFlow | null {
	const raw = storage.getItem(NATIVE_OAUTH_PENDING_KEY);
	return raw ? (JSON.parse(raw) as NativeOAuthPendingFlow) : null;
}

interface FakeFlow {
	auth: OAuthAuthSurface;
	deps: NativeOAuthDeps;
	storage: ReturnType<typeof memStorage>;
	calls: string[];
	deliver: (url: string) => void;
	openedUrls: string[];
	beginOptions: Record<string, unknown>[];
	exchangedCodes: string[];
	listeners: number;
	unsubscribes: number;
	signOuts: number;
	/** The flow nonce the LAST begin rode through redirectTo (`?flow=<nonce>`). */
	flowMarker: () => string | null;
	/** This flow's own callback URL — carries its flow marker, exactly as the
	 *  real redirect would. */
	callbackUrl: (query: string) => string;
}

function fakeFlow(
	opts: {
		beginUrl?: string | null;
		beginError?: string;
		exchangeError?: string;
		/** Uid reported before any exchange (link mode's "before"). `null` = signed out. */
		uid?: string | null;
		/** Uid reported once an exchange happened (defaults to `uid` — identity preserved). */
		uidAfterExchange?: string;
		/** What getLaunchUrl reports (cold-start delivery channel). */
		launchUrl?: string | null;
		/** openUrl throws ONCE with this message (then works — recovery coverage). */
		openError?: string;
		/** onDeepLink registration itself throws with this message. */
		listenError?: string;
		/** exchangeCodeForSession blocks on this gate before resolving (holds the
		 *  exchange mid-flight — the cold-vs-interactive arbitration window). */
		exchangeGate?: Promise<void>;
		/** getUser fails (persistently — retries too) once an exchange happened. */
		getUserFailAfterExchange?: boolean;
		/** signOut RESOLVES with this error (auth-js's offline/5xx logout shape —
		 *  the wrong session stays installed in storage). */
		signOutError?: string;
		/** signOut REJECTS outright with this message. */
		signOutReject?: string;
		/** Shared storage — pass the SAME instance to model a process restart. */
		storage?: ReturnType<typeof memStorage>;
	} = {}
): FakeFlow {
	let openFailuresLeft = opts.openError ? 1 : 0;
	const storage = opts.storage ?? memStorage();
	const flow: FakeFlow = {
		storage,
		calls: [],
		openedUrls: [],
		beginOptions: [],
		exchangedCodes: [],
		listeners: 0,
		unsubscribes: 0,
		signOuts: 0,
		deliver: () => {},
		flowMarker: () => {
			const last = flow.beginOptions.at(-1) as
				| { options?: { redirectTo?: string } }
				| undefined;
			const redirectTo = last?.options?.redirectTo;
			if (!redirectTo) return null;
			try {
				return new URL(redirectTo).searchParams.get('flow');
			} catch {
				return null;
			}
		},
		callbackUrl: (query: string) => {
			const marker = flow.flowMarker();
			return `${NATIVE_OAUTH_CALLBACK}?${marker ? `flow=${marker}&` : ''}${query}`;
		},
		auth: {
			async linkIdentity(credentials) {
				flow.calls.push('linkIdentity');
				flow.beginOptions.push(credentials as unknown as Record<string, unknown>);
				if (opts.beginError) return { data: null, error: { message: opts.beginError } };
				return {
					data: {
						url: opts.beginUrl === undefined ? 'https://provider.example/authorize' : opts.beginUrl
					},
					error: null
				};
			},
			async signInWithOAuth(credentials) {
				flow.calls.push('signInWithOAuth');
				flow.beginOptions.push(credentials as unknown as Record<string, unknown>);
				if (opts.beginError) return { data: null, error: { message: opts.beginError } };
				return {
					data: {
						url: opts.beginUrl === undefined ? 'https://provider.example/authorize' : opts.beginUrl
					},
					error: null
				};
			},
			async exchangeCodeForSession(code) {
				flow.calls.push('exchange');
				flow.exchangedCodes.push(code);
				if (opts.exchangeGate) await opts.exchangeGate;
				return { error: opts.exchangeError ? { message: opts.exchangeError } : null };
			},
			async getUser() {
				flow.calls.push('getUser');
				if (opts.getUserFailAfterExchange && flow.exchangedCodes.length) {
					return { data: { user: null }, error: { message: 'user read failed' } };
				}
				const baseUid = opts.uid === undefined ? 'uid-guest' : opts.uid;
				if (baseUid === null) return { data: { user: null }, error: null };
				const uid = flow.exchangedCodes.length ? (opts.uidAfterExchange ?? baseUid) : baseUid;
				return { data: { user: { id: uid } }, error: null };
			},
			async signOut() {
				flow.calls.push('signOut');
				flow.signOuts += 1;
				if (opts.signOutReject) throw new Error(opts.signOutReject);
				return { error: opts.signOutError ? { message: opts.signOutError } : null };
			}
		},
		deps: {
			async openUrl(url) {
				flow.calls.push('openUrl');
				if (openFailuresLeft > 0) {
					openFailuresLeft -= 1;
					throw new Error(opts.openError);
				}
				flow.openedUrls.push(url);
			},
			async closeBrowser() {
				flow.calls.push('closeBrowser');
			},
			async onDeepLink(callback) {
				flow.calls.push('listen:register');
				// Registration is genuinely async in Capacitor — readiness must be awaited.
				await Promise.resolve();
				if (opts.listenError) throw new Error(opts.listenError);
				flow.listeners += 1;
				flow.deliver = callback;
				flow.calls.push('listen:ready');
				return () => {
					flow.unsubscribes += 1;
					flow.listeners -= 1;
				};
			},
			async getLaunchUrl() {
				flow.calls.push('getLaunchUrl');
				return opts.launchUrl ?? null;
			},
			storage,
			timeoutMs: 200
		}
	};
	return flow;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	resetNativeOAuthStateForTests();
});

describe('runNativeOAuth', () => {
	test('LINK mode claims the CURRENT uid via linkIdentity (never signInWithOAuth) and exchanges the returned code', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		// Begin: capture the uid to preserve FIRST, then linkIdentity with the
		// deep-link redirect and no webview navigation.
		expect(flow.calls.slice(0, 2)).toEqual(['getUser', 'linkIdentity']);
		expect(flow.calls).not.toContain('signInWithOAuth');
		const options = (flow.beginOptions[0] as { options: Record<string, unknown> }).options;
		// The redirect carries THIS flow's ownership marker (`?flow=<nonce>`) on top
		// of the exact callback — the binding that lets stale callbacks be quarantined.
		expect(String(options.redirectTo)).toMatch(
			new RegExp(`^${NATIVE_OAUTH_CALLBACK.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\?flow=[0-9a-f-]+$`)
		);
		expect(options.skipBrowserRedirect).toBe(true);
		// The provider URL opened in the SYSTEM browser.
		expect(flow.openedUrls).toEqual(['https://provider.example/authorize']);

		flow.deliver(flow.callbackUrl(`code=one-time-code`));
		await run;
		expect(flow.exchangedCodes).toEqual(['one-time-code']);
		expect(flow.calls).toContain('closeBrowser');
		expect(flow.listeners).toBe(0); // unsubscribed
	});

	test('SIGN-IN mode uses signInWithOAuth with the same deep-link contract', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'discord', 'signIn', flow.deps);
		await tick();
		expect(flow.calls[0]).toBe('signInWithOAuth');
		flow.deliver(flow.callbackUrl(`code=c2`));
		await run;
		expect(flow.exchangedCodes).toEqual(['c2']);
	});

	test('the deep-link listener is registered AND ready before the browser opens', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		const ready = flow.calls.indexOf('listen:ready');
		const open = flow.calls.indexOf('openUrl');
		expect(ready).toBeGreaterThan(-1);
		expect(open).toBeGreaterThan(ready);
		flow.deliver(flow.callbackUrl(`code=ordered`));
		await run;
	});

	test('foreign deep links are ignored; only this app’s callback settles the flow', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver('https://evil.example/auth/callback?code=stolen');
		flow.deliver('com.arcspirits.app://share/target');
		await tick();
		expect(flow.exchangedCodes).toEqual([]);
		flow.deliver(flow.callbackUrl(`code=real`));
		await run;
		expect(flow.exchangedCodes).toEqual(['real']);
	});

	test('a provider error deep link fails the flow without any exchange', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'apple', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`error=access_denied&error_description=User+cancelled`));
		await expect(run).rejects.toThrow(/User cancelled/);
		expect(flow.exchangedCodes).toEqual([]);
		expect(flow.listeners).toBe(0);
	});

	test('never completing the provider flow times out (bounded), unsubscribed, and a later flow starts fresh', async () => {
		const flow = fakeFlow();
		await expect(runNativeOAuth(flow.auth, 'google', 'link', flow.deps)).rejects.toThrow(
			/timed out/i
		);
		expect(flow.listeners).toBe(0);
		expect(flow.unsubscribes).toBe(1);
		// The pending-flow latch was released — the retry runs to completion.
		const retry = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=after-timeout`));
		await retry;
		expect(flow.exchangedCodes).toEqual(['after-timeout']);
		expect(flow.listeners).toBe(0);
	});

	test('an openUrl failure tears down completely (listener unsubscribed exactly once) and the next attempt works', async () => {
		const flow = fakeFlow({ openError: 'browser refused to open' });
		await expect(runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps)).rejects.toThrow(
			/browser refused to open/
		);
		expect(flow.listeners).toBe(0);
		expect(flow.unsubscribes).toBe(1);
		expect(flow.exchangedCodes).toEqual([]);
		const retry = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=after-open-failure`));
		await retry;
		expect(flow.exchangedCodes).toEqual(['after-open-failure']);
		expect(flow.unsubscribes).toBe(2);
	});

	test('only ONE flow may be pending: a concurrent second attempt is refused without disturbing the first', async () => {
		const flow = fakeFlow();
		const first = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		await expect(runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps)).rejects.toThrow(
			/already in progress/
		);
		// The first flow is untouched by the refusal and still completes.
		flow.deliver(flow.callbackUrl(`code=single-flight`));
		await first;
		expect(flow.exchangedCodes).toEqual(['single-flight']);
	});

	test('a begin failure (e.g. manual linking disabled) surfaces verbatim and never opens a browser', async () => {
		const flow = fakeFlow({ beginError: 'Manual linking is disabled' });
		await expect(runNativeOAuth(flow.auth, 'google', 'link', flow.deps)).rejects.toThrow(
			/Manual linking is disabled/
		);
		expect(flow.openedUrls).toEqual([]);
	});

	test('a begin response without a provider URL fails explicitly', async () => {
		const flow = fakeFlow({ beginUrl: null });
		await expect(runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps)).rejects.toThrow(
			/no provider URL/
		);
	});

	test('an exchange failure propagates (the deep link alone is not a session)', async () => {
		const flow = fakeFlow({ exchangeError: 'invalid code verifier' });
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=c9`));
		await expect(run).rejects.toThrow(/invalid code verifier/);
	});
});

// ── link-mode uid proof: verify, never assume ────────────────────────────────────

describe('runNativeOAuth link-mode uid proof', () => {
	test('the post-exchange uid is VERIFIED equal to the pre-flow uid on success', async () => {
		const flow = fakeFlow({ uid: 'uid-canonical', uidAfterExchange: 'uid-canonical' });
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=same-uid`));
		await run;
		// Captured before AND checked after — equality is proven, not assumed.
		expect(flow.calls.filter((c) => c === 'getUser')).toHaveLength(2);
		expect(flow.exchangedCodes).toEqual(['same-uid']);
		expect(flow.signOuts).toBe(0); // a correct link never quarantines
	});

	test('a DIFFERENT uid after the exchange FAILS CLOSED: the mismatched session is SIGNED OUT before the loud failure', async () => {
		const flow = fakeFlow({ uid: 'uid-canonical', uidAfterExchange: 'uid-hijacked' });
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=uid-swap`));
		await expect(run).rejects.toThrow(/changed the account identity/i);
		// The wrong session Supabase installed was quarantined — no caller can
		// continue under the wrong canonical identity.
		expect(flow.signOuts).toBe(1);
		expect(flow.listeners).toBe(0); // still torn down cleanly
	});

	test('an UNVERIFIABLE post-exchange state (getUser failing even on retry) is quarantined the same way', async () => {
		const flow = fakeFlow({ uid: 'uid-canonical', getUserFailAfterExchange: true });
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=unverifiable`));
		await expect(run).rejects.toThrow(/signed out rather than continuing/i);
		expect(flow.signOuts).toBe(1);
		// It genuinely retried the read before giving up.
		expect(flow.calls.filter((c) => c === 'getUser').length).toBeGreaterThanOrEqual(3);
	});

	test('link mode with NO signed-in account fails before any browser opens', async () => {
		const flow = fakeFlow({ uid: null });
		await expect(runNativeOAuth(flow.auth, 'google', 'link', flow.deps)).rejects.toThrow(
			/no signed-in account/i
		);
		expect(flow.openedUrls).toEqual([]);
		expect(flow.exchangedCodes).toEqual([]);
	});
});

// ── cold-start launch-URL resume (persisted pending-flow machine) ──────────────────

describe('resumeColdStartOAuth', () => {
	test('a pending flow + callback launch URL is exchanged once, and the pending record is cleared', async () => {
		const flow = fakeFlow({
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=cold-code`
		});
		seedPending(flow.storage);
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(true);
		expect(flow.exchangedCodes).toEqual(['cold-code']);
		expect(readPending(flow.storage)).toBeNull(); // settled — never haunts a later boot
	});

	test('WITHOUT a pending record, a callback launch URL is STALE: ignored, nothing consumed or exchanged', async () => {
		const flow = fakeFlow({ launchUrl: `${NATIVE_OAUTH_CALLBACK}?code=stale-cold` });
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
		expect(flow.exchangedCodes).toEqual([]);
	});

	test('no launch URL, or deps without getLaunchUrl, resumes nothing (a pending flow is settled as abandoned)', async () => {
		const flow = fakeFlow({ launchUrl: null });
		seedPending(flow.storage);
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
		// Icon-tap relaunch: the old flow's listener died with the old process — the
		// record is settled rather than left pending forever.
		expect(readPending(flow.storage)).toBeNull();
		const bare = fakeFlow();
		delete bare.deps.getLaunchUrl;
		seedPending(bare.storage);
		await expect(resumeColdStartOAuth(bare.auth, bare.deps)).resolves.toBe(false);
		expect(flow.exchangedCodes).toEqual([]);
		expect(bare.exchangedCodes).toEqual([]);
	});

	test('an EXPIRED pending record is cleaned up and resumes nothing — even with a callback launch URL', async () => {
		const flow = fakeFlow({ launchUrl: `${NATIVE_OAUTH_CALLBACK}?code=too-late` });
		seedPending(flow.storage, { expiresAt: Date.now() - 1000 });
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
		expect(flow.exchangedCodes).toEqual([]);
		expect(readPending(flow.storage)).toBeNull();
	});

	test('foreign launch URLs are ignored: no exchange, and their codes are NOT consumed', async () => {
		for (const foreign of [
			'https://evil.example/auth/callback?code=shared-1',
			'com.arcspirits.app://share/target?code=shared-1'
		]) {
			const flow = fakeFlow({ launchUrl: foreign });
			seedPending(flow.storage);
			await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
			expect(flow.exchangedCodes).toEqual([]);
		}
		// The foreign URL's code never entered the ledger — OUR callback carrying the
		// same code value still exchanges normally.
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=shared-1`));
		await run;
		expect(flow.exchangedCodes).toEqual(['shared-1']);
	});

	test('a provider-error launch URL is the flow\'s authoritative failure: pending cleared, no throw at boot', async () => {
		const flow = fakeFlow({
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?error=access_denied&error_description=User+cancelled`
		});
		seedPending(flow.storage);
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
		expect(flow.exchangedCodes).toEqual([]);
		expect(readPending(flow.storage)).toBeNull();
	});

	test('an exchange failure at cold start surfaces as an error and clears the pending record', async () => {
		const flow = fakeFlow({
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=cold-bad`,
			exchangeError: 'invalid code verifier'
		});
		seedPending(flow.storage);
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).rejects.toThrow(
			/invalid code verifier/
		);
		expect(readPending(flow.storage)).toBeNull();
	});
});

// ── ACTUAL simulated process restarts ───────────────────────────────────────────────

describe('process-restart resume (in-memory state wiped, storage survives)', () => {
	test('a LINK flow killed mid-sheet resumes cold with uid verified BEFORE and AFTER; a second restart replays nothing', async () => {
		const storage = memStorage();

		// Process 1: the warm LINK flow begins (pending record written), then the OS
		// kills the app while the browser sheet is up — the flow never settles.
		const killed = fakeFlow({ uid: 'uid-guest', storage });
		const abandoned = runNativeOAuth(killed.auth, 'google', 'link', killed.deps).catch(() => {});
		await tick();
		const persisted = readPending(storage);
		expect(persisted?.mode).toBe('link');
		expect(persisted?.expectedUid).toBe('uid-guest');

		// PROCESS DEATH: every in-memory ledger/latch is gone; storage survives.
		resetNativeOAuthStateForTests();

		// Process 2: launched BY the callback deep link (which carries the flow's
		// own marker — the real redirect always does). The cold path must verify
		// the recorded uid before the exchange and again after, then clear pending.
		const coldCallback = `${NATIVE_OAUTH_CALLBACK}?flow=${persisted?.nonce}&code=cold-resume`;
		const relaunched = fakeFlow({
			uid: 'uid-guest',
			launchUrl: coldCallback,
			storage
		});
		await expect(resumeColdStartOAuth(relaunched.auth, relaunched.deps)).resolves.toBe(true);
		expect(relaunched.exchangedCodes).toEqual(['cold-resume']);
		expect(relaunched.calls.filter((c) => c === 'getUser')).toHaveLength(2); // before + after
		expect(readPending(storage)).toBeNull();

		// SECOND process death + relaunch with the SAME launch URL redelivered: the
		// cross-restart ledger (the cleared pending record) blocks any re-exchange.
		resetNativeOAuthStateForTests();
		const replayed = fakeFlow({
			uid: 'uid-guest',
			launchUrl: coldCallback,
			storage
		});
		await expect(resumeColdStartOAuth(replayed.auth, replayed.deps)).resolves.toBe(false);
		expect(replayed.exchangedCodes).toEqual([]);

		// Settle process 1's abandoned promise (test hygiene — its own teardown ran).
		killed.deliver(`${NATIVE_OAUTH_CALLBACK}?error=access_denied`);
		await abandoned;
	});

	test('a cold LINK whose signed-in account CHANGED while closed fails BEFORE any exchange', async () => {
		const storage = memStorage();
		seedPending(storage, { mode: 'link', expectedUid: 'uid-original' });
		resetNativeOAuthStateForTests();
		const flow = fakeFlow({
			uid: 'uid-someone-else', // a different account holds the session now
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=cold-link`,
			storage
		});
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).rejects.toThrow(
			/signed-in account changed/i
		);
		expect(flow.exchangedCodes).toEqual([]); // verified BEFORE the exchange
		expect(readPending(storage)).toBeNull();
	});

	test('a cold LINK whose post-exchange uid differs from the recorded one fails loudly — and SIGNS OUT the mismatched session', async () => {
		const storage = memStorage();
		seedPending(storage, { mode: 'link', expectedUid: 'uid-original' });
		const flow = fakeFlow({
			uid: 'uid-original',
			uidAfterExchange: 'uid-hijacked',
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=cold-link-swap`,
			storage
		});
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).rejects.toThrow(
			/changed the account identity/i
		);
		expect(flow.signOuts).toBe(1); // fail closed — never left active
		expect(readPending(storage)).toBeNull();
	});

	test('a STALE flow-A callback cannot settle flow B\'s cold resume: strict ownership rejects it BEFORE any exchange (marker-less included) — never a phantom success', async () => {
		// Flow B is pending (it wrote the record and stored ITS verifier); the
		// launch URL redelivers flow A's OLD callback. Pre-fix the MARKER-LESS
		// variant was exchanged "for compatibility" against B's stored verifier —
		// burning it on a dead code. Strict ownership rejects BOTH shapes without
		// consuming or exchanging anything, so B's verifier survives.
		for (const staleLaunch of [
			`${NATIVE_OAUTH_CALLBACK}?flow=flow-A&code=flow-A-code`, // foreign marker
			`${NATIVE_OAUTH_CALLBACK}?code=flow-A-code` // marker-less (older flow)
		]) {
			resetNativeOAuthStateForTests();
			const storage = memStorage();
			seedPending(storage, { nonce: 'flow-B' });
			const flow = fakeFlow({
				launchUrl: staleLaunch,
				exchangeError: 'invalid code verifier',
				storage
			});
			await expect(resumeColdStartOAuth(flow.auth, flow.deps), staleLaunch).resolves.toBe(false);
			expect(flow.exchangedCodes, staleLaunch).toEqual([]); // B's verifier survives
			// The pending flow itself is settled as abandoned (its own callback died
			// with the old process) — never left to haunt a later boot.
			expect(readPending(storage), staleLaunch).toBeNull();
		}
	});

	test('the persisted pending record carries ONLY non-secret metadata (no code, token or verifier shape)', async () => {
		const flow = fakeFlow({ uid: 'uid-guest' });
		const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
		await tick();
		const record = readPending(flow.storage);
		expect(record).not.toBeNull();
		expect(Object.keys(record as object).sort()).toEqual(
			['createdAt', 'expectedUid', 'expiresAt', 'mode', 'nonce', 'provider', 'v'].sort()
		);
		flow.deliver(flow.callbackUrl(`code=finish-nonsecret`));
		await run;
		expect(readPending(flow.storage)).toBeNull(); // cleared on success
	});
});

// ── exact-once exchange across duplicate warm + cold delivery ─────────────────────

describe('exact-once exchange (warm + cold duplicate delivery)', () => {
	test('warm THEN cold: the launch-URL duplicate is ignored, exactly one exchange', async () => {
		const flow = fakeFlow({ launchUrl: `${NATIVE_OAUTH_CALLBACK}?code=dup-wc` });
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=dup-wc`));
		await run;
		// The SAME code now shows up as the launch URL (e.g. a redundant delivery) —
		// the warm success cleared the pending record, so it is ignored, never
		// double-exchanged (in-memory ledger AND cross-restart record agree).
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(false);
		expect(flow.exchangedCodes).toEqual(['dup-wc']);
	});

	test('cold THEN warm: a stale already-consumed code can NEITHER settle a newer flow NOR fake a success without an exchange', async () => {
		const flow = fakeFlow({
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=dup-cw`
		});
		seedPending(flow.storage);
		await expect(resumeColdStartOAuth(flow.auth, flow.deps)).resolves.toBe(true);
		expect(flow.exchangedCodes).toEqual(['dup-cw']);

		// A NEWER flow starts; the stale duplicate arrives as a warm event. The old
		// behavior "settled" the new flow successfully WITHOUT any exchange — the
		// exact defect. Now the duplicate is ignored and the flow keeps waiting for
		// ITS OWN callback…
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=dup-cw`)); // stale — ignored
		await tick();
		expect(flow.exchangedCodes).toEqual(['dup-cw']); // still exactly one exchange
		// …and completes only with a genuinely fresh code.
		flow.deliver(flow.callbackUrl(`code=fresh-own-code`));
		await run;
		expect(flow.exchangedCodes).toEqual(['dup-cw', 'fresh-own-code']);
		expect(flow.listeners).toBe(0);
	});
});

// ── no secrets in error messages ──────────────────────────────────────────────────

describe('one owner: cold-start recovery vs a new interactive flow', () => {
	test('an interactive flow started while recovery is MID-EXCHANGE waits for it to settle, then begins cleanly with its own record intact', async () => {
		const storage = memStorage();
		seedPending(storage, { nonce: 'cold-1', mode: 'signIn' });
		let releaseExchange!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseExchange = resolve;
		});
		const flow = fakeFlow({
			storage,
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=cold-1&code=cold-code`,
			exchangeGate: gate
		});

		const resume = resumeColdStartOAuth(flow.auth, flow.deps);
		await tick();
		expect(flow.exchangedCodes).toEqual(['cold-code']); // recovery mid-exchange

		// The user taps "sign in" while startup recovery is still exchanging: the
		// new flow must NOT begin underneath it (a fresh begin would replace the
		// stored PKCE verifier the recovery's exchange depends on).
		const interactive = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		expect(flow.calls).not.toContain('signInWithOAuth'); // blocked on the recovery

		releaseExchange();
		expect(await resume).toBe(true);
		await tick();
		expect(flow.calls).toContain('signInWithOAuth'); // now it begins

		// The recovery's (nonce-guarded) cleanup did not wipe the interactive
		// flow's freshly-written pending record.
		expect(readPending(storage)?.nonce).toBe(flow.flowMarker());

		flow.deliver(flow.callbackUrl('code=warm-after-cold'));
		await interactive;
		expect(flow.exchangedCodes).toEqual(['cold-code', 'warm-after-cold']);
		expect(readPending(storage)).toBeNull(); // and its own settle cleared its own record
	});

	test('a recovery fired while an interactive flow already owns the machine backs off without touching anything', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();
		expect(readPending(flow.storage)).not.toBeNull();

		// A (pathological) late resume call: the interactive flow owns the latch.
		expect(await resumeColdStartOAuth(flow.auth, flow.deps)).toBe(false);
		expect(readPending(flow.storage)).not.toBeNull(); // the live flow's record survives

		flow.deliver(flow.callbackUrl('code=owned'));
		await run;
		expect(flow.exchangedCodes).toEqual(['owned']);
	});
});

describe('callback ownership: stale callbacks are QUARANTINED, never exchanged against the live flow', () => {
	test('a stale, previously UNCONSUMED flow-A callback delivered warm neither settles flow B nor destroys its verifier — B completes with its own callback', async () => {
		const flow = fakeFlow();
		const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
		await tick();

		// Flow A timed out in a previous life; its callback (never consumed, so the
		// consumed-code ledger does NOT screen it) finally arrives. Pre-fix this was
		// exchanged against B's verifier — failing the exchange AND deleting B's
		// stored verifier (supabase-js removes it on failed exchanges too), killing B.
		flow.deliver(`${NATIVE_OAUTH_CALLBACK}?flow=stale-flow-a&code=stale-a-code`);
		await tick();
		expect(flow.exchangedCodes).toEqual([]); // quarantined — nothing exchanged

		// A stale CANCELLATION from flow A must not cancel B either.
		flow.deliver(
			`${NATIVE_OAUTH_CALLBACK}?flow=stale-flow-a&error=access_denied&error_description=Old+cancel`
		);
		await tick();

		// Flow B is still live and ITS OWN callback completes it.
		flow.deliver(flow.callbackUrl('code=b-own-code'));
		await run;
		expect(flow.exchangedCodes).toEqual(['b-own-code']);
	});

	test('COLD: a launch callback naming a DIFFERENT flow than the pending record exchanges nothing and settles the pending flow as abandoned', async () => {
		const storage = memStorage();
		seedPending(storage, { nonce: 'flow-B', mode: 'signIn' });
		const flow = fakeFlow({
			storage,
			launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=flow-A&code=foreign-cold-code`
		});
		expect(await resumeColdStartOAuth(flow.auth, flow.deps)).toBe(false);
		expect(flow.exchangedCodes).toEqual([]); // the foreign code never touched B's verifier
		expect(readPending(storage)).toBeNull(); // B cannot complete cold — settled as abandoned
	});
});

describe('listener registration failure', () => {
	test('clears exactly its own pending record, leaks no listener, and releases the latch for a fresh attempt', async () => {
		const failing = fakeFlow({ listenError: 'listener registration exploded' });
		await expect(runNativeOAuth(failing.auth, 'google', 'signIn', failing.deps)).rejects.toThrow(
			/listener registration exploded/
		);
		// The record written just before registration is gone (nonce-guarded — its
		// own), and no listener or browser sheet was left behind.
		expect(readPending(failing.storage)).toBeNull();
		expect(failing.listeners).toBe(0);
		expect(failing.openedUrls).toEqual([]);

		// The latch is released: the NEXT attempt runs the full happy path.
		const retry = fakeFlow();
		const run = runNativeOAuth(retry.auth, 'google', 'signIn', retry.deps);
		await tick();
		retry.deliver(retry.callbackUrl('code=after-listen-failure'));
		await run;
		expect(retry.exchangedCodes).toEqual(['after-listen-failure']);
	});
});

describe('no authorization code ever leaks into error messages', () => {
	test('warm exchange failure, link uid mismatch, and cold exchange failure all omit the code', async () => {
		const scenarios: Array<{ code: string; run: () => Promise<unknown> }> = [
			{
				code: 'sekrit-warm-code',
				run: async () => {
					const flow = fakeFlow({ exchangeError: 'invalid code verifier' });
					const run = runNativeOAuth(flow.auth, 'google', 'signIn', flow.deps);
					await tick();
					flow.deliver(flow.callbackUrl(`code=sekrit-warm-code`));
					return run;
				}
			},
			{
				code: 'sekrit-link-code',
				run: async () => {
					const flow = fakeFlow({ uid: 'u1', uidAfterExchange: 'u2' });
					const run = runNativeOAuth(flow.auth, 'google', 'link', flow.deps);
					await tick();
					flow.deliver(flow.callbackUrl(`code=sekrit-link-code`));
					return run;
				}
			},
			{
				code: 'sekrit-cold-code',
				run: async () => {
					const flow = fakeFlow({
						launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=sekrit-cold-code`,
						exchangeError: 'invalid code verifier'
					});
					seedPending(flow.storage);
					return resumeColdStartOAuth(flow.auth, flow.deps);
				}
			},
			{
				code: 'sekrit-cold-link-code',
				run: async () => {
					const flow = fakeFlow({
						uid: 'uid-someone-else',
						launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=sekrit-cold-link-code`
					});
					seedPending(flow.storage, { mode: 'link', expectedUid: 'uid-original' });
					return resumeColdStartOAuth(flow.auth, flow.deps);
				}
			}
		];
		for (const { code, run } of scenarios) {
			resetNativeOAuthStateForTests();
			let thrown: unknown = null;
			await run().catch((err: unknown) => {
				thrown = err;
			});
			expect(thrown, code).toBeInstanceOf(Error);
			expect((thrown as Error).message, code).not.toContain(code);
		}
	});
});

// ── unclean quarantine escalation (fail-closed host hand-off) ───────────────────────

describe('quarantine sign-out outcome is CHECKED (warm + cold, resolved-error + rejection)', () => {
	function withEscalation(deps: NativeOAuthDeps) {
		let escalations = 0;
		return {
			deps: {
				...deps,
				onQuarantineUnclean: () => {
					escalations += 1;
				}
			} satisfies NativeOAuthDeps,
			count: () => escalations
		};
	}

	test('WARM mismatch, signOut RESOLVES {error} (auth-js offline/5xx shape): the host quarantine escalates — the wrong session may still be installed', async () => {
		const flow = fakeFlow({ uid: 'u1', uidAfterExchange: 'u2', signOutError: 'network down' });
		const esc = withEscalation(flow.deps);
		const run = runNativeOAuth(flow.auth, 'google', 'link', esc.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=warm-unclean`));
		await expect(run).rejects.toThrow(/changed the account identity/i);
		expect(flow.signOuts).toBe(1);
		expect(esc.count()).toBe(1); // fail-closed hand-off to the host store
	});

	test('WARM mismatch, signOut REJECTS outright: escalated the same way, and the loud failure is never masked', async () => {
		const flow = fakeFlow({ uid: 'u1', uidAfterExchange: 'u2', signOutReject: 'transport died' });
		const esc = withEscalation(flow.deps);
		const run = runNativeOAuth(flow.auth, 'google', 'link', esc.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=warm-reject`));
		await expect(run).rejects.toThrow(/changed the account identity/i);
		expect(esc.count()).toBe(1);
	});

	test('WARM mismatch, signOut resolves CLEAN: the session is verifiably gone — NO escalation', async () => {
		const flow = fakeFlow({ uid: 'u1', uidAfterExchange: 'u2' });
		const esc = withEscalation(flow.deps);
		const run = runNativeOAuth(flow.auth, 'google', 'link', esc.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=warm-clean`));
		await expect(run).rejects.toThrow(/changed the account identity/i);
		expect(flow.signOuts).toBe(1);
		expect(esc.count()).toBe(0);
	});

	test('WARM unverifiable session (getUser fails even on retry) with a failing signOut escalates too', async () => {
		const flow = fakeFlow({
			uid: 'u1',
			getUserFailAfterExchange: true,
			signOutError: 'still down'
		});
		const esc = withEscalation(flow.deps);
		const run = runNativeOAuth(flow.auth, 'google', 'link', esc.deps);
		await tick();
		flow.deliver(flow.callbackUrl(`code=warm-unverifiable`));
		await expect(run).rejects.toThrow(/could not verify the account/i);
		expect(esc.count()).toBe(1);
	});

	test('COLD mismatch: resolved-error and rejecting signOut both escalate; a clean one does not', async () => {
		for (const [overrides, expected] of [
			[{ signOutError: 'network down' }, 1],
			[{ signOutReject: 'transport died' }, 1],
			[{}, 0]
		] as const) {
			resetNativeOAuthStateForTests();
			const storage = memStorage();
			seedPending(storage, { mode: 'link', expectedUid: 'uid-original' });
			const flow = fakeFlow({
				uid: 'uid-original',
				uidAfterExchange: 'uid-hijacked',
				launchUrl: `${NATIVE_OAUTH_CALLBACK}?flow=seeded-flow-nonce&code=cold-unclean`,
				storage,
				...overrides
			});
			const esc = withEscalation(flow.deps);
			await expect(
				resumeColdStartOAuth(flow.auth, esc.deps),
				JSON.stringify(overrides)
			).rejects.toThrow(/changed the account identity/i);
			expect(flow.signOuts, JSON.stringify(overrides)).toBe(1);
			expect(esc.count(), JSON.stringify(overrides)).toBe(expected);
		}
	});
});
