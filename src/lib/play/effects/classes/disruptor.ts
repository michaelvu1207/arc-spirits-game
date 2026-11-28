import type { ClassAbility, ClassHandler } from './types';

/**
 * Bastion — "If the opponent's side has more initiative than your side, or is a monster, when you
 * Take Damage, half it (rounding up)." Every monster hit (`combat.vsMonster`) is halved. Against
 * a player it reads the opposing seat's stored initiative (or the group's pooled total via
 * `combat.opponentInitiative`); if it exceeds this player's, flag the halve.
 */
const disruptorOnTakeDamage: ClassHandler = (ctx) => {
	if (ctx.combat?.vsMonster) {
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
			"The opponent's side has more initiative than yours — incoming damage is halved."
		);
	}
};

export const ability: ClassAbility[] = [{ on: 'onTakeDamage', run: disruptorOnTakeDamage }];
