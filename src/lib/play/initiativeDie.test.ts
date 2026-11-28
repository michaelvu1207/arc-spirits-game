/**
 * Initiative (Michael, 2026-11-26 and 2026-11-27): one 12-sided die per player, not a number.
 * "initiaitve is no longer an integer value"; "you also can't get more than 1 inittiative dice";
 * "monsters by default always have initiative"; "feral should be gain initiative if your side doesn't.
 * same thing with spellblade, firecracker. remove the strike first from assasin"; the wording is
 * "gain the initiative". The die hits on 4 / 6 / 7 / 8 of its 12 sides at Pure / Tainted / Corrupt /
 * Fallen, and in a player fight "iniative values can add up": each die that hits is 1 initiative, a
 * side adds its players' initiative up, the side with more attacks first, equal means at the same
 * time. (These were the switches initiativeDie and initiativeSum until 2026-11-27; see
 * docs/rules-history-2026-11.md.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fightMonster, resolveEncounterCombat, rollInitiativeDie } from './combat';
import { INITIATIVE_DIE_SIDES, INITIATIVE_HITS, initiativeHits } from './rules';
import { buildRulesBrief } from './agents/rulesBrief';
import { navigationPowerById, navigationPowerPool } from './navigationPowers';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import type { DiceTier, PlayCatalog, PrivatePlayerState, SeatColor } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const STATUS = ['Pure', 'Tainted', 'Corrupt', 'Fallen'];
const dice = (n: number, tier: DiceTier = 'exalted') => Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier }));
const monster = (hp: number, damage: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, initiative: 100, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;
const at = (statusLevel: number, more: Partial<PrivatePlayerState> = {}): PrivatePlayerState =>
	makePlayer({ statusLevel, statusToken: STATUS[statusLevel], barrier: 10, maxBarrier: 10, attackDice: dice(4), ...more } as never);
const SEEDS = Array.from({ length: 600 }, (_, i) => i + 1);
type ClassRow = { name: string; effect_schema: { count: number; effects?: { description: string }[] }[] };
const CLASSES = JSON.parse(readFileSync('data/classes.json', 'utf8')) as ClassRow[];
/** The printed text of `className` at `count`, from the game data. */
const classText = (className: string, count = 1): string =>
	(CLASSES.find((c) => c.name === className)?.effect_schema.find((r) => r.count === count)?.effects ?? []).map((e) => e.description).join(' ');

describe('initiative: the die', () => {
	it('has 12 sides; Pure 4, Tainted 6, Corrupt 7, Fallen 8 of them give the initiative', () => {
		expect(INITIATIVE_DIE_SIDES).toBe(12);
		expect(INITIATIVE_HITS).toEqual([4, 6, 7, 8]);
		expect([0, 1, 2, 3].map((s) => initiativeHits(s))).toEqual([4, 6, 7, 8]);
	});
	it('hits in about 33, 50, 58 and 67 % of rolls, and a roll is 1 to 12', () => {
		for (const [status, share] of [[0, 4 / 12], [1, 6 / 12], [2, 7 / 12], [3, 8 / 12]] as const) {
			const p = at(status);
			const state = makeState(p, {}, 7 + status);
			let hits = 0;
			const seen = new Set<number>();
			for (let i = 0; i < 6000; i += 1) {
				if (rollInitiativeDie(state, p, frozen, [], 'You roll')) hits += 1;
				seen.add(p.initiativeRoll!);
			}
			expect(Math.abs(hits / 6000 - share)).toBeLessThan(0.025);
			expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		}
	});
});

describe('initiative: a fight with a monster (the monster always has the initiative)', () => {
	/** A fight whose hit corrupts the player (Barrier 3, hit 5): whether the player's damage landed. */
	const corruptingFight = (status: number, seed: number, spirits: PrivatePlayerState['spirits'] = []) => {
		const p = at(status, { barrier: 3, maxBarrier: 6, spirits, monsterHand: [monster(40, 5)] } as never);
		const res = fightMonster(makeState(p, {}, seed), 'Red', frozen, 0)!;
		return { res, roll: p.initiativeRoll, log: res.log.join(' / ') };
	};
	it('with the initiative the damage lands despite the corruption; without it the monster attacks first and the player cannot attack back', () => {
		for (const status of [0, 2]) {
			let hits = 0;
			for (const seed of SEEDS) {
				const { res, roll, log } = corruptingFight(status, seed);
				const hit = roll! <= initiativeHits(status);
				if (hit) hits += 1;
				expect(res.corrupted).toBe(true);
				expect(res.playerDamage > 0).toBe(hit);
				expect(log.includes('You attack at the same time as the monster')).toBe(hit);
				expect(log.includes('Corrupted players cannot strike back this combat.')).toBe(!hit);
				expect(log).not.toContain('You attack first');
			}
			expect(Math.abs(hits / SEEDS.length - initiativeHits(status) / 12)).toBeLessThan(0.07);
		}
	});
	it('the player never attacks before the monster: its hit lands even when the player kills it', () => {
		for (const seed of SEEDS.slice(0, 100)) {
			const p = at(3, { monsterHand: [monster(1, 2)] } as never);
			const res = fightMonster(makeState(p, {}, seed), 'Red', frozen, 0)!;
			expect(res.killed).toBe(true);
			expect(res.barrierLost).toBe(2);
		}
	});
	it('Feral and Spellblade gain the initiative when the die misses (same time, never first)', () => {
		for (const cls of ['Feral', 'Spellblade']) {
			let covered = 0;
			for (const seed of SEEDS.slice(0, 200)) {
				const { res, roll, log } = corruptingFight(0, seed, [spirit(1, { [cls]: 1 })]);
				expect(res.playerDamage).toBeGreaterThan(0);
				expect(res.barrierLost).toBeGreaterThan(0);
				if (roll! > initiativeHits(0)) {
					covered += 1;
					expect(log).toContain('You gain the initiative through an ability.');
				}
				expect(log).not.toMatch(/strike first|strikes first|attacks first\.|attack first/);
			}
			expect(covered).toBeGreaterThan(100);
		}
	});
	it('no class gives an initiative number', () => {
		const p = at(0, { spirits: [spirit(1, { Fighter: 5, Fairy: 1, Titan: 1, Huntress: 1, Monk: 1, Firetail: 1, Paladin: 1 })], monsterHand: [monster(40, 1)] } as never);
		const res = fightMonster(makeState(p), 'Red', frozen, 0)!;
		expect(res.log.join(' / ')).not.toMatch(/Gained \d+ initiative/);
		expect([0, 1]).toContain(p.initiative);
	});
	it('one die per player: the same time on a hit, the monster first on a miss', () => {
		for (const seed of SEEDS.slice(0, 200)) {
			const p = at(1, { monsterHand: [monster(40, 1)] } as never);
			const res = fightMonster(makeState(p, {}, seed), 'Red', frozen, 0)!;
			const hit = p.initiativeRoll! <= 6;
			expect(p.initiative).toBe(hit ? 1 : 0);
			expect(res.log.join(' / ')).toContain(hit ? 'Test Monster has the initiative too — you attack at the same time.' : 'Test Monster has the initiative and attacks first.');
		}
	});
});

describe('initiative: what the players read', () => {
	it('no class text names an initiative number or "strike first"', () => {
		expect(CLASSES.length).toBeGreaterThan(40);
		for (const c of CLASSES) {
			for (const tier of c.effect_schema) {
				const t = (tier.effects ?? []).map((e) => e.description).join(' ');
				expect(t, c.name).not.toMatch(/\d+ (combat )?initiative|strikes? first|attack first/i);
				expect(t.trim(), c.name).not.toBe('');
			}
		}
	});
	it('the changed cards', () => {
		expect(classText('Fighter', 1)).toBe('No effect at this count.');
		expect(classText('Fighter', 3)).toBe('On Rest, gain 2 Basic Attack Dice.');
		expect(classText('Fairy')).toBe("When Awakened, gain 1 Enchanted Attack for every spirit matching this Fairy's origin.");
		expect(classText('Monk')).toBe('While you are not Evil and have no Cursed Spirits, take 2 less damage.');
		expect(classText('Huntress')).toBe("On this spirit's Awakening, gain 3 Arcane Attack Dice.");
		expect(classText('Titan')).toBe('When you take damage, take 6 less. Gain 6 damage.');
		expect(classText('Corruptor')).not.toMatch(/initiative/i);
		expect(classText('Spellblade')).toBe('On Navigation Reveal, you may change your destination. In combat, gain the initiative if your side does not have it.');
		expect(classText('Assassin')).toBe('In combat with a player who has more attack dice than you, deal 3 more damage.');
		expect(navigationPowerById('sudden-strike')?.text).toBe('In your battles this round, gain the initiative if your side does not have it.');
		expect(navigationPowerPool().find((p) => p.id === 'sudden-strike')?.text).toContain('gain the initiative');
	});
	it('the rules text explains the die and the chances by status', () => {
		const brief = buildRulesBrief(frozen);
		expect(brief).toContain('Every player has ONE initiative die with 12 sides and can never get more');
		expect(brief).toContain('Pure 4 of 12 (33 %), Tainted 6 of 12 (50 %), Corrupt 7 of 12 (58 %), Fallen 8 of 12 (67 %)');
		expect(brief).toContain('Monsters always have the initiative: against a monster your one die decides');
		expect(brief).toContain('The monster always has the initiative, so you never attack before it');
		expect(brief).not.toMatch(/strike first|strikes first/);
	});
});

describe('firetailDamage: "In a round when another player is at your location, deal 3 more damage in combat." (Michael, 2026-11-26)', () => {
	/** A Firetail holder at the Arcane Abyss with 4 Exalted dice fights a monster; Blue is at `blueAt`. Returns the damage dealt. */
	const fight = (blueAt: string | null, seed = 3) => {
		const p = at(0, { navigationDestination: 'Arcane Abyss', spirits: [spirit(1, { Firetail: 1 })], monsterHand: [monster(60, 1)] } as never);
		const plain = at(0, { navigationDestination: 'Arcane Abyss', monsterHand: [monster(60, 1)] } as never);
		const blue = () => at(0, { playerColor: 'Blue', navigationDestination: blueAt } as never);
		const withFox = fightMonster(makeState(p, { Blue: blue() }, seed), 'Red', frozen, 0)!;
		const without = fightMonster(makeState(plain, { Blue: blue() }, seed), 'Red', frozen, 0)!;
		return { more: withFox.playerDamage - without.playerDamage, log: withFox.log.join(' / ') };
	};
	it('monster fight: 3 more damage with another player at the location, none alone', () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			expect(fight('Arcane Abyss', seed).more).toBe(3);
			expect(fight('Forest Region', seed).more).toBe(0);
			expect(fight(null, seed).more).toBe(0);
		}
		expect(fight('Arcane Abyss').log).toContain('Firetail: another player is at your location — deal 3 more damage.');
		expect(fight('Arcane Abyss').log).not.toMatch(/Gained \d+ initiative/);
	});
	it('player fight: the holder deals 3 more, as attacker and as defender', () => {
		for (const holder of ['Red', 'Blue'] as const) {
			const mk = (fox: boolean) => {
				const red = at(3, { navigationDestination: 'Fire Region', spirits: fox && holder === 'Red' ? [spirit(1, { Firetail: 1 })] : [] } as never);
				const blue = at(0, { playerColor: 'Blue', navigationDestination: 'Fire Region', spirits: fox && holder === 'Blue' ? [spirit(1, { Firetail: 1 })] : [] } as never);
				const combat = resolveEncounterCombat(makeState(red, { Blue: blue }, 11), frozen, ['Red'], ['Blue']);
				return combat.sides.find((s) => s.seat === holder)!.damageDealt;
			};
			expect(mk(true) - mk(false)).toBe(3);
		}
	});
	it('the printed text in the game data', () => {
		expect(classText('Firetail')).toBe('In a round when another player is at your location, deal 3 more damage in combat.');
	});
});

describe('initiative adds up per side: "have it such that iniative values can add up ... if 2 good roll 1 initiative, then they will have 2 iniative and possibly win" (Michael, 2026-11-27)', () => {
	/** Red (Fallen, the attacker) against Blue and, when `green` is given, Green on the Good side. */
	const fight = (seed: number, o: { red?: Partial<PrivatePlayerState>; blue?: Partial<PrivatePlayerState>; green?: Partial<PrivatePlayerState> | null; orange?: Partial<PrivatePlayerState> | null } = {}) => {
		const r = at(3, o.red ?? {});
		const b = at(0, { playerColor: 'Blue', ...(o.blue ?? {}) } as never);
		const g = o.green === null || o.green === undefined ? null : at(0, { playerColor: 'Green', ...o.green } as never);
		const or = o.orange === null || o.orange === undefined ? null : at(3, { playerColor: 'Orange', ...o.orange } as never);
		const state = makeState(r, { Blue: b, ...(g ? { Green: g } : {}), ...(or ? { Orange: or } : {}) }, seed);
		const combat = resolveEncounterCombat(state, frozen, ['Red', ...(or ? ['Orange'] : [])] as SeatColor[], ['Blue', ...(g ? ['Green'] : [])] as SeatColor[]);
		return { r, b, g, or, combat, log: combat.log.join(' / ') };
	};
	const first = (log: string) => (/Evil has more initiative \(\d against \d\) and attacks first\./.test(log) ? 'evil' : /Good has more initiative \(\d against \d\) and attacks first\./.test(log) ? 'good' : /Both sides have \d initiative — they attack at the same time\./.test(log) ? 'same' : 'other');

	it('1 Evil against 2 Good: the Good side adds up its dice, and with 2 against 1 it attacks first', () => {
		const n = { evil: 0, good: 0, same: 0, other: 0 };
		let twoOne = 0;
		for (const seed of SEEDS) {
			const { r, b, g, log, combat } = fight(seed, { green: {} });
			const e = r.initiativeRoll! <= 8 ? 1 : 0;
			const good = (b.initiativeRoll! <= 4 ? 1 : 0) + (g!.initiativeRoll! <= 4 ? 1 : 0);
			const o = first(log);
			n[o] += 1;
			expect(o).toBe(e > good ? 'evil' : good > e ? 'good' : 'same');
			expect(combat.sides.map((s) => s.initiative)).toEqual([e, good, good]);
			expect(log).toContain(`Good has ${good} initiative in all.`);
			if (e === 1 && good === 2) { twoOne += 1; expect(log).toContain('Good has more initiative (2 against 1) and attacks first.'); }
		}
		expect(twoOne).toBeGreaterThan(20);
		// Fallen 8 of 12 against two Pure at 4 of 12: Evil first 8/27, Good first 7/27, same time 12/27.
		expect(Math.abs(n.evil / SEEDS.length - 8 / 27)).toBeLessThan(0.07);
		expect(Math.abs(n.good / SEEDS.length - 7 / 27)).toBeLessThan(0.07);
		expect(Math.abs(n.same / SEEDS.length - 12 / 27)).toBeLessThan(0.07);
		expect(n.other).toBe(0);
	});
	it('one against one: 1 against 0 attacks first; 0 and 0, or 1 and 1, at the same time', () => {
		const n = { evil: 0, good: 0, same: 0, other: 0 };
		for (const seed of SEEDS) {
			const { r, b, log, combat } = fight(seed);
			const e = r.initiativeRoll! <= 8 ? 1 : 0, g = b.initiativeRoll! <= 4 ? 1 : 0;
			const o = first(log);
			n[o] += 1;
			expect(o).toBe(e > g ? 'evil' : g > e ? 'good' : 'same');
			if (e === g) expect(log).toContain(`Both sides have ${e} initiative — they attack at the same time.`);
			expect(log).not.toContain('initiative in all');
			expect(combat.sides.map((s) => s.initiative)).toEqual([e, g]);
			expect(combat.sides.map((s) => s.initiativeRoll)).toEqual([r.initiativeRoll, b.initiativeRoll]);
		}
		// Fallen (8 of 12) against Pure (4 of 12): first 4/9, same time 4/9, second 1/9.
		expect(Math.abs(n.evil / SEEDS.length - 4 / 9)).toBeLessThan(0.07);
		expect(Math.abs(n.same / SEEDS.length - 4 / 9)).toBeLessThan(0.07);
		expect(Math.abs(n.good / SEEDS.length - 1 / 9)).toBeLessThan(0.05);
		expect(n.other).toBe(0);
	});
	it('at the same time both hits land, even on a player the other hit corrupts', () => {
		let seen = 0;
		for (const seed of SEEDS) {
			const { r, b, combat, log } = fight(seed, { red: { barrier: 1, maxBarrier: 4 }, blue: { barrier: 1, maxBarrier: 4 } });
			if (first(log) !== 'same') continue;
			seen += 1;
			expect(combat.sides.every((s) => s.corrupted && s.damageDealt > 0)).toBe(true);
			expect(r.corruptionCount).toBe(1);
			expect(b.corruptionCount).toBe(1);
		}
		expect(seen).toBeGreaterThan(100);
	});
	it('Feral and Spellblade on the defender: its side always has initiative, so the attacker is never first', () => {
		for (const cls of ['Feral', 'Spellblade']) {
			const seen = new Set<string>();
			for (const seed of SEEDS.slice(0, 300)) {
				const { b, log } = fight(seed, { blue: { spirits: [spirit(1, { [cls]: 1 })] } });
				const o = first(log);
				seen.add(o);
				expect(['good', 'same']).toContain(o);
				if (b.initiativeRoll! > 4) expect(log).toContain('Good gains the initiative through an ability.');
			}
			expect([...seen].sort()).toEqual(['good', 'same']);
		}
	});
	it('Firecracker: the armed use covers a missed die in that combat and is spent', () => {
		for (const seed of SEEDS.slice(0, 200)) {
			const { b, log } = fight(seed, { blue: { strikeFirstCharges: 1 } as never });
			expect(['good', 'same']).toContain(first(log));
			expect(log).toContain('Blue Firecracker: gains the initiative in this combat if the die misses.');
			expect(b.strikeFirstCharges).toBe(0);
		}
	});
	it('Assassin: 3 more damage against a player with more attack dice, and no strike first', () => {
		const seen = new Set<string>();
		for (const seed of SEEDS.slice(0, 300)) {
			const { r, b, log } = fight(seed, { red: { attackDice: dice(1), spirits: [spirit(1, { Assassin: 1 })] }, blue: { attackDice: dice(5) } });
			const e = r.initiativeRoll! <= 8 ? 1 : 0, g = b.initiativeRoll! <= 4 ? 1 : 0;
			expect(log).toContain('Assassin: Blue has more attack dice — deal 3 more.');
			expect(log).not.toContain('strike first');
			expect(first(log)).toBe(e > g ? 'evil' : g > e ? 'good' : 'same');
			seen.add(first(log));
		}
		expect(seen.has('good')).toBe(true);
	});
	it('"gain the initiative if your side does not have it" makes 0 into 1, never more', () => {
		let covered = 0, beaten = 0;
		for (const seed of SEEDS) {
			const { r, b, g, log, combat } = fight(seed, { red: { spirits: [spirit(1, { Spellblade: 1 })] }, green: {} });
			const rolled = r.initiativeRoll! <= 8 ? 1 : 0;
			const good = (b.initiativeRoll! <= 4 ? 1 : 0) + (g!.initiativeRoll! <= 4 ? 1 : 0);
			expect(combat.sides[0].initiative).toBe(1);
			if (!rolled) { covered += 1; expect(log).toContain('Evil gains the initiative through an ability.'); }
			if (good === 2) { beaten += 1; expect(first(log)).toBe('good'); }
		}
		expect(covered).toBeGreaterThan(100);
		expect(beaten).toBeGreaterThan(30);
	});
	it('Paladin: the same initiative of 1 or more means its side attacks first; 0 and 0 stays at the same time', () => {
		const n = { tie1: 0, tie2: 0, zero: 0 };
		for (const seed of SEEDS) {
			const { r, b, g, or, log } = fight(seed, { blue: { spirits: [spirit(1, { Paladin: 1 })] }, green: {}, orange: {} });
			const e = (r.initiativeRoll! <= 8 ? 1 : 0) + (or!.initiativeRoll! <= 8 ? 1 : 0);
			const good = (b.initiativeRoll! <= 4 ? 1 : 0) + (g!.initiativeRoll! <= 4 ? 1 : 0);
			if (e !== good) { expect(first(log)).toBe(e > good ? 'evil' : 'good'); continue; }
			if (e === 0) { n.zero += 1; expect(log).toContain('Both sides have 0 initiative — they attack at the same time.'); continue; }
			if (e === 1) n.tie1 += 1; else n.tie2 += 1;
			expect(log).toContain(`Both sides have ${e} initiative — Good attacks first through Paladin.`);
		}
		expect(n.tie1).toBeGreaterThan(30);
		expect(n.tie2).toBeGreaterThan(5);
		expect(n.zero).toBeGreaterThan(5);
	});
	it('Bastion halves when the other side has more initiative; Prince gains when its side has more', () => {
		let halved = 0, twoOne = 0;
		for (const seed of SEEDS) {
			const { r, or, b, log } = fight(seed, { red: { spirits: [spirit(1, { Prince: 1 })] }, blue: { spirits: [spirit(1, { Bastion: 1 })] }, orange: {} });
			const e = (r.initiativeRoll! <= 8 ? 1 : 0) + (or!.initiativeRoll! <= 8 ? 1 : 0), good = b.initiativeRoll! <= 4 ? 1 : 0;
			const h = log.includes("The opponent's side has more initiative than yours — incoming damage is halved.");
			const p = log.includes('Red Prince: its side has more initiative — deals 2 more damage.');
			expect(h).toBe(e > good);
			expect(p).toBe(e > good);
			if (h) halved += 1;
			if (e === 2 && good === 1 && h) twoOne += 1;
		}
		expect(halved).toBeGreaterThan(200);
		expect(twoOne).toBeGreaterThan(20);
	});
	it('the cards and the rules text in the words of the sum', () => {
		expect(classText('Paladin')).toBe('If both sides have the same initiative (1 or more), your side attacks first.');
		expect(classText('Prince')).toBe('When your side has more initiative than the enemy, deal 2 more damage.');
		expect(classText('Bastion')).toBe("If the opponent's side has more initiative than your side, or is a monster, when you Take Damage, half it (rounding up).");
		expect(classText('Feral')).toBe('When an Evil player or a monster attacks you, your side gains the initiative if it does not have it.');
		const brief = buildRulesBrief(frozen);
		expect(brief).toContain('two players on the same side who both hit have 2');
		expect(brief).toContain('The side with MORE initiative attacks first');
		expect(brief).toContain('a side with 0 initiative then has 1');
		expect(brief).not.toContain('has the initiative when any of its dice hits');
	});
});
