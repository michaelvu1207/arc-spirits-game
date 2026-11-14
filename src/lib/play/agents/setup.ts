/** Deterministic lobby setup shared by the runner and replay. */

import { createRng, nextInt } from '../rng';
import { applyGameCommand, createLobbyState } from '../runtime';
import {
	SEAT_COLORS,
	type GameActor,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';

export const AGENT_HOST: GameActor = {
	memberId: 'agent-host',
	displayName: 'host',
	role: 'host',
	seatColor: null
};

export function agentMemberId(seat: SeatColor): string {
	return `agent-${seat}`;
}

/** Seat colors for `count` players, in the engine's seat order. */
export function seatsFor(count: number): SeatColor[] {
	if (count < 2 || count > 4) throw new Error('the harness plays 2-4 seats');
	return SEAT_COLORS.slice(0, count) as SeatColor[];
}

/** Distinct guardians drawn from the catalog with the game seed (recorded in the header). */
export function pickGuardians(catalog: PlayCatalog, seed: number, count: number): string[] {
	const pool = catalog.guardians.map((g) => g.name);
	if (pool.length < count) throw new Error(`catalog has only ${pool.length} guardians`);
	const rng = createRng((seed ^ 0x5eed) >>> 0);
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(pool.splice(nextInt(rng, pool.length), 1)[0]);
	return out;
}

function expectOk(result: ReturnType<typeof applyGameCommand>, label: string): PublicGameState {
	if (!result.ok) throw new Error(`${label}: ${result.error.code} ${result.error.message}`);
	return result.state;
}

/** Lobby → seats claimed → guardians chosen → game started with `seed`. */
export function createAgentLobby(
	catalog: PlayCatalog,
	seed: number,
	seats: { seat: SeatColor; guardian: string }[]
): PublicGameState {
	let state = createLobbyState({
		roomCode: 'AGENTS',
		guardianNames: catalog.guardians.map((g) => g.name)
	});
	for (const { seat, guardian } of seats) {
		const memberId = agentMemberId(seat);
		state = expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			),
			`claimSeat ${seat}`
		);
		state = expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardian },
				catalog
			),
			`selectGuardian ${seat}`
		);
	}
	state = expectOk(
		applyGameCommand(state, AGENT_HOST, { type: 'startGame', seed }, catalog),
		'startGame'
	);
	// The engine's game id embeds the wall-clock start time (runtime.ts makeGameId). It is only an
	// identifier, but it is part of the state hash, so drop the time to make replays reproducible.
	if (state.gameId) state.gameId = state.gameId.replace(/^game_\d{8}_\d{6}_/, 'game_agent_');
	return state;
}
