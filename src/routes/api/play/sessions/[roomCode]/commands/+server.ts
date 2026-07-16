import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { runRoomCommand } from '$lib/play/server/service';
import { withAffordances } from '$lib/server/roomAffordances';
import { isValidCmdId, validateCommandShape } from '$lib/play/server/commandPolicy';
import type { GameCommand } from '$lib/play/types';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	// The validated account is the sole wire principal; the deny-by-default command
	// admission policy (shared with the WebSocket boundary) runs inside
	// runRoomCommand before the reducer. No wire field confers internal trust.
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Join this room before sending commands.');
	}

	const body = await request.json().catch(() => ({}));
	const expectedRevision =
		typeof body?.expectedRevision === 'number' ? body.expectedRevision : null;
	const command = (body?.command ?? null) as GameCommand | null;

	// The SAME bounded cmdId + payload schema as the WebSocket boundary.
	if (!validateCommandShape(command)) {
		throw error(400, 'Missing or malformed command.');
	}
	if (!isValidCmdId(body?.cmdId)) {
		throw error(400, 'Missing cmdId — every command must carry a client idempotency key.');
	}
	const cmdId = body.cmdId as string;

	// God-mode grants are a dev-only tool — never resolvable in production.
	if (command.type === 'debugGrant' && !dev) {
		throw error(404, 'Not found.');
	}

	const view = await runRoomCommand({
		roomCode,
		userId: user.id,
		expectedRevision,
		command,
		cmdId
	});
	// Post-command affordances ride along so the client's action surface never
	// goes stale between polls (mirrors the WS ack, which is a full RoomView v2).
	return json(await withAffordances(roomCode, view));
};
