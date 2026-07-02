import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setRoomMemberCookie } from '$lib/play/server/cookies';
import { fillBots } from '$lib/play/server/botSim';
import {
	createRoom,
	loadRawRoomState,
	loadRoomView,
	runRoomCommand
} from '$lib/play/server/service';
import { SEAT_COLORS } from '$lib/play/types';
import { enforceRateLimit } from '$lib/server/rateLimit';

function pickRandom<T>(items: T[]): T | null {
	if (items.length === 0) return null;
	return items[Math.floor(Math.random() * items.length)] ?? null;
}

export const POST: RequestHandler = async (event) => {
	const { request, cookies, locals } = event;
	enforceRateLimit(event, 'solo-play-create', 8, 60_000);

	const body = await request.json().catch(() => ({}));
	const displayName = typeof body?.displayName === 'string' ? body.displayName : '';
	const { user } = await locals.safeGetSession();

	const created = await createRoom(displayName, user?.id ?? null, 'casual');
	setRoomMemberCookie(cookies, created.roomCode, created.memberId);

	const seat = SEAT_COLORS[0];
	await runRoomCommand({
		roomCode: created.roomCode,
		memberId: created.memberId,
		expectedRevision: null,
		command: { type: 'claimSeat', seatColor: seat }
	});

	const state = await loadRawRoomState(created.roomCode);
	const guardian = pickRandom(state.guardianPool);
	if (guardian) {
		await runRoomCommand({
			roomCode: created.roomCode,
			memberId: created.memberId,
			expectedRevision: null,
			command: { type: 'selectGuardian', guardianName: guardian }
		});
	}

	await fillBots(created.roomCode, created.memberId, {
		targetSeats: 4,
		shuffleGuardians: true
	});

	await runRoomCommand({
		roomCode: created.roomCode,
		memberId: created.memberId,
		expectedRevision: null,
		command: { type: 'startGame' }
	});

	return json(await loadRoomView(created.roomCode, created.memberId));
};
