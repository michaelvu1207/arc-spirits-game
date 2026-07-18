import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mintRoomWsTicket } from '$lib/play/server/service';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Mint a short-lived, ONE-USE, room-scoped WebSocket join ticket for the validated
 * caller (see wsTickets.ts for the full contract). This is the ONLY place the raw
 * ticket value ever appears: an authenticated, `no-store` response, handed straight
 * into the WS join frame. Only a digest is stored server-side; the ticket is bound
 * to exactly this room, this user, this membership and its permission level, is
 * consumed atomically on first use, and expires in seconds. Reconnects mint a
 * fresh one. Members get 'member' tickets; authenticated viewers of PUBLIC rooms
 * get 'spectator' tickets (which cannot command); private rooms answer 404 to
 * non-members.
 */
export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'ws-ticket', 30, 60_000);
	const roomCode = String(event.params.roomCode ?? '');
	const { user } = await event.locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in (a guest identity is created automatically) first.');
	}
	const minted = await mintRoomWsTicket(roomCode, user.id);
	return json(minted, { headers: { 'Cache-Control': 'no-store' } });
};
