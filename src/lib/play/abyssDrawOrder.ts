
import type { PublicGameState, SeatColor } from './types';

/** The players at the Arcane Abyss this round in drawing order (fewest points at the start of the round first). */
export function abyssDrawOrder(state: Pick<PublicGameState, 'activeSeats' | 'players' | 'round'>): SeatColor[] {
	const seats = state.activeSeats ?? [];
	const n = seats.length;
	const start = n ? (Math.max(1, state.round ?? 1) - 1) % n : 0;
	const rank = (seat: SeatColor) => (seats.indexOf(seat) - start + n) % n;
	const points = (seat: SeatColor) => state.players[seat]?.vpHistory?.at(-1) ?? 0;
	return seats
		.filter((seat) => state.players[seat]?.navigationDestination === 'Arcane Abyss')
		.sort((a, b) => points(a) - points(b) || rank(a) - rank(b));
}

/**
 * The player `seat` must wait for before drawing from a monster deck (the first player ahead in
 * the order who may still draw), or null when `seat` may draw now. Always null with the rule off.
 */
export function abyssDrawBlockedBy(
	catalog: unknown,
	state: Pick<PublicGameState, 'activeSeats' | 'players' | 'round' | 'phase'>,
	seat: SeatColor
): SeatColor | null {
	if (state.phase !== 'location') return null;
	for (const other of abyssDrawOrder(state)) {
		if (other === seat) return null;
		const p = state.players[other];
		if (!p || p.phaseReady === true) continue;
		const revealed = (p.pendingMonsterDraw?.cards.length ?? 0) > 0;
		// Rule `monsterDrawOne`: a full hand may still draw (the card can replace a held one).
		const mayStillDraw = p.monsterDrawRound !== state.round && true;
		if (revealed || mayStillDraw) return other;
	}
	return null;
}
