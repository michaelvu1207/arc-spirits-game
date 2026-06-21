import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { leaveQueue } from '$lib/play/server/matchmaking';

/**
 * Leave the ranked matchmaking queue (cancel search). Auth REQUIRED. Only cancels a
 * still-searching row — a row that was already matched is left alone so the hand-off
 * to the created game isn't clobbered.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in to play ranked.');
	}

	await leaveQueue(user.id);
	return json({ ok: true });
};
