/**
 * Viewer / actor derivation — ported from src/lib/play/server/service.ts
 * (viewerForMember + actorForMember). Pure: given the authoritative state and a member
 * row, decide the seat/role the connection plays as.
 */

import { SEAT_COLORS } from '../src/lib/play/types';
import type { GameActor, PublicGameState, SpectatorProjection } from '../src/lib/play/types';
import type { SessionMemberRow } from './supabase';

export type Viewer = SpectatorProjection['viewer'];

/** The viewer projection identity for a member (or a plain spectator when null).
 *  The AUTHORITATIVE state is the sole seat authority: `member.seat_color` is only a
 *  mirror and may lag a concurrent release/takeover, so it is never consulted — a
 *  member the state no longer seats is a seatless viewer, full stop. */
export function viewerForMember(state: PublicGameState, member: SessionMemberRow | null): Viewer {
	if (!member) {
		return { role: 'spectator', seatColor: null, displayName: null };
	}
	const seatColor =
		SEAT_COLORS.find((candidate) => state.seats[candidate].memberId === member.id) ?? null;
	return { role: member.role, seatColor, displayName: member.display_name };
}

/** The command actor for a seated/spectating member. */
export function actorForMember(state: PublicGameState, member: SessionMemberRow): GameActor {
	const viewer = viewerForMember(state, member);
	return {
		memberId: member.id,
		displayName: member.display_name,
		role: member.role,
		seatColor: viewer.seatColor
	};
}
