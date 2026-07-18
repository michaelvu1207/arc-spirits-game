/**
 * Durable commit protocol (commit.ts) — the single authority every transport shares.
 * Proves, against the in-memory Postgres fake (both pre- and post-migration modes):
 * STRICT revision monotonicity (next > expected at every layer — shared commit, RPC,
 * raw store trigger — incl. the current=expected=next equal-revision rewrite), CAS
 * fencing (single winner), identity-bound cmdId exactly-once (honest duplicate
 * answers the ORIGINAL revision; a re-used cmdId with a different actor/type/payload
 * is an idempotency_conflict), the concurrent-duplicate race, fail-closed readiness
 * when the atomic RPC is missing, and the documented fallback-mode crash residual
 * the RPC closes (fallback engages ONLY behind the explicit opt-in).
 */
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
	commitRoomMutation,
	CommitNotReadyError,
	findCommittedCmd,
	resetCommitRpcProbe,
	type CommitSessionRef
} from './commit';
import { FakePlayDb } from './fakePlayDb';
import type { PublicGameState } from '../types';

function stateAt(revision: number, extra: Partial<PublicGameState> = {}): PublicGameState {
	return {
		roomCode: 'ROOM42',
		revision,
		status: 'active',
		gameId: 'game-1',
		scenario: null,
		...extra
	} as unknown as PublicGameState;
}

function sessionRef(db: FakePlayDb): CommitSessionRef {
	const row = db.getSession('ROOM42')!;
	return { id: row.id, revision: row.revision, started_at: row.started_at, ended_at: row.ended_at };
}

function seed(db: FakePlayDb, revision = 5) {
	return db.seedSession({
		room_code: 'ROOM42',
		status: 'active',
		revision,
		public_state: stateAt(revision),
		started_at: '2026-07-10T00:00:00.000Z'
	});
}

const CMD = { type: 'adjustVictoryPoints', amount: 1 } as never;

function eventFor(revision: number, cmdId: string | null = null) {
	return {
		commandType: 'adjustVictoryPoints',
		payload: CMD as Record<string, unknown>,
		actorMemberId: 'm-1',
		revision,
		cmdId
	};
}

describe.each([
	{ label: 'fallback mode (pre-migration)', rpc: false },
	{ label: 'RPC mode (20260710 migration applied)', rpc: true }
])('$label', ({ rpc }) => {
	let db: FakePlayDb;

	beforeEach(() => {
		resetCommitRpcProbe();
		// Pre-migration mode is an EXPLICIT opt-in now (fail-closed otherwise).
		if (!rpc) process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
		db = new FakePlayDb({ rpc });
		seed(db);
	});

	afterEach(() => {
		delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
	});

	test('commits under the revision CAS and appends the ledger row', async () => {
		const outcome = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6, 'cmd-a')]
		});
		expect(outcome.outcome).toBe('committed');
		expect(db.getSession('ROOM42')!.revision).toBe(6);
		const events = db.rowsFor('play_game_session_events');
		expect(events).toHaveLength(1);
		expect(events[0].command_payload.cmdId).toBe('cmd-a');
		expect(events[0].revision).toBe(6);
	});

	test('a stale writer CAS-misses and cannot overwrite newer state', async () => {
		// Someone else committed revision 6 first.
		await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6)]
		});
		// A writer still fenced on revision 5 must lose, leaving revision 6 intact.
		const stale = await commitRoomMutation(db, {
			session: { ...sessionRef(db), revision: 5 },
			nextState: stateAt(6, { gameId: 'FORK' }),
			events: [eventFor(6)]
		});
		expect(stale.outcome).toBe('cas_miss');
		expect(db.getSession('ROOM42')!.revision).toBe(6);
		expect(db.getSession('ROOM42')!.public_state.gameId).toBe('game-1');
	});

	test('an equal-revision rewrite is also fenced out (no silent same-revision fork)', async () => {
		await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6)]
		});
		// Fenced on 5 → wants to WRITE 6 again with different content: must miss.
		const rewrite = await commitRoomMutation(db, {
			session: { ...sessionRef(db), revision: 5 },
			nextState: stateAt(6, { roomCode: 'EVIL42' }),
			events: [eventFor(6)]
		});
		expect(rewrite.outcome).toBe('cas_miss');
		expect(db.getSession('ROOM42')!.public_state.roomCode).toBe('ROOM42');
	});

	test('REGRESSION: current=expected=next with changed state is rejected at every layer', async () => {
		// Head is at 5. A writer fenced on the CURRENT revision tries to re-WRITE
		// revision 5 with different content — the equal-revision rewrite that used to
		// slip through the CAS (revision matched) and silently overwrite state.
		const before = structuredClone(db.getSession('ROOM42')!.public_state);

		// 1) The shared commit protocol rejects it before any wire write.
		await expect(
			commitRoomMutation(db, {
				session: sessionRef(db), // revision 5 — equals the head
				nextState: stateAt(5, { gameId: 'EVIL-FORK' }),
				events: [eventFor(5)]
			})
		).rejects.toThrow(/revision_not_monotonic/);

		// 2) Bypassing the shared commit: the store's RPC / trigger layer also refuses.
		if (rpc) {
			const viaRpc = await db.rpc('commit_room_command', {
				p_session_id: sessionRef(db).id,
				p_expected_revision: 5,
				p_next_revision: 5,
				p_status: 'active',
				p_game_id: 'EVIL-FORK',
				p_scenario: null,
				p_public_state: stateAt(5, { gameId: 'EVIL-FORK' }),
				p_stamp_started_at: false,
				p_stamp_ended_at: false,
				p_events: []
			});
			expect(viaRpc.error?.message).toMatch(/revision_not_monotonic/);
		}
		const direct = await db
			.from('play_game_sessions')
			.update({ revision: 5, public_state: stateAt(5, { gameId: 'EVIL-FORK' }) })
			.eq('id', sessionRef(db).id)
			.eq('revision', 5)
			.select('*')
			.maybeSingle();
		expect(direct.error?.message).toMatch(/revision_not_monotonic/);
		const lower = await db
			.from('play_game_sessions')
			.update({ revision: 4 })
			.eq('id', sessionRef(db).id)
			.eq('revision', 5)
			.select('*')
			.maybeSingle();
		expect(lower.error?.message).toMatch(/revision_not_monotonic/);

		// Nothing changed: same revision, same state, no ledger rows.
		expect(db.getSession('ROOM42')!.revision).toBe(5);
		expect(db.getSession('ROOM42')!.public_state).toEqual(before);
		expect(db.rowsFor('play_game_session_events')).toHaveLength(0);
	});

	test('event revisions must be coherent with the committed range (base, next]', async () => {
		await expect(
			commitRoomMutation(db, {
				session: sessionRef(db),
				nextState: stateAt(6),
				events: [eventFor(5)] // at/below the fenced base — incoherent
			})
		).rejects.toThrow(/event_revision_incoherent/);
		await expect(
			commitRoomMutation(db, {
				session: sessionRef(db),
				nextState: stateAt(6),
				events: [eventFor(7)] // beyond the written head — incoherent
			})
		).rejects.toThrow(/event_revision_incoherent/);
		expect(db.getSession('ROOM42')!.revision).toBe(5);
	});

	test('the written state must carry exactly the committed revision', async () => {
		if (!rpc) return; // the TS layer passes nextState.revision itself; the RPC re-checks
		const res = await db.rpc('commit_room_command', {
			p_session_id: sessionRef(db).id,
			p_expected_revision: 5,
			p_next_revision: 6,
			p_status: 'active',
			p_game_id: 'game-1',
			p_scenario: null,
			p_public_state: stateAt(9), // disagrees with p_next_revision
			p_stamp_started_at: false,
			p_stamp_ended_at: false,
			p_events: []
		});
		expect(res.error?.message).toMatch(/revision_incoherent/);
		expect(db.getSession('ROOM42')!.revision).toBe(5);
	});

	test('same cmdId with a DIFFERENT actor or payload → idempotency_conflict, nothing applied', async () => {
		const first = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6, 'bound-1')]
		});
		expect(first.outcome).toBe('committed');

		// Different ACTOR under the original cmdId.
		const otherActor = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7),
			events: [{ ...eventFor(7, 'bound-1'), actorMemberId: 'm-2' }]
		});
		expect(otherActor.outcome).toBe('idempotency_conflict');
		expect(otherActor.outcome === 'idempotency_conflict' && otherActor.revision).toBe(6);

		// Different PAYLOAD under the original cmdId.
		const otherPayload = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7),
			events: [
				{
					...eventFor(7, 'bound-1'),
					payload: { type: 'adjustVictoryPoints', amount: 99 } as never
				}
			]
		});
		expect(otherPayload.outcome).toBe('idempotency_conflict');

		// Different COMMAND TYPE under the original cmdId.
		const otherType = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7),
			events: [
				{
					...eventFor(7, 'bound-1'),
					commandType: 'releaseSeat',
					payload: { type: 'releaseSeat' } as never
				}
			]
		});
		expect(otherType.outcome).toBe('idempotency_conflict');

		// The honest identical retry still answers the original.
		const honest = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7),
			events: [eventFor(7, 'bound-1')]
		});
		expect(honest.outcome).toBe('duplicate');
		expect(honest.outcome === 'duplicate' && honest.revision).toBe(6);

		// Exactly one application ever landed.
		expect(db.getSession('ROOM42')!.revision).toBe(6);
		expect(db.rowsFor('play_game_session_events')).toHaveLength(1);
	});

	test('duplicate cmdId answers the ORIGINAL committed revision, applies nothing', async () => {
		const first = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6, 'retry-me')]
		});
		expect(first.outcome).toBe('committed');

		// The retry arrives later, computed from the (now-current) base revision 6.
		const retry = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7),
			events: [eventFor(7, 'retry-me')]
		});
		expect(retry.outcome).toBe('duplicate');
		expect(retry.outcome === 'duplicate' && retry.revision).toBe(6);
		expect(db.getSession('ROOM42')!.revision).toBe(6); // second application never landed
		expect(db.rowsFor('play_game_session_events')).toHaveLength(1);
	});

	test('findCommittedCmd resolves the committed revision AND identity for a cmdId', async () => {
		const ref = sessionRef(db);
		await commitRoomMutation(db, {
			session: ref,
			nextState: stateAt(6),
			events: [eventFor(6, 'lookup-me')]
		});
		expect(await findCommittedCmd(db, ref.id, 'lookup-me')).toEqual({
			revision: 6,
			actorMemberId: 'm-1',
			commandType: 'adjustVictoryPoints',
			payload: { type: 'adjustVictoryPoints', amount: 1, cmdId: 'lookup-me' }
		});
		expect(await findCommittedCmd(db, ref.id, 'never-sent')).toBeNull();
	});

	test('CONCURRENT identical cmdIds admit exactly one application', async () => {
		// Both fenced on revision 5, both carrying the same cmdId, racing.
		const ref = sessionRef(db);
		const [a, b] = await Promise.all([
			commitRoomMutation(db, {
				session: ref,
				nextState: stateAt(6),
				events: [eventFor(6, 'race')]
			}),
			commitRoomMutation(db, {
				session: ref,
				nextState: stateAt(6),
				events: [eventFor(6, 'race')]
			})
		]);
		const outcomes = [a.outcome, b.outcome].sort();
		expect(outcomes).toContain('committed');
		// The loser is a cas_miss (fallback) or duplicate (RPC unique index) — either
		// way the caller reloads, re-checks the ledger, and answers the original.
		expect(db.getSession('ROOM42')!.revision).toBe(6);
		expect(
			db.rowsFor('play_game_session_events').filter((row) => row.command_payload.cmdId === 'race')
		).toHaveLength(1);
	});

	test('finished transition stamps ended_at exactly once', async () => {
		const outcome = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6, { status: 'finished' }),
			events: [eventFor(6)]
		});
		expect(outcome.outcome).toBe('committed');
		const endedAt = db.getSession('ROOM42')!.ended_at;
		expect(typeof endedAt).toBe('string');

		const again = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(7, { status: 'finished' }),
			events: [eventFor(7)]
		});
		expect(again.outcome).toBe('committed');
		expect(db.getSession('ROOM42')!.ended_at).toBe(endedAt); // not re-stamped
	});
});

describe('mode-specific guarantees', () => {
	beforeEach(() => resetCommitRpcProbe());
	afterEach(() => {
		delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
	});

	test('READINESS: a missing atomic RPC without the opt-in fails closed (store_not_ready)', async () => {
		delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
		const db = new FakePlayDb({ rpc: false });
		seed(db);
		// No opt-in ⇒ the commit must NOT degrade to the non-atomic fallback: it fails
		// with a readiness error and writes NOTHING.
		await expect(
			commitRoomMutation(db, {
				session: sessionRef(db),
				nextState: stateAt(6),
				events: [eventFor(6, 'not-ready')]
			})
		).rejects.toThrow(CommitNotReadyError);
		expect(db.getSession('ROOM42')!.revision).toBe(5);
		expect(db.rowsFor('play_game_session_events')).toHaveLength(0);

		// The EXPLICIT opt-in (param or ARC_ALLOW_NONATOMIC_COMMIT=1) restores the
		// pre-migration fallback for local/test use.
		const optedIn = await commitRoomMutation(
			db,
			{ session: sessionRef(db), nextState: stateAt(6), events: [eventFor(6, 'opted-in')] },
			{ allowNonAtomicFallback: true }
		);
		expect(optedIn.outcome).toBe('committed');
		expect(db.getSession('ROOM42')!.revision).toBe(6);
	});

	test('RPC mode: a crash cannot separate the state write from its ledger row', async () => {
		const db = new FakePlayDb({ rpc: true });
		seed(db);
		// In RPC mode the ledger insert is inside the same transaction — the injected
		// event-insert failure path is unreachable (no separate statement to fail).
		db.failNextEventInsert = 1;
		const outcome = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6, 'atomic')]
		});
		expect(outcome.outcome).toBe('committed');
		expect(db.rowsFor('play_game_session_events')).toHaveLength(1);
	});

	test('fallback mode (opted in): a lost ledger write is surfaced, never silent (documented residual)', async () => {
		process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
		const db = new FakePlayDb({ rpc: false });
		seed(db);
		db.failNextEventInsert = 2; // first attempt + its one retry
		const outcome = await commitRoomMutation(db, {
			session: sessionRef(db),
			nextState: stateAt(6),
			events: [eventFor(6, 'lost-marker')]
		});
		// State IS durable; the idempotency marker for this one command is lost and the
		// commit says so — the exact residual the 20260710 RPC migration closes.
		expect(outcome.outcome).toBe('committed');
		expect(outcome.outcome === 'committed' && outcome.ledgerWriteFailed).toBe(true);
		expect(db.getSession('ROOM42')!.revision).toBe(6);
	});
});
