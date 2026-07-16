import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelSearch, leaveQueue } from '$lib/play/server/matchmaking';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Leave the ranked matchmaking queue (cancel search).
 *
 * Two cancellation contracts, deliberately SEPARATE so one can never affect the
 * other:
 *
 *   - `{ searchId }` — EXACT-HANDLE retirement: retires the one search bound to
 *     that SERVER HANDLE (returned only in the authenticated queue responses of
 *     the row's owner) and touches NOTHING else. This is the
 *     initiating-principal-bound path: after a durable account transition — or a
 *     sign-out that destroyed the session entirely — the caller may authenticate
 *     as a DIFFERENT uid or none at all, so possession of the unguessable
 *     256-bit handle (never a retained/replayed superseded token) is the proof
 *     of initiation, and NO session is required. Crucially, this path performs
 *     NO uid-bound leave: retiring stale account A's search while signed in as
 *     account B must never cancel B's own fresh queue row. A handle whose row
 *     already matched retires the initiating uid's seat in the formed room
 *     (closing it when no human remains), so an in-flight old search can never
 *     leave an abandoned match or a ghost seat behind.
 *
 *   - Default (no `searchId`) — CURRENT-PRINCIPAL cancel: auth REQUIRED; cancels
 *     the CALLER's own still-searching row. A row that already matched is left
 *     alone so the hand-off to the created game isn't clobbered.
 */
export const POST: RequestHandler = async (event) => {
	const { locals, request } = event;
	// The handle path deliberately needs no session (sign-out cleanup), so it gets
	// the same per-caller rate limit the other unauthenticated-reachable room
	// endpoints carry — a handle probe is unguessable (256-bit) but not free.
	enforceRateLimit(event, 'matchmaking-leave', 30, 60_000);
	const body = (await request.json().catch(() => null)) as { searchId?: unknown } | null;
	const searchId = typeof body?.searchId === 'string' ? body.searchId : null;

	if (searchId) {
		const retired = await cancelSearch(searchId);
		return json({ ok: true, retired });
	}

	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in to play ranked.');
	}
	await leaveQueue(user.id);
	return json({ ok: true });
};
