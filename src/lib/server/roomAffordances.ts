/**
 * HTTP-path affordances threading (plans/ux-overhaul.md §5). The WS room server
 * already ships RoomView v2 (projection + per-seat affordances); the HTTP `/view`
 * and `/commands` responses were still v1. This decorates a RoomView with the
 * SAME `affordances` block so affordance-driven UI (pass-turn legality, §5.2
 * location interactions) works identically on both transports.
 *
 * Lives in routes-land (not src/lib/play/**): it only composes the engine's
 * exported entry points, never re-derives a rule.
 */
import type { RoomView } from '$lib/play/server/service';
import { loadRawRoomState } from '$lib/play/server/service';
import { loadPlayCatalog } from '$lib/play/server/catalog';
import { computeAffordances, type SeatAffordances } from '$lib/play/viewV2';
import type { SeatColor } from '$lib/play/types';

export type RoomViewWithAffordances = RoomView & {
	affordances: Partial<Record<SeatColor, SeatAffordances>>;
};

/**
 * Attach the viewer's own affordances (secrecy: only their seat) to a RoomView.
 * Best-effort: any failure — or a state revision that moved between the two
 * loads — degrades to an empty block, which the client treats as "no affordance
 * data" (legacy behavior), never as "nothing is legal".
 */
export async function withAffordances(
	roomCode: string,
	view: RoomView
): Promise<RoomViewWithAffordances> {
	const seat = view.member.seatColor;
	if (!seat || view.projection.status !== 'active') return { ...view, affordances: {} };
	try {
		const [state, catalog] = await Promise.all([loadRawRoomState(roomCode), loadPlayCatalog()]);
		if (state.revision !== view.projection.revision) return { ...view, affordances: {} };
		return { ...view, affordances: { [seat]: computeAffordances(state, seat, catalog) } };
	} catch {
		return { ...view, affordances: {} };
	}
}
