import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { joinRoom, loadRoomView } from '$lib/play/server/service';
import { clearLegacyRoomCredentialCookies, setLastRoomCookie } from '$lib/play/server/cookies';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const POST: RequestHandler = async (event) => {
	const { request, params, cookies, locals } = event;
	// Cap per IP to stop room-enumeration / membership-spam.
	enforceRateLimit(event, 'room-join', 30, 60_000);
	const body = await request.json().catch(() => ({}));
	const displayName = typeof body?.displayName === 'string' ? body.displayName : '';
	const roomCode = String(params.roomCode ?? '');

	// Wire admission: validated identity required; membership is idempotent per
	// (room, user) — a repeat or concurrent join converges on the same member row.
	// Private (ranked / matchmade / rematch) rooms never admit outsiders here.
	const { user } = await locals.safeGetSession();
	// Client-minted ENTRY-OP id (abort compensation): stamped on the membership
	// ONLY if this join CREATES it — an abandoned op then removes exactly that
	// membership and can never touch a pre-existing one.
	const originOp = typeof body?.opId === 'string' ? body.opId : null;
	const joined = await joinRoom(roomCode, displayName, user?.id ?? null, { originOp });
	clearLegacyRoomCredentialCookies(cookies);
	setLastRoomCookie(cookies, roomCode, event.url);

	const view = await loadRoomView(roomCode, { trustedMemberId: joined.memberId });
	return json(view);
};
