import { runAction } from '../actions';
import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

// Firetail — "In a round when another player is at your location, gain 3 Initiative."
// Initiative only matters in combat, so the bonus is applied when combat begins, if another
// active player shares this player's location this round.
// Rule `firetailVsMonsters` (default false): "In combat with a monster, or in a round when another
// player is at your location, gain 3 Initiative." Monster combat fires `inCombat` with no opponent.
export const FIRETAIL_INITIATIVE = 3;
/** Under rule `spiritInitiativeTrim` (Michael, 2026-11-21). */
export const FIRETAIL_INITIATIVE_TRIMMED = 2;
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const amount = ruleValue(ctx.catalog, 'spiritInitiativeTrim') ? FIRETAIL_INITIATIVE_TRIMMED : FIRETAIL_INITIATIVE;
			if (ctx.opponent === undefined && ruleValue(ctx.catalog, 'firetailVsMonsters')) {
				runAction(ctx, { kind: 'gainInitiative', amount });
				return;
			}
			runAction(ctx, {
				kind: 'conditional',
				when: { kind: 'hasColocated' },
				then: [{ kind: 'gainInitiative', amount }]
			});
		}
	}
];
