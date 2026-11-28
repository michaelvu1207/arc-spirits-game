import { nextId } from '../../rng';
import { runAction } from '../actions';
import { cameFromMountain } from './rider';
import { ruleValue } from '../../rules';
import { placedAugmentTotal } from '../../augments';
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
//
// Rule switch `ramAugmentDamage` (rules.ts; default false; Michael, 2026-11-14). On: Ram is "In
// combat, deal 1 more damage for each Spirit Augment on your spirits." Every placed augment
// counts, whatever its class and whether its spirit is awake; augments not yet placed do not.
// It applies in monster fights and player fights and does not grow with more Rams. The
// Mountain Region augment is off.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const augments = placedAugmentTotal(ctx.player);
			if (augments <= 0) return;
			ctx.player.combatDamageBonus += augments;
			ctx.log.push(`Ram: ${augments} Spirit Augment${augments === 1 ? '' : 's'} — deal ${augments} more damage.`);
		}
	},
	{
		on: 'onNavigate',
		run(ctx) {
			const { player, state } = ctx;
			return;
		}
	}
];

export const decisions: ClassDecisions = {
	ramAugment(ctx, optionId) {
		if (optionId !== 'yes') return;
		runAction(ctx, { kind: 'gainAugment', amount: 1 });
	}
};
