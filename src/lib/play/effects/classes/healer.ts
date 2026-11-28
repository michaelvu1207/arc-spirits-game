import { runAction } from '../actions';
import { nextId } from '../../rng';
import type { ClassAbility, ClassDecisions } from './types';

// Healer — "On rest, if you have 10 max barrier, you may restore 3 barrier. When discarded,
// restore 2 barrier." No point (Michael, 2026-11-18).
//
// The discard restore fires on `onSpiritDiscard` while an awakened Healer is in play. The on-rest
// opt-in (a bespoke `run` handler gated on the full 10 max barrier) offers the restore of 3 via
// the `healerRestore` resolver.
export const ability: ClassAbility[] = [
	{
		on: 'onSpiritDiscard',
		breakpoints: [{ count: 1, actions: [{ kind: 'restoreBarrier', amount: 2 }] }]
	},
	{
		on: 'onRest',
		run(ctx) {
			const { player, log, state } = ctx;
			// Gate: the reward is only available at the full 10 max barrier breakpoint.
			if (player.maxBarrier < 10) {
				// No-silent-no-op: a player below 10 max barrier simply isn't offered the
				// choice. We leave a log breadcrumb so the gate stays observable.
				log.push('Healer: need 10 max barrier to restore barrier.');
				return;
			}
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'healerRestore',
				prompt: 'On rest, you may restore 3 barrier.',
				options: [
					{ id: 'yes', label: 'Restore 3 barrier' },
					{ id: 'no', label: 'No' }
				]
			});
			log.push('Decision: On rest, restore 3 barrier?');
		}
	}
];

// Resolver for the opt-in card: restore 3 barrier (self only).
export const decisions: ClassDecisions = {
	healerRestore(ctx, optionId) {
		if (optionId !== 'yes') return;
		runAction(ctx, { kind: 'restoreBarrier', amount: 3 });
	}
};
