import type { ClassAbility } from './types';

// Titan — "When you take damage, take 6 less. Gain 6 damage." Titan gives no initiative.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [
			{
				count: 1,
				actions: [
					{ kind: 'reduceIncomingDamage', amount: 6 },
					{ kind: 'combatBonus', amount: 6 }
				]
			}
		]
	}
];
