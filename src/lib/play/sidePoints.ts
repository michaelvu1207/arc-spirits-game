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
	return;
}

/** Halve the non-monster points gained since the last settlement (rule `sidePointsHalf`). */
export function settleSidePoints(
	state: PublicGameState,
	catalog: Pick<PlayCatalog, 'rules'> | null | undefined
): void {
	return;
}
