import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { fillBots } from '$lib/play/server/botSim';
import { normalizeBotProfileKey } from '$lib/play/bots/contract';

export const POST: RequestHandler = async ({ request, params, cookies }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	if (!memberId) {
		throw error(401, 'Join this room before adding bots.');
	}

	const body = await request.json().catch(() => ({}));
	const targetSeats = typeof body?.targetSeats === 'number' ? body.targetSeats : undefined;
	const difficulty = normalizeBotProfileKey(body?.difficulty);

	try {
		return json(await fillBots(roomCode, memberId, { targetSeats, difficulty }));
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to fill bots.';
		// Ranked games reject bots — surface as a clean 400.
		if (message.includes('Bots are not allowed in ranked games')) throw error(400, message);
		throw err;
	}
};
