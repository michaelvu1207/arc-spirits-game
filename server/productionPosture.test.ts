/**
 * PRODUCTION POSTURE — live probes that a production-mode deployment rejects every
 * debug/integrity surface EVEN WHEN the local-test environment flags are set.
 *
 *  1. LIVE PROCESS: the real room server (`server/index.ts`) is spawned with
 *     NODE_ENV=production AND ARC_WS_ALLOW_DEBUG_SEED=1 AND
 *     ARC_ALLOW_INTEGRITY_COMMANDS=1 — the exact leftover-flag deployment the
 *     pre-fix code exposed — and every /debug/* endpoint must answer 404 while
 *     /healthz and the WS upgrade stay alive (a garbage join dies at ticket auth).
 *  2. IN-PROCESS WIRE GATE: the RoomRegistry command path under the same env
 *     refuses an integrity command from a legitimately joined member.
 *  3. NON-ATOMIC FALLBACK FAILS CLOSED: NODE_ENV=production with a leftover
 *     ARC_ALLOW_NONATOMIC_COMMIT=1 — and even an explicit in-code opt-in — cannot
 *     engage the legacy non-atomic command commit, ranked finalization, or effects-
 *     outbox drain. Each REAL gate is probed directly; nothing may be written.
 *  4. SHARED GATE FUNCTIONS: both transports' gates (commandPolicy.ts) refuse
 *     production regardless of flags — the same functions service.ts (HTTP) and
 *     connections.ts (WS) call, so neither boundary can drift.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS process-ownership helper shared with the release gates
import { spawnOwned, stopOwned } from '../scripts/procOwn.mjs';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import WebSocketClient from 'ws';
import { RoomRegistry, type RegistryDeps } from './connections';
import { RoomHost, type RoomHostDeps } from './roomHost';
import type { PlaySessionRow, SessionMemberRow } from './supabase';
import { FakePlayDb } from '../src/lib/play/server/fakePlayDb';
import { consumeWsTicket, createWsTicket } from '../src/lib/play/server/wsTickets';
import {
	httpIntegrityToolsAllowed,
	wsIntegrityToolsAllowed
} from '../src/lib/play/server/commandPolicy';
import {
	CommitNotReadyError,
	commitRoomMutation,
	nonAtomicFallbackPermitted
} from '../src/lib/play/server/commit';
import {
	finalizeMatchWith,
	frozenFinalizeState,
	type FinalizeMatchSession
} from '../src/lib/play/server/matchFinalize';
import {
	drainEffectsOutbox,
	effectsOutboxEvent,
	EFFECTS_COMMAND_TYPE
} from '../src/lib/play/server/effectsOutbox';
import { applyGameCommand, createLobbyState } from '../src/lib/play/runtime';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState } from '../src/lib/play/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8990 + Math.floor(Math.random() * 200);

const PRODUCTION_ENV = {
	NODE_ENV: 'production',
	ARC_WS_ALLOW_DEBUG_SEED: '1',
	ARC_ALLOW_INTEGRITY_COMMANDS: '1'
} as const;

// ── 1. live room-server process in production mode ───────────────────────────────

let server: ReturnType<typeof spawnOwned> | null = null;

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
				signal: AbortSignal.timeout(1000)
			});
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`production room server never became healthy on :${PORT}\n${(server?.ownedLog ?? '').slice(-2000)}`
	);
}

beforeAll(async () => {
	// OWNED process group (scripts/procOwn.mjs): `node .bin/tsx` directly — the old
	// `spawn('npx', ['tsx', …])` + `kill('SIGKILL')` killed only the npx wrapper and
	// reparented the tsx/node room-server pair to launchd, leaking a listener on a
	// random port after every full test run.
	server = spawnOwned(
		'node',
		[join(HERE, '..', 'node_modules', '.bin', 'tsx'), join(HERE, 'index.ts')],
		{
			cwd: join(HERE, '..'),
			label: 'production-posture room server',
			env: {
				...process.env,
				...PRODUCTION_ENV,
				PORT: String(PORT),
				// The store is never reached by these probes; dummies keep lazy init inert.
				PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL || 'http://127.0.0.1:9',
				PUBLIC_SUPABASE_ANON_KEY: process.env.PUBLIC_SUPABASE_ANON_KEY || 'dummy',
				SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy'
			}
		}
	);
	await waitForHealth();
}, 30_000);

afterAll(async () => {
	// TERM → bounded wait → KILL against the whole group, ACTUAL exit awaited.
	if (server) await stopOwned(server, { termTimeoutMs: 3000 });
});

describe('live room server with NODE_ENV=production + debug flags set', () => {
	test('the leftover flags are loudly ignored at boot', async () => {
		expect(server?.ownedLog ?? '').toContain('debugSeed=off');
		expect(server?.ownedLog ?? '').toContain('stay DISABLED');
	});

	test('every /debug/* endpoint answers 404 (seed, ticket mints, bot seeding)', async () => {
		for (const path of [
			'/debug/seed',
			'/debug/ticket?memberId=x&roomCode=Y',
			'/debug/spectator-ticket?roomCode=Y',
			'/debug/seed-bots?botCount=3'
		]) {
			const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
				method: 'POST',
				signal: AbortSignal.timeout(2000)
			});
			expect(res.status, path).toBe(404);
		}
	});

	test('the WS transport stays alive but strictly ticket-authenticated (garbage join is fatal)', async () => {
		const ws = new WebSocketClient(`ws://127.0.0.1:${PORT}/ws`);
		const frames: Record<string, unknown>[] = [];
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`no fatal error frame\n${JSON.stringify(frames)}`)),
				5000
			);
			ws.on('open', () => {
				ws.send(JSON.stringify({ t: 'join', roomCode: 'NOSUCH', ticket: 'm-forged-uuid' }));
			});
			ws.on('message', (data) => {
				const frame = JSON.parse(String(data)) as Record<string, unknown>;
				frames.push(frame);
				if (frame.t === 'error') {
					clearTimeout(timer);
					resolve();
				}
			});
			ws.on('error', reject);
		});
		ws.close();
		const err = frames.find((f) => f.t === 'error')!;
		expect(err.fatal).toBe(true);
		expect(frames.some((f) => f.t === 'joined')).toBe(false);
	});
});

// ── 2. in-process wire gate under production env ─────────────────────────────────

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

class FakeWs {
	readonly OPEN = 1;
	readyState = 1;
	sent: Record<string, unknown>[] = [];
	private handlers = new Map<string, ((data?: unknown) => void)[]>();
	on(event: string, cb: (data?: unknown) => void): void {
		const list = this.handlers.get(event) ?? [];
		list.push(cb);
		this.handlers.set(event, list);
	}
	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}
	close(): void {
		this.readyState = 3;
	}
	async deliver(frame: unknown): Promise<void> {
		for (const cb of this.handlers.get('message') ?? [])
			await cb(Buffer.from(JSON.stringify(frame)));
		await new Promise((r) => setTimeout(r, 0));
	}
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error('condition never became true');
		await new Promise((r) => setTimeout(r, 5));
	}
}

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('in-process production wire gate', () => {
	test('a joined member’s integrity command is refused under NODE_ENV=production even with both flags set', async () => {
		for (const key of Object.keys(PRODUCTION_ENV)) {
			savedEnv[key] = process.env[key];
		}
		savedEnv.ARC_ALLOW_NONATOMIC_COMMIT = process.env.ARC_ALLOW_NONATOMIC_COMMIT;
		Object.assign(process.env, PRODUCTION_ENV, { ARC_ALLOW_NONATOMIC_COMMIT: '1' });

		const db = new FakePlayDb({ rpc: true });
		const HOST: GameActor = {
			memberId: 'm-host',
			displayName: 'Host',
			role: 'host',
			seatColor: null
		};
		let state = createLobbyState({ roomCode: 'PROD01', guardianNames: ['Myrtle', 'Nyra'] });
		const step = (actor: GameActor, command: GameCommand) => {
			const result = applyGameCommand(state, actor, command, CATALOG);
			if (!result.ok) throw new Error(result.error.message);
			state = result.state;
		};
		step(HOST, { type: 'claimSeat', seatColor: 'Red' });
		step({ ...HOST, seatColor: 'Red' }, { type: 'selectGuardian', guardianName: 'Myrtle' });
		step({ ...HOST, seatColor: 'Red' }, { type: 'startGame', seed: 5 });

		const session = db.seedSession({
			room_code: 'PROD01',
			status: state.status,
			revision: state.revision,
			public_state: state as PublicGameState,
			mode: 'casual',
			visibility: 'public',
			started_at: new Date().toISOString()
		});
		db.seedMember({
			id: 'm-host',
			session_id: session.id,
			display_name: 'Host',
			role: 'host',
			user_id: 'u-host'
		});

		const hostDeps: RoomHostDeps = {
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
			loadBotMembers: async () => new Map(),
			loadCatalog: async () => CATALOG
		};
		const deps: RegistryDeps = {
			consumeWsTicket: (raw) => consumeWsTicket(db, raw),
			getMemberById: async (memberId) =>
				structuredClone(
					db.rowsFor('play_session_members').find((m) => m.id === memberId) ?? null
				) as SessionMemberRow | null,
			touchMemberLastSeen: async () => {},
			loadRoomHost: (roomCode) => RoomHost.load(roomCode, hostDeps)
		};
		const registry = new RoomRegistry(deps);
		try {
			const ws = new FakeWs();
			registry.handleSocket(ws as unknown as WebSocket, {} as IncomingMessage);
			const { ticket } = await createWsTicket(db, {
				sessionId: session.id,
				userId: 'u-host',
				memberId: 'm-host',
				role: 'member'
			});
			await ws.deliver({ t: 'join', roomCode: 'PROD01', ticket });
			await until(() => ws.sent.some((f) => f.t === 'joined'));

			const revisionBefore = db.getSession('PROD01')!.revision;
			await ws.deliver({
				t: 'command',
				cmdId: 'prod-integrity-1',
				command: { type: 'adjustVictoryPoints', amount: 30 }
			});
			await until(() => ws.sent.some((f) => f.t === 'ack'));
			const ack = ws.sent.find((f) => f.t === 'ack')!;
			expect(ack.ok).toBe(false);
			expect((ack.error as { code: string }).code).toBe('forbidden_command');
			expect(db.getSession('PROD01')!.revision).toBe(revisionBefore);
		} finally {
			await registry.shutdown();
		}
	});
});

// ── 3. NON-ATOMIC FALLBACK: production fails closed across EVERY authority gate ───
// The pre-fix defect: NODE_ENV=production plus a leftover ARC_ALLOW_NONATOMIC_COMMIT=1
// still engaged the legacy non-atomic command commit / outbox finalize / ranked
// finalization. All of them resolve through nonAtomicFallbackPermitted now — these
// probes run each REAL gate under that exact leftover-flag production posture, with
// the strongest possible opt-in (the explicit in-code override), and require a hard
// refusal with nothing written.

function seedFinishedRankedFixture(db: FakePlayDb) {
	const sessionId = 's-prod-rank';
	db.seedMember({ id: 'm-red', session_id: sessionId, display_name: 'Alice', user_id: 'u-red' });
	db.seedMember({ id: 'm-blue', session_id: sessionId, display_name: 'Bob', user_id: 'u-blue' });
	const session: FinalizeMatchSession = {
		id: sessionId,
		game_id: 'game-prod-1',
		mode: 'ranked',
		started_at: '2026-07-10T11:00:00.000Z',
		ended_at: '2026-07-10T12:00:00.000Z'
	};
	const state = {
		roomCode: 'PRODRK',
		revision: 30,
		status: 'finished',
		gameId: 'game-prod-1',
		scenario: null,
		winnerSeat: 'Red',
		round: 7,
		activeSeats: ['Red', 'Blue'],
		seats: {
			Red: { memberId: 'm-red', displayName: 'Alice' },
			Blue: { memberId: 'm-blue', displayName: 'Bob' }
		},
		players: { Red: { victoryPoints: 30 }, Blue: { victoryPoints: 22 } }
	} as unknown as PublicGameState;
	return { session, state };
}

describe('production fails closed on the non-atomic fallback (flag AND explicit opt-in set)', () => {
	function enterProductionWithLeftoverFlag() {
		for (const key of ['NODE_ENV', 'ARC_ALLOW_NONATOMIC_COMMIT']) {
			if (!(key in savedEnv)) savedEnv[key] = process.env[key];
		}
		process.env.NODE_ENV = 'production';
		process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
	}

	test('the shared gate refuses production and every non-dev/test tier, explicit opt-in included', () => {
		for (const nodeEnv of ['production', 'staging', 'preview']) {
			expect(
				nonAtomicFallbackPermitted(undefined, {
					NODE_ENV: nodeEnv,
					ARC_ALLOW_NONATOMIC_COMMIT: '1'
				})
			).toBe(false);
			expect(nonAtomicFallbackPermitted(true, { NODE_ENV: nodeEnv })).toBe(false);
		}
		// The local fallback is bounded to a safe development/test posture.
		expect(
			nonAtomicFallbackPermitted(undefined, {
				NODE_ENV: 'development',
				ARC_ALLOW_NONATOMIC_COMMIT: '1'
			})
		).toBe(true);
		expect(nonAtomicFallbackPermitted(true, { NODE_ENV: 'test' })).toBe(true);
		expect(nonAtomicFallbackPermitted(undefined, { NODE_ENV: 'development' })).toBe(false);
		expect(nonAtomicFallbackPermitted(undefined, {})).toBe(false);
		expect(nonAtomicFallbackPermitted(true, {})).toBe(true);
	});

	test('COMMAND COMMIT: a production store without the atomic RPC is a readiness error — never a silent non-atomic write', async () => {
		enterProductionWithLeftoverFlag();
		const db = new FakePlayDb(); // pre-migration store: no commit_room_command
		const session = db.seedSession({
			room_code: 'PRODNA',
			status: 'active',
			revision: 3,
			public_state: { roomCode: 'PRODNA', revision: 3, status: 'active' }
		});
		const nextState = {
			roomCode: 'PRODNA',
			revision: 4,
			status: 'active'
		} as unknown as PublicGameState;
		const attempt = () =>
			commitRoomMutation(
				db,
				{
					session: { id: session.id, revision: 3, started_at: null, ended_at: null },
					nextState,
					events: [
						{
							commandType: 'passTurn',
							payload: {},
							actorMemberId: 'm-x',
							revision: 4,
							cmdId: 'prod-na-1'
						}
					]
				},
				{ allowNonAtomicFallback: true } // the strongest opt-in — still refused
			);
		await expect(attempt()).rejects.toThrow(CommitNotReadyError);
		// Nothing moved: no CAS write, no ledger row.
		expect(db.getSession('PRODNA')!.revision).toBe(3);
		expect(db.rowsFor('play_game_session_events')).toHaveLength(0);
	});

	test('RANKED FINALIZATION: without the finalize RPC production records nothing (no anchor, no ratings) and reports not-durable', async () => {
		enterProductionWithLeftoverFlag();
		const db = new FakePlayDb(); // no finalize_match RPC
		const { session, state } = seedFinishedRankedFixture(db);
		expect(await finalizeMatchWith(db, session, state, { allowNonAtomicFallback: true })).toBe(
			false
		);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('match_result_players')).toHaveLength(0);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
		expect(db.rowsFor('player_rating_events')).toHaveLength(0);
	});

	test('EFFECTS OUTBOX: the owed finalize row is RETAINED for a post-upgrade drain, never burned through the legacy sequence', async () => {
		enterProductionWithLeftoverFlag();
		const db = new FakePlayDb();
		const { session, state } = seedFinishedRankedFixture(db);
		const outboxEvent = effectsOutboxEvent(30, [
			{ kind: 'matchFinalize', session, terminal: frozenFinalizeState(state) }
		])!;
		db.rowsFor('play_game_session_events').push({
			id: 'evt-outbox-1',
			session_id: session.id,
			revision: outboxEvent.revision,
			actor_member_id: null,
			command_type: EFFECTS_COMMAND_TYPE,
			command_payload: outboxEvent.payload
		});
		await drainEffectsOutbox(db, null, session.id, state, { allowNonAtomicFallback: true });
		// The drain must NOT delete the row (the finalize could not be made durable)
		// and must NOT have finalized through the legacy path.
		expect(
			db
				.rowsFor('play_game_session_events')
				.filter((row) => row.command_type === EFFECTS_COMMAND_TYPE)
		).toHaveLength(1);
		expect(db.rowsFor('match_results')).toHaveLength(0);
		expect(db.rowsFor('player_ratings')).toHaveLength(0);
	});

	test('control: the SAME calls succeed on a dev/test posture (the fallback stays available where it is safe)', async () => {
		// NODE_ENV under vitest is 'test' — the bounded posture. Explicit opt-in engages.
		const db = new FakePlayDb();
		const { session, state } = seedFinishedRankedFixture(db);
		expect(await finalizeMatchWith(db, session, state, { allowNonAtomicFallback: true })).toBe(
			true
		);
		expect(db.rowsFor('match_results')).toHaveLength(1);
	});
});

// ── 4. the shared gate functions both transports call ────────────────────────────

describe('shared production integrity gates (commandPolicy)', () => {
	test('production refuses regardless of flags; non-production honors its tier rules', () => {
		const prodWithFlags = {
			NODE_ENV: 'production',
			...{
				ARC_WS_ALLOW_DEBUG_SEED: '1',
				ARC_ALLOW_INTEGRITY_COMMANDS: '1'
			}
		};
		expect(httpIntegrityToolsAllowed(prodWithFlags)).toBe(false);
		expect(wsIntegrityToolsAllowed(prodWithFlags)).toBe(false);

		expect(httpIntegrityToolsAllowed({ NODE_ENV: 'development' })).toBe(true);
		expect(wsIntegrityToolsAllowed({ NODE_ENV: 'development' })).toBe(false); // WS needs the explicit opt-in
		expect(wsIntegrityToolsAllowed({ NODE_ENV: 'test', ARC_WS_ALLOW_DEBUG_SEED: '1' })).toBe(true);
		expect(wsIntegrityToolsAllowed({ NODE_ENV: 'test', ARC_ALLOW_INTEGRITY_COMMANDS: '1' })).toBe(
			true
		);
	});
});
