/**
 * The changes of 2026-11-20 (Michael), one rule switch each (rules.ts):
 * - buffedDice: stronger attack dice, averages 0.5 / 1 / 1.5 / 2, with a wide-spread Arcane die;
 * - fighterInitiative: Fighter gives 1 combat initiative per Fighter trait, up to 5, from one trait.
 * Each is checked on and off.
 */
import { describe, expect, it } from 'vitest';
import { BUFFED_DICE_TIER_FACES, DICE_TIER_FACES, diceTierFaces, expectedAttack, fightMonster, resetCombatFlags, rollAttack } from './combat';
import { applyTrigger } from './effects/apply';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import { attackLine } from './agents/view';
import type { DiceTier, PlayCatalog, PlayRules } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const withRules = (rules: PlayRules | undefined): PlayCatalog => ({ ...frozen, rules });
const dice = (...tiers: DiceTier[]) => tiers.map((tier, i) => ({ instanceId: `d${i}`, tier }));
const avg = (f: number[]) => f.reduce((a, b) => a + b, 0) / f.length;
const monster = (hp: number, damage: number, initiative: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, initiative, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;

describe('buffedDice: attack dice with averages 0.5, 1, 1.5 and 2', () => {
	const ON = withRules({ buffedDice: true });
	it('has six faces per die and the averages 0.5, 1, 1.5, 2', () => {
		expect(Object.values(BUFFED_DICE_TIER_FACES).map((f) => f.length)).toEqual([6, 6, 6, 6]);
		expect((['basic', 'enchanted', 'exalted', 'arcane'] as DiceTier[]).map((t) => avg(BUFFED_DICE_TIER_FACES[t]))).toEqual([0.5, 1, 1.5, 2]);
	});
	it('is off by default: the old dice, so recorded games replay', () => {
		expect(diceTierFaces(undefined)).toBe(DICE_TIER_FACES);
		expect(diceTierFaces(withRules(undefined))).toBe(DICE_TIER_FACES);
		expect(expectedAttack(makePlayer({ attackDice: dice('basic', 'basic', 'basic', 'exalted') }))).toBeCloseTo(2);
		const state = makeState(makePlayer({ attackDice: dice('arcane') }));
		const seen = new Set<number>();
		for (let i = 0; i < 200; i += 1) seen.add(rollAttack(state, state.players.Red!, withRules(undefined)));
		expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});
	it('on: the new averages, in the number shown to a player too', () => {
		expect(diceTierFaces(ON)).toBe(BUFFED_DICE_TIER_FACES);
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'enchanted', 'exalted', 'arcane') });
		expect(expectedAttack(p, ON)).toBeCloseTo(5.5);
		expect(attackLine(p as never, ON)).toContain('average 5.5 damage');
		expect(attackLine(p as never)).toContain('average 4.3 damage');
	});
	it('on: the Arcane die rolls 0, 1, 3 or 5, the Exalted die 1 or 2', () => {
		const rolls = (tier: DiceTier) => {
			const state = makeState(makePlayer({ attackDice: dice(tier) }));
			const seen = new Set<number>();
			for (let i = 0; i < 300; i += 1) seen.add(rollAttack(state, state.players.Red!, ON));
			return [...seen].sort((a, b) => a - b);
		};
		expect(rolls('arcane')).toEqual([0, 1, 3, 5]);
		expect(rolls('exalted')).toEqual([1, 2]);
		expect(rolls('enchanted')).toEqual([0, 1, 2]);
		expect(rolls('basic')).toEqual([0, 1]);
	});
});

describe('fighterInitiative: 1 combat initiative per Fighter trait, up to 5', () => {
	const ON = withRules({ fighterInitiative: true });
	const initiative = (catalog: PlayCatalog, fighters: number) => {
		const p = makePlayer({ spirits: [spirit(1, { Fighter: fighters })] });
		const state = makeState(p);
		resetCombatFlags(p);
		applyTrigger(state, 'Red', 'inCombat', [], { catalog });
		return p.initiative;
	};
	it('gives 1 to 5 initiative at 1 to 5 traits, and no more above 5', () => {
		expect([1, 2, 3, 4, 5, 6, 7].map((n) => initiative(ON, n))).toEqual([1, 2, 3, 4, 5, 5, 5]);
	});
	it('is off by default', () => {
		expect([1, 5].map((n) => initiative(withRules(undefined), n))).toEqual([0, 0]);
	});
	it('with 5 traits the player strikes before a monster of initiative 4, not one of initiative 5', () => {
		const first = (catalog: PlayCatalog, fighters: number, monsterInitiative: number) => {
			const p = makePlayer({ barrier: 9, maxBarrier: 9, attackDice: dice('basic'), spirits: [spirit(1, { Fighter: fighters })], monsterHand: [monster(50, 1, monsterInitiative)] });
			return fightMonster(makeState(p), 'Red', catalog, 0)!.log.some((l) => /attack first/i.test(l));
		};
		expect(first(ON, 5, 4)).toBe(true);
		expect(first(ON, 5, 5)).toBe(false);
		expect(first(ON, 4, 4)).toBe(false);
		expect(first(withRules(undefined), 5, 4)).toBe(false);
	});
	it('leaves the dice on Rest as they were', () => {
		const p = makePlayer({ spirits: [spirit(1, { Fighter: 5 })] });
		applyTrigger(makeState(p), 'Red', 'onRest', [], { catalog: ON });
		expect(p.attackDice.length).toBe(10);
	});
});
