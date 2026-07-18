import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setLastRoomCookie } from '$lib/play/server/cookies';
import { requestRematch } from '$lib/play/server/postgame';
import { loadRoomView } from '$lib/play/server/service';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Same-party rematch: the first ORIGINAL member of a finished room to call this
 * creates the rematch lobby (and hosts it); everyone else's call joins that same
 * lobby, idempotently per member. The caller authenticates with their validated
 * account — the same boundary as every other room mutation — and must own a
 * membership in the FINISHED room. The rematch lobby is PRIVATE: outsiders cannot
 * discover or enter it through browse, join, view, chat or postgame.
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies, locals } = event;
	enforceRateLimit(event, 'room-rematch', 20, 60_000);
	const roomCode = String(params.roomCode ?? '');

	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Join this room before requesting a rematch.');

	const rematch = await requestRematch(roomCode, user.id);
	setLastRoomCookie(cookies, rematch.roomCode, event.url);

	// `memberId` is the public seat label only — it never authorizes; the caller's
	// account owns the new membership and every later request re-proves it.
	return json({
		roomCode: rematch.roomCode,
		memberId: rematch.memberId,
		created: rematch.created,
		view: await loadRoomView(rematch.roomCode, { trustedMemberId: rematch.memberId })
	});
};
