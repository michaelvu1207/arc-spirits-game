import type { ClassAbility } from './types';

// Abyss Harbinger — "Gain 2 Initiative" passive combat effect. The "when corrupted,
// gain 1 Arcane Attack die in the Awakening Phase" grant is a Cleanup CLAIM card
// (phases.ts, corruptedThisRound) handled OUTSIDE the effect system.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainInitiative', amount: 2 }] }]
	}
];
