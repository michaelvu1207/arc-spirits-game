import { nextId } from '../../rng';
import type { PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import { ruleValue } from '../../rules';
import type { ClassAbility, ClassDecisions } from './types';

// Master — "On Cultivate, gain 2 Max Barrier." (new Max Barrier arrives intact)
//
// Rule switch `masterBarrierChoice` (rules.ts; default false): on ⇒ "On Cultivate, gain 2 Max
// Barrier or restore 2 Barrier." The two differ only while some Barrier is broken and Max Barrier
// is below its cap, so a card is made only then:
//  - Barrier full ⇒ Max Barrier (a restore would give nothing);
//  - Max Barrier at the cap ⇒ restore;
//  - otherwise the player chooses. An unanswered card (bots never answer) gives Max Barrier,
//    the old effect, when the Benefits step starts (or at Cleanup for a later Cultivate).

export const MASTER_CULTIVATE_KIND = 'masterCultivate';
export const MASTER_AMOUNT = 2;
const MAX_BARRIER_CAP = 10;

type MasterOption = 'maxBarrier' | 'restore';

/** What each option would give right now. */
export function masterGains(player: Pick<PrivatePlayerState, 'maxBarrier' | 'barrier'>): {
	max: number;
	restore: number;
} {
	return {
		max: Math.max(0, Math.min(MASTER_AMOUNT, MAX_BARRIER_CAP - player.maxBarrier)),
		restore: Math.max(0, Math.min(MASTER_AMOUNT, player.maxBarrier - player.barrier))
	};
}

/** The pick when there is no real choice, and for an unanswered card. */
export function masterDefaultOption(
	player: Pick<PrivatePlayerState, 'maxBarrier' | 'barrier'>
): MasterOption {
	const gains = masterGains(player);
	return gains.max > 0 || gains.restore === 0 ? 'maxBarrier' : 'restore';
}

export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		run(ctx) {
			const { player, state } = ctx;
			const gains = masterGains(player);
			if (gains.max === 0 || gains.restore === 0) {
				// No real choice: one of the two would give nothing.
				if (masterDefaultOption(player) === 'restore') {
					runAction(ctx, { kind: 'restoreBarrier', amount: MASTER_AMOUNT });
				} else {
					runAction(ctx, { kind: 'gainMaxBarrier', amount: MASTER_AMOUNT });
				}
				return;
			}
			player.pendingDecisions = player.pendingDecisions ?? [];
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: MASTER_CULTIVATE_KIND,
				prompt: 'Master: you Cultivated. Choose one.',
				options: [
					{ id: 'maxBarrier', label: `Gain ${MASTER_AMOUNT} Max Barrier` },
					{ id: 'restore', label: `Restore ${MASTER_AMOUNT} Barrier` }
				],
				expiresAt: 'benefits',
				expiryOptionId: 'auto'
			});
		}
	}
];

export const decisions: ClassDecisions = {
	[MASTER_CULTIVATE_KIND](ctx, optionId) {
		const choice: MasterOption =
			optionId === 'restore' ? 'restore' : optionId === 'maxBarrier' ? 'maxBarrier' : masterDefaultOption(ctx.player);
		if (choice === 'restore') runAction(ctx, { kind: 'restoreBarrier', amount: MASTER_AMOUNT });
		else runAction(ctx, { kind: 'gainMaxBarrier', amount: MASTER_AMOUNT });
	}
};
