import type { PublicGameState } from '../types';

type RoundState = Pick<PublicGameState, 'status' | 'round'>;

/**
 * Return the round whose post-cleanup/final state should be persisted after a successful CAS.
 * Modern play advances rounds through ordinary phase commands and deadline enforcement; the
 * obsolete commitRound command is neither necessary nor sufficient as a capture signal.
 */
export function completedHistoryRound(before: RoundState, after: RoundState): number | null {
	if (before.status !== 'active') return null;
	if (after.status === 'finished') return after.round > 0 ? after.round : null;
	if (after.status === 'active' && after.round > before.round) {
		return before.round > 0 ? before.round : null;
	}
	return null;
}
