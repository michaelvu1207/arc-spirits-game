import { ruleValue } from '../../rules';
import type { ClassAbility, ClassHandler } from './types';

/**
 * "If the opponent has higher initiative, when you Take Damage, half it (rounding
 * up)." Reads the opposing seat's stored initiative (or the group's pooled total via
 * `combat.opponentInitiative`); if it exceeds this player's, flag the halve.
 * Rule `bastionVsMonsters` (default false): "…, or is a monster, …" — every monster hit
 * (`combat.vsMonster`) is halved, whatever the monster's initiative.
 */
const disruptorOnTakeDamage: ClassHandler = (ctx) => {
	if (ctx.combat?.vsMonster && ruleValue(ctx.catalog, 'bastionVsMonsters')) {
		ctx.player.halveIncoming = true;
		ctx.log.push('A monster attacks — incoming damage is halved.');
		return;
	}
	const opponentSeat = ctx.combat?.opponent ?? ctx.opponent;
	const opponent = opponentSeat ? ctx.state.players[opponentSeat] : undefined;
	const opponentInitiative = ctx.combat?.opponentInitiative ?? opponent?.initiative;
	if (opponentInitiative != null && opponentInitiative > ctx.player.initiative) {
		ctx.player.halveIncoming = true;
		ctx.log.push(
			ruleValue(ctx.catalog, 'initiativeDie') && ruleValue(ctx.catalog, 'initiativeSum')
				? "The opponent's side has more initiative than yours — incoming damage is halved."
				: ruleValue(ctx.catalog, 'initiativeDie')
				? 'The opponent has the initiative and your side does not — incoming damage is halved.'
				: 'Opponent has higher initiative — incoming damage is halved.'
		);
	}
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: disruptorOnTakeDamage }];
