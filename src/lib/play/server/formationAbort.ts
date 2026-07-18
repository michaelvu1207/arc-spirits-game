/**
 * A ranked/matchmade formation aborted AFTER its session row existed. Carries
 * what the queue-claim owner (tryFormRankedMatch) must know to stay fail-closed:
 * the partial session's id and whether its close was durably CONFIRMED. An
 * unconfirmed close means the claimed queue rows must NOT re-enter the pool
 * until a recovery path closes the room for real — releasing them while the
 * partial room might still be live would let the same players form a second
 * match on top of it.
 *
 * Lives in its own module (not service.ts) so tests that mock the heavy service
 * module keep the REAL class for `instanceof` checks in matchmaking.ts.
 */
export class RankedFormationAbortError extends Error {
	readonly sessionId: string;
	/** True only when the partial session was VERIFIED closed (or gone). */
	readonly closed: boolean;
	constructor(sessionId: string, closed: boolean, cause: unknown) {
		super(
			`Ranked formation aborted (session ${sessionId}, close ${closed ? 'confirmed' : 'UNCONFIRMED'}): ` +
				(cause instanceof Error ? cause.message : String(cause)),
			{ cause }
		);
		this.name = 'RankedFormationAbortError';
		this.sessionId = sessionId;
		this.closed = closed;
	}
}
