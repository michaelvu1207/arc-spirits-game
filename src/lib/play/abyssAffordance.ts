/**
 * What a player at the Arcane Abyss may do right now, under the rules of the game: battle actions
 * left, how a monster draw works, and whom the player waits for before drawing.
 *
 * One pure function for the server (the per-seat affordances of viewV2.ts) and for a game screen
 * that has no affordances yet (it then calls this with the room projection). It only reads; the
 * reducer in runtime.ts stays the authority on every command.
 */
import { abyssDrawBlockedBy, abyssDrawOrder } from './abyssDrawOrder';
import { ABYSS_SUMMON_USED, monsterFightsLeft } from './locationInteractions';
import type { PublicGameState, SeatColor } from './types';

export interface AbyssAffordance {
	/**
	 * Battle actions the seat has left this round. A fight uses one; the Arcane Abyss Summon action
	 * uses one too.
	 */
	battleActionsLeft: number;
	/** Battle actions the seat has each round: 1, or more with Monster Hunter. */
	battleActions: number;
	/** The Arcane Abyss Summon action uses a battle action (always true). */
	summonUsesBattleAction: boolean;
	/** The seat took the Arcane Abyss Summon action this round. */
	summonTaken: boolean;
	/** Cards one draw reveals: always 1. */
	drawReveals: 1 | 2;
	/**
	 * The revealed card may go back on top of its deck, a kept card may take the place of a held
	 * one, and a full hand may still draw (always true).
	 */
	canReturnDraw: boolean;
	/** The players at the Arcane Abyss in drawing order (fewest points first). */
	drawOrder?: SeatColor[];
	/** The seat that draws from the decks before this one, while it has to wait. */
	drawWaitsOn?: SeatColor;
}

type AbyssState = Pick<PublicGameState, 'activeSeats' | 'players' | 'round' | 'phase'>;

/** The Arcane Abyss affordance of `seat`, or undefined when the seat is not at the Arcane Abyss in the Location phase. */
export function abyssAffordance(
	state: AbyssState,
	seat: SeatColor,
	catalog?: unknown
): AbyssAffordance | undefined {
	const player = state.players[seat];
	if (!player || state.phase !== 'location' || player.navigationDestination !== 'Arcane Abyss') return undefined;
	const waitsOn = abyssDrawBlockedBy(catalog, state, seat);
	return {
		battleActionsLeft: Math.max(0, monsterFightsLeft(player, true)),
		battleActions: 1 + (player.extraActions?.combat ?? 0),
		summonUsesBattleAction: true,
		summonTaken: (player.actionsUsedThisRound ?? []).includes(ABYSS_SUMMON_USED),
		drawReveals: 1,
		canReturnDraw: true,
		drawOrder: abyssDrawOrder(state),
		...(waitsOn ? { drawWaitsOn: waitsOn } : {})
	};
}
