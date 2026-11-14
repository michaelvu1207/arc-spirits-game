import { runAction } from '../actions';
import type { ClassAbility } from './types';

/** Hunter's flat damage bonus in monster combat. */
export const HUNTER_MONSTER_DAMAGE = 5;

// Hunter — "In combat with a monster, deal 5 more damage." A flat bonus like Titan's
// combatBonus: added once to the attack roll of each monster combat (not to each die).
// Monster combat fires `inCombat` with no opponent seat; PvP passes one, so PvP gets nothing.
// Each monster fight resets the combat flags and fires `inCombat` again, so both Monster
// Hunter combats in a round get the bonus.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			if (ctx.opponent !== undefined) return;
			runAction(ctx, { kind: 'combatBonus', amount: HUNTER_MONSTER_DAMAGE });
		}
	}
];
