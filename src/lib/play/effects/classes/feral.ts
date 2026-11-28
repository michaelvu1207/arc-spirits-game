import { isEvilAlignment } from '../../types';
import type { ClassAbility } from './types';

// Feral — "When an Evil player or a monster attacks you, your side gains the initiative if it
// does not have it." No extra damage (Michael, 2026-11-18).
// - Monster combat (`inCombat` with no opposing seat): the monster attacks in every monster
//   fight, so the owner gains the initiative if their die misses.
// - PvP Encounter (`inCombat` carries the opposing seat): when that seat is Evil and this player
//   is not, this player's side gains the initiative if its dice miss.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			if (ctx.opponent === undefined) {
				ctx.player.alwaysAttackFirst = true;
				ctx.log.push('Feral: a monster attacks — you gain the initiative if your die misses.');
				return;
			}
			const opponent = ctx.state.players[ctx.opponent];
			if (!opponent) return;
			if (!isEvilAlignment(opponent.statusLevel) || isEvilAlignment(ctx.player.statusLevel)) return;
			ctx.player.alwaysAttackFirst = true;
			ctx.log.push('Feral: an Evil player attacks — your side gains the initiative if its dice miss.');
		}
	}
];
