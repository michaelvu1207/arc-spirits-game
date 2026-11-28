import { isEvilAlignment } from '../../types';
import type { ClassAbility } from './types';

/** Feral's extra damage (when its side strikes first; against monsters always, see the rule switch). */
export const FERAL_DAMAGE = 3;

// Feral — "When an Evil player or a monster attacks you, your side strikes first and deals 3
// more damage."
// - Monster combat (`inCombat` with no opposing seat): the monster attacks in every monster
//   fight, so the owner strikes first and deals 3 more damage.
// - PvP Encounter (`inCombat` carries the opposing seat): when that seat is Evil and this player
//   is not, this player's side gets attack-first priority and this player deals 3 more damage
//   (added to the side's total).
// Rule `feralNoDamage` (Michael, 2026-11-18): no extra damage at all; Feral is only "When an Evil
// player or a monster attacks you, your side strikes first."
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const bonus = 0;
			const more = bonus ? ` and deal ${bonus} more damage` : '';
			if (ctx.opponent === undefined) {
				ctx.player.alwaysAttackFirst = true;
				ctx.player.combatDamageBonus += bonus;
				ctx.log.push(`Feral: a monster attacks — you gain the initiative if your die misses${more}.`);
				return;
			}
			const opponent = ctx.state.players[ctx.opponent];
			if (!opponent) return;
			if (!isEvilAlignment(opponent.statusLevel) || isEvilAlignment(ctx.player.statusLevel)) return;
			ctx.player.alwaysAttackFirst = true;
			ctx.player.combatDamageBonus += bonus;
			ctx.log.push(
				`Feral: an Evil player attacks — your side gains the initiative if its dice miss${more}.`
			);
		}
	}
];
