import { runAction } from '../actions';
import { FAIRY_DICE_TIER } from '../../rules';
import type { ClassAbility, ClassHandler } from './types';

/**
 * "When Awakened, gain 1 Enchanted Attack for every spirit matching this Fairy's origin."
 * Per-awakening + origin-aware: only grants when the spirit that just awakened
 * (ctx.command.slotIndex) is itself a Fairy; counts every spirit whose origin overlaps that
 * Fairy's. A Fairy with no origin grants no dice.
 */
const fairyAwakening: ClassHandler = (ctx) => {
	const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
	if (slot == null) return;
	const fairy = ctx.player.spirits.find((s) => s.slotIndex === slot);
	if (!fairy || (fairy.classes?.['Fairy'] ?? 0) <= 0) return;
	const fairyOrigins = Object.keys(fairy.origins ?? {});
	if (fairyOrigins.length > 0) {
		const matching = ctx.player.spirits.filter((s) =>
			Object.keys(s.origins ?? {}).some((o) => fairyOrigins.includes(o))
		).length;
		if (matching > 0) runAction(ctx, { kind: 'gainAttackDice', tier: FAIRY_DICE_TIER, amount: matching });
	}
};

export const ability: ClassAbility[] = [{ on: 'awakening', run: fairyAwakening }];
