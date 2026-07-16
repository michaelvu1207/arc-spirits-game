import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakePlayDb } from './fakePlayDb';

const holder = vi.hoisted(() => ({ dbs: {} as Record<string, unknown> }));
vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: (schema = 'arc_spirits_game') => holder.dbs[schema] ?? null
}));
vi.mock('./service', () => ({
	createRoom: vi.fn(async () => ({ roomCode: 'PRIV42', memberId: 'host-member' })),
	joinRoom: vi.fn(async (_room: string, _name: string, userId: string) => ({ memberId: `member-${userId}`, created: true })),
	loadRoomView: vi.fn(async (_room: string, viewer: { userId?: string }) => ({
		projection: { roomCode: 'PRIV42', status: 'lobby' },
		member: { id: viewer.userId ? `member-${viewer.userId}` : null, role: 'player' }
	}))
}));

import {
	acceptSocialInvite,
	blockPlayer,
	createSocialInvite,
	ensureParty,
	previewSocialInvite,
	setPresence,
	socialSnapshot
} from './social';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function setup() {
	const play = new FakePlayDb({ rpc: true });
	const pub = new FakePlayDb({ rpc: true });
	holder.dbs = { arc_spirits_2d: play, public: pub };
	for (const [id, display_name] of [[A, 'Aster'], [B, 'Bramble'], [C, 'Cinder']]) {
		pub.rowsFor('profiles').push({ id, display_name });
	}
	return { play, pub };
}

beforeEach(() => setup());

describe('live social authority', () => {
	test('party invite is stable, one-use, retry-safe, and restores the same party snapshot', async () => {
		const party = await ensureParty(A);
		expect((await ensureParty(A)).id).toBe(party.id);
		const invite = await createSocialInvite(A, { kind: 'party' });
		expect(invite.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		await expect(previewSocialInvite(invite.token)).resolves.toMatchObject({ kind: 'party', from: 'Aster', used: false });
		await expect(acceptSocialInvite(B, invite.token)).resolves.toMatchObject({ kind: 'party', partyId: party.id });
		await expect(acceptSocialInvite(B, invite.token)).resolves.toMatchObject({ kind: 'party', partyId: party.id });
		await expect(acceptSocialInvite(C, invite.token)).rejects.toMatchObject({ status: 410 });
		const snapshot = await socialSnapshot(B);
		expect(snapshot.party?.id).toBe(party.id);
		expect(snapshot.party?.members.map((member) => member.displayName)).toEqual(['Aster', 'Bramble']);
	});

	test('targeted friend invite cannot be stolen; multi-device presence stays online and hides room codes from non-party friends', async () => {
		const invite = await createSocialInvite(A, { kind: 'friend', targetUserId: B });
		await expect(acceptSocialInvite(C, invite.token)).rejects.toMatchObject({ status: 404 });
		await acceptSocialInvite(B, invite.token);
		await setPresence(B, { clientId: 'browser-0001', platform: 'web', state: 'online', visibility: 'friends' });
		await setPresence(B, { clientId: 'iphone-00001', platform: 'ios', state: 'in_game', visibility: 'friends', roomCode: 'SECRET' });
		const snapshot = await socialSnapshot(A);
		expect(snapshot.friends).toHaveLength(1);
		expect(snapshot.friends[0]).toMatchObject({
			userId: B,
			displayName: 'Bramble',
			presence: { state: 'in_game', roomCode: null }
		});
	});

	test('blocking atomically removes friendship, shared party visibility, and outstanding targeted invites', async () => {
		await ensureParty(A);
		const partyInvite = await createSocialInvite(A, { kind: 'party', targetUserId: B });
		await acceptSocialInvite(B, partyInvite.token);
		const friendInvite = await createSocialInvite(A, { kind: 'friend', targetUserId: B });
		await acceptSocialInvite(B, friendInvite.token);
		const outstanding = await createSocialInvite(B, { kind: 'friend', targetUserId: A });
		await blockPlayer(A, B);
		const snapshot = await socialSnapshot(A);
		expect(snapshot.friends).toEqual([]);
		expect(snapshot.party?.members.map((member) => member.userId)).toEqual([A]);
		await expect(acceptSocialInvite(A, outstanding.token)).rejects.toMatchObject({ status: 404 });
		await expect(createSocialInvite(B, { kind: 'friend', targetUserId: A })).rejects.toMatchObject({ status: 404 });
	});

	test('recent rivals derive only from finalized human opponent rows and deduplicate', async () => {
		const { play } = setup();
		play.rowsFor('match_result_players').push(
			{ session_id: 's1', user_id: A, display_name: 'Aster', is_bot: false, created_at: '2026-07-13T02:00:00Z' },
			{ session_id: 's1', user_id: B, display_name: 'Bramble', is_bot: false, created_at: '2026-07-13T02:00:00Z' },
			{ session_id: 's1', user_id: C, display_name: 'Bot', is_bot: true, created_at: '2026-07-13T02:00:00Z' },
			{ session_id: 's2', user_id: A, display_name: 'Aster', is_bot: false, created_at: '2026-07-13T01:00:00Z' },
			{ session_id: 's2', user_id: B, display_name: 'Bramble', is_bot: false, created_at: '2026-07-13T01:00:00Z' }
		);
		const snapshot = await socialSnapshot(A);
		expect(snapshot.recentRivals).toEqual([{ userId: B, displayName: 'Bramble' }]);
	});
});
