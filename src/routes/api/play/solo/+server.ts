import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearLegacyRoomCredentialCookies, setLastRoomCookie } from '$lib/play/server/cookies';
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
	// Solo is casual by definition; the validated (possibly anonymous) account owns
	// the membership — createRoom rejects unauthenticated callers.
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in (a guest identity is created automatically) to start solo play.');
	}

	// Table size: 'solo' fills to a 4-seat table (1 human + 3 bots); 'heads-up' is a
	// 2-seat duel (1 human + 1 bot), where a single champion bot plays undiluted by
	// mirror competition. Allow-listed — never trust a raw seat count from the client.
	const mode = body?.mode === 'heads-up' ? 'heads-up' : 'solo';
	const targetSeats = mode === 'heads-up' ? 2 : 4;

	// Client-minted ENTRY-OP id (abort compensation): the created solo session is
	// stamped with it, so an abort at ANY later point of this multi-step setup —
	// even with no response delivered — resolves and unwinds exactly this room.
	const originOp = typeof body?.opId === 'string' ? body.opId : null;
	const created = await createRoom(displayName, user.id, 'casual', { originOp });
	clearLegacyRoomCredentialCookies(cookies);
	setLastRoomCookie(cookies, created.roomCode, event.url);

	const seat = SEAT_COLORS[0];
	await runRoomCommand({
		roomCode: created.roomCode,
		trustedMemberId: created.memberId,
		expectedRevision: null,
		command: { type: 'claimSeat', seatColor: seat }
	});

	const state = await loadRawRoomState(created.roomCode);
	const guardian = pickRandom(state.guardianPool);
	if (guardian) {
		await runRoomCommand({
			roomCode: created.roomCode,
			trustedMemberId: created.memberId,
			expectedRevision: null,
			command: { type: 'selectGuardian', guardianName: guardian }
		});
	}

	await fillBots(created.roomCode, created.memberId, {
		targetSeats,
		shuffleGuardians: true
	});

	await runRoomCommand({
		roomCode: created.roomCode,
		trustedMemberId: created.memberId,
		expectedRevision: null,
		command: { type: 'startGame' }
	});

	const view = await loadRoomView(created.roomCode, { trustedMemberId: created.memberId });
	return json(view);
};
