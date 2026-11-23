/**
 * Rule `abyssDrawByPoints` (Michael, 2026-11-22: "have least points to greatest player draw in that
 * order"): the monster decks are shared and limited, so the players at the Arcane Abyss draw from
 * them one after the other, the player with the fewest points first.
 *
 * - The points are those a player had when the round began (the snapshot of the last Cleanup; 0 in
 *   round 1), so a kill made earlier in the same Location step does not change the order.
 * - Equal points: table order, starting one seat later each round.
 * - A player ahead stops holding the others back once they have drawn and kept a card, hold three
 *   cards, or have ended their Location turn. Taking the permanent monster is not a deck draw: it
 *   needs no turn and counts as that player's draw of the visit.
 */
import { ruleValue } from './rules';
import type { PlayCatalog, PublicGameState, SeatColor } from './types';

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
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined,
	state: Pick<PublicGameState, 'activeSeats' | 'players' | 'round' | 'phase'>,
	seat: SeatColor
): SeatColor | null {
	if (!ruleValue(catalog, 'abyssDrawByPoints') || state.phase !== 'location') return null;
	for (const other of abyssDrawOrder(state)) {
		if (other === seat) return null;
		const p = state.players[other];
		if (!p || p.phaseReady === true) continue;
		const revealed = (p.pendingMonsterDraw?.cards.length ?? 0) > 0;
		const mayStillDraw = p.monsterDrawRound !== state.round && (p.monsterHand?.length ?? 0) < 3;
		if (revealed || mayStillDraw) return other;
	}
	return null;
}
