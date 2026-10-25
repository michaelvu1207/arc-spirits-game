import type { ClassAbility, ClassHandler } from './types';

// Aquamaiden counts Spirits from the Water Region.
const reduceFromTidalSpirits: ClassHandler = (ctx) => {
	const tidal = ctx.player.spirits.reduce(
		(total, spirit) =>
			spirit.isFaceDown ? total : total + (spirit.origins?.['Water Region'] ?? 0),
		0
	);
	if (tidal <= 0) return;
	ctx.player.damageReduction += tidal;
	ctx.log.push(`Tide Warden: ${tidal} Water Spirit(s) reduce incoming damage by ${tidal}.`);
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: reduceFromTidalSpirits }];
