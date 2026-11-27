import { isEvilAlignment } from '../../types';
import { ruleValue } from '../../rules';
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
			const bonus = ruleValue(ctx.catalog, 'feralNoDamage') ? 0 : FERAL_DAMAGE;
			const more = bonus ? ` and deal ${bonus} more damage` : '';
			// Rule `initiativeDie` (Michael, 2026-11-26: "feral should be gain initiative if your side doesn't"):
			// the flag then means "has the initiative even when the die misses" (combat.ts).
			const die = ruleValue(ctx.catalog, 'initiativeDie');
			if (ctx.opponent === undefined) {
				// Rule switch `feralMonsterStrikeFirst` (rules.ts; default true). Off (proposal C2):
				// against a monster Feral only deals its 3 more damage; vs Evil players unchanged.
				if (!ruleValue(ctx.catalog, 'feralMonsterStrikeFirst')) {
					if (!bonus) return;
					ctx.player.combatDamageBonus += bonus;
					ctx.log.push(`A monster attacks — you deal ${bonus} more damage.`);
					return;
				}
				ctx.player.alwaysAttackFirst = true;
				ctx.player.combatDamageBonus += bonus;
				ctx.log.push(die ? `Feral: a monster attacks — you gain the initiative if your die misses${more}.` : `A monster attacks — you strike first${more}.`);
				return;
			}
			const opponent = ctx.state.players[ctx.opponent];
			if (!opponent) return;
			if (!isEvilAlignment(opponent.statusLevel) || isEvilAlignment(ctx.player.statusLevel)) return;
			ctx.player.alwaysAttackFirst = true;
			ctx.player.combatDamageBonus += bonus;
			ctx.log.push(
				die
					? `Feral: an Evil player attacks — your side gains the initiative if its dice miss${more}.`
					: bonus
						? `An Evil player attacks — your side strikes first and you deal ${bonus} more damage.`
						: 'An Evil player attacks — your side strikes first.'
			);
		}
	}
];
