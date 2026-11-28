import { isEvilAlignment } from '../../types';
import { ruleValue } from '../../rules';
import { runAction } from '../actions';
import type { ClassAbility } from './types';

/** Gardener's restore in the Awakening Phase. */
export const GARDENER_RESTORE = 2;
/** Rule `sunRework`: restore 3 and gain 1 Max Barrier. */
export const GARDENER_SUN_RESTORE = 3;

// Gardener — "In the Awakening Phase, if you are not Evil, restore 2 Barrier." Uses the engine's
// `awakeningPhase` event, the same beat as every other "In the Awakening Phase" text (Princess,
// Queen, Sorcerer, Cursed Spirit): it fires once per round when the post-location sequence starts
// (the step the code calls Benefits, before spirits flip).
// Rule `sunRework` (default false): "restore 3 Barrier and gain 1 Max Barrier."
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			if (isEvilAlignment(ctx.player.statusLevel)) return;
			runAction(ctx, { kind: 'restoreBarrier', amount: GARDENER_SUN_RESTORE });
			runAction(ctx, { kind: 'gainMaxBarrier', amount: 1 });
			return;
		}
	}
];
