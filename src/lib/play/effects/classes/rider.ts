import { nextId } from '../../rng';
import type { PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility, ClassDecisions } from './types';

// Rider — "When you navigate to the Mountain Region from a different location, choose one:
// restore 3 Barrier, gain 3 Max Barrier, gain 3 Basic Attack Dice, or gain 1 Spirit Augment of
// your choice."
//
// When destinations are revealed (`onNavigate`) and the owner's destination is the Mountain
// Region, an awakened Rider gives one card, but only when the owner's location in the previous
// round (`previousDestination`) was not the Mountain Region. Round 1 (no previous location)
// counts; staying at the Mountain Region gives nothing (Michael, 2026-11-12). The card stays open through
// the Encounter and Location Phases. "Choose one" is not optional: an unanswered card (bots
// never answer) expires when the Benefits step starts and the engine applies `auto`.
// The dice go through the normal gain path (cap, Wildling, Druid); new Max Barrier arrives
// intact (`gainMaxBarrier` raises the current barrier by the same amount).

export const RIDER_DESTINATION = 'Mountain Region';

/** Rider and Ram: the owner was at the Mountain Region in the previous round (so this is not an
 *  arrival "from a different location"). Round 1 has no previous location. */
export function cameFromMountain(player: Pick<PrivatePlayerState, 'previousDestination'>): boolean {
	return (player.previousDestination ?? null) === RIDER_DESTINATION;
}
export const RIDER_AMOUNT = 3;
const MAX_BARRIER_CAP = 10;

type RiderOption = 'restore' | 'maxBarrier' | 'dice' | 'augment';

/** The engine's pick for an unanswered card: the option that gives the most right now. Max
 *  Barrier also restores what it adds, so it wins while it adds at least as much as a restore. */
export function riderDefaultOption(player: PrivatePlayerState): RiderOption {
	const maxGain = Math.min(RIDER_AMOUNT, MAX_BARRIER_CAP - player.maxBarrier);
	const restoreGain = Math.min(RIDER_AMOUNT, player.maxBarrier - player.barrier);
	if (maxGain > 0 && maxGain >= restoreGain) return 'maxBarrier';
	if (restoreGain > 0) return 'restore';
	return 'dice';
}

export const ability: ClassAbility[] = [
	{
		on: 'onNavigate',
		run(ctx) {
			const { player, state } = ctx;
			if (player.navigationDestination !== RIDER_DESTINATION) return;
			if (cameFromMountain(player)) return;
			player.pendingDecisions = (player.pendingDecisions ?? []).filter(
				(d) => d.kind !== 'riderMountain'
			);
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'riderMountain',
				prompt: 'Rider: you navigated to the Mountain Region. Choose one.',
				options: [
					{ id: 'restore', label: `Restore ${RIDER_AMOUNT} Barrier` },
					{ id: 'maxBarrier', label: `Gain ${RIDER_AMOUNT} Max Barrier` },
					{ id: 'dice', label: `Gain ${RIDER_AMOUNT} Basic Attack Dice` },
					// Never the engine's own pick.
					{ id: 'augment', label: 'Gain 1 Spirit Augment of your choice' }
				],
				expiresAt: 'benefits',
				expiryOptionId: 'auto'
			});
		}
	}
];

export const decisions: ClassDecisions = {
	riderMountain(ctx, optionId) {
		const choice: RiderOption =
			optionId === 'auto' ? riderDefaultOption(ctx.player) : (optionId as RiderOption);
		if (optionId === 'auto') ctx.log.push('Rider: no choice made — the engine picks one.');
		switch (choice) {
			case 'restore':
				runAction(ctx, { kind: 'restoreBarrier', amount: RIDER_AMOUNT });
				break;
			case 'maxBarrier':
				runAction(ctx, { kind: 'gainMaxBarrier', amount: RIDER_AMOUNT });
				break;
			case 'dice':
				runAction(ctx, { kind: 'gainAttackDice', tier: 'basic', amount: RIDER_AMOUNT });
				break;
			case 'augment':
				runAction(ctx, { kind: 'gainAugment', amount: 1 });
				break;
		}
	}
};
