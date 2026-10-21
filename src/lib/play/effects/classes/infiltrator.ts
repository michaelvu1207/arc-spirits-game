import type { ClassAbility, ClassHandler } from './types';

// Infiltrator — "For every Cursed Spirit trait you have, gain 1 Attack Damage."
const gainCursedDamage: ClassHandler = (ctx) => {
	const cursed = ctx.player.spirits.reduce(
		(total, spirit) =>
			spirit.isFaceDown ? total : total + (spirit.classes?.['Cursed Spirit'] ?? 0),
		0
	);
	if (cursed <= 0) return;
	ctx.player.combatDamageBonus += cursed;
	ctx.log.push(`'Cursed Fighter': gained +${cursed} combat damage from ${cursed} Cursed Spirit trait(s).`);
};

export const ability: ClassAbility[] = [{ on: 'inCombat', run: gainCursedDamage }];
