/**
 * Member-row mirror sync (seat_color / selected_guardian / role), client-injected so
 * BOTH transports keep `play_session_members` consistent with the committed state.
 * The WebSocket path previously skipped this — a `claimSeat` over WS left the member
 * row stale, which is exactly the live failure the Godot port documented
 * ("WS claimSeat then HTTP /bots/add → 'Only seated player can change guardian'").
 *
 * No `$env` / SvelteKit imports — throws plain Errors; callers decide severity.
 */
import { SEAT_COLORS } from '../types';
import type { MemberRole, PublicGameState } from '../types';
import type { PlayDbClient } from './commit';

const MEMBERS_TABLE = 'play_session_members';

interface MirrorMemberRow {
	id: string;
	role: MemberRole;
}

/**
 * Mirror each member's seat/guardian/role from the committed state. Runs the
 * per-member writes CONCURRENTLY (independent rows). NOTE: never touches
 * last_seen_at — that column is a per-member liveness signal owned by the member's
 * own polls/commands.
 */
export async function syncMemberMirrorsWith(
	admin: PlayDbClient,
	sessionId: string,
	state: PublicGameState
): Promise<void> {
	const { data, error } = await admin
		.from(MEMBERS_TABLE)
		.select('id, role')
		.eq('session_id', sessionId);
	if (error) {
		throw new Error(`Failed to load session members: ${error.message}`);
	}
	const members = (data as MirrorMemberRow[] | null) ?? [];

	const results = await Promise.all(
		members.map((member) => {
			const occupiedSeat =
				SEAT_COLORS.find((seatColor) => state.seats[seatColor].memberId === member.id) ?? null;
			const selectedGuardian = occupiedSeat
				? (state.seats[occupiedSeat].selectedGuardian ?? null)
				: null;
			const role: MemberRole =
				member.role === 'host' ? 'host' : occupiedSeat ? 'player' : 'spectator';

			return admin
				.from(MEMBERS_TABLE)
				.update({ seat_color: occupiedSeat, selected_guardian: selectedGuardian, role })
				.eq('id', member.id);
		})
	);

	const failed = results.find((result: { error: { message: string } | null }) => result.error);
	if (failed?.error) {
		throw new Error(`Failed to update member mirror: ${failed.error.message}`);
	}
}

/** Cheap change detector: do the committed seats differ from the prior state in any
 *  member-mirror-relevant way (occupant or guardian)? Lets the WS host skip the
 *  member-table writes on the hot path (bot ticks, in-phase actions). */
export function seatMirrorsChanged(prev: PublicGameState, next: PublicGameState): boolean {
	for (const seat of SEAT_COLORS) {
		const a = prev.seats[seat];
		const b = next.seats[seat];
		if ((a?.memberId ?? null) !== (b?.memberId ?? null)) return true;
		if ((a?.selectedGuardian ?? null) !== (b?.selectedGuardian ?? null)) return true;
	}
	return false;
}
