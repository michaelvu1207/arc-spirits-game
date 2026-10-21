import type { ClassAbility, ClassHandler } from './types';

// Strategist — reduce incoming damage by 1 for every placed Spirit Augment.
const reduceFromAugments: ClassHandler = (ctx) => {
	const augments = ctx.player.spiritAugmentAttachments?.length ?? 0;
	if (augments <= 0) return;
	ctx.player.damageReduction += augments;
	ctx.log.push(`Runic Bulwark: ${augments} Spirit Augment(s) reduce incoming damage by ${augments}.`);
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: reduceFromAugments }];
