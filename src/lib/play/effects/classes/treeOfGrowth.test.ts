import { describe, expect, it } from 'vitest';
import { fire } from './testHelpers';

describe('Growth Warden', () => {
	it('offers its reward only after attack dice changed this round', () => {
		const changed = fire({ 'Growth Warden': 1 }, 'awakeningPhase', {
			player: { attackDiceChangedThisTurn: true }
		});
		expect(changed.player.pendingDecisions[0]?.kind).toBe('treeOfGrowthReward');
		const unchanged = fire({ 'Growth Warden': 1 }, 'awakeningPhase');
		expect(unchanged.player.pendingDecisions).toHaveLength(0);
	});
});
