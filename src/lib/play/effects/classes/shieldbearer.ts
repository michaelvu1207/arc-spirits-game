
import type { ClassAbility } from './types';

/** Shieldbearer's reduction for a hit taken at full Barrier. */
export const SHIELDBEARER_REDUCTION = 3;
/** Rule `sunRework`: reduction for any hit, and for a hit at full Barrier. */
export const SHIELDBEARER_SUN_REDUCTION = 2;
export const SHIELDBEARER_SUN_FULL_REDUCTION = 4;
/** Rule `shieldbearerFullOnly`: reduction for a hit at full Barrier (none otherwise). */
export const SHIELDBEARER_FULL_ONLY_REDUCTION = 5;

// Shieldbearer — "When you take damage, if your Barrier is full, take 3 less." Checked for each
// hit (`onTakeDamage`, before the hit lands; the reduction is for that hit only, see takeDamage).
// Rule `sunRework` (default false): "take 2 less. If your Barrier is full, take 4 less instead."
export const ability: ClassAbility[] = [
	{
		on: 'onTakeDamage',
		run(ctx) {
			const { player } = ctx;
			const full = player.maxBarrier > 0 && player.barrier >= player.maxBarrier;
			// Rule `shieldbearerFullOnly`: 5 less at full Barrier, nothing otherwise.
			if (!full) return;
			player.damageReduction += SHIELDBEARER_FULL_ONLY_REDUCTION;
			ctx.log.push(`Shieldbearer: full Barrier — take ${SHIELDBEARER_FULL_ONLY_REDUCTION} less damage.`);
			return;
		}
	}
];
