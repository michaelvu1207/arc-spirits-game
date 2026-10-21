/**
 * Status-change bookkeeping + the `onStatusChange` trigger.
 *
 * Whenever a player's `statusLevel` changes — the corruption ladder in
 * `combat.ts takeDamage`, or a manual `adjustStatus` in the runtime — this helper
 * records which corruption thresholds were crossed THIS round (so the Awakening
 * Phase, folded into cleanup, can grant the status-driven class effects exactly
 * once) and fires the `onStatusChange` trigger so any immediate class reaction
 * runs.
 *
 * The threshold flags are engine bookkeeping (they apply regardless of class), so
 * they're set here at the single dispatch point rather than in a class handler.
 * They are reset at the start of each round in `beginNavigation`. `corruptedThisRound`
 * marks any upward status move (Abyss Harbinger); the per-stage `became*` flags mark
 * the specific stage entered (Cursed Spirit's per-stage grants).
 */

import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import { applyTrigger } from './apply';

/** Status ladder indices, named for readability at the call sites. */
const TAINTED = 1;
const CORRUPT = 2;
const FALLEN = 3;

/**
 * Record the thresholds crossed by a `oldStatus → newStatus` transition and fire
 * the `onStatusChange` trigger. Only upward transitions (corruption) record
 * threshold flags; a no-op transition (old === new) still fires the trigger so
 * callers stay uniform, but records nothing.
 *
 * Flags are sticky for the round (set, never cleared here) so a player who passes
 * through Tainted on the way to Corrupt records BOTH — each `became*` reflects
 * "you entered this stage this round", which is what the Awakening-Phase grants key
 * on. Reset happens at `beginNavigation`.
 */
export function applyStatusChange(
	state: PublicGameState,
	seat: SeatColor,
	oldStatus: number,
	newStatus: number,
	catalog: PlayCatalog | undefined,
	log: string[]
): void {
	const player = state.players[seat];
	if (!player) return;

	if (newStatus > oldStatus) {
		player.corruptedThisRound = true;
		// Mark every stage newly entered on this transition (covers multi-step jumps).
		if (newStatus >= TAINTED && oldStatus < TAINTED) player.becameTaintedThisRound = true;
		if (newStatus >= CORRUPT && oldStatus < CORRUPT) player.becameCorruptThisRound = true;
		if (newStatus >= FALLEN && oldStatus < FALLEN) player.becameFallenThisRound = true;
	}

	applyTrigger(state, seat, 'onStatusChange', log, { catalog, oldStatus, newStatus });
}
