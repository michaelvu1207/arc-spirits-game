import type { ClassAbility } from './types';

// Beast — "In combat, deal 1 damage and gain 1 combat initiative for every
// Beast trait." `'1+'` scales both amounts by the trait count.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [
			{
				count: '1+',
				actions: [
					// Beast gives damage only (Michael, 2026-11-21).
					{ kind: 'combatBonus', amount: 1 }
				]
			}
		]
	}
];
