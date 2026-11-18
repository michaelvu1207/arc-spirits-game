import { runAction } from '../actions';
import { nextId } from '../../rng';
import { ruleValue } from '../../rules';
import type { ClassAbility, ClassDecisions } from './types';

// Healer — "When discarded, restore two barriers. On rest, if you have 10 max barrier,
// you may restore 3 barrier and gain 1 VP."
//
// On-summon restore: like Sharpshooter's on-summon grant, this fires for the summoning
// player whenever a spirit is summoned while an awakened Healer is in play — a flat
// +2 barrier of sustain. The on-rest opt-in (a bespoke `run` handler gated on the full
// 10 max barrier) still offers the restore-3 + 1 VP via the `healerRestore` resolver.
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
				log.push('Healer: need 10 max barrier to restore barrier and gain VP.');
				return;
			}
			const noVp = ruleValue(ctx.catalog, 'healerNoVp');
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'healerRestore',
				prompt: noVp ? 'On rest, you may restore 3 barrier.' : 'On rest, you may restore 3 barrier and gain 1 VP.',
				options: [
					{ id: 'yes', label: noVp ? 'Restore 3 barrier' : 'Restore 3 barrier and gain 1 VP' },
					{ id: 'no', label: 'No' }
				]
			});
			log.push('Decision: On rest, restore 3 barrier and gain 1 VP?');
		}
	}
];

// Resolver for the opt-in card: restore 3 barrier (self only) and gain 1 VP.
export const decisions: ClassDecisions = {
	healerRestore(ctx, optionId) {
		if (optionId !== 'yes') return;
		runAction(ctx, { kind: 'restoreBarrier', amount: 3 });
		// Rule `healerNoVp` (Michael, 2026-11-18): no point.
		if (!ruleValue(ctx.catalog, 'healerNoVp')) runAction(ctx, { kind: 'gainVP', amount: 1 });
	}
};
