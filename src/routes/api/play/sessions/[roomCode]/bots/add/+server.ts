import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberCookie } from '$lib/play/server/cookies';
import { addBot } from '$lib/play/server/botSim';
import { BOT_PROFILES } from '$lib/play/server/botPolicy';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, cookies }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberCookie(cookies, roomCode);
	if (!memberId) {
		throw error(401, 'Join this room before adding bots.');
	}

	const body = await request.json().catch(() => ({}));
	const seat = typeof body?.seat === 'string' ? (body.seat as SeatColor) : undefined;
	const guardianName = typeof body?.guardianName === 'string' ? body.guardianName : undefined;
	// Only honor a known strategy key; anything else falls back to the designed baseline 'medium'
	// (the legacy random-legal bot is no longer an offered option).
	const difficulty =
		typeof body?.difficulty === 'string' && body.difficulty in BOT_PROFILES
			? body.difficulty
			: 'medium';

	try {
		return json(await addBot(roomCode, memberId, { seat, guardianName, difficulty }));
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to add bot.';
		// Ranked games reject bots — surface as a clean 400.
		if (message.includes('Bots are not allowed in ranked games')) throw error(400, message);
		throw err;
	}
};
