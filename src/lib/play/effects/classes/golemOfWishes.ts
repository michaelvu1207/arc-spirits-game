import type { ClassAbility } from './types';

// Living Bastion — take 6 less damage, gain 6 attack damage and 6 initiative.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [
			{
				count: 1,
				actions: [
					{ kind: 'reduceIncomingDamage', amount: 6 },
					{ kind: 'combatBonus', amount: 6 },
					{ kind: 'gainInitiative', amount: 6 }
				]
			}
		]
	}
];
