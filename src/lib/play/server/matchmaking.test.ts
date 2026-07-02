import { describe, expect, test } from 'vitest';
import { botOrdinal, pickNearestBots, type BotCandidate } from './matchmaking';

function bot(user_id: string, mu: number, sigma: number, bot_profile = 'neural'): BotCandidate {
	return { user_id, display_name: user_id, mu, sigma, bot_profile };
}

describe('botOrdinal', () => {
	test('derives ordinal as mu - 3*sigma (no ordinal column on player_ratings)', () => {
		expect(botOrdinal({ mu: 25, sigma: 8 })).toBe(1);
		expect(botOrdinal({ mu: 39, sigma: 3 })).toBe(30);
	});
});

describe('pickNearestBots', () => {
	test('orders candidates by ordinal proximity to the human, nearest first', () => {
		// ordinals: a=0, b=10, c=20, d=-5
		const candidates = [bot('a', 0, 0), bot('b', 10, 0), bot('c', 20, 0), bot('d', -5, 0)];
		const picked = pickNearestBots(candidates, 6, 5).map((c) => c.user_id);
		// distances from 6: a=6, b=4, c=14, d=11 → b, a, d, c
		expect(picked).toEqual(['b', 'a', 'd', 'c']);
	});

	test('takes only the nearest `take` candidates', () => {
		const candidates = [bot('a', 0, 0), bot('b', 10, 0), bot('c', 20, 0)];
		const picked = pickNearestBots(candidates, 0, 2).map((c) => c.user_id);
		expect(picked).toEqual(['a', 'b']);
	});

	test('is stable for equal distances (preserves input order)', () => {
		// a (ordinal -5) and b (ordinal +5) are equidistant from 0 → input order wins.
		const candidates = [bot('a', -5, 0), bot('b', 5, 0)];
		const picked = pickNearestBots(candidates, 0, 2).map((c) => c.user_id);
		expect(picked).toEqual(['a', 'b']);
	});

	test('factors sigma into proximity via the mu - 3*sigma ordinal', () => {
		// Same mu, different sigma → different ordinal. human ordinal = 25.
		const tight = bot('tight', 30, 2); // ordinal 24
		const wide = bot('wide', 30, 6); // ordinal 12
		const picked = pickNearestBots([wide, tight], 25, 1).map((c) => c.user_id);
		expect(picked).toEqual(['tight']);
	});

	test('handles empty / non-positive take gracefully', () => {
		expect(pickNearestBots([], 0, 5)).toEqual([]);
		expect(pickNearestBots([bot('a', 0, 0)], 0, 0)).toEqual([]);
	});
});
