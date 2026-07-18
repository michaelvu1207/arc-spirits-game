import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rankedLeaderboard } from '$lib/play/server/rankedSeasons';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ranked-leaderboard', 90, 60_000);
	const limit = Number(event.url.searchParams.get('limit') ?? 50);
	return json(await rankedLeaderboard(limit), { headers: { 'cache-control': 'public, max-age=20' } });
};
