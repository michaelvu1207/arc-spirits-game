import { DICE_TIER_ORDER } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions } from './types';

// Strategist — "On rest, you may discard 3 attack dice to gain 1 Spirit Augment."
// Gated on holding ≥3 dice, then an opt-in Yes/No card resolved by `strategistTrade`.
export const STRATEGIST_TRADE_COST = 3;
export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		breakpoints: [
			{
				count: 1,
				actions: [
					{
						kind: 'conditional',
						when: { kind: 'hasAttackDice', amount: STRATEGIST_TRADE_COST },
						then: [
							{
								kind: 'choose',
								decisionKind: 'strategistTrade',
								prompt: 'On rest, you may discard 3 attack dice to gain 1 Spirit Augment.',
								options: [
									{ id: 'yes', label: 'Discard 3 dice → 1 Augment' },
									{ id: 'no', label: 'No' }
								]
							}
						]
					}
				]
			}
		]
	}
];

// Colocated resolver for the opt-in Yes/No card.
export const decisions: ClassDecisions = {
	strategistTrade(ctx, optionId, selectedInstanceIds) {
		if (optionId === 'yes') {
			const dice = ctx.player.attackDice;
			if (dice.length < STRATEGIST_TRADE_COST) return;
			const owned = new Set(dice.map((die) => die.instanceId));
			const selected = [...new Set(selectedInstanceIds ?? [])].filter((id) => owned.has(id));
			const ids =
				selected.length === STRATEGIST_TRADE_COST
					? selected
					: [...dice]
							.sort(
								(a, b) =>
									DICE_TIER_ORDER.indexOf(a.tier) - DICE_TIER_ORDER.indexOf(b.tier)
							)
							.slice(0, STRATEGIST_TRADE_COST)
							.map((die) => die.instanceId);
			runAction(ctx, { kind: 'discardAttackDiceByIds', instanceIds: ids });
			runAction(ctx, { kind: 'gainAugment', amount: 1 });
		}
	}
};
