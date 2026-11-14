import type { ClassAbility } from './types';

// Paladin — "+4 Initiative. If initiative is tied, your side strikes first."
// The tie-break is a per-combat flag that resolveEncounterCombat reads (combat.ts). The old
// Aegis Weaver text ("restore Barrier equal to Max Barrier gained") is not in the November 2026
// catalog, so it is gone.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			ctx.player.initiative += 4;
			ctx.player.winsInitiativeTies = true;
			ctx.log.push('Gained 4 initiative; wins initiative ties.');
		}
	}
];
