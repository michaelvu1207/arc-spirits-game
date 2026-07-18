import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadPostgameSummary } from '$lib/play/server/postgame';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Authoritative terminal-screen summary (placements, ranked rating movement once
 * finalized, rematch lobby status). For PUBLIC rooms this is public data — readable
 * by players and spectators alike, exactly like the finished board itself. PRIVATE
 * rooms (ranked / matchmade / rematch parties) answer 404 to non-members so the
 * postgame path cannot be used to discover them.
 */
export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'postgame-summary', 60, 60_000);
	const { user } = await event.locals.safeGetSession();
	return json(await loadPostgameSummary(String(event.params.roomCode ?? ''), user?.id ?? null));
};
