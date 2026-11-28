import { runAction } from '../actions';
import { navigationPowerPool } from '../../navigationPowers';
import { nextInt } from '../../rng';
import { ruleValue } from '../../rules';
import { isHeroSpirit } from '../heroes';
import type { ClassAbility, ClassHandler } from './types';

/**
 * "If you Cultivate with 3 Heroes, gain 1 Spirit Augment." Heroes are found by
 * {@link isHeroSpirit} (Human Enclave origin, or a `human` class type — the November 2026
 * heroes have no origin); awakened or not; grants once when ≥3.
 */
const captainOnCultivate: ClassHandler = (ctx) => {
	return;
};

/**
 * Rule `captainPowerOnKill` (Michael, 2026-11-18): "After you defeat a monster, gain 1 random
 * Power." replaces the Cultivate clause. With `captainNoDiscardDie` as well, it is the whole ability. The Power comes
 * from the same pool as the Forest Region's random Power.
 */
const captainOnKill: ClassHandler = (ctx) => {
	if (!ctx.combat?.killed) return;
	const powers = navigationPowerPool(ctx.catalog);
	if (powers.length === 0) return;
	const power = powers[nextInt(ctx.state.rng, powers.length)];
	(ctx.player.powerInventory ??= []).push(power.id);
	ctx.log.push(`Captain: defeated a monster — gained 1 random Power: ${power.name}.`);
};

export const ability: ClassAbility[] = [
	{ on: 'onCultivate', run: captainOnCultivate },
	{ on: 'onMonsterKill', run: captainOnKill },
	{
		// "When discarded, gain 1 Enchanted Attack." Rule `captainNoDiscardDie` removes it. (A separate
		// switch: the games recorded under `captainPowerOnKill` alone still gave the die.)
		on: 'onSpiritDiscard',
		run(ctx) {
			return;
		}
	}
];
