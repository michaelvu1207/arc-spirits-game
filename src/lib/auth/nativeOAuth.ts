/**
 * Native (Capacitor) OAuth round trip — system browser out, deep link back.
 *
 * The static native shell cannot complete the web flow: `/auth/callback` is a
 * SvelteKit SERVER route (PKCE code → session cookie exchange), and a bundle served
 * from `capacitor://localhost` has no server and no first-party cookie jar for the
 * provider redirect to land in. This module keeps CANONICAL IDENTITY intact with a
 * fully client-held PKCE exchange instead:
 *
 *   1. BEGIN in the app's webview: `linkIdentity` (guest-account claim — SAME uid,
 *      all progress kept) or `signInWithOAuth`, with `skipBrowserRedirect` — the
 *      supabase-js client generates and STORES the PKCE code_verifier locally and
 *      hands back the provider URL without navigating.
 *   2. OPEN the provider URL in the SYSTEM browser (SFSafariViewController via
 *      @capacitor/browser). Credentials are typed into the real browser, never
 *      into the app's webview.
 *   3. RETURN via the app's private URL scheme: the provider bounces through the
 *      Supabase callback to `com.arcspirits.app://auth/callback?code=…`. The deep
 *      link carries ONLY the one-time authorization code — useless to any other
 *      app without the code_verifier held in this app's storage.
 *   4. EXCHANGE in the webview: `exchangeCodeForSession(code)` completes PKCE with
 *      the stored verifier.
 *
 * DELIVERY REALITIES — this is a small state machine, not a happy path, because the
 * OS delivers the callback through TWO channels and may deliver it more than once:
 *
 *   • WARM return — the app stayed alive behind the browser sheet: the callback
 *     arrives as a @capacitor/app `appUrlOpen` event. The listener registration is
 *     AWAITED before the browser opens, so a fast redirect can never outrun it and
 *     cleanup always holds a RESOLVED unsubscribe (no handle-in-flight race).
 *   • COLD return — the OS killed the app while the sheet was up: the callback
 *     arrives as the LAUNCH URL of the next process ({@link resumeColdStartOAuth},
 *     called once at startup by the shell). The PKCE code_verifier survived in the
 *     supabase-js storage, so the exchange still completes — GOVERNED by the
 *     PERSISTED PENDING-FLOW RECORD below, never by guesswork.
 *   • PERSISTED PENDING FLOW — beginning a flow writes a NON-SECRET record (mode,
 *     provider, expected uid for link, a per-flow nonce, bounded created/expiry
 *     instants — NEVER a code, token or verifier) to the SAME storage that holds
 *     the PKCE verifier, before the browser opens. It is cleared on EVERY warm
 *     settle (success, provider error/cancellation, timeout, open failure) and on
 *     every cold settle. The cold path exchanges ONLY when a live, unexpired
 *     pending record exists: a callback launch URL with no pending flow is stale
 *     by definition (some earlier settle already consumed or abandoned it) and is
 *     ignored WITHOUT consuming anything; an expired record is cleaned up.
 *   • DUPLICATES — the same callback URL can be delivered through BOTH channels (or
 *     twice). Within one process, a module-level consumed-code ledger
 *     ({@link tryConsumeCode}, checked-and-set synchronously so concurrent
 *     deliveries cannot both win) guarantees EXACTLY ONE `exchangeCodeForSession`
 *     per code; ACROSS a process death, the pending record is the ledger — it is
 *     cleared by the settle that exchanged, so a redelivered launch URL finds no
 *     pending flow and is ignored. An already-consumed code arriving as a warm
 *     event is IGNORED by the listener (it belongs to an older, settled flow):
 *     it can neither settle the newer flow nor conjure a success without an
 *     exchange — the newer flow keeps waiting for ITS OWN callback.
 *   • CALLBACK OWNERSHIP — every flow rides its own nonce through the redirect URL
 *     (`redirectTo: …/auth/callback?flow=<nonce>`, the same query-param pattern the
 *     web flow's `?next=` already exercises against the project's allow-list), so
 *     a delivered callback names the flow it belongs to. This matters because
 *     supabase-js DELETES the stored PKCE verifier on a FAILED exchange too: an
 *     unconsumed stale flow-A callback exchanged "just to see" during flow B would
 *     both fail AND destroy B's verifier — B could never complete. The listener
 *     therefore QUARANTINES any callback that does not carry EXACTLY the live
 *     flow's marker (code and provider-error deliveries alike: a stale
 *     cancellation must not cancel B) without consuming or exchanging anything —
 *     flow B keeps waiting for its own callback. MARKER-LESS callbacks are
 *     rejected the same way, strictly and fail-closed: every flow this build
 *     ever began minted a marker, so a marker-less delivery is by definition an
 *     older flow's stale callback — "compatibility" acceptance would burn the
 *     live flow's verifier on a dead code and disrupt the new sign-in.
 *   • STALE FLOWS — a callback from flow A can never settle flow B and report
 *     success: the flow marker screens it out before anything is consumed; within
 *     a process the ledger additionally screens consumed codes; and across a
 *     restart the exchange binds to the PKCE verifier of the flow that stored the
 *     pending record — never a phantom success without an exchange.
 *   • FAILURE — timeout, provider-error deep link, or a browser that refuses to
 *     open all tear the flow down completely: listener unsubscribed, timer cleared,
 *     pending record cleared, pending-flow latch released, and the system browser
 *     sheet closed best-effort — the next attempt starts fresh, no listener leak.
 *   • FOREIGN LINKS — anything that is not EXACTLY our callback never settles the
 *     flow and is never consumed by the cold-start path.
 *   • LINK PROOF — `mode: 'link'` exists to claim the CURRENT uid. The flow captures
 *     the canonical uid BEFORE beginning and VERIFIES (never assumes) that the
 *     post-exchange session still carries it; if the provider identity landed on a
 *     different account the flow FAILS CLOSED: the mismatched session Supabase just
 *     installed is SIGNED OUT (local scope) before the loud failure, so no caller
 *     ever continues under the wrong canonical identity. An unverifiable post-
 *     exchange state (getUser failing even on retry) quarantines the same way.
 *     The COLD path enforces the same proof from the persisted record: the current
 *     uid must equal the recorded expected uid BEFORE the exchange and again AFTER.
 *   • ONE OWNER — cold-start recovery and interactive flows share one owner lock:
 *     the shell's startup resume holds the flow latch while it runs, and every new
 *     interactive flow AWAITS the startup recovery's settle before beginning, so a
 *     resuming exchange can never interleave with (or have its verifier replaced
 *     by) a fresh begin — and every cleanup either path performs is nonce-guarded
 *     to its own record, never a newer flow's.
 *   • NO SECRETS — authorization codes and tokens are never logged, never persisted
 *     and never appear in error messages; failures describe the situation, not the
 *     credential.
 *
 * The web build never enters this path (see auth.svelte.ts: `isNativeShell()`),
 * and the plugin modules are imported dynamically so the web bundle stays free of
 * them. Simulator-ready: no signing, device, or push entitlement needed — the URL
 * scheme is registered in ios/App/App/Info.plist and the orchestration logic is
 * unit-tested with injected fakes (nativeOAuth.test.ts).
 */

import type { OAuthProvider } from './auth.svelte';

/** The app's private URL scheme (mirrors appId in capacitor.config.ts and the
 *  CFBundleURLTypes entry in ios/App/App/Info.plist). */
export const NATIVE_OAUTH_SCHEME = 'com.arcspirits.app';
/** The redirect base the Supabase project must allow-list for native builds. Flows
 *  append `?flow=<nonce>` (callback-ownership binding), so the allow-list entry must
 *  tolerate query params — the same pattern the web flow's `?next=` already uses
 *  (`com.arcspirits.app://auth/callback*` when matching is exact). */
export const NATIVE_OAUTH_CALLBACK = `${NATIVE_OAUTH_SCHEME}://auth/callback`;

/** How long the user gets to finish the provider flow before the attempt fails. */
const DEEP_LINK_TIMEOUT_MS = 5 * 60_000;

/** Storage key of the persisted pending-flow record (NON-SECRET metadata only —
 *  never a code, token or verifier). Lives in the same storage as the PKCE
 *  verifier, so it survives exactly the process deaths the verifier survives. */
export const NATIVE_OAUTH_PENDING_KEY = 'arc-native-oauth-pending';
/** How long a persisted pending flow stays resumable across a process death.
 *  Longer than the warm timeout on purpose: the OS may kill the app while the
 *  user is mid-provider-flow and the cold return can arrive later than a warm
 *  one would have. */
export const PENDING_FLOW_TTL_MS = 10 * 60_000;

/** The persisted pending-flow record — every field is non-secret by construction. */
export interface NativeOAuthPendingFlow {
	v: 1;
	/** Per-flow binding: distinguishes THIS flow instance from any other. */
	nonce: string;
	mode: 'link' | 'signIn';
	provider: OAuthProvider;
	/** The canonical uid a LINK flow must preserve (null for signIn). */
	expectedUid: string | null;
	createdAt: number;
	expiresAt: number;
}

/** The minimal storage surface (localStorage-shaped; tests inject a fake). */
export type NativeOAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readPendingFlow(storage: NativeOAuthStorage | undefined): NativeOAuthPendingFlow | null {
	if (!storage) return null;
	try {
		const raw = storage.getItem(NATIVE_OAUTH_PENDING_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as NativeOAuthPendingFlow;
		if (
			parsed == null ||
			parsed.v !== 1 ||
			typeof parsed.nonce !== 'string' ||
			(parsed.mode !== 'link' && parsed.mode !== 'signIn') ||
			typeof parsed.expiresAt !== 'number' ||
			typeof parsed.createdAt !== 'number'
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function writePendingFlow(storage: NativeOAuthStorage | undefined, record: NativeOAuthPendingFlow) {
	try {
		storage?.setItem(NATIVE_OAUTH_PENDING_KEY, JSON.stringify(record));
	} catch {
		// Storage denied — the warm path still works; only cold resume is lost.
	}
}

/** Clear the pending record — but ONLY the one this flow wrote (nonce-guarded), so
 *  a slow old flow settling late can never wipe a newer flow's record. Pass null
 *  to clear unconditionally (cold-path settles, expiry cleanup). */
function clearPendingFlow(storage: NativeOAuthStorage | undefined, nonce: string | null) {
	try {
		if (!storage) return;
		if (nonce != null) {
			const current = readPendingFlow(storage);
			if (current && current.nonce !== nonce) return;
		}
		storage.removeItem(NATIVE_OAUTH_PENDING_KEY);
	} catch {
		// Best-effort.
	}
}

function mintFlowNonce(): string {
	try {
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}
}

/** True when running inside the Capacitor native shell (never on the web build). */
export function isNativeShell(): boolean {
	try {
		const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
		return cap?.isNativePlatform?.() === true;
	} catch {
		return false;
	}
}

export type OAuthDeepLink =
	| { ok: true; code: string; flow: string | null }
	| { ok: false; error: string; flow: string | null }
	| null;

/**
 * Parse a candidate deep link. Returns null for anything that is not EXACTLY this
 * app's OAuth callback (wrong scheme, wrong host/path, unparseable) — those are
 * other deep links, not ours to consume. A matching callback yields the one-time
 * code or the provider's error, never both silently, plus the FLOW MARKER the
 * beginning flow rode through the redirect URL (`?flow=<nonce>`) — the callback-
 * ownership binding; null for a marker-less (older-app) callback.
 */
export function parseOAuthDeepLink(url: string): OAuthDeepLink {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${NATIVE_OAUTH_SCHEME}:`) return null;
	const target = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
	if (target !== 'auth/callback') return null;
	const flow = parsed.searchParams.get('flow');
	const providerError = parsed.searchParams.get('error');
	if (providerError) {
		return {
			ok: false,
			error: parsed.searchParams.get('error_description') || providerError,
			flow
		};
	}
	const code = parsed.searchParams.get('code');
	if (!code) {
		return { ok: false, error: 'The sign-in redirect carried no authorization code.', flow };
	}
	return { ok: true, code, flow };
}

/** The supabase-js auth surface this flow needs (structural, so tests inject fakes). */
export interface OAuthAuthSurface {
	linkIdentity(credentials: {
		provider: OAuthProvider;
		options?: { redirectTo?: string; skipBrowserRedirect?: boolean };
	}): Promise<{ data: { url?: string | null } | null; error: { message: string } | null }>;
	signInWithOAuth(credentials: {
		provider: OAuthProvider;
		options?: { redirectTo?: string; skipBrowserRedirect?: boolean };
	}): Promise<{ data: { url?: string | null } | null; error: { message: string } | null }>;
	exchangeCodeForSession(code: string): Promise<{ error: { message: string } | null }>;
	/** Current session's user — the canonical uid the link flow must preserve. */
	getUser(): Promise<{
		data: { user: { id: string } | null };
		error: { message: string } | null;
	}>;
	/** Terminate the ACTIVE session (local scope): the fail-closed quarantine when a
	 *  link exchange installed a session for the WRONG canonical identity. */
	signOut(options?: { scope?: 'local' | 'global' | 'others' }): Promise<{
		error: { message: string } | null;
	}>;
}

/** The native-shell capabilities, injected so tests need no Capacitor runtime. */
export interface NativeOAuthDeps {
	/** Open a URL in the SYSTEM browser (not the webview). */
	openUrl(url: string): Promise<void>;
	/** Dismiss the in-app system browser sheet, best-effort. */
	closeBrowser(): Promise<void>;
	/** Subscribe to app deep links; resolves to an unsubscribe ONCE the listener is
	 *  actually registered — callers await this before opening the browser. */
	onDeepLink(callback: (url: string) => void): Promise<() => void>;
	/** The URL that launched this process, if any (cold-start delivery channel).
	 *  Only {@link resumeColdStartOAuth} reads it; warm flows never do. */
	getLaunchUrl?(): Promise<string | null>;
	/** Persistence for the NON-SECRET pending-flow record (survives process death;
	 *  same storage as the PKCE verifier). Absent ⇒ warm-only flows. */
	storage?: NativeOAuthStorage;
	timeoutMs?: number;
	/** ESCALATION for an UNCLEAN quarantine: the wrong-identity session could not
	 *  be PROVABLY cleared (signOut rejected, or resolved with an error — auth-js
	 *  can leave the bad session installed on offline/5xx logout failures). The
	 *  host (auth store) must then fail CLOSED: block all authenticated activity
	 *  and keep retrying the cleanup until it verifiably succeeds. */
	onQuarantineUnclean?: () => void | Promise<void>;
}

/** The real Capacitor deps. Plugin modules load lazily — never in the web bundle. */
export function capacitorOAuthDeps(): NativeOAuthDeps {
	return {
		async openUrl(url) {
			const { Browser } = await import('@capacitor/browser');
			await Browser.open({ url });
		},
		async closeBrowser() {
			try {
				const { Browser } = await import('@capacitor/browser');
				await Browser.close();
			} catch {
				// Best-effort — the redirect already foregrounded us.
			}
		},
		async onDeepLink(callback) {
			const { App } = await import('@capacitor/app');
			const subscription = await App.addListener('appUrlOpen', (event) => callback(event.url));
			return () => {
				void subscription.remove();
			};
		},
		async getLaunchUrl() {
			const { App } = await import('@capacitor/app');
			const launch = await App.getLaunchUrl();
			return launch?.url ?? null;
		},
		// The SAME storage supabase-js keeps the PKCE code_verifier in: the pending
		// record survives exactly the process deaths the verifier survives, so a
		// resumable cold return always finds BOTH or NEITHER.
		storage: (() => {
			try {
				return globalThis.localStorage;
			} catch {
				return undefined;
			}
		})()
	};
}

// ── exact-once exchange ledger + single-pending-flow latch (module state) ─────────
// The same one-time code can be delivered via appUrlOpen AND the launch URL (or
// twice); whoever consumes it here first performs the ONLY exchange. Synchronous
// check-and-set, so two in-flight deliveries cannot both pass the gate.
const consumedCodes = new Set<string>();
const CONSUMED_CODES_MAX = 16; // codes are one-time and minutes-lived — keep it tiny

function tryConsumeCode(code: string): boolean {
	if (consumedCodes.has(code)) return false;
	consumedCodes.add(code);
	while (consumedCodes.size > CONSUMED_CODES_MAX) {
		const oldest: string | undefined = consumedCodes.values().next().value;
		if (oldest === undefined) break;
		consumedCodes.delete(oldest);
	}
	return true;
}

/** Only one flow — interactive OR cold-start recovery — may own the machine at a
 *  time; released in EVERY exit path (success, timeout, provider error, open
 *  failure) so the next attempt starts fresh. */
let flowActive = false;

/** The shell's startup recovery, if one was fired: interactive flows AWAIT its
 *  settle before beginning, so a resuming exchange can never interleave with a
 *  fresh begin (which would replace the stored PKCE verifier out from under it). */
let startupRecovery: Promise<unknown> | null = null;

/** Test hook: clear the module-level ledger/latch between isolated scenarios. */
export function resetNativeOAuthStateForTests(): void {
	consumedCodes.clear();
	flowActive = false;
	startupRecovery = null;
}

/**
 * LINK PROOF (after) with fail-closed quarantine: VERIFY the canonical uid
 * survived the exchange — never assume. Supabase has already installed whatever
 * session the exchange produced; if that session belongs to a DIFFERENT account
 * (or cannot be verified even on retry), it is SIGNED OUT (local scope) before
 * the loud failure, so no caller ever continues under the wrong canonical
 * identity.
 *
 * The sign-out's OUTCOME IS CHECKED — auth-js resolves `{ error }` (rather than
 * rejecting) on offline/5xx logout failures and can leave the wrong session
 * INSTALLED in storage. An unclean quarantine (rejection OR resolved error)
 * escalates through deps.onQuarantineUnclean: the host blocks all authenticated
 * activity and keeps retrying the cleanup until it verifiably succeeds. The
 * escalation never masks the primary error — the loud failure below is thrown
 * regardless.
 */
async function verifyLinkedUidOrQuarantine(
	auth: OAuthAuthSurface,
	expectedUid: string | null,
	onQuarantineUnclean?: () => void | Promise<void>
): Promise<void> {
	const quarantine = async () => {
		let clean = false;
		try {
			const result = await auth.signOut({ scope: 'local' });
			clean = !result?.error;
		} catch {
			clean = false;
		}
		if (!clean) {
			// The wrong session may STILL be installed: fail closed at the host.
			try {
				await onQuarantineUnclean?.();
			} catch {
				// The escalation is itself best-effort here — the loud throw below is
				// the primary signal either way.
			}
		}
	};
	let after = await auth.getUser();
	if (after.error || !after.data.user?.id) {
		// One retry: a transient read failure must not sign a CORRECT link out.
		after = await auth.getUser();
	}
	const afterUid = after.data.user?.id ?? null;
	if (after.error || !afterUid) {
		await quarantine();
		throw new Error(
			'Could not verify the account after linking — the unverified session was signed out rather than continuing under an unknown identity.'
		);
	}
	if (afterUid !== expectedUid) {
		await quarantine();
		throw new Error(
			'Linking changed the account identity: the provider sign-in landed on a different account, so that session was signed out instead of replacing the current one.'
		);
	}
}

/**
 * Run the full native OAuth round trip (the WARM path — the app stays alive and the
 * callback returns as an `appUrlOpen` event). `mode: 'link'` claims the CURRENT
 * (anonymous) account's uid via `linkIdentity` — never `signInWithOAuth`, which
 * would mint a different account and silently abandon the guest's stats and
 * memberships — and PROVES it: the pre-flow uid is captured up front and compared
 * against the post-exchange session uid; a mismatch throws instead of silently
 * switching identities. Throws with the provider/auth error message on any failure
 * (never embedding the authorization code); on success the client session is
 * updated in place (same storage the rest of the app reads).
 */
export async function runNativeOAuth(
	auth: OAuthAuthSurface,
	provider: OAuthProvider,
	mode: 'link' | 'signIn',
	deps: NativeOAuthDeps
): Promise<void> {
	// STARTUP ARBITRATION: if the shell fired a cold-start recovery, it owns the
	// machine (and the stored PKCE verifier) until it settles — beginning a new
	// flow underneath it would replace the verifier its exchange depends on, and
	// its unconditional-looking cleanups would race ours. Block here (its outcome
	// is irrelevant; only its completion matters), then take the latch.
	if (startupRecovery) await startupRecovery;
	// Single pending flow. Checked-and-set BEFORE the try below, so a refused second
	// attempt cannot release the latch the first flow still owns.
	if (flowActive) {
		throw new Error('A sign-in attempt is already in progress — finish or dismiss it first.');
	}
	flowActive = true;
	const flowNonce = mintFlowNonce();
	try {
		// LINK PROOF (before): the uid the link flow promises to preserve. No session
		// means there is nothing to link TO — fail before opening any browser.
		let expectedUid: string | null = null;
		if (mode === 'link') {
			const current = await auth.getUser();
			expectedUid = current.data.user?.id ?? null;
			if (current.error || !expectedUid) {
				throw new Error('Cannot link a provider: no signed-in account to preserve.');
			}
		}

		const begin = mode === 'link' ? auth.linkIdentity.bind(auth) : auth.signInWithOAuth.bind(auth);
		// CALLBACK OWNERSHIP: the flow nonce rides the redirect URL, so the delivered
		// callback names the flow it belongs to (the same query-param pattern the web
		// flow's `?next=` already exercises against the project's redirect allow-list).
		const { data, error } = await begin({
			provider,
			options: {
				redirectTo: `${NATIVE_OAUTH_CALLBACK}?flow=${flowNonce}`,
				skipBrowserRedirect: true
			}
		});
		if (error) throw new Error(error.message);
		const providerUrl = data?.url;
		if (!providerUrl) {
			throw new Error('Could not start the sign-in flow (no provider URL was issued).');
		}

		// PERSIST THE PENDING FLOW before any browser opens: if the OS kills the app
		// while the sheet is up, the next process resumes from exactly this record
		// (mode, expected uid, flow nonce, bounded lifetime — nothing secret).
		const now = Date.now();
		writePendingFlow(deps.storage, {
			v: 1,
			nonce: flowNonce,
			mode,
			provider,
			expectedUid,
			createdAt: now,
			expiresAt: now + PENDING_FLOW_TTL_MS
		});

		let settled = false;
		let settle!: (result: Extract<OAuthDeepLink, { ok: boolean }>) => void;
		let fail!: (err: Error) => void;
		const deepLink = new Promise<Extract<OAuthDeepLink, { ok: boolean }>>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// The timeout can reject while we're still awaiting openUrl — pre-attach a
		// handler so that branch never surfaces as an unhandled rejection.
		deepLink.catch(() => {});

		// Register AND AWAIT the listener BEFORE the browser opens: a fast redirect
		// must not outrun registration, and holding the already-RESOLVED unsubscribe
		// means cleanup can never race a registration still in flight. Registration
		// FAILURE lands after the pending record was written but before the teardown
		// finally below exists — release exactly this flow's own resources (the
		// nonce-guarded record; no timer or browser sheet exists yet) and rethrow.
		let unsubscribe: () => void;
		try {
			unsubscribe = await deps.onDeepLink((url) => {
				const result = parseOAuthDeepLink(url);
				if (result == null || settled) return; // not our callback / already done
				// STRICT CALLBACK OWNERSHIP: only a callback carrying EXACTLY this flow's
				// marker may settle it — code AND provider-error deliveries alike. A
				// callback naming a DIFFERENT flow is a stale flow's delivery (its
				// cancellation must not cancel this one, and exchanging its code would
				// destroy THIS flow's stored PKCE verifier — supabase-js deletes it on
				// failed exchanges too). A MARKER-LESS callback is equally untrusted:
				// every flow this build ever began minted a marker, so a marker-less
				// delivery is by definition an OLDER flow's stale callback — accepting
				// it "for compatibility" would burn this flow's verifier on a dead code
				// and disrupt the live sign-in. Fail closed: nothing is consumed; this
				// flow keeps waiting for its own callback.
				if (result.flow !== flowNonce) return;
				// A code some OTHER settle already exchanged is a STALE duplicate from an
				// older flow — it must neither settle THIS flow nor fake a success without
				// an exchange. Ignore it; this flow keeps waiting for its own callback.
				if (result.ok && consumedCodes.has(result.code)) return;
				settled = true;
				settle(result);
			});
		} catch (err) {
			clearPendingFlow(deps.storage, flowNonce);
			throw err;
		}
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			fail(new Error('Sign-in timed out — the provider window was never completed.'));
		}, deps.timeoutMs ?? DEEP_LINK_TIMEOUT_MS);

		try {
			await deps.openUrl(providerUrl);
			const result = await deepLink;
			await deps.closeBrowser();
			if (!result.ok) throw new Error(result.error);
			// EXACT-ONCE: claim the code in the ledger and perform the ONLY exchange.
			// Losing the claim here means another channel raced us between the listener
			// check and now — surface it honestly rather than reporting an unexchanged
			// success.
			if (!tryConsumeCode(result.code)) {
				throw new Error('This sign-in link was already used — start the sign-in again.');
			}
			const exchanged = await auth.exchangeCodeForSession(result.code);
			if (exchanged.error) throw new Error(exchanged.error.message);
			// LINK PROOF (after): VERIFY the canonical uid survived — never assume. A
			// mismatched or unverifiable session is SIGNED OUT before the loud failure
			// (an UNCLEAN sign-out escalates the fail-closed host quarantine).
			if (mode === 'link') {
				await verifyLinkedUidOrQuarantine(auth, expectedUid, deps.onQuarantineUnclean);
			}
		} catch (err) {
			// Timeout / provider error (user cancellation) / open failure: the system
			// browser sheet may still be up — dismiss it best-effort on the way out.
			void deps.closeBrowser().catch(() => {});
			throw err;
		} finally {
			// EVERY exit (success, timeout, provider error, open failure) tears down:
			// no late settle, no live timer, no leaked listener, no stale pending
			// record (nonce-guarded — never wipes a newer flow's record).
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			clearPendingFlow(deps.storage, flowNonce);
		}
	} finally {
		flowActive = false;
	}
}

/**
 * COLD-START resume — called ONCE at app startup by the native shell (never on the
 * web build). If the OS killed the app while the OAuth browser sheet was up, the
 * callback deep link arrives as this process's LAUNCH URL instead of an
 * `appUrlOpen` event; the PKCE code_verifier AND the pending-flow record survived
 * in supabase-js's storage, so the exchange can still complete — as the EXACT flow
 * that began it, never as a guess:
 *
 *   - NO pending record ⇒ any callback launch URL is STALE (an earlier settle
 *     already exchanged or abandoned it) — ignored, nothing consumed. This is the
 *     cross-restart exact-once ledger: the settle that exchanges clears the
 *     record, so a redelivered launch URL can never exchange twice.
 *   - EXPIRED record ⇒ cleaned up; nothing resumable.
 *   - Provider-error launch URL ⇒ the flow's authoritative failure: the pending
 *     record is cleared (never left to haunt a later start), nothing exchanged.
 *   - LINK flows verify the canonical uid BEFORE the exchange (the signed-in
 *     account must still be the one the flow promised to preserve) and AGAIN
 *     after — exactly the warm path's proof.
 *   - A stale callback from a DIFFERENT flow cannot settle this one as a phantom
 *     success: the exchange binds to the stored PKCE verifier of the flow that
 *     wrote the record, so a foreign code fails the exchange loudly (and clears
 *     the pending record — authoritative failure).
 *
 * Returns true iff a session was established here — the caller then refreshes
 * auth-dependent state. Throws on exchange/link-proof failure (messages never
 * contain the code).
 */
export async function resumeColdStartOAuth(
	auth: OAuthAuthSurface,
	deps: NativeOAuthDeps
): Promise<boolean> {
	// ONE OWNER: the recovery shares the interactive latch — a flow already running
	// (the shell called resume late) is never raced; and while the recovery runs,
	// every new interactive flow blocks on `startupRecovery` (see runNativeOAuth),
	// so nothing can replace the stored PKCE verifier mid-exchange or interleave
	// cleanups. All of this recovery's own cleanups are NONCE-GUARDED to the record
	// it read, so even a pathological overlap can never wipe a newer flow's record.
	if (flowActive) return false;
	flowActive = true;
	const recovery = (async (): Promise<boolean> => {
		const pending = readPendingFlow(deps.storage);
		const launchUrl = (await deps.getLaunchUrl?.()) ?? null;
		const parsed = launchUrl ? parseOAuthDeepLink(launchUrl) : null;

		if (!pending) {
			// No flow is pending: a callback launch URL here is a stale redelivery of a
			// flow that already settled — never consumed, never exchanged.
			return false;
		}
		if (Date.now() > pending.expiresAt) {
			// The flow died with the old process and its window has passed.
			clearPendingFlow(deps.storage, pending.nonce);
			return false;
		}
		if (parsed == null) {
			// A pending flow but no callback in the launch URL: the user relaunched the
			// app themselves (icon tap). The old flow cannot complete any more — its
			// warm listener died with the old process — so settle it as abandoned.
			clearPendingFlow(deps.storage, pending.nonce);
			return false;
		}
		if (parsed.flow !== pending.nonce) {
			// The launch callback does not name the pending flow — a DIFFERENT marker
			// is a stale redelivery, and a MARKER-LESS launch URL is an older flow's
			// callback (every flow this build began minted a marker). STRICT,
			// fail-closed ownership either way: never exchanged (that would consume
			// the pending flow's stored verifier), never consumed. The pending flow
			// itself cannot complete either (its own callback died with the old
			// process), so it settles as abandoned.
			clearPendingFlow(deps.storage, pending.nonce);
			return false;
		}
		if (!parsed.ok) {
			// Provider error / user cancellation delivered cold: authoritative failure.
			clearPendingFlow(deps.storage, pending.nonce);
			return false;
		}
		if (!tryConsumeCode(parsed.code)) return false; // another channel in THIS process won

		try {
			// LINK PROOF (before): the account to preserve must still be signed in.
			if (pending.mode === 'link') {
				const current = await auth.getUser();
				const uid = current.data.user?.id ?? null;
				if (current.error || !uid || uid !== pending.expectedUid) {
					throw new Error(
						'Cannot complete the account link — the signed-in account changed while the app was closed.'
					);
				}
			}
			const exchanged = await auth.exchangeCodeForSession(parsed.code);
			if (exchanged.error) throw new Error(exchanged.error.message);
			// LINK PROOF (after): VERIFY the canonical uid survived — never assume. A
			// mismatched or unverifiable session is SIGNED OUT before the loud failure
			// (fail closed — exactly the warm path's quarantine, unclean-escalation
			// included).
			if (pending.mode === 'link') {
				await verifyLinkedUidOrQuarantine(auth, pending.expectedUid, deps.onQuarantineUnclean);
			}
			return true;
		} finally {
			// EVERY cold settle — success, exchange failure, link-proof failure — clears
			// the pending record (its OWN record only): the flow is over either way.
			clearPendingFlow(deps.storage, pending.nonce);
		}
	})();
	// Interactive flows gate on SETTLEMENT only — the outcome (or failure) of the
	// recovery is the shell's to report.
	startupRecovery = recovery.catch(() => {}).finally(() => {
		startupRecovery = null;
	});
	try {
		return await recovery;
	} finally {
		flowActive = false;
	}
}
