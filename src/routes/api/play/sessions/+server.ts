import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRoom, listOpenRooms, loadRoomView } from '$lib/play/server/service';
import { clearLegacyRoomCredentialCookies, setLastRoomCookie } from '$lib/play/server/cookies';
import { enforceRateLimit } from '$lib/server/rateLimit';

// Public server browser: list every joinable lobby + spectatable live game.
// Central admission applies inside listOpenRooms — only PUBLIC casual rooms appear.
export const GET: RequestHandler = async () => {
	return json({ rooms: await listOpenRooms() });
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies, locals } = event;
	enforceRateLimit(event, 'room-create', 8, 60_000);
	const body = await request.json().catch(() => ({}));
	const displayName = typeof body?.displayName === 'string' ? body.displayName : '';
	const visibility = body?.visibility === 'private' ? 'private' : 'public';

	// The validated account (permanent, or the automatically-created anonymous guest
	// identity) is the sole durable principal — it owns the membership. There is no
	// credential echo and no room-credential cookie: authority is re-derived from the
	// validated session on every request, so sign-out drops it instantly and another
	// user can never inherit it.
	const { user } = await locals.safeGetSession();
	// Client-minted ENTRY-OP id (abort compensation): stamped on the created
	// session so an aborted request whose response never arrived can still be
	// resolved and unwound via POST /api/play/abandon-entry. Format-validated;
	// never authorization.
	const originOp = typeof body?.opId === 'string' ? body.opId : null;
	const created = await createRoom(displayName, user?.id ?? null, 'casual', { originOp, visibility });
	if (!created) throw error(500, 'Room creation failed.');
	clearLegacyRoomCredentialCookies(cookies);
	setLastRoomCookie(cookies, created.roomCode, event.url);

	const view = await loadRoomView(created.roomCode, { trustedMemberId: created.memberId });
	return json(view);
};
