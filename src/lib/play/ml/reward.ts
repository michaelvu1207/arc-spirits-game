/**
 * Terminal returns for a finished (or capped) game, one scalar in [0,1] per seat.
 *
 * Free-for-all → placement-based: rank active seats by final VP, best place = 1.0, worst
 * = 0.0, linearly in between (ties share the average). The seat that actually reached the
 * VP target is guaranteed rank 1 (it has the most VP), so winning = 1.0. This denser signal
 * (vs pure win/loss) gives the value head and AWR something to learn from in every game,
 * including the many self-play games that time out short of a winner.
 */

import { VP_TO_WIN, type SeatColor } from '../types';

/**
 * Blend of placement and absolute VP progress. Placement is the true objective (first to
 * 30 wins), but under the current rules outright wins are rare, so a pure placement signal
 * is coarse. We add a VP-progress term so the value head and AWR get a denser gradient —
 * crucially this rewards the PvP line (which racks up VP via +3-per-attack group attacks), the
 * only line that actually reaches 30 under current rules. winnerSeat (reached 30) is pinned
 * to 1.0 so winning always dominates.
 */
const PLACEMENT_WEIGHT = 0.7;
const VP_WEIGHT = 0.3;

export function computeReturns(
	finalVP: Record<string, number>,
	activeSeats: SeatColor[],
	winnerSeat?: SeatColor | null
): Record<string, number> {
	const seats = activeSeats.filter((s) => s in finalVP);
	const n = seats.length;
	const out: Record<string, number> = {};
	if (n <= 1) {
		for (const s of seats) out[s] = 1;
		return out;
	}
	// Placement (1.0 best … 0.0 worst), ties share the average.
	const sorted = [...seats].sort((a, b) => finalVP[b] - finalVP[a]);
	const place: Record<string, number> = {};
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j + 1 < sorted.length && finalVP[sorted[j + 1]] === finalVP[sorted[i]]) j++;
		const avgPlace = (i + j) / 2 + 1;
		const frac = (n - avgPlace) / (n - 1);
		for (let k = i; k <= j; k++) place[sorted[k]] = frac;
		i = j + 1;
	}
	for (const s of seats) {
		if (winnerSeat && s === winnerSeat) {
			out[s] = 1;
			continue;
		}
		const vpFrac = Math.max(0, Math.min(1, finalVP[s] / VP_TO_WIN));
		out[s] = PLACEMENT_WEIGHT * place[s] + VP_WEIGHT * vpFrac;
	}
	return out;
}
