import type { ClassAbility } from './types';

// Firetail — "In a round when another player is at your location, deal 3 more damage in combat."
// (Michael, 2026-11-26.) Monster fights and player fights; Firetail gives no initiative.

/** Firetail's extra damage in a combat of a round when another player is at this player's location. */
export const FIRETAIL_DAMAGE = 3;
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			if (ctx.colocated.length === 0) return;
			ctx.player.combatDamageBonus += FIRETAIL_DAMAGE;
			ctx.log.push(`Firetail: another player is at your location — deal ${FIRETAIL_DAMAGE} more damage.`);
		}
	}
];
