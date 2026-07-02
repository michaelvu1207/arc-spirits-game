import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { runRoomCommand } from '$lib/play/server/service';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, cookies, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	// Matchmade players have no member cookie — fall back to their auth user_id.
	const { user } = await locals.safeGetSession();
	if (!memberId && !user) {
		throw error(401, 'Join this room before claiming a seat.');
	}

	const body = await request.json().catch(() => ({}));
	const seatColor = typeof body?.seatColor === 'string' ? (body.seatColor as SeatColor) : null;
	const expectedRevision =
		typeof body?.expectedRevision === 'number' ? body.expectedRevision : null;

	if (!seatColor) {
		throw error(400, 'Missing seat color.');
	}

	return json(
		await runRoomCommand({
			roomCode,
			memberId,
			expectedRevision,
			command: { type: 'claimSeat', seatColor },
			fallbackUserId: user?.id ?? null
		})
	);
};
