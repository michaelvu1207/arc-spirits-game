import type { ClassAbility } from './types';

// Battle Adept — "If you overkill by 2 damage, gain 1 max barrier. If you don't
// kill, gain 1 Enchanted Attack." Per-trait ('1+') so each fighter activates.
// Rule `battleAdeptNoDice` (Michael, 2026-11-21): no attack dice for a fight that does not kill.
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
					},
					{
						kind: 'conditional',
						when: { kind: 'notKilled' },
						then: [
							{
								kind: 'conditional',
								when: { kind: 'ruleOff', rule: 'battleAdeptNoDice' },
								then: [{ kind: 'gainAttackDice', tier: 'enchanted', amount: 1 }]
							}
						]
					}
				]
			}
		]
	}
];
