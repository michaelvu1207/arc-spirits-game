import type { ClassAbility } from './types';

// Salamander — "In combat, roll again each attack dice that shows 0, once."
// Arms a per-combat flag that `rollAttack` (combat.ts) reads per die.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			ctx.player.rerollZeroDice = true;
			ctx.log.push('Attack dice that show 0 are rolled again, once.');
		}
	}
];
