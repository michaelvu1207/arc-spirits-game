/**
 * The changes of 2026-11-20 (Michael), one rule switch each (rules.ts):
 * - buffedDice: stronger attack dice, averages 0.5 / 1 / 1.5 / 2, with a wide-spread Arcane die;
 * - fighterInitiative: Fighter gives 1 combat initiative per Fighter trait, up to 5, from one trait;
 * - elementalistMethods: Elementalist upgrades an attack dice twice per action, one more action per
 *   breakpoint (monster kill, Rest, Cultivate, Spirit World Summon).
 * - elementalistOneUpgrade: with elementalistMethods, one upgrade per action in place of two;
 * - restByStatus: Rest restores 2 Barrier plus 1 per status step above Fallen;
 * - fairyEnchanted: a Fairy's awakening gives Enchanted dice, not Exalted;
 * - cursedSpiritBasic: Cursed Spirit's Tainted reward gives Basic dice, not Enchanted.
 * The changes of 2026-11-21 (Michael):
 * - elementalistBigKills: a kill of a Difficulty 2 or 3 card upgrades an attack dice twice;
 * - battleAdeptNoDice: Battle Adept gains no attack dice when a fight does not kill;
 * - beastNoInitiative: Beast gives combat damage only, no combat initiative;
 * - spiritInitiativeTrim: Monk gives 3 Initiative, Paladin 2 and Firetail 2;
 * - arcaneBlood: a kill gives its rewards or Arcane Blood (1 / 2 / 3); Elementalist (2) upgrades per Arcane Blood.
 * Each is checked on and off.
 */
import { describe, expect, it } from 'vitest';
import { BUFFED_DICE_TIER_FACES, DICE_TIER_FACES, diceTierFaces, expectedAttack, fightMonster, resetCombatFlags, rollAttack } from './combat';
import { applyGameCommand, arcaneBloodFor, createLobbyState } from './runtime';
import { buildLocationInteractions } from './locationInteractions';
import { applyRest, applyTrigger } from './effects/apply';
import { cursedSpiritDiceTier, fairyDiceTier, restBarrier, ruleAdjustedClassSchema } from './rules';
import { buildRulesBrief } from './agents/rulesBrief';
import { enterBenefits } from './phases';
import { labelFor } from './agents/labels';
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

describe('restByStatus: Rest restores 2 Barrier plus 1 per status step above Fallen', () => {
	const ON = withRules({ restByStatus: true });
	/** Barrier restored by one Rest at `statusLevel`, from 0 of Max Barrier 9. */
	const restored = (catalog: PlayCatalog, statusLevel: number, maxBarrier = 9) => {
		const p = makePlayer({ barrier: 0, maxBarrier, brokenBarrier: maxBarrier, statusLevel });
		applyRest(makeState(p), 'Red', [], { catalog });
		return p.barrier;
	};
	it('restores 5, 4, 3, 2 at Pure, Tainted, Corrupt, Fallen', () => {
		expect([0, 1, 2, 3].map((s) => restored(ON, s))).toEqual([5, 4, 3, 2]);
		expect(restBarrier(ON, 0)).toBe(5);
		expect(restBarrier(ON, 3)).toBe(2);
	});
	it('never goes above Max Barrier', () => {
		expect(restored(ON, 0, 3)).toBe(3);
	});
	it('is off by default: 2 at every status', () => {
		expect([0, 1, 2, 3].map((s) => restored(withRules(undefined), s))).toEqual([2, 2, 2, 2]);
	});
	it('restBase4: the base is 4 (Pure 7, Tainted 6, Corrupt 5, Fallen 4; 4 at every status without restByStatus)', () => {
		const FOUR = withRules({ restByStatus: true, restBase4: true });
		expect([0, 1, 2, 3].map((s) => restored(FOUR, s))).toEqual([7, 6, 5, 4]);
		expect([0, 1, 2, 3].map((s) => restored(withRules({ restBase4: true }), s))).toEqual([4, 4, 4, 4]);
		expect(restored(FOUR, 0, 6)).toBe(6);
		expect(buildRulesBrief(FOUR)).toContain('Rest restores 4 Barrier plus 1 for each status step above Fallen (Pure 7, Tainted 6, Corrupt 5, Fallen 4');
		expect(buildRulesBrief(ON)).toContain('Rest restores 2 Barrier plus 1 for each status step above Fallen (Pure 5, Tainted 4, Corrupt 3, Fallen 2');
	});
});

describe('fairyEnchanted: a Fairy gives Enchanted dice when it awakens', () => {
	/** The dice a Fairy gives on awakening with two more spirits of its origin and one of another. */
	const awakenFairy = (catalog: PlayCatalog) => {
		const p = makePlayer({
			spirits: [
				spirit(1, { Fairy: 1 }, { origins: { Floral: 1 } }),
				spirit(2, { Fighter: 1 }, { origins: { Floral: 1 } }),
				spirit(3, { Healer: 1 }, { origins: { Floral: 1 } }),
				spirit(4, { Fighter: 1 }, { origins: { Tidal: 1 } })
			]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog, command: { slotIndex: 1 } });
		return { tiers: p.attackDice.map((d) => d.tier).join(','), initiative: p.initiative };
	};
	it('gives 1 Enchanted dice per spirit of its origin, and the 3 initiative as before', () => {
		expect(awakenFairy(withRules({ fairyEnchanted: true }))).toEqual({ tiers: 'enchanted,enchanted,enchanted', initiative: 3 });
		expect(fairyDiceTier(withRules({ fairyEnchanted: true }))).toBe('enchanted');
	});
	it('is off by default: Exalted dice', () => {
		expect(awakenFairy(withRules(undefined))).toEqual({ tiers: 'exalted,exalted,exalted', initiative: 3 });
		expect(fairyDiceTier(withRules(undefined))).toBe('exalted');
	});
});

describe('cursedSpiritBasic: the dice of the Tainted reward are Basic', () => {
	const actor: GameActor = { memberId: 'host', role: 'host', displayName: 'Host', seatColor: 'Red' };
	/** Two Cursed Spirits, Tainted this round; the claim takes `maxBarrier` units as Max Barrier and the rest as dice. */
	const claim = (catalog: PlayCatalog, maxBarrier: number) => {
		const p = makePlayer({ maxBarrier: 6, spirits: [spirit(1, { 'Cursed Spirit': 2 })], becameTaintedThisRound: true });
		const state = makeState(p);
		state.status = 'active';
		enterBenefits(state);
		state.phase = 'benefits';
		const command: GameCommand = { type: 'resolveAwakenReward', taintedMaxBarrier: maxBarrier };
		const label = labelFor(command, state as never, 'Red', catalog);
		const result = applyGameCommand(state, actor, command, catalog);
		if (!result.ok) throw new Error(result.error.message);
		const after = result.state.players.Red!;
		return { tiers: after.attackDice.map((d) => d.tier).join(','), maxBarrier: after.maxBarrier, label };
	};
	it('gives Basic dice, one per Cursed Spirit', () => {
		const ON = withRules({ cursedSpiritBasic: true });
		const all = claim(ON, 0);
		expect(all.tiers).toBe('basic,basic');
		expect(all.label).toContain('2 Basic dice');
		expect(cursedSpiritDiceTier(ON)).toBe('basic');
	});
	it('keeps the choice of Max Barrier', () => {
		expect(claim(withRules({ cursedSpiritBasic: true }), 1)).toMatchObject({ tiers: 'basic', maxBarrier: 7 });
	});
	it('is off by default: Enchanted dice', () => {
		const off = claim(withRules(undefined), 0);
		expect(off.tiers).toBe('enchanted,enchanted');
		expect(off.label).toContain('2 Enchanted dice');
	});
});

describe('elementalistOneUpgrade: one upgrade per action', () => {
	const ONE = withRules({ elementalistMethods: true, elementalistOneUpgrade: true });
	const tiers = (p: { attackDice: { tier: DiceTier }[] }) => p.attackDice.map((d) => d.tier).join(',');
	const after = (catalog: PlayCatalog, n: number, trigger: 'onRest' | 'onCultivate' | 'onMonsterKill') => {
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'enchanted', 'exalted', 'arcane'), spirits: [spirit(1, { Elementalist: n })] });
		applyTrigger(makeState(p), 'Red', trigger, [], { catalog, combat: trigger === 'onMonsterKill' ? { dealt: 5, overkill: 0, killed: true } : undefined });
		return tiers(p);
	};
	const ONCE = 'enchanted,basic,enchanted,exalted,arcane';
	it('a kill at 2, a Rest at 3 and a Cultivate at 4 Elementalists each upgrade one dice one step', () => {
		expect(after(ONE, 2, 'onMonsterKill')).toBe(ONCE);
		expect(after(ONE, 3, 'onRest')).toBe(ONCE);
		expect(after(ONE, 4, 'onCultivate')).toBe(ONCE);
	});
	it('keeps the breakpoints: no upgrade below them', () => {
		expect(after(ONE, 1, 'onMonsterKill')).toBe('basic,basic,enchanted,exalted,arcane');
		expect(after(ONE, 2, 'onRest')).toBe('basic,basic,enchanted,exalted,arcane');
	});
	it('does nothing without elementalistMethods, and two upgrades stay the default with it', () => {
		expect(after(withRules({ elementalistOneUpgrade: true }), 2, 'onMonsterKill')).toBe('basic,basic,enchanted,exalted,arcane');
		expect(after(withRules({ elementalistMethods: true }), 2, 'onMonsterKill')).toBe('enchanted,enchanted,enchanted,exalted,arcane');
	});
});

describe('elementalistBigKills: two upgrades for a Difficulty 2 or 3 kill', () => {
	const BIG = withRules({ elementalistMethods: true, elementalistOneUpgrade: true, elementalistBigKills: true });
	const tiers = (p: { attackDice: { tier: DiceTier }[] }) => p.attackDice.map((d) => d.tier).join(',');
	const START = 'basic,basic,enchanted,exalted,arcane';
	const kill = (catalog: PlayCatalog, n: number, monsterDifficulty: 1 | 2 | 3, monsterPermanent = false) => {
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'enchanted', 'exalted', 'arcane'), spirits: [spirit(1, { Elementalist: n })] });
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { catalog, combat: { dealt: 5, overkill: 0, killed: true, monsterDifficulty, monsterPermanent } });
		return tiers(p);
	};
	it('Difficulty 2 and 3 kills upgrade twice, a Difficulty 1 kill once', () => {
		expect(kill(BIG, 2, 1)).toBe('enchanted,basic,enchanted,exalted,arcane');
		expect(kill(BIG, 2, 2)).toBe('enchanted,enchanted,enchanted,exalted,arcane');
		expect(kill(BIG, 2, 3)).toBe('enchanted,enchanted,enchanted,exalted,arcane');
	});
	it('the Abyss Lurker (permanent monster) upgrades once whatever its Difficulty', () => {
		expect(kill(BIG, 2, 2, true)).toBe('enchanted,basic,enchanted,exalted,arcane');
	});
	it('needs 2 Elementalists and a kill', () => {
		expect(kill(BIG, 1, 3)).toBe(START);
		const p = makePlayer({ attackDice: dice('basic', 'basic'), spirits: [spirit(1, { Elementalist: 2 })] });
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { catalog: BIG, combat: { dealt: 5, overkill: 0, killed: false, monsterDifficulty: 3 } });
		expect(tiers(p)).toBe('basic,basic');
	});
	it('Rest and Cultivate keep one upgrade', () => {
		const p = makePlayer({ attackDice: dice('basic', 'basic'), spirits: [spirit(1, { Elementalist: 4 })] });
		applyTrigger(makeState(p), 'Red', 'onCultivate', [], { catalog: BIG });
		expect(tiers(p)).toBe('enchanted,basic');
	});
	it('is off by default: one upgrade for any kill with elementalistOneUpgrade, two without', () => {
		expect(kill(withRules({ elementalistMethods: true, elementalistOneUpgrade: true }), 2, 3)).toBe('enchanted,basic,enchanted,exalted,arcane');
		expect(kill(withRules({ elementalistMethods: true }), 2, 1)).toBe('enchanted,enchanted,enchanted,exalted,arcane');
		expect(kill(withRules({ elementalistBigKills: true }), 2, 3)).toBe(START);
	});
	it('a real fight passes the card\'s Difficulty: a Difficulty 2 card upgrades twice', () => {
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'exalted', 'exalted', 'exalted', 'exalted', 'exalted', 'exalted'), spirits: [spirit(1, { Elementalist: 2 })] });
		const state = makeState(p);
		const card = { ...(monster(1, 1, 0) as object), difficulty: 2 } as never;
		p.monsterHand = [card];
		fightMonster(state, 'Red', withRules({ ...BIG.rules, buffedDice: true }), 0);
		expect(tiers(p).split(',').filter((t) => t === 'basic').length).toBe(0);
	});
});

describe('battleAdeptNoDice: no attack dice for a fight that does not kill', () => {
	const fire = (catalog: PlayCatalog, combat: { dealt: number; overkill: number; killed: boolean }) => {
		const p = makePlayer({ spirits: [spirit(1, { 'Battle Adept': 1 })] });
		const before = p.maxBarrier;
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { catalog, combat });
		return { dice: p.attackDice.map((d) => d.tier).join(','), maxBarrier: p.maxBarrier - before };
	};
	it('on: a failed kill gives nothing, an overkill by 2 still gives 1 Max Barrier', () => {
		const ON = withRules({ battleAdeptNoDice: true });
		expect(fire(ON, { dealt: 1, overkill: 0, killed: false })).toEqual({ dice: '', maxBarrier: 0 });
		expect(fire(ON, { dealt: 9, overkill: 2, killed: true })).toEqual({ dice: '', maxBarrier: 1 });
	});
	it('is off by default: a failed kill gives 1 Enchanted dice', () => {
		expect(fire(withRules(undefined), { dealt: 1, overkill: 0, killed: false })).toEqual({ dice: 'enchanted', maxBarrier: 0 });
	});
});

describe('beastNoInitiative: Beast gives combat damage only', () => {
	const fire = (catalog: PlayCatalog, traits: Record<string, number>) => {
		const p = makePlayer({ spirits: [spirit(1, traits)] });
		const log: string[] = [];
		resetCombatFlags(p);
		applyTrigger(makeState(p), 'Red', 'inCombat', log, { catalog });
		return { damage: p.combatDamageBonus, initiative: p.initiative, log: log.join(' | ') };
	};
	it('on: 1 damage per Beast trait and no initiative', () => {
		const ON = withRules({ beastNoInitiative: true });
		const r = fire(ON, { Beast: 4 });
		expect([r.damage, r.initiative]).toEqual([4, 0]);
		expect(r.log).toContain('Gained +4 combat damage');
		expect(r.log).not.toContain('initiative');
	});
	it('on, with fighterInitiative: initiative comes from Fighter traits only', () => {
		const ON = withRules({ beastNoInitiative: true, fighterInitiative: true });
		const r = fire(ON, { Beast: 4, Fighter: 3 });
		expect([r.damage, r.initiative]).toEqual([4, 3]);
	});
	it('is off by default: 1 damage and 1 initiative per Beast trait', () => {
		const r = fire(withRules(undefined), { Beast: 4 });
		expect([r.damage, r.initiative]).toEqual([4, 4]);
	});
});

describe('spiritInitiativeTrim: Monk 3, Paladin 2, Firetail 2', () => {
	const initiative = (catalog: PlayCatalog, cls: string) => {
		const p = makePlayer({ spirits: [spirit(1, { [cls]: 1 })] });
		resetCombatFlags(p);
		applyTrigger(makeState(p), 'Red', 'inCombat', [], { catalog });
		return { initiative: p.initiative, ties: p.winsInitiativeTies === true, reduction: p.damageReduction ?? 0 };
	};
	const ON = withRules({ spiritInitiativeTrim: true, firetailVsMonsters: true });
	const OFF = withRules({ firetailVsMonsters: true });
	it('on: Monk 3 (still 2 less damage), Paladin 2 (still wins ties), Firetail 2 against a monster', () => {
		expect(initiative(ON, 'Monk')).toEqual({ initiative: 3, ties: false, reduction: 2 });
		expect(initiative(ON, 'Paladin')).toEqual({ initiative: 2, ties: true, reduction: 0 });
		expect(initiative(ON, 'Firetail').initiative).toBe(2);
	});
	it('is off by default: 5, 4 and 3', () => {
		expect(['Monk', 'Paladin', 'Firetail'].map((c) => initiative(OFF, c).initiative)).toEqual([5, 4, 3]);
	});
});

describe('arcaneBlood: the rewards of a kill, or Arcane Blood in their place', () => {
	const RULES: PlayRules = { elementalistMethods: true, elementalistOneUpgrade: true, elementalistBigKills: true, goodKillBonus: true };
	const ON = withRules({ ...RULES, arcaneBlood: true });
	const OFF = withRules(RULES);
	/** Red (2 Elementalists, 10 Basic dice) has just killed a card of `difficulty` worth 3 Victory Points. */
	const afterKill = (catalog: PlayCatalog, difficulty: 1 | 2 | 3, elementalists = 2) => {
		const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e'; // the "3 Victory Points" reward icon
		const p = makePlayer({
			barrier: 9, maxBarrier: 9, attackDice: dice(...Array<DiceTier>(10).fill('basic')),
			spirits: [spirit(1, { Elementalist: elementalists }), spirit(2, { Beast: 60 })],
			monsterHand: [{ ...(monster(1, 1, 0) as object), difficulty, rewardTrack: [VP3] } as never]
		});
		let state: PublicGameState = { ...makeState(p), status: 'active', phase: 'location' } as PublicGameState;
		p.navigationDestination = 'Arcane Abyss';
		const actor = { displayName: 'R', role: 'player', seatColor: 'Red' } as unknown as GameActor;
		const run = (command: GameCommand) => {
			const r = applyGameCommand(state, actor, command, catalog);
			if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
			state = r.state;
			return state.players.Red!;
		};
		return { run, me: () => state.players.Red!, state: () => state, actor };
	};
	const tiers = (p: { attackDice: { tier: string }[] }) => p.attackDice.filter((d) => d.tier !== 'basic').length;
	it('on: the kill itself upgrades nothing and offers 1 / 2 / 3 Arcane Blood by Difficulty', () => {
		for (const d of [1, 2, 3] as const) {
			const g = afterKill(ON, d);
			const me = g.run({ type: 'startCombat', handIndex: 0 });
			expect(me.pendingReward?.arcaneBlood).toBe(d);
			expect(tiers(me)).toBe(0);
		}
	});
	it('on: Arcane Blood gives one upgrade each and none of the rewards; the Good bonus stays', () => {
		const g = afterKill(ON, 3);
		g.run({ type: 'startCombat', handIndex: 0 });
		const vpAfterKill = g.me().victoryPoints; // the Good-alignment bonus of the kill
		const me = g.run({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true });
		expect(tiers(me)).toBe(3);
		expect(me.victoryPoints).toBe(vpAfterKill);
		expect(vpAfterKill).toBe(1);
		expect(me.pendingReward).toBeNull();
		expect(me.lastAction?.log.join(' | ')).toContain('Gained 3 Arcane Blood');
	});
	it('on: taking the rewards gives the points and no upgrade', () => {
		const g = afterKill(ON, 3);
		g.run({ type: 'startCombat', handIndex: 0 });
		const me = g.run({ type: 'resolveMonsterReward', picks: [] });
		expect(tiers(me)).toBe(0);
		expect(me.victoryPoints).toBe(1 + 3);
	});
	it('on: with one Elementalist the Arcane Blood upgrades nothing', () => {
		const g = afterKill(ON, 2, 1);
		g.run({ type: 'startCombat', handIndex: 0 });
		expect(tiers(g.run({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true }))).toBe(0);
	});
	it('on: the two choices read clearly for an AI player', () => {
		const g = afterKill(ON, 3);
		g.run({ type: 'startCombat', handIndex: 0 });
		const label = (c: GameCommand) => labelFor(c, g.state() as never, 'Red', ON);
		expect(label({ type: 'resolveMonsterReward', picks: [0] })).toContain('Claim every reward of Test Monster: 3 Victory Points');
		expect(label({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true })).toContain(
			'Take 3 Arcane Blood in place of every reward of Test Monster: Elementalist permanently upgrades an attack dice 3 times'
		);
	});
	it('arcaneBloodDouble: 2 / 4 / 6 Arcane Blood, one upgrade each', () => {
		const DOUBLE = withRules({ ...RULES, arcaneBlood: true, arcaneBloodDouble: true });
		for (const d of [1, 2, 3] as const) {
			const g = afterKill(DOUBLE, d);
			expect(g.run({ type: 'startCombat', handIndex: 0 }).pendingReward?.arcaneBlood).toBe(2 * d);
			expect(tiers(g.run({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true }))).toBe(2 * d);
		}
		expect(buildRulesBrief(DOUBLE)).toContain('2 for a Difficulty 1 card or the permanent monster, 4 for a Difficulty 2 card, 6 for a Difficulty 3 card');
		expect(buildRulesBrief(ON)).toContain('1 for a Difficulty 1 card or the permanent monster, 2 for a Difficulty 2 card, 3 for a Difficulty 3 card');
	});
	it('arcaneBloodTwoPerPoint: 2 for the permanent monster, 4 / 8 / 12 by Difficulty', () => {
		const TWO = withRules({ ...RULES, arcaneBlood: true, arcaneBloodDouble: true, arcaneBloodTwoPerPoint: true });
		for (const d of [1, 2, 3] as const) {
			const g = afterKill(TWO, d);
			expect(g.run({ type: 'startCombat', handIndex: 0 }).pendingReward?.arcaneBlood).toBe(4 * d);
		}
		expect(arcaneBloodFor({ permanent: true, difficulty: 1 }, TWO)).toBe(2);
		expect(buildRulesBrief(TWO)).toContain('2 for the permanent monster, 4 for a Difficulty 1 card, 8 for a Difficulty 2 card, 12 for a Difficulty 3 card');
	});
	it('arcaneBloodPerPoint: 1 for the permanent monster, 2 / 4 / 7 by Difficulty, over the other amount rules', () => {
		const ONE = withRules({ ...RULES, arcaneBlood: true, arcaneBloodDouble: true, arcaneBloodTwoPerPoint: true, arcaneBloodPerPoint: true });
		for (const [d, n] of [[1, 2], [2, 4], [3, 7]] as const) {
			const g = afterKill(ONE, d);
			expect(g.run({ type: 'startCombat', handIndex: 0 }).pendingReward?.arcaneBlood).toBe(n);
		}
		expect(arcaneBloodFor({ permanent: true, difficulty: 1 }, ONE)).toBe(1);
		expect(buildRulesBrief(ONE)).toContain('1 for the permanent monster, 2 for a Difficulty 1 card, 4 for a Difficulty 2 card, 7 for a Difficulty 3 card');
	});
	it('the rules text names the choice only with the rule on, and Elementalist (2) reads "When you gain an Arcane Blood"', () => {
		expect(buildRulesBrief(ON)).toContain('ARCANE BLOOD');
		expect(buildRulesBrief(OFF)).not.toContain('ARCANE BLOOD');
		const schema = [2, 3].map((count) => ({ count, effects: [{ type: 'benefit', description: `old ${count}` }] })) as never;
		expect(ruleAdjustedClassSchema(ON, 'Elementalist', schema)![0].effects?.[0].description).toBe('When you gain an Arcane Blood, upgrade an attack dice.');
	});
	it('is off by default: the kill upgrades, no Arcane Blood is offered or accepted', () => {
		const g = afterKill(OFF, 3);
		const me = g.run({ type: 'startCombat', handIndex: 0 });
		expect(tiers(me)).toBe(2);
		expect(me.pendingReward?.arcaneBlood).toBeUndefined();
		expect(() => g.run({ type: 'resolveMonsterReward', picks: [], arcaneBlood: true })).toThrow(/no Arcane Blood/);
	});
});
