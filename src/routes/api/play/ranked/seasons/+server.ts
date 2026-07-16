import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rankedArchive } from '$lib/play/server/rankedSeasons';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ranked-archive', 30, 60_000);
	return json(await rankedArchive(8), { headers: { 'cache-control': 'public, max-age=60' } });
};
