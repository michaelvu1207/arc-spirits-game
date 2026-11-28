import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

/** Under rule `fighterInitiative`: the most initiative Fighter gives (its highest breakpoint). */
export const FIGHTER_INITIATIVE_MAX = 5;

// Fighter — the dice engine. SUPER-LINEAR breakpoints (counts 2/3/4/5 → +1/+2/+5/+10
// dice) so stacking Fighters pays off far more than repeat-resting a small pool: a
// 5-Fighter pool fills the entire 10-dice cap in ONE rest. Rewards action economy.
export const ability: ClassAbility[] = [
	{
		on: 'onRest',
		breakpoints: [
			{ count: 2, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 1 }] },
			{ count: 3, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 2 }] },
			{ count: 4, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 5 }] },
			{
				count: 5,
				actions: [
					{ kind: 'gainAttackDice', tier: 'basic', amount: 10 },
					{ kind: 'gainAugment', amount: 1 }
				]
			}
		]
	},
	// Rule `fighterInitiative` (Michael, 2026-11-20): "In combat, gain N combat initiative" at
	// 1, 2, 3, 4 and 5 Fighter traits (N = the trait count, at most 5). Against monsters and players.
	{
		on: 'inCombat',
		run(ctx) {
			return;
		}
	}
];
