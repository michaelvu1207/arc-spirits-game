import { beforeEach, describe, expect, test, vi } from 'vitest';
import { loadFrozenCatalog } from '../agents/catalog';
import { agentMemberId, createAgentLobby, pickGuardians, seatsFor } from '../agents/setup';
import { applyGameCommand } from '../runtime';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';

const catalog: PlayCatalog = loadFrozenCatalog();

const mocks = vi.hoisted(() => {
	class StaleRevisionError extends Error {
		readonly status = 409;
		constructor(readonly revision: number) {
			super(`stale ${revision}`);
		}
	}
	return {
		StaleRevisionError,
		listActiveAiRooms: vi.fn(),
		loadAiRoom: vi.fn(),
		lastCommitAt: vi.fn(),
		runRoomCommand: vi.fn()
	};
});

vi.mock('./service', () => ({
	StaleRevisionError: mocks.StaleRevisionError,
	listActiveAiRooms: mocks.listActiveAiRooms,
	loadAiRoom: mocks.loadAiRoom,
	lastCommitAt: mocks.lastCommitAt,
	runRoomCommand: mocks.runRoomCommand
}));
vi.mock('./catalog', () => ({ loadPlayCatalog: async () => catalog }));

import { actForAiSeat, aiSeatsThatMustAct, buildAiDecision, listPendingAiDecisions } from './aiSeats';

const SESSION = 'session-1';
const ROOM = 'AIROOM';
const NOW = 1_800_000_000_000;

/** A real two-seat game at its first decisions; Red (also an AI seat) has played until it
 *  need not act, Blue still has to choose. */
function gameState(): PublicGameState {
	const seats = seatsFor(2);
	const guardians = pickGuardians(catalog, 7, seats.length);
	let state = createAgentLobby(
		catalog,
		7,
		seats.map((seat, i) => ({ seat, guardian: guardians[i] }))
	);
	const [red, blue] = seats;
	for (let i = 0; i < 40 && aiSeatsThatMustAct(state, [red]).length > 0; i++) {
		const action = buildAiDecision(state, red, catalog, ROOM).built.request.actions[0];
		const result = applyGameCommand(
			state,
			{ memberId: agentMemberId(red), displayName: red, role: 'player', seatColor: red },
			action.command,
			catalog
		);
		if (!result.ok) throw new Error(result.error.message);
		state = result.state;
	}
	if (aiSeatsThatMustAct(state, [red]).length > 0) throw new Error('red never finished');
	if (aiSeatsThatMustAct(state, [blue]).length === 0) throw new Error('blue has nothing to do');
	return state;
}

let state: PublicGameState;
let seats: SeatColor[];

function room() {
	return {
		sessionId: SESSION,
		roomCode: ROOM,
		revision: state.revision,
		state,
		aiSeats: new Map(seats.map((seat) => [seat, agentMemberId(seat)]))
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state = gameState();
	seats = state.activeSeats;
	mocks.listActiveAiRooms.mockImplementation(async () => [room()]);
	mocks.loadAiRoom.mockImplementation(async () => room());
	mocks.lastCommitAt.mockResolvedValue(NOW - 4_000);
	mocks.runRoomCommand.mockImplementation(
		async ({ command, trustedMemberId }: { command: GameCommand; trustedMemberId: string }) => {
			const seat = seats.find((s) => agentMemberId(s) === trustedMemberId)!;
			const result = applyGameCommand(
				state,
				{ memberId: trustedMemberId, displayName: seat, role: 'player', seatColor: seat },
				command,
				catalog
			);
			if (!result.ok) throw { status: 400, body: { message: result.error.message } };
			state = result.state;
			return { projection: { revision: state.revision } };
		}
	);
});

describe('GET /api/ai/pending items', () => {
	test('one item per AI seat that must act, none for a seat that need not', async () => {
		const [red, blue] = seats;
		const items = await listPendingAiDecisions(NOW);
		expect(items.map((i) => i.seat)).toEqual([blue]);
		expect(items.some((i) => i.seat === red)).toBe(false);
		const [item] = items;
		expect(item.roomCode).toBe(ROOM);
		expect(item.revision).toBe(state.revision);
		expect(item.waitingMs).toBe(4_000);
		expect(item.system.length).toBeGreaterThan(500);
		expect(item.prompt).toContain('LEGAL ACTIONS:');
		expect(item.prompt).toContain('{"action": "<id>", "reason"');
		expect(item.actions.length).toBeGreaterThan(1);
		expect(item.actions[0]).toEqual({ id: 'a1', label: expect.any(String) });
	});

	test('no AI rooms → no items and no catalog work', async () => {
		mocks.listActiveAiRooms.mockResolvedValue([]);
		expect(await listPendingAiDecisions(NOW)).toEqual([]);
		expect(mocks.lastCommitAt).not.toHaveBeenCalled();
	});
});

describe('POST /api/ai/act', () => {
	test('applies the chosen action as the AI seat, fenced to the asked revision', async () => {
		const blue = seats[1];
		const before = state.revision;
		const [item] = await listPendingAiDecisions(NOW);
		const expected = buildAiDecision(state, blue, catalog, ROOM).built.request.actions[1];

		const result = await actForAiSeat({
			roomCode: ROOM,
			seat: blue,
			revision: before,
			actionId: item.actions[1].id
		});

		expect(result).toEqual({ status: 200, body: { ok: true, revision: before + 1 } });
		expect(mocks.runRoomCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				roomCode: ROOM,
				trustedMemberId: agentMemberId(blue),
				command: expected.command,
				cmdId: `ai:${SESSION}:${before}:${blue}`,
				requireRevision: before
			})
		);
	});

	test('a stale revision is a 409 carrying the current revision', async () => {
		const result = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision - 1,
			actionId: 'a1'
		});
		expect(result).toEqual({
			status: 409,
			body: { message: expect.any(String), revision: state.revision }
		});
		expect(mocks.runRoomCommand).not.toHaveBeenCalled();
	});

	test('a stale revision is accepted while the seat is still asked the same thing', async () => {
		const [item] = (await listPendingAiDecisions()).filter((i) => i.seat === seats[1]);
		expect(item.decisionKey).toMatch(/^[0-9a-f]{24}$/);
		mocks.runRoomCommand.mockResolvedValue({ projection: { revision: state.revision + 1 } });
		const ok = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision - 3,
			decisionKey: item.decisionKey,
			actionId: item.actions[0].id
		});
		expect(ok.status).toBe(200);
		// Applied at the CURRENT revision, never at the stale one.
		expect(mocks.runRoomCommand).toHaveBeenCalledWith(
			expect.objectContaining({ requireRevision: state.revision, expectedRevision: state.revision })
		);
		mocks.runRoomCommand.mockClear();
		const changed = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision - 3,
			decisionKey: 'not-the-current-decision',
			actionId: item.actions[0].id
		});
		expect(changed.status).toBe(409);
		expect(mocks.runRoomCommand).not.toHaveBeenCalled();
	});

	test('a commit race is retried while the decision is unchanged', async () => {
		const [item] = (await listPendingAiDecisions()).filter((i) => i.seat === seats[1]);
		mocks.runRoomCommand
			.mockRejectedValueOnce(new mocks.StaleRevisionError(state.revision + 1))
			.mockResolvedValue({ projection: { revision: state.revision + 2 } });
		const result = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision,
			decisionKey: item.decisionKey,
			actionId: item.actions[0].id
		});
		expect(result.status).toBe(200);
		expect(mocks.runRoomCommand).toHaveBeenCalledTimes(2);
	});

	test('a revision that moves during the commit is a 409 too', async () => {
		mocks.runRoomCommand.mockRejectedValue(new mocks.StaleRevisionError(state.revision + 1));
		const result = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision,
			actionId: 'a1'
		});
		expect(result).toEqual({
			status: 409,
			body: { message: expect.any(String), revision: state.revision + 1 }
		});
	});

	test('an unknown action id is a 400, never a guess', async () => {
		const result = await actForAiSeat({
			roomCode: ROOM,
			seat: seats[1],
			revision: state.revision,
			actionId: 'a999'
		});
		expect(result.status).toBe(400);
		expect(mocks.runRoomCommand).not.toHaveBeenCalled();
	});

	test('a seat that need not act, or a non-AI seat, is refused', async () => {
		const red = seats[0];
		expect(
			(await actForAiSeat({ roomCode: ROOM, seat: red, revision: state.revision, actionId: 'a1' }))
				.status
		).toBe(409);
		mocks.loadAiRoom.mockImplementation(async () => ({ ...room(), aiSeats: new Map() }));
		expect(
			(
				await actForAiSeat({
					roomCode: ROOM,
					seat: seats[1],
					revision: state.revision,
					actionId: 'a1'
				})
			).status
		).toBe(400);
		expect(mocks.runRoomCommand).not.toHaveBeenCalled();
	});
});
