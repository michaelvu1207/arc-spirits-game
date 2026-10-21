import type { ClassAbility, ClassHandler } from './types';

// Firekeeper — "If you roll an even combat value in combat, when you Take
// Damage, reduce it by 5." Combat records the roll before damage lands.
const reduceEvenRollDamage: ClassHandler = (ctx) => {
	const value = ctx.player.combatValueThisFight;
	if (value === undefined || value % 2 !== 0) return;
	ctx.player.damageReduction += 5;
	ctx.log.push(`Emberguard: even combat value (${value}) reduces incoming damage by 5.`);
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: reduceEvenRollDamage }];
