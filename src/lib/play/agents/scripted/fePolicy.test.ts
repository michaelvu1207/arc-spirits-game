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
import { elementalistRestUpgrades } from '../../effects/classes/elementalist';
import { elementalistUpgradeAction } from '../../rules';
import {
	chooseFeAction,
	cultivateMaxBarrier,
	damagePmf,
	diceAfter,
	elementalistUpgrades,
	fightOutcome,
	relicRestGain,
	relicWorth,
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

	it('reads the Fighter Rest dice from the engine and the rules', () => {
		const with35 = { rules: { fighterDice35: true } } as unknown as PlayCatalog;
		const without = { rules: { fighterDice35: false } } as unknown as PlayCatalog;
		expect([0, 1, 2, 3, 4, 5, 6].map((f) => restDice(f, with35))).toEqual([0, 0, 1, 2, 3, 5, 5]);
		expect([0, 1, 2, 3, 4, 5, 6].map((f) => restDice(f, without))).toEqual([0, 0, 1, 2, 5, 10, 10]);
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

describe('scripted Fighter + Elementalist: rules read from the engine', () => {
	const rules = (r: Record<string, boolean>) => ({ rules: r }) as unknown as PlayCatalog;
	const relic = [{ hasRune: true, type: 'relic', slotIndex: 1 }];

	it('Rest-only Elementalist: the engine helper decides, a relic gates the top step', () => {
		const cat = rules({
			elementalistMethods: true,
			elementalistRest1235: true,
			elementalist5NeedsRelic: true
		});
		for (let e = 0; e <= 6; e++) {
			expect(elementalistUpgrades(cat, 'rest', e, true)).toBe(
				elementalistRestUpgrades(cat, e, { mats: relic } as never)
			);
			expect(elementalistUpgrades(cat, 'rest', e, false)).toBe(
				elementalistRestUpgrades(cat, e, { mats: [] } as never)
			);
			for (const a of ['cultivate', 'summon', 'kill'] as const)
				expect(elementalistUpgrades(cat, a, e, true)).toBe(0);
		}
		// The relic matters at 5 (and not below) while the gate is on, and nowhere without it.
		expect(relicRestGain(cat, 5)).toBeGreaterThan(0);
		expect(relicRestGain(cat, 4)).toBe(0);
		const ungated = rules({ elementalistMethods: true, elementalistRest1235: true });
		expect(relicRestGain(ungated, 5)).toBe(0);
	});

	it('ladder on Cultivate: the engine names the action, the helper gives the amount', () => {
		const cat = rules({
			elementalistMethods: true,
			elementalistRest1235: true,
			elementalist5NeedsRelic: true,
			elementalistOnCultivate: true
		});
		expect(elementalistUpgradeAction(cat)).toBe('cultivate');
		for (let e = 0; e <= 6; e++) {
			expect(elementalistUpgrades(cat, 'cultivate', e, true)).toBe(
				elementalistRestUpgrades(cat, e, { mats: relic } as never)
			);
			for (const a of ['rest', 'summon', 'kill'] as const)
				expect(elementalistUpgrades(cat, a, e, true)).toBe(0);
		}
		expect(relicRestGain(cat, 5)).toBeGreaterThan(0);
	});

	it('the action rule (yesterday): Rest / Cultivate / Summon from (3) / (4) / (5), kills only via Arcane Blood', () => {
		const cat = rules({
			elementalistMethods: true,
			elementalistOneUpgrade: true,
			arcaneBlood: true
		});
		expect([2, 3].map((e) => elementalistUpgrades(cat, 'rest', e, false))).toEqual([0, 1]);
		expect([3, 4].map((e) => elementalistUpgrades(cat, 'cultivate', e, false))).toEqual([0, 1]);
		expect([4, 5].map((e) => elementalistUpgrades(cat, 'summon', e, false))).toEqual([0, 1]);
		expect(elementalistUpgrades(cat, 'kill', 5, false, { difficulty: 3 })).toBe(0);
		expect(relicRestGain(cat, 5)).toBe(0);
	});

	it('the default Elementalist ladder is read by running the class ability', () => {
		const cat = rules({});
		expect([1, 2, 3, 4, 5].map((e) => elementalistUpgrades(cat, 'rest', e, false))).toEqual([
			0, 1, 2, 5, 10
		]);
	});

	it('Cultivator Max Barrier comes from the class ladder and its rule switch', () => {
		expect(
			[1, 2, 3, 4, 5].map((c) => cultivateMaxBarrier(c, rules({ cultivatorBarrier35: true })))
		).toEqual([0, 1, 2, 3, 5]);
		expect([1, 2, 3, 4, 5].map((c) => cultivateMaxBarrier(c, rules({})))).toEqual([0, 1, 2, 5, 10]);
	});
});

describe('scripted Fighter + Elementalist: relics', () => {
	const { catalog } = repoCatalog();
	const gated = {
		...catalog,
		rules: { ...(catalog.rules ?? {}), elementalistRest1235: true, elementalist5NeedsRelic: true }
	} as PlayCatalog;
	const flower = {
		slotIndex: 1,
		hasRune: true,
		id: '690a7e3b-5737-4494-bb8a-b58bee13f473',
		name: 'Flower',
		type: 'relic',
		special: true,
		relicTool: true
	};
	const viewWith = (elementalist: number, mats: unknown[]) =>
		({
			round: 5,
			activeSeats: ['Red'],
			players: {
				Red: {
					spirits: new Array(elementalist).fill(0).map((_, i) => ({
						slotIndex: i + 1,
						name: `E${i}`,
						cost: 3,
						isFaceDown: false,
						classes: { Elementalist: 1 },
						origins: {}
					})),
					spiritAugmentAttachments: [],
					attackDice: new Array(10).fill(0).map((_, i) => ({ instanceId: `d${i}`, tier: 'basic' })),
					mats,
					// Hurt: the Flower's effect is worth something.
					barrier: 2,
					maxBarrier: 5,
					victoryPoints: 0,
					pendingDecisions: [
						{
							id: 'dec1',
							kind: 'relicTool',
							prompt: 'Flower: You may restore your Barrier to full, then discard this.',
							options: [
								{ id: 'keep:1:x', label: 'Keep Flower for later' },
								{ id: 'effect:1:x', label: 'Restore your Barrier to full, then discard Flower' }
							]
						}
					]
				}
			}
		}) as never;
	const offers = [
		{
			id: 'a',
			group: 'decision',
			label: 'keep',
			command: { type: 'resolveDecision', decisionId: 'dec1', optionId: 'keep:1:x' }
		},
		{
			id: 'b',
			group: 'decision',
			label: 'use',
			command: { type: 'resolveDecision', decisionId: 'dec1', optionId: 'effect:1:x' }
		}
	] as never;

	it('a relic is worth keeping at Elementalist 5 only when the rules gate the step on it', () => {
		expect(relicWorth(situationOf(viewWith(5, [flower]), 'Red', gated))).toBeGreaterThan(0);
		const ungated = {
			...gated,
			rules: { ...gated.rules, elementalist5NeedsRelic: false }
		} as PlayCatalog;
		expect(relicWorth(situationOf(viewWith(5, [flower]), 'Red', ungated))).toBe(0);
	});

	it('keeps its only relic at Elementalist 5 under the gate, uses it otherwise', () => {
		expect(chooseFeAction(viewWith(5, [flower]), 'Red', offers, gated).id).toBe('a');
		const ungated = {
			...gated,
			rules: { ...gated.rules, elementalist5NeedsRelic: false }
		} as PlayCatalog;
		expect(chooseFeAction(viewWith(5, [flower]), 'Red', offers, ungated).id).toBe('b');
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
				// It builds what it says it builds: both classes, and nobody is stuck (a seat that
				// could not take a monster's hit used to rest to the end of the game with 0 points).
				const top = (k: 'fighter' | 'elementalist') =>
					Math.max(...seat.scripted!.byRound.map((r) => r[k]));
				// The repo's rule numbers change while they are tuned, so the floor for every seat is
				// 2 of each class; most seats reach 3 of each (checked below).
				expect(top('fighter')).toBeGreaterThanOrEqual(2);
				expect(top('elementalist')).toBeGreaterThanOrEqual(2);
				expect(seat.finalVp).toBeGreaterThan(5);
			}
			const reach3 = (k: 'fighter' | 'elementalist') =>
				g.seats.filter((x) => Math.max(...x.scripted!.byRound.map((r) => r[k])) >= 3).length;
			expect(reach3('fighter')).toBeGreaterThanOrEqual(3);
			expect(reach3('elementalist')).toBeGreaterThanOrEqual(3);
			// Most seats complete Fighter 5 (the rest win points with fewer Fighters).
			expect(
				g.seats.filter((x) => x.scripted!.roundFighter5 !== null).length
			).toBeGreaterThanOrEqual(2);
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
