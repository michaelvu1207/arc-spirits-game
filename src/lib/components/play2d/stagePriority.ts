/**
 * Which in-stage screen comes first for the local player. Shared by MainStage (the stage)
 * and GameBoard2D (the info panel), so both agree.
 *
 * Play test 2 (2026-11-12): in the Awakening step the "Place augments" screen covered a
 * pending relic-tool card. A pending decision card now comes first in that step; the
 * augments wait and show again when the cards are answered.
 */
export interface StagePriorityInput {
	phase: string;
	activeAction: string | null | undefined;
	unplacedAugments: number;
	pendingDecisions: number;
}

/** True when the augment placement screen is the screen to show now. */
export function showsAugmentPlacement(input: StagePriorityInput): boolean {
	if (input.activeAction === 'combat' || input.unplacedAugments <= 0) return false;
	return !(input.phase === 'awakening' && input.pendingDecisions > 0);
}
