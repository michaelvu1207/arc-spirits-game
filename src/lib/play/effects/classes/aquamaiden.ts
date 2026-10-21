import type { ClassAbility, ClassHandler } from './types';

// Aquamaiden — Tidal Spirits are the live Moon Tide region spirits.
const reduceFromTidalSpirits: ClassHandler = (ctx) => {
	const tidal = ctx.player.spirits.reduce(
		(total, spirit) =>
			spirit.isFaceDown ? total : total + (spirit.origins?.['Moon Tide'] ?? 0),
		0
	);
	if (tidal <= 0) return;
	ctx.player.damageReduction += tidal;
	ctx.log.push(`Tide Warden: ${tidal} Tidal Spirit(s) reduce incoming damage by ${tidal}.`);
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: reduceFromTidalSpirits }];
