import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateRoomMember } from '$lib/play/server/service';
import { setBotGuardian } from '$lib/play/server/botSim';
import type { SeatColor } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// Resolve the validated account to the trusted internal member id at the edge —
	// botSim helpers only ever receive server-verified identities.
	const { user } = await locals.safeGetSession();
	const caller = await authenticateRoomMember(roomCode, user?.id ?? null);
	if (!caller) {
		throw error(401, 'Join this room first.');
	}

	const body = await request.json().catch(() => ({}));
	const seat = String(body?.seat ?? '') as SeatColor;
	const guardianName = String(body?.guardianName ?? '');
	if (!seat || !guardianName) {
		throw error(400, 'seat and guardianName are required.');
	}

	return json(await setBotGuardian(roomCode, caller.memberId, seat, guardianName));
};
