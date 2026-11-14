import { nextId } from '../../rng';
import { runAction } from '../actions';
import { cameFromMountain } from './rider';
import type { ClassAbility, ClassDecisions } from './types';

/** Where Ram's augment comes from (the same arrival as Rider). */
export const RAM_DESTINATION = 'Mountain Region';

// Ram — "When you navigate to the Mountain Region from a different location, you may gain 1
// Spirit Augment of your choice."
// Same trigger and timing as Rider: when destinations are revealed (`onNavigate`) and the owner's
// destination is the Mountain Region, and the owner's location in the previous round was not the
// Mountain Region (round 1 counts; staying there gives nothing; see `cameFromMountain`), an
// awakened Ram gives one yes/no card. "Yes" gains 1 generic Spirit Augment through the common
// gain path (the owner picks its type at placement; Smith adds 1 more). The card stays open
// through the Encounter and Location Phases; an unanswered card (bots) ends at Benefits with no
// augment ("you may").
export const ability: ClassAbility[] = [
	{
		on: 'onNavigate',
		run(ctx) {
			const { player, state } = ctx;
			if (player.navigationDestination !== RAM_DESTINATION) return;
			if (cameFromMountain(player)) return;
			player.pendingDecisions = (player.pendingDecisions ?? []).filter((d) => d.kind !== 'ramAugment');
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'ramAugment',
				prompt: 'Ram: you navigated to the Mountain Region. Gain 1 Spirit Augment of your choice?',
				options: [
					{ id: 'yes', label: 'Gain 1 Spirit Augment' },
					{ id: 'no', label: 'No augment' }
				],
				expiresAt: 'benefits'
			});
		}
	}
];

export const decisions: ClassDecisions = {
	ramAugment(ctx, optionId) {
		if (optionId !== 'yes') return;
		runAction(ctx, { kind: 'gainAugment', amount: 1 });
	}
};
