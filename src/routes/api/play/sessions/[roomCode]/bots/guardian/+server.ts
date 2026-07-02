import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { setBotGuardian } from '$lib/play/server/botSim';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, cookies }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	if (!memberId) {
		throw error(401, 'Join this room first.');
	}

	const body = await request.json().catch(() => ({}));
	const seat = String(body?.seat ?? '') as SeatColor;
	const guardianName = String(body?.guardianName ?? '');
	if (!seat || !guardianName) {
		throw error(400, 'seat and guardianName are required.');
	}

	return json(await setBotGuardian(roomCode, memberId, seat, guardianName));
};
