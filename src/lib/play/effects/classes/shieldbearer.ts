import type { ClassAbility } from './types';

/** Shieldbearer's reduction for a hit taken at full Barrier (none otherwise). */
export const SHIELDBEARER_FULL_ONLY_REDUCTION = 5;

// Shieldbearer — "When you take damage, if your Barrier is full, take 5 less." Nothing when the
// Barrier is not full. Checked for each hit (`onTakeDamage`, before the hit lands; the reduction
// is for that hit only, see takeDamage).
export const ability: ClassAbility[] = [
	{
		on: 'onTakeDamage',
		run(ctx) {
			const { player } = ctx;
			const full = player.maxBarrier > 0 && player.barrier >= player.maxBarrier;
			if (!full) return;
			player.damageReduction += SHIELDBEARER_FULL_ONLY_REDUCTION;
			ctx.log.push(`Shieldbearer: full Barrier — take ${SHIELDBEARER_FULL_ONLY_REDUCTION} less damage.`);
		}
	}
];
