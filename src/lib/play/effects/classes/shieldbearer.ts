import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

/** Shieldbearer's reduction for a hit taken at full Barrier. */
export const SHIELDBEARER_REDUCTION = 3;
/** Rule `sunRework`: reduction for any hit, and for a hit at full Barrier. */
export const SHIELDBEARER_SUN_REDUCTION = 2;
export const SHIELDBEARER_SUN_FULL_REDUCTION = 4;

// Shieldbearer — "When you take damage, if your Barrier is full, take 3 less." Checked for each
// hit (`onTakeDamage`, before the hit lands; the reduction is for that hit only, see takeDamage).
// Rule `sunRework` (default false): "take 2 less. If your Barrier is full, take 4 less instead."
export const ability: ClassAbility[] = [
	{
		on: 'onTakeDamage',
		run(ctx) {
			const { player } = ctx;
			const full = player.maxBarrier > 0 && player.barrier >= player.maxBarrier;
			if (ruleValue(ctx.catalog, 'sunRework')) {
				const amount = full ? SHIELDBEARER_SUN_FULL_REDUCTION : SHIELDBEARER_SUN_REDUCTION;
				player.damageReduction += amount;
				ctx.log.push(`Shieldbearer: ${full ? 'full Barrier — ' : ''}take ${amount} less damage.`);
				return;
			}
			if (!full) return;
			player.damageReduction += SHIELDBEARER_REDUCTION;
			ctx.log.push(`Shieldbearer: full Barrier — take ${SHIELDBEARER_REDUCTION} less damage.`);
		}
	}
];
