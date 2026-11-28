import { runAction } from '../actions';
import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

// Chorus — "When you awaken a spirit, restore 3 Barrier and gain 1 potential."
// Fires on every awakening while a Chorus is awake (including the Chorus spirit's own
// awakening). potential = max barrier.
// Rule `sunRework` (default false): "restore all your Barrier and gain 2 Max Barrier."
export const ability: ClassAbility[] = [
	{
		on: 'awakening',
		run(ctx) {
			runAction(ctx, { kind: 'restoreBarrier', amount: ctx.player.maxBarrier });
			runAction(ctx, { kind: 'gainMaxBarrier', amount: 2 });
			return;
		}
	}
];
