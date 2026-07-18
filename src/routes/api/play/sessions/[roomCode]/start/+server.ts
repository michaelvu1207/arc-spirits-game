import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runRoomCommand } from '$lib/play/server/service';
import { isValidCmdId } from '$lib/play/server/commandPolicy';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// Validated account only — no member cookies/headers, no public-id auth.
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Join this room before starting the game.');
	}

	const body = await request.json().catch(() => ({}));
	const expectedRevision =
		typeof body?.expectedRevision === 'number' ? body.expectedRevision : null;
	// Same bounded cmdId schema as every command boundary.
	if (!isValidCmdId(body?.cmdId)) {
		throw error(400, 'Missing cmdId — every command must carry a client idempotency key.');
	}

	return json(
		await runRoomCommand({
			roomCode,
			userId: user.id,
			expectedRevision,
			command: { type: 'startGame' },
			cmdId: body.cmdId as string
		})
	);
};
