/**
 * Entry-op abort compensation (service.ts + 20260712_entry_op_compensation.sql):
 * an aborted create/solo/join whose response never arrived (AMBIGUOUS COMMIT)
 * must still be resolvable and unwindable — through the op id the client minted
 * BEFORE sending — in EVERY arrival order:
 *
 *   - abandon AFTER the commit: the op's session/membership is found by its
 *     origin_op stamp and left/closed;
 *   - abandon BEFORE the commit lands: the tombstone wins — the late commit
 *     self-compensates on its post-commit re-check;
 *   - a join that merely REUSED a pre-existing membership stamped nothing, so
 *     the abandon removes NOTHING (the old roomCode-leave used to remove it);
 *   - a join aborted into an ACTIVE room removes exactly the newly added,
 *     unseated membership even while other humans remain;
 *   - an idempotent create replay with the same op id resolves the SAME room
 *     instead of minting a second one.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakePlayDb } from './fakePlayDb';
import { createLobbyState } from '../runtime';
import type { PlayCatalog } from '../types';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: () => holder.db
}));
vi.mock('./catalog', () => ({
	loadPlayCatalog: async () =>
		({ guardians: [], spirits: [], mats: [], classes: [] }) as unknown as PlayCatalog
}));

import { abandonEntryOp, createRoom, joinRoom } from './service';

const OP = (seed: string) => `peo_${seed.padEnd(43, 'x').slice(0, 43)}`;
const UID = 'uid-owner';

function freshDb(): FakePlayDb {
	const db = new FakePlayDb({ rpc: true });
	holder.db = db;
	return db;
}

function sessions(db: FakePlayDb) {
	return (db.tables.get('play_game_sessions') ?? []) as Record<string, any>[];
}
function members(db: FakePlayDb) {
	return (db.tables.get('play_session_members') ?? []) as Record<string, any>[];
}

function seedPublicLobby(db: FakePlayDb, roomCode: string, hostUid: string) {
	const state = createLobbyState({ roomCode, guardianNames: ['Pyra', 'Aqua'] });
	db.seedSession({
		id: `sess-${roomCode}`,
		room_code: roomCode,
		status: 'lobby',
		mode: 'casual',
		visibility: 'public',
		revision: state.revision,
		public_state: state,
		created_at: new Date().toISOString()
	});
	db.seedMember({
		id: `m-host-${roomCode}`,
		session_id: `sess-${roomCode}`,
		user_id: hostUid,
		display_name: 'Host',
		is_bot: false,
		role: 'host'
	});
	return state;
}

beforeEach(() => {
	holder.db = null;
});

describe('entry-op compensation — CREATE/SOLO', () => {
	test('abandon AFTER the commit: the op-stamped room is resolved with no roomCode in hand and left/closed', async () => {
		const db = freshDb();
		const op = OP('create-late-abandon');
		const created = await createRoom('Maker', UID, 'casual', { originOp: op });
		expect(sessions(db).find((s) => s.room_code === created.roomCode)?.origin_op).toBe(op);

		// The client never saw the response — it knows ONLY the op id.
		const result = await abandonEntryOp(op, UID);
		expect(result.compensated).toBe('room');
		// Sole human gone → the lobby is closed, membership removed.
		expect(sessions(db).find((s) => s.room_code === created.roomCode)?.status).toBe('closed');
		expect(members(db).some((m) => m.id === created.memberId)).toBe(false);
	});

	test('abandon BEFORE the commit lands: the tombstone wins and the late create self-compensates', async () => {
		const db = freshDb();
		const op = OP('create-early-abandon');
		// The abandon arrives first — nothing exists yet.
		expect((await abandonEntryOp(op, UID)).compensated).toBe('none');

		// The (delayed) create now commits — and immediately self-compensates on
		// its post-commit tombstone re-check: no live orphan room survives.
		const created = await createRoom('Maker', UID, 'casual', { originOp: op });
		expect(sessions(db).find((s) => s.room_code === created.roomCode)?.status).toBe('closed');
		expect(members(db).some((m) => m.id === created.memberId)).toBe(false);
	});

	test('idempotent replay: the same op id resolves the SAME room instead of minting a second one (ambiguous-commit resolution)', async () => {
		const db = freshDb();
		const op = OP('create-replay');
		const first = await createRoom('Maker', UID, 'casual', { originOp: op });
		const replay = await createRoom('Maker', UID, 'casual', { originOp: op });
		expect(replay.roomCode).toBe(first.roomCode);
		expect(replay.memberId).toBe(first.memberId);
		expect(sessions(db).filter((s) => s.origin_op === op)).toHaveLength(1);
	});

	test('an op id belonging to a DIFFERENT account neither resolves nor unwinds anything', async () => {
		const db = freshDb();
		const op = OP('create-foreign');
		const created = await createRoom('Maker', UID, 'casual', { originOp: op });
		// Replay under another account: refused, no membership leak.
		await expect(createRoom('Thief', 'uid-thief', 'casual', { originOp: op })).rejects.toMatchObject(
			{ status: 409 }
		);
		// Abandon under another account: that account has no membership in the
		// room, so leaveRoomAsUser is a no-op — the owner's room survives.
		await abandonEntryOp(op, 'uid-thief');
		expect(sessions(db).find((s) => s.room_code === created.roomCode)?.status).toBe('lobby');
		expect(members(db).some((m) => m.id === created.memberId)).toBe(true);
	});
});

describe('entry-op compensation — JOIN', () => {
	test('abandon removes EXACTLY the membership the op created (lobby): pre-existing memberships are untouchable', async () => {
		const db = freshDb();
		seedPublicLobby(db, 'JOIN01', 'uid-host');
		const op = OP('join-created');
		const joined = await joinRoom('JOIN01', 'Joiner', UID, { originOp: op });
		expect(joined.created).toBe(true);
		expect(members(db).find((m) => m.id === joined.memberId)?.origin_op).toBe(op);

		expect((await abandonEntryOp(op, UID)).compensated).toBe('membership');
		expect(members(db).some((m) => m.id === joined.memberId)).toBe(false);
		// The host's room lives on.
		expect(db.getSession('JOIN01')?.status).toBe('lobby');
		expect(members(db).some((m) => m.user_id === 'uid-host')).toBe(true);
	});

	test('a join that REUSED a pre-existing membership stamps nothing — its abandoned op removes NOTHING (the old roomCode-leave removed it)', async () => {
		const db = freshDb();
		seedPublicLobby(db, 'JOIN02', 'uid-host');
		// The user is ALREADY a member (an earlier, un-op-stamped join).
		db.seedMember({
			id: 'm-preexisting',
			session_id: 'sess-JOIN02',
			user_id: UID,
			display_name: 'Regular',
			is_bot: false
		});
		const op = OP('join-reused');
		const joined = await joinRoom('JOIN02', 'Regular', UID, { originOp: op });
		expect(joined.created).toBe(false);
		expect(joined.memberId).toBe('m-preexisting');
		expect(members(db).find((m) => m.id === 'm-preexisting')?.origin_op ?? null).toBeNull();

		expect((await abandonEntryOp(op, UID)).compensated).toBe('none');
		// The pre-existing membership SURVIVES the aborted duplicate join.
		expect(members(db).some((m) => m.id === 'm-preexisting')).toBe(true);
	});

	test('abandon BEFORE the join commit lands: the tombstone wins and the late join self-compensates, leaving no ghost membership', async () => {
		const db = freshDb();
		seedPublicLobby(db, 'JOIN03', 'uid-host');
		const op = OP('join-early-abandon');
		expect((await abandonEntryOp(op, UID)).compensated).toBe('none');

		const joined = await joinRoom('JOIN03', 'Joiner', UID, { originOp: op });
		// The commit landed — and was immediately unwound by the re-check.
		expect(members(db).some((m) => m.id === joined.memberId)).toBe(false);
		expect(db.getSession('JOIN03')?.status).toBe('lobby'); // host unaffected
	});

	test('ACTIVE room: the op-created, UNSEATED membership is removed even while other humans remain — nothing else is touched', async () => {
		const db = freshDb();
		const state = createLobbyState({ roomCode: 'ACTIVE1', guardianNames: ['Pyra'] });
		state.status = 'active';
		db.seedSession({
			id: 'sess-ACTIVE1',
			room_code: 'ACTIVE1',
			status: 'active',
			mode: 'casual',
			visibility: 'public',
			revision: state.revision,
			public_state: state,
			created_at: new Date().toISOString()
		});
		db.seedMember({
			id: 'm-playing',
			session_id: 'sess-ACTIVE1',
			user_id: 'uid-playing',
			display_name: 'In Game',
			is_bot: false
		});
		// The op-created membership (an aborted join-to-chat/spectate).
		db.seedMember({
			id: 'm-late',
			session_id: 'sess-ACTIVE1',
			user_id: UID,
			display_name: 'Late Joiner',
			is_bot: false,
			origin_op: OP('join-active')
		});

		expect((await abandonEntryOp(OP('join-active'), UID)).compensated).toBe('membership');
		expect(members(db).some((m) => m.id === 'm-late')).toBe(false);
		// The other human's live game is untouched — no close, no membership loss.
		expect(db.getSession('ACTIVE1')?.status).toBe('active');
		expect(members(db).some((m) => m.id === 'm-playing')).toBe(true);
	});

	test('FAIL-CLOSED: a tombstone write failure makes the abandon throw (retryable) instead of reporting an uncompensatable cancellation', async () => {
		const db = freshDb();
		seedPublicLobby(db, 'JOIN04', 'uid-host');
		const op = OP('join-tomb-fail');
		const joined = await joinRoom('JOIN04', 'Joiner', UID, { originOp: op });
		db.failNextOp('play_entry_op_cancellations', 'upsert', 'error');

		await expect(abandonEntryOp(op, UID)).rejects.toMatchObject({ status: 500 });
		expect(members(db).some((m) => m.id === joined.memberId)).toBe(true); // coherent

		expect((await abandonEntryOp(op, UID)).compensated).toBe('membership');
		expect(members(db).some((m) => m.id === joined.memberId)).toBe(false);
	});

	test('a malformed op id is inert end-to-end (no stamp, no resolution)', async () => {
		const db = freshDb();
		seedPublicLobby(db, 'JOIN05', 'uid-host');
		const joined = await joinRoom('JOIN05', 'Joiner', UID, { originOp: 'peo_short' });
		expect(members(db).find((m) => m.id === joined.memberId)?.origin_op ?? null).toBeNull();
		expect((await abandonEntryOp('peo_short', UID)).compensated).toBe('none');
		expect(members(db).some((m) => m.id === joined.memberId)).toBe(true);
	});
});
