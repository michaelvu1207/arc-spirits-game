import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

/** Assassin's extra damage when it strikes first. */
export const ASSASSIN_DAMAGE = 3;

// Assassin — "In combat with a player who has more attack dice than you, strike first and deal 3
// more damage." PvP only (`inCombat` carries the opposing seat): when that player (the combat's
// representative seat) has MORE attack dice than this player — counted after a Witch's take, and
// an equal count gives nothing — this player's side gets attack-first priority and this player
// deals 3 more damage. The old "+4 Initiative, roll twice" rule is gone.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const opponent = ctx.opponent ? ctx.state.players[ctx.opponent] : undefined;
			if (!opponent) return;
			if (opponent.attackDice.length <= ctx.player.attackDice.length) return;
			// Rule `initiativeDie` (Michael, 2026-11-26: "remove the strike first from assasin"): the damage only.
			if (ruleValue(ctx.catalog, 'initiativeDie')) {
				ctx.player.combatDamageBonus += ASSASSIN_DAMAGE;
				ctx.log.push(`Assassin: ${ctx.opponent} has more attack dice — deal ${ASSASSIN_DAMAGE} more.`);
				return;
			}
			ctx.player.alwaysAttackFirst = true;
			ctx.player.combatDamageBonus += ASSASSIN_DAMAGE;
			ctx.log.push(`Assassin: ${ctx.opponent} has more attack dice — strike first and deal ${ASSASSIN_DAMAGE} more.`);
		}
	}
];
