import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { runRoomCommand } from '$lib/play/server/service';
import type { GameCommand } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, cookies, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	// A matchmade player has no member cookie — fall back to their auth user_id so
	// runRoomCommand can resolve their server-created membership by user.
	const { user } = await locals.safeGetSession();
	if (!memberId && !user) {
		throw error(401, 'Join this room before sending commands.');
	}

	const body = await request.json().catch(() => ({}));
	const expectedRevision =
		typeof body?.expectedRevision === 'number' ? body.expectedRevision : null;
	const command = (body?.command ?? null) as GameCommand | null;

	if (!command || typeof command.type !== 'string') {
		throw error(400, 'Missing command.');
	}

	// God-mode grants are a dev-only tool — never resolvable in production.
	if (command.type === 'debugGrant' && !dev) {
		throw error(404, 'Not found.');
	}

	return json(
		await runRoomCommand({
			roomCode,
			memberId,
			expectedRevision,
			command,
			fallbackUserId: user?.id ?? null
		})
	);
};
