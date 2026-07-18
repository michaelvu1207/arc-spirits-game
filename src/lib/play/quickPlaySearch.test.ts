/**
 * Quick Play search fence — adversarial races for the canonical-identity +
 * search-generation guard in quickPlaySearch.ts: cancel, unmount, a NEWER search,
 * a durable UID change and completed navigation must silence every prior poll
 * result (headers + body), timer, error and navigation; a same-UID access-token
 * refresh must NOT reset or cancel a valid search; a matched result may navigate
 * only for the exact identity/search that initiated it, exactly once.
 *
 * ATTEMPT-BOUND CANCELLATION (the generation-safe server contract): every search
 * mints its own unguessable attempt token BEFORE the first request; every queue
 * poll carries it and every retirement (explicit cancel, destroy, stale paths,
 * failures, late effects) leaves through it. There is NO uid-bound fallback
 * anywhere — the suite proves that no retirement of search N can ever carry
 * search N+1's token (the failure mode that used to cancel a newer same-account
 * search), across late success, late failure, sign-out, durable account change
 * and cancel-before-first-response, each exactly once.
 */
import { describe, expect, test } from 'vitest';
import {
	QuickPlayAuthRequired,
	QuickPlaySearch,
	mintQuickPlayAttemptId,
	type QuickPlayMatchInfo,
	type QuickPlayQueueResult,
	type QuickPlaySearchState
} from './quickPlaySearch';

interface HarnessOpts {
	uid?: string;
	resolveDelay?: boolean;
	/** Hold leave promises so tests can order acknowledgement/failure against a
	 *  late queue response deterministically. */
	leaveDelay?: boolean;
}

function harness(opts: HarnessOpts = {}) {
	const state = {
		uid: (opts.uid ?? 'uid-1') as string | null,
		token: 'access-token-1' // rotated freely; NEVER part of the fence
	};
	const queueCalls: {
		attemptId: string;
		resolve: (r: QuickPlayQueueResult) => void;
		reject: (e: Error) => void;
	}[] = [];
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const navigations: { roomCode: string; memberId: string | null }[] = [];
	/** The SERVER-TRUTH match metadata each navigation carried. */
	const navMeta: QuickPlayMatchInfo[] = [];
	/** Every leave call, with the ATTEMPT TOKEN / handle it carried. */
	const leaves: string[] = [];
	const leaveCalls: {
		searchId: string;
		resolve: () => void;
		reject: (error: Error) => void;
	}[] = [];
	const snapshots: QuickPlaySearchState[] = [];
	let resolveIdentityGate: (() => void) | null = null;
	let attemptCounter = 0;

	const search = new QuickPlaySearch({
		resolveIdentity: () => {
			// The uid this resolve call is FOR is the one signed in when it began.
			const captured = state.uid as string;
			if (!opts.resolveDelay) return Promise.resolve(captured);
			return new Promise((resolve) => {
				resolveIdentityGate = () => resolve(captured);
			});
		},
		currentUid: () => state.uid,
		queue: (attemptId) =>
			new Promise<QuickPlayQueueResult>((resolve, reject) => {
				queueCalls.push({ attemptId, resolve, reject });
			}),
		leave: (searchId) => {
			leaves.push(searchId);
			if (!opts.leaveDelay) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				leaveCalls.push({ searchId, resolve, reject });
			});
		},
		navigate: (roomCode, memberId, match) => {
			navigations.push({ roomCode, memberId });
			navMeta.push(match);
			return Promise.resolve();
		},
		onChange: (snapshot) => snapshots.push(snapshot),
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		cancelTimer: (t) => {
			(t as unknown as { cancelled: boolean }).cancelled = true;
		},
		// Deterministic attempt tokens: mqa_attempt-1, mqa_attempt-2, … in the
		// order searches start. The suite asserts which ATTEMPT each leave targets.
		mintAttemptId: () => `mqa_attempt-${++attemptCounter}`
	});

	return {
		search,
		state,
		queueCalls,
		timers,
		navigations,
		navMeta,
		leaves,
		leaveCalls,
		snapshots,
		releaseIdentity: () => resolveIdentityGate?.(),
		resolveLeave(index: number) {
			const call = leaveCalls[index];
			if (!call) throw new Error(`no leave call at index ${index}`);
			call.resolve();
		},
		rejectLeave(index: number, error = new Error('leave failed')) {
			const call = leaveCalls[index];
			if (!call) throw new Error(`no leave call at index ${index}`);
			call.reject(error);
		},
		fireDueTimer() {
			const timer = timers.find((t) => !t.cancelled && !(t as { fired?: boolean }).fired);
			if (!timer) throw new Error('no live timer to fire');
			(timer as { fired?: boolean }).fired = true;
			timer.fn();
		},
		last: () => snapshots.at(-1)!
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const searching = (queued: number, needed = 4, searchId?: string): QuickPlayQueueResult => ({
	status: 'searching',
	queued,
	needed,
	...(searchId ? { searchId } : {}),
	players: [{ userId: 'uid-1', displayName: 'Me', you: true }]
});

const matched = (roomCode: string, searchId?: string): QuickPlayQueueResult => ({
	status: 'matched',
	roomCode,
	memberId: 'm-mine',
	queued: 4,
	needed: 4,
	...(searchId ? { searchId } : {}),
	players: [
		{ userId: 'uid-1', displayName: 'Me', you: true },
		{ userId: 'b1', displayName: 'Mia', you: false, isBot: true }
	]
});

describe('QuickPlaySearch fence', () => {
	test('ATTEMPT CONTRACT: every poll carries this search’s own pre-minted token; a new search mints a NEW one', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		expect(h.queueCalls.map((c) => c.attemptId)).toEqual(['mqa_attempt-1']);
		h.queueCalls[0].resolve(searching(1, 4, 'mqa_attempt-1'));
		await flush();
		h.fireDueTimer();
		await flush();
		// Same search, same token on every poll.
		expect(h.queueCalls.map((c) => c.attemptId)).toEqual(['mqa_attempt-1', 'mqa_attempt-1']);

		h.search.cancel();
		void h.search.start();
		await flush();
		// The next search is a DIFFERENT attempt: its own token, never the old one.
		expect(h.queueCalls.at(-1)?.attemptId).toBe('mqa_attempt-2');
	});

	test('the default mint produces well-formed, unique, high-entropy tokens', () => {
		const a = mintQuickPlayAttemptId();
		const b = mintQuickPlayAttemptId();
		expect(a).toMatch(/^mqa_[A-Za-z0-9_-]{43}$/);
		expect(b).toMatch(/^mqa_[A-Za-z0-9_-]{43}$/);
		expect(a).not.toBe(b);
	});

	test('happy path: poll → matched navigates exactly once for the initiating search, and retires the search first', async () => {
		const h = harness();
		await Promise.race([h.search.start(), flush()]);
		await flush();
		expect(h.last().phase).toBe('searching');
		expect(h.queueCalls).toHaveLength(1);

		h.queueCalls[0].resolve(searching(2));
		await flush();
		expect(h.last().queued).toBe(2);
		h.fireDueTimer();
		await flush();
		expect(h.queueCalls).toHaveLength(2);

		h.queueCalls[1].resolve(matched('ROOM77'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'ROOM77', memberId: 'm-mine' }]);
		expect(h.last().phase).toBe('idle');
		// No timer survives the match — nothing can double-navigate.
		expect(h.timers.every((t) => t.cancelled || (t as { fired?: boolean }).fired)).toBe(true);
	});

	test('CANCEL: a poll result (even a match) landing after cancel acts on nothing', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		expect(h.queueCalls).toHaveLength(1);

		h.search.cancel();
		expect(h.last().phase).toBe('idle');
		// The retirement is the search's OWN token — known before any response.
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		// The in-flight poll (already authorized, body still parsing) now matches.
		h.queueCalls[0].resolve(matched('GHOST1'));
		await flush();
		expect(h.navigations).toEqual([]); // no navigation for a cancelled search
		expect(h.last().phase).toBe('idle');
		expect(h.last().queued).toBe(0); // counts not repopulated either
	});

	test("NEWER SEARCH: the previous search's match cannot navigate; only the new search's can", async () => {
		const h = harness();
		void h.search.start();
		await flush();
		const firstPoll = h.queueCalls[0];

		h.search.cancel();
		void h.search.start();
		await flush();
		expect(h.queueCalls).toHaveLength(2);

		// Old search's poll settles with a match — it belongs to a retired search.
		firstPoll.resolve(matched('OLDROOM'));
		await flush();
		expect(h.navigations).toEqual([]);
		expect(h.last().phase).toBe('searching'); // the new search is untouched

		// The NEW search's match navigates.
		h.queueCalls[1].resolve(matched('NEWROOM'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'NEWROOM', memberId: 'm-mine' }]);
	});

	test('NO UID-WIDE FALLBACK — a late queue failure after an acknowledged leave does not send twice or touch a newer same-UID search', async () => {
		const h = harness();
		void h.search.start(); // search 1, attempt-1
		await flush();
		const firstPoll = h.queueCalls[0];

		h.search.cancel(); // cancel BEFORE the first response
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		void h.search.start(); // search 2, attempt-2 — SAME uid, immediately
		await flush();
		expect(h.queueCalls).toHaveLength(2);
		expect(h.queueCalls[1].attemptId).toBe('mqa_attempt-2');

		// Search 1's request now FAILS without ever returning a handle. The first
		// leave was acknowledged, so its attempt tombstone is authoritative and a
		// late queue failure must not manufacture a duplicate leave.
		firstPoll.reject(new Error('response lost'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.leaves).not.toContain('mqa_attempt-2');
		expect(h.last().phase).toBe('searching'); // search 2 untouched
		expect(h.last().error).toBeNull();

		// …and search 2 still completes normally.
		h.queueCalls[1].resolve(matched('ROOM2', 'mqa_attempt-2'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'ROOM2', memberId: 'm-mine' }]);
		expect(h.leaves).toEqual(['mqa_attempt-1']); // matched row hands off
	});

	test('NO UID-WIDE FALLBACK — a late successful/matched response after acknowledged cancel sends no duplicate and leaves the newer search alone', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		const firstPoll = h.queueCalls[0];

		h.search.cancel();
		void h.search.start();
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		// Search 1's response arrives LATE and even reveals a formed match: the
		// membership is covered by the acknowledged attempt-1 tombstone — never
		// navigated, never sending again, never touching attempt-2.
		firstPoll.resolve(matched('GHOSTROOM', 'mqa_attempt-1'));
		await flush();
		expect(h.navigations).toEqual([]);
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.leaves).not.toContain('mqa_attempt-2');
		expect(h.last().phase).toBe('searching'); // search 2 unaffected
	});

	test('SIGN-OUT + immediate restart as a NEW account: search 1’s late failure retires only its own token — the new account’s search is untouchable', async () => {
		const h = harness();
		void h.search.start(); // uid-1, attempt-1
		await flush();
		const firstPoll = h.queueCalls[0];

		h.state.uid = null; // signed out entirely while the first request is in flight
		h.search.cancel();
		// Token-bound leave: needs no session, replays no superseded auth token.
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		h.state.uid = 'uid-2'; // a different account signs in and searches at once
		void h.search.start();
		await flush();
		expect(h.queueCalls[1].attemptId).toBe('mqa_attempt-2');

		firstPoll.reject(new Error('response lost'));
		await flush();
		// The acknowledged attempt-1 leave is final; the late failure sends nothing.
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.last().phase).toBe('searching'); // uid-2's search unaffected
	});

	test('UNMOUNT (destroy): pending polls/timers/errors are permanently silenced and a later start is refused', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve(searching(1));
		await flush();
		expect(h.timers).toHaveLength(1);

		h.search.destroy();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.timers[0].cancelled).toBe(true);

		// A queued timer callback that somehow still fires does nothing more: the
		// retirement already happened and a timer wake-up is not a late response.
		h.timers[0].fn();
		await flush();
		expect(h.queueCalls).toHaveLength(1); // no new poll
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		await h.search.start(); // destroyed controller refuses to restart
		expect(h.queueCalls).toHaveLength(1);
		expect(h.navigations).toEqual([]);
	});

	test('DURABLE UID CHANGE: a held poll for the previous account neither updates state nor navigates nor reschedules', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		expect(h.queueCalls).toHaveLength(1);

		h.state.uid = 'uid-2'; // account switched mid-poll
		h.queueCalls[0].resolve(matched('WRONGID'));
		await flush();
		expect(h.navigations).toEqual([]);
		expect(h.queueCalls).toHaveLength(1); // no reschedule for the dead identity
		expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
		// …and the UI SETTLES: never a permanent "searching" with no timer behind it.
		expect(h.last().phase).toBe('idle');
		// The dead search's server row is retired through its OWN token — a leave
		// that can never reach uid-2's queue state.
		expect(h.leaves).toEqual(['mqa_attempt-1']);
	});

	test('UID change during the IDENTITY RESOLVE itself: the search never starts polling — and settles out of "searching"', async () => {
		const h = harness({ resolveDelay: true });
		void h.search.start();
		await flush();
		expect(h.last().phase).toBe('searching');
		h.state.uid = 'uid-2'; // switched while resolveIdentity was in flight
		h.releaseIdentity(); // resolves with the OLD uid
		await flush();
		expect(h.queueCalls).toHaveLength(0); // never polled as the wrong identity
		expect(h.leaves).toEqual([]); // no request ever issued — nothing to retire
		// The UI must not stay "searching" forever with nothing behind it.
		expect(h.last().phase).toBe('idle');
	});

	test('SAME-UID TOKEN REFRESH: rotating the access token neither cancels the search nor blocks its match', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		h.state.token = 'access-token-2'; // refresh: same uid, new token
		h.queueCalls[0].resolve(searching(3));
		await flush();
		expect(h.last().phase).toBe('searching');
		expect(h.last().queued).toBe(3); // the poll applied normally

		h.fireDueTimer();
		await flush();
		h.state.token = 'access-token-3'; // and again mid-poll
		h.queueCalls[1].resolve(matched('TOKROOM'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'TOKROOM', memberId: 'm-mine' }]);
	});

	test("STALE ERROR: a cancelled search's failure cannot clobber the new search's clean state", async () => {
		const h = harness();
		void h.search.start();
		await flush();
		const firstPoll = h.queueCalls[0];

		h.search.cancel();
		void h.search.start();
		await flush();

		firstPoll.reject(new Error('old search exploded'));
		await flush();
		expect(h.last().phase).toBe('searching'); // new search alive
		expect(h.last().error).toBeNull(); // and unpolluted
	});

	test('AUTH REQUIRED: a 401-with-identity poll surfaces needsAuth (no generic error), for the live search only', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].reject(new QuickPlayAuthRequired());
		await flush();
		expect(h.last().phase).toBe('idle');
		expect(h.last().needsAuth).toBe(true);
		expect(h.last().error).toBeNull();
	});

	test('SERVER RETIREMENT — cross-tab UID change while the queue request is HELD: the stale response retires the row via the echoed handle, exactly once, and applies nothing', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		expect(h.queueCalls).toHaveLength(1);

		// Another tab signs into a different durable account while the poll is held.
		h.state.uid = 'uid-2';
		h.queueCalls[0].resolve(searching(2, 4, 'handle-A'));
		await flush();

		// Client silent…
		expect(h.last().queued).toBe(0);
		expect(h.navigations).toEqual([]);
		expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
		// …and the SERVER row retired through the search's own handle (the server's
		// echo — a LEGACY server may have minted it) — never anything uid-bound
		// that would hit uid-2's own queue state.
		expect(h.leaves).toEqual(['handle-A']);
	});

	test('SERVER RETIREMENT — FORMATION WINS the race: a stale matched result retires the handle (server unwinds the membership) and never navigates', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		h.state.uid = 'uid-2'; // durable transition while the poll is in flight
		h.queueCalls[0].resolve(matched('GHOSTRM', 'handle-B'));
		await flush();

		expect(h.navigations).toEqual([]); // the old identity's match is never entered
		expect(h.leaves).toEqual(['handle-B']); // …and its formed membership is retired
	});

	test('SERVER RETIREMENT — a pending TIMER firing after the UID change retires via the handle learned from the last good poll', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve(searching(2, 4, 'handle-C')); // healthy poll → handle known
		await flush();
		expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);

		h.state.uid = 'uid-2'; // transition with NO request in flight
		h.fireDueTimer(); // the scheduled poll wakes up under the wrong identity
		await flush();

		expect(h.queueCalls).toHaveLength(1); // it never polls as the wrong identity…
		expect(h.leaves).toEqual(['handle-C']); // …but retires the initiating row
		expect(h.last().phase).toBe('idle'); // and the stuck "searching" UI settles
	});

	test('CANCEL BEFORE FIRST RESPONSE: an acknowledged pre-minted-token leave remains exactly once after the late response', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		// Explicit cancel with the queue request still in flight: the attempt token
		// (minted before the request) retires the row/tombstones the attempt — it
		// may still race AHEAD of the server's own enqueue.
		h.search.cancel();
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		// The late response cannot invalidate the acknowledged tombstone, so it
		// produces no second leave.
		h.queueCalls[0].resolve(searching(3, 4, 'mqa_attempt-1'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.last().phase).toBe('idle');
		expect(h.last().queued).toBe(0); // nothing of the stale body applied

		// Nothing left to fire — and even a rogue timer callback retires nothing more.
		for (const t of h.timers) t.fn();
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
	});

	test('HELD LEAVE ACK: late searching and matched responses never duplicate a successful cancellation', async () => {
		for (const result of [
			searching(3, 4, 'mqa_attempt-1'),
			matched('GHOSTM', 'mqa_attempt-1')
		]) {
			const h = harness({ leaveDelay: true });
			void h.search.start();
			await flush();
			h.search.cancel();
			expect(h.leaves).toEqual(['mqa_attempt-1']);

			// Establish the healthy acknowledgement before releasing the held queue
			// response — this is the browser journey race that previously sent twice.
			h.resolveLeave(0);
			await flush();
			h.queueCalls[0].resolve(result);
			await flush();

			expect(h.leaves).toEqual(['mqa_attempt-1']);
			expect(h.navigations).toEqual([]);
			expect(h.last().phase).toBe('idle');
		}
	});

	test('FAILED LEAVE: a surfaced late response earns one bounded retry with the same old attempt and cannot affect a newer search', async () => {
		const h = harness({ leaveDelay: true });
		void h.search.start();
		await flush();
		const firstPoll = h.queueCalls[0];

		h.search.cancel();
		void h.search.start();
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		expect(h.queueCalls[1].attemptId).toBe('mqa_attempt-2');

		// The first leave genuinely failed, but no retry is sent until the held
		// queue operation surfaces. That lets a legacy echo refine the handle while
		// keeping the retry bounded and attempt-local.
		h.rejectLeave(0);
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
		firstPoll.resolve(searching(2, 4, 'mqa_attempt-1'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1', 'mqa_attempt-1']);
		expect(h.leaveCalls).toHaveLength(2);
		h.resolveLeave(1);
		await flush();

		// Additional stale callbacks cannot spend another retry, and search 2 is
		// still the live generation.
		firstPoll.resolve(matched('IGNORED', 'mqa_attempt-1'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1', 'mqa_attempt-1']);
		expect(h.last().phase).toBe('searching');
		expect(h.last().error).toBeNull();
	});

	test('FAILED LEAVE ordering: a late response observed while leave is pending retries once if that leave later rejects', async () => {
		const h = harness({ leaveDelay: true });
		void h.search.start();
		await flush();
		h.search.cancel();
		h.queueCalls[0].resolve(searching(2, 4, 'mqa_attempt-1'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		h.rejectLeave(0);
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1', 'mqa_attempt-1']);
		h.resolveLeave(1);
		await flush();
		expect(h.leaves).toHaveLength(2);
	});

	test('CANCEL before the first response and FORMATION already won — the late matched result retires the formed membership via its handle, never navigates', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		h.search.cancel();
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		h.queueCalls[0].resolve(matched('GHOSTM', 'handle-M'));
		await flush();
		expect(h.navigations).toEqual([]); // the cancelled search never enters the room
		// The acknowledged attempt tombstone remains final even if a legacy-shaped
		// handle is echoed later.
		expect(h.leaves).toEqual(['mqa_attempt-1']);
	});

	test('SIGN-OUT before the first response: the attempt token retires the row with NO session and NO superseded auth token', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		h.state.uid = null; // signed out entirely while the first request is in flight
		h.search.cancel();
		// The token-bound leave goes out anyway — the endpoint's handle path needs
		// no session, and nothing uid-bound is (or could be) sent.
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		h.queueCalls[0].resolve(searching(2, 4, 'handle-S'));
		await flush();
		// The acknowledged session-free leave remains exactly once.
		expect(h.leaves).toEqual(['mqa_attempt-1']);
	});

	test('EXPLICIT CANCEL after a durable UID change leaves ONLY through the old search’s own token — it can never cancel the new account’s search', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		h.state.uid = 'uid-2'; // another account signed in while the poll is held
		h.search.cancel(); // the user cancels the (dead) search explicitly
		// Attempt-bound, not uid-bound: uid-2's queue state is untouchable.
		expect(h.leaves).toEqual(['mqa_attempt-1']);

		// The late response cannot cause a duplicate after the acknowledged leave.
		h.queueCalls[0].resolve(searching(2, 4, 'handle-X'));
		await flush();
		expect(h.leaves).toEqual(['mqa_attempt-1']);
	});

	test('EXPLICIT CANCEL prefers the server-echoed handle (legacy server compatibility)', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve(searching(1, 4, 'handle-E'));
		await flush();

		h.search.cancel();
		expect(h.leaves).toEqual(['handle-E']);
		expect(h.timers.every((t) => t.cancelled)).toBe(true);

		// A cancelled timer's callback somehow firing anyway adds nothing.
		h.timers[0].fn();
		await flush();
		expect(h.leaves).toEqual(['handle-E']);
		expect(h.queueCalls).toHaveLength(1);
	});

	test('NAVIGATION FAILURE after a match: the handed-off row is NEVER retired (no leave), and no stale error clobbers the idle state', async () => {
		const h = harness();
		const failing = new QuickPlaySearch({
			resolveIdentity: () => Promise.resolve('uid-1'),
			currentUid: () => 'uid-1',
			queue: (attemptId) =>
				new Promise<QuickPlayQueueResult>((resolve, reject) => {
					h.queueCalls.push({ attemptId, resolve, reject });
				}),
			leave: (searchId) => {
				h.leaves.push(searchId);
				return Promise.resolve();
			},
			// The page-level dep handles goto failure itself (member-seed rollback +
			// recovery message); if it nevertheless REJECTS, the controller must not
			// misread that as a search failure — and above all must never leave() the
			// matched row (the seat belongs to the room now).
			navigate: () => Promise.reject(new Error('router exploded')),
			onChange: (s) => h.snapshots.push(s),
			mintAttemptId: () => 'mqa_nav-fail'
		});
		void failing.start();
		await flush();
		h.queueCalls[0].resolve(matched('NAVROOM', 'mqa_nav-fail'));
		await flush();
		expect(h.leaves).toEqual([]); // the matched row hands off — NEVER retired
		expect(h.last().phase).toBe('idle');
		expect(h.last().error).toBeNull(); // no stale error over the idle/match state
		expect(h.last().match?.roomCode).toBe('NAVROOM'); // recovery info retained
	});

	test('MATCH HAND-OFF for the LIVE identity is never cancelled: destroy() after navigation sends no leave for it', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve(matched('LIVERM', 'handle-F'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'LIVERM', memberId: 'm-mine' }]);

		h.search.destroy(); // page unmounts INTO the room
		expect(h.leaves).toEqual([]); // the matched row hands off — never retired
	});

	test('SAME-UID TOKEN ROTATION preserves the live search: no retirement, polling continues', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve(searching(2, 4, 'handle-G'));
		await flush();

		h.state.token = 'rotated-token'; // same uid — NOT an identity change
		h.fireDueTimer();
		await flush();
		expect(h.queueCalls).toHaveLength(2); // still polling
		expect(h.leaves).toEqual([]); // nothing retired

		h.queueCalls[1].resolve(matched('KEEPRM', 'handle-G'));
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'KEEPRM', memberId: 'm-mine' }]);
	});

	test('IDENTITY-RESOLVE FAILURE: no request was issued, so nothing is retired server-side', async () => {
		const h = harness({ resolveDelay: true });
		const failing = new QuickPlaySearch({
			resolveIdentity: () => Promise.reject(new Error('no identity')),
			currentUid: () => 'uid-1',
			queue: () => Promise.reject(new Error('unreachable')),
			leave: (searchId) => {
				h.leaves.push(searchId);
				return Promise.resolve();
			},
			navigate: () => Promise.resolve(),
			onChange: (s) => h.snapshots.push(s),
			mintAttemptId: () => 'mqa_never-sent'
		});
		await failing.start();
		expect(h.last().phase).toBe('idle');
		expect(h.last().error).toBe('no identity');
		failing.cancel();
		failing.destroy();
		expect(h.leaves).toEqual([]); // token never transmitted → nothing to leave
	});

	test('SERVER-TRUTH MATCH METADATA: a verified searcher matched into a mixed party gets the CASUAL/unrated verdict through state and navigate', async () => {
		const h = harness();
		void h.search.start();
		await flush();

		// The server formed a CASUAL, unrated game (the party contained a guest) —
		// whatever the searching UI assumed about this verified account.
		h.queueCalls[0].resolve({
			status: 'matched',
			roomCode: 'MIXED1',
			memberId: 'm-mine',
			mode: 'casual',
			rated: false,
			queued: 4,
			needed: 4,
			players: []
		});
		await flush();
		expect(h.navigations).toEqual([{ roomCode: 'MIXED1', memberId: 'm-mine' }]);
		expect(h.navMeta).toEqual([{ roomCode: 'MIXED1', mode: 'casual', rated: false }]);
		expect(h.last().match).toEqual({ roomCode: 'MIXED1', mode: 'casual', rated: false });

		// A ranked verdict rides through truthfully too.
		const h2 = harness();
		void h2.search.start();
		await flush();
		h2.queueCalls[0].resolve({
			status: 'matched',
			roomCode: 'RANK1',
			memberId: 'm-mine',
			mode: 'ranked',
			rated: true,
			queued: 4,
			needed: 4,
			players: []
		});
		await flush();
		expect(h2.navMeta).toEqual([{ roomCode: 'RANK1', mode: 'ranked', rated: true }]);
		expect(h2.last().match).toEqual({ roomCode: 'RANK1', mode: 'ranked', rated: true });
	});

	test('BOT DISCLOSURE + labels ride the snapshot untouched', async () => {
		const h = harness();
		void h.search.start();
		await flush();
		h.queueCalls[0].resolve({
			status: 'searching',
			rated: false,
			mode: 'casual',
			queued: 2,
			needed: 4,
			players: [
				{ userId: 'uid-1', displayName: 'Me', you: true },
				{ userId: 'b9', displayName: 'Nyx', you: false, isBot: true }
			]
		});
		await flush();
		expect(h.last().players).toEqual([
			{ userId: 'uid-1', displayName: 'Me', you: true },
			{ userId: 'b9', displayName: 'Nyx', you: false, isBot: true }
		]);
	});
});
