import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createReplayShare } from '$lib/play/server/replaySharing';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'replay-share-create', 10, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to share a replay.');
	const body = await event.request.json().catch(() => ({}));
	const gameId = typeof body?.gameId === 'string' ? body.gameId : '';
	const title = typeof body?.title === 'string' ? body.title : undefined;
	return json(await createReplayShare(user.id, gameId, title), { headers: { 'cache-control': 'no-store' } });
};
