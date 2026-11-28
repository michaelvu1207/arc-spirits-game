import { nextId } from '../../rng';
import type { PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions } from './types';

export const ALCHEMIST_AUGMENT_KIND = 'alchemistAugment';

/** The placed Spirit Augments of a player (attachments that carry a class). */
function placedAugments(player: PrivatePlayerState) {
	return (player.spiritAugmentAttachments ?? []).filter((a) => a.classId || a.className);
}

// Arcane Alchemist — "When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane
// Attack Dice (once a round)." (Michael, 2026-11-18; once a round: Michael, 2026-11-22.) A card
// lists every placed augment; the chosen one is removed from its spirit. A player converts at most
// one augment a round, however often they Cultivate in it.
export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		run(ctx) {
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
	}
};
