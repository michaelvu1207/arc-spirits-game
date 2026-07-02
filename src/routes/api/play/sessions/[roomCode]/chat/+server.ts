import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRoomMemberId } from '$lib/play/server/cookies';
import { createRoomChatMessage, listRoomChatMessages } from '$lib/play/server/service';
import { enforceRateLimit } from '$lib/server/rateLimit';

function parseLimit(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

export const GET: RequestHandler = async ({ request, params, cookies, url, locals }) => {
	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request) ?? url.searchParams.get('member');
	const { user } = await locals.safeGetSession();
	const messages = await listRoomChatMessages({
		roomCode,
		memberId,
		fallbackUserId: user?.id ?? null,
		after: url.searchParams.get('after'),
		limit: parseLimit(url.searchParams.get('limit'))
	});
	return json(
		{ messages },
		{
			headers: { 'Cache-Control': 'no-store' }
		}
	);
};

export const POST: RequestHandler = async (event) => {
	const { request, params, cookies, locals } = event;
	enforceRateLimit(event, 'room-chat', 20, 60_000);

	const roomCode = String(params.roomCode ?? '');
	const memberId = getRoomMemberId(cookies, roomCode, request);
	const { user } = await locals.safeGetSession();
	if (!memberId && !user) {
		throw error(401, 'Join this room before sending chat messages.');
	}

	const body = await request.json().catch(() => ({}));
	const message = await createRoomChatMessage({
		roomCode,
		memberId,
		fallbackUserId: user?.id ?? null,
		body: body?.body
	});
	return json({ message });
};
