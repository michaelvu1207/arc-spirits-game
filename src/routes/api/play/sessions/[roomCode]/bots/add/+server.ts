import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateRoomMember } from '$lib/play/server/service';
import { addBot } from '$lib/play/server/botSim';
import { normalizeBotProfileKey } from '$lib/play/bots/contract';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// Resolve the validated account to the trusted internal member id at the edge —
	// botSim helpers only ever receive server-verified identities.
	const { user } = await locals.safeGetSession();
	const caller = await authenticateRoomMember(roomCode, user?.id ?? null);
	if (!caller) {
		throw error(401, 'Join this room before adding bots.');
	}

	const body = await request.json().catch(() => ({}));
	const seat = typeof body?.seat === 'string' ? (body.seat as SeatColor) : undefined;
	const guardianName = typeof body?.guardianName === 'string' ? body.guardianName : undefined;
	const difficulty = normalizeBotProfileKey(body?.difficulty);

	try {
		return json(await addBot(roomCode, caller.memberId, { seat, guardianName, difficulty }));
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to add bot.';
		// Ranked games reject bots — surface as a clean 400.
		if (message.includes('Bots are not allowed in ranked games')) throw error(400, message);
		throw err;
	}
};
