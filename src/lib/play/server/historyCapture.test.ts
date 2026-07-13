import { describe, expect, it } from 'vitest';
import { completedHistoryRound } from './historyCapture';

describe('completedHistoryRound', () => {
	it('ignores lobby start and in-round commands', () => {
		expect(
			completedHistoryRound({ status: 'lobby', round: 0 }, { status: 'active', round: 1 })
		).toBeNull();
		expect(
			completedHistoryRound({ status: 'active', round: 7 }, { status: 'active', round: 7 })
		).toBeNull();
	});

	it('captures the round completed by a normal phase transition', () => {
		expect(
			completedHistoryRound({ status: 'active', round: 7 }, { status: 'active', round: 8 })
		).toBe(7);
	});

	it('captures a terminal round without requiring a round increment', () => {
		expect(
			completedHistoryRound({ status: 'active', round: 17 }, { status: 'finished', round: 17 })
		).toBe(17);
		expect(
			completedHistoryRound({ status: 'active', round: 30 }, { status: 'finished', round: 30 })
		).toBe(30);
	});

	it('does not recapture an already terminal state', () => {
		expect(
			completedHistoryRound({ status: 'finished', round: 17 }, { status: 'finished', round: 17 })
		).toBeNull();
	});
});
