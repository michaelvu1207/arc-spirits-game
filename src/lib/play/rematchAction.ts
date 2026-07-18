/**
 * The postgame REMATCH action, extracted framework-free (the Svelte component
 * adapts its closures into the deps) so the lifetime/ordering contract is
 * deterministically testable:
 *
 *   - LIFETIME FENCE: a held rematch response landing after the component
 *     unmounted, or after the player explicitly chose Main Menu, acts on
 *     NOTHING — no member seed into the global store, no goto over the route
 *     the player picked, no error write to a dead screen. The lobby the server
 *     may have created stays live for the PARTY (their postgame polls converge
 *     on it); only this client's late jump is cancelled.
 *   - CONTEXT FENCE: the response navigates only for the exact identity/room
 *     that initiated it (a durable account change or room swap mid-flight
 *     surfaces an error instead — while the screen is still alive).
 *   - ROLLBACK: the member seed is applied immediately before the navigation
 *     and rolled back if the goto FAILS (only while the seed is still the live
 *     value), so room A is never left rendered under room B's member identity.
 */

export interface RematchDeps<PriorMember> {
	/** POST /rematch for the finished room (creates-or-joins the party lobby). */
	post(): Promise<{ roomCode: string; memberId: string }>;
	/** True while the initiating identity + finished room are still on screen. */
	fresh(): boolean;
	/** True once the component unmounted or the player explicitly navigated away. */
	departed(): boolean;
	/** Seed the rematch membership; returns the prior member picture for rollback. */
	seed(memberId: string): PriorMember;
	/** Roll a failed navigation's seed back (no-op if the seed was superseded). */
	restore(prior: PriorMember, seededMemberId: string): void;
	/** Navigate into the rematch lobby. */
	navigate(roomCode: string): Promise<void>;
	/** Surface a user-facing failure (called only while the screen is alive). */
	onError(message: string): void;
}

export type RematchOutcome = 'navigated' | 'ignored' | 'failed';

export async function runRematch<PriorMember>(
	deps: RematchDeps<PriorMember>
): Promise<RematchOutcome> {
	try {
		const result = await deps.post();
		// LIFETIME fence first: unmount / explicit Main Menu wins over the held
		// response, silently and completely.
		if (deps.departed()) return 'ignored';
		if (!deps.fresh()) throw new Error('Your account or room changed — rematch not joined.');
		const prior = deps.seed(result.memberId);
		try {
			await deps.navigate(result.roomCode);
			return 'navigated';
		} catch (navErr) {
			deps.restore(prior, result.memberId);
			throw navErr;
		}
	} catch (e) {
		// A failure surfacing after departure belongs to nobody: no error write, and
		// the outcome reads as the ignore it is.
		if (deps.departed()) return 'ignored';
		if (deps.fresh()) {
			deps.onError(e instanceof Error ? e.message : 'Rematch failed — try again.');
		}
		return 'failed';
	}
}
