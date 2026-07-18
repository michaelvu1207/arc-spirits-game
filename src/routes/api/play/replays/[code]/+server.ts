import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadSharedReplay, revokeReplayShare } from '$lib/play/server/replaySharing';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'replay-share-read', 90, 60_000);
	return json(await loadSharedReplay(String(event.params.code ?? '')), {
		headers: { 'cache-control': 'no-store' }
	});
};

export const DELETE: RequestHandler = async (event) => {
	enforceRateLimit(event, 'replay-share-revoke', 20, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) return json({ error: 'Sign in to manage this replay.' }, { status: 401 });
	return json(await revokeReplayShare(user.id, String(event.params.code ?? '')), {
		headers: { 'cache-control': 'no-store' }
	});
};
