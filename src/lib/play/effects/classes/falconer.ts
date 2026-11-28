import { nextId } from '../../rng';
import type { PrivatePlayerState, PublicGameState } from '../../types';
import type { ClassAbility, ClassDecisions } from './types';

// Falconer — "On your next monster kill you may gain double the rewards, except Victory Points.
// Then discard this spirit." (Michael, 2026-11-14; no doubled Victory Points: balance test of
// 2026-11-18.) After a kill that opens a reward claim, a player with an awakened Falconer SPIRIT
// (a Falconer augment has no spirit to discard) gets a yes/no card. Yes: every reward of that kill
// except Victory Points is given twice and the Falconer spirit is discarded (the reducer's
// `resolveDecision` does both, because discarding a spirit lives there). No, or no answer before
// the claim or the Benefits step: nothing, and the next kill asks again.
export const FALCONER_DOUBLE_KIND = 'falconerDouble';

/** The awakened spirit whose own card has the Falconer class, if any. */
export function awakeFalconerSpirit(player: PrivatePlayerState) {
	return (player.spirits ?? []).find((s) => !s.isFaceDown && (s.classes?.['Falconer'] ?? 0) > 0);
}

/** Offer the doubling for the reward claim that is open now. */
export function offerFalconerDouble(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog: unknown
): void {
	const reward = player.pendingReward;
	const falconer = awakeFalconerSpirit(player);
	if (!reward || reward.doubled || !falconer) return;
	player.pendingDecisions = (player.pendingDecisions ?? []).filter((d) => d.kind !== FALCONER_DOUBLE_KIND);
	player.pendingDecisions.push({
		id: nextId(state.rng, 'dec'),
		source: 'class',
		kind: FALCONER_DOUBLE_KIND,
		prompt: `Falconer: gain double the rewards of ${reward.monsterName} (not its Victory Points)? ${falconer.name} is then discarded.`,
		options: [
			{ id: 'yes', label: `Double the rewards except Victory Points and discard ${falconer.name}` },
			{ id: 'no', label: 'No, keep the spirit' }
		],
		expiresAt: 'benefits'
	});
}

export const ability: ClassAbility[] = [];

export const decisions: ClassDecisions = {
	// The doubling itself is applied by the reducer (it discards a spirit); see FALCONER_DOUBLE_KIND.
	falconerDouble() {}
};
