/**
 * Room visibility & admission — the PURE decision half, enforced centrally by every
 * discovery/entry path (browse, join, view, chat, seat, spectate, postgame, WS
 * ticket mint). One rule set so a hidden room cannot leak through a side door.
 *
 *  - PUBLIC casual rooms: listable in the server browser; joinable/spectatable by
 *    policy while open.
 *  - PRIVATE rooms (ranked/matchmade parties, rematch lobbies): never listed, never
 *    generically joinable, and invisible (404) to non-members on every read path —
 *    their existence is not confirmed to outsiders.
 *  - RANKED rooms are additionally never wire-joinable at all: seating is produced
 *    exclusively by the matchmaker (server-internal).
 */

export type RoomVisibility = 'public' | 'private';

export interface RoomAdmissionFacts {
	mode: 'casual' | 'ranked';
	visibility: RoomVisibility;
	status: 'lobby' | 'active' | 'finished' | 'closed';
}

/** Normalize a raw session row's visibility column (absent on pre-migration rows:
 *  ranked rooms were always party-only, so they default private; casual public). */
export function roomVisibility(row: { visibility?: string | null; mode?: string | null }): RoomVisibility {
	if (row.visibility === 'private' || row.visibility === 'public') return row.visibility;
	return row.mode === 'ranked' ? 'private' : 'public';
}

/** May this room appear in the PUBLIC server browser? */
export function canListPublicly(facts: RoomAdmissionFacts): boolean {
	return facts.visibility === 'public' && facts.mode === 'casual';
}

/** May a wire caller WITHOUT an existing membership join this room? */
export function canJoinFromWire(facts: RoomAdmissionFacts, hasExistingMembership: boolean): boolean {
	if (facts.status === 'finished' || facts.status === 'closed') return false;
	if (hasExistingMembership) return true; // idempotent recovery re-join
	return facts.visibility === 'public' && facts.mode === 'casual';
}

/** May this caller READ the room (view/chat/postgame/WS spectate)? Non-members can
 *  read public rooms; private rooms exist only for their members. */
export function canViewRoom(facts: RoomAdmissionFacts, isMember: boolean): boolean {
	if (isMember) return true;
	return facts.visibility === 'public';
}
