import { describe, expect, test, vi } from 'vitest';
const { loadRoomView, loadPlayCatalog, getNeuralPolicy, getRemoteV2Fleet } = vi.hoisted(() => ({
	loadRoomView: vi.fn().mockResolvedValue({ roomCode: 'TEST' }),
	loadPlayCatalog: vi.fn(),
	getNeuralPolicy: vi.fn(),
	getRemoteV2Fleet: vi.fn()
}));
vi.mock('./service', () => ({ loadRoomView }));
vi.mock('./catalog', () => ({ loadPlayCatalog }));
vi.mock('../ml/neuralBot', () => ({ getNeuralPolicy }));
vi.mock('../ml/remoteV2', () => ({ getRemoteV2Fleet }));
import { addBot, fillBots, seatBotPlayer, tickBots } from './botSim';

describe('bots are paused', () => {
	test('rejects every bot creation entry point before any room mutation', async () => {
		await expect(addBot('TEST', 'host')).rejects.toThrow('temporarily unavailable');
		await expect(fillBots('TEST', 'host')).rejects.toThrow('temporarily unavailable');
		await expect(
			seatBotPlayer('TEST', 'Blue', { userId: 'bot', displayName: 'bot' })
		).rejects.toThrow('temporarily unavailable');
	});
	test('ticks do not load the catalog or either inference policy', async () => {
		expect(await tickBots('TEST', 'host')).toEqual({
			view: { roomCode: 'TEST' },
			commandsIssued: 0
		});
		expect(loadPlayCatalog).not.toHaveBeenCalled();
		expect(getNeuralPolicy).not.toHaveBeenCalled();
		expect(getRemoteV2Fleet).not.toHaveBeenCalled();
	});
});
