import type { ClassAbility } from './types';

// Paladin — "If both sides have the same initiative (1 or more), your side attacks first."
// The tie-break is a per-combat flag that resolveEncounterCombat reads (combat.ts). Paladin gives
// no initiative of its own. The old Aegis Weaver text ("restore Barrier equal to Max Barrier
// gained") is not in the November 2026 catalog, so it is gone.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			ctx.player.winsInitiativeTies = true;
			ctx.log.push('Paladin: attacks first when both sides have the same initiative of 1 or more.');
		}
	}
];
