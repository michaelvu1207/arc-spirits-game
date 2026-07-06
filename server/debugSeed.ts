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
import { getPlayAdmin, PLAY_TABLES } from './supabase';
import { loadCatalog } from './catalog';

function randomRoomCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
	return code;
}

export interface SeededRoom {
	roomCode: string;
	memberId: string;
	seat: SeatColor;
	/** A pre-validated legal command for the seated member, for the smoke to submit. */
	sampleCommand: GameCommand;
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

	const memberInsert = await admin
		.from(PLAY_TABLES.MEMBERS)
		.insert({ session_id: sessionId, display_name: displayName, role: 'host', private_state: {} })
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

	return { roomCode, memberId, seat, sampleCommand: legal[0] };
}
