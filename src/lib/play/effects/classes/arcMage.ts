import { nextId } from '../../rng';
import { DICE_TIER_ORDER, type PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions } from './types';

// Arcane Alchemist — "When you cultivate, you may discard 4 attack dice to gain 1 Arcane
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

export const ALCHEMIST_AUGMENT_KIND = 'alchemistAugment';

/** The placed Spirit Augments of a player (attachments that carry a class). */
function placedAugments(player: PrivatePlayerState) {
	return (player.spiritAugmentAttachments ?? []).filter((a) => a.classId || a.className);
}

// Rule `alchemistAugmentToArcane` (Michael, 2026-11-18): "When you Cultivate, you may convert 1
// of your Spirit Augments into 1 Arcane Attack Dice." replaces the 4-dice trade. A card lists
// every placed augment; the chosen one is removed from its spirit.
export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		run(ctx) {
			// Rule `alchemistOncePerRound`: one conversion a round, however often the player Cultivates in it.
			if (ctx.player.alchemistConvertedRound != null && ctx.player.alchemistConvertedRound === ctx.state.round) return;
			const augments = placedAugments(ctx.player);
			if (augments.length === 0) return;
			ctx.player.pendingDecisions.push({
				id: nextId(ctx.state.rng, 'dec'),
				source: 'class',
				kind: ALCHEMIST_AUGMENT_KIND,
				prompt: 'When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane Attack Dice.',
				options: [
					...augments.map((a) => {
						const spirit = ctx.player.spirits.find((sp) => sp.slotIndex === a.spiritSlotIndex);
						return {
							id: `aug:${a.spiritSlotIndex}:${a.runeId}`,
							label: `Convert the ${a.className ?? a.name ?? 'Spirit'} augment on ${spirit?.name ?? `slot ${a.spiritSlotIndex}`} → 1 Arcane Attack Dice`
						};
					}),
					{ id: 'no', label: 'No' }
				]
			});
			ctx.log.push('Decision: convert a Spirit Augment into an Arcane Attack Dice?');
			return;
		}
	}
];

export const decisions: ClassDecisions = {
	[ALCHEMIST_AUGMENT_KIND](ctx, optionId) {
		const match = /^aug:(\d+):(.+)$/.exec(optionId);
		if (!match) return;
		const list = ctx.player.spiritAugmentAttachments ?? [];
		const index = list.findIndex((a) => a.spiritSlotIndex === Number(match[1]) && a.runeId === match[2] && (a.classId || a.className));
		if (index < 0) {
			ctx.log.push('Arcane Alchemist: that augment is no longer there.');
			return;
		}
		if (ctx.player.alchemistConvertedRound != null && ctx.player.alchemistConvertedRound === ctx.state.round) {
			ctx.log.push('Arcane Alchemist: already converted an augment this round.');
			return;
		}
		ctx.player.alchemistConvertedRound = ctx.state.round;
		const [removed] = list.splice(index, 1);
		ctx.log.push(`Arcane Alchemist: converted the ${removed.className ?? removed.name ?? 'Spirit'} augment into 1 Arcane Attack Dice.`);
		runAction(ctx, { kind: 'gainAttackDice', tier: 'arcane', amount: 1 });
	},
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
