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
/** Rule `firetailDamage` (Michael, 2026-11-26): more damage in a combat of a round when another player is at this player's location. */
export const FIRETAIL_DAMAGE = 3;
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			// Rule `firetailDamage`: "In a round when another player is at your location, deal 3 more damage in
			// combat." Monster fights and player fights; no initiative of any kind.
			if (ruleValue(ctx.catalog, 'firetailDamage')) {
				if (ctx.colocated.length === 0) return;
				ctx.player.combatDamageBonus += FIRETAIL_DAMAGE;
				ctx.log.push(`Firetail: another player is at your location — deal ${FIRETAIL_DAMAGE} more damage.`);
				return;
			}
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
