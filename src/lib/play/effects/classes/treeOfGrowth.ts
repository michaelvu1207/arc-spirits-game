import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions, ClassHandler } from './types';

// Growth Warden — after gaining or upgrading attack dice this round, choose
// either 2 max barrier or any Spirit Augment during the Awakening phase.
const offerGrowthReward: ClassHandler = (ctx) => {
	if (!ctx.player.attackDiceChangedThisTurn) return;
	runAction(ctx, {
		kind: 'choose',
		decisionKind: 'treeOfGrowthReward',
		prompt: 'You gained or upgraded attack dice this turn. Choose a Growth Warden reward.',
		options: [
			{ id: 'barrier', label: 'Gain 2 max barrier' },
			{ id: 'augment', label: 'Gain 1 Spirit Augment' }
		]
	});
};

export const ability: ClassAbility[] = [{ on: 'awakeningPhase', run: offerGrowthReward }];

export const decisions: ClassDecisions = {
	treeOfGrowthReward(ctx, optionId) {
		if (optionId === 'barrier') runAction(ctx, { kind: 'gainMaxBarrier', amount: 2 });
		if (optionId === 'augment') runAction(ctx, { kind: 'gainAugment', amount: 1 });
	}
};
