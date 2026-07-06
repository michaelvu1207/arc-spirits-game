import { DICE_TIER_ORDER } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions } from './types';

// Arc Mage — "When you cultivate, you may discard 4 attack dice to gain 1 Arcane
// Attack Dice." (CHANGED: was 3 → now 4.) Gated on ≥4 dice, then an opt-in
// `arcMageTrade` card. The owner PICKS which 4 dice to spend (client sends their
// instance ids) so they never lose an Arcane die by accident; bots (and any
// resolve that omits a pick) auto-spend the 4 lowest-value dice. Done ONCE per
// cultivate — no re-offer loop.
// Exported so the view/affordances layer (decisionPicker.ts) and the reducer's
// picker-selection validation read the SAME pick count as this resolver — the count
// can never drift between "what the UI offers" and "what the resolver spends".
export const ARC_MAGE_TRADE_COST = 4;
const TRADE_COST = ARC_MAGE_TRADE_COST;

const tradePrompt = `When you cultivate, you may discard ${TRADE_COST} attack dice to gain 1 Arcane Attack Dice.`;
const tradeOptions = [
	{ id: 'yes', label: `Convert ${TRADE_COST} dice → 1 Arcane` },
	{ id: 'no', label: 'No' }
];

export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		breakpoints: [
			{
				count: 1,
				actions: [
					{
						kind: 'conditional',
						when: { kind: 'hasAttackDice', amount: TRADE_COST },
						then: [
							{
								kind: 'choose',
								decisionKind: 'arcMageTrade',
								prompt: tradePrompt,
								options: tradeOptions
							}
						]
					}
				]
			}
		]
	}
];

// Colocated resolver for the opt-in card. On Yes, discard the chosen 4 dice → gain
// 1 Arcane. The owner's client sends `selectedInstanceIds` (the 4 dice they clicked);
// when absent or invalid (bots, or a malformed pick) we auto-spend the 4 LOWEST-value
// dice so an Arcane is never wasted. Fires ONCE per cultivate — no re-offer loop.
export const decisions: ClassDecisions = {
	arcMageTrade(ctx, optionId, selectedInstanceIds) {
		if (optionId !== 'yes') return;
		const dice = ctx.player.attackDice;
		if (dice.length < TRADE_COST) return;

		const owned = new Set(dice.map((d) => d.instanceId));
		const picked = [...new Set(selectedInstanceIds ?? [])].filter((id) => owned.has(id));

		const ids =
			picked.length === TRADE_COST
				? picked
				: [...dice]
						.sort(
							(a, b) => DICE_TIER_ORDER.indexOf(a.tier) - DICE_TIER_ORDER.indexOf(b.tier)
						)
						.slice(0, TRADE_COST)
						.map((d) => d.instanceId);

		runAction(ctx, { kind: 'discardAttackDiceByIds', instanceIds: ids });
		runAction(ctx, { kind: 'gainAttackDice', tier: 'arcane', amount: 1 });
	}
};
