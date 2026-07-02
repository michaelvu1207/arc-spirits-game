import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { runRoomCommand } from '$lib/play/server/service';

export const POST: RequestHandler = async ({ request, params, cookies, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	// Matchmade players have no member cookie — fall back to their auth user_id.
	const { user } = await locals.safeGetSession();
	if (!memberId && !user) {
		throw error(401, 'Join this room before starting the game.');
	}

	const body = await request.json().catch(() => ({}));
	const expectedRevision =
		typeof body?.expectedRevision === 'number' ? body.expectedRevision : null;

	return json(
		await runRoomCommand({
			roomCode,
			memberId,
			expectedRevision,
			command: { type: 'startGame' },
			fallbackUserId: user?.id ?? null
		})
	);
};
