import type { ClassAbility } from './types';

// Fighter — the dice engine. On Rest, 2 / 3 / 4 / 5 Fighters give 1 / 2 / 3 / 5 Basic Attack Dice;
// 5 Fighters also give 1 Spirit Augment of any class. Fighter gives no initiative.
export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		breakpoints: [
			{ count: 2, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 1 }] },
			{ count: 3, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 2 }] },
			{ count: 4, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 3 }] },
			{
				count: 5,
				actions: [
					{ kind: 'gainAttackDice', tier: 'basic', amount: 5 },
					{ kind: 'gainAugment', amount: 1 }
				]
			}
		]
	}
];
