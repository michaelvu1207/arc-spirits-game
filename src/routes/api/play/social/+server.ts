import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { socialSnapshot } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-read', 90, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to use live social features.');
	return json(await socialSnapshot(user.id), { headers: { 'cache-control': 'no-store' } });
};
