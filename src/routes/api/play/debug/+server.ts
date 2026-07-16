import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { createDebugRoom, loadRoomView } from '$lib/play/server/service';
import { setLastRoomCookie } from '$lib/play/server/cookies';

// Dev-only: spawn a solo game parked in the Awakening phase with a face-down
// spirit of the requested class + everything needed to awaken it. Never exposed
// in production builds.
export const POST: RequestHandler = async (event) => {
	const { request, cookies, locals } = event;
	if (!dev) {
		return new Response('Not found', { status: 404 });
	}

	const body = await request.json().catch(() => ({}));
	const displayName = typeof body?.displayName === 'string' ? body.displayName : '';
	const className = typeof body?.className === 'string' ? body.className : '';
	const spiritId = typeof body?.spiritId === 'string' ? body.spiritId : undefined;
	if (!className && !spiritId) {
		return json({ message: 'A class name or spirit id is required.' }, { status: 400 });
	}

	// Even the dev tool follows the account trust model: the validated (anonymous)
	// user owns the seeded membership.
	const { user } = await locals.safeGetSession();
	const created = await createDebugRoom(displayName, className, spiritId, user?.id ?? null);
	setLastRoomCookie(cookies, created.roomCode, event.url);

	const view = await loadRoomView(created.roomCode, { trustedMemberId: created.memberId });
	return json(view);
};
