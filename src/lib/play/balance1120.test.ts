/**
 * The balance changes of 20-27 November 2026 (Michael), as the one ruleset plays them now: the attack dice,
 * Rest by status, Fairy and Cursed Spirit dice, no class initiative, Battle Adept, Fighter and Cultivator
 * 1 / 2 / 3 / 5, Elementalist on Cultivate, the Difficulty 3 ability, Arcane Alchemist once a round, Sentinel,
 * Mage and the sacrifice limit. How each came about: docs/rules-history-2026-11.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DICE_TIER_FACES, expectedAttack, fightMonster, resetCombatFlags, rollAttack, takeDamage, useSentinelDiscard } from './combat';
import { applyGameCommand, monsterCardFromCatalog } from './runtime';
import { applyCultivate, applyRest, applyTrigger } from './effects/apply';
import { ALCHEMIST_AUGMENT_KIND, decisions as alchemistDecisions } from './effects/classes/arcMage';
import { SENTINEL_DISCARD_KIND, ability as sentinelAbility, decisions as sentinelDecisions } from './effects/classes/firekeeper';
import {
	CURSED_SPIRIT_DICE_TIER,
	ELEMENTALIST_NO_RELIC_UPGRADES,
	ELEMENTALIST_UPGRADES,
	FAIRY_DICE_TIER,
	MAGE_AWAKEN_ARCANE_DICE,
	REST_BARRIER_BY_STATUS,
	SACRIFICE_MAX,
	SENTINEL_DAMAGE_PER_DIE,
	difficulty3Restore,
	restBarrier
} from './rules';
import { buildRulesBrief } from './agents/rulesBrief';
import { enterBenefits } from './phases';
import { labelFor, monsterLine } from './agents/labels';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { loadFrozenCatalog } from './agents/catalog';
import { attackLine } from './agents/view';
import type { DiceTier, GameActor, GameCommand, PlayCatalog } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const dice = (...tiers: DiceTier[]) => tiers.map((tier, i) => ({ instanceId: `d${i}`, tier }));
const avg = (f: number[]) => f.reduce((a, b) => a + b, 0) / f.length;
const monster = (hp: number, damage: number, initiative: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, initiative, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;
const tenBasic = () => dice(...Array<DiceTier>(10).fill('basic'));
const relic = { slotIndex: 1, hasRune: true, id: 'firecracker', name: 'Firecracker', type: 'relic' } as never;
const rune = { slotIndex: 1, hasRune: true, id: 'forest', name: 'Forest Rune', type: 'rune' } as never;

/** The printed text of class `name` at `count` in the game data. */
const CLASSES = JSON.parse(readFileSync('data/classes.json', 'utf8')) as {
	name: string;
	effect_schema: { count: number | string; effects: { description: string }[] }[];
}[];
const classText = (name: string, count: number | string) =>
	CLASSES.find((c) => c.name === name)!.effect_schema.find((t) => t.count === count)!.effects[0].description;

describe('attack dice: Basic 0.33, Enchanted 0.5, Exalted 1.5, Arcane 2', () => {
	it('has six faces per die and those averages', () => {
		expect(DICE_TIER_FACES).toEqual({
			basic: [0, 0, 0, 0, 1, 1],
			enchanted: [0, 0, 0, 1, 1, 1],
			exalted: [1, 1, 1, 2, 2, 2],
			arcane: [0, 0, 1, 3, 3, 5]
		});
		expect((['basic', 'enchanted', 'exalted', 'arcane'] as DiceTier[]).map((t) => Math.round(avg(DICE_TIER_FACES[t]) * 100) / 100)).toEqual([0.33, 0.5, 1.5, 2]);
	});
	it('a player sees the average, and the rules text lists the faces', () => {
		const p = makePlayer({ attackDice: dice('basic', 'basic', 'basic', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'enchanted', 'exalted') });
		expect(expectedAttack(p)).toBeCloseTo(5.5);
		const q = makePlayer({ attackDice: dice('basic', 'basic', 'enchanted', 'exalted', 'arcane') });
		expect(attackLine(q as never)).toContain('average 4.7 damage');
		expect(buildRulesBrief(frozen)).toContain('basic 0,0,0,0,1,1; enchanted 0,0,0,1,1,1; exalted 1,1,1,2,2,2; arcane 0,0,1,3,3,5');
	});
	it('rolls: Basic 0 or 1, Enchanted 0 or 1, Exalted 1 or 2, Arcane 0, 1, 3 or 5', () => {
		const rolls = (tier: DiceTier) => {
			const state = makeState(makePlayer({ attackDice: dice(tier) }));
			const seen = new Set<number>();
			for (let i = 0; i < 300; i += 1) seen.add(rollAttack(state, state.players.Red!));
			return [...seen].sort((a, b) => a - b);
		};
		expect(rolls('basic')).toEqual([0, 1]);
		expect(rolls('enchanted')).toEqual([0, 1]);
		expect(rolls('exalted')).toEqual([1, 2]);
		expect(rolls('arcane')).toEqual([0, 1, 3, 5]);
	});
});

describe('no class gives initiative: Beast, Fighter, Monk and Paladin', () => {
	const fire = (traits: Record<string, number>) => {
		const p = makePlayer({ spirits: [spirit(1, traits)] });
		const log: string[] = [];
		resetCombatFlags(p);
		applyTrigger(makeState(p), 'Red', 'inCombat', log);
		return { damage: p.combatDamageBonus, initiative: p.initiative, ties: p.winsInitiativeTies === true, reduction: p.damageReduction ?? 0, log: log.join(' | ') };
	};
	it('Beast: 1 damage per Beast trait and no initiative', () => {
		const r = fire({ Beast: 4 });
		expect([r.damage, r.initiative]).toEqual([4, 0]);
		expect(r.log).toContain('Gained +4 combat damage');
		expect(r.log).not.toContain('initiative');
	});
	it('Fighter gives none; Monk still takes 2 less damage, Paladin still wins ties', () => {
		expect(fire({ Beast: 4, Fighter: 5 }).initiative).toBe(0);
		expect(fire({ Monk: 1 })).toMatchObject({ initiative: 0, ties: false, reduction: 2 });
		expect(fire({ Paladin: 1 })).toMatchObject({ initiative: 0, ties: true, reduction: 0 });
	});
});

describe('Rest restores 4 / 4 / 3 / 2 Barrier at Pure / Tainted / Corrupt / Fallen', () => {
	/** Barrier restored by one Rest at `statusLevel`, from 0 of Max Barrier 9. */
	const restored = (statusLevel: number, maxBarrier = 9) => {
		const p = makePlayer({ barrier: 0, maxBarrier, brokenBarrier: maxBarrier, statusLevel });
		applyRest(makeState(p), 'Red', []);
		return p.barrier;
	};
	it('restores 4, 4, 3, 2 by status', () => {
		expect([0, 1, 2, 3].map((s) => restored(s))).toEqual([4, 4, 3, 2]);
		expect(REST_BARRIER_BY_STATUS).toEqual([4, 4, 3, 2]);
		expect([0, 1, 2, 3].map((s) => restBarrier(s))).toEqual([4, 4, 3, 2]);
	});
	it('never goes above Max Barrier', () => {
		expect(restored(0, 3)).toBe(3);
	});
	it('the rules text names the numbers', () => {
		expect(buildRulesBrief(frozen)).toContain('Rest restores Barrier by your status (Pure 4, Tainted 4, Corrupt 3, Fallen 2; never above your Max Barrier)');
	});
});

describe('Fairy: Enchanted dice when it awakens', () => {
	it('gives 1 Enchanted dice per spirit of its origin, and no initiative', () => {
		const p = makePlayer({
			spirits: [
				spirit(1, { Fairy: 1 }, { origins: { Floral: 1 } }),
				spirit(2, { Fighter: 1 }, { origins: { Floral: 1 } }),
				spirit(3, { Healer: 1 }, { origins: { Floral: 1 } }),
				spirit(4, { Fighter: 1 }, { origins: { Tidal: 1 } })
			]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 1 } });
		expect({ tiers: p.attackDice.map((d) => d.tier).join(','), initiative: p.initiative }).toEqual({ tiers: 'enchanted,enchanted,enchanted', initiative: 0 });
		expect(FAIRY_DICE_TIER).toBe('enchanted');
	});
});

describe('Cursed Spirit: the dice of the Tainted reward are Basic', () => {
	const actor: GameActor = { memberId: 'host', role: 'host', displayName: 'Host', seatColor: 'Red' };
	/** Two Cursed Spirits, Tainted this round; the claim takes `maxBarrier` units as Max Barrier and the rest as dice. */
	const claim = (maxBarrier: number) => {
		const p = makePlayer({ maxBarrier: 6, spirits: [spirit(1, { 'Cursed Spirit': 2 })], becameTaintedThisRound: true });
		const state = makeState(p);
		state.status = 'active';
		enterBenefits(state);
		state.phase = 'benefits';
		const command: GameCommand = { type: 'resolveAwakenReward', taintedMaxBarrier: maxBarrier };
		const label = labelFor(command, state as never, 'Red', frozen);
		const result = applyGameCommand(state, actor, command, frozen);
		if (!result.ok) throw new Error(result.error.message);
		const after = result.state.players.Red!;
		return { tiers: after.attackDice.map((d) => d.tier).join(','), maxBarrier: after.maxBarrier, label };
	};
	it('gives Basic dice, one per Cursed Spirit', () => {
		const all = claim(0);
		expect(all.tiers).toBe('basic,basic');
		expect(all.label).toContain('2 Basic dice');
		expect(CURSED_SPIRIT_DICE_TIER).toBe('basic');
	});
	it('keeps the choice of Max Barrier', () => {
		expect(claim(1)).toMatchObject({ tiers: 'basic', maxBarrier: 7 });
	});
});

describe('Battle Adept: no attack dice for a fight that does not kill', () => {
	const fire = (combat: { dealt: number; overkill: number; killed: boolean }) => {
		const p = makePlayer({ spirits: [spirit(1, { 'Battle Adept': 1 })] });
		const before = p.maxBarrier;
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { combat });
		return { dice: p.attackDice.map((d) => d.tier).join(','), maxBarrier: p.maxBarrier - before };
	};
	it('a failed kill gives nothing, an overkill by 2 still gives 1 Max Barrier', () => {
		expect(fire({ dealt: 1, overkill: 0, killed: false })).toEqual({ dice: '', maxBarrier: 0 });
		expect(fire({ dealt: 9, overkill: 2, killed: true })).toEqual({ dice: '', maxBarrier: 1 });
	});
});

describe('Fighter and Cultivator: 1 / 2 / 3 / 5 at 2 / 3 / 4 / 5', () => {
	const fighters = (n: number) => makePlayer({ spirits: [spirit(1, { Fighter: n })] });
	const cultivators = (n: number) => makePlayer({ maxBarrier: 0, barrier: 0, spirits: [spirit(1, { Cultivator: n })] });
	const restDice = (n: number) => { const p = fighters(n); applyRest(makeState(p), 'Red', []); return p.attackDice.length; };
	const maxBarrier = (n: number) => { const p = cultivators(n); applyCultivate(makeState(p), 'Red', []); return p.maxBarrier; };
	it('Fighter on Rest: 1, 2, 3, 5 Basic dice at 2, 3, 4, 5 (the Spirit Augment at 5 stays)', () => {
		expect([1, 2, 3, 4, 5].map((n) => restDice(n))).toEqual([0, 1, 2, 3, 5]);
		const p = fighters(5), log: string[] = [];
		applyRest(makeState(p), 'Red', log);
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(log.join(' ')).toMatch(/augment/i);
	});
	it('Cultivator on Cultivate: 1, 2, 3, 5 Max Barrier at 2, 3, 4, 5', () => {
		expect([1, 2, 3, 4, 5].map((n) => maxBarrier(n))).toEqual([0, 1, 2, 3, 5]);
	});
	it('the class texts in the game data say so', () => {
		expect(classText('Fighter', 4)).toBe('On Rest, gain 3 Basic Attack Dice.');
		expect(classText('Fighter', 5)).toContain('gain 5 Basic Attack Dice and 1 of any spirit augment');
		expect(classText('Cultivator', 4)).toBe('On Cultivate, gain 3 Max Barrier.');
		expect(classText('Cultivator', 5)).toContain('gain 5 Max Barrier');
	});
});

describe('Elementalist: on Cultivate, 1 / 2 / 3 / 5 upgrades at 2 / 3 / 4 / 5 (5: with a relic, else 4)', () => {
	type Act = typeof applyCultivate;
	/** Dice above Basic after one `act` (each upgrade lifts one Basic die to Enchanted while Basic dice remain). */
	const after = (n: number, act: Act, mats: never[] = []) => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: n })], mats });
		act(makeState(p), 'Red', []);
		return p.attackDice.filter((d) => d.tier !== 'basic').length;
	};
	it('a Cultivate upgrades 1 / 2 / 3 / 5 at 2 / 3 / 4 / 5 Elementalists, none at 1; a Rest upgrades nothing', () => {
		expect([1, 2, 3, 4, 5, 6].map((n) => after(n, applyCultivate, [relic]))).toEqual([0, 1, 2, 3, 5, 5]);
		expect([2, 3, 4, 5].map((n) => after(n, applyRest, [relic]))).toEqual([0, 0, 0, 0]);
		expect(ELEMENTALIST_UPGRADES).toEqual([1, 2, 3, 5]);
	});
	it('the step at 5 needs a held relic (any relic); a rune is not one; without one, 5 upgrade 4 times', () => {
		expect(after(5, applyCultivate)).toBe(4);
		expect(after(5, applyCultivate, [rune])).toBe(4);
		expect(after(5, applyCultivate, [relic])).toBe(5);
		expect(after(4, applyCultivate, [relic])).toBe(3);
		expect(after(4, applyCultivate)).toBe(3);
		expect(ELEMENTALIST_NO_RELIC_UPGRADES).toBe(4);
	});
	it('a monster kill upgrades nothing', () => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: 5 })], mats: [relic] });
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], { combat: { dealt: 5, overkill: 0, killed: true, monsterDifficulty: 3 } });
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
	});
	it('upgrades the lowest die first', () => {
		const p = makePlayer({ attackDice: dice('basic', 'enchanted', 'enchanted', 'exalted'), spirits: [spirit(1, { Elementalist: 3 })] });
		applyCultivate(makeState(p), 'Red', []);
		// Two upgrades: the Basic die first, then one of the Enchanted dice.
		expect(p.attackDice.map((d) => d.tier).sort()).toEqual(['enchanted', 'enchanted', 'exalted', 'exalted']);
	});
	it('ten Basic dice are ten Exalted dice after 5 Cultivates at 5 Elementalists without a relic', () => {
		const p = makePlayer({ attackDice: tenBasic(), spirits: [spirit(1, { Elementalist: 5 })] });
		for (let i = 0; i < 4; i++) applyCultivate(makeState(p), 'Red', []);
		expect(p.attackDice.every((d) => d.tier === 'exalted')).toBe(false);
		applyCultivate(makeState(p), 'Red', []);
		expect(p.attackDice.every((d) => d.tier === 'exalted')).toBe(true);
	});
	it('the class texts in the game data say Cultivate', () => {
		expect(classText('Elementalist', 2)).toBe('When you Cultivate, upgrade an attack dice.');
		expect(classText('Elementalist', 4)).toBe('When you Cultivate, upgrade an attack dice 3 times.');
		expect(classText('Elementalist', 5)).toBe('When you Cultivate, upgrade an attack dice 5 times if you have a relic (any relic); 4 times if you have none.');
	});
});

describe('a Difficulty 3 monster restores 5 Barrier after a fight it survives (Michael, 2026-11-22)', () => {
	const d3 = (hp: number, restore?: number) => ({ ...(monster(hp, 5, 100) as object), difficulty: 3, ...(restore ? { restoreAfterCombat: restore } : {}) }) as never;
	/** A player with `beast` Beast traits and no dice deals exactly `beast` damage; Barrier 20 so the hit of 5 never corrupts. */
	const fighter = (beast: number, card: never) => makePlayer({ barrier: 20, maxBarrier: 20, spirits: [spirit(1, { Beast: beast })], monsterHand: [card] });
	it('only the damage beyond 5 stays on the card: 9 damage needs three fights against Barrier 16', () => {
		const p = fighter(9, d3(16, 5)), state = makeState(p);
		const first = fightMonster(state, 'Red')!;
		expect(first.killed).toBe(false);
		expect(first.fought!.hp).toBe(12); // 16 - 9 = 7, then 5 back
		expect(first.log.some((l) => l.includes('restores 5 Barrier (12/16)'))).toBe(true);
		expect(p.monsterHand![0].hp).toBe(12);
		expect(fightMonster(state, 'Red')!.fought!.hp).toBe(8);
		expect(fightMonster(state, 'Red')!.killed).toBe(true);
		expect(p.monsterHand).toHaveLength(0);
	});
	it('a fight that deals 5 or less makes no progress, and the Barrier never goes above the printed one', () => {
		const p = fighter(5, d3(16, 5)), state = makeState(p);
		expect(fightMonster(state, 'Red')!.fought!.hp).toBe(16);
		const q = fighter(3, d3(16, 5));
		expect(fightMonster(makeState(q), 'Red')!.fought!.hp).toBe(16);
	});
	it('a card without the ability keeps all its damage', () => {
		const p = fighter(9, d3(16));
		expect(fightMonster(makeState(p), 'Red')!.fought!.hp).toBe(7);
	});
	it('the ability is on Difficulty 3 cards only, not on the permanent monster; the players are told', () => {
		const m = (stage: number, permanent = false) => ({ id: `m${stage}`, name: 'M', damage: 5, barrier: 16, rewardTrack: [], dicePool: [], chooseAmount: 0, stage, order: 1, ...(permanent ? { permanent: true } : {}) }) as never;
		expect(difficulty3Restore(3)).toBe(5);
		expect(difficulty3Restore(2)).toBe(0);
		expect(monsterCardFromCatalog(m(3), frozen).restoreAfterCombat).toBe(5);
		expect(monsterCardFromCatalog(m(2), frozen).restoreAfterCombat).toBeUndefined();
		expect(monsterCardFromCatalog(m(3, true), frozen).restoreAfterCombat).toBeUndefined();
		expect(monsterLine(monsterCardFromCatalog(m(3), frozen))).toContain('ability: restores 5 Barrier after a fight it survives');
		expect(monsterLine(monsterCardFromCatalog(m(2), frozen))).not.toContain('ability');
		expect(buildRulesBrief(frozen)).toContain('DIFFICULTY 3 ABILITY: every Difficulty 3 monster restores 5 Barrier');
	});
});

describe('Arcane Alchemist converts one augment a round (Michael, 2026-11-22)', () => {
	const aug = (slot: number, runeId: string) => ({ spiritSlotIndex: slot, runeId, className: 'Beast', classId: 'beast' }) as never;
	const setup = () => {
		const p = makePlayer({ spirits: [spirit(1, { 'Arcane Alchemist': 1 })], spiritAugmentAttachments: [aug(1, 'r1'), aug(1, 'r2')] });
		const state = makeState(p);
		state.round = 3;
		const cultivate = () => { p.pendingDecisions = []; const log: string[] = []; applyCultivate(state, 'Red', log); return p.pendingDecisions.filter((d) => d.kind === ALCHEMIST_AUGMENT_KIND).length; };
		const convert = (id: string) => alchemistDecisions[ALCHEMIST_AUGMENT_KIND]!({ state, player: p, log: [], seat: 'Red' } as never, id);
		return { p, state, cultivate, convert };
	};
	const arcane = (p: { attackDice: { tier: DiceTier }[] }) => p.attackDice.filter((d) => d.tier === 'arcane').length;
	it('after a conversion a second Cultivate in the same round offers nothing; the next round offers again', () => {
		const { p, state, cultivate, convert } = setup();
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
		const { p, cultivate, convert } = setup();
		expect(cultivate()).toBe(1);
		convert('no');
		expect(arcane(p)).toBe(0);
		expect(cultivate()).toBe(1);
	});
	it('the class text in the game data says once a round', () => {
		expect(classText('Arcane Alchemist', 1)).toBe('When you Cultivate, you may convert 1 of your Spirit Augments into 1 Arcane Attack Dice (once a round).');
	});
});

describe('Sentinel: 1 damage for each die it discards (Michael, 2026-11-22: "nerf sentinel to do 1 damage per dice instead")', () => {
	const sentinel = () => makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], attackDice: dice('basic', 'basic', 'basic', 'basic', 'basic'), sentinelDiscardIds: ['d0', 'd1', 'd2', 'd3', 'd4'] });
	it('five discarded dice are 5 more damage', () => {
		const p = sentinel(), log: string[] = [];
		useSentinelDiscard(p, log);
		expect(SENTINEL_DAMAGE_PER_DIE).toBe(1);
		expect(p.discardDamageBonus).toBe(5);
		expect(p.attackDice).toHaveLength(0);
		expect(log[0]).toContain('discarded 5 attack dice before the roll for 5 more damage');
	});
	it('in a fight: Beast 3 and five discarded dice deal 8 to a monster', () => {
		const p = makePlayer({ barrier: 20, maxBarrier: 20, spirits: [spirit(1, { Sentinel: 1, Beast: 3 })], attackDice: dice('basic', 'basic', 'basic', 'basic', 'basic'), sentinelDiscardIds: ['d0', 'd1', 'd2', 'd3', 'd4'], monsterHand: [monster(16, 5, 100) as never] });
		expect(16 - fightMonster(makeState(p), 'Red')!.fought!.hp).toBe(8);
	});
	it('the class text, the decision card and its log line name the number', () => {
		expect(classText('Sentinel', 1)).toBe('Before you roll in combat, you may discard attack dice. For each dice that you discard, deal 1 more damage.');
		const p = makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], attackDice: dice('basic', 'basic') });
		const state = makeState(p), log: string[] = [];
		sentinelAbility[0].run!({ state, seat: 'Red', player: p, log, trigger: 'awakeningPhase' } as never);
		expect(p.pendingDecisions!.find((d) => d.kind === SENTINEL_DISCARD_KIND)!.prompt).toContain('Each discarded die deals 1 more damage.');
		sentinelDecisions[SENTINEL_DISCARD_KIND]({ state, seat: 'Red', player: p, log, trigger: 'awakeningPhase' } as never, 'yes', ['d0', 'd1']);
		expect(log.at(-1)).toContain('(+2 damage)');
	});
});

describe('Mage: 3 Arcane dice on its awakening (Michael, 2026-11-22: "nerf the mage by 1 attack dice so only 3 arcane attack")', () => {
	it('gives 3 Arcane dice; the class text in the game data names the number', () => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { type: 'awakenSpirit', slotIndex: 1 } as never });
		expect(p.attackDice.map((d) => d.tier)).toEqual(['arcane', 'arcane', 'arcane']);
		expect(MAGE_AWAKEN_ARCANE_DICE).toBe(3);
		expect(classText('Mage', 1)).toBe("On this spirit's Awakening, gain 3 Arcane Attack Dice.");
	});
});

describe('the sacrifice of a corruption stops growing at 4 (Michael, 2026-11-26: "after the last sacriface, it stops at 4")', () => {
	/** A Fallen player with `spirits` spirits and `count` corruptions so far takes a hit that corrupts: points lost and spirits owed. */
	const corruptAgain = (count: number, spirits: number) => {
		const p = makePlayer({
			statusLevel: 3, statusToken: 'Fallen', barrier: 2, maxBarrier: 6, victoryPoints: 20, corruptionCount: count,
			spirits: Array.from({ length: spirits }, (_, i) => spirit(i + 1, { Healer: 1 }))
		} as never);
		const log: string[] = [];
		const r = takeDamage(p, 9, undefined, log);
		return { corrupted: r.corrupted, lost: 20 - p.victoryPoints, owed: p.pendingCorruptionDiscard?.count ?? 0, count: p.corruptionCount };
	};
	it('the 5th and 6th corruption cost 4, like the 4th', () => {
		expect(SACRIFICE_MAX).toBe(4);
		expect(corruptAgain(3, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 4 });
		expect(corruptAgain(4, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 5 });
		expect(corruptAgain(5, 0)).toEqual({ corrupted: true, lost: 4, owed: 0, count: 6 });
		// Spirits are paid first: 3 spirits and 4 owed leave 1 point to lose.
		expect(corruptAgain(5, 3)).toEqual({ corrupted: true, lost: 1, owed: 3, count: 6 });
		// The first corruptions cost 1, 2, 3.
		expect(corruptAgain(1, 7)).toEqual({ corrupted: true, lost: 0, owed: 2, count: 2 });
	});
	it('the rules text says where it stops', () => {
		expect(buildRulesBrief(frozen)).toContain('4 for the 4th (and 4 for every corruption after your 4th: it stops growing there)');
	});
});
