import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createPartyRoom, loadPartyRoom } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

async function uid(event: Parameters<RequestHandler>[0]) {
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to use a party room.');
	return user.id;
}

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'party-room-read', 60, 60_000);
	return json(await loadPartyRoom(await uid(event)), { headers: { 'cache-control': 'no-store' } });
};

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'party-room-create', 8, 60_000);
	return json(await createPartyRoom(await uid(event)), { headers: { 'cache-control': 'no-store' } });
};
