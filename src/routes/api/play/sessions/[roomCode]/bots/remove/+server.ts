import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { removeBot } from '$lib/play/server/botSim';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, cookies }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	if (!memberId) {
		throw error(401, 'Join this room first.');
	}

	const body = await request.json().catch(() => ({}));
	const seat = String(body?.seat ?? '') as SeatColor;
	if (!seat) {
		throw error(400, 'seat is required.');
	}

	return json(await removeBot(roomCode, memberId, seat));
};
