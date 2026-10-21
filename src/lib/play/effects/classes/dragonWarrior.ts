import type { ClassAbility } from './types';

// Arcane Vanguard — "Gain 2 initiative. On this spirit's Awakening, gain 3 Arcane Attack Dice."
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainInitiative', amount: 2 }] }]
	},
	{
		on: 'awakening',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainAttackDice', tier: 'arcane', amount: 3 }] }]
	}
];
