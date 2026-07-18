import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SEAT_COLORS, type PublicGameState, type SeatColor } from '../types';

const mocks = vi.hoisted(() => ({
	joinRoom: vi.fn(),
	loadRoomView: vi.fn(),
	loadRawRoomState: vi.fn(),
	runRoomCommand: vi.fn(),
	getSessionModeByRoomCode: vi.fn()
}));

vi.mock('./service', () => ({
	enforceRoomDeadlines: vi.fn(),
	getSessionIdByRoomCode: vi.fn(),
	getSessionModeByRoomCode: mocks.getSessionModeByRoomCode,
	joinRoom: mocks.joinRoom,
	loadBotMembers: vi.fn(),
	loadRawRoomState: mocks.loadRawRoomState,
	loadRoomView: mocks.loadRoomView,
	runRoomCommand: mocks.runRoomCommand
}));

import { addBot, fillBots } from './botSim';

function lobbyState(): PublicGameState {
	const seats = Object.fromEntries(
		SEAT_COLORS.map((seat) => [
			seat,
			{
				memberId: seat === 'Red' ? 'human-host' : null,
				displayName: seat === 'Red' ? 'Host' : null,
				selectedGuardian: seat === 'Red' ? 'Myrtle' : null
			}
		])
	);
	return {
		status: 'lobby',
		guardianPool: ['Myrtle', 'Nyra', 'Orro'],
		seats
	} as unknown as PublicGameState;
}

beforeEach(() => {
	vi.clearAllMocks();
	const state = lobbyState();
	mocks.getSessionModeByRoomCode.mockResolvedValue('casual');
	mocks.loadRoomView.mockResolvedValue({ member: { role: 'host' } });
	mocks.loadRawRoomState.mockImplementation(async () => state);
	mocks.joinRoom.mockResolvedValue({ memberId: 'server-bot', created: true });
	mocks.runRoomCommand.mockImplementation(async ({ command }: { command: Record<string, unknown> }) => {
		if (command.type === 'claimSeat') {
			const seat = command.seatColor as SeatColor;
			state.seats[seat]!.memberId = 'server-bot';
			state.seats[seat]!.displayName = 'Nameless Spirit';
		}
		return {};
	});
});

describe('server-managed bot admission', () => {
	test('fillBots marks direct bot membership creation as internal', async () => {
		await fillBots('ROOM01', 'human-host', { targetSeats: 2 });
		expect(mocks.joinRoom).toHaveBeenCalledWith(
			'ROOM01',
			'Nameless Spirit',
			null,
			expect.objectContaining({ isBot: true, admission: 'internal' })
		);
	});

	test('addBot marks the shared single-bot seating path as internal', async () => {
		await addBot('ROOM02', 'human-host');
		expect(mocks.joinRoom).toHaveBeenCalledWith(
			'ROOM02',
			'Nameless Spirit',
			null,
			expect.objectContaining({ isBot: true, admission: 'internal' })
		);
	});
});
