/**
 * Rule `initiativeDie` (Michael, 2026-11-26): initiative is one 12-sided die per player, not a number.
 * "initiaitve is no longer an integer value, its now a true/false where only one needs to hit";
 * "if you're pure, you have 3/12, then tainted is 5/12, corrupt is 7/12, fallen is 9/12";
 * "you also can't get more than 1 inittiative dice"; "monsters by default always have initiative";
 * "if both player hit initiaive, then both players attack at the same time";
 * "feral should be gain initiative if your side doesn't. same thing with spellblade, firecracker.
 * remove the strike first from assasin"; the wording is "gain the initiative".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fightMonster, resolveEncounterCombat, rollInitiativeDie } from './combat';
import { INITIATIVE_DIE_SIDES, initiativeHits, parseRules, ruleAdjustedClassSchema } from './rules';
import { buildRulesBrief } from './agents/rulesBrief';
import { navigationPowerById, navigationPowerPool } from './navigationPowers';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import type { DiceTier, PlayCatalog, PlayRules, PrivatePlayerState, SeatColor } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const withRules = (rules: PlayRules | undefined): PlayCatalog => ({ ...frozen, rules });
const DIE = withRules({ initiativeDie: true });
const OFF = withRules({});
const STATUS = ['Pure', 'Tainted', 'Corrupt', 'Fallen'];
const dice = (n: number, tier: DiceTier = 'exalted') => Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier }));
const monster = (hp: number, damage: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, initiative: 100, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;
const at = (statusLevel: number, more: Partial<PrivatePlayerState> = {}): PrivatePlayerState =>
	makePlayer({ statusLevel, statusToken: STATUS[statusLevel], barrier: 10, maxBarrier: 10, attackDice: dice(4), ...more } as never);
const SEEDS = Array.from({ length: 600 }, (_, i) => i + 1);

describe('initiativeDie: the die', () => {
	it('has 12 sides; Pure 3, Tainted 5, Corrupt 7, Fallen 9 of them give the initiative', () => {
		expect(INITIATIVE_DIE_SIDES).toBe(12);
		expect([0, 1, 2, 3].map((s) => initiativeHits(DIE, s))).toEqual([3, 5, 7, 9]);
		expect([0, 1, 2, 3].map((s) => initiativeHits(withRules({ initiativeDie: true, numbers: { initiativeHits: [4, 4, 6, 8] } }), s))).toEqual([4, 4, 6, 8]);
		expect(parseRules({ numbers: { initiativeHits: [3, 5, 7, 13] } }).problems).toHaveLength(1);
		expect(parseRules({ numbers: { initiativeHits: [3, 5, 7] } }).problems).toHaveLength(1);
		expect(parseRules({ initiativeDie: true, numbers: { initiativeHits: [3, 5, 7, 9] } }).problems).toHaveLength(0);
	});
	it('hits in about 25, 42, 58 and 75 % of rolls, and a roll is 1 to 12', () => {
		for (const [status, share] of [[0, 3 / 12], [1, 5 / 12], [2, 7 / 12], [3, 9 / 12]] as const) {
			const p = at(status);
			const state = makeState(p, {}, 7 + status);
			let hits = 0;
			const seen = new Set<number>();
			for (let i = 0; i < 6000; i += 1) {
				if (rollInitiativeDie(state, p, DIE, [], 'You roll')) hits += 1;
				seen.add(p.initiativeRoll!);
			}
			expect(Math.abs(hits / 6000 - share)).toBeLessThan(0.025);
			expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		}
	});
});

describe('initiativeDie: a fight with a monster (the monster always has the initiative)', () => {
	/** A fight whose hit corrupts the player (Barrier 3, hit 5): whether the player's damage landed. */
	const corruptingFight = (catalog: PlayCatalog, status: number, seed: number, spirits: PrivatePlayerState['spirits'] = []) => {
		const p = at(status, { barrier: 3, maxBarrier: 6, spirits, monsterHand: [monster(40, 5)] } as never);
		const res = fightMonster(makeState(p, {}, seed), 'Red', catalog, 0)!;
		return { res, roll: p.initiativeRoll, log: res.log.join(' / ') };
	};
	it('with the initiative the damage lands despite the corruption; without it the monster attacks first and the player cannot attack back', () => {
		for (const status of [0, 2]) {
			let hits = 0;
			for (const seed of SEEDS) {
				const { res, roll, log } = corruptingFight(DIE, status, seed);
				const hit = roll! <= initiativeHits(DIE, status);
				if (hit) hits += 1;
				expect(res.corrupted).toBe(true);
				expect(res.playerDamage > 0).toBe(hit);
				expect(log.includes('You attack at the same time as the monster')).toBe(hit);
				expect(log.includes('Corrupted players cannot strike back this combat.')).toBe(!hit);
				expect(log).not.toContain('You attack first');
			}
			expect(Math.abs(hits / SEEDS.length - initiativeHits(DIE, status) / 12)).toBeLessThan(0.07);
		}
	});
	it('the player never attacks before the monster: its hit lands even when the player kills it', () => {
		for (const seed of SEEDS.slice(0, 100)) {
			const p = at(3, { monsterHand: [monster(1, 2)] } as never);
			const res = fightMonster(makeState(p, {}, seed), 'Red', DIE, 0)!;
			expect(res.killed).toBe(true);
			expect(res.barrierLost).toBe(2);
		}
	});
	it('Feral and Spellblade gain the initiative when the die misses (same time, never first); off: Feral strikes first', () => {
		for (const cls of ['Feral', 'Spellblade']) {
			let covered = 0;
			for (const seed of SEEDS.slice(0, 200)) {
				const { res, roll, log } = corruptingFight(DIE, 0, seed, [spirit(1, { [cls]: 1 })]);
				expect(res.playerDamage).toBeGreaterThan(0);
				expect(res.barrierLost).toBeGreaterThan(0);
				if (roll! > 3) {
					covered += 1;
					expect(log).toContain('You gain the initiative through an ability.');
				}
				expect(log).not.toMatch(/strike first|strikes first|attacks first\.|attack first/);
			}
			expect(covered).toBeGreaterThan(100);
		}
		const p = at(0, { spirits: [spirit(1, { Feral: 1 })], monsterHand: [monster(1, 2)] } as never);
		const off = fightMonster(makeState(p), 'Red', OFF, 0)!;
		expect(off.barrierLost).toBe(0);
		expect(off.log.join(' ')).toContain('You attack first');
	});
	it('no class gives an initiative number', () => {
		const p = at(0, { spirits: [spirit(1, { Fighter: 5, Fairy: 1, Titan: 1, Huntress: 1, Monk: 1, Firetail: 1, Paladin: 1 })], monsterHand: [monster(40, 1)] } as never);
		const res = fightMonster(makeState(p), 'Red', withRules({ initiativeDie: true, fighterInitiative: true, firetailVsMonsters: true }), 0)!;
		expect(res.log.join(' / ')).not.toMatch(/Gained \d+ initiative/);
		expect([0, 1]).toContain(p.initiative);
	});
});

describe('initiativeDie: an attack on players', () => {
	/** Red (Fallen, the attacker) against Blue; `blue` and `red` add to the two players. */
	const attack = (catalog: PlayCatalog, seed: number, red: Partial<PrivatePlayerState> = {}, blue: Partial<PrivatePlayerState> = {}, blueStatus = 0, more: Partial<Record<SeatColor, PrivatePlayerState>> = {}) => {
		const r = at(3, red);
		const b = at(blueStatus, { playerColor: 'Blue', ...blue } as never);
		const state = makeState(r, { Blue: b, ...more }, seed);
		const evil = ['Red', ...Object.keys(more)] as SeatColor[];
		const combat = resolveEncounterCombat(state, catalog, evil, ['Blue']);
		return { r, b, combat, log: combat.log.join(' / '), state };
	};
	const outcome = (log: string) =>
		log.includes('Evil has the initiative and attacks first.') ? 'evil'
			: log.includes('Good has the initiative and attacks first.') ? 'good'
			: log.includes('Both sides have the initiative — they attack at the same time.') ? 'both'
			: log.includes('Neither side has the initiative — they attack at the same time.') ? 'neither'
			: 'other';
	it('one side with the initiative attacks first; both or neither: at the same time', () => {
		const n = { evil: 0, good: 0, both: 0, neither: 0, other: 0 };
		for (const seed of SEEDS) {
			const { r, b, log, combat } = attack(DIE, seed);
			const redHit = r.initiativeRoll! <= 9, blueHit = b.initiativeRoll! <= 3;
			const o = outcome(log);
			n[o] += 1;
			expect(o).toBe(redHit && blueHit ? 'both' : redHit ? 'evil' : blueHit ? 'good' : 'neither');
			expect(combat.sides.map((s) => s.initiative)).toEqual([redHit ? 1 : 0, blueHit ? 1 : 0]);
			expect(combat.sides.map((s) => s.initiativeRoll)).toEqual([r.initiativeRoll, b.initiativeRoll]);
		}
		// Fallen (9 of 12) against Pure (3 of 12): first 56 %, same time 38 %, second 6 %.
		expect(Math.abs(n.evil / SEEDS.length - 0.5625)).toBeLessThan(0.07);
		expect(Math.abs((n.both + n.neither) / SEEDS.length - 0.375)).toBeLessThan(0.07);
		expect(Math.abs(n.good / SEEDS.length - 0.0625)).toBeLessThan(0.04);
	});
	it('at the same time both hits land, even on a player the other hit corrupts', () => {
		let seen = 0;
		for (const seed of SEEDS) {
			const { r, b, combat, log } = attack(DIE, seed, { barrier: 1, maxBarrier: 4 }, { barrier: 1, maxBarrier: 4 });
			if (!['both', 'neither'].includes(outcome(log))) continue;
			seen += 1;
			expect(combat.sides.every((s) => s.corrupted && s.damageDealt > 0)).toBe(true);
			expect(r.corruptionCount).toBe(1);
			expect(b.corruptionCount).toBe(1);
		}
		expect(seen).toBeGreaterThan(100);
	});
	it('several attackers: the side has the initiative when any of its dice hits', () => {
		for (const seed of SEEDS.slice(0, 300)) {
			const orange = at(3, { playerColor: 'Orange' } as never);
			const { r, b, log } = attack(DIE, seed, {}, {}, 0, { Orange: orange });
			const evilHit = r.initiativeRoll! <= 9 || orange.initiativeRoll! <= 9, blueHit = b.initiativeRoll! <= 3;
			expect(outcome(log)).toBe(evilHit && blueHit ? 'both' : evilHit ? 'evil' : blueHit ? 'good' : 'neither');
		}
	});
	it('Paladin: when both sides have the initiative its side attacks first; when neither has it, at the same time', () => {
		const n = { first: 0, neither: 0 };
		for (const seed of SEEDS) {
			const { r, b, log } = attack(DIE, seed, {}, { spirits: [spirit(1, { Paladin: 1 })] });
			const redHit = r.initiativeRoll! <= 9, blueHit = b.initiativeRoll! <= 3;
			if (redHit && blueHit) {
				n.first += 1;
				expect(log).toContain('Both sides have the initiative — Good attacks first through Paladin.');
			} else if (!redHit && !blueHit) {
				n.neither += 1;
				expect(outcome(log)).toBe('neither');
			} else expect(outcome(log)).toBe(redHit ? 'evil' : 'good');
			expect(log).not.toMatch(/Gained \d+ initiative/);
		}
		expect(n.first).toBeGreaterThan(50);
		expect(n.neither).toBeGreaterThan(20);
	});
	it('Feral and Spellblade on the defender: its side always has the initiative, so the attacker is never first', () => {
		for (const cls of ['Feral', 'Spellblade']) {
			const seen = new Set<string>();
			for (const seed of SEEDS.slice(0, 300)) {
				const { b, log } = attack(DIE, seed, {}, { spirits: [spirit(1, { [cls]: 1 })] });
				const o = outcome(log);
				seen.add(o);
				expect(['good', 'both']).toContain(o);
				if (b.initiativeRoll! > 3) expect(log).toContain('Good gains the initiative through an ability.');
			}
			expect([...seen].sort()).toEqual(['both', 'good']);
		}
	});
	it('Firecracker: the armed use covers a missed die in that combat and is spent', () => {
		for (const seed of SEEDS.slice(0, 200)) {
			const { r, b, log } = attack(DIE, seed, {}, { strikeFirstCharges: 1 } as never);
			expect(['good', 'both']).toContain(outcome(log));
			expect(log).toContain('Blue Firecracker: gains the initiative in this combat if the die misses.');
			expect(b.strikeFirstCharges).toBe(0);
			void r;
		}
	});
	it('Assassin: 3 more damage against a player with more attack dice, and no strike first', () => {
		const seen = new Set<string>();
		for (const seed of SEEDS.slice(0, 300)) {
			const { r, b, log } = attack(DIE, seed, { attackDice: dice(1), spirits: [spirit(1, { Assassin: 1 })] }, { attackDice: dice(5) });
			const redHit = r.initiativeRoll! <= 9, blueHit = b.initiativeRoll! <= 3;
			expect(log).toContain('Assassin: Blue has more attack dice — deal 3 more.');
			expect(log).not.toContain('strike first');
			expect(outcome(log)).toBe(redHit && blueHit ? 'both' : redHit ? 'evil' : blueHit ? 'good' : 'neither');
			seen.add(outcome(log));
		}
		expect(seen.has('good')).toBe(true);
	});
	it('Bastion halves when only the opponent has the initiative; Prince gains only when its side alone has it', () => {
		let halved = 0, prince = 0;
		for (const seed of SEEDS) {
			const { log } = attack(DIE, seed, { spirits: [spirit(1, { Prince: 1 })] }, { spirits: [spirit(1, { Bastion: 1 })] });
			const o = outcome(log);
			const h = log.includes('The opponent has the initiative and your side does not — incoming damage is halved.');
			const p = log.includes('Red Prince: only its side has the initiative — deals 2 more damage.');
			expect(h).toBe(o === 'evil');
			expect(p).toBe(o === 'evil');
			if (h) halved += 1;
			if (p) prince += 1;
		}
		expect(halved).toBeGreaterThan(200);
		expect(prince).toBe(halved);
	});
	it('off: the numbers decide, as before', () => {
		const { log } = attack(OFF, 1, { spirits: [spirit(1, { Paladin: 1 })] });
		expect(log).toMatch(/Evil is faster \(initiative \d+ vs 0\) and strikes first\./);
		expect(log).not.toContain('initiative die');
	});
});

describe('initiativeDie: what the players read', () => {
	/** The text of a class under the switch, from the text it has today. */
	const text = (className: string, today: string) => {
		const schema = [{ count: 1, effects: [{ type: 'benefit', description: today }] }] as never;
		return (ruleAdjustedClassSchema(DIE, className, schema) ?? []).flatMap((t) => (t.effects ?? []).map((e) => e.description)).join(' ');
	};
	it('no class text of the lab cards names an initiative number or "strike first" (lab rules plus the switch)', () => {
		const classes = JSON.parse(readFileSync('data/classes.json', 'utf8')) as { name: string; effect_schema: never }[];
		const labRules = parseRules({ ...JSON.parse(readFileSync('data/rules.json', 'utf8')), initiativeDie: true }).rules;
		const lab = withRules(labRules);
		expect(classes.length).toBeGreaterThan(40);
		for (const c of classes) {
			for (const tier of ruleAdjustedClassSchema(lab, c.name, c.effect_schema) ?? []) {
				const t = (tier.effects ?? []).map((e) => e.description).join(' ');
				expect(t, c.name).not.toMatch(/\d+ (combat )?initiative|strikes? first|attack first/i);
				expect(t.trim(), c.name).not.toBe('');
			}
		}
	});
	it('the changed cards', () => {
		expect(text('Fighter', 'In combat, gain 1 combat initiative.')).toBe('No effect at this count.');
		expect(text('Fighter', 'In combat, gain 3 combat initiative. On Rest, gain 2 Basic Attack Dice.')).toBe('On Rest, gain 2 Basic Attack Dice.');
		expect(text('Fairy', "When Awakened, gain 1 Enchanted Attack for every spirit matching this Fairy's origin. Gain 3 Initiative.")).toBe("When Awakened, gain 1 Enchanted Attack for every spirit matching this Fairy's origin.");
		expect(text('Monk', 'While you are not Evil and have no Cursed Spirits, gain 3 Initiative and take 2 less damage.')).toBe('While you are not Evil and have no Cursed Spirits, take 2 less damage.');
		expect(text('Huntress', "Gain 2 initiative. On this spirit's Awakening, gain 3 Arcane Attack Dice.")).toBe("On this spirit's Awakening, gain 3 Arcane Attack Dice.");
		expect(text('Titan', 'When you take damage, take 6 less. Gain 6 damage and 6 Initiative.')).toBe('When you take damage, take 6 less. Gain 6 damage.');
		expect(text('Corruptor', 'Set your status to Fallen (this is not a corruption). Gain 2 Initiative.')).toBe('Set your status to Fallen (this is not a corruption).');
		expect(text('Firetail', 'In combat with a monster, or in a round when another player is at your location, gain 2 Initiative.')).toBe('No effect.');
		expect(text('Feral', 'When an Evil player or a monster attacks you, your side strikes first.')).toBe('When an Evil player or a monster attacks you, your side gains the initiative if it does not have it.');
		expect(text('Spellblade', 'On Navigation Reveal, you may change your destination and you may always attack first.')).toBe('On Navigation Reveal, you may change your destination. In combat, gain the initiative if your side does not have it.');
		expect(text('Assassin', 'In combat with a player who has more attack dice than you, strike first and deal 3 more damage.')).toBe('In combat with a player who has more attack dice than you, deal 3 more damage.');
		expect(text('Paladin', '+2 Initiative. If initiative is tied, your side strikes first.')).toBe('If both sides have the initiative, your side attacks first.');
		expect(text('Prince', 'When you strike first, deal 2 more damage.')).toBe('When your side has the initiative and the enemy does not, deal 2 more damage.');
		expect(text('Bastion', 'If the opponent has higher initiative, or is a monster, when you Take Damage, half it (rounding up).')).toBe('If the opponent has the initiative and your side does not, or is a monster, when you Take Damage, half it (rounding up).');
		expect(navigationPowerById('sudden-strike', DIE)?.text).toBe('In your battles this round, gain the initiative if your side does not have it.');
		expect(navigationPowerById('sudden-strike', OFF)?.text).toBe('In your battles this round, you strike first.');
		expect(navigationPowerPool(withRules({ initiativeDie: true, powerRework: true })).find((p) => p.id === 'sudden-strike')?.text).toContain('gain the initiative');
	});
	it('the rules text explains the die and the chances by status', () => {
		const brief = buildRulesBrief(DIE);
		expect(brief).toContain('Every player has ONE initiative die with 12 sides and can never get more');
		expect(brief).toContain('Pure 3 of 12 (25 %), Tainted 5 of 12 (42 %), Corrupt 7 of 12 (58 %), Fallen 9 of 12 (75 %)');
		expect(brief).toContain('Monsters always have the initiative.');
		expect(brief).toContain('The monster always has the initiative, so you never attack before it');
		expect(brief).not.toMatch(/strike first|strikes first/);
		expect(buildRulesBrief(OFF)).toContain('Initiative decides who strikes first in PvP.');
	});
});

describe('firetailDamage: "In a round when another player is at your location, deal 3 more damage in combat." (Michael, 2026-11-26)', () => {
	const FOX = withRules({ initiativeDie: true, firetailDamage: true });
	/** A Firetail holder at the Arcane Abyss with 4 Exalted dice fights a monster; Blue is at `blueAt`. Returns the damage dealt. */
	const fight = (catalog: PlayCatalog, blueAt: string | null, seed = 3) => {
		const p = at(0, { navigationDestination: 'Arcane Abyss', spirits: [spirit(1, { Firetail: 1 })], monsterHand: [monster(60, 1)] } as never);
		const plain = at(0, { navigationDestination: 'Arcane Abyss', monsterHand: [monster(60, 1)] } as never);
		const blue = () => at(0, { playerColor: 'Blue', navigationDestination: blueAt } as never);
		const withFox = fightMonster(makeState(p, { Blue: blue() }, seed), 'Red', catalog, 0)!;
		const without = fightMonster(makeState(plain, { Blue: blue() }, seed), 'Red', catalog, 0)!;
		return { more: withFox.playerDamage - without.playerDamage, log: withFox.log.join(' / ') };
	};
	it('monster fight: 3 more damage with another player at the location, none alone', () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			expect(fight(FOX, 'Arcane Abyss', seed).more).toBe(3);
			expect(fight(FOX, 'Forest Region', seed).more).toBe(0);
			expect(fight(FOX, null, seed).more).toBe(0);
		}
		expect(fight(FOX, 'Arcane Abyss').log).toContain('Firetail: another player is at your location — deal 3 more damage.');
		expect(fight(FOX, 'Arcane Abyss').log).not.toMatch(/Gained \d+ initiative/);
	});
	it('player fight: the holder deals 3 more, as attacker and as defender', () => {
		for (const holder of ['Red', 'Blue'] as const) {
			const mk = (fox: boolean) => {
				const red = at(3, { navigationDestination: 'Fire Region', spirits: fox && holder === 'Red' ? [spirit(1, { Firetail: 1 })] : [] } as never);
				const blue = at(0, { playerColor: 'Blue', navigationDestination: 'Fire Region', spirits: fox && holder === 'Blue' ? [spirit(1, { Firetail: 1 })] : [] } as never);
				const combat = resolveEncounterCombat(makeState(red, { Blue: blue }, 11), FOX, ['Red'], ['Blue']);
				return combat.sides.find((s) => s.seat === holder)!.damageDealt;
			};
			expect(mk(true) - mk(false)).toBe(3);
		}
	});
	it('text, and off it is the old Firetail', () => {
		const schema = [{ count: 1, effects: [{ type: 'benefit', description: 'In a round when another player is at your location, gain 3 Initiative.' }] }] as never;
		const text = (c: PlayCatalog) => (ruleAdjustedClassSchema(c, 'Firetail', schema) ?? []).flatMap((t) => (t.effects ?? []).map((e) => e.description)).join(' ');
		expect(text(FOX)).toBe('In a round when another player is at your location, deal 3 more damage in combat.');
		expect(text(withRules({ firetailDamage: true }))).toBe('In a round when another player is at your location, deal 3 more damage in combat.');
		expect(text(DIE)).toBe('No effect.');
		expect(text(OFF)).toBe('In a round when another player is at your location, gain 3 Initiative.');
		expect(fight(OFF, 'Arcane Abyss').more).toBe(0);
		expect(fight(OFF, 'Arcane Abyss').log).toContain('Gained 3 initiative.');
	});
});

describe('initiativeSum: "have it such that iniative values can add up ... if 2 good roll 1 initiative, then they will have 2 iniative and possibly win" (Michael, 2026-11-27)', () => {
	const SUM = withRules({ initiativeDie: true, initiativeSum: true, numbers: { initiativeHits: [4, 6, 7, 8] } });
	/** Red (Fallen, the attacker) against Blue and, when `green` is given, Green on the Good side. */
	const fight = (catalog: PlayCatalog, seed: number, o: { red?: Partial<PrivatePlayerState>; blue?: Partial<PrivatePlayerState>; green?: Partial<PrivatePlayerState> | null; orange?: Partial<PrivatePlayerState> | null } = {}) => {
		const r = at(3, o.red ?? {});
		const b = at(0, { playerColor: 'Blue', ...(o.blue ?? {}) } as never);
		const g = o.green === null || o.green === undefined ? null : at(0, { playerColor: 'Green', ...o.green } as never);
		const or = o.orange === null || o.orange === undefined ? null : at(3, { playerColor: 'Orange', ...o.orange } as never);
		const state = makeState(r, { Blue: b, ...(g ? { Green: g } : {}), ...(or ? { Orange: or } : {}) }, seed);
		const combat = resolveEncounterCombat(state, catalog, ['Red', ...(or ? ['Orange'] : [])] as SeatColor[], ['Blue', ...(g ? ['Green'] : [])] as SeatColor[]);
		return { r, b, g, or, combat, log: combat.log.join(' / ') };
	};
	const first = (log: string) => (/Evil has more initiative \(\d against \d\) and attacks first\./.test(log) ? 'evil' : /Good has more initiative \(\d against \d\) and attacks first\./.test(log) ? 'good' : /Both sides have \d initiative — they attack at the same time\./.test(log) ? 'same' : 'other');

	it('the new chances: Pure 4, Tainted 6, Corrupt 7, Fallen 8 of 12', () => {
		expect([0, 1, 2, 3].map((level) => initiativeHits(SUM, level))).toEqual([4, 6, 7, 8]);
		expect(buildRulesBrief(SUM)).toContain('Pure 4 of 12 (33 %), Tainted 6 of 12 (50 %), Corrupt 7 of 12 (58 %), Fallen 8 of 12 (67 %)');
	});
	it('1 Evil against 2 Good: the Good side adds up its dice, and with 2 against 1 it attacks first', () => {
		const n = { evil: 0, good: 0, same: 0, other: 0 };
		let twoOne = 0;
		for (const seed of SEEDS) {
			const { r, b, g, log, combat } = fight(SUM, seed, { green: {} });
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
	it('without the switch the same fight is "any die": 2 Good hits against 1 Evil hit is at the same time', () => {
		const ANY = withRules({ initiativeDie: true, numbers: { initiativeHits: [4, 6, 7, 8] } });
		let seen = 0;
		for (const seed of SEEDS) {
			const { r, b, g, log, combat } = fight(ANY, seed, { green: {} });
			if (!(r.initiativeRoll! <= 8 && b.initiativeRoll! <= 4 && g!.initiativeRoll! <= 4)) continue;
			seen += 1;
			expect(log).toContain('Both sides have the initiative — they attack at the same time.');
			expect(combat.sides.map((s) => s.initiative)).toEqual([1, 1, 1]);
		}
		expect(seen).toBeGreaterThan(20);
	});
	it('one against one: 1 against 0 attacks first; 0 and 0, or 1 and 1, at the same time', () => {
		for (const seed of SEEDS.slice(0, 300)) {
			const { r, b, log } = fight(SUM, seed);
			const e = r.initiativeRoll! <= 8 ? 1 : 0, g = b.initiativeRoll! <= 4 ? 1 : 0;
			expect(first(log)).toBe(e > g ? 'evil' : g > e ? 'good' : 'same');
			if (e === g) expect(log).toContain(`Both sides have ${e} initiative — they attack at the same time.`);
			expect(log).not.toContain('initiative in all');
		}
	});
	it('"gain the initiative if your side does not have it" makes 0 into 1, never more', () => {
		let covered = 0, beaten = 0;
		for (const seed of SEEDS) {
			const { r, b, g, log, combat } = fight(SUM, seed, { red: { spirits: [spirit(1, { Spellblade: 1 })] }, green: {} });
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
			const { r, b, g, or, log } = fight(SUM, seed, { blue: { spirits: [spirit(1, { Paladin: 1 })] }, green: {}, orange: {} });
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
			const { r, or, b, log } = fight(SUM, seed, { red: { spirits: [spirit(1, { Prince: 1 })] }, blue: { spirits: [spirit(1, { Bastion: 1 })] }, orange: {} });
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
	it('a monster fight does not change: one die, the same time on a hit, the monster first on a miss', () => {
		for (const seed of SEEDS.slice(0, 200)) {
			const run = (catalog: PlayCatalog) => {
				const p = at(1, { monsterHand: [monster(40, 1)] } as never);
				const res = fightMonster(makeState(p, {}, seed), 'Red', catalog, 0)!;
				return { roll: p.initiativeRoll, init: p.initiative, log: res.log, barrier: p.barrier };
			};
			const sum = run(SUM), any = run(withRules({ initiativeDie: true, numbers: { initiativeHits: [4, 6, 7, 8] } }));
			expect(sum).toEqual(any);
			expect(sum.init).toBe(sum.roll! <= 6 ? 1 : 0);
		}
	});
	it('the cards and the rules text in the words of the sum', () => {
		const text = (className: string, description: string) =>
			(ruleAdjustedClassSchema(SUM, className, [{ count: 1, effects: [{ type: 'benefit', description }] }] as never) ?? []).flatMap((t) => (t.effects ?? []).map((e) => e.description)).join(' ');
		expect(text('Paladin', '+2 Initiative. If initiative is tied, your side strikes first.')).toBe('If both sides have the same initiative (1 or more), your side attacks first.');
		expect(text('Prince', 'When you strike first, deal 2 more damage.')).toBe('When your side has more initiative than the enemy, deal 2 more damage.');
		expect(text('Bastion', 'If the opponent has higher initiative, or is a monster, when you Take Damage, half it (rounding up).')).toBe("If the opponent's side has more initiative than your side, or is a monster, when you Take Damage, half it (rounding up).");
		expect(text('Feral', 'When an Evil player or a monster attacks you, your side strikes first.')).toBe('When an Evil player or a monster attacks you, your side gains the initiative if it does not have it.');
		const brief = buildRulesBrief(SUM);
		expect(brief).toContain('two players on the same side who both hit have 2');
		expect(brief).toContain('The side with MORE initiative attacks first');
		expect(brief).toContain('a side with 0 initiative then has 1');
		expect(brief).not.toContain('has the initiative when any of its dice hits');
		expect(buildRulesBrief(DIE)).toContain('has the initiative when any of its dice hits');
		const lab = parseRules(JSON.parse(readFileSync('data/rules.json', 'utf8')));
		expect(lab.problems).toEqual([]);
		expect(lab.rules?.initiativeSum).toBe(true);
		expect(lab.rules?.numbers?.initiativeHits).toEqual([4, 6, 7, 8]);
	});
});
