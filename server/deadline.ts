/**
 * Server-clock phase-deadline helpers, ported verbatim from
 * src/lib/play/server/service.ts (stampPhaseDeadline / applyNavLockDeadline). The pure
 * reducer nulls phaseDeadline on every phase entry; the server re-stamps it against the
 * SERVER clock after each command so a silent/disconnected seat can't stall the game.
 * Shared by the room host (live) and the bot-game bench.
 */

import { phaseDurationMs, type PublicGameState } from '../src/lib/play/types';

const NAV_GRACE_MS = 5000;

/** Stamp the wall-clock deadline for the CURRENT phase if unset. */
export function stampPhaseDeadline(state: PublicGameState): void {
	if (state.status !== 'active') {
		state.phaseDeadline = null;
		return;
	}
	if (state.phase === 'navigation' && !state.revealedDestinations) {
		const dur = state.navigationDurationMs;
		if (dur == null) {
			state.phaseDeadline = null;
			state.navigationDeadline = null;
			state.navigationFullDeadline = null;
			return;
		}
		if (state.phaseDeadline == null) state.phaseDeadline = Date.now() + dur;
		state.navigationDeadline ??= state.phaseDeadline;
		state.navigationFullDeadline ??= state.navigationDeadline;
		return;
	}
	if (state.phaseDeadline == null) {
		state.phaseDeadline = Date.now() + phaseDurationMs(state.phase);
	}
}

/** Collapse the navigation deadline to a short grace once every seat is locked. */
export function applyNavLockDeadline(state: PublicGameState): void {
	if (state.status !== 'active' || state.phase !== 'navigation' || state.revealedDestinations)
		return;
	const seats = state.activeSeats;
	const allLocked = seats.length > 0 && seats.every((s) => state.navigation[s]?.locked === true);
	const full = state.navigationFullDeadline;
	if (allLocked) {
		const grace = Date.now() + NAV_GRACE_MS;
		const target = full == null ? grace : Math.min(full, grace);
		state.navigationDeadline = target;
		state.phaseDeadline = target;
	} else {
		state.navigationDeadline = full;
		state.phaseDeadline = full;
	}
}

/** True when the current phase has run past its server-clock deadline. */
export function deadlinePassed(state: PublicGameState): boolean {
	return (
		state.status === 'active' && state.phaseDeadline != null && Date.now() > state.phaseDeadline
	);
}
