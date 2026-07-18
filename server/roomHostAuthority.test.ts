/**
 * P0 multiplayer authority & recovery — the acceptance suite for the durable
 * write-through room server. Runs the REAL RoomHost + the REAL shared commit
 * protocol against the in-memory Postgres fake (src/lib/play/server/fakePlayDb.ts),
 * in BOTH commit modes (pre-migration CAS fallback and the 20260710 atomic RPC).
 *
 * What is proven here, mapped to the batch outcome:
 *  1. one durable monotonically revisioned history (no fork, no stale/equal-revision
 *     overwrite) across two live instances + a simulated serverless HTTP writer;
 *  2. cmdId is a durable exactly-once boundary — retry after ack loss, across
 *     restart, and across a WS→HTTP transport fallback;
 *  3. bots/deadline enforcement/room close are single-winner fenced;
 *  4. deterministic engine semantics + identical (revision, stateHash) for mixed
 *     transports; spectator privacy preserved;
 *  5. restart/reconnect recovery converges on the durable truth;
 *  6. measured command-ack latency (the durability floor), printed for the tester.
 */
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { RoomHost, type RoomHostDeps } from './roomHost';
import { buildViewForViewer } from './view';
import { stampPhaseDeadline, applyNavLockDeadline } from './deadline';
import type { PlaySessionRow } from './supabase';
import {
	applyGameCommand,
	buildSessionProjection,
	createLobbyState,
	cloneState,
	ensureStateShape,
	resolvePassedDeadline
} from '../src/lib/play/runtime';
import { hashGameState } from '../src/lib/play/stateHash';
import {
	commitRoomMutation,
	committedCmdMatches,
	findCommittedCmd,
	resetCommitRpcProbe,
	type CommitEvent
} from '../src/lib/play/server/commit';
import {
	computeRequiredEffects,
	drainEffectsOutbox,
	effectsOutboxEvent,
	EFFECTS_COMMAND_TYPE
} from '../src/lib/play/server/effectsOutbox';
import { finalizeMatchWith } from '../src/lib/play/server/matchFinalize';
import { writeHistorySnapshotsWith } from '../src/lib/play/server/historySnapshots';
import { FakePlayDb, jsonbNormalize } from '../src/lib/play/server/fakePlayDb';
import { SEAT_COLORS } from '../src/lib/play/types';
import type {
	GameActor,
	GameCommand,
	PlayCatalog,
	PublicGameState
} from '../src/lib/play/types';

// The pre-migration (non-RPC) commit mode is an EXPLICIT opt-in now — these suites
// exercise it deliberately (migration tests); the readiness test below clears it.
process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';

// ── fixtures (mirrors deadlineEnforcement.test.ts) ────────────────────────────────

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 30 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: 2,
		classes: {},
		origins: {}
	})),
	locations: []
} as unknown as PlayCatalog;

const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };
const GUEST: GameActor = {
	memberId: 'm-guest',
	displayName: 'Guest',
	role: 'player',
	seatColor: null
};
const RED: GameActor = { ...HOST, seatColor: 'Red' };
const BLUE: GameActor = { ...GUEST, seatColor: 'Blue' };

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}

function startedGame(seed = 1): PublicGameState {
	let state = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
	state = apply(state, HOST, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, GUEST, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Myrtle' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Nyra' });
	state = apply(state, RED, { type: 'startGame', seed });
	return state;
}

/** RoomHost deps bound to a FakePlayDb (deep-cloning reads like a real fetch). */
function depsFor(db: FakePlayDb): RoomHostDeps {
	return {
		db: () => db,
		historyDb: () => db,
		getSessionByRoomCode: async (roomCode: string) => {
			const row = db.getSession(roomCode);
			return row ? (structuredClone(row) as unknown as PlaySessionRow) : null;
		},
		getSessionRevision: async (sessionId: string) => {
			const row = db.rowsFor('play_game_sessions').find((r) => r.id === sessionId);
			return row ? { revision: row.revision, status: row.status } : null;
		},
		loadBotMembers: async (sessionId: string) =>
			new Map(
				db
					.rowsFor('play_session_members')
					.filter((m) => m.session_id === sessionId && m.is_bot)
					.map((m) => [m.id as string, (m.bot_profile as string | null) ?? null])
			),
		loadCatalog: async () => CATALOG
	};
}

function seedRoom(db: FakePlayDb, state: PublicGameState) {
	const session = db.seedSession({
		room_code: state.roomCode,
		status: state.status,
		revision: state.revision,
		public_state: state,
		started_at: state.status === 'active' ? new Date().toISOString() : null
	});
	db.seedMember({ id: 'm-host', session_id: session.id, display_name: 'Host', role: 'host' });
	db.seedMember({ id: 'm-guest', session_id: session.id, display_name: 'Guest', role: 'player' });
	return session;
}

async function loadHost(db: FakePlayDb): Promise<RoomHost> {
	const host = await RoomHost.load('ROOM42', depsFor(db));
	if (!host) throw new Error('room not found');
	return host;
}

/**
 * The serverless HTTP path, simulated 1:1 over the SAME shared modules service.ts
 * uses: per-attempt identity-bound cmdId dedup (+ recovery drain) → per-attempt actor
 * re-derivation from the fresh state (state is the sole seat authority) → engine
 * apply → deadline stamps → shared commit with the effects outbox riding it →
 * post-commit drain. Duplicates answer the CURRENT head + duplicateOfRevision,
 * exactly like runRoomCommand's current-view answer.
 */
async function httpRunCommand(
	db: FakePlayDb,
	roomCode: string,
	actor: GameActor,
	command: GameCommand,
	cmdId: string | null = null
): Promise<{ revision: number; duplicate?: boolean; duplicateOfRevision?: number }> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const session = structuredClone(db.getSession(roomCode)!);
		const state = ensureStateShape(session.public_state as PublicGameState);
		if (cmdId) {
			const committed = await findCommittedCmd(db, session.id, cmdId);
			if (committed) {
				const matches = committedCmdMatches(committed, {
					commandType: command.type,
					payload: command,
					actorMemberId: actor.memberId,
					revision: committed.revision,
					cmdId
				});
				if (!matches) throw new Error('idempotency_conflict');
				await drainEffectsOutbox(db, db, session.id, state);
				return { revision: session.revision, duplicate: true, duplicateOfRevision: committed.revision };
			}
		}
		// Fresh actor per attempt: the state's seats map is the sole seat authority.
		const liveActor: GameActor = {
			...actor,
			seatColor: SEAT_COLORS.find((seat) => state.seats[seat]?.memberId === actor.memberId) ?? null
		};
		const result = applyGameCommand(state, liveActor, command, CATALOG);
		if (!result.ok) throw new Error(result.error.message);
		const next = result.state;
		stampPhaseDeadline(next);
		applyNavLockDeadline(next);
		const events: CommitEvent[] = [
			{
				commandType: command.type,
				payload: command,
				actorMemberId: actor.memberId,
				revision: next.revision,
				cmdId
			}
		];
		const outbox = effectsOutboxEvent(
			next.revision,
			computeRequiredEffects({
				prev: state,
				next,
				command,
				session: {
					id: session.id,
					game_id: next.gameId,
					mode: (session.mode as 'casual' | 'ranked') ?? 'casual',
					started_at: session.started_at,
					ended_at: session.ended_at
				},
				timestamp: new Date().toISOString()
			})
		);
		if (outbox) events.push(outbox);
		const outcome = await commitRoomMutation(db, {
			session: {
				id: session.id,
				revision: session.revision,
				started_at: session.started_at,
				ended_at: session.ended_at
			},
			nextState: next,
			events
		});
		if (outcome.outcome === 'idempotency_conflict') throw new Error('idempotency_conflict');
		if (outcome.outcome === 'committed') {
			await drainEffectsOutbox(db, db, session.id, next);
			return { revision: next.revision };
		}
		// cas_miss / duplicate → reload + re-check the ledger on the next attempt.
	}
	throw new Error('conflict: retries exhausted');
}

function dbProjectionHash(db: FakePlayDb, roomCode: string): { revision: number; hash: string } {
	// A serverless reader: fresh parse of the jsonb row (key order already shuffled by
	// the fake's jsonbNormalize), projected exactly like loadRoomView.
	const row = structuredClone(db.getSession(roomCode)!);
	const projection = buildSessionProjection(row.public_state as PublicGameState, {
		role: 'spectator',
		seatColor: null,
		displayName: null
	});
	return { revision: projection.revision, hash: projection.stateHash! };
}

function redVp(db: FakePlayDb): number {
	const row = db.getSession('ROOM42')!;
	return (row.public_state as PublicGameState).players.Red?.victoryPoints ?? -1;
}

const VP: GameCommand = { type: 'adjustVictoryPoints', amount: 1 };

// ── the suites, in both commit modes ──────────────────────────────────────────────

describe.each([
	{ label: 'fallback commit (pre-migration)', rpc: false },
	{ label: 'atomic RPC commit (20260710 applied)', rpc: true }
])('$label', ({ rpc }) => {
	let db: FakePlayDb;
	let baseState: PublicGameState;
	let minRevisionSeen: number;

	beforeEach(() => {
		resetCommitRpcProbe();
		db = new FakePlayDb({ rpc });
		baseState = startedGame(7);
		seedRoom(db, baseState);
		// Fencing invariant: the durable revision must NEVER decrease, no matter which
		// writer (command, tick, close, recovery) lands.
		minRevisionSeen = baseState.revision;
		db.onRowUpdated = (table, row) => {
			if (table !== 'play_game_sessions') return;
			expect(row.revision).toBeGreaterThanOrEqual(minRevisionSeen);
			minRevisionSeen = row.revision;
		};
	});

	test('ack is durable: process kill after ack loses nothing (restart recovery)', async () => {
		const hostA = await loadHost(db);
		const outcome = await hostA.applyCommand(RED, VP, 'cmd-1');
		expect(outcome.ok).toBe(true);
		const ackedRevision = outcome.ok ? outcome.revision : -1;

		// "kill -9": drop the instance without any flush/shutdown path.
		const hostB = await loadHost(db);
		expect(hostB.getRevision()).toBe(ackedRevision);
		expect(hashGameState(hostB.getState())).toBe(hashGameState(db.getSession('ROOM42')!.public_state));
		expect(redVp(db)).toBe(baseState.players.Red!.victoryPoints + 1);
	});

	test('ranked tick adopts a disconnect takeover before any further server authority work', async () => {
		const session = db.getSession('ROOM42')!;
		session.mode = 'ranked';
		db.seedMember({
			id: 'm-stale',
			session_id: session.id,
			user_id: 'u-stale',
			display_name: 'Disconnected player',
			role: 'player'
		});

		let takeoverCalls = 0;
		const deps: RoomHostDeps = {
			...depsFor(db),
			takeOverRankedDisconnects: async (sessionId) => {
				takeoverCalls += 1;
				expect(sessionId).toBe(session.id);
				if (takeoverCalls > 1) return 0;

				const stale = db.rowsFor('play_session_members').find((row) => row.id === 'm-stale')!;
				stale.is_bot = true;
				stale.bot_profile = 'ranked_disconnect';
				const state = structuredClone(session.public_state) as PublicGameState;
				state.revision += 1;
				session.public_state = jsonbNormalize(state);
				session.revision = state.revision;
				return 1;
			}
		};

		const host = await RoomHost.load('ROOM42', deps);
		if (!host) throw new Error('room not found');
		const before = host.getRevision();
		const advanced = await host.runTick();

		expect(takeoverCalls).toBe(1);
		expect(advanced).toBe(true);
		expect(host.getRevision()).toBe(before + 1);
		expect(host.getBotMembers().get('m-stale')).toBe('ranked_disconnect');
	});

	test('duplicate cmdId after ack loss: same instance, across restart, and across WS→HTTP fallback — applied exactly once', async () => {
		const vpBefore = redVp(db);
		const hostA = await loadHost(db);
		const first = await hostA.applyCommand(RED, VP, 'retry-1');
		expect(first.ok && first.revision).toBe(baseState.revision + 1);

		// Duplicate answers carry the CURRENT head as `revision` (matching the view the
		// ack pairs with) and the original commit as `duplicateOfRevision`. With no
		// interleaved commits both equal the original here.
		// (a) same instance — the ack was lost, client resends on the same socket.
		const sameInstance = await hostA.applyCommand(RED, VP, 'retry-1');
		expect(sameInstance.ok && sameInstance.revision).toBe(baseState.revision + 1);
		expect(sameInstance.ok && sameInstance.duplicateOfRevision).toBe(baseState.revision + 1);

		// (b) across a server restart — in-memory memo gone, durable ledger answers.
		const hostB = await loadHost(db);
		const afterRestart = await hostB.applyCommand(RED, VP, 'retry-1');
		expect(afterRestart.ok && afterRestart.revision).toBe(baseState.revision + 1);
		expect(afterRestart.ok && afterRestart.duplicate).toBe(true);
		expect(afterRestart.ok && afterRestart.duplicateOfRevision).toBe(baseState.revision + 1);

		// (c) WS→HTTP fallback — the retry reaches the OTHER transport.
		const viaHttp = await httpRunCommand(db, 'ROOM42', RED, VP, 'retry-1');
		expect(viaHttp).toEqual({
			revision: baseState.revision + 1,
			duplicate: true,
			duplicateOfRevision: baseState.revision + 1
		});

		expect(redVp(db)).toBe(vpBefore + 1); // exactly once, ever.
	});

	test('LATE duplicate retry: ack pairs the CURRENT revision/view with an explicit duplicateOfRevision', async () => {
		const hostA = await loadHost(db);
		const original = await hostA.applyCommand(RED, VP, 'late-dup');
		expect(original.ok).toBe(true);
		const originalRev = original.ok ? original.revision : -1;

		// Several unrelated commits land AFTER it (both transports).
		await hostA.applyCommand(BLUE, VP, 'late-x1');
		await httpRunCommand(db, 'ROOM42', RED, VP, 'late-x2');
		await hostA.applyCommand(BLUE, VP, 'late-x3');
		const head = db.getSession('ROOM42')!.revision;
		expect(head).toBeGreaterThan(originalRev);

		// Same instance (in-memory memo): NEVER the original revision with a current
		// view — the protocol invariant is revision === view.projection.revision.
		const memoDup = await hostA.applyCommand(RED, VP, 'late-dup');
		expect(memoDup.ok && memoDup.revision).toBe(head);
		expect(memoDup.ok && memoDup.duplicateOfRevision).toBe(originalRev);
		expect(hostA.getRevision()).toBe(head); // the view the ack would carry

		// Across a restart (durable ledger path).
		const hostB = await loadHost(db);
		const restartDup = await hostB.applyCommand(RED, VP, 'late-dup');
		expect(restartDup.ok && restartDup.revision).toBe(head);
		expect(restartDup.ok && restartDup.duplicate).toBe(true);
		expect(restartDup.ok && restartDup.duplicateOfRevision).toBe(originalRev);
		expect(hostB.getRevision()).toBe(head);

		// WS→HTTP fallback: same coherent answer (runRoomCommand returns the CURRENT view).
		const httpDup = await httpRunCommand(db, 'ROOM42', RED, VP, 'late-dup');
		expect(httpDup).toEqual({ revision: head, duplicate: true, duplicateOfRevision: originalRev });

		// Applied exactly once, ever.
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_payload?.cmdId === 'late-dup')
		).toHaveLength(1);
		expect(db.getSession('ROOM42')!.revision).toBe(head);
	});

	test('cmdId is BOUND to its original identity: mismatched re-use rejects on every path', async () => {
		const hostA = await loadHost(db);
		const first = await hostA.applyCommand(RED, VP, 'ident-1');
		expect(first.ok).toBe(true);
		const headAfter = db.getSession('ROOM42')!.revision;

		// (a) same instance, different ACTOR under the committed cmdId (memo path).
		const memoConflict = await hostA.applyCommand(BLUE, VP, 'ident-1');
		expect(memoConflict.ok).toBe(false);
		expect(!memoConflict.ok && memoConflict.error.code).toBe('idempotency_conflict');

		// (b) across a restart, different PAYLOAD (durable ledger path).
		const hostB = await loadHost(db);
		const restartConflict = await hostB.applyCommand(
			RED,
			{ type: 'adjustVictoryPoints', amount: 5 } as GameCommand,
			'ident-1'
		);
		expect(restartConflict.ok).toBe(false);
		expect(!restartConflict.ok && restartConflict.error.code).toBe('idempotency_conflict');

		// (c) cross-transport: the HTTP path rejects the mismatched re-use too.
		await expect(httpRunCommand(db, 'ROOM42', BLUE, VP, 'ident-1')).rejects.toThrow(
			/idempotency_conflict/
		);

		// (d) CONCURRENT: two different commands race one fresh cmdId from two
		// instances — exactly one applies, the other must conflict (never both).
		const hostC = await loadHost(db);
		const [x, y] = await Promise.all([
			hostB.applyCommand(RED, VP, 'ident-race'),
			hostC.applyCommand(BLUE, VP, 'ident-race')
		]);
		const applied = [x, y].filter((o) => o.ok && !o.duplicate);
		const conflicted = [x, y].filter((o) => !o.ok);
		expect(applied).toHaveLength(1);
		expect(conflicted).toHaveLength(1);
		expect(!conflicted[0].ok && conflicted[0].error.code).toBe('idempotency_conflict');
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_payload?.cmdId === 'ident-race')
		).toHaveLength(1);

		// Nothing was ever silently substituted: ident-1 committed exactly once.
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_payload?.cmdId === 'ident-1')
		).toHaveLength(1);
		expect(db.getSession('ROOM42')!.revision).toBe(headAfter + 1); // + the race winner
	});

	test('a stale/forged seat identity is never authorized: the state is the sole seat authority', async () => {
		const hostA = await loadHost(db);
		const vpBefore = redVp(db);

		// The stale-mirror vector: a member row (or a poisoned connection) claims
		// seatColor 'Red' while the AUTHORITATIVE state seats m-host there. The old
		// code trusted the presented seatColor (and viewerForMember's member.seat_color
		// fallback), so this command would have adjusted the REAL Red player's VP.
		const FORGED: GameActor = {
			memberId: 'm-ghost',
			displayName: 'Ghost',
			role: 'player',
			seatColor: 'Red' // forged/stale — the state does not seat m-ghost
		};
		const forged = await hostA.applyCommand(FORGED, VP, 'forged-seat');
		expect(forged.ok).toBe(false);
		expect(!forged.ok && forged.error.code).toBe('illegal_command');
		expect(redVp(db)).toBe(vpBefore); // the seated player's VP untouched
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_payload?.cmdId === 'forged-seat')
		).toHaveLength(0);

		// Same over the HTTP harness (per-attempt re-derivation from fresh state).
		await expect(httpRunCommand(db, 'ROOM42', FORGED, VP, 'forged-seat-http')).rejects.toThrow();
		expect(redVp(db)).toBe(vpBefore);
	});

	test('two-instance seat race: a release/takeover on newer state defeats the stale seat on CAS retry', async () => {
		// Seats change in the LOBBY, so the race is staged there: hostA's cache goes
		// stale while another instance releases the seat and a third member takes it.
		const lobbyDb = new FakePlayDb({ rpc });
		const lobby = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
		seedRoom(lobbyDb, lobby);
		lobbyDb.seedMember({ id: 'm-third', session_id: lobbyDb.getSession('ROOM42')!.id, display_name: 'Third', role: 'player' });

		const hostA = await loadHost(lobbyDb); // will go stale
		const hostB = await loadHost(lobbyDb);

		// hostA seats m-host on Red (both caches see it after hostB converges).
		expect((await hostA.applyCommand(HOST, { type: 'claimSeat', seatColor: 'Red' }, 'race-claim')).ok).toBe(true);
		await hostB.ensureFresh();

		// On the NEWER history via hostB: m-host releases Red, m-third takes it over.
		expect((await hostB.applyCommand(HOST, { type: 'releaseSeat' } as GameCommand, 'race-release')).ok).toBe(true);
		const THIRD: GameActor = { memberId: 'm-third', displayName: 'Third', role: 'player', seatColor: null };
		expect((await hostB.applyCommand(THIRD, { type: 'claimSeat', seatColor: 'Red' }, 'race-takeover')).ok).toBe(true);

		// hostA still caches m-host on Red. Its seat-scoped command applies against the
		// stale cache, CAS-misses, reloads — and must re-derive the actor from the
		// fresh state (m-host unseated ⇒ reject). It must NEVER touch the seat that
		// now belongs to m-third.
		const stale = await hostA.applyCommand(
			RED, // carries the stale seatColor 'Red' — advisory only
			{ type: 'selectGuardian', guardianName: 'Myrtle' } as GameCommand,
			'race-stale'
		);
		expect(stale.ok).toBe(false);
		expect(!stale.ok && stale.error.code).toBe('illegal_command');

		const finalRow = lobbyDb.getSession('ROOM42')!;
		const finalState = finalRow.public_state as PublicGameState;
		expect(finalState.seats.Red!.memberId).toBe('m-third'); // takeover intact
		expect(finalState.seats.Red!.selectedGuardian).toBeNull(); // never mutated by the stale actor
		expect(
			lobbyDb.rowsFor('play_game_session_events').filter((e) => e.command_payload?.cmdId === 'race-stale')
		).toHaveLength(0);
	});

	test('SIGKILL between commit and effects: the durable outbox recovers mirrors, match records, and round history', async () => {
		// Simulate the crashed writer: commit state + ledger + OUTBOX atomically (what
		// a real writer does), then die before running ANY effect.
		const row = db.getSession('ROOM42')!;
		const prev = ensureStateShape(structuredClone(row.public_state)) as PublicGameState;
		const next = cloneState(prev);
		next.revision = prev.revision + 1;
		next.status = 'finished';
		next.winnerSeat = 'Red';
		next.seats.Blue!.memberId = null; // seat change ⇒ a member-mirror is owed
		const effects = computeRequiredEffects({
			prev,
			next,
			command: null,
			session: {
				id: row.id,
				game_id: next.gameId,
				mode: 'casual',
				started_at: row.started_at,
				ended_at: null
			},
			roundStates: [prev], // a round crossed this commit ⇒ history snapshots owed
			timestamp: '2026-07-10T12:00:00.000Z'
		});
		expect(effects.map((e) => e.kind).sort()).toEqual([
			'historySnapshots',
			'matchFinalize',
			'memberMirrors',
			'replayFrame'
		]);
		const events: CommitEvent[] = [
			{
				commandType: 'adjustVictoryPoints',
				payload: VP,
				actorMemberId: 'm-host',
				revision: next.revision,
				cmdId: 'crash-1'
			},
			effectsOutboxEvent(next.revision, effects)!
		];
		// Give the Blue member a stale mirror so recovery visibly repairs it.
		const blueMember = db.rowsFor('play_session_members').find((m) => m.id === 'm-guest')!;
		blueMember.seat_color = 'Blue';
		const outcome = await commitRoomMutation(db, {
			session: { id: row.id, revision: prev.revision, started_at: row.started_at, ended_at: row.ended_at },
			nextState: next,
			events
		});
		expect(outcome.outcome).toBe('committed');
		// ← SIGKILL here: no effect ran, but what is owed is already durable.
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('game_state_snapshots')).toHaveLength(0);
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(1);

		// Recovery: a fresh instance load drains the outbox.
		await loadHost(db);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_result_players').length).toBeGreaterThan(0);
		expect(db.rowsFor('game_state_snapshots').length).toBeGreaterThan(0);
		expect(db.rowsFor('replay_codes')).toHaveLength(1);
		expect(blueMember.seat_color).toBeNull(); // mirror repaired from durable state
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(0); // outbox settled

		// Exactly once: further drains/loads re-run nothing.
		const snapshotCount = db.rowsFor('game_state_snapshots').length;
		await loadHost(db);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('game_state_snapshots')).toHaveLength(snapshotCount);
		expect(db.rowsFor('replay_codes')).toHaveLength(1);
	});

	test('a duplicate retry (either transport) finishes the crashed writer\'s owed effects before answering', async () => {
		// hostA is already live BEFORE the crash (so its load-time drain saw nothing).
		const hostA = await loadHost(db);

		const row = db.getSession('ROOM42')!;
		const prev = ensureStateShape(structuredClone(row.public_state)) as PublicGameState;
		const next = cloneState(prev);
		next.revision = prev.revision + 1;
		next.status = 'finished';
		next.winnerSeat = 'Red';
		const effects = computeRequiredEffects({
			prev,
			next,
			command: null,
			session: { id: row.id, game_id: next.gameId, mode: 'casual', started_at: row.started_at, ended_at: null },
			timestamp: '2026-07-10T12:00:00.000Z'
		});
		const outcome = await commitRoomMutation(db, {
			session: { id: row.id, revision: prev.revision, started_at: row.started_at, ended_at: row.ended_at },
			nextState: next,
			events: [
				{ commandType: 'adjustVictoryPoints', payload: VP, actorMemberId: 'm-host', revision: next.revision, cmdId: 'crash-2' },
				effectsOutboxEvent(next.revision, effects)!
			]
		});
		expect(outcome.outcome).toBe('committed');
		expect(db.rowsFor('match_results')).toHaveLength(0); // writer died pre-effects

		// The client retries its lost ack against ANOTHER instance (hostA): the
		// duplicate answer must first finish what the dead writer owed.
		const retry = await hostA.applyCommand(RED, VP, 'crash-2');
		expect(retry.ok && retry.duplicate).toBe(true);
		expect(retry.ok && retry.duplicateOfRevision).toBe(next.revision);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(0);
	});

	test('readiness: without the atomic RPC and without the opt-in, commands fail closed as store_not_ready', async () => {
		if (rpc) return; // only meaningful for the pre-migration store
		delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
		try {
			const host = await loadHost(db);
			const outcome = await host.applyCommand(RED, VP, 'nr-1');
			expect(outcome.ok).toBe(false);
			expect(!outcome.ok && outcome.error.code).toBe('store_not_ready');
			expect(!outcome.ok && outcome.error.message).toMatch(/20260710_command_ledger/);
			// NOTHING was written or acknowledged.
			expect(db.getSession('ROOM42')!.revision).toBe(baseState.revision);
			expect(db.rowsFor('play_game_session_events')).toHaveLength(0);
		} finally {
			process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
		}
	});

	test('simultaneous commands from two instances + HTTP linearize on one history', async () => {
		const hostA = await loadHost(db);
		const hostB = await loadHost(db);
		const vpBefore = redVp(db);

		const [a, b, c] = await Promise.all([
			hostA.applyCommand(RED, VP, 'sim-a'),
			hostB.applyCommand(BLUE, VP, 'sim-b'),
			httpRunCommand(db, 'ROOM42', RED, VP, 'sim-c')
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(c.revision).toBeGreaterThan(baseState.revision);

		// One linear history: three commits, distinct consecutive revisions.
		const row = db.getSession('ROOM42')!;
		expect(row.revision).toBe(baseState.revision + 3);
		const revs = [a.ok && a.revision, b.ok && b.revision, c.revision].sort();
		expect(new Set(revs).size).toBe(3);
		expect(redVp(db)).toBe(vpBefore + 2); // two RED adjusts, one BLUE

		// Both instances converge on the durable truth.
		await hostA.ensureFresh();
		await hostB.ensureFresh();
		expect(hostA.getRevision()).toBe(row.revision);
		expect(hashGameState(hostA.getState())).toBe(hashGameState(hostB.getState()));
	});

	test('a stale instance can never roll the room back (fencing + convergence)', async () => {
		const hostA = await loadHost(db); // becomes stale
		const hostB = await loadHost(db);
		await hostB.applyCommand(RED, VP, 'b-1');
		await hostB.applyCommand(BLUE, VP, 'b-2');

		// hostA still holds baseRevision in memory; its next command must NOT clobber
		// hostB's commits — it reloads, re-applies on top, and extends the history.
		const outcome = await hostA.applyCommand(RED, VP, 'a-1');
		expect(outcome.ok && outcome.revision).toBe(baseState.revision + 3);
		expect(redVp(db)).toBe(baseState.players.Red!.victoryPoints + 2); // b-1 + a-1
		// the onRowUpdated monotonicity assertion has been active throughout.
	});

	test('mixed transports see the SAME revision and state hash (jsonb round-trip safe)', async () => {
		const hostA = await loadHost(db);
		await hostA.applyCommand(RED, VP, 'mix-1');

		// WS view (in-memory object) vs HTTP view (fresh jsonb parse, keys re-sorted).
		const wsProjection = buildSessionProjection(hostA.getState(), {
			role: 'spectator',
			seatColor: null,
			displayName: null
		});
		const http = dbProjectionHash(db, 'ROOM42');
		expect(wsProjection.revision).toBe(http.revision);
		expect(wsProjection.stateHash).toBe(http.hash);
	});

	test('room close is fenced: a late command cannot reopen or regress the room', async () => {
		const hostA = await loadHost(db);

		// The HTTP lifecycle sweep closes the room (CAS write, revision bump) while the
		// WS host still holds an 'active' cache.
		const row = db.getSession('ROOM42')!;
		const closed = cloneState(ensureStateShape(structuredClone(row.public_state)));
		closed.status = 'closed';
		closed.revision = row.revision + 1;
		const closeOutcome = await commitRoomMutation(db, {
			session: { id: row.id, revision: row.revision, started_at: row.started_at, ended_at: row.ended_at },
			nextState: closed,
			events: [
				{ commandType: 'closeRoom', payload: { reason: 'abandoned' }, actorMemberId: null, revision: closed.revision }
			]
		});
		expect(closeOutcome.outcome).toBe('committed');

		// The stale WS host's command: CAS-miss → reload → sees closed → coherent reject.
		const late = await hostA.applyCommand(RED, VP, 'late-1');
		expect(late.ok).toBe(false);
		expect(!late.ok && late.error.code).toBe('room_closed');
		expect(db.getSession('ROOM42')!.status).toBe('closed');
		expect(db.getSession('ROOM42')!.revision).toBe(closed.revision); // no regress

		// Reopen-as-reload converges on the closed truth (no zombie 'active' cache).
		const hostB = await loadHost(db);
		expect(hostB.getStatus()).toBe('closed');
	});

	test('deadline enforcement is single-winner across the WS tick and the HTTP poller', async () => {
		// Expire the navigation deadline in the durable state.
		const row = db.getSession('ROOM42')!;
		const expired = ensureStateShape(structuredClone(row.public_state)) as PublicGameState;
		expired.phaseDeadline = Date.now() - 5_000;
		expired.navigationDeadline = expired.phaseDeadline;
		row.public_state = jsonbNormalize(expired);

		const hostA = await loadHost(db);
		const before = hostA.getRevision();

		// The HTTP-side enforcement (maybeEnforceDeadline's core), racing the WS tick.
		const httpEnforce = async () => {
			const fresh = structuredClone(db.getSession('ROOM42')!);
			const state = ensureStateShape(fresh.public_state as PublicGameState);
			if (state.phaseDeadline == null || Date.now() <= state.phaseDeadline) return;
			resolvePassedDeadline(state, CATALOG, Date.now(), []);
			stampPhaseDeadline(state);
			await commitRoomMutation(db, {
				session: { id: fresh.id, revision: fresh.revision, started_at: fresh.started_at, ended_at: fresh.ended_at },
				nextState: state,
				events: [
					{ commandType: 'enforceDeadline', payload: { type: 'enforceDeadline' }, actorMemberId: null, revision: state.revision }
				]
			}); // cas_miss ⇒ the tick won; no second advance.
		};

		await Promise.all([hostA.runTick(), httpEnforce()]);

		const after = db.getSession('ROOM42')!;
		expect(after.revision).toBe(before + 1); // exactly ONE advance won
		const enforceEvents = db
			.rowsFor('play_game_session_events')
			.filter((event) => event.command_type === 'enforceDeadline');
		expect(enforceEvents).toHaveLength(1);
		// And the host cache converged on whatever won.
		expect(hostA.getRevision()).toBe(after.revision);
	});

	test('HTTP-committed mutations reach the WS host cache (freshness convergence)', async () => {
		const hostA = await loadHost(db);
		await httpRunCommand(db, 'ROOM42', BLUE, VP, 'http-1');
		expect(hostA.getRevision()).toBe(baseState.revision); // cache is behind…
		const advanced = await hostA.runTick(); // …tick converges (join/resync do too)
		expect(advanced).toBe(true);
		expect(hostA.getRevision()).toBe(baseState.revision + 1);
		expect(hashGameState(hostA.getState())).toBe(hashGameState(db.getSession('ROOM42')!.public_state));
	});

	test('WS claimSeat mirrors the member row (transport-parity side effect)', async () => {
		const lobbyDb = new FakePlayDb({ rpc });
		const lobby = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
		seedRoom(lobbyDb, lobby);
		const host = await loadHost(lobbyDb);
		const outcome = await host.applyCommand(HOST, { type: 'claimSeat', seatColor: 'Red' }, 'seat-1');
		expect(outcome.ok).toBe(true);
		const member = lobbyDb.rowsFor('play_session_members').find((m) => m.id === 'm-host')!;
		expect(member.seat_color).toBe('Red');
		expect(member.role).toBe('host');
	});

	test('spectators never see owner-private state; owners do (privacy preserved)', async () => {
		const hostA = await loadHost(db);
		const state = hostA.getState();
		state.players.Red!.lastAction = { label: 'secret plan' } as never;

		const ownerView = buildViewForViewer(
			state,
			{ role: 'player', seatColor: 'Red', displayName: 'Host' },
			{ id: 'm-host', role: 'player', seatColor: 'Red', displayName: 'Host' },
			CATALOG,
			new Map()
		);
		const spectatorView = buildViewForViewer(
			state,
			{ role: 'spectator', seatColor: null, displayName: null },
			{ id: null, role: 'spectator', seatColor: null, displayName: null },
			CATALOG,
			new Map()
		);
		expect(ownerView.projection.players.Red?.lastAction).toEqual({ label: 'secret plan' });
		expect(spectatorView.projection.players.Red?.lastAction).toBeNull();
		// Same authoritative history for both viewers regardless of the redaction.
		expect(ownerView.projection.stateHash).toBe(spectatorView.projection.stateHash);
		expect(ownerView.projection.revision).toBe(spectatorView.projection.revision);
	});

	test('illegal and stale attempts reject coherently without corrupting later commands', async () => {
		const hostA = await loadHost(db);
		const bad = await hostA.applyCommand(
			{ ...GUEST, seatColor: null, memberId: 'm-nobody', displayName: 'X', role: 'spectator' },
			VP,
			'bad-1'
		);
		expect(bad.ok).toBe(false);
		expect(db.getSession('ROOM42')!.revision).toBe(baseState.revision); // nothing leaked

		const good = await hostA.applyCommand(RED, VP, 'good-after-bad');
		expect(good.ok && good.revision).toBe(baseState.revision + 1);
	});
});

// ── exactly-once terminal side effects (shared modules, both transports) ──────────

describe('exactly-once terminal/record side effects', () => {
	test('finalizeMatch records ONE match result across concurrent duplicate fires', async () => {
		const db = new FakePlayDb();
		const state = startedGame(3);
		const session = seedRoom(db, state);
		state.status = 'finished';
		state.winnerSeat = 'Red';

		const ref = {
			id: session.id as string,
			game_id: 'game-x',
			mode: 'casual' as const,
			started_at: session.started_at as string | null,
			ended_at: new Date().toISOString()
		};
		await Promise.all([
			finalizeMatchWith(db, ref, state),
			finalizeMatchWith(db, ref, state),
			finalizeMatchWith(db, ref, state)
		]);
		// Re-fire later (e.g. the other transport's recovery path) — still one record.
		await finalizeMatchWith(db, ref, state);
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_result_players')).toHaveLength(2);
	});

	test('RANKED finish: SIGKILL before effects, then two recovering instances drain — rated exactly once', async () => {
		// Production posture (finalize_match transaction available) + a ranked room
		// with attributable users on both seats.
		const db = new FakePlayDb({ rpc: true });
		const state = startedGame(5);
		const session = seedRoom(db, state);
		session.mode = 'ranked';
		db.rowsFor('play_session_members').find((m) => m.id === 'm-host')!.user_id = 'u-host';
		db.rowsFor('play_session_members').find((m) => m.id === 'm-guest')!.user_id = 'u-guest';

		// The dying writer: commit the finished transition + its effects outbox row
		// atomically, then never run an effect.
		const prev = ensureStateShape(structuredClone(session.public_state)) as PublicGameState;
		const next = cloneState(prev);
		next.revision = prev.revision + 1;
		next.status = 'finished';
		next.winnerSeat = 'Red';
		const effects = computeRequiredEffects({
			prev,
			next,
			command: null,
			session: { id: session.id, game_id: next.gameId, mode: 'ranked', started_at: session.started_at, ended_at: null },
			timestamp: '2026-07-10T12:00:00.000Z'
		});
		// NOTE: the terminal command in the ledger must be a LEGITIMATE rules command —
		// a rated transcript containing an integrity tool (e.g. adjustVictoryPoints)
		// is deliberately QUARANTINED by finalize (proven in the next test).
		const outcome = await commitRoomMutation(db, {
			session: { id: session.id, revision: prev.revision, started_at: session.started_at, ended_at: session.ended_at },
			nextState: next,
			events: [
				{ commandType: 'commitCleanup', payload: { type: 'commitCleanup' }, actorMemberId: 'm-host', revision: next.revision, cmdId: 'ranked-crash' },
				effectsOutboxEvent(next.revision, effects)!
			]
		});
		expect(outcome.outcome).toBe('committed');
		expect(db.rowsFor('match_results')).toHaveLength(0); // ← SIGKILL here

		// Recovery: two fresh instances load (and drain) concurrently.
		db.latencyMs = 2;
		await Promise.all([RoomHost.load('ROOM42', depsFor(db)), RoomHost.load('ROOM42', depsFor(db))]);
		db.latencyMs = 0;

		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_results')[0].rated).toBe(true);
		expect(db.rowsFor('match_result_players')).toHaveLength(2);
		expect(db.rowsFor('player_rating_events')).toHaveLength(2);
		for (const user of ['u-host', 'u-guest']) {
			const row = db.rowsFor('player_ratings').find((r) => r.user_id === user)!;
			expect(row.games_played).toBe(1); // never double-applied
		}
		expect(
			db.rowsFor('play_game_session_events').filter((e) => e.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(0); // outbox settled

		// A later drain re-runs nothing.
		await loadHost(db);
		expect(db.rowsFor('player_rating_events')).toHaveLength(2);
		expect(db.rowsFor('player_ratings').find((r) => r.user_id === 'u-host')!.games_played).toBe(1);
	});

	test('RANKED transcript containing a forbidden integrity command is QUARANTINED: recorded, never rated', async () => {
		const db = new FakePlayDb({ rpc: true });
		const state = startedGame(6);
		const session = seedRoom(db, state);
		session.mode = 'ranked';
		db.rowsFor('play_session_members').find((m) => m.id === 'm-host')!.user_id = 'u-host';
		db.rowsFor('play_session_members').find((m) => m.id === 'm-guest')!.user_id = 'u-guest';

		const prev = ensureStateShape(structuredClone(session.public_state)) as PublicGameState;
		const next = cloneState(prev);
		next.revision = prev.revision + 1;
		next.status = 'finished';
		next.winnerSeat = 'Red';
		const effects = computeRequiredEffects({
			prev,
			next,
			command: null,
			session: { id: session.id, game_id: next.gameId, mode: 'ranked', started_at: session.started_at, ended_at: null },
			timestamp: '2026-07-10T12:00:00.000Z'
		});
		// Somehow (a compromised path, a pre-cutover ledger) a forbidden integrity
		// command sits in the rated transcript.
		const outcome = await commitRoomMutation(db, {
			session: { id: session.id, revision: prev.revision, started_at: session.started_at, ended_at: session.ended_at },
			nextState: next,
			events: [
				{ commandType: 'adjustVictoryPoints', payload: VP, actorMemberId: 'm-host', revision: next.revision, cmdId: 'ranked-cheat' },
				effectsOutboxEvent(next.revision, effects)!
			]
		});
		expect(outcome.outcome).toBe('committed');

		await loadHost(db); // recovery drain runs finalize

		// Recorded for the players — but UNRATED and marked quarantined; no rating
		// rows or events exist and later drains never revisit the decision.
		expect(db.rowsFor('match_results')).toHaveLength(1);
		expect(db.rowsFor('match_results')[0].rated).toBe(false);
		expect(db.rowsFor('match_results')[0].quarantined).toBe(true);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		await loadHost(db);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
	});

	test('commitRound history snapshots upsert idempotently (one logical record set)', async () => {
		const db = new FakePlayDb();
		const state = startedGame(4);
		if (!state.gameId) throw new Error('started game must mint a gameId');
		await writeHistorySnapshotsWith(db, state, '2026-07-10T12:00:00.000Z');
		const rowsAfterFirst = db.rowsFor('game_state_snapshots').length;
		expect(rowsAfterFirst).toBeGreaterThan(0);
		await writeHistorySnapshotsWith(db, state, '2026-07-10T12:00:05.000Z');
		expect(db.rowsFor('game_state_snapshots')).toHaveLength(rowsAfterFirst);
		expect(db.rowsFor('replay_codes')).toHaveLength(1);
	});
});

// ── seeded transcript: transports are indistinguishable ───────────────────────────

describe('seeded transcript equivalence (WS host vs serverless HTTP)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('the same seeded command transcript yields identical (revision, stateHash) on both transports', async () => {
		const transcript: { actor: GameActor; command: GameCommand; cmdId: string }[] = [
			{ actor: HOST, command: { type: 'claimSeat', seatColor: 'Red' }, cmdId: 't-1' },
			{ actor: GUEST, command: { type: 'claimSeat', seatColor: 'Blue' }, cmdId: 't-2' },
			{ actor: RED, command: { type: 'selectGuardian', guardianName: 'Myrtle' }, cmdId: 't-3' },
			{ actor: BLUE, command: { type: 'selectGuardian', guardianName: 'Nyra' }, cmdId: 't-4' },
			{ actor: RED, command: { type: 'startGame', seed: 11 }, cmdId: 't-5' },
			{ actor: RED, command: { type: 'adjustVictoryPoints', amount: 2 }, cmdId: 't-6' },
			{ actor: BLUE, command: { type: 'adjustVictoryPoints', amount: 3 }, cmdId: 't-7' }
		];

		// Transport A: the WebSocket room host (write-through cache).
		const wsDb = new FakePlayDb({ rpc: true });
		seedRoom(wsDb, createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] }));
		const host = await loadHost(wsDb);
		const wsTrace: [number, string][] = [];
		for (const step of transcript) {
			const outcome = await host.applyCommand(step.actor, step.command, step.cmdId);
			expect(outcome.ok).toBe(true);
			wsTrace.push([
				outcome.ok ? outcome.revision : -1,
				hashGameState(wsDb.getSession('ROOM42')!.public_state)
			]);
		}

		// Transport B: the serverless HTTP path over the same shared commit.
		const httpDb = new FakePlayDb({ rpc: false });
		seedRoom(httpDb, createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] }));
		const httpTrace: [number, string][] = [];
		for (const step of transcript) {
			const result = await httpRunCommand(httpDb, 'ROOM42', step.actor, step.command, step.cmdId);
			httpTrace.push([
				result.revision,
				hashGameState(httpDb.getSession('ROOM42')!.public_state)
			]);
		}

		expect(wsTrace).toEqual(httpTrace);
	});
});

// ── measured ack latency (the durability floor) ───────────────────────────────────

describe('command-ack latency measurement (injected 4ms/statement store)', () => {
	async function measure(rpc: boolean): Promise<{ p50: number; p95: number }> {
		resetCommitRpcProbe();
		const db = new FakePlayDb({ rpc });
		db.latencyMs = 4;
		seedRoom(db, startedGame(9));
		const host = await loadHost(db);
		const samples: number[] = [];
		for (let i = 0; i < 25; i += 1) {
			const startedAt = performance.now();
			const outcome = await host.applyCommand(RED, VP, `lat-${rpc ? 'rpc' : 'fb'}-${i}`);
			expect(outcome.ok).toBe(true);
			samples.push(performance.now() - startedAt);
		}
		samples.sort((a, b) => a - b);
		return { p50: samples[12], p95: samples[23] };
	}

	test('ack latency = durable commit cost; RPC mode needs fewer store round-trips', async () => {
		const fallback = await measure(false);
		const rpcMode = await measure(true);
		// An ack can never be cheaper than ONE durable round-trip (that IS the point:
		// acknowledgement now means durability, not memory).
		expect(rpcMode.p50).toBeGreaterThanOrEqual(4);
		// Fallback = dedup SELECT + CAS UPDATE + ledger INSERT ⇒ ≥3 round-trips.
		expect(fallback.p50).toBeGreaterThanOrEqual(12);
		expect(rpcMode.p50).toBeLessThan(fallback.p50);
		console.log(
			`[latency] command→durable-ack over 4ms/statement store — ` +
				`fallback p50=${fallback.p50.toFixed(1)}ms p95=${fallback.p95.toFixed(1)}ms; ` +
				`RPC p50=${rpcMode.p50.toFixed(1)}ms p95=${rpcMode.p95.toFixed(1)}ms ` +
				`(migration cuts ~${(fallback.p50 - rpcMode.p50).toFixed(1)}ms/command)`
		);
	});
});
