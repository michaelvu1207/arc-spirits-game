import { runAction } from '../actions';
import { nextId } from '../../rng';
import type { ClassAbility, ClassDecisions } from './types';

// Arcane Ascendant — "In the Awakening phase, you may upgrade 1 Exalted Attack to an
// Arcane Attack." Was an onRest auto-upgrade; now an Awakening-phase opt-in.
//
// Implemented as a bespoke `run` handler on `awakeningPhase` (fires once per active
// player at cleanup) so we can gate precisely on the player HOLDING an Exalted die —
// the declarative `hasAttackDice` condition only counts total dice, not a tier — and
// only then surface the opt-in card. The colocated `arcaneAdvisorUpgrade` resolver
// performs the single exalted→arcane upgrade when the player picks "yes".
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			const { player, log, state } = ctx;
			const hasExalted = player.attackDice.some((d) => d.tier === 'exalted');
			if (!hasExalted) {
				// No-silent-no-op: a player with no Exalted die simply isn't offered the
				// choice. The eligibility itself (offering only when holdable) is the UX
				// surface; we still leave a log breadcrumb so the gate is observable.
				log.push('Arcane Ascendant: no Exalted attack die to upgrade.');
				return;
			}
			player.pendingDecisions.push({
				id: nextId(state.rng, 'dec'),
				source: 'class',
				kind: 'arcaneAdvisorUpgrade',
				prompt: 'Awakening: you may upgrade 1 Exalted Attack to an Arcane Attack.',
				options: [
					{ id: 'yes', label: 'Upgrade Exalted → Arcane' },
					{ id: 'no', label: 'No' }
				]
			});
			log.push('Decision: Awakening — upgrade 1 Exalted Attack to an Arcane Attack?');
		}
	}
];

// Colocated resolver for the opt-in card: upgrade exactly one Exalted die to Arcane.
export const decisions: ClassDecisions = {
	arcaneAdvisorUpgrade(ctx, optionId) {
		if (optionId !== 'yes') return;
		runAction(ctx, { kind: 'upgradeDice', times: 1, from: 'exalted', to: 'arcane' });
	}
};
