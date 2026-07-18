import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadProgression } from '$lib/play/server/progression';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'progression-read', 60, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to load progression.');
	return json(await loadProgression(user.id), { headers: { 'cache-control': 'no-store' } });
};
