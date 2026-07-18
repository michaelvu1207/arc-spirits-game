import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rankedSnapshot } from '$lib/play/server/rankedSeasons';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ranked-snapshot', 90, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to view ranked progress.');
	return json(await rankedSnapshot(user.id), { headers: { 'cache-control': 'no-store' } });
};
