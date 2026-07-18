import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadRoomView } from '$lib/play/server/service';
import { withAffordances } from '$lib/server/roomAffordances';

// Lightweight "fetch my current room view" endpoint. The realtime broadcast
// (DB trigger → `realtime.send`) only tells a client that the room's revision
// changed; the client then GETs this to pull its own owner-gated projection.
// It is also the client's safety-poll + reconnect target, and — because
// loadRoomView runs the opportunistic deadline-enforcement / room-close hooks —
// it is what keeps the host-independent server-authority cadence alive.
export const GET: RequestHandler = async ({ params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// The validated account (session cookie same-origin; Bearer for the cookieless
	// native shell) is the ONLY identity channel — no member cookies, headers or
	// query params. Membership, role, seat and private fields are re-derived from it
	// on every call, so an account switch or sign-out changes the answer immediately.
	// Private rooms 404 for non-members inside loadRoomView.
	const { user } = await locals.safeGetSession();
	const view = await withAffordances(
		roomCode,
		await loadRoomView(roomCode, { userId: user?.id ?? null })
	);
	return json(view, {
		// Always revalidate — this is live game state.
		headers: { 'Cache-Control': 'no-store' }
	});
};
