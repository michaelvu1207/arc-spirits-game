/**
 * The changes of 2026-11-20 (Michael), one rule switch each (rules.ts):
 * - buffedDice: stronger attack dice, averages 0.5 / 1 / 1.5 / 2, with a wide-spread Arcane die;
 * - fighterInitiative: Fighter gives 1 combat initiative per Fighter trait, up to 5, from one trait;
 * - elementalistMethods: Elementalist upgrades an attack dice twice per action, one more action per
 *   breakpoint (monster kill, Rest, Cultivate, Spirit World Summon).
 * Each is checked on and off.
 */
import { describe, expect, it } from 'vitest';
import { BUFFED_DICE_TIER_FACES, DICE_TIER_FACES, diceTierFaces, expectedAttack, fightMonster, resetCombatFlags, rollAttack } from './combat';
import { applyGameCommand, createLobbyState } from './runtime';
import { buildLocationInteractions } from './locationInteractions';
import { applyTrigger } from './effects/apply';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import { attackLine } from './agents/view';
import type { DiceTier, GameActor, GameCommand, PlayCatalog, PlayRules, PublicGameState } from './types';

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

describe('elementalistMethods: two upgrades per action, one more action per breakpoint', () => {
	const ON = withRules({ elementalistMethods: true });
	const OFF = withRules(undefined);
	const tiers = (p: { attackDice: { tier: DiceTier }[] }) => p.attackDice.map((d) => d.tier).join(',');
	const pool = () => dice('basic', 'basic', 'enchanted', 'exalted', 'arcane');
	/** The pool after one `trigger` with `n` Elementalists. */
	const after = (catalog: PlayCatalog, n: number, trigger: 'onRest' | 'onCultivate' | 'onMonsterKill', combat?: { killed: boolean }) => {
		const p = makePlayer({ attackDice: pool(), spirits: [spirit(1, { Elementalist: n })] });
		applyTrigger(makeState(p), 'Red', trigger, [], { catalog, combat: combat ? { dealt: 5, overkill: 0, ...combat } : undefined });
		return tiers(p);
	};
	const START = 'basic,basic,enchanted,exalted,arcane';
	/** Two upgrades: the two Basic dice become Enchanted. */
	const TWO = 'enchanted,enchanted,enchanted,exalted,arcane';

	it('(2) a monster kill upgrades twice, the Abyss Lurker too; a fight without a kill does not', () => {
		expect(after(ON, 2, 'onMonsterKill', { killed: true })).toBe(TWO);
		expect(after(ON, 1, 'onMonsterKill', { killed: true })).toBe(START);
		expect(after(ON, 5, 'onMonsterKill', { killed: false })).toBe(START);
	});
	it('(3) Rest and (4) Cultivate upgrade twice each, from their breakpoint on, and no more at 5', () => {
		expect(after(ON, 2, 'onRest')).toBe(START);
		expect(after(ON, 3, 'onRest')).toBe(TWO);
		expect(after(ON, 5, 'onRest')).toBe(TWO);
		expect(after(ON, 3, 'onCultivate')).toBe(START);
		expect(after(ON, 4, 'onCultivate')).toBe(TWO);
	});
	it('goes Basic to Enchanted to Exalted, lowest dice first, and never touches Exalted or Arcane', () => {
		const p = makePlayer({ attackDice: pool(), spirits: [spirit(1, { Elementalist: 3 })] });
		const state = makeState(p);
		applyTrigger(state, 'Red', 'onRest', [], { catalog: ON });
		applyTrigger(state, 'Red', 'onRest', [], { catalog: ON });
		expect(tiers(p)).toBe('exalted,exalted,enchanted,exalted,arcane');
		for (let i = 0; i < 3; i += 1) applyTrigger(state, 'Red', 'onRest', [], { catalog: ON });
		expect(tiers(p)).toBe('exalted,exalted,exalted,exalted,arcane');
	});
	it('ten Basic dice are ten Exalted dice after ten actions', () => {
		const p = makePlayer({ attackDice: dice(...Array.from({ length: 10 }, () => 'basic' as DiceTier)), spirits: [spirit(1, { Elementalist: 3 })] });
		const state = makeState(p);
		for (let i = 0; i < 9; i += 1) applyTrigger(state, 'Red', 'onRest', [], { catalog: ON });
		expect(p.attackDice.filter((d) => d.tier === 'exalted').length).toBe(8);
		applyTrigger(state, 'Red', 'onRest', [], { catalog: ON });
		expect(p.attackDice.every((d) => d.tier === 'exalted')).toBe(true);
	});
	it('a monster fight that kills upgrades, also against the permanent monster', () => {
		// Three old Arcane dice roll at least 3, so the Barrier 1 monster always dies.
		const fight = (permanent: boolean) => {
			const card = { ...(monster(1, 1, 0) as object), permanent } as never;
			const p = makePlayer({ barrier: 9, maxBarrier: 9, attackDice: dice('arcane', 'arcane', 'arcane', 'basic'), spirits: [spirit(1, { Elementalist: 2 })], monsterHand: [card] });
			expect(fightMonster(makeState(p), 'Red', ON, 0)!.killed).toBe(true);
			return tiers(p);
		};
		expect(fight(false)).toBe('arcane,arcane,arcane,exalted');
		expect(fight(true)).toBe('arcane,arcane,arcane,exalted');
	});
	it('(5) a Spirit World Summon at the Water Region upgrades twice', () => {
		const actor: GameActor = { memberId: 'host', role: 'host', displayName: 'Host', seatColor: 'Red' };
		const summon = (catalog: PlayCatalog, elementalists: number) => {
			const run = (state: PublicGameState, command: GameCommand) => {
				const result = applyGameCommand(state, actor, command, catalog);
				if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
				return result.state;
			};
			let state = createLobbyState({ roomCode: 'ELEM', guardianNames: catalog.guardians.map((g) => g.name) });
			state = run(state, { type: 'claimSeat', seatColor: 'Red' });
			state = run(state, { type: 'selectGuardian', guardianName: catalog.guardians[0].name });
			state = run(state, { type: 'startGame', seed: 21 });
			state.phase = 'location';
			const p = state.players.Red!;
			p.navigationDestination = 'Water Region';
			p.pendingPowerDrafts = [];
			p.actionsUsedThisRound = [];
			p.phaseReady = false;
			p.spirits = [spirit(1, { Elementalist: elementalists })];
			p.attackDice = dice('basic', 'basic', 'basic');
			const water = catalog.locations!.find((l) => l.name === 'Water Region')!;
			const row = buildLocationInteractions(water.rewardRows, 'Water Region').find((i) =>
				i.gains.some((g) => g.type === 'action' && g.action === 'spiritWorldSummon')
			)!;
			state = run(state, { type: 'resolveLocationInteraction', rowIndex: row.rowIndex });
			return tiers(state.players.Red!);
		};
		expect(summon(ON, 5)).toBe('enchanted,enchanted,basic');
		expect(summon(ON, 4)).toBe('basic,basic,basic');
		expect(summon(OFF, 5)).toBe('basic,basic,basic');
	});
	it('off by default: the old ladder of 1, 2, 5, 10 upgrades per Rest', () => {
		expect(after(OFF, 2, 'onRest')).toBe('enchanted,basic,enchanted,exalted,arcane');
		expect(after(OFF, 3, 'onRest')).toBe('enchanted,enchanted,enchanted,exalted,arcane');
		expect(after(OFF, 4, 'onRest')).toBe('exalted,exalted,exalted,exalted,arcane');
		expect(after(OFF, 5, 'onMonsterKill', { killed: true })).toBe(START);
		expect(after(OFF, 5, 'onCultivate')).toBe(START);
	});
});
