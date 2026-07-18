import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setPresence } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'presence-write', 45, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to publish presence.');
	const body = await event.request.json().catch(() => ({}));
	return json(await setPresence(user.id, {
		state: typeof body.state === 'string' ? body.state : undefined,
		visibility: typeof body.visibility === 'string' ? body.visibility : undefined,
		roomCode: typeof body.roomCode === 'string' ? body.roomCode : null,
		clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
		platform: typeof body.platform === 'string' ? body.platform : undefined
	}), { headers: { 'cache-control': 'no-store' } });
};
