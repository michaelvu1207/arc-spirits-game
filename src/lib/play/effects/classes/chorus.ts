import { runAction } from '../actions';
import type { ClassAbility } from './types';

// Chorus — "When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max
// Barrier." Fires on every awakening while a Chorus is awake (including the Chorus spirit's own
// awakening).
export const ability: ClassAbility[] = [
	{
		on: 'awakening',
		run(ctx) {
			runAction(ctx, { kind: 'restoreBarrier', amount: ctx.player.maxBarrier });
			runAction(ctx, { kind: 'gainMaxBarrier', amount: 2 });
		}
	}
];
