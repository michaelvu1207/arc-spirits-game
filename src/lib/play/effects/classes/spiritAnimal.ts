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
					{ kind: 'combatBonus', amount: 1 },
					// Rule `beastNoInitiative` (Michael, 2026-11-21): Beast gives damage only; combat
					// initiative comes from Fighter (`fighterInitiative`).
					{
						kind: 'conditional',
						when: { kind: 'ruleOff', rule: 'beastNoInitiative' },
						then: [{ kind: 'gainInitiative', amount: 1 }]
					}
				]
			}
		]
	}
];
