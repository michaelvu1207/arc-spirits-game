/**
 * The class changes of 2026-11-14 (Michael), one rule switch each (rules.ts): mysticSwap23,
 * falconerDoubleKill, herderArcaneAugments, riderAugmentOption, mageArcaneDice,
 * shieldbearerFullOnly. Each is checked on and off.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { fightMonster, resetCombatFlags } from './combat';
import { applyTrigger, cultivateRuneMultiplier } from './effects/apply';
import { augmentPlacementEligibility, ownerAugmentCapacity } from './augments';
import { ruleAdjustedClassSchema } from './rules';
import { ctxFor, makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { decisions as riderDecisions } from './effects/classes/rider';
import { loadFrozenCatalog } from './agents/catalog';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PlayRules, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
const withRules = (rules: PlayRules | undefined): PlayCatalog => ({ ...frozen, rules });
const dice = (tier: 'basic' | 'arcane', n: number) =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier }));
const monster = (hp: number, damage: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;

describe('mysticSwap23: Mystic (2) attacks at the same time, Mystic (3) doubles Cultivate runes', () => {
	const SWAP = withRules({ mysticCultivateDouble: true, mysticSwap23: true });
	const OLD = withRules({ mysticCultivateDouble: true });
	/** A hit that corrupts: the player strikes back only with a simultaneous attack. */
	const strikesBack = (catalog: PlayCatalog, mystic: number) => {
		const p = makePlayer({ barrier: 1, maxBarrier: 1, attackDice: dice('arcane', 5), spirits: [spirit(1, { Mystic: mystic })], monsterHand: [monster(10, 5)] });
		const result = fightMonster(makeState(p), 'Red', catalog, 0)!;
		expect(result.corrupted).toBe(true);
		return result.playerDamage > 0;
	};
	it('simultaneous attack: at 2 with the swap, at 3 without', () => {
		expect(strikesBack(SWAP, 2)).toBe(true);
		expect(strikesBack(SWAP, 1)).toBe(false);
		expect(strikesBack(OLD, 2)).toBe(false);
		expect(strikesBack(OLD, 3)).toBe(true);
	});
	it('Cultivate doubling: at 3 with the swap, at 2 without', () => {
		const mult = (catalog: PlayCatalog, mystic: number) =>
			cultivateRuneMultiplier(makePlayer({ spirits: [spirit(1, { Mystic: mystic })] }), catalog);
		expect([mult(SWAP, 2), mult(SWAP, 3)]).toEqual([1, 2]);
		expect([mult(OLD, 2), mult(OLD, 3)]).toEqual([2, 2]);
	});
	it('printed text follows the switch', () => {
		const schema = [1, 2, 3].map((count) => ({ count, effects: [{ type: 'benefit', description: `old ${count}` }] })) as never;
		const out = ruleAdjustedClassSchema(SWAP, 'Mystic', schema)!;
		expect(out[1].effects?.[0].description).toContain('attack at the same time');
		expect(out[2].effects?.[0].description).toContain('twice as many runes');
	});
});

describe('herderArcaneAugments: each Arcane spirit may hold 2 Spirit Augments', () => {
	const ON = withRules({ herderArcaneAugments: true });
	const board = (herderFaceDown = false) =>
		makePlayer({
			spirits: [
				{ ...spirit(1, { Herder: 1 }, { faceDown: herderFaceDown }), cost: 7 },
				{ ...spirit(2, { Fighter: 1 }), cost: 7 },
				{ ...spirit(3, { Fighter: 1 }), cost: 3 }
			],
			spiritAugmentAttachments: [
				{ runeId: 'a', spiritId: 's2', spiritSlotIndex: 2, className: 'Fighter' },
				{ runeId: 'b', spiritId: 's3', spiritSlotIndex: 3, className: 'Fighter' }
			]
		});
	it('capacity 2 for cost 7+, 1 for a Spirit World spirit', () => {
		const p = board();
		expect(p.spirits.map((s) => ownerAugmentCapacity(p, s, ON))).toEqual([2, 2, 1]);
	});
	it('a face-down Herder, or the rule off: capacity 1', () => {
		const down = board(true);
		expect(down.spirits.map((s) => ownerAugmentCapacity(down, s, ON))).toEqual([1, 1, 1]);
		const p = board();
		expect(p.spirits.map((s) => ownerAugmentCapacity(p, s, frozen))).toEqual([1, 1, 1]);
	});
	it('a second augment may go on the Arcane spirit that has one, not on the Spirit World spirit', () => {
		const p = board();
		const augment = { runeId: 'x', name: 'Spirit Augment' } as never;
		expect(augmentPlacementEligibility(p, augment, ON).eligibleSpiritSlots).toEqual([1, 2]);
		expect(augmentPlacementEligibility(p, augment, frozen).eligibleSpiritSlots).toEqual([1]);
	});
	it('gives no runes and no augments on awaken; off: the old runes for Beasts', () => {
		const awaken = (catalog: PlayCatalog) => {
			const p = makePlayer({ spirits: [spirit(1, { Herder: 1 }), spirit(2, { Beast: 1 }, { origins: { 'Fire Region': 1 } })] });
			applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog, command: { type: 'awakenSpirit', slotIndex: 1 } });
			return [p.mats.filter((m) => m.hasRune).length, (p.unplacedAugments ?? []).length];
		};
		expect(awaken(ON)).toEqual([0, 0]);
		expect(awaken(frozen)).toEqual([1, 0]);
	});
});

describe('riderAugmentOption: the Mountain Region choice also offers 1 Spirit Augment', () => {
	const ON = withRules({ riderAugmentOption: true });
	const arrive = (catalog: PlayCatalog) => {
		const p = makePlayer({ spirits: [spirit(1, { Rider: 1 })], navigationDestination: 'Mountain Region' as never });
		applyTrigger(makeState(p), 'Red', 'onNavigate', [], { catalog });
		return { p, card: p.pendingDecisions.find((d) => d.kind === 'riderMountain')! };
	};
	it('on: four options, the augment option gives 1 augment; the engine never picks it', () => {
		const { p, card } = arrive(ON);
		expect(card.options.map((o) => o.id)).toEqual(['restore', 'maxBarrier', 'dice', 'augment']);
		riderDecisions.riderMountain({ ...ctxFor(p), catalog: ON }, 'augment');
		expect(p.unplacedAugments).toHaveLength(1);
		const auto = arrive(ON).p;
		riderDecisions.riderMountain({ ...ctxFor(auto), catalog: ON }, 'auto');
		expect(auto.unplacedAugments ?? []).toHaveLength(0);
	});
	it('off: three options', () => {
		expect(arrive(frozen).card.options.map((o) => o.id)).toEqual(['restore', 'maxBarrier', 'dice']);
	});
});

describe('mageArcaneDice: on its awakening the Mage gives 4 Arcane Attack Dice, nothing else', () => {
	const ON = withRules({ sunRework: true, mageArcaneDice: true });
	const SUN = withRules({ sunRework: true });
	const awaken = (catalog: PlayCatalog) => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog, command: { type: 'awakenSpirit', slotIndex: 1 } });
		return p.attackDice.map((d) => d.tier);
	};
	const phaseCards = (catalog: PlayCatalog) => {
		const p = makePlayer({ spirits: [spirit(1, { Mage: 1 })], mats: [{ slotIndex: 1, hasRune: true, name: 'Fire Rune', type: 'rune' }] as never });
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', [], { catalog });
		return p.pendingDecisions.filter((d) => d.kind === 'runeMageTrade').length;
	};
	it('on: 4 Arcane dice and no rune trade card', () => {
		expect(awaken(ON)).toEqual(['arcane', 'arcane', 'arcane', 'arcane']);
		expect(phaseCards(ON)).toBe(0);
	});
	it('off (sunRework only): 2 Exalted dice and the rune trade card', () => {
		expect(awaken(SUN)).toEqual(['exalted', 'exalted']);
		expect(phaseCards(SUN)).toBe(1);
	});
	it('another spirit awakening gives no dice', () => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 }), spirit(2, { Fighter: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: ON, command: { type: 'awakenSpirit', slotIndex: 2 } });
		expect(p.attackDice).toHaveLength(0);
	});
});

describe('shieldbearerFullOnly: 5 less damage at full Barrier, nothing otherwise', () => {
	const ON = withRules({ sunRework: true, shieldbearerFullOnly: true });
	const SUN = withRules({ sunRework: true });
	const reduction = (catalog: PlayCatalog, barrier: number) => {
		const p = makePlayer({ barrier, maxBarrier: 6, spirits: [spirit(1, { Shieldbearer: 1 })] });
		resetCombatFlags(p);
		applyTrigger(makeState(p), 'Red', 'onTakeDamage', [], { catalog });
		return p.damageReduction;
	};
	it('on: 5 at full Barrier, 0 below', () => {
		expect([reduction(ON, 6), reduction(ON, 5)]).toEqual([5, 0]);
	});
	it('off (sunRework only): 4 at full, 2 below', () => {
		expect([reduction(SUN, 6), reduction(SUN, 5)]).toEqual([4, 2]);
	});
});

// ── Falconer, through the real reducer ───────────────────────────────────────
const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' }
} as const;
const LURKER: PlayCatalogMonster = { id: 'perm', name: 'Abyss Lurker', damage: 1, barrier: 1, rewardTrack: [VP, ABYSS_SUMMON], dicePool: [], chooseAmount: 2, stage: 1, order: 9, initiative: 0, permanent: true };
const falconerCatalog = (rules?: PlayRules): PlayCatalog => ({
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 14 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
	monsters: [{ ...LURKER, id: 'deck-1', name: 'Deck Monster', permanent: undefined }, LURKER],
	rules
});
function ok(state: PublicGameState, catalog: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = applyGameCommand(state, actor as never, command, catalog);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red (with an awakened Falconer spirit) has just defeated the Abyss Lurker. */
function afterKill(catalog: PlayCatalog, falconer: 'spirit' | 'none' = 'spirit'): PublicGameState {
	let s = createLobbyState({ roomCode: 'FALC', guardianNames: ['Myrtle', 'Nyra'] });
	s = ok(s, catalog, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	s = ok(s, catalog, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	s = ok(s, catalog, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	s = ok(s, catalog, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	s = ok(s, catalog, ACTORS.Red, { type: 'startGame', seed: 3 });
	for (const seat of ['Red', 'Blue'] as const)
		s = ok(s, catalog, ACTORS[seat], { type: 'lockNavigation', destination: 'Arcane Abyss' });
	if (s.phase !== 'location') s = ok(s, catalog, ACTORS.Red, { type: 'forceAdvancePhase' });
	const red = s.players.Red!;
	red.spirits = [
		{ slotIndex: 1, id: 'eagle', name: 'Eagle Keeper', cost: 7, classes: falconer === 'spirit' ? { Falconer: 1 } : {}, origins: {}, isFaceDown: false },
		{ slotIndex: 2, id: 'other', name: 'Other', cost: 3, classes: {}, origins: {}, isFaceDown: false }
	];
	red.barrier = 10;
	red.maxBarrier = 10;
	red.attackDice = dice('arcane', 3);
	s = ok(s, catalog, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1, permanent: true });
	s = ok(s, catalog, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
	expect(s.players.Red!.pendingReward?.monsterName).toBe('Abyss Lurker');
	return s;
}
const card = (s: PublicGameState) => s.players.Red!.pendingDecisions.find((d) => d.kind === 'falconerDouble');

describe('falconerDoubleKill: "On your next monster kill you may gain double the rewards. Then discard this spirit."', () => {
	const ON = falconerCatalog({ falconerDoubleKill: true });

	it('yes: every reward twice, and the Falconer spirit is discarded', () => {
		let s = afterKill(ON);
		const c = card(s)!;
		expect(c.options.map((o) => o.id)).toEqual(['yes', 'no']);
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, ON, ACTORS.Red, { type: 'resolveDecision', decisionId: c.id, optionId: 'yes' });
		expect(s.players.Red!.spirits.map((x) => x.name)).toEqual(['Other']);
		expect(s.players.Red!.pendingReward?.rewardTrack).toEqual([VP, ABYSS_SUMMON, VP, ABYSS_SUMMON]);
		s = ok(s, ON, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 2);
		expect(card(s)).toBeUndefined();
	});

	it('with falconerNoDoubleVp: every reward twice except Victory Points', () => {
		const NO_VP = falconerCatalog({ falconerDoubleKill: true, falconerNoDoubleVp: true });
		let s = afterKill(NO_VP);
		const c = card(s)!;
		expect(c.options[0].label).toContain('except Victory Points');
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, NO_VP, ACTORS.Red, { type: 'resolveDecision', decisionId: c.id, optionId: 'yes' });
		expect(s.players.Red!.spirits.map((x) => x.name)).toEqual(['Other']);
		expect(s.players.Red!.pendingReward?.rewardTrack).toEqual([VP, ABYSS_SUMMON, ABYSS_SUMMON]);
		expect(s.players.Red!.pendingReward?.chooseAmount).toBe(3);
		s = ok(s, NO_VP, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
	});

	it('no: the usual rewards, the spirit stays, and the next kill asks again', () => {
		let s = afterKill(ON);
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, ON, ACTORS.Red, { type: 'resolveDecision', decisionId: card(s)!.id, optionId: 'no' });
		s = ok(s, ON, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
		expect(s.players.Red!.spirits.map((x) => x.name)).toContain('Eagle Keeper');
	});

	it('claiming without an answer: usual rewards, the card is gone, the spirit stays', () => {
		let s = afterKill(ON);
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, ON, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
		expect(card(s)).toBeUndefined();
		expect(s.players.Red!.spirits.map((x) => x.name)).toContain('Eagle Keeper');
	});

	it('no card without a Falconer spirit, or with the rule off', () => {
		expect(card(afterKill(ON, 'none'))).toBeUndefined();
		expect(card(afterKill(falconerCatalog()))).toBeUndefined();
	});

	it('on: no augments when the Falconer awakens; off: 2 augments', () => {
		const awaken = (catalog: PlayCatalog) => {
			const p = makePlayer({ spirits: [spirit(1, { Falconer: 1 })] });
			applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog, command: { type: 'awakenSpirit', slotIndex: 1 } });
			return (p.unplacedAugments ?? []).length;
		};
		expect(awaken(withRules({ falconerDoubleKill: true }))).toBe(0);
		expect(awaken(frozen)).toBe(2);
	});
});
