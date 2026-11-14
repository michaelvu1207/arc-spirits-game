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
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			if (ctx.opponent === undefined) {
				// Rule switch `feralMonsterStrikeFirst` (rules.ts; default true). Off (proposal C2):
				// against a monster Feral only deals its 3 more damage; vs Evil players unchanged.
				if (!ruleValue(ctx.catalog, 'feralMonsterStrikeFirst')) {
					ctx.player.combatDamageBonus += FERAL_DAMAGE;
					ctx.log.push(`A monster attacks — you deal ${FERAL_DAMAGE} more damage.`);
					return;
				}
				ctx.player.alwaysAttackFirst = true;
				ctx.player.combatDamageBonus += FERAL_DAMAGE;
				ctx.log.push(`A monster attacks — you strike first and deal ${FERAL_DAMAGE} more damage.`);
				return;
			}
			const opponent = ctx.state.players[ctx.opponent];
			if (!opponent) return;
			if (!isEvilAlignment(opponent.statusLevel) || isEvilAlignment(ctx.player.statusLevel)) return;
			ctx.player.alwaysAttackFirst = true;
			ctx.player.combatDamageBonus += FERAL_DAMAGE;
			ctx.log.push(
				`An Evil player attacks — your side strikes first and you deal ${FERAL_DAMAGE} more damage.`
			);
		}
	}
];
