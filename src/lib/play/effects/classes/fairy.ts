import { runAction } from '../actions';
import type { ClassAbility, ClassHandler } from './types';

/**
 * "When Awakened, gain 1 Exalted Attack for every spirit matching this Fairy's
 * origin. Gain 3 Initiative." Per-awakening + origin-aware: only grants when the
 * spirit that just awakened (ctx.command.slotIndex) is itself a Fairy; counts every
 * spirit whose origin overlaps that Fairy's. Exalted dice capped at max barrier.
 */
const fairyAwakening: ClassHandler = (ctx) => {
	const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
	if (slot == null) return;
	const fairy = ctx.player.spirits.find((s) => s.slotIndex === slot);
	if (!fairy || (fairy.classes?.['Fairy'] ?? 0) <= 0) return;
	// Origin-matched Exalted dice — skipped only when the Fairy has no origin (a
	// degenerate spirit grants no dice, but still gets the unconditional initiative).
	const fairyOrigins = Object.keys(fairy.origins ?? {});
	if (fairyOrigins.length > 0) {
		const matching = ctx.player.spirits.filter((s) =>
			Object.keys(s.origins ?? {}).some((o) => fairyOrigins.includes(o))
		).length;
		if (matching > 0) runAction(ctx, { kind: 'gainAttackDice', tier: 'exalted', amount: matching });
	}
	// "+3 Initiative" is unconditional — always granted whenever a Fairy awakens.
	runAction(ctx, { kind: 'gainInitiative', amount: 3 });
};

export const ability: ClassAbility[] = [{ on: 'awakening', run: fairyAwakening }];
