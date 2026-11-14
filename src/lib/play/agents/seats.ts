import { botSeatNeedsToAct } from '../server/botPolicy';
import type { PublicGameState, SeatColor } from '../types';

/** Seats that must act now; a pending Navigation Power prompt blocks everyone else. Shared by
 *  the harness runner and live AI seats (server/aiPlayers.ts). */
export function seatsToAct(state: PublicGameState): SeatColor[] {
	const needing = state.activeSeats.filter((seat) => botSeatNeedsToAct(state, seat));
	const prompted = needing.filter((seat) => {
		const p = state.players[seat];
		return (
			(p?.navigationPowerOffers?.length ?? 0) > 0 || p?.pendingNavigationTrade?.toSeat === seat
		);
	});
	return prompted.length ? prompted : needing;
}
