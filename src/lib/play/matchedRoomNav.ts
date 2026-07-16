/**
 * Matched-room navigation with a CANCELLATION FENCE — the missing last leg of the
 * Quick Play fence discipline (quickPlaySearch.ts retires the SEARCH before its
 * navigation, but the navigation itself used to be a bare `goto` with no owner:
 * once it began, a slow room-route load could be "held" for many seconds and then
 * COMMIT over whatever the player did in the meantime — Back to the menu, a
 * sign-out, a brand-new search).
 *
 * Contract:
 *   - `navigate(roomCode, memberId)` seeds the room membership label, records the
 *     held navigation, and awaits the router `goto`. The room URL CARRIES the
 *     test/dev query modes of the current page (`e2e`, `ws`) — a matched
 *     navigation must not silently drop the harness posture it was driven under.
 *   - `fence()` (back-out, identity change, newer attempt) makes the held
 *     navigation unable to win: the generation bumps (the navigate continuation
 *     goes silent), the seeded member label is rolled back (only while it is
 *     still the live value), and — when `supersede` is set — a fresh
 *     same-URL `replaceState` navigation is issued, which makes the ROUTER abort
 *     the in-flight room load (SvelteKit cancels a pending navigation when a
 *     newer one starts). Even if the held goto commits in the same instant, the
 *     superseding navigation lands the player back where they chose to be.
 *   - A navigation the USER started elsewhere (unmount path) fences with
 *     `supersede: false`: their own navigation already aborts the held one, and
 *     issuing another would hijack it.
 *   - A goto REJECTION after a fence is silent (the fence caused it); an
 *     unfenced rejection rolls the member seed back and rethrows so the page can
 *     surface a recovery path (the room code is still joinable by hand).
 *
 * Framework-free: the page injects `goto`/URL/member-store access, so every
 * ordering is unit-testable without a router.
 */

export interface HeldRoomNav {
	roomCode: string;
	memberId: string | null;
}

export interface MatchedRoomNavDeps {
	/** Router navigation (SvelteKit `goto`). */
	goto(url: string, opts?: { replaceState?: boolean; noScroll?: boolean; keepFocus?: boolean }): Promise<void>;
	/** The CURRENT page location (pathname + search including the leading '?'). */
	currentLocation(): { pathname: string; search: string };
	/** Seed the room membership label; returns the prior value for rollback (an
	 *  OPAQUE token — the navigator only carries it back to restoreMember). */
	seedMember(memberId: string): unknown;
	/** Roll the seed back — only while `expected` is still the live value. */
	restoreMember(prior: unknown, expected: string): void;
}

/** Query params carried from the current page into the matched room URL: the e2e
 *  harness mode and the dev-only ws override. Everything else stays behind. */
const CARRIED_PARAMS = ['e2e', 'ws'] as const;

export function matchedRoomUrl(roomCode: string, currentSearch: string): string {
	const current = new URLSearchParams(
		currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch
	);
	const carried = new URLSearchParams();
	for (const key of CARRIED_PARAMS) {
		if (current.has(key)) carried.set(key, current.get(key) ?? '');
	}
	const qs = carried.toString();
	return `/play/${encodeURIComponent(roomCode)}${qs ? `?${qs}` : ''}`;
}

export class MatchedRoomNavigator {
	private readonly deps: MatchedRoomNavDeps;
	/** Bumped by every navigate/fence — a held continuation from an older
	 *  generation may neither clear state nor report an error. */
	private gen = 0;
	private pending: (HeldRoomNav & { gen: number; prior: unknown }) | null = null;

	constructor(deps: MatchedRoomNavDeps) {
		this.deps = deps;
	}

	/** The held (in-flight) matched-room navigation, if any. */
	get held(): HeldRoomNav | null {
		return this.pending ? { roomCode: this.pending.roomCode, memberId: this.pending.memberId } : null;
	}

	/**
	 * Drive the matched navigation. Resolves 'arrived' when the room committed,
	 * 'fenced' when a fence silenced it (nothing to surface), and THROWS the
	 * router error when the navigation itself failed unfenced (caller surfaces
	 * the manual-join recovery path; the member seed is already rolled back).
	 */
	async navigate(roomCode: string, memberId: string | null): Promise<'arrived' | 'fenced'> {
		const gen = ++this.gen;
		const prior = memberId ? this.deps.seedMember(memberId) : undefined;
		this.pending = { gen, roomCode, memberId, prior };
		const url = matchedRoomUrl(roomCode, this.deps.currentLocation().search);
		try {
			await this.deps.goto(url);
		} catch (err) {
			if (this.gen !== gen) return 'fenced'; // the fence aborted it — already handled
			this.pending = null;
			if (memberId) this.deps.restoreMember(prior, memberId);
			throw err;
		}
		if (this.gen !== gen) return 'fenced';
		this.pending = null;
		return 'arrived';
	}

	/**
	 * Silence and (optionally) abort the held navigation. Returns true when a
	 * held navigation was actually fenced. `supersede` (default true) issues the
	 * same-URL replaceState navigation that makes the router drop the in-flight
	 * room load — pass false ONLY when another navigation is already underway
	 * (the unmount/beforeNavigate path), where a second goto would hijack it.
	 */
	fence(opts: { supersede?: boolean } = {}): boolean {
		const pending = this.pending;
		this.gen += 1;
		if (!pending) return false;
		this.pending = null;
		if (pending.memberId) this.deps.restoreMember(pending.prior, pending.memberId);
		if (opts.supersede !== false) {
			const here = this.deps.currentLocation();
			void this.deps
				.goto(`${here.pathname}${here.search}`, {
					replaceState: true,
					noScroll: true,
					keepFocus: true
				})
				.catch(() => {});
		}
		return true;
	}
}
