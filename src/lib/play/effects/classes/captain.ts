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
	if (ruleValue(ctx.catalog, 'captainPowerOnKill')) return;
	const heroes = ctx.player.spirits.filter((s) => isHeroSpirit(s, ctx.catalog)).length;
	if (heroes >= 3) runAction(ctx, { kind: 'gainAugment', amount: 1 });
};

/**
 * Rule `captainPowerOnKill` (Michael, 2026-11-18): "After you defeat a monster, gain 1 random
 * Power." replaces the Cultivate clause (the "When discarded" clause stays). The Power comes
 * from the same pool as the Forest Region's random Power.
 */
const captainOnKill: ClassHandler = (ctx) => {
	if (!ruleValue(ctx.catalog, 'captainPowerOnKill') || !ctx.combat?.killed) return;
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
		on: 'onSpiritDiscard',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainAttackDice', tier: 'enchanted', amount: 1 }] }]
	}
];
