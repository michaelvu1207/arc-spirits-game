import { ruleValue } from '../../rules';
import type { ClassAbility } from './types';

// Queen — DB intent: "In the Awakening Phase, gain 1 VP." Unconditional.
//
// CHANGED: was an all-Evil win-con (+3 VP × players) surfaced as a Cleanup CLAIM
// card (enterCleanup → resolveAwakenReward). Now a flat, unconditional +1 VP in the
// Awakening Phase. Implemented as a bespoke `run` handler on `awakeningPhase` (fires
// once per active player at cleanup, BEFORE findWinner) that mutates the acting
// player's victoryPoints directly and logs a breadcrumb so the gain is observable.
//
// Rule switch `moonPerksNeedAttack` (rules.ts; default false): on ⇒ the VP only in a round in
// which this player attacked a player (`attackedPlayerThisRound`, set when a PvP attack resolves).
//
// ENGINE FOLLOW-UP (cannot be done in this file): the old Queen Cleanup claim
// in phases.ts `enterCleanup` must be REMOVED, and Queen moved out of
// ENGINE_HANDLED_CLASSES (into the handler-coverage path) in coverage.test.ts /
// awaken.test.ts — otherwise the player is granted VP twice. Reported via engineNeeds.
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			const { player, log } = ctx;
			if (ruleValue(ctx.catalog, 'moonPerksNeedAttack') && !player.attackedPlayerThisRound) {
				log.push('Queen: no player attacked this round — no VP.');
				return;
			}
			player.victoryPoints += 1;
			log.push('Queen: Awakening Phase — gain 1 VP.');
		}
	}
];
