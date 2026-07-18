import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureParty, leaveParty } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

async function uid(event: Parameters<RequestHandler>[0]) {
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to manage a party.');
	return user.id;
}

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'party-create', 12, 60_000);
	const body = await event.request.json().catch(() => ({}));
	return json(body.action === 'leave'
		? await leaveParty(await uid(event))
		: { party: await ensureParty(await uid(event)) }, { headers: { 'cache-control': 'no-store' } });
};

export const DELETE: RequestHandler = async (event) => {
	enforceRateLimit(event, 'party-leave', 12, 60_000);
	return json(await leaveParty(await uid(event)), { headers: { 'cache-control': 'no-store' } });
};
