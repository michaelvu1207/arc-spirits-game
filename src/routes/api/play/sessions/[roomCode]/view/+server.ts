import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberCookie } from '$lib/play/server/cookies';
import { loadRoomView } from '$lib/play/server/service';

// Lightweight "fetch my current room view" endpoint. The realtime broadcast
// (DB trigger → `realtime.send`) only tells a client that the room's revision
// changed; the client then GETs this to pull its own owner-gated projection.
// It is also the client's safety-poll + reconnect target, and — because
// loadRoomView runs the opportunistic deadline-enforcement / room-close hooks —
// it is what keeps the host-independent server-authority cadence alive now that
// the per-second SSE poll is gone.
export const GET: RequestHandler = async ({ params, cookies, url, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// Cookie authenticates the web client; the cookieless Capacitor shell passes
	// the member id as a query param (matches the events/commands routes).
	const memberId = getRoomMemberCookie(cookies, roomCode) ?? url.searchParams.get('member');
	// A matchmade player may have no member cookie/id — fall back to their auth user_id
	// so the server recognizes them as their own session member.
	const { user } = await locals.safeGetSession();
	const view = await loadRoomView(roomCode, memberId, user?.id ?? null);
	return json(view, {
		// Always revalidate — this is live game state.
		headers: { 'Cache-Control': 'no-store' }
	});
};
