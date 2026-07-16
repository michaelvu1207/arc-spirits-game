import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { equipCosmetic } from '$lib/play/server/progression';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'progression-equip', 30, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to equip cosmetics.');
	const body = await event.request.json().catch(() => ({}));
	const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
	const guardianName = typeof body?.guardianName === 'string' ? body.guardianName : null;
	if (!itemId || itemId.length > 80 || (guardianName?.length ?? 0) > 80) throw error(400, 'Invalid cosmetic loadout.');
	return json(await equipCosmetic(user.id, itemId, guardianName), { headers: { 'cache-control': 'no-store' } });
};
