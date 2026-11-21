import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

/** Paladin's Initiative: 4, or 2 under rule `spiritInitiativeTrim` (Michael, 2026-11-21). */
export const PALADIN_INITIATIVE = 4;
export const PALADIN_INITIATIVE_TRIMMED = 2;

// Paladin — "+4 Initiative. If initiative is tied, your side strikes first."
// The tie-break is a per-combat flag that resolveEncounterCombat reads (combat.ts). The old
// Aegis Weaver text ("restore Barrier equal to Max Barrier gained") is not in the November 2026
// catalog, so it is gone.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const amount = ruleValue(ctx.catalog, 'spiritInitiativeTrim') ? PALADIN_INITIATIVE_TRIMMED : PALADIN_INITIATIVE;
			ctx.player.initiative += amount;
			ctx.player.winsInitiativeTies = true;
			ctx.log.push(`Gained ${amount} initiative; wins initiative ties.`);
		}
	}
];
