/**
 * The `no_human_players` close rule: a started game ends once every human seated at the start
 * has been away longer than ARC_HUMAN_ABSENT_MS, unless the game started with only bot/AI
 * seats. Checked in the AI worker path (listActiveAiRooms / loadAiRoom) and the bot tick
 * (closeRoomIfNoHumanPlayers). Runs against the FakePlayDb store emulator.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakePlayDb } from './fakePlayDb';
import { createLobbyState } from '../runtime';
import { SEAT_COLORS } from '../types';
import type { PlayCatalog } from '../types';
import { noHumanPlayersLeft, roomCloseReason, seatedHumanLastSeen } from '../roomLifecycle';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: () => holder.db
}));
vi.mock('./catalog', () => ({
	loadPlayCatalog: async () =>
		({ guardians: [], spirits: [], mats: [], classes: [] }) as unknown as PlayCatalog
}));

import { closeRoomIfNoHumanPlayers, listActiveAiRooms, loadAiRoom } from './service';

const ROOM = 'NOHUM1';
const SESSION_ID = 'sess-nohum-1';
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Seat = { id: string; kind: 'human' | 'ai'; seenAgoMs?: number };

/** An ACTIVE game whose seats were locked at start with `seats` (in seat order), plus any
 *  extra unseated members (spectators / a host who never sat). */
function seedGame(seats: Seat[], extras: Seat[] = []): FakePlayDb {
	const db = new FakePlayDb({ rpc: true });
	holder.db = db;
	const state = createLobbyState({ roomCode: ROOM, guardianNames: ['Pyra', 'Aqua'] });
	const colors = SEAT_COLORS.slice(0, seats.length);
	seats.forEach((s, i) => {
		state.seats[colors[i]] = { ...state.seats[colors[i]], memberId: s.id, displayName: s.id };
	});
	state.activeSeats = [...colors];
	state.status = 'active';
	db.seedSession({
		id: SESSION_ID,
		room_code: ROOM,
		status: 'active',
		started_at: ago(30 * MIN),
		revision: state.revision,
		public_state: state
	});
	for (const s of [...seats, ...extras]) {
		db.seedMember({
			id: s.id,
			session_id: SESSION_ID,
			user_id: s.kind === 'human' ? `uid-${s.id}` : null,
			display_name: s.id,
			is_bot: s.kind === 'ai',
			bot_profile: s.kind === 'ai' ? 'ai' : null,
			role: extras.includes(s) ? 'spectator' : 'player',
			last_seen_at: ago(s.seenAgoMs ?? 0)
		});
	}
	return db;
}

function closeEvents(db: FakePlayDb) {
	return db.rowsFor('play_game_session_events').filter((e) => e.command_type === 'closeRoom');
}

beforeEach(() => {
	delete process.env.ARC_HUMAN_ABSENT_MS;
});
afterEach(() => {
	delete process.env.ARC_HUMAN_ABSENT_MS;
});

describe('no_human_players: AI worker path', () => {
	test('human seated at start, all humans gone > limit: closed once, with the note, and not listed', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 6 * MIN },
			{ id: 'ai1', kind: 'ai' }
		]);
		expect(await listActiveAiRooms(10)).toEqual([]);
		expect(db.getSession(ROOM)?.status).toBe('closed');
		const events = closeEvents(db);
		expect(events).toHaveLength(1);
		expect(events[0].command_payload).toEqual({
			reason: 'no_human_players',
			note: 'closed: no human players left'
		});
		// A second poll neither lists it nor closes it again.
		expect(await listActiveAiRooms(10)).toEqual([]);
		expect(closeEvents(db)).toHaveLength(1);
		// /api/ai/act's loader sees it as not active.
		expect((await loadAiRoom(ROOM))?.state.status).toBe('closed');
	});

	test('human absent for less than the limit: still listed', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 4 * MIN },
			{ id: 'ai1', kind: 'ai' }
		]);
		const rooms = await listActiveAiRooms(10);
		expect(rooms.map((r) => r.roomCode)).toEqual([ROOM]);
		expect(db.getSession(ROOM)?.status).toBe('active');
	});

	test('ARC_HUMAN_ABSENT_MS overrides the 5 minute default', async () => {
		process.env.ARC_HUMAN_ABSENT_MS = String(2 * MIN);
		seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 3 * MIN },
			{ id: 'ai1', kind: 'ai' }
		]);
		expect(await listActiveAiRooms(10)).toEqual([]);
	});

	test('one human present among gone ones: listed', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 60 * MIN },
			{ id: 'h2', kind: 'human', seenAgoMs: 5_000 },
			{ id: 'ai1', kind: 'ai' }
		]);
		expect((await listActiveAiRooms(10)).map((r) => r.roomCode)).toEqual([ROOM]);
		expect(closeEvents(db)).toHaveLength(0);
	});

	test('room started all-AI: listed even when nobody has been seen for hours', async () => {
		const db = seedGame(
			[
				{ id: 'ai1', kind: 'ai', seenAgoMs: 5 * 60 * MIN },
				{ id: 'ai2', kind: 'ai', seenAgoMs: 5 * 60 * MIN }
			],
			[{ id: 'host', kind: 'human', seenAgoMs: 5 * 60 * MIN }]
		);
		expect((await listActiveAiRooms(10)).map((r) => r.roomCode)).toEqual([ROOM]);
		expect((await loadAiRoom(ROOM))?.state.status).toBe('active');
		expect(await closeRoomIfNoHumanPlayers(ROOM)).toBe(false);
		expect(db.getSession(ROOM)?.status).toBe('active');
	});

	test('a present spectator/host who never sat does not keep a game alive', async () => {
		const db = seedGame(
			[
				{ id: 'h1', kind: 'human', seenAgoMs: 10 * MIN },
				{ id: 'ai1', kind: 'ai' }
			],
			[{ id: 'watcher', kind: 'human', seenAgoMs: 0 }]
		);
		expect(await listActiveAiRooms(10)).toEqual([]);
		expect(db.getSession(ROOM)?.status).toBe('closed');
	});

	test('a seated human whose member row is gone counts as a human who left', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 0 },
			{ id: 'ai1', kind: 'ai' }
		]);
		const members = db.rowsFor('play_session_members');
		members.splice(members.findIndex((m) => m.id === 'h1'), 1);
		expect(await listActiveAiRooms(10)).toEqual([]);
	});
});

describe('no_human_players: bot tick path', () => {
	test('closeRoomIfNoHumanPlayers closes a game whose humans are gone, exactly once', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 6 * MIN },
			{ id: 'ai1', kind: 'ai' }
		]);
		expect(await closeRoomIfNoHumanPlayers(ROOM)).toBe(true);
		expect(db.getSession(ROOM)?.status).toBe('closed');
		// Already closed: reported as not active, no second close event.
		expect(await closeRoomIfNoHumanPlayers(ROOM)).toBe(false);
		expect(closeEvents(db)).toHaveLength(1);
	});

	test('a human who is only thinking (seen recently) keeps the game open', async () => {
		const db = seedGame([
			{ id: 'h1', kind: 'human', seenAgoMs: 3_000 },
			{ id: 'ai1', kind: 'ai' }
		]);
		expect(await closeRoomIfNoHumanPlayers(ROOM)).toBe(false);
		expect(db.getSession(ROOM)?.status).toBe('active');
	});
});

describe('roomLifecycle helpers', () => {
	const state = {
		activeSeats: ['red', 'blue', 'green'],
		seats: { red: { memberId: 'h1' }, blue: { memberId: 'ai1' }, green: { memberId: 'gone' } }
	};
	test('seatedHumanLastSeen skips bots and treats a missing member as long gone', () => {
		expect(
			seatedHumanLastSeen(state, [
				{ id: 'h1', lastSeenAtMs: 1000, isBot: false },
				{ id: 'ai1', lastSeenAtMs: 5, isBot: true }
			])
		).toEqual([1000, 0]);
	});
	test('noHumanPlayersLeft is false for an all-bot start', () => {
		expect(noHumanPlayersLeft([], Date.now(), 1)).toBe(false);
	});
	test('roomCloseReason ignores the rule when the seated list is not supplied', () => {
		const now = Date.now();
		const base = {
			status: 'active' as const,
			createdAtMs: now - 60 * MIN,
			startedAtMs: now - 30 * MIN,
			humanLastSeenMs: [now]
		};
		expect(roomCloseReason(base, now)).toBeNull();
		expect(roomCloseReason({ ...base, seatedHumanLastSeenMs: [now - 10 * MIN] }, now)).toBe(
			'no_human_players'
		);
	});
});
