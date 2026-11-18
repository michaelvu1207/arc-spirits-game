/**
 * Rule `sidePointsHalf` (balance test of 2026-11-18): Victory Points from anything other than
 * a monster's reward count half. Two such points make 1 Victory Point; a single leftover half
 * is kept (`halfPointBank`) until the next one arrives.
 *
 * The point sources are many (class effects, Powers, the Summoner, PvP, relics), so the rule is
 * applied in one place: `settleSidePoints` compares each player's Victory Points with the value
 * at the last settlement, takes out the monster-reward points gained since then
 * (`monsterPointsSinceSettle`, counted where a monster reward pays), and halves the rest. It
 * runs after every command, after a deadline advance, and before the end-of-round win check.
 */
import { ruleValue } from './rules';
import type { PlayCatalog, PrivatePlayerState, PublicGameState } from './types';

/** Count monster-reward points, so the next settlement leaves them whole. */
export function noteMonsterPoints(
	player: PrivatePlayerState,
	amount: number,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined
): void {
	if (!ruleValue(catalog, 'sidePointsHalf') || amount <= 0) return;
	player.monsterPointsSinceSettle = (player.monsterPointsSinceSettle ?? 0) + amount;
}

/** Halve the non-monster points gained since the last settlement (rule `sidePointsHalf`). */
export function settleSidePoints(
	state: PublicGameState,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined
): void {
	if (!ruleValue(catalog, 'sidePointsHalf')) return;
	for (const seat of state.activeSeats ?? []) {
		const player = state.players[seat];
		if (!player) continue;
		const base = player.pointsAtSettle ?? 0;
		const monster = player.monsterPointsSinceSettle ?? 0;
		const side = player.victoryPoints - base - monster;
		if (side > 0) {
			const bank = (player.halfPointBank ?? 0) + side;
			player.halfPointBank = bank % 2;
			player.victoryPoints = base + monster + Math.floor(bank / 2);
		}
		player.pointsAtSettle = player.victoryPoints;
		player.monsterPointsSinceSettle = 0;
	}
}
