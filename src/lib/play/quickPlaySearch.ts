/**
 * Quick Play matchmaking search — a framework-free controller with its OWN
 * canonical identity + search generation, mirroring the play store's fence
 * discipline (playStore.svelte.ts) for the queue lifecycle:
 *
 *   - Every search claims the next SEARCH GENERATION and captures the canonical
 *     Supabase UID it was started for. Every await boundary (identity resolve,
 *     queue poll including its body parse, the poll timer, navigation) re-checks
 *     BOTH before acting: cancel, unmount (destroy), a newer search, or a DURABLE
 *     UID change silences every prior poll result, timer, error and navigation.
 *   - A SAME-UID access-token refresh is NOT an identity change: the captured UID
 *     still matches, so a valid search keeps polling uninterrupted (the next poll
 *     simply carries the fresh token — the deps read it live).
 *   - A matched result may navigate ONLY for the identity + search generation
 *     that initiated it, exactly once; the search retires itself before the
 *     navigation await so even a re-entrant start during `goto` cannot double-act.
 *   - State writes (queued/needed/players/error/needsAuth) are fence-guarded the
 *     same way, so a stale poll's failure can never clobber a newer search's UI.
 *   - ATTEMPT-BOUND SERVER CONTRACT: silencing the client is not enough — the
 *     queue ROW lives server-side, and every cancellation must be able to reach
 *     EXACTLY its own attempt's row, in every ordering. So each search mints an
 *     unguessable ATTEMPT TOKEN (`mqa_…`) BEFORE its first request; every queue
 *     poll carries it (the server binds the row's cancel handle to it), and
 *     every retirement calls `leave(token)` with it. The token needs no session
 *     (possession proves initiation), survives sign-out and durable account
 *     transitions, replays no superseded auth token, and — because a NEWER
 *     search holds a DIFFERENT token — can never cancel newer work. There is NO
 *     current-uid fallback anywhere: the old uid-bound leave could land on the
 *     same account's newer search (the queue row is keyed per user).
 *   - CANCEL-BEFORE-FIRST-RESPONSE / LATE EFFECTS: an explicit cancel can race
 *     the server's own enqueue — the leave may land BEFORE the queue row exists,
 *     and the request that creates it may later SUCCEED (revealing a live row or
 *     even a formed match) or FAIL with no response at all (ambiguous commit).
	 *     The server closes every ordering: the leave TOMBSTONES the attempt token
	 *     before touching rows, and a late enqueue re-checks the tombstone after
	 *     writing and self-cancels — so even the no-response case cannot leave an
	 *     orphaned live search. The client records the first leave's outcome. A
	 *     late response/error causes ONE bounded same-attempt retry only when that
	 *     first leave rejected; a successful acknowledgement permanently closes
	 *     the retry path. A late MATCHED result is likewise fenced from navigation.
	 *     A search that never issued a request retires locally only — no server row
	 *     can exist and its token was never sent.
 *   - SETTLED UI: when a poll/timer discovers its search's identity is gone
 *     (durable change/sign-out) while that search still owns the UI, the state
 *     settles to idle — never a permanent "searching" with no timer behind it.
 *     A matched result's SERVER-TRUTH mode/rated metadata is surfaced through
 *     `state.match` and the `navigate` dep, so mixed verified/guest parties are
 *     labeled the way the server actually formed them.
 *
 * The controller owns NO Svelte state: the page adapts `onChange` into `$state`.
 */

export interface QuickPlayPlayer {
	userId: string;
	displayName: string;
	you: boolean;
	isBot?: boolean;
}

export interface QuickPlayQueueResult {
	status: 'searching' | 'matched';
	roomCode?: string;
	memberId?: string;
	/** Truthful match metadata: rated only for a verified-identity ranked party. */
	rated?: boolean;
	mode?: 'casual' | 'ranked';
	/** The server's echo of this search's cancel handle. A new server echoes the
	 *  client's own attempt token; a LEGACY server (rolling deploy) mints its own
	 *  `mqs_…` handle instead — recorded so retirement still reaches the row. */
	searchId?: string;
	queued: number;
	needed: number;
	players?: QuickPlayPlayer[];
}

/** Thrown by deps.queue when the server no longer accepts the session (401 with a
 *  local identity present) — surfaces as `needsAuth` instead of a generic error. */
export class QuickPlayAuthRequired extends Error {
	constructor(message = 'Your session could not be verified — sign in again to continue.') {
		super(message);
		this.name = 'QuickPlayAuthRequired';
	}
}

/** SERVER-TRUTH metadata of a formed match — surfaced so the UI labels the game
 *  the way the server actually formed it (a verified player whose party includes
 *  a guest plays CASUAL/unrated, whatever the search UI assumed). */
export interface QuickPlayMatchInfo {
	roomCode: string;
	mode: 'casual' | 'ranked';
	rated: boolean;
}

export interface QuickPlaySearchState {
	phase: 'idle' | 'searching';
	queued: number;
	needed: number;
	players: QuickPlayPlayer[];
	error: string | null;
	needsAuth: boolean;
	/** The last match this controller navigated into (server truth), null while
	 *  searching/idle without a match. */
	match: QuickPlayMatchInfo | null;
}

export interface QuickPlaySearchDeps {
	/** Ensure an account exists and return its CANONICAL uid (auth.resolvePlayIdentity
	 *  + auth.user.id). The search is bound to exactly this uid. */
	resolveIdentity(): Promise<string>;
	/** The uid the auth store holds RIGHT NOW (null = signed out). A token refresh
	 *  keeps it; only a durable account change moves it. */
	currentUid(): string | null;
	/** One queue poll (POST /matchmaking/queue), body fully parsed. `attemptId` is
	 *  THIS search's client-minted attempt token — sent with every poll so the
	 *  server binds the row's cancel handle to it before any response exists. */
	queue(attemptId: string): Promise<QuickPlayQueueResult>;
	/** Best-effort leave (POST /matchmaking/leave) — never awaited into state.
	 *  `searchId` is ALWAYS the retiring search's own token (the client-minted
	 *  attempt token, or the server-echoed handle when a legacy server minted its
	 *  own): it retires exactly that attempt's row/tombstone server-side, needs
	 *  no session, and can never touch any other search. */
	leave(searchId: string): Promise<void>;
	/** Navigate into the matched room. Called at most once per search. `match`
	 *  carries the SERVER-TRUTH mode/rated metadata of the formed game. */
	navigate(roomCode: string, memberId: string | null, match: QuickPlayMatchInfo): Promise<void>;
	onChange(state: QuickPlaySearchState): void;
	pollMs?: number;
	schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	cancelTimer?: (t: ReturnType<typeof setTimeout>) => void;
	/** Test seam for the attempt-token mint (default: 32 bytes of Web Crypto). */
	mintAttemptId?: () => string;
}

const DEFAULT_POLL_MS = 2_500;

/** 32 random bytes, base64url, `mqa_`-prefixed — the client-minted, unguessable
 *  per-search cancel capability, structurally disjoint from server handles. */
export function mintQuickPlayAttemptId(): string {
	const cryptoObj = globalThis.crypto;
	if (!cryptoObj?.getRandomValues) {
		// No secure randomness, no capability: fail loudly rather than mint a
		// guessable cancel handle.
		throw new Error('Secure randomness unavailable — cannot start matchmaking.');
	}
	const bytes = new Uint8Array(32);
	cryptoObj.getRandomValues(bytes);
	let bin = '';
	for (const byte of bytes) bin += String.fromCharCode(byte);
	const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	return `mqa_${b64}`;
}

export class QuickPlaySearch {
	private readonly deps: QuickPlaySearchDeps;
	private readonly pollMs: number;
	private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly cancelTimer: (t: ReturnType<typeof setTimeout>) => void;
	private readonly mintAttemptId: () => string;

	/** Monotonic search generation — bumped by start/cancel/destroy/match, so any
	 *  prior search's polls, timers, errors and navigations are fenced out. */
	private searchSeq = 0;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	/** THIS client's attempt token per search generation — minted BEFORE the first
	 *  request, so a cancellation contract exists before any response delivery. */
	private readonly attempts = new Map<number, string>();
	/** Server-echoed cancel handle per search generation. Normally identical to
	 *  the attempt token; differs only under a LEGACY server that minted its own
	 *  handle — in which case the echo is the one that actually reaches the row. */
	private readonly handles = new Map<number, string>();
	/** Search generations that sent (or are provably about to send) at least one
	 *  queue request. A search that never issued one has NO server row and its
	 *  token was never transmitted — retiring it is purely local. */
	private readonly issued = new Set<number>();
	/** Search generations whose SERVER row has been settled — retired via leave,
	 *  or handed off to a matched room. Exactly-once guard for retirement. */
	private readonly settled = new Set<number>();
	/** Outcome of a retiring search's first leave. A late response/error is not by
	 *  itself a reason to send again: the attempt tombstone makes a successful
	 *  acknowledgement authoritative even when it preceded enqueue. Only a
	 *  rejected first leave plus a surfaced late effect earns one bounded retry.
	 *  The token is refreshed from a legacy server echo before that retry. */
	private readonly retirements = new Map<
		number,
		{
			token: string;
			firstFailed: boolean;
			lateObserved: boolean;
			retryIssued: boolean;
		}
	>();

	private state: QuickPlaySearchState = {
		phase: 'idle',
		queued: 0,
		needed: 0,
		players: [],
		error: null,
		needsAuth: false,
		match: null
	};

	constructor(deps: QuickPlaySearchDeps) {
		this.deps = deps;
		this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
		this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancelTimer = deps.cancelTimer ?? ((t) => clearTimeout(t));
		this.mintAttemptId = deps.mintAttemptId ?? mintQuickPlayAttemptId;
	}

	get snapshot(): QuickPlaySearchState {
		return { ...this.state, players: [...this.state.players] };
	}

	/** True while `search` is still the live search AND the canonical identity it
	 *  was started for is still the signed-in account. THE fence: consulted after
	 *  every await and inside every timer/catch before touching anything. */
	private current(search: number, uid: string): boolean {
		return (
			!this.destroyed &&
			search === this.searchSeq &&
			this.state.phase === 'searching' &&
			this.deps.currentUid() === uid
		);
	}

	private emit(patch: Partial<QuickPlaySearchState>): void {
		this.state = { ...this.state, ...patch };
		this.deps.onChange(this.snapshot);
	}

	private stopTimer(): void {
		if (this.pollTimer != null) {
			this.cancelTimer(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/** Begin a NEW search (superseding any prior one). Resolves when the search is
	 *  live (polling), a match navigated, or the attempt failed. */
	async start(): Promise<void> {
		if (this.destroyed || this.state.phase === 'searching') return;
		const search = ++this.searchSeq;
		// The attempt token exists BEFORE anything is sent: whatever happens to the
		// first request (cancel racing it, failure with no response, late success),
		// the retirement contract for exactly this attempt is already in hand.
		try {
			this.attempts.set(search, this.mintAttemptId());
		} catch (err) {
			this.emit({
				phase: 'idle',
				error: err instanceof Error ? err.message : 'Could not start matchmaking.'
			});
			return;
		}
		this.stopTimer();
		this.emit({
			phase: 'searching',
			queued: 0,
			needed: 0,
			players: [],
			error: null,
			needsAuth: false,
			match: null
		});
		let uid: string;
		try {
			uid = await this.deps.resolveIdentity();
		} catch (err) {
			// Identity never materialized — fail THIS search only (if still live).
			// No request was ever sent, so there is nothing server-side to retire.
			if (!this.destroyed && search === this.searchSeq) {
				this.emit({
					phase: 'idle',
					error: err instanceof Error ? err.message : 'Could not start matchmaking.'
				});
			}
			return;
		}
		if (this.destroyed || search !== this.searchSeq || this.deps.currentUid() !== uid) {
			// The account changed (or the search was superseded) DURING the identity
			// resolve: never poll as the wrong identity — and if this search still
			// owns the UI, settle it out of "searching" (no timer will ever run for
			// it). No request was issued, so there is nothing server-side to retire.
			this.settleIfIdentityLost(search, uid);
			return;
		}
		await this.poll(search, uid);
	}

	/** The retiring search's own cancel capability: the server-echoed handle when
	 *  one was learned (identical to the attempt token except under a legacy
	 *  server), else the attempt token itself — known before any response. */
	private tokenFor(search: number): string | null {
		return this.handles.get(search) ?? this.attempts.get(search) ?? null;
	}

	/** Retire a search's SERVER row exactly once, ATTEMPT-BOUND: leave(token)
	 *  needs no session and can only ever reach this attempt's own row/tombstone —
	 *  never another search's (in particular never a NEWER same-account search;
	 *  the old current-uid fallback could). Used by explicit cancel/destroy, the
	 *  stale poll/timer paths, and same-identity poll failure alike. A search
	 *  that never issued a request settles locally: no row can exist, and its
	 *  never-transmitted token has nothing to tombstone. */
	private retire(search: number): void {
		if (this.settled.has(search)) return;
		this.settled.add(search);
		if (!this.issued.has(search)) return;
		const token = this.tokenFor(search);
		if (!token) return;
		const retirement = {
			token,
			firstFailed: false,
			lateObserved: false,
			retryIssued: false
		};
		this.retirements.set(search, retirement);
		void this.deps.leave(token).then(
			() => {
				// A successful tombstone acknowledgement closes this retirement even
				// if the queue response arrives later.
				this.retirements.delete(search);
			},
			() => {
				retirement.firstFailed = true;
				this.maybeRetryLeave(retirement);
			}
		);
	}

	/** Send at most one same-attempt retry, and only after BOTH the first leave
	 *  failed and a late response/error proved that the in-flight queue operation
	 *  has surfaced. Either ordering is supported: leave rejection may arrive
	 *  before or after the held queue response. */
	private maybeRetryLeave(retirement: {
		token: string;
		firstFailed: boolean;
		lateObserved: boolean;
		retryIssued: boolean;
	}): void {
		if (!retirement.firstFailed || !retirement.lateObserved || retirement.retryIssued) return;
		retirement.retryIssued = true;
		void this.deps.leave(retirement.token).catch(() => {});
	}

	/** A late response/error just surfaced for an already-settled search. Record
	 *  its latest attempt-bound handle, then retry only if the original leave
	 *  actually failed. A healthy acknowledged leave remains exactly once. */
	private retireLate(search: number): void {
		const retirement = this.retirements.get(search);
		if (!retirement) return;
		retirement.lateObserved = true;
		retirement.token = this.tokenFor(search) ?? retirement.token;
		this.maybeRetryLeave(retirement);
	}

	/** Retirement entry point for every stale poll/timer/error path. */
	private retireStale(search: number): void {
		if (!this.settled.has(search)) this.retire(search);
		this.retireLate(search);
	}

	/** A poll/timer discovered its search's IDENTITY is gone (durable account
	 *  change or sign-out) while that search still owns the UI: with no timer left
	 *  and every future result fenced, the state would show "searching" forever.
	 *  Settle it to idle. Only the LIVE generation may do this — a superseded
	 *  search's discovery must not touch the newer search's UI. */
	private settleIfIdentityLost(search: number, uid: string): void {
		if (this.destroyed) return;
		if (search !== this.searchSeq) return;
		if (this.state.phase !== 'searching') return;
		if (this.deps.currentUid() === uid) return;
		this.searchSeq += 1;
		this.stopTimer();
		this.emit({ phase: 'idle' });
	}

	/** Cancel the live search: nothing started before this point may act again. */
	cancel(): void {
		const search = this.searchSeq;
		this.searchSeq += 1;
		this.stopTimer();
		if (this.state.phase !== 'idle') this.emit({ phase: 'idle' });
		this.retire(search);
	}

	/** Unmount teardown: like cancel, but permanent — even a later start() is refused. */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		const search = this.searchSeq;
		const wasSearching = this.state.phase === 'searching';
		this.searchSeq += 1;
		this.stopTimer();
		this.state = { ...this.state, phase: 'idle' };
		if (wasSearching) this.retire(search);
	}

	private async poll(search: number, uid: string): Promise<void> {
		if (!this.current(search, uid)) {
			// A timer firing for a superseded search: the client is already silent,
			// and the server row is retired through the search's own token. retire()
			// only: a timer wake-up is not a server response and cannot establish the
			// late-effect half of a bounded failed-leave retry. If the search itself
			// is still the live one and only
			// its IDENTITY vanished, the UI settles to idle here as well (nothing
			// else will ever run for it).
			this.retire(search);
			this.settleIfIdentityLost(search, uid);
			return;
		}
		const attemptId = this.attempts.get(search);
		if (!attemptId) return; // unreachable: start() minted it before polling
		// From this point a server row may exist — retirement must go server-side.
		this.issued.add(search);
		try {
			const result = await this.deps.queue(attemptId);
			// Record the server's cancel-handle echo FIRST, whatever the freshness:
			// normally it IS the attempt token; under a legacy server it is the only
			// handle that actually reaches the row.
			if (typeof result.searchId === 'string' && result.searchId.length > 0) {
				this.handles.set(search, result.searchId);
			}
			// The poll (headers AND parsed body) belongs to `search` for `uid` — if
			// the player cancelled, unmounted, restarted, or changed account while it
			// was in flight, NOTHING of it applies: no counts, no navigation, no
			// error — and the server row is retired through this search's own token
			// (a matched row's membership is retired server-side, so no abandoned
			// match survives the transition).
			if (!this.current(search, uid)) {
				this.retireStale(search);
				this.settleIfIdentityLost(search, uid);
				return;
			}
			this.emit({
				queued: result.queued,
				needed: result.needed,
				players: result.players ?? []
			});
			if (result.status === 'matched' && result.roomCode) {
				// Retire the search BEFORE the navigation await: the match may navigate
				// exactly once, only for the identity/search that initiated it, and no
				// residual timer/poll may act during or after the route change. The
				// SERVER row hands off to the room — settled locally, NEVER leave()d.
				// `match` carries the SERVER-TRUTH mode/rated verdict (a verified
				// player whose party includes a guest formed a CASUAL game, whatever
				// the searching UI assumed).
				const match: QuickPlayMatchInfo = {
					roomCode: result.roomCode,
					mode: result.mode === 'ranked' ? 'ranked' : 'casual',
					rated: result.rated === true
				};
				this.settled.add(search);
				this.searchSeq += 1;
				this.stopTimer();
				this.emit({ phase: 'idle', match });
				await this.deps.navigate(result.roomCode, result.memberId ?? null, match);
				return;
			}
			if (!this.current(search, uid)) {
				this.retireStale(search);
				this.settleIfIdentityLost(search, uid);
				return;
			}
			this.pollTimer = this.schedule(() => {
				this.pollTimer = null;
				void this.poll(search, uid);
			}, this.pollMs);
		} catch (err) {
			// A stale poll's failure must not clobber a newer search's state — but its
			// server row is still retired through the search's own token (including
			// the bounded failed-leave retry for a search settled before this first
			// response: even a FAILURE with no body may have committed server-side,
			// and the token/tombstone contract reaches that effect without touching
			// any newer search).
			if (!this.current(search, uid)) {
				this.retireStale(search);
				this.settleIfIdentityLost(search, uid);
				return;
			}
			this.searchSeq += 1; // this search is over
			this.stopTimer();
			// Same-identity failure: best-effort retire the row too (a transient poll
			// failure must not leave the abandoned row free to form a match).
			this.retire(search);
			// The queue error itself is the surfaced late/ambiguous outcome. If the
			// first leave rejects too, it therefore earns one bounded retry.
			this.retireLate(search);
			if (err instanceof QuickPlayAuthRequired) {
				this.emit({ phase: 'idle', needsAuth: true, error: null });
			} else {
				this.emit({
					phase: 'idle',
					error: err instanceof Error ? err.message : 'Matchmaking failed — try again.'
				});
			}
		}
	}
}
