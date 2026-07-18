import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { purchaseCosmetic } from '$lib/play/server/progression';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'progression-purchase', 20, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to purchase cosmetics.');
	const body = await event.request.json().catch(() => ({}));
	const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
	if (!itemId || itemId.length > 80) throw error(400, 'A valid cosmetic item is required.');
	return json(await purchaseCosmetic(user.id, itemId), { headers: { 'cache-control': 'no-store' } });
};
