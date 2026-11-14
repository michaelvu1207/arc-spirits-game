import { runAction } from '../actions';
import type { ClassAbility } from './types';

// Wanderer — "When you enter a location where you were not last round, gain 2 Basic Attack
// Dice." Checked at Navigation Reveal: `previousDestination` is the location of the previous
// round (set when a new round begins; null in round 1, so round 1 counts as a new location).
export const ability: ClassAbility[] = [
	{
		on: 'onNavigate',
		run(ctx) {
			const here = ctx.player.navigationDestination;
			if (!here || here === (ctx.player.previousDestination ?? null)) return;
			runAction(ctx, { kind: 'gainAttackDice', tier: 'basic', amount: 2 });
		}
	}
];
