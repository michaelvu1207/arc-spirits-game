/**
 * WebSocket boundary — adversarial acceptance for the ticket-authenticated join,
 * frame schema validation, immutable socket↔room binding, per-frame viewer
 * recomputation, and the shared deny-by-default command admission policy. Runs the
 * REAL RoomRegistry + RoomHost against the in-memory store fake and REAL ticket
 * mint/consume, with fake sockets standing in for `ws`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
	resolveWsAuthLeaseMs,
	RoomRegistry,
	WS_AUTH_LEASE_DEFAULT_MS,
	WS_AUTH_LEASE_MAX_MS,
	WS_AUTH_LEASE_MIN_MS,
	type RegistryDeps
} from './connections';
import { RoomHost, type RoomHostDeps } from './roomHost';
import type { PlaySessionRow, SessionMemberRow } from './supabase';
import { FakePlayDb } from '../src/lib/play/server/fakePlayDb';
import {
	consumeWsTicket,
	createWsTicket,
	WS_TICKET_TTL_MS
} from '../src/lib/play/server/wsTickets';
import { applyGameCommand, createLobbyState } from '../src/lib/play/runtime';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState } from '../src/lib/play/types';

process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';

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

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}

function startedGame(seed = 1): PublicGameState {
	let state = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
	state = apply(state, HOST, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, GUEST, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'selectGuardian', guardianName: 'Myrtle' }
	);
	state = apply(
		state,
		{ ...GUEST, seatColor: 'Blue' },
		{ type: 'selectGuardian', guardianName: 'Nyra' }
	);
	state = apply(state, { ...HOST, seatColor: 'Red' }, { type: 'startGame', seed });
	return state;
}

function hostDepsFor(db: FakePlayDb): RoomHostDeps {
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

function registryDepsFor(db: FakePlayDb): RegistryDeps {
	return {
		consumeWsTicket: (raw) => consumeWsTicket(db, raw),
		getMemberById: async (memberId) =>
			structuredClone(
				db.rowsFor('play_session_members').find((m) => m.id === memberId) ?? null
			) as SessionMemberRow | null,
		touchMemberLastSeen: async () => {},
		loadRoomHost: (roomCode) => RoomHost.load(roomCode, hostDepsFor(db))
	};
}

function seedRoom(db: FakePlayDb, state: PublicGameState, mode: 'casual' | 'ranked' = 'casual') {
	const session = db.seedSession({
		room_code: state.roomCode,
		status: state.status,
		revision: state.revision,
		public_state: state,
		mode,
		visibility: mode === 'ranked' ? 'private' : 'public',
		started_at: state.status === 'active' ? new Date().toISOString() : null
	});
	db.seedMember({
		id: 'm-host',
		session_id: session.id,
		display_name: 'Host',
		role: 'host',
		user_id: 'u-host'
	});
	db.seedMember({
		id: 'm-guest',
		session_id: session.id,
		display_name: 'Guest',
		role: 'player',
		user_id: 'u-guest'
	});
	return session;
}

/** Fake `ws` socket capturing outbound frames; tests inject inbound frames. */
class FakeWs {
	readonly OPEN = 1;
	readyState = 1;
	sent: Record<string, unknown>[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private handlers = new Map<string, ((data?: unknown) => void)[]>();

	on(event: string, cb: (data?: unknown) => void): void {
		const list = this.handlers.get(event) ?? [];
		list.push(cb);
		this.handlers.set(event, list);
	}
	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
		this.readyState = 3;
	}
	// test drivers
	async deliver(frame: unknown): Promise<void> {
		const raw = typeof frame === 'string' ? frame : JSON.stringify(frame);
		for (const cb of this.handlers.get('message') ?? []) await cb(Buffer.from(raw));
		await new Promise((r) => setTimeout(r, 0)); // let async handlers settle
	}
	frames(t: string): Record<string, unknown>[] {
		return this.sent.filter((f) => f.t === t);
	}
	last(t: string): Record<string, unknown> | undefined {
		return this.frames(t).at(-1);
	}
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error('condition never became true');
		await new Promise((r) => setTimeout(r, 5));
	}
}

let registry: RoomRegistry;

function attach(db: FakePlayDb): FakeWs {
	const ws = new FakeWs();
	registry.handleSocket(ws as unknown as WebSocket, {} as IncomingMessage);
	void db;
	return ws;
}

async function mintMemberTicket(
	db: FakePlayDb,
	sessionId: string,
	memberId: string,
	userId: string
) {
	const { ticket } = await createWsTicket(db, { sessionId, userId, memberId, role: 'member' });
	return ticket;
}

async function mintSpectatorTicket(db: FakePlayDb, sessionId: string) {
	const { ticket } = await createWsTicket(db, {
		sessionId,
		userId: 'u-watcher',
		memberId: null,
		role: 'spectator'
	});
	return ticket;
}

beforeEach(() => {
	delete process.env.ARC_WS_ALLOW_DEBUG_SEED;
	delete process.env.ARC_ALLOW_INTEGRITY_COMMANDS;
});

afterEach(async () => {
	await registry.shutdown();
});

describe('ticket-authenticated join', () => {
	test('a valid member ticket joins as the exact bound membership (seat + role + truthful metadata)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		const joined = ws.last('joined')!;
		expect(joined.seat).toBe('Red');
		expect(joined.role).toBe('host');
		const projection = (joined.view as { projection: Record<string, unknown> }).projection;
		expect(projection.mode).toBe('casual');
		expect(projection.visibility).toBe('public');
		expect(projection.rated).toBe(false);
		expect(registry.connectionCount('ROOM42')).toBe(1);
	});

	for (const [label, forge] of [
		['a public member UUID', async () => 'm-host'],
		['random junk', async () => 'pwt_not-a-real-ticket'],
		['a missing ticket', async () => undefined]
	] as const) {
		test(`${label} fails the join FATALLY — never a silent spectator downgrade`, async () => {
			const db = new FakePlayDb({ rpc: true });
			seedRoom(db, startedGame());
			registry = new RoomRegistry(registryDepsFor(db));
			const ws = attach(db);
			await ws.deliver({ t: 'join', roomCode: 'ROOM42', ticket: await forge() });
			await until(() => ws.frames('error').length === 1);
			const err = ws.last('error')!;
			expect(err.fatal).toBe(true);
			expect(ws.frames('joined')).toHaveLength(0);
			expect(ws.closed).not.toBeNull();
			expect(registry.connectionCount('ROOM42')).toBe(0);
		});
	}

	test('a REPLAYED ticket fails fatally (one-use, atomic consume)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ticket = await mintMemberTicket(db, session.id, 'm-host', 'u-host');
		const first = attach(db);
		await first.deliver({ t: 'join', roomCode: 'ROOM42', ticket });
		await until(() => first.frames('joined').length === 1);

		const replayer = attach(db);
		await replayer.deliver({ t: 'join', roomCode: 'ROOM42', ticket });
		await until(() => replayer.frames('error').length === 1);
		expect(replayer.last('error')!.fatal).toBe(true);
		expect(registry.connectionCount('ROOM42')).toBe(1); // only the legitimate join
	});

	test('an EXPIRED ticket fails fatally', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const { ticket } = await createWsTicket(db, {
			sessionId: session.id,
			userId: 'u-host',
			memberId: 'm-host',
			role: 'member'
		});
		// The DATABASE's clock passes the lifetime before the join arrives.
		db.dbClockOffsetMs = WS_TICKET_TTL_MS + 1;
		const ws = attach(db);
		await ws.deliver({ t: 'join', roomCode: 'ROOM42', ticket });
		await until(() => ws.frames('error').length === 1);
		expect(String(ws.last('error')!.message)).toContain('expired');
	});

	test('a WRONG-ROOM ticket fails fatally (exact session binding)', async () => {
		const db = new FakePlayDb({ rpc: true });
		seedRoom(db, startedGame());
		const other = db.seedSession({
			room_code: 'OTHER1',
			status: 'lobby',
			revision: 0,
			public_state: createLobbyState({ roomCode: 'OTHER1', guardianNames: ['Myrtle'] })
		});
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: (
				await createWsTicket(db, {
					sessionId: other.id,
					userId: 'u-host',
					memberId: 'm-host',
					role: 'member'
				})
			).ticket
		});
		await until(() => ws.frames('error').length === 1);
		expect(String(ws.last('error')!.message)).toContain('wrong room');
	});

	test('an ACCOUNT TRANSITION between mint and join drops authority (wrong-user binding)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ticket = await mintMemberTicket(db, session.id, 'm-host', 'u-host');
		// The membership changes hands (sign-out / account switch) before the join.
		db.rowsFor('play_session_members').find((m) => m.id === 'm-host')!.user_id = 'u-someone-else';
		const ws = attach(db);
		await ws.deliver({ t: 'join', roomCode: 'ROOM42', ticket });
		await until(() => ws.frames('error').length === 1);
		expect(String(ws.last('error')!.message)).toContain('no longer valid');
		expect(registry.connectionCount('ROOM42')).toBe(0);
	});

	test('a BOT-bound ticket fails fatally (bots are server-only actors)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		db.seedMember({
			id: 'm-bot',
			session_id: session.id,
			display_name: 'Mia',
			role: 'player',
			user_id: 'u-bot',
			is_bot: true
		});
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-bot', 'u-bot')
		});
		await until(() => ws.frames('error').length === 1);
		expect(ws.last('error')!.fatal).toBe(true);
	});
});

describe('socket ↔ room binding + frame schema', () => {
	test('a SECOND join is fatal and cannot leave the socket registered in the first room', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		expect(registry.connectionCount('ROOM42')).toBe(1);

		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-guest', 'u-guest')
		});
		await until(() => ws.frames('error').length === 1);
		expect(ws.last('error')!.code).toBe('already_joined');
		expect(registry.connectionCount('ROOM42')).toBe(0); // unregistered, closed
		expect(ws.closed).not.toBeNull();
	});

	test('SAME-TICK double join (the race): frames are serialized, so the socket can never cross-register in two rooms', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		const otherState = startedGame(2);
		const other = db.seedSession({
			room_code: 'OTHER1',
			status: otherState.status,
			revision: otherState.revision,
			public_state: { ...otherState, roomCode: 'OTHER1' },
			mode: 'casual',
			visibility: 'public'
		});
		db.seedMember({
			id: 'm-other',
			session_id: other.id,
			display_name: 'Elsewhere',
			role: 'host',
			user_id: 'u-host'
		});
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);

		// Both join frames land in the SAME tick (neither awaited before the other is
		// delivered) — the exact schedule where the pre-await `roomCode == null` guard
		// used to pass twice and register one socket in BOTH rooms.
		const ticketA = await mintMemberTicket(db, session.id, 'm-host', 'u-host');
		const ticketB = await mintMemberTicket(db, other.id, 'm-other', 'u-host');
		const p1 = ws.deliver({ t: 'join', roomCode: 'ROOM42', ticket: ticketA });
		const p2 = ws.deliver({ t: 'join', roomCode: 'OTHER1', ticket: ticketB });
		await Promise.all([p1, p2]);
		await until(() => ws.frames('error').length === 1);

		// Exactly ONE joined; the second join is the fatal protocol violation, which
		// unregisters the socket everywhere (never two rooms, never a half-join).
		expect(ws.frames('joined')).toHaveLength(1);
		expect(ws.last('error')!.code).toBe('already_joined');
		expect(registry.connectionCount('ROOM42')).toBe(0);
		expect(registry.connectionCount('OTHER1')).toBe(0);
		expect(ws.closed).not.toBeNull();
	});

	test('malformed frames are rejected without effect (bad JSON / non-object / unknown type / bad cmdId)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		const revisionBefore = db.getSession('ROOM42')!.revision;

		await ws.deliver('{not json');
		expect(ws.last('error')!.code).toBe('bad_frame');
		await ws.deliver('42');
		expect(ws.last('error')!.code).toBe('bad_frame');
		await ws.deliver({ t: 'launchMissiles' });
		expect(ws.last('error')!.code).toBe('unknown_type');
		await ws.deliver({ t: 'command', cmdId: 'has space', command: { type: 'passEncounter' } });
		expect(ws.last('error')!.code).toBe('bad_cmd_id');
		await ws.deliver({ t: 'command', cmdId: 'x'.repeat(200), command: { type: 'passEncounter' } });
		expect(ws.last('error')!.code).toBe('bad_cmd_id');
		await ws.deliver({ t: 'command', cmdId: 'ok-1', command: 'not-an-object' });
		const malformedAck = ws.frames('ack').find((a) => a.cmdId === 'ok-1');
		expect(malformedAck?.ok).toBe(false);

		expect(db.getSession('ROOM42')!.revision).toBe(revisionBefore); // nothing changed
	});
});

describe('command admission over the wire', () => {
	test('spectator tickets can never command', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintSpectatorTicket(db, session.id)
		});
		await until(() => ws.frames('joined').length === 1);
		await ws.deliver({ t: 'command', cmdId: 'spec-1', command: { type: 'passEncounter' } });
		await until(() => ws.frames('ack').length === 1);
		const ack = ws.last('ack')!;
		expect(ack.ok).toBe(false);
		expect((ack.error as { code: string }).code).toBe('not_a_member');
	});

	test('PRODUCTION posture: integrity/debug/internal commands are refused with no state change', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		const revisionBefore = db.getSession('ROOM42')!.revision;
		const ledgerBefore = db.rowsFor('play_game_session_events').length;

		const forbidden: GameCommand[] = [
			{ type: 'debugGrant', grant: 'vp' } as unknown as GameCommand,
			{ type: 'adjustVictoryPoints', amount: 30 } as GameCommand,
			{ type: 'adjustStatus', amount: 5 } as GameCommand,
			{ type: 'flipSpirit', slotIndex: 1 } as GameCommand,
			{ type: 'spawnDiceBatch', diceId: 'basic_attack', count: 6 } as GameCommand,
			{ type: 'moveMatObject' } as unknown as GameCommand,
			{ type: 'commitRound' } as GameCommand,
			{ type: 'refillMarket' } as GameCommand
		];
		for (let i = 0; i < forbidden.length; i += 1) {
			await ws.deliver({ t: 'command', cmdId: `forbid-${i}`, command: forbidden[i] });
			await until(() => ws.frames('ack').some((a) => a.cmdId === `forbid-${i}`));
			const ack = ws.frames('ack').find((a) => a.cmdId === `forbid-${i}`)!;
			expect(ack.ok, forbidden[i].type).toBe(false);
			expect((ack.error as { code: string }).code).toBe('forbidden_command');
		}
		// Rejections leave revision, ledger and outbox untouched.
		expect(db.getSession('ROOM42')!.revision).toBe(revisionBefore);
		expect(db.rowsFor('play_game_session_events').length).toBe(ledgerBefore);
	});

	test('RANKED refuses host rescue (forceAdvancePhase) and lobby tools from anyone', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame(), 'ranked');
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		const revisionBefore = db.getSession('ROOM42')!.revision;

		await ws.deliver({ t: 'command', cmdId: 'force-1', command: { type: 'forceAdvancePhase' } });
		await until(() => ws.frames('ack').some((a) => a.cmdId === 'force-1'));
		const forceAck = ws.frames('ack').find((a) => a.cmdId === 'force-1')!;
		expect(forceAck.ok).toBe(false);
		expect((forceAck.error as { code: string }).code).toBe('ranked_forbids_host_tools');

		// Ranked projections carry truthful metadata.
		const joined = ws.last('joined')!;
		const projection = (joined.view as { projection: Record<string, unknown> }).projection;
		expect(projection.mode).toBe('ranked');
		expect(projection.rated).toBe(true);
		expect(projection.visibility).toBe('private');

		expect(db.getSession('ROOM42')!.revision).toBe(revisionBefore);
	});

	test('legitimate play commands stay green over WS (dev + prod posture alike)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		await ws.deliver({
			t: 'command',
			cmdId: 'nav-1',
			command: { type: 'lockNavigation', destination: 'Tidal Cove' }
		});
		await until(() => ws.frames('ack').some((a) => a.cmdId === 'nav-1'));
		const ack = ws.frames('ack').find((a) => a.cmdId === 'nav-1')!;
		expect(ack.ok).toBe(true);
	});
});

describe('established-socket authority is never stale', () => {
	async function joinedHost(db: FakePlayDb, sessionId: string): Promise<FakeWs> {
		const ws = attach(db);
		await ws.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, sessionId, 'm-host', 'u-host')
		});
		await until(() => ws.frames('joined').length === 1);
		return ws;
	}

	test('OWNERSHIP TRANSFER after join: the cached socket cannot commit — command dies fatally, revision unchanged (the probe)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = await joinedHost(db, session.id);
		const revisionBefore = db.getSession('ROOM42')!.revision;

		// The membership changes hands AFTER the socket authenticated (the live probe:
		// join as A, flip the owner, then command over the cached socket).
		db.rowsFor('play_session_members').find((m) => m.id === 'm-host')!.user_id = 'u-attacker';

		await ws.deliver({
			t: 'command',
			cmdId: 'stale-1',
			command: { type: 'lockNavigation', destination: 'Tidal Cove' }
		});
		await until(() => ws.frames('error').length === 1);
		expect(ws.last('error')!.code).toBe('authority_revoked');
		expect(ws.last('error')!.fatal).toBe(true);
		expect(ws.frames('ack')).toHaveLength(0);
		expect(db.getSession('ROOM42')!.revision).toBe(revisionBefore); // nothing committed
		expect(registry.connectionCount('ROOM42')).toBe(0); // terminated, not downgraded
	});

	test('MEMBERSHIP DELETION after join: resync (a private projection) terminates instead of answering', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = await joinedHost(db, session.id);

		const rows = db.rowsFor('play_session_members');
		rows.splice(
			rows.findIndex((m) => m.id === 'm-host'),
			1
		);

		ws.sent.length = 0;
		await ws.deliver({ t: 'resync' });
		await until(() => ws.frames('error').length === 1);
		expect(ws.last('error')!.code).toBe('authority_revoked');
		expect(ws.frames('delta')).toHaveLength(0); // no private view leaked
		expect(registry.connectionCount('ROOM42')).toBe(0);
	});

	test('BROADCAST to a revoked viewer terminates it instead of leaking another private delta', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const hostWs = await joinedHost(db, session.id);
		const guestWs = attach(db);
		await guestWs.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-guest', 'u-guest')
		});
		await until(() => guestWs.frames('joined').length === 1);

		// The GUEST's membership changes hands; the HOST then commits a command whose
		// broadcast would have carried the guest's (now foreign) member view.
		db.rowsFor('play_session_members').find((m) => m.id === 'm-guest')!.user_id = 'u-attacker';
		guestWs.sent.length = 0;
		await hostWs.deliver({
			t: 'command',
			cmdId: 'bcast-1',
			command: { type: 'lockNavigation', destination: 'Tidal Cove' }
		});
		await until(() => guestWs.frames('error').length === 1);
		expect(guestWs.last('error')!.code).toBe('authority_revoked');
		expect(guestWs.frames('delta')).toHaveLength(0);
		expect(registry.connectionCount('ROOM42')).toBe(1); // only the host remains
	});

	test('ROLE CHANGE after join is adopted: a demoted host loses host tools on the next command', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = await joinedHost(db, session.id);

		db.rowsFor('play_session_members').find((m) => m.id === 'm-host')!.role = 'player';

		await ws.deliver({ t: 'command', cmdId: 'demoted-1', command: { type: 'forceAdvancePhase' } });
		await until(() => ws.frames('ack').some((a) => a.cmdId === 'demoted-1'));
		const ack = ws.frames('ack').find((a) => a.cmdId === 'demoted-1')!;
		expect(ack.ok).toBe(false);
		expect((ack.error as { code: string }).code).toBe('host_only'); // judged on the FRESH role
	});

	test('AUTHENTICATED LEASE: a socket past the lease window is closed non-fatally (reconnect re-proves identity)', async () => {
		const db = new FakePlayDb({ rpc: true });
		const session = seedRoom(db, startedGame());
		registry = new RoomRegistry(registryDepsFor(db));
		const ws = await joinedHost(db, session.id);

		// Backdate the authentication instant past the lease, then run one sweep.
		const rooms = (
			registry as unknown as {
				rooms: Map<string, { connections: Set<{ authenticatedAt: number }> }>;
			}
		).rooms;
		for (const conn of rooms.get('ROOM42')!.connections) {
			conn.authenticatedAt = Date.now() - (15 * 60_000 + 1000);
		}
		await (registry as unknown as { sweep(): Promise<void> }).sweep();

		await until(() => ws.frames('error').length === 1);
		expect(ws.last('error')!.code).toBe('lease_expired');
		expect(ws.last('error')!.fatal).toBeUndefined(); // NON-fatal: the client reconnects with a fresh ticket
		expect(ws.closed?.code).toBe(4001);
		expect(registry.connectionCount('ROOM42')).toBe(0);
	});

	describe('LEASE CONFIGURATION is validated: a malformed ARC_WS_AUTH_LEASE_MS can never mean "infinite"', () => {
		test('unset/blank resolves to the default', () => {
			expect(resolveWsAuthLeaseMs(undefined, 'production')).toBe(WS_AUTH_LEASE_DEFAULT_MS);
			expect(resolveWsAuthLeaseMs('', 'production')).toBe(WS_AUTH_LEASE_DEFAULT_MS);
			expect(resolveWsAuthLeaseMs('   ', 'production')).toBe(WS_AUTH_LEASE_DEFAULT_MS);
		});

		test('a valid in-bounds integer is honored on every tier', () => {
			expect(resolveWsAuthLeaseMs('60000', 'production')).toBe(60_000);
			expect(resolveWsAuthLeaseMs(String(WS_AUTH_LEASE_MIN_MS), 'production')).toBe(
				WS_AUTH_LEASE_MIN_MS
			);
			expect(resolveWsAuthLeaseMs(String(WS_AUTH_LEASE_MAX_MS), 'production')).toBe(
				WS_AUTH_LEASE_MAX_MS
			);
			expect(resolveWsAuthLeaseMs('900000', 'development')).toBe(900_000);
		});

		test('INVALID values (the NaN → infinite-lease defect) refuse production startup and default elsewhere', () => {
			for (const bad of [
				'fifteen-minutes',
				'NaN',
				'Infinity',
				'-Infinity',
				'1e999',
				'12.5',
				'60000ms'
			]) {
				expect(() => resolveWsAuthLeaseMs(bad, 'production'), bad).toThrow(/ARC_WS_AUTH_LEASE_MS/);
				const fallback = resolveWsAuthLeaseMs(bad, 'development');
				expect(fallback, bad).toBe(WS_AUTH_LEASE_DEFAULT_MS);
				expect(Number.isFinite(fallback), bad).toBe(true);
			}
		});

		test('OUT-OF-RANGE values (zero, negative, sub-minimum, beyond 24h) refuse production startup and default elsewhere', () => {
			for (const bad of [
				'0',
				'-1',
				'-60000',
				String(WS_AUTH_LEASE_MIN_MS - 1),
				String(WS_AUTH_LEASE_MAX_MS + 1),
				'999999999999999'
			]) {
				expect(() => resolveWsAuthLeaseMs(bad, 'production'), bad).toThrow(/ARC_WS_AUTH_LEASE_MS/);
				expect(resolveWsAuthLeaseMs(bad, 'test'), bad).toBe(WS_AUTH_LEASE_DEFAULT_MS);
			}
		});

		test('whatever the input, the resolved lease is finite and inside the hard bounds (the sweep comparison cannot be defeated)', () => {
			for (const raw of [undefined, '', 'garbage', '0', '-5', '86400001', '60000', 'Infinity']) {
				let lease: number;
				try {
					lease = resolveWsAuthLeaseMs(raw, 'production');
				} catch {
					lease = resolveWsAuthLeaseMs(raw, 'development');
				}
				expect(Number.isFinite(lease), String(raw)).toBe(true);
				expect(lease, String(raw)).toBeGreaterThanOrEqual(WS_AUTH_LEASE_MIN_MS);
				expect(lease, String(raw)).toBeLessThanOrEqual(WS_AUTH_LEASE_MAX_MS);
				// The defect's exact shape: elapsed > lease must be able to become true.
				expect(Number.MAX_SAFE_INTEGER > lease, String(raw)).toBe(true);
			}
		});
	});
});

describe('per-frame viewer recomputation (no stale owner leakage)', () => {
	test('after a seat release + takeover, every outgoing view reflects the CURRENT seats', async () => {
		const db = new FakePlayDb({ rpc: true });
		// Lobby room: seats can be released/claimed.
		let lobby = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
		lobby = apply(lobby, HOST, { type: 'claimSeat', seatColor: 'Red' });
		const session = seedRoom(db, lobby);
		registry = new RoomRegistry(registryDepsFor(db));

		const hostWs = attach(db);
		await hostWs.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-host', 'u-host')
		});
		await until(() => hostWs.frames('joined').length === 1);
		expect(hostWs.last('joined')!.seat).toBe('Red');

		const guestWs = attach(db);
		await guestWs.deliver({
			t: 'join',
			roomCode: 'ROOM42',
			ticket: await mintMemberTicket(db, session.id, 'm-guest', 'u-guest')
		});
		await until(() => guestWs.frames('joined').length === 1);

		// Host releases Red; guest takes it over — two commands over the live wire.
		await hostWs.deliver({
			t: 'command',
			cmdId: 'rel-1',
			command: { type: 'releaseSeat', seatColor: 'Red' }
		});
		await until(() => hostWs.frames('ack').some((a) => a.cmdId === 'rel-1'));
		await guestWs.deliver({
			t: 'command',
			cmdId: 'take-1',
			command: { type: 'claimSeat', seatColor: 'Red' }
		});
		await until(() => guestWs.frames('ack').some((a) => a.cmdId === 'take-1'));

		// The host's broadcast delta for the takeover recomputes ITS viewer: no seat.
		await until(() => hostWs.frames('delta').length >= 1);
		const hostDelta = hostWs.frames('delta').at(-1)!;
		const hostView = hostDelta.patch as {
			member: { seatColor: string | null };
			projection: { seats: Record<string, { memberId: string | null }> };
		};
		expect(hostView.member.seatColor).toBeNull();
		expect(hostView.projection.seats.Red.memberId).toBe('m-guest');

		// And an explicit resync answers the same current truth.
		hostWs.sent.length = 0;
		await hostWs.deliver({ t: 'resync' });
		await until(() => hostWs.frames('delta').length === 1);
		const resync = hostWs.frames('delta')[0].patch as { member: { seatColor: string | null } };
		expect(resync.member.seatColor).toBeNull();
	});
});
