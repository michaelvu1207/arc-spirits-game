/**
 * Dev-only room seeding for the smoke test. Reproduces (minimally) the intent of
 * src/routes/api/play/debug/+server.ts — which is SvelteKit-bound and can't be imported
 * here — by driving the real engine to an ACTIVE game, then persisting a session +
 * host-member row directly through the room server's own Supabase client.
 *
 * GATED: only reachable when ARC_WS_ALLOW_DEBUG_SEED=1. Never expose in production.
 */

import { createLobbyState, applyGameCommand } from '../src/lib/play/runtime';
import { legalActions } from '../src/lib/play/ml/actions';
import { SEAT_COLORS } from '../src/lib/play/types';
import type { GameActor, GameCommand, PublicGameState, SeatColor } from '../src/lib/play/types';
import { randomUUID } from 'node:crypto';
import { getPlayAdmin, PLAY_TABLES, getSessionByRoomCode, getMemberById } from './supabase';
import { loadCatalog } from './catalog';
import { createWsTicket } from '../src/lib/play/server/wsTickets';

function randomRoomCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
	return code;
}

export interface SeededRoom {
	roomCode: string;
	/** PUBLIC member id (seat labeling; non-authorizing). */
	memberId: string;
	/** The seeded member's account id (the durable principal for this membership). */
	userId: string;
	/** A ONE-USE join ticket for the seeded member (the smoke's first join; later
	 *  joins mint fresh ones via /debug/ticket). */
	ticket: string;
	seat: SeatColor;
	/** A pre-validated legal command for the seated member, for the smoke to submit. */
	sampleCommand: GameCommand;
}

/**
 * Mint a fresh ONE-USE join ticket for an already-seeded member (reconnects,
 * second instances, restart scenarios). Dev/test only — gated by
 * ARC_WS_ALLOW_DEBUG_SEED at the HTTP layer; production tickets come exclusively
 * from the authenticated SvelteKit endpoint.
 */
export async function mintDebugTicket(params: {
	memberId?: string;
	roomCode?: string;
}): Promise<{ ticket: string; expiresAt: string }> {
	if (!params.memberId) throw new Error('memberId is required.');
	const member = await getMemberById(params.memberId);
	if (!member) throw new Error('member not found.');
	if (params.roomCode) {
		const session = await getSessionByRoomCode(params.roomCode);
		if (!session || session.id !== member.session_id) throw new Error('member/room mismatch.');
	}
	if (!member.user_id) throw new Error('member has no owning account.');
	return createWsTicket(getPlayAdmin(), {
		sessionId: member.session_id,
		userId: member.user_id,
		memberId: member.id,
		role: 'member'
	});
}

/** Dev/test spectator ticket for a room (the smoke's spectator connections). */
export async function mintDebugSpectatorTicket(
	roomCode: string
): Promise<{ ticket: string; expiresAt: string }> {
	const session = await getSessionByRoomCode(roomCode);
	if (!session) throw new Error('room not found.');
	return createWsTicket(getPlayAdmin(), {
		sessionId: session.id,
		userId: randomUUID(),
		memberId: null,
		role: 'spectator'
	});
}

/**
 * Seed a solo, already-started game with a distinguishable owner-private field, so the
 * smoke can prove per-connection view filtering + a legal command round-trip.
 */
export async function seedDebugRoom(displayName = 'Smoke Host'): Promise<SeededRoom> {
	const catalog = await loadCatalog();
	const guardianNames = catalog.guardians.map((g) => g.name);
	if (guardianNames.length === 0) throw new Error('Catalog has no guardians to seed a game.');

	const roomCode = randomRoomCode();
	const seat: SeatColor = SEAT_COLORS[0];
	const admin = getPlayAdmin();

	// 1) Insert a fresh lobby session + a host member.
	const lobby = createLobbyState({ roomCode, guardianNames });
	const sessionInsert = await admin
		.from(PLAY_TABLES.SESSIONS)
		.insert({
			room_code: roomCode,
			status: lobby.status,
			revision: lobby.revision,
			scenario: lobby.scenario,
			public_state: lobby,
			mode: 'casual'
		})
		.select('id')
		.single();
	if (sessionInsert.error) throw new Error(`seed: session insert failed: ${sessionInsert.error.message}`);
	const sessionId = (sessionInsert.data as { id: string }).id;

	const userId = randomUUID();
	const memberInsert = await admin
		.from(PLAY_TABLES.MEMBERS)
		.insert({
			session_id: sessionId,
			display_name: displayName,
			role: 'host',
			private_state: {},
			user_id: userId
		})
		.select('id')
		.single();
	if (memberInsert.error) throw new Error(`seed: member insert failed: ${memberInsert.error.message}`);
	const memberId = (memberInsert.data as { id: string }).id;

	// 2) Drive lobby → active through the real reducer.
	let state: PublicGameState = createLobbyState({ roomCode, guardianNames });
	const host: GameActor = { memberId, displayName, role: 'host', seatColor: null };
	for (const command of [
		{ type: 'claimSeat', seatColor: seat },
		{ type: 'selectGuardian', guardianName: guardianNames[0] },
		{ type: 'startGame' }
	] as GameCommand[]) {
		const result = applyGameCommand(state, host, command, catalog);
		if (!result.ok) throw new Error(`seed: ${command.type} failed: ${result.error.message}`);
		state = result.state;
	}

	// 3) Stamp a distinguishable owner-only field so spectator vs owner projections differ.
	//    lastAction is blanked for non-owners in buildSessionProjection; the exact shape is
	//    irrelevant to the projection (it is passed through verbatim), so a controlled cast
	//    keeps the seed free of engine-internal action typing.
	const player = state.players[seat];
	if (player) {
		(player as { lastAction: unknown }).lastAction = { kind: 'smoke-sentinel' };
	}

	// 4) Persist the active state.
	const persist = await admin
		.from(PLAY_TABLES.SESSIONS)
		.update({
			status: state.status,
			revision: state.revision,
			game_id: state.gameId,
			scenario: state.scenario,
			public_state: state,
			started_at: new Date().toISOString()
		})
		.eq('id', sessionId);
	if (persist.error) throw new Error(`seed: persist failed: ${persist.error.message}`);

	// 5) A pre-validated legal command for the seat (phase-agnostic — whatever is legal now).
	const legal = legalActions(state, seat, catalog);
	if (legal.length === 0) throw new Error('seed: no legal command available for the seated player.');

	const { ticket } = await createWsTicket(admin, {
		sessionId,
		userId,
		memberId,
		role: 'member'
	});
	return { roomCode, memberId, userId, ticket, seat, sampleCommand: legal[0] };
}

export interface SeededBotRoom {
	roomCode: string;
	/** The one human (host) seat's PUBLIC member id (labeling only). */
	humanMemberId: string;
	/** ONE-USE join ticket for the human seat. */
	humanTicket: string;
	humanSeat: SeatColor;
	botSeats: SeatColor[];
}

/**
 * Seed a STARTED game with one human (host) seat + `botCount` bot seats (is_bot=true,
 * bot_profile=neural), parked in navigation. Drives the whole lobby→active transition
 * through the real reducer, then persists the session + member rows. Used by the M0e smoke
 * to prove bots act in-process (with bots) and deadline enforcement fires (with 0 bots +
 * a short nav timer). `navMs` sets the navigation deadline.
 */
export async function seedBotRoom(opts: {
	botCount: number;
	navMs?: number;
}): Promise<SeededBotRoom> {
	const catalog = await loadCatalog();
	const guardianNames = catalog.guardians.map((g) => g.name);
	const seatCount = 1 + opts.botCount;
	if (seatCount > SEAT_COLORS.length) throw new Error('seed: too many seats.');
	const seats = SEAT_COLORS.slice(0, seatCount);
	const roomCode = randomRoomCode();
	const admin = getPlayAdmin();

	// 1) Session + member rows: seat 0 is the human host; the rest are bots.
	const lobby = createLobbyState({ roomCode, guardianNames });
	const sessionInsert = await admin
		.from(PLAY_TABLES.SESSIONS)
		.insert({
			room_code: roomCode,
			status: lobby.status,
			revision: lobby.revision,
			scenario: lobby.scenario,
			public_state: lobby,
			mode: 'casual'
		})
		.select('id')
		.single();
	if (sessionInsert.error) throw new Error(`seedBot: session insert: ${sessionInsert.error.message}`);
	const sessionId = (sessionInsert.data as { id: string }).id;

	const memberIds: string[] = [];
	const humanUserId = randomUUID();
	for (let i = 0; i < seatCount; i += 1) {
		const isBot = i > 0;
		const insert = await admin
			.from(PLAY_TABLES.MEMBERS)
			.insert({
				session_id: sessionId,
				display_name: isBot ? 'Nameless Spirit' : 'Smoke Host',
				role: i === 0 ? 'host' : 'spectator',
				private_state: {},
				is_bot: isBot,
				bot_profile: isBot ? 'neural' : null,
				user_id: isBot ? null : humanUserId
			})
			.select('id')
			.single();
		if (insert.error) throw new Error(`seedBot: member insert: ${insert.error.message}`);
		memberIds.push((insert.data as { id: string }).id);
	}

	// 2) Drive lobby → active through the real reducer (each seat claims + picks a guardian).
	let state: PublicGameState = createLobbyState({ roomCode, guardianNames });
	for (let i = 0; i < seatCount; i += 1) {
		const actor: GameActor = {
			memberId: memberIds[i],
			displayName: i === 0 ? 'Smoke Host' : 'Nameless Spirit',
			role: i === 0 ? 'host' : 'player',
			seatColor: null
		};
		for (const command of [
			{ type: 'claimSeat', seatColor: seats[i] },
			{ type: 'selectGuardian', guardianName: guardianNames[i] }
		] as GameCommand[]) {
			const r = applyGameCommand(state, actor, command, catalog);
			if (!r.ok) throw new Error(`seedBot: ${command.type} seat ${seats[i]}: ${r.error.message}`);
			state = r.state;
		}
	}
	state.navigationDurationMs = opts.navMs ?? 2000;
	{
		const hostActor: GameActor = {
			memberId: memberIds[0],
			displayName: 'Smoke Host',
			role: 'host',
			seatColor: null
		};
		const r = applyGameCommand(state, hostActor, { type: 'startGame' }, catalog);
		if (!r.ok) throw new Error(`seedBot: startGame: ${r.error.message}`);
		state = r.state;
	}
	// Stamp a navigation deadline so the deadline-enforcement path has something to fire on.
	if (state.phase === 'navigation' && state.navigationDurationMs != null) {
		state.phaseDeadline = Date.now() + state.navigationDurationMs;
	}

	// 3) Persist the active state.
	const persist = await admin
		.from(PLAY_TABLES.SESSIONS)
		.update({
			status: state.status,
			revision: state.revision,
			game_id: state.gameId,
			scenario: state.scenario,
			public_state: state,
			started_at: new Date().toISOString()
		})
		.eq('id', sessionId);
	if (persist.error) throw new Error(`seedBot: persist: ${persist.error.message}`);

	const { ticket: humanTicket } = await createWsTicket(admin, {
		sessionId,
		userId: humanUserId,
		memberId: memberIds[0],
		role: 'member'
	});
	return {
		roomCode,
		humanMemberId: memberIds[0],
		humanTicket,
		humanSeat: seats[0],
		botSeats: seats.slice(1)
	};
}
