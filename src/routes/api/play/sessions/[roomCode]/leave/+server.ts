import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { leaveRoomAsUser } from '$lib/play/server/service';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Leave a room as the validated account. The compensation path for an ABANDONED
 * room entry: a client whose create/solo/join round-trip was cancelled (unmount
 * won the race) after the server-side effect landed calls this so no orphan
 * room/membership lingers. Idempotent; safe for rooms the caller never entered.
 * Semantics (see leaveRoomAsUser): a lobby membership is removed (last human out
 * closes the lobby); an active game only closes when the caller is its sole
 * human — a started seat never becomes an unauthorized ghost.
 */
export const POST: RequestHandler = async (event) => {
	const { params, locals } = event;
	enforceRateLimit(event, 'room-leave', 30, 60_000);
	const roomCode = String(params.roomCode ?? '');

	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in (a guest identity is created automatically) to leave a room.');
	}

	return json(await leaveRoomAsUser(roomCode, user.id));
};
