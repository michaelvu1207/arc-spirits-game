import { isEvilAlignment } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility } from './types';

// Sorcerer — "In the Awakening Phase, if you are Evil, gain 1 Enchanted Attack Dice." Fires with
// the other Awakening-Phase effects (the Benefits step). The die goes through the normal gain path
// (cap 10, Wildling, Druid). The old Exalted → Arcane upgrade card is gone.
// Rule switch `moonPerksNeedAttack` (rules.ts; default false): on ⇒ only in a round in which this
// player attacked a player (`attackedPlayerThisRound`).
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			if (!isEvilAlignment(ctx.player.statusLevel)) return;
			runAction(ctx, { kind: 'gainAttackDice', tier: 'enchanted', amount: 1 });
		}
	}
];
