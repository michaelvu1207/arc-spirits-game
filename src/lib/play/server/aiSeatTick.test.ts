import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameCommand, PublicGameState } from '../types';

const NOW = 1_800_000_000_000;
const AI_MEMBER = 'ai-member';
const COMMAND = { type: 'lockNavigation', destination: 'Somewhere' } as unknown as GameCommand;

const mocks = vi.hoisted(() => ({
	runRoomCommand: vi.fn(),
	lastCommitAt: vi.fn(),
	loadRawRoomState: vi.fn(),
	planNeuralPhaseActions: vi.fn(),
	planUniformLegalPhaseActions: vi.fn(),
	getNeuralPolicy: vi.fn()
}));

vi.mock('./service', () => ({
	enforceRoomDeadlines: vi.fn(),
	closeRoomIfNoHumanPlayers: vi.fn(async () => false),
	getSessionIdByRoomCode: vi.fn().mockResolvedValue('session-1'),
	getSessionModeByRoomCode: vi.fn(),
	joinRoom: vi.fn(),
	lastCommitAt: mocks.lastCommitAt,
	loadBotMembers: vi.fn().mockResolvedValue(new Map([['ai-member', 'ai']])),
	loadRawRoomState: mocks.loadRawRoomState,
	loadRoomView: vi.fn().mockResolvedValue({ roomCode: 'ROOM01' }),
	runRoomCommand: mocks.runRoomCommand
}));
vi.mock('./catalog', () => ({ loadPlayCatalog: vi.fn().mockResolvedValue({}) }));
vi.mock('../ml/neuralBot', () => ({
	getNeuralPolicy: mocks.getNeuralPolicy,
	planNeuralPhaseActions: mocks.planNeuralPhaseActions,
	planUniformLegalPhaseActions: mocks.planUniformLegalPhaseActions
}));
vi.mock('../ml/remoteV2', () => ({
	getRemoteV2Fleet: vi.fn().mockResolvedValue([]),
	markSearchPlanningFailure: vi.fn(),
	planNeuralPhaseActionsV2: vi.fn(),
	resetRemoteV2Client: vi.fn(),
	searchPlanningEnabled: vi.fn().mockReturnValue(false)
}));

import { tickBots } from './botSim';

/** An active navigation round: Red is a human, Blue an AI seat that has not locked yet. */
function activeState(): PublicGameState {
	return {
		status: 'active',
		phase: 'navigation',
		activeSeats: ['Red', 'Blue'],
		seats: {
			Red: { memberId: 'human', displayName: 'Host', selectedGuardian: 'A' },
			Blue: { memberId: AI_MEMBER, displayName: 'Claude', selectedGuardian: 'B' }
		},
		players: { Red: {}, Blue: {} },
		navigation: { Red: { locked: true }, Blue: { locked: false } }
	} as unknown as PublicGameState;
}

let savedKey: string | undefined;
let savedTimeout: string | undefined;
beforeEach(() => {
	savedKey = process.env.ARC_AI_WORKER_KEY;
	savedTimeout = process.env.ARC_AI_SEAT_TIMEOUT_MS;
	process.env.ARC_AI_WORKER_KEY = 'worker-key';
	delete process.env.ARC_AI_SEAT_TIMEOUT_MS;
	vi.clearAllMocks();
	vi.spyOn(Date, 'now').mockReturnValue(NOW);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	mocks.loadRawRoomState.mockImplementation(async () => activeState());
	mocks.getNeuralPolicy.mockResolvedValue({ policy: 'bundled' });
	mocks.planNeuralPhaseActions.mockReturnValue([COMMAND]);
	mocks.runRoomCommand.mockResolvedValue({});
});
afterEach(() => {
	vi.restoreAllMocks();
	if (savedKey === undefined) delete process.env.ARC_AI_WORKER_KEY;
	else process.env.ARC_AI_WORKER_KEY = savedKey;
	if (savedTimeout === undefined) delete process.env.ARC_AI_SEAT_TIMEOUT_MS;
	else process.env.ARC_AI_SEAT_TIMEOUT_MS = savedTimeout;
});

describe('tickBots and AI seats', () => {
	test('skips an AI seat the room has waited on for less than the timeout (no policy loaded)', async () => {
		mocks.lastCommitAt.mockResolvedValue(NOW - 30_000);
		const result = await tickBots('ROOM01', 'human');
		expect(result.commandsIssued).toBe(0);
		expect(mocks.runRoomCommand).not.toHaveBeenCalled();
		expect(mocks.getNeuralPolicy).not.toHaveBeenCalled();
	});

	test('plays it with the bundled policy, like a neural bot, after the timeout', async () => {
		mocks.lastCommitAt.mockResolvedValue(NOW - 90_001);
		const result = await tickBots('ROOM01', 'human');
		expect(mocks.planNeuralPhaseActions).toHaveBeenCalledWith(
			expect.anything(),
			'Blue',
			expect.anything(),
			{ policy: 'bundled' },
			expect.objectContaining({ search: false })
		);
		expect(mocks.runRoomCommand).toHaveBeenCalledWith(
			expect.objectContaining({ trustedMemberId: AI_MEMBER, command: COMMAND })
		);
		expect(result.commandsIssued).toBe(1);
	});

	test('ARC_AI_SEAT_TIMEOUT_MS changes the wait', async () => {
		process.env.ARC_AI_SEAT_TIMEOUT_MS = '10000';
		mocks.lastCommitAt.mockResolvedValue(NOW - 12_000);
		expect((await tickBots('ROOM01', 'human')).commandsIssued).toBe(1);
	});

	test('without the worker key (and bots paused) the tick does nothing', async () => {
		delete process.env.ARC_AI_WORKER_KEY;
		mocks.lastCommitAt.mockResolvedValue(NOW - 999_999);
		expect((await tickBots('ROOM01', 'human')).commandsIssued).toBe(0);
		expect(mocks.loadRawRoomState).not.toHaveBeenCalled();
	});
});
