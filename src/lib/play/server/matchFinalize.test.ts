/**
 * Ranked finalize — cross-process exactly-once PROTOCOL suite (in-memory fake).
 *
 * Proves, against the in-memory Postgres fake (both store postures), that a
 * finished ranked session converges to EXACTLY ONE match_results anchor, one
 * player row per seat, one rating event per rated player, and one games_played /
 * mu/sigma application per player — across:
 *   - re-fires and concurrent duplicate drains (same and cross "process");
 *   - independent finalizers racing from scratch (no shared in-process state);
 *   - crashes before/after the finalize transaction (RPC posture: all-or-nothing);
 *   - crashes at EVERY intermediate write of the legacy non-atomic sequence
 *     (opt-in fallback posture: the partial-attempt markers make crash-and-retry
 *     converge without double-applying);
 *   - the caller's stale_ratings re-read/recompute retry loop;
 *   - the fail-closed readiness contract when the finalize_match RPC is missing.
 *
 * Plus: replay-code creation under concurrent drains (one logical code per round).
 *
 * SCOPE — what this suite does NOT prove: the fake executes each finalize_match
 * "transaction" atomically in one JS turn, so genuinely interleaved transaction
 * schedules (two finalizers both validating an ABSENT shared rating base before
 * either commits — the schedule the function's per-user advisory locks exist for)
 * cannot arise here. PostgreSQL locking behavior is proven against a real cluster
 * in matchFinalize.pg.test.ts; nothing in this file is evidence of it.
 */
import { describe, expect, test, afterEach } from 'vitest';
import {
	finalizeMatchWith,
	finalizeMatchUnserialized,
	type FinalizeMatchSession
} from './matchFinalize';
import { writeSnapshotRowsWith } from './historySnapshots';
import { FakePlayDb } from './fakePlayDb';
import type { PublicGameState } from '../types';

afterEach(() => {
	delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
});

function finishedState(overrides: Partial<PublicGameState> = {}): PublicGameState {
	return {
		roomCode: 'RANK42',
		revision: 30,
		status: 'finished',
		gameId: 'game-r1',
		scenario: null,
		winnerSeat: 'Red',
		round: 7,
		activeSeats: ['Red', 'Blue'],
		seats: {
			Red: { memberId: 'm-red', displayName: 'Alice' },
			Blue: { memberId: 'm-blue', displayName: 'Bob' }
		},
		players: {
			Red: { victoryPoints: 30 },
			Blue: { victoryPoints: 22 }
		},
		...overrides
	} as unknown as PublicGameState;
}

function seedRankedSession(
	db: FakePlayDb,
	sessionId = 's-rank-1',
	users: { red: string | null; blue: string | null } = { red: 'u-red', blue: 'u-blue' }
): FinalizeMatchSession {
	db.seedMember({ id: 'm-red', session_id: sessionId, display_name: 'Alice', user_id: users.red });
	db.seedMember({ id: 'm-blue', session_id: sessionId, display_name: 'Bob', user_id: users.blue });
	return {
		id: sessionId,
		game_id: 'game-r1',
		mode: 'ranked',
		started_at: '2026-07-10T11:00:00.000Z',
		ended_at: '2026-07-10T12:00:00.000Z'
	};
}

function ratingOf(db: FakePlayDb, userId: string) {
	return db.rowsFor('player_ratings').find((r) => r.user_id === userId) ?? null;
}

function assertExactlyOnce(db: FakePlayDb, sessionId: string) {
	expect(db.rowsFor('match_results').filter((r) => r.session_id === sessionId)).toHaveLength(1);
	expect(db.rowsFor('match_result_players').filter((r) => r.session_id === sessionId)).toHaveLength(
		2
	);
	expect(db.rowsFor('player_rating_events').filter((r) => r.session_id === sessionId)).toHaveLength(
		2
	);
	for (const user of ['u-red', 'u-blue']) {
		const events = db
			.rowsFor('player_rating_events')
			.filter((r) => r.session_id === sessionId && r.user_id === user);
		expect(events).toHaveLength(1);
	}
}

// ── production posture: the atomic finalize_match transaction ─────────────────────

describe('finalize_match transaction (20260710_ranked_finalize applied)', () => {
	test('a finished ranked session records everything exactly once and rates both players', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);

		assertExactlyOnce(db, session.id);
		const anchor = db.rowsFor('match_results')[0];
		expect(anchor.ranked).toBe(true);
		expect(anchor.rated).toBe(true);
		expect(anchor.winner_seat).toBe('Red');
		expect(anchor.player_count).toBe(2);

		const red = ratingOf(db, 'u-red')!;
		const blue = ratingOf(db, 'u-blue')!;
		expect(red.games_played).toBe(1);
		expect(blue.games_played).toBe(1);
		expect(red.mu).toBeGreaterThan(blue.mu); // winner gains, loser drops
		expect(red.last_session_id).toBe(session.id);

		// The event trail matches the applied ratings.
		const redEvent = db
			.rowsFor('player_rating_events')
			.find((e) => e.user_id === 'u-red' && e.session_id === session.id)!;
		expect(redEvent.mu_after).toBe(red.mu);
		expect(redEvent.placement).toBe(1);
	});

	test('an abandoned human rates behind every non-abandoner even when bot control wins the board', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = { ...seedRankedSession(db), ranked_season_id: 'season-zero-2026' };
		const redMember = db.rowsFor('play_session_members').find((row) => row.id === 'm-red')!;
		redMember.is_bot = true; // server bot took over after explicit concede
		db.rowsFor('ranked_participation').push({ session_id: session.id, member_id: 'm-red',
			season_id: 'season-zero-2026', user_id: 'u-red', abandoned: true, abandonment_kind: 'concede' });
		expect(await finalizeMatchWith(db, session, finishedState({ winnerSeat: 'Red' }))).toBe(true);
		const redEvent = db.rowsFor('player_rating_events').find((row) => row.user_id === 'u-red')!;
		const blueEvent = db.rowsFor('player_rating_events').find((row) => row.user_id === 'u-blue')!;
		expect(redEvent.placement).toBe(2);
		expect(blueEvent.placement).toBe(1);
		const redResult = db.rowsFor('match_result_players').find((row) => row.user_id === 'u-red')!;
		expect(redResult).toMatchObject({ placement: 1, rated_placement: 2, abandoned: true });
		expect(db.rowsFor('ranked_season_rating_events').filter((row) => row.session_id === session.id)).toHaveLength(2);
	});

	test('re-fires and concurrent cross-instance drains converge without re-applying', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		const muAfterFirst = ratingOf(db, 'u-red')!.mu;

		// Independent finalizers (recovery worker / second instance): NO shared
		// in-process serialization, interleaved statements via injected latency.
		db.latencyMs = 2;
		const results = await Promise.all([
			finalizeMatchUnserialized(db, session, finishedState()),
			finalizeMatchUnserialized(db, session, finishedState()),
			finalizeMatchUnserialized(db, session, finishedState())
		]);
		expect(results).toEqual([true, true, true]);

		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
		expect(ratingOf(db, 'u-red')!.mu).toBe(muAfterFirst);
	});

	test('independent finalizers racing FROM SCRATCH admit exactly one application', async () => {
		const db = new FakePlayDb({ rpc: true });
		db.latencyMs = 2;
		const session = seedRankedSession(db);

		const results = await Promise.all(
			Array.from({ length: 4 }, () => finalizeMatchUnserialized(db, session, finishedState()))
		);
		expect(results).toEqual([true, true, true, true]);

		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
		expect(ratingOf(db, 'u-blue')!.games_played).toBe(1);
	});

	test('a crash AFTER the transaction commits recovers to already_finalized (nothing doubled)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);

		db.failNextRpcCall('finalize_match', 'crash-after');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		// The transaction committed before the "process" died: everything is durable…
		assertExactlyOnce(db, session.id);
		const mu = ratingOf(db, 'u-red')!.mu;

		// …and the outbox-driven retry converges without touching anything.
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
		expect(ratingOf(db, 'u-red')!.mu).toBe(mu);
	});

	test('a crash BEFORE the transaction applies nothing; the retry starts clean', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);

		db.failNextRpcCall('finalize_match', 'crash-before');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
	});

	test('a failed (rolled-back) transaction leaves no partial state and retries cleanly', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);

		db.failNextRpcCall('finalize_match', 'error');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
	});

	test('two sessions rating the SAME user: the losing caller retries on stale_ratings and converges (PROTOCOL only — real-PG serialization is proven in matchFinalize.pg.test.ts)', async () => {
		const db = new FakePlayDb({ rpc: true });
		db.latencyMs = 2;
		// Session A: u-shared vs u-a2. Session B: u-shared vs u-b2.
		db.seedMember({ id: 'm-red', session_id: 's-A', display_name: 'Shared', user_id: 'u-shared' });
		db.seedMember({ id: 'm-blue', session_id: 's-A', display_name: 'A2', user_id: 'u-a2' });
		db.seedMember({ id: 'm-red', session_id: 's-B', display_name: 'Shared', user_id: 'u-shared' });
		db.seedMember({ id: 'm-blue', session_id: 's-B', display_name: 'B2', user_id: 'u-b2' });
		const sessionA: FinalizeMatchSession = {
			id: 's-A',
			game_id: 'game-A',
			mode: 'ranked',
			started_at: null,
			ended_at: '2026-07-10T12:00:00.000Z'
		};
		const sessionB: FinalizeMatchSession = { ...sessionA, id: 's-B', game_id: 'game-B' };

		// Both finalizers read u-shared's (absent) base concurrently; the fake's rpc
		// bodies then run one-at-a-time (its atomicity is stronger than a real
		// schedule — see fakePlayDb.ts HONESTY LIMIT), so the loser gets
		// stale_ratings and must re-read + re-apply on top. This exercises the
		// CALLER's retry loop; that real PostgreSQL actually forces this
		// serialization (advisory locks, absent rows included) is proven in
		// matchFinalize.pg.test.ts, not here.
		const [a, b] = await Promise.all([
			finalizeMatchUnserialized(db, sessionA, finishedState({ gameId: 'game-A' })),
			finalizeMatchUnserialized(db, sessionB, finishedState({ gameId: 'game-B' }))
		]);
		expect(a).toBe(true);
		expect(b).toBe(true);

		const shared = ratingOf(db, 'u-shared')!;
		expect(shared.games_played).toBe(2); // one per session, never lost or doubled
		expect(db.rowsFor('player_rating_events').filter((e) => e.user_id === 'u-shared')).toHaveLength(
			2
		);
		expect(db.rowsFor('match_results')).toHaveLength(2);

		// The event chain is contiguous: one event starts where the other ended.
		const events = db.rowsFor('player_rating_events').filter((e) => e.user_id === 'u-shared');
		const chained =
			events[0].mu_after === events[1].mu_before || events[1].mu_after === events[0].mu_before;
		expect(chained).toBe(true);
	});

	test('a stale rating base is refused by the transaction itself (defense in depth)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);

		// A hand-rolled second finalize for another session claims u-red is still
		// unrated (expected_games null) — the transaction must refuse it outright.
		const res = await db.rpc('finalize_match', {
			p_session_id: 's-rank-2',
			p_result: { mode: 'ranked', ranked: true },
			p_players: [],
			p_ratings: [
				{
					user_id: 'u-red',
					placement: 1,
					mu_before: 25,
					sigma_before: 8.333,
					mu_after: 27,
					sigma_after: 8,
					expected_mu: null,
					expected_sigma: null,
					expected_games: null
				}
			]
		});
		expect(res.error?.message).toMatch(/stale_ratings/);
		expect(db.rowsFor('match_results')).toHaveLength(1); // nothing applied
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
	});

	test('legacy partial state (ratings applied, events lost, no anchor) is completed WITHOUT re-applying', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);
		// The old non-atomic finalizer crashed between its ratings upsert and its
		// events insert: last_session_id stamped, no events, no anchor.
		db.rowsFor('player_ratings').push(
			{
				user_id: 'u-red',
				display_name: 'Alice',
				mu: 27.1,
				sigma: 7.9,
				games_played: 1,
				last_session_id: session.id,
				rating_version: 1
			},
			{
				user_id: 'u-blue',
				display_name: 'Bob',
				mu: 22.9,
				sigma: 7.9,
				games_played: 1,
				last_session_id: session.id,
				rating_version: 1
			}
		);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);

		const anchor = db.rowsFor('match_results')[0];
		expect(anchor.rated).toBe(true); // the prior attempt's ratings stand
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1); // NOT double-applied
		expect(ratingOf(db, 'u-red')!.mu).toBe(27.1);
		// The lost event rows are unrecoverable (mu_before is gone) and stay missing.
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
		expect(db.rowsFor('match_result_players')).toHaveLength(2);
	});

	test('legacy partial state (ratings + events, no anchor) is completed WITHOUT re-applying', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);
		db.rowsFor('player_ratings').push(
			{
				user_id: 'u-red',
				display_name: 'Alice',
				mu: 27.1,
				sigma: 7.9,
				games_played: 1,
				last_session_id: session.id,
				rating_version: 1
			},
			{
				user_id: 'u-blue',
				display_name: 'Bob',
				mu: 22.9,
				sigma: 7.9,
				games_played: 1,
				last_session_id: session.id,
				rating_version: 1
			}
		);
		db.rowsFor('player_rating_events').push(
			{
				session_id: session.id,
				user_id: 'u-red',
				placement: 1,
				mu_before: 25,
				sigma_before: 8.333,
				mu_after: 27.1,
				sigma_after: 7.9,
				rating_version: 1
			},
			{
				session_id: session.id,
				user_id: 'u-blue',
				placement: 2,
				mu_before: 25,
				sigma_before: 8.333,
				mu_after: 22.9,
				sigma_after: 7.9,
				rating_version: 1
			}
		);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
	});

	test('anchor-only partial state repairs the player rows and never touches ratings', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db);
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		// Simulate the lost tail: drop the player rows.
		db.tables.set('match_result_players', []);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
	});

	test('a casual finish records an unrated anchor and never touches ratings', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = { ...seedRankedSession(db), mode: 'casual' as const };

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		const anchor = db.rowsFor('match_results')[0];
		expect(anchor.ranked).toBe(false);
		expect(anchor.rated).toBe(false);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
		expect(db.rowsFor('match_result_players')).toHaveLength(2);
	});

	test('ranked with fewer than two attributable users records an unrated anchor', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRankedSession(db, 's-rank-1', { red: 'u-red', blue: null });

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		expect(db.rowsFor('match_results')[0].rated).toBe(false);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		// The guest/unattributable seat is flagged as a bot-safety net.
		const blueRow = db.rowsFor('match_result_players').find((p) => p.seat_color === 'Blue')!;
		expect(blueRow.is_bot).toBe(true);
	});
});

// ── readiness: fail closed without the migration ───────────────────────────────────

describe('fail-closed readiness (finalize_match RPC missing)', () => {
	test('without the opt-in NOTHING is written and the effect reports not-durable (outbox retries)', async () => {
		delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
		const db = new FakePlayDb({ rpc: false });
		const session = seedRankedSession(db);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('match_result_players')).toHaveLength(0);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);

		// The explicit opt-in (param or env) restores the local/test fallback.
		expect(
			await finalizeMatchWith(db, session, finishedState(), { allowNonAtomicFallback: true })
		).toBe(true);
		assertExactlyOnce(db, session.id);
	});
});

// ── opt-in fallback: crash at every intermediate legacy write ──────────────────────

describe('non-atomic fallback (explicit opt-in): crash-and-retry never double-applies', () => {
	function fallbackDb(): FakePlayDb {
		process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
		return new FakePlayDb({ rpc: false });
	}

	test('crash after the ratings upsert (events not yet written)', async () => {
		const db = fallbackDb();
		const session = seedRankedSession(db);

		db.failNextOp('player_ratings', 'upsert', 'crash-after');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		// The dead writer applied ratings only.
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		const mu = ratingOf(db, 'u-red')!.mu;

		// Recovery: the last_session_id marker forbids re-application.
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
		expect(ratingOf(db, 'u-red')!.mu).toBe(mu);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_results')[0].rated).toBe(true);
		expect(db.rowsFor('match_result_players')).toHaveLength(2);
		// Residual, stated honestly: the event rows died with the writer.
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
	});

	test('crash after the events insert (anchor not yet written)', async () => {
		const db = fallbackDb();
		const session = seedRankedSession(db);

		db.failNextOp('player_rating_events', 'insert', 'crash-after');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('player_rating_events')).toHaveLength(2);
		expect(db.rowsFor('match_results')).toHaveLength(0);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
	});

	test('crash after the anchor insert (player rows not yet written)', async () => {
		const db = fallbackDb();
		const session = seedRankedSession(db);

		db.failNextOp('match_results', 'insert', 'crash-after');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_result_players')).toHaveLength(0);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
		expect(ratingOf(db, 'u-red')!.games_played).toBe(1);
	});

	test('a transient ratings-upsert ERROR applies nothing and retries cleanly', async () => {
		const db = fallbackDb();
		const session = seedRankedSession(db);

		db.failNextOp('player_ratings', 'upsert', 'error');
		expect(await finalizeMatchWith(db, session, finishedState())).toBe(false);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		expect(db.rowsFor('match_results')).toHaveLength(0);

		expect(await finalizeMatchWith(db, session, finishedState())).toBe(true);
		assertExactlyOnce(db, session.id);
	});
});

// ── replay codes: one logical code per (game, round) under concurrent drains ───────

describe('replay-code creation under concurrent drains', () => {
	const rows = [
		{ game_id: 'game-r1', navigation_count: 3, player_color: 'Red', payload: {} },
		{ game_id: 'game-r1', navigation_count: 3, player_color: 'Blue', payload: {} }
	];

	test('two concurrent drains mint exactly one code (the loser adopts the winner)', async () => {
		const db = new FakePlayDb({ rpc: true });
		db.latencyMs = 2;
		await Promise.all([
			writeSnapshotRowsWith(db, rows, 'game-r1', 3),
			writeSnapshotRowsWith(db, rows, 'game-r1', 3)
		]);
		expect(db.rowsFor('replay_codes')).toHaveLength(1);
		expect(db.rowsFor('game_state_snapshots')).toHaveLength(2);
	});

	test('a later re-drain reuses the existing code', async () => {
		const db = new FakePlayDb({ rpc: true });
		await writeSnapshotRowsWith(db, rows, 'game-r1', 3);
		const code = db.rowsFor('replay_codes')[0].code;
		await writeSnapshotRowsWith(db, rows, 'game-r1', 3);
		expect(db.rowsFor('replay_codes')).toHaveLength(1);
		expect(db.rowsFor('replay_codes')[0].code).toBe(code);
	});
});
