import { describe, expect, it } from 'vitest';
import { calculateMatchAward, rankForXp, nextRankForXp, RANKS } from './progression';

describe('cosmetic progression', () => {
	it('maps XP to the highest unlocked rank', () => {
		expect(rankForXp(0).id).toBe('iron');
		expect(rankForXp(80).id).toBe('silver');
		expect(rankForXp(319).id).toBe('gold');
		expect(rankForXp(800).id).toBe('ascendant');
	});

	it('finds the next rank threshold', () => {
		expect(nextRankForXp(0)?.id).toBe('silver');
		expect(nextRankForXp(RANKS.at(-1)!.minXp)).toBeNull();
	});

	it('awards more credits and XP for wins than low placements', () => {
		const win = calculateMatchAward({
			matchId: 'room:red',
			victoryPoints: 30,
			placement: 1,
			won: true,
			round: 8
		});
		const fourth = calculateMatchAward({
			matchId: 'room:blue',
			victoryPoints: 8,
			placement: 4,
			won: false,
			round: 8
		});

		expect(win.credits).toBeGreaterThan(fourth.credits);
		expect(win.rankXp).toBeGreaterThan(fourth.rankXp);
		expect(fourth.credits).toBeGreaterThan(0);
	});
});
