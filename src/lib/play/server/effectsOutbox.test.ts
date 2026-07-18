/**
 * Effects-outbox finalize payload — ADVERSARIAL delayed-recovery suite.
 *
 * The defect this closes (review P1): the outbox used to store only the session
 * REFERENCE and finalize from the CURRENT state at drain time, with ended_at still
 * null at pre-commit. A delayed recovery therefore recorded the recovery wall-clock
 * as the finish time and could consume a LATER state (different winner / VPs /
 * round) than the one that actually finished the game.
 *
 * The fix freezes the exact terminal inputs — standings (member, name, VP per
 * active seat), winner, round — and the committed finish timestamp INTO the outbox
 * payload at the finished transition (it rides the same atomic commit as the state).
 * These tests corrupt everything a delayed drain could wrongly consume — the
 * current state, the session row's stamps, even the members' display names the
 * frozen standings must NOT re-resolve VPs from — and assert the frozen payload
 * wins. Legacy outbox rows (written before `terminal` existed) keep the old
 * drain-time-state behavior, asserted last.
 */
import { describe, expect, test } from 'vitest';
import {
	computeRequiredEffects,
	drainEffectsOutbox,
	effectsOutboxEvent,
	EFFECTS_COMMAND_TYPE,
	type RequiredEffect
} from './effectsOutbox';
import { COMMIT_TABLES } from './commit';
import { FakePlayDb } from './fakePlayDb';
import type { PublicGameState } from '../types';

const FROZEN_ENDED_AT = '2026-07-10T12:00:00.000Z';

function stateAt(overrides: Partial<PublicGameState> = {}): PublicGameState {
	return {
		roomCode: 'RANK42',
		revision: 30,
		status: 'active',
		gameId: 'game-r1',
		scenario: null,
		winnerSeat: null,
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

function seedRankedRoom(db: FakePlayDb, sessionId = 's-rank-1') {
	db.seedMember({ id: 'm-red', session_id: sessionId, display_name: 'Alice', user_id: 'u-red' });
	db.seedMember({ id: 'm-blue', session_id: sessionId, display_name: 'Bob', user_id: 'u-blue' });
}

/** The finished transition as a writer commits it: compute the owed effects and
 *  durably append the outbox event (state row itself is irrelevant to the drain). */
function commitFinishedTransition(db: FakePlayDb, sessionId: string, next: PublicGameState) {
	const effects = computeRequiredEffects({
		prev: stateAt(), // status 'active' → 'finished': finalize is owed
		next,
		command: null,
		session: {
			id: sessionId,
			game_id: next.gameId,
			mode: 'ranked',
			started_at: '2026-07-10T11:00:00.000Z',
			ended_at: null // NOT stamped yet at pre-commit — the payload must freeze it
		},
		timestamp: FROZEN_ENDED_AT
	});
	const outbox = effectsOutboxEvent(next.revision, effects)!;
	db.rowsFor(COMMIT_TABLES.EVENTS).push({
		id: `evt-outbox-${sessionId}`,
		session_id: sessionId,
		revision: outbox.revision,
		actor_member_id: null,
		command_type: EFFECTS_COMMAND_TYPE,
		// Deep-cloned + key-sorted like the real jsonb column round-trip.
		command_payload: JSON.parse(JSON.stringify(outbox.payload))
	});
	return effects;
}

describe('matchFinalize outbox payload freezing (P1)', () => {
	test('the transition freezes the exact terminal inputs and the committed finish timestamp', () => {
		const db = new FakePlayDb({ rpc: true });
		const finished = stateAt({ status: 'finished', winnerSeat: 'Red', revision: 31 });
		const effects = commitFinishedTransition(db, 's-rank-1', finished);

		const finalize = effects.find((e) => e.kind === 'matchFinalize');
		expect(finalize).toBeDefined();
		if (finalize?.kind !== 'matchFinalize') throw new Error('unreachable');
		expect(finalize.session.ended_at).toBe(FROZEN_ENDED_AT); // never null in the payload
		expect(finalize.terminal).toEqual({
			winnerSeat: 'Red',
			round: 7,
			activeSeats: ['Red', 'Blue'],
			seats: {
				Red: { memberId: 'm-red', displayName: 'Alice' },
				Blue: { memberId: 'm-blue', displayName: 'Bob' }
			},
			players: { Red: { victoryPoints: 30 }, Blue: { victoryPoints: 22 } }
		});
	});

	test('delayed recovery finalizes the FROZEN terminal state — not the mutated current state, not the recovery clock', async () => {
		const db = new FakePlayDb({ rpc: true });
		seedRankedRoom(db);
		const finished = stateAt({ status: 'finished', winnerSeat: 'Red', revision: 31 });
		commitFinishedTransition(db, 's-rank-1', finished);
		// ← the writer dies here; nothing finalized yet.
		expect(db.rowsFor('match_results')).toHaveLength(0);

		// By the time recovery drains, the "current" durable state and session stamps
		// have moved on ADVERSARIALLY: different winner, flipped VPs, later round.
		// (However a session gets here — post-game tampering, a rematch feature, a
		// bug — recovery must not consume any of it.)
		const mutatedCurrent = stateAt({
			status: 'finished',
			winnerSeat: 'Blue',
			revision: 44,
			round: 12,
			players: { Red: { victoryPoints: 1 }, Blue: { victoryPoints: 99 } }
		} as Partial<PublicGameState>);

		await drainEffectsOutbox(db, null, 's-rank-1', mutatedCurrent);

		const anchor = db.rowsFor('match_results')[0];
		expect(anchor).toBeDefined();
		expect(anchor.winner_seat).toBe('Red'); // frozen, not 'Blue'
		expect(anchor.navigation_count).toBe(7); // frozen, not 12
		expect(anchor.ended_at).toBe(FROZEN_ENDED_AT); // frozen, NOT recovery wall-clock
		expect(anchor.rated).toBe(true);

		const players = db.rowsFor('match_result_players');
		expect(players).toHaveLength(2);
		const red = players.find((p) => p.seat_color === 'Red')!;
		const blue = players.find((p) => p.seat_color === 'Blue')!;
		expect(red.victory_points).toBe(30); // frozen, not 1
		expect(blue.victory_points).toBe(22); // frozen, not 99
		expect(red.placement).toBe(1);
		expect(blue.placement).toBe(2);

		// Ratings were computed FROM the frozen standings and stamped with the frozen
		// finish time — the winner per the frozen state gains.
		const redRating = db.rowsFor('player_ratings').find((r) => r.user_id === 'u-red')!;
		const blueRating = db.rowsFor('player_ratings').find((r) => r.user_id === 'u-blue')!;
		expect(redRating.mu).toBeGreaterThan(blueRating.mu);
		expect(redRating.last_game_at).toBe(FROZEN_ENDED_AT);

		// Outbox settled exactly once; a re-drain with yet another state is a no-op.
		expect(
			db.rowsFor(COMMIT_TABLES.EVENTS).filter((e) => e.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(0);
		await drainEffectsOutbox(db, null, 's-rank-1', mutatedCurrent);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(redRating.games_played).toBe(1);
	});

	test('delayed recovery ignores later session-row stamp changes (frozen ended_at rides the payload, not the row)', async () => {
		const db = new FakePlayDb({ rpc: true });
		seedRankedRoom(db, 's-rank-2');
		const finished = stateAt({ status: 'finished', winnerSeat: 'Red', revision: 31 });
		commitFinishedTransition(db, 's-rank-2', finished);

		// The session row's ended_at gets rewritten (or cleared) after the crash —
		// the drain never reads it, but make the adversarial intent explicit.
		db.seedSession({
			id: 's-rank-2',
			room_code: 'RANK43',
			revision: 44,
			ended_at: '2026-07-11T09:00:00.000Z'
		});

		await drainEffectsOutbox(db, null, 's-rank-2', finished);
		expect(db.rowsFor('match_results')[0].ended_at).toBe(FROZEN_ENDED_AT);
	});

	test('legacy outbox rows (no frozen terminal) still finalize from the drain-time state', async () => {
		const db = new FakePlayDb({ rpc: true });
		seedRankedRoom(db, 's-legacy');
		// A row written by the PREVIOUS deploy: session reference only, ended_at null.
		const legacyEffect: RequiredEffect = {
			kind: 'matchFinalize',
			session: {
				id: 's-legacy',
				game_id: 'game-r1',
				mode: 'ranked',
				started_at: '2026-07-10T11:00:00.000Z',
				ended_at: null
			}
		};
		db.rowsFor(COMMIT_TABLES.EVENTS).push({
			id: 'evt-legacy',
			session_id: 's-legacy',
			revision: 31,
			actor_member_id: null,
			command_type: EFFECTS_COMMAND_TYPE,
			command_payload: JSON.parse(JSON.stringify({ effects: [legacyEffect] }))
		});

		const current = stateAt({ status: 'finished', winnerSeat: 'Blue', revision: 40, round: 9 });
		const before = Date.now();
		await drainEffectsOutbox(db, null, 's-legacy', current);

		const anchor = db.rowsFor('match_results')[0];
		expect(anchor.winner_seat).toBe('Blue'); // drain-time state — the documented legacy behavior
		expect(anchor.navigation_count).toBe(9);
		// ended_at falls back to the drain wall-clock (the pre-fix residual, legacy rows only).
		expect(Date.parse(anchor.ended_at)).toBeGreaterThanOrEqual(before - 1);
	});
});
