import { createHash, randomBytes } from 'node:crypto';
import { error as kitError } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { createRoom, joinRoom, loadRoomView } from './service';

type Row = Record<string, any>;
type InviteKind = 'friend' | 'party' | 'room';

function db() {
	const value = getSupabaseAdmin('arc_spirits_2d');
	if (!value) throw kitError(503, 'Live social service is not configured.');
	return value;
}

function profilesDb() {
	const value = getSupabaseAdmin('public');
	if (!value) throw kitError(503, 'Live social service is not configured.');
	return value;
}

function pair(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a];
}

function digest(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

async function names(userIds: string[]): Promise<Map<string, string>> {
	const ids = [...new Set(userIds.filter(Boolean))];
	if (!ids.length) return new Map();
	const result = await profilesDb().from('profiles').select('id,display_name').in('id', ids);
	if (result.error) return new Map(ids.map((id) => [id, `Spirit ${id.slice(0, 6)}`]));
	return new Map(((result.data ?? []) as Row[]).map((row) => [String(row.id), String(row.display_name || `Spirit ${String(row.id).slice(0, 6)}`)]));
}

async function displayName(userId: string): Promise<string> {
	return (await names([userId])).get(userId) ?? `Spirit ${userId.slice(0, 6)}`;
}

async function blockedEither(a: string, b: string): Promise<boolean> {
	const forward = await db().from('social_blocks').select('blocker_user_id')
		.eq('blocker_user_id', a).eq('blocked_user_id', b).maybeSingle();
	if (forward.data) return true;
	const reverse = await db().from('social_blocks').select('blocker_user_id')
		.eq('blocker_user_id', b).eq('blocked_user_id', a).maybeSingle();
	return reverse.data != null;
}

async function partyMembership(userId: string): Promise<Row | null> {
	const result = await db().from('social_party_members').select('*').eq('user_id', userId).maybeSingle();
	if (result.error) throw kitError(503, 'Could not load party membership.');
	return result.data as Row | null;
}

async function partyRecord(partyId: string): Promise<Row> {
	const result = await db().from('social_parties').select('*').eq('id', partyId).maybeSingle();
	if (result.error || !result.data) throw kitError(404, 'Party not found.');
	return result.data as Row;
}

export async function ensureParty(userId: string) {
	const existing = await partyMembership(userId);
	if (existing) return partyRecord(String(existing.party_id));
	const created = await db().from('social_parties').insert({ owner_user_id: userId }).select('*').single();
	if (created.error || !created.data) throw kitError(503, 'Could not create party.');
	const party = created.data as Row;
	const member = await db().from('social_party_members').insert({
		party_id: party.id, user_id: userId, role: 'owner'
	});
	if (member.error) {
		await db().from('social_parties').delete().eq('id', party.id);
		const winner = await partyMembership(userId);
		if (winner) return partyRecord(String(winner.party_id));
		throw kitError(409, 'Could not create party.');
	}
	return party;
}

export async function leaveParty(userId: string): Promise<{ left: true }> {
	const mine = await partyMembership(userId);
	if (!mine) return { left: true };
	const members = await db().from('social_party_members').select('*')
		.eq('party_id', mine.party_id).order('joined_at', { ascending: true });
	if (members.error) throw kitError(503, 'Could not leave party.');
	const others = ((members.data ?? []) as Row[]).filter((row) => row.user_id !== userId);
	if (mine.role === 'owner' && others.length) {
		const next = others[0];
		await db().from('social_party_members').update({ role: 'owner' })
			.eq('party_id', mine.party_id).eq('user_id', next.user_id);
		await db().from('social_parties').update({ owner_user_id: next.user_id })
			.eq('id', mine.party_id);
	}
	await db().from('social_party_members').delete().eq('party_id', mine.party_id).eq('user_id', userId);
	if (!others.length) await db().from('social_parties').delete().eq('id', mine.party_id);
	return { left: true };
}

export async function createSocialInvite(userId: string, input: {
	kind: InviteKind; targetUserId?: string | null; roomCode?: string | null;
}) {
	const kind = input.kind;
	let targetUserId = input.targetUserId?.trim() || null;
	let partyId: string | null = null;
	let roomCode: string | null = null;
	if (kind === 'friend') {
		if (!targetUserId || targetUserId === userId) throw kitError(400, 'Choose another player.');
		if (await blockedEither(userId, targetUserId)) throw kitError(404, 'Player not available.');
	} else if (kind === 'party') {
		const mine = await partyMembership(userId);
		if (!mine || mine.role !== 'owner') throw kitError(403, 'Only the party leader can invite.');
		partyId = String(mine.party_id);
		targetUserId = targetUserId && targetUserId !== userId ? targetUserId : null;
		if (targetUserId && await blockedEither(userId, targetUserId)) throw kitError(404, 'Player not available.');
	} else {
		roomCode = String(input.roomCode ?? '').trim().toUpperCase();
		if (!/^[A-Z0-9]{6}$/.test(roomCode)) throw kitError(400, 'Choose a live room.');
		const view = await loadRoomView(roomCode, { userId });
		if (!view.member.id) throw kitError(404, 'Room not found.');
	}
	const token = randomBytes(24).toString('base64url');
	const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
	const inserted = await db().from('social_invites').insert({
		token_digest: digest(token), created_by: userId, invite_kind: kind,
		target_user_id: targetUserId, party_id: partyId, room_code: roomCode,
		expires_at: expiresAt
	}).select('id').single();
	if (inserted.error) throw kitError(503, 'Could not create invite.');
	return { inviteId: String(inserted.data.id), token, url: `/invite/${token}`, kind, expiresAt };
}

export async function previewSocialInvite(token: string) {
	if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw kitError(404, 'Invite not found.');
	const result = await db().from('social_invites').select('invite_kind,created_by,expires_at,accepted_at,revoked_at')
		.eq('token_digest', digest(token)).maybeSingle();
	const row = result.data as Row | null;
	if (result.error || !row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) throw kitError(404, 'Invite not found.');
	return {
		kind: row.invite_kind,
		from: await displayName(String(row.created_by)),
		expiresAt: row.expires_at,
		used: row.accepted_at != null
	};
}

export async function acceptSocialInvite(userId: string, token: string) {
	if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw kitError(404, 'Invite not found.');
	const tokenDigest = digest(token);
	const loaded = await db().from('social_invites').select('*').eq('token_digest', tokenDigest).maybeSingle();
	const invite = loaded.data as Row | null;
	if (loaded.error || !invite || invite.revoked_at || Date.parse(invite.expires_at) <= Date.now()) throw kitError(404, 'Invite not found.');
	if (invite.target_user_id && invite.target_user_id !== userId) throw kitError(404, 'Invite not found.');
	if (invite.created_by === userId || await blockedEither(userId, String(invite.created_by))) throw kitError(404, 'Invite not found.');
	if (invite.accepted_at && invite.accepted_by !== userId) throw kitError(410, 'Invite already used.');
	// Join the party before consuming the one-use capability. PostgreSQL's
	// trigger serializes inserts and structurally caps the party at four; if a
	// competing redemption wins the capability CAS, compensate this insert.
	if (invite.invite_kind === 'party' && !invite.accepted_at) {
		const current = await partyMembership(userId);
		let inserted = false;
		if (current && String(current.party_id) !== String(invite.party_id)) {
			throw kitError(409, 'Leave your current party before joining another.');
		}
		if (!current) {
			const joined = await db().from('social_party_members').insert({
				party_id: invite.party_id, user_id: userId, role: 'member'
			});
			if (joined.error) {
				if (/party is full|23514/i.test(joined.error.message ?? '')) throw kitError(409, 'Party is full.');
				throw kitError(409, 'Leave your current party before joining another.');
			}
			inserted = true;
		}
		const accepted = await db().from('social_invites').update({
			accepted_by: userId, accepted_at: new Date().toISOString()
		}).eq('id', invite.id).is('accepted_at', null).select('*').maybeSingle();
		if (!accepted.data) {
			const winner = await db().from('social_invites').select('*').eq('id', invite.id).maybeSingle();
			if (!winner.data || winner.data.accepted_by !== userId) {
				if (inserted) await db().from('social_party_members').delete()
					.eq('party_id', invite.party_id).eq('user_id', userId);
				throw kitError(410, 'Invite already used.');
			}
		}
		return { kind: 'party' as const, partyId: invite.party_id };
	}
	if (!invite.accepted_at) {
		const accepted = await db().from('social_invites').update({
			accepted_by: userId, accepted_at: new Date().toISOString()
		}).eq('id', invite.id).is('accepted_at', null).select('*').maybeSingle();
		if (!accepted.data) {
			const winner = await db().from('social_invites').select('*').eq('id', invite.id).maybeSingle();
			if (!winner.data || winner.data.accepted_by !== userId) throw kitError(410, 'Invite already used.');
		}
	}
	if (invite.invite_kind === 'friend') {
		const [userLow, userHigh] = pair(userId, String(invite.created_by));
		const friend = await db().from('social_friendships').upsert({
			user_low: userLow, user_high: userHigh, requested_by: invite.created_by,
			status: 'accepted', accepted_at: new Date().toISOString()
		}, { onConflict: 'user_low,user_high' });
		if (friend.error) throw kitError(503, 'Could not accept friend invite.');
		return { kind: 'friend' as const };
	}
	if (invite.invite_kind === 'party') return { kind: 'party' as const, partyId: invite.party_id };
	const name = await displayName(userId);
	const member = await joinRoom(String(invite.room_code), name, userId, { admission: 'internal' });
	return { kind: 'room' as const, roomCode: invite.room_code, memberId: member.memberId };
}

export async function revokeSocialInvite(userId: string, inviteId: string) {
	const result = await db().from('social_invites').update({ revoked_at: new Date().toISOString() })
		.eq('id', inviteId).eq('created_by', userId).is('accepted_at', null).select('id').maybeSingle();
	if (result.error || !result.data) throw kitError(404, 'Invite not found.');
	return { revoked: true };
}

export async function blockPlayer(userId: string, blockedUserId: string) {
	if (!blockedUserId || blockedUserId === userId) throw kitError(400, 'Choose another player.');
	const insert = await db().from('social_blocks').upsert({
		blocker_user_id: userId, blocked_user_id: blockedUserId
	}, { onConflict: 'blocker_user_id,blocked_user_id' });
	if (insert.error) throw kitError(503, 'Could not block player.');
	const [userLow, userHigh] = pair(userId, blockedUserId);
	await db().from('social_friendships').delete().eq('user_low', userLow).eq('user_high', userHigh);
	// Outstanding targeted capabilities stop working immediately in both directions.
	await db().from('social_invites').update({ revoked_at: new Date().toISOString() })
		.eq('created_by', userId).eq('target_user_id', blockedUserId).is('accepted_at', null);
	await db().from('social_invites').update({ revoked_at: new Date().toISOString() })
		.eq('created_by', blockedUserId).eq('target_user_id', userId).is('accepted_at', null);
	// A block cannot leave the two identities sharing party presence. The leader
	// removes the blocked member; otherwise the blocker leaves their shared party.
	const blockerParty = await partyMembership(userId);
	const blockedParty = await partyMembership(blockedUserId);
	if (blockerParty && blockedParty && blockerParty.party_id === blockedParty.party_id) {
		if (blockerParty.role === 'owner') {
			await db().from('social_party_members').delete()
				.eq('party_id', blockerParty.party_id).eq('user_id', blockedUserId);
		} else {
			await leaveParty(userId);
		}
	}
	return { blocked: true };
}

export async function setPresence(userId: string, input: {
	state?: string; visibility?: string; roomCode?: string | null; clientId?: string; platform?: string;
}) {
	const state = ['online', 'away', 'in_game'].includes(input.state ?? '') ? input.state! : 'online';
	const visibility = ['friends', 'party', 'hidden'].includes(input.visibility ?? '') ? input.visibility! : 'friends';
	const clientId = /^[A-Za-z0-9_-]{8,64}$/.test(input.clientId ?? '') ? input.clientId! : 'web-default';
	const platform = ['web', 'godot', 'ios', 'android'].includes(input.platform ?? '') ? input.platform! : 'web';
	const expiresAt = new Date(Date.now() + 90_000).toISOString();
	const result = await db().from('social_presence').upsert({
		user_id: userId, client_id: clientId, state, visibility, platform,
		room_code: state === 'in_game' ? (input.roomCode?.slice(0, 6).toUpperCase() || null) : null,
		expires_at: expiresAt, updated_at: new Date().toISOString()
	}, { onConflict: 'user_id,client_id' });
	if (result.error) throw kitError(503, 'Could not update presence.');
	return { state, visibility, clientId, platform, expiresAt };
}

export async function createPartyRoom(userId: string) {
	const mine = await partyMembership(userId);
	if (!mine || mine.role !== 'owner') throw kitError(403, 'Only the party leader can create the room.');
	const party = await partyRecord(String(mine.party_id));
	if (party.active_room_code) {
		try {
			const view = await loadRoomView(String(party.active_room_code), { userId });
			if (view.member.id) return { roomCode: party.active_room_code, memberId: view.member.id, view };
		} catch {
			// Clear only the stale value we observed; a concurrent leader request that
			// already replaced it wins and remains untouched.
			await db().from('social_parties').update({ active_room_code: null })
				.eq('id', mine.party_id).eq('active_room_code', party.active_room_code);
		}
	}
	const memberRows = await db().from('social_party_members').select('user_id').eq('party_id', mine.party_id);
	if (memberRows.error) throw kitError(503, 'Could not load party.');
	const memberIds = ((memberRows.data ?? []) as Row[]).map((row) => String(row.user_id));
	const byName = await names(memberIds);
	const created = await createRoom(byName.get(userId) ?? 'Party Leader', userId, 'casual', { visibility: 'private' });
	for (const memberId of memberIds) {
		if (memberId === userId) continue;
		await joinRoom(created.roomCode, byName.get(memberId) ?? 'Party Member', memberId, { admission: 'internal' });
	}
	const claimed = await db().from('social_parties').update({
		active_room_code: created.roomCode, updated_at: new Date().toISOString()
	}).eq('id', mine.party_id).is('active_room_code', null).select('id').maybeSingle();
	if (!claimed.data) {
		const winner = await partyRecord(String(mine.party_id));
		// This candidate lost the single-party-room CAS. Delete only the private,
		// unstarted shell we just created; the winning room is returned to everyone.
		const candidate = await db().from('play_game_sessions').select('id,status')
			.eq('room_code', created.roomCode).maybeSingle();
		if (candidate.data?.status === 'lobby') {
			await db().from('play_session_members').delete().eq('session_id', candidate.data.id);
			await db().from('play_game_sessions').delete().eq('id', candidate.data.id);
		}
		const view = await loadRoomView(String(winner.active_room_code), { userId });
		return { roomCode: winner.active_room_code, memberId: view.member.id, view };
	}
	return {
		roomCode: created.roomCode,
		memberId: created.memberId,
		view: await loadRoomView(created.roomCode, { userId })
	};
}

export async function loadPartyRoom(userId: string) {
	const mine = await partyMembership(userId);
	if (!mine) throw kitError(404, 'Party not found.');
	const party = await partyRecord(String(mine.party_id));
	if (!party.active_room_code) return { roomCode: null, memberId: null, view: null };
	const view = await loadRoomView(String(party.active_room_code), { userId });
	return { roomCode: party.active_room_code, memberId: view.member.id, view };
}

export async function socialSnapshot(userId: string) {
	const low = await db().from('social_friendships').select('*').eq('user_low', userId);
	const high = await db().from('social_friendships').select('*').eq('user_high', userId);
	if (low.error || high.error) throw kitError(503, 'Could not load friends.');
	const friendshipRows = [...(low.data ?? []), ...(high.data ?? [])] as Row[];
	const friendIds = friendshipRows.filter((row) => row.status === 'accepted')
		.map((row) => String(row.user_low === userId ? row.user_high : row.user_low));
	const pendingIds = friendshipRows.filter((row) => row.status === 'pending')
		.map((row) => String(row.user_low === userId ? row.user_high : row.user_low));
	const mine = await partyMembership(userId);
	let party: Row | null = null;
	let partyMembers: Row[] = [];
	if (mine) {
		party = await partyRecord(String(mine.party_id));
		const members = await db().from('social_party_members').select('*').eq('party_id', mine.party_id)
			.order('joined_at', { ascending: true });
		partyMembers = (members.data ?? []) as Row[];
	}
	const partyIds = partyMembers.map((row) => String(row.user_id));
	const allIds = [...new Set([...friendIds, ...pendingIds, ...partyIds])];
	const byName = await names(allIds);
	const presence = allIds.length
		? await db().from('social_presence').select('*').in('user_id', allIds).gt('expires_at', new Date().toISOString())
		: { data: [], error: null };
	const presenceByUser = new Map<string, Row>();
	const presencePriority: Record<string, number> = { away: 0, online: 1, in_game: 2 };
	for (const row of (presence.data ?? []) as Row[]) {
		const id = String(row.user_id);
		const current = presenceByUser.get(id);
		if (!current || (presencePriority[row.state] ?? 0) > (presencePriority[current.state] ?? 0)
			|| ((presencePriority[row.state] ?? 0) === (presencePriority[current.state] ?? 0)
				&& Date.parse(row.updated_at) > Date.parse(current.updated_at))) presenceByUser.set(id, row);
	}
	const isPartyMember = (id: string) => partyIds.includes(id);
	const visiblePresence = (id: string) => {
		const row = presenceByUser.get(id);
		if (!row || row.visibility === 'hidden') return null;
		if (row.visibility === 'party' && !isPartyMember(id)) return null;
		return {
			state: row.state,
			// Anti-stream-sniping: a live room code is disclosed only to the same
			// persistent party, never to ordinary friends/recent rivals.
			roomCode: isPartyMember(id) ? row.room_code : null,
			expiresAt: row.expires_at
		};
	};

	const myResults = await db().from('match_result_players').select('session_id')
		.eq('user_id', userId).eq('is_bot', false).order('created_at', { ascending: false }).limit(20);
	const sessionIds = [...new Set(((myResults.data ?? []) as Row[]).map((row) => String(row.session_id)))];
	let rivals: Row[] = [];
	if (sessionIds.length) {
		const result = await db().from('match_result_players').select('user_id,display_name,session_id,created_at')
			.in('session_id', sessionIds).eq('is_bot', false).order('created_at', { ascending: false });
		const seen = new Set<string>();
		for (const row of (result.data ?? []) as Row[]) {
			const id = String(row.user_id ?? '');
			if (!id || id === userId || friendIds.includes(id) || seen.has(id) || await blockedEither(userId, id)) continue;
			seen.add(id); rivals.push(row);
			if (rivals.length >= 8) break;
		}
	}

	return {
		party: party ? {
			id: party.id,
			ownerUserId: party.owner_user_id,
			activeRoomCode: party.active_room_code,
			members: partyMembers.map((row) => ({
				userId: row.user_id, displayName: byName.get(String(row.user_id)) ?? 'Spirit',
				role: row.role, presence: visiblePresence(String(row.user_id))
			}))
		} : null,
		friends: friendIds.map((id) => ({ userId: id, displayName: byName.get(id) ?? 'Spirit', presence: visiblePresence(id) })),
		pending: friendshipRows.filter((row) => row.status === 'pending').map((row) => {
			const other = String(row.user_low === userId ? row.user_high : row.user_low);
			return { userId: other, displayName: byName.get(other) ?? 'Spirit', direction: row.requested_by === userId ? 'outgoing' : 'incoming' };
		}),
		recentRivals: rivals.map((row) => ({ userId: row.user_id, displayName: row.display_name || 'Spirit' }))
	};
}
