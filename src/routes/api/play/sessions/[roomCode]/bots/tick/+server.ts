import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadRoomView, authenticateRoomMember } from '$lib/play/server/service';
import { tickBots } from '$lib/play/server/botSim';

export const POST: RequestHandler = async ({ params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// Resolve the validated account to the trusted internal member id at the edge —
	// botSim helpers only ever receive server-verified identities.
	const { user } = await locals.safeGetSession();
	const caller = await authenticateRoomMember(roomCode, user?.id ?? null);
	if (!caller) {
		throw error(401, 'Join this room before ticking bots.');
	}

	// Host-only: resolve the caller's role authoritatively before driving bots.
	const view = await loadRoomView(roomCode, { trustedMemberId: caller.memberId });
	if (view.member.role !== 'host') {
		throw error(403, 'Only the host can drive the bots.');
	}

	const { view: nextView, commandsIssued } = await tickBots(roomCode, caller.memberId);
	return json({ ...nextView, commandsIssued });
};
