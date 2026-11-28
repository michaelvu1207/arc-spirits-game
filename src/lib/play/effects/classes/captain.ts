import { navigationPowerPool } from '../../navigationPowers';
import { nextInt } from '../../rng';
import type { ClassAbility, ClassHandler } from './types';

/**
 * Captain — "After you defeat a monster, gain 1 random Power." (Michael, 2026-11-18.) That is the
 * whole ability: no Cultivate clause, no "When discarded" clause. The Power comes from the same
 * pool as the Forest Region's random Power.
 */
const captainOnKill: ClassHandler = (ctx) => {
	if (!ctx.combat?.killed) return;
	const powers = navigationPowerPool(ctx.catalog);
	if (powers.length === 0) return;
	const power = powers[nextInt(ctx.state.rng, powers.length)];
	(ctx.player.powerInventory ??= []).push(power.id);
	ctx.log.push(`Captain: defeated a monster — gained 1 random Power: ${power.name}.`);
};

export const ability: ClassAbility[] = [{ on: 'onMonsterKill', run: captainOnKill }];
