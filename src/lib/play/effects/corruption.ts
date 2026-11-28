/**
 * Class and awaken effects of one corruption event (the barrier is emptied in combat, or a
 * status step up). Called at both corruption sites (`combat.ts` takeDamage and the runtime
 * `adjustStatus`), right after the corruption count goes up. A corruption while already Fallen
 * counts too.
 *  - Cultist: "When you become Corrupted, sacrifice 1 fewer spirit and gain 1 VP." The +1 VP is
 *    here; the smaller sacrifice is in `setCorruptionDiscardObligation` (types.ts).
 *  - Night Witch awaken ("Become Corrupted while Fallen."): progress flag when the player was
 *    already Fallen before this corruption (`wasFallen`).
 */
import type { PrivatePlayerState } from '../types';
import { hasAwakenedClass } from './actions';
import { AWAKEN_PROGRESS_KEYS, AWAKEN_SPIRIT_IDS, isFallen, recordAwakenProgress } from './awakenHandlers';

export const CULTIST_VP = 1;

export function applyCorruptionEffects(
	player: PrivatePlayerState,
	log?: string[],
	opts: { wasFallen?: boolean; catalog?: unknown } = {}
): void {
	if (hasAwakenedClass(player, 'Cultist')) {
		// Rule `cultistNoVp` (Michael, 2026-11-18): the Cultist gives no point (1 fewer sacrifice only).
		log?.push('Cultist: corrupted — sacrifice 1 fewer spirit.');
	}
	if (opts.wasFallen) {
		recordAwakenProgress(player, AWAKEN_SPIRIT_IDS.nightWitch, AWAKEN_PROGRESS_KEYS.nightWitch);
	}
}

/** Moon Cultist awaken ("While Fallen, sacrifice a spirit."): a discard that pays a corruption
 *  sacrifice, made while Fallen. */
export function recordSacrifice(player: PrivatePlayerState): void {
	if (!isFallen(player)) return;
	recordAwakenProgress(player, AWAKEN_SPIRIT_IDS.moonCultist, AWAKEN_PROGRESS_KEYS.moonCultist);
}
