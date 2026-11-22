/**
 * The scripted Fighter + Elementalist player: its dice and fight model, and full games that it
 * must finish legally (no fallback, no rejected command, no stall). Offline, no model calls.
 *
 *   npx vitest run src/lib/play/agents/scripted
 */

import { describe, expect, it } from 'vitest';
import { diceTierFaces } from '../../combat';
import type { DiceTier, MonsterState, PlayCatalog } from '../../types';
import { loadCatalogSpec, loadFrozenCatalog } from '../catalog';
import { playTable } from './feGames';
import {
	damagePmf,
	diceAfter,
	fightOutcome,
	restDice,
	situationOf,
	upgradeRoom,
	type FightSetup
} from './fePolicy';
import { summarizeFeRun, vpAt } from './feSummary';

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

describe('scripted Fighter + Elementalist: dice model', () => {
	it('adds Basic dice up to 10 and upgrades the lowest die first', () => {
		expect(diceAfter(['basic', 'enchanted'], 1, 0)).toEqual(['basic', 'enchanted', 'basic']);
		expect(diceAfter(new Array(9).fill('basic'), 5, 0)).toHaveLength(10);
		expect(diceAfter(['enchanted', 'basic'], 0, 1)).toEqual(['enchanted', 'enchanted']);
		expect(diceAfter(['enchanted', 'enchanted'], 0, 3)).toEqual(['exalted', 'exalted']);
		expect(upgradeRoom(['basic', 'enchanted', 'exalted'])).toBe(3);
	});

	it('gives Fighter Rest dice 1 / 2 / 3 / 5 at Fighter 2 / 3 / 4 / 5', () => {
		expect([0, 1, 2, 3, 4, 5, 6].map(restDice)).toEqual([0, 0, 1, 2, 3, 5, 5]);
	});

	it('computes an exact damage distribution', () => {
		const faces = {
			basic: [0, 0, 0, 0, 1, 1],
			enchanted: [0, 0, 1, 1, 1, 2],
			exalted: [1, 1, 1, 2, 2, 2],
			arcane: [0, 0, 1, 3, 3, 5]
		};
		const pmf = damagePmf(['basic', 'basic'], faces as Record<DiceTier, number[]>);
		expect(pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
		expect(pmf[0]).toBeCloseTo(4 / 9, 10);
		expect(pmf[2]).toBeCloseTo(1 / 9, 10);
	});
});

describe('scripted Fighter + Elementalist: fight model', () => {
	const { catalog } = repoCatalog();
	const card: MonsterState = {
		id: 'm',
		name: 'Test',
		hp: 5,
		maxHp: 5,
		difficulty: 2,
		damage: 4,
		rewardTrack: [],
		chooseAmount: 0,
		livesRemaining: 1,
		livesTotal: 1,
		ladderIndex: 0,
		ladderMax: 1
	};
	const view = {
		round: 1,
		activeSeats: ['Red'],
		players: {
			Red: {
				spirits: [],
				spiritAugmentAttachments: [],
				attackDice: [],
				mats: [],
				barrier: 4,
				maxBarrier: 4,
				victoryPoints: 0
			}
		}
	} as never;
	const s = situationOf(view, 'Red', catalog);
	const setup = (over: Partial<FightSetup>): FightSetup => ({
		tiers: new Array(10).fill('exalted'),
		barrier: 4,
		reduction: 0,
		strikeFirst: false,
		extraArcane: 0,
		...over
	});

	it('a hit equal to the Barrier corrupts before the player strikes', () => {
		const o = fightOutcome(s, card, setup({ barrier: 4 }));
		expect(o.corrupted).toBe(true);
		expect(o.pKill).toBe(0);
	});

	it('a lower hit is survived and the dice decide', () => {
		const o = fightOutcome(s, card, setup({ barrier: 5 }));
		expect(o.corrupted).toBe(false);
		expect(o.pKill).toBeCloseTo(1, 6);
		expect(o.hit).toBe(4);
	});

	it('Battle Guard reduction and strike-first are applied', () => {
		expect(fightOutcome(s, card, setup({ barrier: 4, reduction: 4 })).corrupted).toBe(false);
		const first = fightOutcome(s, card, setup({ barrier: 4, strikeFirst: true }));
		expect(first.pKill).toBeCloseTo(1, 6);
		expect(first.hit).toBeCloseTo(0, 6);
	});

	it('uses the catalog dice faces', () => {
		const faces = diceTierFaces(catalog);
		expect(Object.keys(faces).sort()).toEqual(['arcane', 'basic', 'enchanted', 'exalted']);
	});
});

describe('scripted Fighter + Elementalist: full games', () => {
	const loaded = repoCatalog();
	const catalogInfo = { source: loaded.source, path: loaded.path, hash: loaded.hash };

	it('four scripted players finish games legally', async () => {
		const games = [];
		for (const seed of [1, 2, 3]) {
			const g = await playTable({
				catalog: loaded.catalog,
				catalogInfo,
				seed,
				seats: ['script:fe', 'script:fe', 'script:fe', 'script:fe'],
				rulesBrief: 'test'
			});
			expect(g.stopReason).toBe('finished');
			expect(g.fallbacks).toBe(0);
			expect(g.winner).not.toBeNull();
			for (const seat of g.seats) {
				expect(seat.scripted).toBeDefined();
				expect(seat.scripted!.byRound.length).toBeGreaterThan(0);
				// It builds what it says it builds.
				expect(seat.scripted!.roundFighter5).not.toBeNull();
			}
			// Somebody scores by killing monsters.
			expect(Math.max(...g.seats.map((x) => x.finalVp))).toBeGreaterThan(10);
			games.push(g);
		}
		const sum = summarizeFeRun(games);
		expect(sum.finished).toBe(3);
		expect(sum.scripted.players).toBe(12);
	}, 120_000);

	it('plays against mock seats and is deterministic for a seed', async () => {
		const seats = ['mock:greedy', 'script:fe', 'mock:greedy', 'mock:random'];
		const a = await playTable({
			catalog: loaded.catalog,
			catalogInfo,
			seed: 7,
			seats,
			rulesBrief: 'test'
		});
		const b = await playTable({
			catalog: loaded.catalog,
			catalogInfo,
			seed: 7,
			seats,
			rulesBrief: 'test'
		});
		expect(a.stopReason).toBe('finished');
		expect(a.fallbacks).toBe(0);
		expect(a.seats.map((x) => x.vpByRound)).toEqual(b.seats.map((x) => x.vpByRound));
		expect(a.seats[1].scripted!.kills).toEqual(b.seats[1].scripted!.kills);
	}, 120_000);

	it('also plays the frozen catalog without an illegal move', async () => {
		const catalog = loadFrozenCatalog();
		const g = await playTable({
			catalog,
			catalogInfo: { source: 'frozen', path: 'frozen', hash: 'frozen' },
			seed: 3,
			seats: ['script:fe', 'mock:random'],
			rulesBrief: 'test',
			maxDecisions: 4000
		});
		expect(['finished', 'decision-cap']).toContain(g.stopReason);
		expect(g.fallbacks).toBe(0);
	}, 120_000);

	it('reads points at a round with the final value kept after the game ends', () => {
		expect(vpAt([1, 2, 3], 2)).toBe(2);
		expect(vpAt([1, 2, 3], 8)).toBe(3);
		expect(vpAt([], 8)).toBe(0);
	});
});
