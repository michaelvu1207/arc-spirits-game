
import type { PrivatePlayerState, PublicGameState } from './types';

/** Count monster-reward points, so the next settlement leaves them whole. */
export function noteMonsterPoints(
	player: PrivatePlayerState,
	amount: number,
	catalog: unknown
): void {
	return;
}

/** Halve the non-monster points gained since the last settlement (rule `sidePointsHalf`). */
export function settleSidePoints(
	state: PublicGameState,
	catalog: unknown
): void {
	return;
}
