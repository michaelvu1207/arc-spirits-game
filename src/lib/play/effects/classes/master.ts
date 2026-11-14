import type { ClassAbility } from './types';

// Master — "On Cultivate, gain 2 potential." (potential = max barrier)
export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainMaxBarrier', amount: 2 }] }]
	}
];
