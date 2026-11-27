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
import { BUFFED_DICE_TIER_FACES, DICE_TIER_FACES, TWO_THIRDS_DICE_TIER_FACES, WEAK_LOW_DICE_TIER_FACES, diceTierFaces, expectedAttack, fightMonster, resetCombatFlags, rollAttack, takeDamage, useSentinelDiscard } from './combat';
import { applyGameCommand, arcaneBloodFor, createLobbyState, monsterCardFromCatalog } from './runtime';
import { buildLocationInteractions } from './locationInteractions';
import { applyCultivate, applyRest, applyTrigger } from './effects/apply';
import { ALCHEMIST_AUGMENT_KIND, decisions as alchemistDecisions } from './effects/classes/arcMage';
import { SENTINEL_DISCARD_KIND, ability as sentinelAbility, decisions as sentinelDecisions } from './effects/classes/firekeeper';
import { cursedSpiritDiceTier, elementalistUpgradeAction, fairyDiceTier, parseRules, restBarrier, ruleAdjustedActions, ruleAdjustedClassSchema } from './rules';
import { buildRulesBrief } from './agents/rulesBrief';
import { enterBenefits } from './phases';
import { labelFor, monsterLine } from './agents/labels';
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

describe('weakLowDice: Basic 0.33, Enchanted 0.83, Exalted 1.5, Arcane 2', () => {
	const ON = withRules({ buffedDice: true, weakLowDice: true });
	it('has the averages 0.33, 0.83, 1.5, 2 and overrides buffedDice', () => {
		expect(diceTierFaces(ON)).toBe(WEAK_LOW_DICE_TIER_FACES);
		expect((['basic', 'enchanted', 'exalted', 'arcane'] as DiceTier[]).map((t) => Math.round(avg(WEAK_LOW_DICE_TIER_FACES[t]) * 100) / 100)).toEqual([0.33, 0.83, 1.5, 2]);
		expect(WEAK_LOW_DICE_TIER_FACES.exalted).toEqual(BUFFED_DICE_TIER_FACES.exalted);
		expect(diceTierFaces(withRules({ buffedDice: true }))).toBe(BUFFED_DICE_TIER_FACES);
	});
	it('a player sees the new average, and the rules text lists the faces', () => {
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'basic', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'exalted') });
		expect(expectedAttack(p, ON)).toBeCloseTo(7.5);
		expect(buildRulesBrief(ON)).toContain('basic 0,0,0,0,1,1; enchanted 0,0,1,1,1,2; exalted 1,1,1,2,2,2');
	});
	it('rolls: Basic 0 or 1, Enchanted 0, 1 or 2', () => {
		const rolls = (tier: DiceTier) => {
			const state = makeState(makePlayer({ attackDice: dice(tier) }));
			const seen = new Set<number>();
			for (let i = 0; i < 300; i += 1) seen.add(rollAttack(state, state.players.Red!, ON));
			return [...seen].sort((a, b) => a - b);
		};
		expect(rolls('basic')).toEqual([0, 1]);
		expect(rolls('enchanted')).toEqual([0, 1, 2]);
		expect(rolls('exalted')).toEqual([1, 2]);
	});
});

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
	it('numbers.restBarrier: one number per status replaces the switches (Pure 4, Tainted 4, Corrupt 3, Fallen 2)', () => {
		const LIST = withRules({ restByStatus: true, restBase4: true, numbers: { restBarrier: [4, 4, 3, 2] } });
		expect([0, 1, 2, 3].map((s) => restored(LIST, s))).toEqual([4, 4, 3, 2]);
		expect(restored(LIST, 0, 3)).toBe(3);
		expect(buildRulesBrief(LIST)).toContain('Rest restores Barrier by your status (Pure 4, Tainted 4, Corrupt 3, Fallen 2; never above your Max Barrier)');
		expect(parseRules({ numbers: { restBarrier: [4, 4, 3] } }).problems).toHaveLength(1);
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

describe('fighterDice35 and cultivatorBarrier35: the top two breakpoints give 3 and 5', () => {
	const fighters = (n: number) => makePlayer({ spirits: [spirit(1, { Fighter: n })] });
	const cultivators = (n: number) => makePlayer({ maxBarrier: 0, barrier: 0, spirits: [spirit(1, { Cultivator: n })] });
	const restDice = (catalog: PlayCatalog, n: number) => { const p = fighters(n); applyRest(makeState(p), 'Red', [], { catalog }); return p.attackDice.length; };
	const maxBarrier = (catalog: PlayCatalog, n: number) => { const p = cultivators(n); applyCultivate(makeState(p), 'Red', [], { catalog }); return p.maxBarrier; };
	it('Fighter on Rest: 1, 2, 3, 5 Basic dice at 2, 3, 4, 5 (the Spirit Augment at 5 stays)', () => {
		const ON = withRules({ fighterDice35: true });
		expect([1, 2, 3, 4, 5].map((n) => restDice(ON, n))).toEqual([0, 1, 2, 3, 5]);
		const p = fighters(5), log: string[] = [];
		applyRest(makeState(p), 'Red', log, { catalog: ON });
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(log.join(' ')).toMatch(/augment/i);
	});
	it('Cultivator on Cultivate: 1, 2, 3, 5 Max Barrier at 2, 3, 4, 5', () => {
		expect([1, 2, 3, 4, 5].map((n) => maxBarrier(withRules({ cultivatorBarrier35: true }), n))).toEqual([0, 1, 2, 3, 5]);
	});
	it('is off by default: 5 and 10, so recorded games replay', () => {
		expect([4, 5].map((n) => restDice(withRules(undefined), n))).toEqual([5, 10]);
		expect([4, 5].map((n) => maxBarrier(withRules(undefined), n))).toEqual([5, 10]);
		const actions = [{ kind: 'gainAttackDice', amount: 10 }];
		expect(ruleAdjustedActions(withRules(undefined), 'Fighter', 5, actions)).toBe(actions);
		expect(ruleAdjustedActions(withRules({ cultivatorBarrier35: true }), 'Fighter', 5, actions)).toBe(actions);
	});
	it('the printed class text follows the switches', () => {
		const text = (catalog: PlayCatalog, name: string, count: number) => ruleAdjustedClassSchema(catalog, name, [{ count, effects: [{ type: 'benefit', description: 'old' }] }] as never)![0].effects?.[0].description;
		const ON = withRules({ fighterDice35: true, cultivatorBarrier35: true, cultivatorRelicOnce: true });
		expect(text(ON, 'Fighter', 4)).toBe('In combat, gain 4 combat initiative. On Rest, gain 3 Basic Attack Dice.');
		expect(text(ON, 'Fighter', 5)).toContain('gain 5 Basic Attack Dice and 1 of any spirit augment');
		expect(text(ON, 'Cultivator', 4)).toBe('On Cultivate, gain 3 Max Barrier.');
		expect(text(ON, 'Cultivator', 5)).toContain('gain 5 Max Barrier');
		expect(text(withRules({ cultivatorRelicOnce: true }), 'Cultivator', 5)).toContain('gain 10 Max Barrier');
	});
});

describe('elementalistRest1235, elementalist5NeedsRelic and enchantedTwoThirds (Michael, 2026-11-22)', () => {
	const tenBasic = () => Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as DiceTier }));
	const relic = { slotIndex: 1, hasRune: true, id: 'firecracker', name: 'Firecracker', type: 'relic' } as never;
	const rune = { slotIndex: 1, hasRune: true, id: 'forest', name: 'Forest Rune', type: 'rune' } as never;
	/** Dice above Basic after one Rest (each upgrade lifts one Basic die to Enchanted while Basic dice remain). */
	const upgraded = (rules: PlayRules, n: number, mats: never[] = []) => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: n })], mats });
		applyRest(makeState(p), 'Red', [], { catalog: withRules(rules) });
		return p.attackDice.filter((d) => d.tier !== 'basic').length;
	};
	it('on Rest: 1 / 2 / 3 / 5 upgrades at 2 / 3 / 4 / 5 Elementalists, none at 1', () => {
		expect([1, 2, 3, 4, 5, 6].map((n) => upgraded({ elementalistRest1235: true }, n))).toEqual([0, 1, 2, 3, 5, 5]);
	});
	it('it overrides elementalistMethods: a Cultivate and Arcane Blood upgrade nothing', () => {
		const ON = withRules({ elementalistMethods: true, elementalistOneUpgrade: true, elementalistRest1235: true, arcaneBlood: true });
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: 5 })] });
		applyCultivate(makeState(p), 'Red', [], { catalog: ON });
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(upgraded({ elementalistMethods: true, elementalistOneUpgrade: true, elementalistRest1235: true }, 3)).toBe(2);
	});
	it('with elementalist5NeedsRelic the step at 5 needs a held relic (any relic); a rune is not one', () => {
		const R: PlayRules = { elementalistRest1235: true, elementalist5NeedsRelic: true };
		expect(upgraded(R, 5)).toBe(3);
		expect(upgraded(R, 5, [rune])).toBe(3);
		expect(upgraded(R, 5, [relic])).toBe(5);
		expect(upgraded(R, 4, [relic])).toBe(3);
		expect(upgraded(R, 4)).toBe(3);
	});
	it('upgrades the lowest die first', () => {
		const p = makePlayer({ attackDice: dice('basic', 'enchanted', 'enchanted', 'exalted'), spirits: [spirit(1, { Elementalist: 3 })] });
		applyRest(makeState(p), 'Red', [], { catalog: withRules({ elementalistRest1235: true }) });
		// Two upgrades: the Basic die first, then one of the Enchanted dice.
		expect(p.attackDice.map((d) => d.tier).sort()).toEqual(['enchanted', 'enchanted', 'exalted', 'exalted']);
	});
	it('the printed text follows the switches', () => {
		const text = (rules: PlayRules, count: number) => ruleAdjustedClassSchema(withRules(rules), 'Elementalist', [{ count, effects: [{ type: 'benefit', description: 'old' }] }] as never)![0].effects?.[0].description;
		expect(text({ elementalistRest1235: true, arcaneBlood: true }, 2)).toBe('On Rest, upgrade an attack dice.');
		expect(text({ elementalistRest1235: true }, 4)).toBe('On Rest, upgrade an attack dice 3 times.');
		expect(text({ elementalistRest1235: true }, 5)).toBe('On Rest, upgrade an attack dice 5 times.');
		expect(text({ elementalistRest1235: true, elementalist5NeedsRelic: true }, 5)).toContain('if you have a relic');
	});
	it('enchantedTwoThirds: the dice are 0.33 / 0.67 / 1.5 under weakLowDice, and unchanged without it', () => {
		const ON = withRules({ buffedDice: true, weakLowDice: true, enchantedTwoThirds: true });
		expect(diceTierFaces(ON)).toBe(TWO_THIRDS_DICE_TIER_FACES);
		expect((['basic', 'enchanted', 'exalted', 'arcane'] as DiceTier[]).map((t) => Math.round(avg(diceTierFaces(ON)[t]) * 100) / 100)).toEqual([0.33, 0.67, 1.5, 2]);
		expect(diceTierFaces(withRules({ buffedDice: true, enchantedTwoThirds: true }))).toBe(BUFFED_DICE_TIER_FACES);
		expect(buildRulesBrief(ON)).toContain('basic 0,0,0,0,1,1; enchanted 0,0,1,1,1,1; exalted 1,1,1,2,2,2');
	});
});

describe('elementalistOnCultivate: the ladder upgrades on Cultivate, not on Rest (Michael, 2026-11-22)', () => {
	const tenBasic = () => Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as DiceTier }));
	const relic = { slotIndex: 1, hasRune: true, id: 'firecracker', name: 'Firecracker', type: 'relic' } as never;
	const R: PlayRules = { elementalistRest1235: true, elementalistOnCultivate: true };
	const after = (rules: PlayRules, n: number, act: typeof applyRest, mats: never[] = []) => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: n })], mats });
		act(makeState(p), 'Red', [], { catalog: withRules(rules) });
		return p.attackDice.filter((d) => d.tier !== 'basic').length;
	};
	it('a Cultivate upgrades 1 / 2 / 3 / 5 at 2 / 3 / 4 / 5 Elementalists; a Rest upgrades nothing', () => {
		expect([1, 2, 3, 4, 5, 6].map((n) => after(R, n, applyCultivate))).toEqual([0, 1, 2, 3, 5, 5]);
		expect([2, 3, 4, 5].map((n) => after(R, n, applyRest))).toEqual([0, 0, 0, 0]);
		expect(elementalistUpgradeAction(withRules(R))).toBe('cultivate');
		expect(elementalistUpgradeAction(withRules({ elementalistRest1235: true }))).toBe('rest');
		expect(elementalistUpgradeAction(withRules({ elementalistOnCultivate: true }))).toBeNull();
	});
	it('the relic step and the numbers work the same on Cultivate', () => {
		const G: PlayRules = { ...R, elementalist5NeedsRelic: true, numbers: { elementalistRest: [1, 1, 2, 4] } };
		expect(after(G, 5, applyCultivate)).toBe(2);
		expect(after(G, 5, applyCultivate, [relic])).toBe(4);
	});
	it('without the ladder rule the switch does nothing', () => {
		const OLD: PlayRules = { elementalistMethods: true, elementalistOneUpgrade: true };
		expect(after({ ...OLD, elementalistOnCultivate: true }, 4, applyCultivate)).toBe(after(OLD, 4, applyCultivate));
		expect(after({ ...OLD, elementalistOnCultivate: true }, 3, applyRest)).toBe(after(OLD, 3, applyRest));
	});
	it('the printed text says Cultivate, and Elementalist is no longer a Rest class in the brief', () => {
		const text = (rules: PlayRules, count: number) => ruleAdjustedClassSchema(withRules(rules), 'Elementalist', [{ count, effects: [{ type: 'benefit', description: 'old' }] }] as never)![0].effects?.[0].description;
		expect(text(R, 2)).toBe('When you Cultivate, upgrade an attack dice.');
		expect(text(R, 4)).toBe('When you Cultivate, upgrade an attack dice 3 times.');
		expect(text({ ...R, elementalist5NeedsRelic: true }, 5)).toBe('When you Cultivate, upgrade an attack dice 5 times if you have a relic (any relic); 3 times if you have none.');
	});
});

describe('difficulty3Restores: a Difficulty 3 monster restores Barrier after a fight it survives (Michael, 2026-11-22)', () => {
	const ON = withRules({ difficulty3Restores: true });
	const d3 = (hp: number, restore?: number) => ({ ...(monster(hp, 5, 100) as object), difficulty: 3, ...(restore ? { restoreAfterCombat: restore } : {}) }) as never;
	/** A player with `beast` Beast traits and no dice deals exactly `beast` damage; Barrier 20 so the hit of 5 never corrupts. */
	const fighter = (beast: number, card: never) => makePlayer({ barrier: 20, maxBarrier: 20, spirits: [spirit(1, { Beast: beast })], monsterHand: [card] });
	it('only the damage beyond 5 stays on the card: 9 damage needs three fights against Barrier 16', () => {
		const p = fighter(9, d3(16, 5)), state = makeState(p);
		const first = fightMonster(state, 'Red', ON, 0)!;
		expect(first.killed).toBe(false);
		expect(first.fought!.hp).toBe(12); // 16 - 9 = 7, then 5 back
		expect(first.log.some((l) => l.includes('restores 5 Barrier (12/16)'))).toBe(true);
		expect(p.monsterHand![0].hp).toBe(12);
		expect(fightMonster(state, 'Red', ON, 0)!.fought!.hp).toBe(8);
		expect(fightMonster(state, 'Red', ON, 0)!.killed).toBe(true);
		expect(p.monsterHand).toHaveLength(0);
	});
	it('a fight that deals 5 or less makes no progress, and the Barrier never goes above the printed one', () => {
		const p = fighter(5, d3(16, 5)), state = makeState(p);
		expect(fightMonster(state, 'Red', ON, 0)!.fought!.hp).toBe(16);
		const q = fighter(3, d3(16, 5));
		expect(fightMonster(makeState(q), 'Red', ON, 0)!.fought!.hp).toBe(16);
	});
	it('a card without the ability keeps all its damage', () => {
		const p = fighter(9, d3(16));
		expect(fightMonster(makeState(p), 'Red', ON, 0)!.fought!.hp).toBe(7);
	});
	it('the rule puts the ability on Difficulty 3 cards only; the number can be set in the data; the players are told', () => {
		const m = (stage: number, permanent = false) => ({ id: `m${stage}`, name: 'M', damage: 5, barrier: 16, rewardTrack: [], dicePool: [], chooseAmount: 0, stage, order: 1, ...(permanent ? { permanent: true } : {}) }) as never;
		const byStage = (rules: PlayRules) => withRules({ monsterDeckByStage: true, ...rules });
		const on = byStage({ difficulty3Restores: true });
		expect(monsterCardFromCatalog(m(3), on).restoreAfterCombat).toBe(5);
		expect(monsterCardFromCatalog(m(2), on).restoreAfterCombat).toBeUndefined();
		expect(monsterCardFromCatalog(m(3, true), on).restoreAfterCombat).toBeUndefined();
		expect(monsterCardFromCatalog(m(3), byStage({})).restoreAfterCombat).toBeUndefined();
		expect(monsterCardFromCatalog(m(3), byStage({ difficulty3Restores: true, numbers: { difficulty3Restore: 3 } })).restoreAfterCombat).toBe(3);
		expect(monsterLine(monsterCardFromCatalog(m(3), on))).toContain('ability: restores 5 Barrier after a fight it survives');
		expect(monsterLine(monsterCardFromCatalog(m(2), on))).not.toContain('ability');
		expect(buildRulesBrief(on)).toContain('DIFFICULTY 3 ABILITY: every Difficulty 3 monster restores 5 Barrier');
		expect(buildRulesBrief(byStage({}))).not.toContain('DIFFICULTY 3 ABILITY');
		expect(parseRules({ numbers: { difficulty3Restore: -1 } }).problems).toHaveLength(1);
	});
});

describe('alchemistOncePerRound: Arcane Alchemist converts one augment a round (Michael, 2026-11-22)', () => {
	const aug = (slot: number, runeId: string) => ({ spiritSlotIndex: slot, runeId, className: 'Beast', classId: 'beast' }) as never;
	const setup = (rules: PlayRules) => {
		const p = makePlayer({ spirits: [spirit(1, { 'Arcane Alchemist': 1 })], spiritAugmentAttachments: [aug(1, 'r1'), aug(1, 'r2')] });
		const state = makeState(p), catalog = withRules(rules);
		state.round = 3;
		const cultivate = () => { p.pendingDecisions = []; const log: string[] = []; applyCultivate(state, 'Red', log, { catalog }); return p.pendingDecisions.filter((d) => d.kind === ALCHEMIST_AUGMENT_KIND).length; };
		const convert = (id: string) => alchemistDecisions[ALCHEMIST_AUGMENT_KIND]!({ state, player: p, catalog, log: [], seat: 'Red' } as never, id);
		return { p, state, cultivate, convert };
	};
	const arcane = (p: { attackDice: { tier: DiceTier }[] }) => p.attackDice.filter((d) => d.tier === 'arcane').length;
	it('after a conversion a second Cultivate in the same round offers nothing; the next round offers again', () => {
		const { p, state, cultivate, convert } = setup({ alchemistAugmentToArcane: true, alchemistOncePerRound: true });
		expect(cultivate()).toBe(1);
		convert('aug:1:r1');
		expect(arcane(p)).toBe(1);
		expect(cultivate()).toBe(0);
		convert('aug:1:r2'); // a stale card answered late converts nothing
		expect(arcane(p)).toBe(1);
		expect(p.spiritAugmentAttachments).toHaveLength(1);
		state.round += 1;
		expect(cultivate()).toBe(1);
		convert('aug:1:r2');
		expect(arcane(p)).toBe(2);
	});
	it('declining keeps the offer for a later Cultivate of the round', () => {
		const { p, cultivate, convert } = setup({ alchemistAugmentToArcane: true, alchemistOncePerRound: true });
		expect(cultivate()).toBe(1);
		convert('no');
		expect(arcane(p)).toBe(0);
		expect(cultivate()).toBe(1);
	});
	it('without the rule every Cultivate offers a conversion, and the text says once a round only with it', () => {
		const { p, cultivate, convert } = setup({ alchemistAugmentToArcane: true });
		expect(cultivate()).toBe(1);
		convert('aug:1:r1');
		expect(cultivate()).toBe(1);
		convert('aug:1:r2');
		expect(arcane(p)).toBe(2);
		expect(p.alchemistConvertedRound).toBeUndefined();
		const text = (rules: PlayRules) => ruleAdjustedClassSchema(withRules(rules), 'Arcane Alchemist', [{ count: 1, effects: [{ type: 'benefit', description: 'old' }] }] as never)![0].effects?.[0].description;
		expect(text({ alchemistAugmentToArcane: true })).toBe('When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane Attack Dice.');
		expect(text({ alchemistAugmentToArcane: true, alchemistOncePerRound: true })).toContain('(once a round)');
	});
});

describe('rules.json numbers: dice faces and the Elementalist ladder from the data (Michael, 2026-11-22)', () => {
	const tenBasic = () => Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as DiceTier }));
	const relic = { slotIndex: 1, hasRune: true, id: 'firecracker', name: 'Firecracker', type: 'relic' } as never;
	const upgraded = (rules: PlayRules, n: number, mats: never[] = []) => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: n })], mats });
		applyRest(makeState(p), 'Red', [], { catalog: withRules(rules) });
		return p.attackDice.filter((d) => d.tier !== 'basic').length;
	};
	const text = (rules: PlayRules, count: number) => ruleAdjustedClassSchema(withRules(rules), 'Elementalist', [{ count, effects: [{ type: 'benefit', description: 'old' }] }] as never)![0].effects?.[0].description;
	it('parseRules reads them and reports bad ones', () => {
		const good = parseRules({ weakLowDice: true, numbers: { diceFaces: { enchanted: [0, 1, 1, 1, 1, 1] }, elementalistRest: [1, 1, 2, 4] } });
		expect(good.problems).toEqual([]);
		expect(good.rules).toEqual({ weakLowDice: true, numbers: { diceFaces: { enchanted: [0, 1, 1, 1, 1, 1] }, elementalistRest: [1, 1, 2, 4] } });
		expect(parseRules({ numbers: {} }).rules).toBeUndefined();
		const bad = parseRules({ numbers: { diceFaces: { gold: [1], basic: [0.5] }, elementalistRest: [1, 2, 3], speed: 3 } });
		expect(bad.rules).toBeUndefined();
		expect(bad.problems).toHaveLength(4);
	});
	it('diceFaces replaces the faces of the tiers it names, under any dice switch', () => {
		const own = { diceFaces: { enchanted: [0, 0, 0, 1, 1, 1], exalted: [1, 1, 1, 1, 2, 2] } };
		const ON = withRules({ buffedDice: true, weakLowDice: true, enchantedTwoThirds: true, numbers: own });
		expect(diceTierFaces(ON)).toEqual({ ...TWO_THIRDS_DICE_TIER_FACES, ...own.diceFaces });
		expect(diceTierFaces(withRules({ numbers: own })).basic).toBe(DICE_TIER_FACES.basic);
		expect(buildRulesBrief(ON)).toContain('basic 0,0,0,0,1,1; enchanted 0,0,0,1,1,1; exalted 1,1,1,1,2,2');
		const p = makePlayer({ attackDice: dice('enchanted', 'enchanted', 'exalted') });
		expect(expectedAttack(p, ON)).toBeCloseTo(0.5 + 0.5 + 8 / 6);
	});
	it('elementalistRest replaces 1 / 2 / 3 / 5, with the relic step and the printed text', () => {
		const R: PlayRules = { elementalistRest1235: true, numbers: { elementalistRest: [1, 1, 2, 4] } };
		expect([1, 2, 3, 4, 5, 6].map((n) => upgraded(R, n))).toEqual([0, 1, 1, 2, 4, 4]);
		const G: PlayRules = { ...R, elementalist5NeedsRelic: true };
		expect(upgraded(G, 5)).toBe(2);
		expect(upgraded(G, 5, [relic])).toBe(4);
		expect(text(R, 3)).toBe('On Rest, upgrade an attack dice.');
		expect(text(R, 4)).toBe('On Rest, upgrade an attack dice 2 times.');
		expect(text(G, 5)).toBe('On Rest, upgrade an attack dice 4 times if you have a relic (any relic); 2 times if you have none.');
		// Without the switch the numbers do nothing.
		expect(upgraded({ numbers: { elementalistRest: [9, 9, 9, 9] } }, 3)).toBe(2);
	});
	it('elementalistNoRelic sets the number at 5 Elementalists without a relic (Michael, 2026-11-22: 15 attack after 5 Cultivates)', () => {
		const G: PlayRules = { elementalistRest1235: true, elementalistOnCultivate: true, elementalist5NeedsRelic: true, numbers: { elementalistNoRelic: 4 } };
		const cultivated = (rules: PlayRules, n: number, mats: never[] = []) => {
			const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: n })], mats });
			applyCultivate(makeState(p), 'Red', [], { catalog: withRules(rules) });
			return p.attackDice.filter((d) => d.tier !== 'basic').length;
		};
		expect([2, 3, 4, 5].map((n) => cultivated(G, n))).toEqual([1, 2, 3, 4]);
		expect(cultivated(G, 5, [relic])).toBe(5);
		expect(cultivated(G, 4, [relic])).toBe(3);
		expect(text(G, 5)).toBe('When you Cultivate, upgrade an attack dice 5 times if you have a relic (any relic); 4 times if you have none.');
		// Ten Basic dice are ten Exalted dice after 5 Cultivates without a relic, 4 with one.
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: 5 })] });
		for (let i = 0; i < 5; i++) applyCultivate(makeState(p), 'Red', [], { catalog: withRules(G) });
		expect(p.attackDice.every((d) => d.tier === 'exalted')).toBe(true);
		// Without the relic rule the number is not read; a bad one is reported.
		expect(cultivated({ elementalistRest1235: true, elementalistOnCultivate: true, numbers: { elementalistNoRelic: 0 } }, 5)).toBe(5);
		expect(parseRules({ numbers: { elementalistNoRelic: 2.5 } }).problems).toHaveLength(1);
		expect(parseRules({ numbers: { elementalistNoRelic: 4 } }).rules).toEqual({ numbers: { elementalistNoRelic: 4 } });
	});
	it('without numbers the text and the ladder are as before', () => {
		expect(text({ elementalistRest1235: true, elementalist5NeedsRelic: true }, 5)).toBe('On Rest, upgrade an attack dice 5 times if you have a relic (any relic); 3 times if you have none.');
		expect(text({ elementalistRest1235: true }, 2)).toBe('On Rest, upgrade an attack dice.');
	});
});

describe('sentinelDamagePerDie: the damage of each die Sentinel discards (Michael, 2026-11-22: "nerf sentinel to do 1 damage per dice instead")', () => {
	const ONE = withRules({ numbers: { sentinelDamagePerDie: 1 } });
	const sentinel = () => makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], attackDice: dice('basic', 'basic', 'basic', 'basic', 'basic'), sentinelDiscardIds: ['d0', 'd1', 'd2', 'd3', 'd4'] });
	const text = (catalog: PlayCatalog) => ruleAdjustedClassSchema(catalog, 'Sentinel', [{ count: 1, effects: [{ type: 'benefit', description: 'printed' }] }] as never)![0].effects?.[0].description;
	it('five discarded dice are 10 damage without the number and 5 with it', () => {
		const before = sentinel(), after = sentinel(), log: string[] = [];
		useSentinelDiscard(before, [], undefined, withRules(undefined));
		useSentinelDiscard(after, log, undefined, ONE);
		expect(before.discardDamageBonus).toBe(10);
		expect(after.discardDamageBonus).toBe(5);
		expect(after.attackDice).toHaveLength(0);
		expect(log[0]).toContain('discarded 5 attack dice before the roll for 5 more damage');
	});
	it('in a fight: Beast 3 and five discarded dice deal 8 to a monster, not 13', () => {
		const fight = (catalog: PlayCatalog) => {
			const p = makePlayer({ barrier: 20, maxBarrier: 20, spirits: [spirit(1, { Sentinel: 1, Beast: 3 })], attackDice: dice('basic', 'basic', 'basic', 'basic', 'basic'), sentinelDiscardIds: ['d0', 'd1', 'd2', 'd3', 'd4'], monsterHand: [monster(16, 5, 100) as never] });
			return 16 - fightMonster(makeState(p), 'Red', catalog, 0)!.fought!.hp;
		};
		expect(fight(withRules(undefined))).toBe(13);
		expect(fight(ONE)).toBe(8);
	});
	it('the class text, the decision card and its log line name the number', () => {
		expect(text(ONE)).toBe('Before you roll in combat, you may discard attack dice. For each dice that you discard, deal 1 more damage.');
		expect(text(withRules(undefined))).toBe('printed');
		const p = makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], attackDice: dice('basic', 'basic') });
		const state = makeState(p), log: string[] = [];
		sentinelAbility[0].run!({ state, seat: 'Red', player: p, catalog: ONE, log, trigger: 'awakeningPhase' } as never);
		expect(p.pendingDecisions!.find((d) => d.kind === SENTINEL_DISCARD_KIND)!.prompt).toContain('Each discarded die deals 1 more damage.');
		sentinelDecisions[SENTINEL_DISCARD_KIND]({ state, seat: 'Red', player: p, catalog: ONE, log, trigger: 'awakeningPhase' } as never, 'yes', ['d0', 'd1']);
		expect(log.at(-1)).toContain('(+2 damage)');
	});
	it('a bad number is reported; a good one is kept', () => {
		expect(parseRules({ numbers: { sentinelDamagePerDie: 1.5 } }).problems).toHaveLength(1);
		expect(parseRules({ numbers: { sentinelDamagePerDie: 1 } }).rules).toEqual({ numbers: { sentinelDamagePerDie: 1 } });
	});
});

describe('mageAwakenArcaneDice: the Arcane dice of Mage\'s awakening (Michael, 2026-11-22: "nerf the mage by 1 attack dice so only 3 arcane attack")', () => {
	const awaken = (rules: PlayRules) => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: withRules(rules), command: { type: 'awakenSpirit', slotIndex: 1 } as never });
		return p.attackDice.map((d) => d.tier);
	};
	const text = (rules: PlayRules) => ruleAdjustedClassSchema(withRules(rules), 'Mage', [{ count: 1, effects: [{ type: 'benefit', description: 'printed' }] }] as never)![0].effects?.[0].description;
	it('4 Arcane dice without the number, 3 with it; the text names the number', () => {
		expect(awaken({ mageArcaneDice: true })).toEqual(['arcane', 'arcane', 'arcane', 'arcane']);
		expect(awaken({ mageArcaneDice: true, numbers: { mageAwakenArcaneDice: 3 } })).toEqual(['arcane', 'arcane', 'arcane']);
		expect(text({ mageArcaneDice: true })).toBe("On this spirit's Awakening, gain 4 Arcane Attack Dice.");
		expect(text({ mageArcaneDice: true, numbers: { mageAwakenArcaneDice: 3 } })).toBe("On this spirit's Awakening, gain 3 Arcane Attack Dice.");
	});
	it('a bad number is reported; a good one is kept', () => {
		expect(parseRules({ numbers: { mageAwakenArcaneDice: -1 } }).problems).toHaveLength(1);
		expect(parseRules({ numbers: { mageAwakenArcaneDice: 3 } }).rules).toEqual({ numbers: { mageAwakenArcaneDice: 3 } });
	});
});

describe('numbers.sacrificeMax: the sacrifice of a corruption stops growing (Michael, 2026-11-26: "after the last sacriface, it stops at 4")', () => {
	/** A Fallen player with `spirits` spirits and `count` corruptions so far takes a hit that corrupts: points lost and spirits owed. */
	const corruptAgain = (catalog: PlayCatalog, count: number, spirits: number) => {
		const p = makePlayer({
			statusLevel: 3, statusToken: 'Fallen', barrier: 2, maxBarrier: 6, victoryPoints: 20, corruptionCount: count,
			spirits: Array.from({ length: spirits }, (_, i) => spirit(i + 1, { Healer: 1 }))
		} as never);
		const log: string[] = [];
		const r = takeDamage(p, 9, undefined, log, catalog);
		return { corrupted: r.corrupted, lost: 20 - p.victoryPoints, owed: p.pendingCorruptionDiscard?.count ?? 0, count: p.corruptionCount };
	};
	const CAP = withRules({ fallenDebtBelowZero: true, numbers: { sacrificeMax: 4 } });
	const OFF = withRules({ fallenDebtBelowZero: true });
	it('with 4: the 5th and 6th corruption cost 4, like the 4th', () => {
		expect(corruptAgain(CAP, 3, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 4 });
		expect(corruptAgain(CAP, 4, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 5 });
		expect(corruptAgain(CAP, 5, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 6 });
		// Spirits are paid first: 3 spirits and 4 owed leave 1 point to lose.
		expect(corruptAgain(CAP, 5, 3)).toEqual({ corrupted: true, lost: 1, owed: 3, count: 6 });
		// The first corruptions are as before.
		expect(corruptAgain(CAP, 1, 7)).toEqual({ corrupted: true, lost: 0, owed: 2, count: 2 });
	});
	it('without the number the cost keeps growing, as before', () => {
		expect(corruptAgain(OFF, 4, 0).lost).toBe(5);
		expect(corruptAgain(OFF, 5, 0).lost).toBe(6);
	});
	it('the rules text says where it stops, and a bad value is a problem', () => {
		expect(buildRulesBrief(CAP)).toContain('4 for the 4th (and 4 for every corruption after your 4th: it stops growing there)');
		expect(buildRulesBrief(OFF)).toContain('and one more for each corruption after that (5 for the 5th, 6 for the 6th)');
		expect(parseRules({ numbers: { sacrificeMax: 0 } }).problems).toHaveLength(1);
		expect(parseRules({ numbers: { sacrificeMax: 4 } }).problems).toHaveLength(0);
	});
});
