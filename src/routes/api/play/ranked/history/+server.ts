import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rankedHistory } from '$lib/play/server/rankedSeasons';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ranked-history', 60, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to view ranked history.');
	return json(await rankedHistory(user.id), { headers: { 'cache-control': 'no-store' } });
};
