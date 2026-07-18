import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { concedeRanked } from '$lib/play/server/rankedSeasons';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ranked-concede', 4, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to concede a ranked seat.');
	return json(await concedeRanked(event.params.roomCode, user.id), { headers: { 'cache-control': 'no-store' } });
};
