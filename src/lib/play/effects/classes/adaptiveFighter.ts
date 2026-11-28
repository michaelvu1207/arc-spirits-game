import type { ClassAbility } from './types';

// Battle Adept — "If you overkill by 2 damage, gain 1 Max Barrier." Per-trait ('1+') so each
// fighter activates. A fight that does not kill gives no attack dice (Michael, 2026-11-21).
export const ability: ClassAbility[] = [
	{
		on: 'onMonsterKill',
		breakpoints: [
			{
				count: '1+',
				actions: [
					{
						kind: 'conditional',
						when: { kind: 'overkillAtLeast', amount: 2 },
						then: [{ kind: 'gainMaxBarrier', amount: 1 }]
					}
				]
			}
		]
	}
];
