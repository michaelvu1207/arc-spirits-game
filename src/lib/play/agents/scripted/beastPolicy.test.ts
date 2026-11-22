/**
 * The scripted Beast player: its planning model, and full games that it must finish legally
 * (no fallback, no rejected command, no stall, no corruption by its own choice). Offline, no
 * model calls.
 *
 *   npx vitest run src/lib/play/agents/scripted
 */

import { describe, expect, it } from 'vitest';
import type { PlayCatalog } from '../../types';
import { loadCatalogSpec, loadFrozenCatalog } from '../catalog';
import {
	applyAbyss,
	applyCultivate,
	applyRest,
	buyAugments,
	cardPace,
	cloneState,
	drawOutcomes,
	planValue,
	typicalCard,
	type PlanCard,
	type PlanRules,
	type PlanState
} from './beastPlan';
import { DEFAULT_BEAST_PARAMS } from './beastPolicy';
import { playTable } from './feGames';
import { seatKind, summarizeByKind, summarizeFeRun, SUMMARY_ROUNDS } from './feSummary';
import { isScriptedPolicy } from './scriptedSeat';

/** The design data in the repo (the rule set the league plays), else the frozen catalog. */
function repoCatalog(): { catalog: PlayCatalog; hash: string; source: string; path: string } {
	try {
		const loaded = loadCatalogSpec('data');
		if (loaded.catalog.spirits?.length) return loaded;
	} catch {
		/* fall through */
	}
	return { catalog: loadFrozenCatalog(), hash: 'frozen', source: 'frozen', path: 'frozen' };
}

const card = (hp: number, hit: number, vp: number, difficulty: 0 | 1 | 2 | 3 = 2): PlanCard => ({
	hp,
	maxHp: hp,
	hit,
	vp,
	runes: 0,
	extra: 0,
	difficulty,
	handIndex: -1
});

function rules(over: Partial<PlanRules> = {}): PlanRules {
	return {
		target: 30,
		heal: 7,
		maxBarrierCap: 10,
		carry: 4,
		handLimit: 3,
		beastDamage: 1,
		cultivateMaxBarrier: (c) => (c >= 3 ? 2 : c >= 2 ? 1 : 0),
		fightsPerRound: 1,
		overkillMaxBarrier: 0,
		overkillAt: 2,
		deckTypes: [
			[],
			[
				{ card: card(2, 3, 3, 1), weight: 1 },
				{ card: card(3, 4, 3, 1), weight: 1 }
			],
			[
				{ card: card(5, 3, 5), weight: 1 },
				{ card: card(8, 4, 5), weight: 1 }
			],
			[{ card: card(12, 5, 7, 3), weight: 1 }]
		],
		lurker: card(1, 3, 1, 0),
		summonBeast: 0.5,
		hexRune: 0.5,
		rivalDraws: 0,
		tuning: {
			depth: 3,
			rollout: 10,
			tail: 0.7,
			winBonus: 3,
			discount: 0.95,
			runeLeft: 0.3,
			chip: 0.5
		},
		cache: new Map(),
		...over
	};
}

function board(over: Partial<PlanState> = {}): PlanState {
	return {
		vp: 0,
		bonus: 0,
		flat: 5,
		dice: 0,
		cultivator: 0,
		maxBarrier: 7,
		barrier: 7,
		runes: 0,
		hosts: 0,
		free: 0,
		plain: 0,
		runesPerCultivate: 0,
		hand: [],
		pools: [0, 5, 5, 5],
		...over
	};
}

describe('scripted Beast: planning model', () => {
	it('never fights a card whose hit the Barrier cannot take', () => {
		const s = board({ barrier: 4, hand: [card(3, 4, 3, 1)] });
		applyAbyss(s, rules(), -1);
		expect(s.barrier).toBe(4);
		expect(s.vp).toBe(0);
	});

	it('kills a card it out-damages, pays the hit and keeps damage on a card it does not kill', () => {
		const s = board({ hand: [card(5, 3, 5)] });
		applyAbyss(s, rules(), -1);
		expect(s.vp).toBe(5);
		expect(s.barrier).toBe(4);
		expect(s.hand).toHaveLength(0);
		const t = board({ flat: 4, hand: [card(8, 4, 5)] });
		applyAbyss(t, rules(), -1);
		expect(t.vp).toBe(0);
		expect(t.hand[0].hp).toBe(4);
	});

	it('strikes first only when the strike kills', () => {
		const s = board({ barrier: 3, hand: [card(5, 3, 5)] });
		applyAbyss(s, rules(), -1, { strikeFirst: true });
		expect(s.vp).toBe(5);
		expect(s.barrier).toBe(3);
		const t = board({ barrier: 3, flat: 4, hand: [card(5, 3, 5)] });
		applyAbyss(t, rules(), -1, { strikeFirst: true });
		expect(t.vp).toBe(0);
		expect(t.barrier).toBe(3);
	});

	it('rests up to Max Barrier, cultivates runes and Max Barrier, buys augments for runes', () => {
		const s = board({ barrier: 2, maxBarrier: 7, cultivator: 2, runesPerCultivate: 2 });
		applyRest(s, rules());
		expect(s.barrier).toBe(7);
		applyCultivate(s, rules());
		expect(s.runes).toBe(2);
		expect(s.maxBarrier).toBe(8);
		const t = board({ runes: 3, hosts: 2, flat: 1 });
		buyAugments(t, rules(), 0);
		expect(t.flat).toBe(3);
		expect(t.runes).toBe(1);
		expect(t.hosts).toBe(0);
	});

	it('a draw keeps the better of two cards: chances add to 1 and favour the better kind', () => {
		const outcomes = drawOutcomes(2, board(), rules());
		expect(outcomes.reduce((n, o) => n + o.chance, 0)).toBeCloseTo(1, 10);
		expect(outcomes[0].card.hp).toBe(5);
		expect(outcomes[0].chance).toBeCloseTo(0.75, 10);
		// The typical card pays no more than its median kind does.
		const typical = typicalCard(2, board(), rules())!;
		expect(typical.vp).toBeLessThanOrEqual(5);
		expect(cardPace(typical, 5, rules())).toBeGreaterThan(0);
	});

	it('values damage and an earlier kill, and does not change the board it is given', () => {
		const r = rules();
		const weak = board({ flat: 2 });
		const strong = board({ flat: 6 });
		const before = JSON.stringify(strong);
		expect(planValue(strong, r, 10)).toBeGreaterThan(planValue(weak, r, 10));
		expect(JSON.stringify(strong)).toBe(before);
		// The same kill one round earlier is worth more.
		const now = cloneState(board({ hand: [card(5, 3, 5)] }));
		applyAbyss(now, r, -1);
		const later = board({ hand: [card(5, 3, 5)] });
		expect(planValue(now, r, 5)).toBeGreaterThan(planValue(later, r, 5) - 1e-9);
	});
});

describe('scripted Beast: full games', () => {
	const loaded = repoCatalog();
	const catalogInfo = { source: loaded.source, path: loaded.path, hash: loaded.hash };

	it('is a registered scripted policy with complete default parameters', () => {
		expect(isScriptedPolicy('beast')).toBe(true);
		expect(isScriptedPolicy('fe')).toBe(true);
		for (const v of Object.values(DEFAULT_BEAST_PARAMS)) expect(Number.isFinite(v)).toBe(true);
	});

	it('four Beast players finish games legally and never corrupt themselves', async () => {
		const games = [];
		for (const seed of [1, 2, 3]) {
			const g = await playTable({
				catalog: loaded.catalog,
				catalogInfo,
				seed,
				seats: ['script:beast', 'script:beast', 'script:beast', 'script:beast'],
				rulesBrief: 'test'
			});
			expect(g.stopReason).toBe('finished');
			expect(g.fallbacks).toBe(0);
			expect(g.winner).not.toBeNull();
			for (const seat of g.seats) {
				expect(seat.scripted).toBeDefined();
				expect(seat.scripted!.byRound.length).toBeGreaterThan(0);
				// Monsters always strike first: it never takes a hit as large as its Barrier.
				expect(seat.corruptions).toBe(0);
				// It builds what it says it builds.
				expect(Math.max(...seat.scripted!.byRound.map((b) => b.beast))).toBeGreaterThanOrEqual(3);
				// Every kill is counted, also when the reward claim was a forced move.
				const kills = seat.scripted!.kills;
				expect(kills.lurker + kills.d1 + kills.d2 + kills.d3).toBe(seat.monsterKills);
			}
			expect(Math.max(...g.seats.map((x) => x.finalVp))).toBeGreaterThan(10);
			games.push(g);
		}
		const kinds = summarizeByKind(games);
		expect(Object.keys(kinds)).toEqual(['script:beast']);
		expect(kinds['script:beast'].players).toBe(12);
		expect(kinds['script:beast'].wins).toBe(3);
		expect(Object.keys(kinds['script:beast'].pointsAt)).toEqual(
			SUMMARY_ROUNDS.map((r) => `round${r}`)
		);
		expect(summarizeFeRun(games).byKind['script:beast'].players).toBe(12);
	}, 240_000);

	it('plays Fighter + Elementalist and mock seats, and is deterministic for a seed', async () => {
		const seats = ['script:beast', 'script:fe', 'script:beast#a', 'mock:greedy'];
		const play = () =>
			playTable({
				catalog: loaded.catalog,
				catalogInfo,
				seed: 7,
				seats,
				variants: { a: { pace: 2 } },
				rulesBrief: 'test'
			});
		const a = await play();
		const b = await play();
		expect(a.stopReason).toBe('finished');
		expect(a.fallbacks).toBe(0);
		expect(a.seats.map((x) => x.vpByRound)).toEqual(b.seats.map((x) => x.vpByRound));
		expect(a.seats[0].scripted!.byRound).toEqual(b.seats[0].scripted!.byRound);
		expect(a.seats[3].scripted).toBeUndefined();
		// A variant keeps its seat kind.
		expect(seatKind(a.seats[2].spec)).toBe('script:beast');
		expect(Object.keys(summarizeByKind([a])).sort()).toEqual([
			'mock:greedy',
			'script:beast',
			'script:fe'
		]);
	}, 240_000);

	it('also plays the frozen catalog without an illegal move', async () => {
		const catalog = loadFrozenCatalog();
		const g = await playTable({
			catalog,
			catalogInfo: { source: 'frozen', path: 'frozen', hash: 'frozen' },
			seed: 3,
			seats: ['script:beast', 'mock:random'],
			rulesBrief: 'test',
			maxDecisions: 4000
		});
		expect(['finished', 'decision-cap']).toContain(g.stopReason);
		expect(g.fallbacks).toBe(0);
	}, 240_000);
});
