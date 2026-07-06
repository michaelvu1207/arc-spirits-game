/**
 * Per-connection view construction. Each connection gets its OWN viewer-filtered
 * RoomViewV2 — never a shared object — because the projection blanks owner-private
 * fields per viewer (secrecy note in viewV2.ts).
 */

import { buildRoomViewV2, type RoomViewMember, type RoomViewV2 } from '../src/lib/play/viewV2';
import { SEAT_COLORS } from '../src/lib/play/types';
import type {
	PlayCatalog,
	PublicGameState,
	SeatColor,
	SpectatorProjection
} from '../src/lib/play/types';

export type Viewer = SpectatorProjection['viewer'];

/**
 * Build the RoomViewV2 for one viewer: the engine projection + this seat's affordances
 * (buildRoomViewV2 attaches affordances only for the viewer's own seat — secrecy). Bot
 * seat flags are stamped from the preloaded room map afterwards.
 */
export function buildViewForViewer(
	state: PublicGameState,
	viewer: Viewer,
	member: RoomViewMember,
	catalog: PlayCatalog,
	botMembers: Map<string, string | null>
): RoomViewV2 {
	const view = buildRoomViewV2(state, viewer, member, catalog);
	attachBotSeatFlags(view.projection, botMembers);
	return view;
}

/** Stamp `projection.seats[seat].isBot` from the preloaded bot-member map (mirrors
 *  service.attachBotSeatFlags, but synchronous — the map is loaded once per room). */
function attachBotSeatFlags(
	projection: SpectatorProjection,
	botMembers: Map<string, string | null>
): void {
	for (const seat of SEAT_COLORS) {
		const seatState = projection.seats[seat as SeatColor];
		if (!seatState) continue;
		const memberId = seatState.memberId;
		seatState.isBot = memberId != null && botMembers.has(memberId);
	}
}
