/**
 * leaveRoomAsUser seat/membership coherence (service.ts) — the abandoned-entry
 * compensation path must NEVER manufacture a GHOST SEAT: a lobby seat map entry
 * pointing at a deleted membership is unrecoverable by any later actor (nobody
 * can release it, nobody can claim it, and Start counts it as a player).
 *
 * The contract under test:
 *   - The membership row is deleted ONLY after the seat release is PROVEN:
 *     either the releaseSeat command committed, or the reducer explicitly said
 *     "no claimed seat" (the member was already unseated — the common case).
 *   - Any OTHER release failure (transient store/commit error, the room racing
 *     out of lobby) FAILS CLOSED: the call throws, seat + membership stay
 *     coherent, and a retry can complete the leave. Pre-fix, a bare catch
 *     swallowed EVERY failure and deleted the membership anyway.
 *
 * Runs against the FakePlayDb real-store emulator (atomic-RPC posture), with
 * the store admin injected via the mocked supabaseAdmin factory.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakePlayDb } from './fakePlayDb';
import { createLobbyState } from '../runtime';
import { SEAT_COLORS } from '../types';
import type { PlayCatalog } from '../types';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: () => holder.db
}));
// releaseSeat never consults the catalog; keep the mock inert so the test needs
// no asset backend.
vi.mock('./catalog', () => ({
	loadPlayCatalog: async () =>
		({ guardians: [], spirits: [], mats: [], classes: [] }) as unknown as PlayCatalog
}));

import { leaveRoomAsUser } from './service';

const ROOM = 'LEAVE1';
const SESSION_ID = 'sess-leave-1';
const LEAVER_MEMBER = 'm-leaver';
const LEAVER_UID = 'uid-leaver';

function seedLobby(opts: { seated: boolean; withOtherHuman?: boolean }): FakePlayDb {
	const db = new FakePlayDb({ rpc: true });
	holder.db = db;
	const state = createLobbyState({ roomCode: ROOM, guardianNames: ['Pyra', 'Aqua'] });
	if (opts.seated) {
		const seat = SEAT_COLORS[0];
		state.seats[seat] = {
			...state.seats[seat],
			memberId: LEAVER_MEMBER,
			displayName: 'Leaver'
		};
	}
	db.seedSession({
		id: SESSION_ID,
		room_code: ROOM,
		status: 'lobby',
		revision: state.revision,
		public_state: state
	});
	db.seedMember({
		id: LEAVER_MEMBER,
		session_id: SESSION_ID,
		user_id: LEAVER_UID,
		display_name: 'Leaver',
		is_bot: false
	});
	if (opts.withOtherHuman !== false) {
		db.seedMember({
			id: 'm-other',
			session_id: SESSION_ID,
			user_id: 'uid-other',
			display_name: 'Other',
			is_bot: false
		});
	}
	return db;
}

function sessionState(db: FakePlayDb): Record<string, any> {
	return db.getSession(ROOM)!.public_state as Record<string, any>;
}

function members(db: FakePlayDb): Record<string, unknown>[] {
	return (db.tables.get('play_session_members') ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
	holder.db = null;
});

describe('leaveRoomAsUser — no ghost seats', () => {
	test('SEATED leaver, healthy store: the seat is released FIRST, then the membership is deleted', async () => {
		const db = seedLobby({ seated: true });
		const result = await leaveRoomAsUser(ROOM, LEAVER_UID);
		expect(result).toEqual({ left: true, closed: false });
		// Seat map no longer points anywhere near the deleted membership…
		const seats = sessionState(db).seats as Record<string, { memberId: string | null }>;
		expect(Object.values(seats).every((s) => s.memberId !== LEAVER_MEMBER)).toBe(true);
		// …and the membership row is gone.
		expect(members(db).some((m) => m.id === LEAVER_MEMBER)).toBe(false);
	});

	test('FAIL CLOSED: a transient commit failure while releasing the seat throws and leaves seat + membership COHERENT (pre-fix: swallowed, membership deleted, seat ghosted)', async () => {
		const db = seedLobby({ seated: true });
		// The releaseSeat command's atomic commit fails once (transient store error).
		db.failNextRpcCall('commit_room_command', 'error');

		// The commit layer surfaces the transient store failure as an HTTP error
		// (503 service-unavailable) — and leaveRoomAsUser rethrows it untouched.
		await expect(leaveRoomAsUser(ROOM, LEAVER_UID)).rejects.toMatchObject({ status: 503 });

		// COHERENT: the seat still points at a membership that still exists — no
		// ghost. (Pre-fix the bare catch deleted the row here, stranding the seat.)
		const seats = sessionState(db).seats as Record<string, { memberId: string | null }>;
		expect(Object.values(seats).some((s) => s.memberId === LEAVER_MEMBER)).toBe(true);
		expect(members(db).some((m) => m.id === LEAVER_MEMBER)).toBe(true);

		// The RETRY (store healthy again) completes the leave cleanly.
		const retried = await leaveRoomAsUser(ROOM, LEAVER_UID);
		expect(retried).toEqual({ left: true, closed: false });
		const seatsAfter = sessionState(db).seats as Record<string, { memberId: string | null }>;
		expect(Object.values(seatsAfter).every((s) => s.memberId !== LEAVER_MEMBER)).toBe(true);
		expect(members(db).some((m) => m.id === LEAVER_MEMBER)).toBe(false);
	});

	test('ALREADY-UNSEATED leaver (the common abandoned-entry case): the benign "no claimed seat" rejection still deletes the membership', async () => {
		const db = seedLobby({ seated: false });
		const result = await leaveRoomAsUser(ROOM, LEAVER_UID);
		expect(result).toEqual({ left: true, closed: false });
		expect(members(db).some((m) => m.id === LEAVER_MEMBER)).toBe(false);
		// The other human's lobby survives untouched.
		expect(db.getSession(ROOM)?.status).toBe('lobby');
	});

	test('LAST human leaving an (unseated) lobby closes it instead of stranding an orphan', async () => {
		const db = seedLobby({ seated: false, withOtherHuman: false });
		const result = await leaveRoomAsUser(ROOM, LEAVER_UID);
		expect(result).toEqual({ left: true, closed: true });
		expect(db.getSession(ROOM)?.status).toBe('closed');
	});

	test('no membership at all is a safe no-op', async () => {
		seedLobby({ seated: false });
		const result = await leaveRoomAsUser(ROOM, 'uid-stranger');
		expect(result).toEqual({ left: false, closed: false });
	});
});
