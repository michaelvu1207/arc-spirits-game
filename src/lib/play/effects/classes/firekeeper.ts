import { nextId } from '../../rng';
import { sentinelDamagePerDie } from '../../rules';
import type { ClassAbility, ClassDecisions, ClassHandler } from './types';

// Sentinel — "Before you roll in combat, you may discard attack dice. For each dice that you
// discard, deal 2 more damage." (It replaces "If you roll an even combat value, deal 3 more
// damage"; the old Emberguard text reduced incoming damage by 5.)
//
// Combat resolves in one step, so the owner chooses in advance: in each Awakening Phase where
// an awakened Sentinel owner holds attack dice, a decision card with a dice picker asks which
// dice (any number, any tier) to discard before the roll of their NEXT combat (monster or PvP).
// `useSentinelDiscard` (combat.ts) then removes those dice for good, just before the roll, and
// adds 2 damage per die (or the catalog's `numbers.sentinelDamagePerDie`) to that combat only. "Discard nothing" (or no pick) clears the choice.

export const SENTINEL_DISCARD_KIND = 'sentinelDiscard';

const offerDiscardChoice: ClassHandler = (ctx) => {
	const { player, state, log } = ctx;
	const perDie = sentinelDamagePerDie(ctx.catalog);
	player.pendingDecisions = (player.pendingDecisions ?? []).filter(
		(d) => d.kind !== SENTINEL_DISCARD_KIND
	);
	if ((player.attackDice ?? []).length === 0) return;
	const marked = (player.sentinelDiscardIds ?? []).filter((id) =>
		player.attackDice.some((die) => die.instanceId === id)
	).length;
	player.pendingDecisions.push({
		id: nextId(state.rng, 'dec'),
		source: 'class',
		kind: SENTINEL_DISCARD_KIND,
		prompt:
			`Sentinel: choose attack dice to discard before the roll of your next combat. Each discarded die deals ${perDie} more damage.` +
			(marked > 0 ? ` (Now chosen: ${marked}.)` : ''),
		options: [
			{ id: 'yes', label: 'Discard the chosen dice before my next combat roll' },
			{ id: 'no', label: 'Discard nothing' }
		]
	});
	log.push('Decision: Sentinel — choose attack dice to discard before your next combat roll.');
};

export const ability: ClassAbility[] = [{ on: 'awakeningPhase', run: offerDiscardChoice }];

export const decisions: ClassDecisions = {
	[SENTINEL_DISCARD_KIND](ctx, optionId, selectedInstanceIds) {
		const owned = new Set(ctx.player.attackDice.map((die) => die.instanceId));
		const chosen =
			optionId === 'yes' ? [...new Set(selectedInstanceIds ?? [])].filter((id) => owned.has(id)) : [];
		ctx.player.sentinelDiscardIds = chosen;
		ctx.log.push(
			chosen.length > 0
				? `Sentinel: ${chosen.length} attack ${chosen.length === 1 ? 'die' : 'dice'} will be discarded before your next combat roll (+${chosen.length * sentinelDamagePerDie(ctx.catalog)} damage).`
				: 'Sentinel: no attack dice will be discarded.'
		);
	}
};
