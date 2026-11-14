import { runAction } from '../actions';
import { isHeroSpirit } from '../heroes';
import type { ClassAbility, ClassHandler } from './types';

/**
 * "If you Cultivate with 3 Heroes, gain 1 Spirit Augment." Heroes are found by
 * {@link isHeroSpirit} (Human Enclave origin, or a `human` class type — the November 2026
 * heroes have no origin); awakened or not; grants once when ≥3.
 */
const captainOnCultivate: ClassHandler = (ctx) => {
	const heroes = ctx.player.spirits.filter((s) => isHeroSpirit(s, ctx.catalog)).length;
	if (heroes >= 3) runAction(ctx, { kind: 'gainAugment', amount: 1 });
};

export const ability: ClassAbility[] = [
	{ on: 'onCultivate', run: captainOnCultivate },
	{
		on: 'onSpiritDiscard',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainAttackDice', tier: 'enchanted', amount: 1 }] }]
	}
];
