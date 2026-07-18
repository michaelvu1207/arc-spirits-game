import { browser } from '$app/environment';
import { invalidate } from '$app/navigation';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { capacitorOAuthDeps, isNativeShell, runNativeOAuth } from './nativeOAuth';

export interface Profile {
	id: string;
	display_name: string;
	is_anonymous: boolean;
}

export type OAuthProvider = 'google' | 'apple' | 'discord';

/** A play action needed a guest identity and could not get one for a TRANSIENT
 *  reason (offline / auth outage / aborted signup), so UIs show a transport error —
 *  never a misleading "sign in to play" wall. */
export class GuestIdentityUnavailable extends Error {
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = 'GuestIdentityUnavailable';
		this.cause = cause;
	}
}

/** The project has anonymous sign-ins DISABLED (a deliberate server-side posture).
 *  Every room operation requires a VALIDATED account identity, so there is no
 *  cookie-only guest to fall back to — playing requires signing in. Distinct from
 *  {@link GuestIdentityUnavailable} (transient) so UIs can render the honest,
 *  actionable state instead of a transport error. */
export class GuestPlayDisabled extends Error {
	constructor() {
		super('Guest play is disabled on this server — create an account or sign in to play.');
		this.name = 'GuestPlayDisabled';
	}
}

/** Shared with the server browser's "Playing as" field + Quick Play, so a signed-in
 *  player's account name is the identity they play under. */
const PLAYER_NAME_KEY = 'arc-player-name';

/** Persisted marker for an UNCLEAN identity quarantine (see enterAuthQuarantine):
 *  survives reloads, so a wrong-identity session that could not be provably
 *  cleared can never be silently re-adopted by the next page load. */
const AUTH_QUARANTINE_KEY = 'arc-auth-quarantine';

function readPersistedQuarantine(): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(AUTH_QUARANTINE_KEY) === '1';
	} catch {
		return false;
	}
}

/**
 * Singleton auth store. Class `$state` fields mutated through methods is the Svelte 5
 * idiom for shared cross-module reactive state — no ownership warnings, and it stays
 * reactive even when updated from the layout effect. Every UI-visible mutation flows
 * through `sync()` (driven by the layout `load`), so it's synchronous + reactive; the
 * profile arrives as load DATA, never via a detached async write.
 */
class AuthStore {
	session = $state<Session | null>(null);
	user = $state<User | null>(null);
	profile = $state<Profile | null>(null);

	#client: SupabaseClient | null = null;

	/** FAIL-CLOSED identity quarantine. Set when an OAuth link exchange installed a
	 *  session for the WRONG canonical identity and the local sign-out could not be
	 *  PROVEN clean (auth-js resolves `{error}` — leaving the bad session in
	 *  storage — on offline/5xx logout failures). While set, NO session or user is
	 *  accepted into this store (every `isSignedIn`-derived surface reads signed
	 *  out, blocking all authenticated activity), and every sync retries the
	 *  cleanup — lifted only once the wrong session is VERIFIABLY gone. Persisted
	 *  (localStorage) so a reload cannot resurrect the wrong session first. */
	#quarantined = $state(readPersistedQuarantine());

	get isQuarantined() {
		return this.#quarantined;
	}

	/** True once the layout has handed over the Supabase client (first `sync`).
	 *  Play entry points triggered from `onMount` (the pre-hydration `?action=`
	 *  reload path) can run BEFORE the layout effect — they must await this instead
	 *  of racing #c() into its "still initializing" throw. */
	get isInitialized() {
		return !!this.#client;
	}

	/** Wait (bounded) for the layout to initialize the auth store. Resolves false
	 *  when it never arrives — callers surface a transport/initialization error. */
	async whenInitialized(timeoutMs = 10_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (!this.isInitialized) {
			if (Date.now() > deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return true;
	}

	get isSignedIn() {
		return !!this.user;
	}
	get isAnonymous() {
		return !!this.user?.is_anonymous;
	}
	/** Signed in AND has claimed a real identity (email/oauth). */
	get isPermanent() {
		return !!this.user && !this.user.is_anonymous;
	}
	get displayName() {
		return this.profile?.display_name ?? null;
	}
	get email() {
		return this.user?.email ?? null;
	}

	/** Enter the fail-closed quarantine (see #quarantined) and attempt the cleanup
	 *  immediately. Called by the native OAuth flow when a wrong-identity session
	 *  could not be provably signed out. */
	async enterAuthQuarantine(): Promise<void> {
		this.#quarantined = true;
		if (browser) {
			try {
				localStorage.setItem(AUTH_QUARANTINE_KEY, '1');
			} catch {
				// The in-memory flag still blocks this process; a reload rechecks below.
			}
		}
		// Block everything NOW — cleanup verification comes after.
		this.session = null;
		this.user = null;
		this.profile = null;
		await this.#retryQuarantineCleanup();
	}

	/** One cleanup attempt: the quarantine lifts ONLY on a signOut that RESOLVES
	 *  clean (auth-js's contract for "local storage cleared"). */
	async #retryQuarantineCleanup(): Promise<boolean> {
		const client = this.#client;
		if (!client) return false;
		try {
			const { error } = await client.auth.signOut({ scope: 'local' });
			if (error) return false;
		} catch {
			return false;
		}
		this.#liftQuarantine();
		return true;
	}

	#liftQuarantine(): void {
		if (!this.#quarantined) return;
		this.#quarantined = false;
		if (browser) {
			try {
				localStorage.removeItem(AUTH_QUARANTINE_KEY);
			} catch {
				// Worst case the next load re-enters quarantine and re-lifts.
			}
		}
	}

	/** Driven reactively from the root layout with the freshest SSR→CSR auth state. */
	sync(
		client: SupabaseClient,
		session: Session | null,
		user: User | null,
		profile: Profile | null
	) {
		this.#client = client;
		if (this.#quarantined) {
			// FAIL CLOSED while quarantined: whatever session storage still holds is
			// (or may be) the wrong identity — refuse it wholesale so nothing
			// authenticated can run under it, and retry the cleanup. A sync that
			// arrives with NO session left is the proof the cleanup landed.
			this.session = null;
			this.user = null;
			this.profile = null;
			if (session || user) {
				void this.#retryQuarantineCleanup().then((cleaned) => {
					if (cleaned) void invalidate('supabase:auth');
				});
			} else {
				this.#liftQuarantine();
			}
			return;
		}
		this.session = session;
		this.user = user;
		const nextProfile = user ? profile : null;
		this.profile = nextProfile;
		// Read the PARAM, never `this.profile` — reading the reactive field here would
		// make the calling layout effect depend on it and loop (effect_update_depth).
		if (browser && nextProfile?.display_name) {
			localStorage.setItem(PLAYER_NAME_KEY, nextProfile.display_name);
		}
	}

	#c(): SupabaseClient {
		if (!this.#client) throw new Error('Auth is still initializing — try again in a moment.');
		return this.#client;
	}

	/** Email + password sign-up. `session` is null when the project requires email
	 *  confirmation (the UI then shows a "check your inbox" state). */
	async signUpEmail(email: string, password: string, displayName: string) {
		const { data, error } = await this.#c().auth.signUp({
			email: email.trim(),
			password,
			options: { data: { display_name: displayName.trim() || 'Nameless Spirit' } }
		});
		if (error) throw error;
		if (data.session) await invalidate('supabase:auth');
		return data;
	}

	async signInEmail(email: string, password: string) {
		const { error } = await this.#c().auth.signInWithPassword({ email: email.trim(), password });
		if (error) throw error;
		await invalidate('supabase:auth');
	}

	async signInWithProvider(provider: OAuthProvider) {
		// Native shell: the server /auth/callback cannot exist in a static bundle —
		// run the system-browser + deep-link round trip instead (nativeOAuth.ts).
		if (isNativeShell()) {
			await runNativeOAuth(this.#c().auth, provider, 'signIn', {
				...capacitorOAuthDeps(),
				onQuarantineUnclean: () => this.enterAuthQuarantine()
			});
			await invalidate('supabase:auth');
			return;
		}
		const redirectTo = browser
			? `${location.origin}/auth/callback?next=${encodeURIComponent(location.pathname)}`
			: undefined;
		const { error } = await this.#c().auth.signInWithOAuth({ provider, options: { redirectTo } });
		if (error) throw error;
	}

	/** Instant, frictionless identity. Requires the project's "Anonymous sign-ins"
	 *  toggle to be enabled; until then this throws `anonymous_provider_disabled`. */
	async signInAnon(displayName?: string) {
		const { error } = await this.#c().auth.signInAnonymously({
			options: displayName ? { data: { display_name: displayName.trim() } } : undefined
		});
		if (error) throw error;
		await invalidate('supabase:auth');
	}

	/**
	 * Anonymous-FIRST entry point for a play action. Resolves the durable identity the
	 * player will play (and be attributed) under, creating a guest account on the spot
	 * for a first-time visitor:
	 *  - no session yet  → sign in anonymously with the typed name (real uid + profile),
	 *  - permanent account → their account name is authoritative (typed name ignored),
	 *  - guest account → keep the guest profile name in sync with what they typed.
	 * There is NO cookie-only fallback: every room operation requires a VALIDATED
	 * account identity, so a name without an account cannot authorize anything. If
	 * anonymous sign-ins are DISABLED server-side (a deliberate project setting) this
	 * throws {@link GuestPlayDisabled} — the honest, actionable state ("sign in to
	 * play") — and a TRANSIENT failure (offline, auth outage, aborted request) throws
	 * {@link GuestIdentityUnavailable} so callers surface a transport error instead
	 * of marching into an inevitable 401.
	 */
	async resolvePlayIdentity(typedName: string): Promise<string> {
		const name = (typedName || '').trim().slice(0, 40) || 'Nameless Spirit';
		if (!this.user) {
			try {
				await this.signInAnon(name);
			} catch (err) {
				const code = (err as { code?: string } | null)?.code;
				if (code === 'anonymous_provider_disabled') {
					throw new GuestPlayDisabled();
				}
				throw new GuestIdentityUnavailable(
					'Could not create your guest identity — you appear to be offline or the sign-in service is unavailable. Check your connection and try again.',
					err
				);
			}
			return name;
		}
		if (this.isPermanent) return this.profile?.display_name ?? name;
		if (this.profile && this.profile.display_name !== name) {
			await this.updateDisplayName(name).catch(() => {});
		}
		return name;
	}

	/** Upgrade an anonymous account to a permanent one by attaching email + password to
	 *  the SAME uid — all stats/history/identity carry over. */
	async linkEmailPassword(email: string, password: string) {
		const { error } = await this.#c().auth.updateUser({ email: email.trim(), password });
		if (error) throw error;
		await invalidate('supabase:auth');
	}

	/**
	 * Upgrade an anonymous account by LINKING an OAuth identity to the SAME uid —
	 * the flow the "claim your account" UI promises ("keep all progress"). This is
	 * `auth.linkIdentity`, NOT `signInWithOAuth`: the latter signs into a DIFFERENT
	 * account and silently abandons the guest's uid, stats and memberships.
	 * Requires the project's "manual linking" toggle; surfacing its error verbatim
	 * beats silently rerouting to a different-uid sign-in.
	 *
	 * On the web the provider round-trips through the server `/auth/callback`
	 * (cookie session). In the NATIVE shell that server route cannot exist, so the
	 * claim runs the system-browser + deep-link PKCE round trip (nativeOAuth.ts) —
	 * still `linkIdentity`, still the SAME uid, canonical identity preserved.
	 */
	async linkOAuthProvider(provider: OAuthProvider) {
		if (isNativeShell()) {
			// A wrong-identity session the flow cannot provably sign out escalates to
			// the store's fail-closed quarantine (blocks all authenticated activity
			// until the cleanup verifiably lands).
			await runNativeOAuth(this.#c().auth, provider, 'link', {
				...capacitorOAuthDeps(),
				onQuarantineUnclean: () => this.enterAuthQuarantine()
			});
			await invalidate('supabase:auth');
			return;
		}
		const redirectTo = browser
			? `${location.origin}/auth/callback?next=${encodeURIComponent('/account')}`
			: undefined;
		const { error } = await this.#c().auth.linkIdentity({ provider, options: { redirectTo } });
		if (error) throw error;
	}

	async updateDisplayName(name: string) {
		if (!this.user) throw new Error('Sign in to set a display name.');
		const trimmed = name.trim().slice(0, 40) || 'Nameless Spirit';
		const { error } = await this.#c()
			.from('profiles')
			.update({ display_name: trimmed })
			.eq('id', this.user.id);
		if (error) throw error;
		await this.#c()
			.auth.updateUser({ data: { display_name: trimmed } })
			.catch(() => {});
		if (browser) localStorage.setItem(PLAYER_NAME_KEY, trimmed);
		await invalidate('supabase:auth');
	}

	async sendPasswordReset(email: string) {
		const redirectTo = browser ? `${location.origin}/auth/callback?next=/account` : undefined;
		const { error } = await this.#c().auth.resetPasswordForEmail(email.trim(), { redirectTo });
		if (error) throw error;
	}

	/** Step-up auth: re-verify the current password before a sensitive action, so a
	 *  borrowed/stolen live session can't silently change credentials or delete the
	 *  account. Throws if the password is wrong (or the account has no password). */
	async reauthenticate(currentPassword: string) {
		const email = this.user?.email;
		if (!email) throw new Error('Re-authentication requires an email + password account.');
		const { error } = await this.#c().auth.signInWithPassword({ email, password: currentPassword });
		if (error) throw new Error('Current password is incorrect.');
	}

	/** Change the password of a signed-in (permanent) account. */
	async changePassword(newPassword: string) {
		const { error } = await this.#c().auth.updateUser({ password: newPassword });
		if (error) throw error;
	}

	/** Change the account email. Sends a confirmation to the new address (and, with
	 *  "Secure email change" on, the old one too) — the change applies once confirmed. */
	async changeEmail(newEmail: string) {
		const { error } = await this.#c().auth.updateUser({ email: newEmail.trim() });
		if (error) throw error;
	}

	/** Revoke the session on ALL devices, not just this one. */
	async signOutEverywhere() {
		await this.#c().auth.signOut({ scope: 'global' });
		this.profile = null;
		await invalidate('supabase:auth');
	}

	/** Permanently delete the account + profile (server-side, service-role). Historical
	 *  game rows survive with user_id nulled. Signs out afterward. */
	async deleteAccount() {
		const res = await fetch('/api/account/delete', { method: 'POST' });
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(body?.message ?? `Failed to delete account (status ${res.status})`);
		}
		await this.#c()
			.auth.signOut()
			.catch(() => {});
		this.profile = null;
		await invalidate('supabase:auth');
	}

	async signOut() {
		await this.#c().auth.signOut();
		this.profile = null;
		await invalidate('supabase:auth');
	}
}

export const auth = new AuthStore();
