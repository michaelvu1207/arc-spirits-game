import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { blockPlayer } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-block', 20, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to manage blocks.');
	const body = await event.request.json().catch(() => ({}));
	return json(await blockPlayer(user.id, String(body.userId ?? '')), {
		headers: { 'cache-control': 'no-store' }
	});
};
