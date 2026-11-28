/**
 * The class changes of 2026-11-14 (Michael): Mystic (2) attacks at the same time and Mystic (3)
 * doubles Cultivate runes, Falconer doubles a kill, Herder's Arcane spirits hold 2 augments, Rider
 * offers an augment, Mage gives Arcane dice, Shieldbearer reduces at full Barrier only; and a
 * monster card's deck is its stage. (They were rule switches until 2026-11-27; see
 * docs/rules-history-2026-11.md.)
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState, monsterDifficulty } from './runtime';
import { fightMonster, resetCombatFlags } from './combat';
import { applyTrigger, cultivateRuneMultiplier } from './effects/apply';
import { augmentPlacementEligibility, ownerAugmentCapacity } from './augments';
import { MAGE_AWAKEN_ARCANE_DICE } from './rules';
import { readFileSync } from 'node:fs';
import { ctxFor, makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { decisions as riderDecisions } from './effects/classes/rider';
import { loadFrozenCatalog } from './agents/catalog';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PublicGameState } from './types';

const frozen: PlayCatalog = loadFrozenCatalog();
/** The printed text of `className` at `count`, from the game data. */
const classText = (className: string, count: number): string => {
	const classes = JSON.parse(readFileSync('data/classes.json', 'utf8')) as {
		name: string;
		effect_schema: { count: number; effects: { description: string }[] }[];
	}[];
	const row = classes.find((c) => c.name === className)?.effect_schema.find((r) => r.count === count);
	return row?.effects.map((e) => e.description).join(' ') ?? '';
};
const dice = (tier: 'basic' | 'arcane', n: number) =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier }));
const monster = (hp: number, damage: number) =>
	({ id: 'm', name: 'Test Monster', hp, maxHp: hp, damage, rewardTrack: [], chooseAmount: 0, livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1 }) as never;

describe('mysticSwap23: Mystic (2) attacks at the same time, Mystic (3) doubles Cultivate runes', () => {
	/** A hit that corrupts: the player strikes back only with a simultaneous attack. */
	const strikesBack = (mystic: number) => {
		const p = makePlayer({ barrier: 1, maxBarrier: 1, attackDice: dice('arcane', 5), spirits: [spirit(1, { Mystic: mystic })], monsterHand: [monster(10, 5)] });
		const result = fightMonster(makeState(p), 'Red', frozen, 0)!;
		expect(result.corrupted).toBe(true);
		return result.playerDamage > 0;
	};
	it('simultaneous attack from Mystic (2)', () => {
		expect(strikesBack(2)).toBe(true);
		expect(strikesBack(1)).toBe(false);
	});
	it('Cultivate doubling from Mystic (3)', () => {
		const mult = (mystic: number) =>
			cultivateRuneMultiplier(makePlayer({ spirits: [spirit(1, { Mystic: mystic })] }), frozen);
		expect([mult(2), mult(3)]).toEqual([1, 2]);
	});
	it('the printed texts in the game data', () => {
		expect(classText('Mystic', 2)).toContain('attack at the same time');
		expect(classText('Mystic', 3)).toContain('twice as many runes');
	});
});

describe('herderArcaneAugments: each Arcane spirit may hold 2 Spirit Augments', () => {
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
		expect(p.spirits.map((s) => ownerAugmentCapacity(p, s))).toEqual([2, 2, 1]);
	});
	it('a face-down Herder: capacity 1', () => {
		const down = board(true);
		expect(down.spirits.map((s) => ownerAugmentCapacity(down, s))).toEqual([1, 1, 1]);
	});
	it('a second augment may go on the Arcane spirit that has one, not on the Spirit World spirit', () => {
		const p = board();
		const augment = { runeId: 'x', name: 'Spirit Augment' } as never;
		expect(augmentPlacementEligibility(p, augment).eligibleSpiritSlots).toEqual([1, 2]);
	});
	it('gives no runes and no augments on awaken', () => {
		const p = makePlayer({ spirits: [spirit(1, { Herder: 1 }), spirit(2, { Beast: 1 }, { origins: { 'Fire Region': 1 } })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: frozen, command: { type: 'awakenSpirit', slotIndex: 1 } });
		expect([p.mats.filter((m) => m.hasRune).length, (p.unplacedAugments ?? []).length]).toEqual([0, 0]);
	});
});

describe('riderAugmentOption: the Mountain Region choice also offers 1 Spirit Augment', () => {
	const arrive = () => {
		const p = makePlayer({ spirits: [spirit(1, { Rider: 1 })], navigationDestination: 'Mountain Region' as never });
		applyTrigger(makeState(p), 'Red', 'onNavigate', [], { catalog: frozen });
		return { p, card: p.pendingDecisions.find((d) => d.kind === 'riderMountain')! };
	};
	it('four options, the augment option gives 1 augment; the engine never picks it', () => {
		const { p, card } = arrive();
		expect(card.options.map((o) => o.id)).toEqual(['restore', 'maxBarrier', 'dice', 'augment']);
		riderDecisions.riderMountain({ ...ctxFor(p), catalog: frozen }, 'augment');
		expect(p.unplacedAugments).toHaveLength(1);
		const auto = arrive().p;
		riderDecisions.riderMountain({ ...ctxFor(auto), catalog: frozen }, 'auto');
		expect(auto.unplacedAugments ?? []).toHaveLength(0);
	});
});

describe('mageArcaneDice: on its awakening the Mage gives 3 Arcane Attack Dice, nothing else', () => {
	const awaken = () => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: frozen, command: { type: 'awakenSpirit', slotIndex: 1 } });
		return p.attackDice.map((d) => d.tier);
	};
	const phaseCards = () => {
		const p = makePlayer({ spirits: [spirit(1, { Mage: 1 })], mats: [{ slotIndex: 1, hasRune: true, name: 'Fire Rune', type: 'rune' }] as never });
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', [], { catalog: frozen });
		return p.pendingDecisions.filter((d) => d.kind === 'runeMageTrade').length;
	};
	it('3 Arcane dice and no rune trade card', () => {
		expect(MAGE_AWAKEN_ARCANE_DICE).toBe(3);
		expect(awaken()).toEqual(['arcane', 'arcane', 'arcane']);
		expect(phaseCards()).toBe(0);
		expect(classText('Mage', 1)).toBe("On this spirit's Awakening, gain 3 Arcane Attack Dice.");
	});
	it('another spirit awakening gives no dice', () => {
		const p = makePlayer({ attackDice: [], spirits: [spirit(1, { Mage: 1 }), spirit(2, { Fighter: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: frozen, command: { type: 'awakenSpirit', slotIndex: 2 } });
		expect(p.attackDice).toHaveLength(0);
	});
});

describe('shieldbearerFullOnly: 5 less damage at full Barrier, nothing otherwise', () => {
	const reduction = (barrier: number) => {
		const p = makePlayer({ barrier, maxBarrier: 6, spirits: [spirit(1, { Shieldbearer: 1 })] });
		resetCombatFlags(p);
		applyTrigger(makeState(p), 'Red', 'onTakeDamage', [], { catalog: frozen });
		return p.damageReduction;
	};
	it('5 at full Barrier, 0 below', () => {
		expect([reduction(6), reduction(5)]).toEqual([5, 0]);
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
const falconerCatalog = (): PlayCatalog => ({
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 14 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
	monsters: [{ ...LURKER, id: 'deck-1', name: 'Deck Monster', permanent: undefined }, LURKER]
});
function ok(state: PublicGameState, catalog: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = applyGameCommand(state, actor as never, command, catalog);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/**
 * Red (with an awakened Falconer spirit) has just defeated the Abyss Lurker (the permanent monster,
 * whose claim is one reward of the player's choice) or, with `target` 'deck', the Deck Monster
 * (every reward of the card).
 */
function afterKill(catalog: PlayCatalog, falconer: 'spirit' | 'none' = 'spirit', target: 'permanent' | 'deck' = 'permanent'): PublicGameState {
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
	if (target === 'permanent') {
		s = ok(s, catalog, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1, permanent: true });
	} else {
		s = ok(s, catalog, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 });
		s = ok(s, catalog, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
	}
	s = ok(s, catalog, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
	expect(s.players.Red!.pendingReward?.monsterName).toBe(target === 'permanent' ? 'Abyss Lurker' : 'Deck Monster');
	return s;
}
const card = (s: PublicGameState) => s.players.Red!.pendingDecisions.find((d) => d.kind === 'falconerDouble');

describe('falconerDoubleKill: "On your next monster kill you may gain double the rewards, except Victory Points. Then discard this spirit."', () => {
	const CAT = falconerCatalog();

	it('yes: every reward of the card twice except Victory Points, and the Falconer spirit is discarded', () => {
		let s = afterKill(CAT, 'spirit', 'deck');
		const c = card(s)!;
		expect(c.options.map((o) => o.id)).toEqual(['yes', 'no']);
		expect(c.options[0].label).toContain('except Victory Points');
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveDecision', decisionId: c.id, optionId: 'yes' });
		expect(s.players.Red!.spirits.map((x) => x.name)).toEqual(['Other']);
		expect(s.players.Red!.pendingReward?.rewardTrack).toEqual([VP, ABYSS_SUMMON, ABYSS_SUMMON]);
		expect(s.players.Red!.pendingReward?.chooseAmount).toBe(3);
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
		expect(card(s)).toBeUndefined();
	});

	it('yes on the permanent monster: the one chosen reward is paid twice, but Victory Points once', () => {
		let s = afterKill(CAT);
		expect(s.players.Red!.pendingReward).toMatchObject({ rewardTrack: [VP, ABYSS_SUMMON], chooseAmount: 1, chooseOne: true });
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveDecision', decisionId: card(s)!.id, optionId: 'yes' });
		expect(s.players.Red!.spirits.map((x) => x.name)).toEqual(['Other']);
		expect(s.players.Red!.pendingReward).toMatchObject({ rewardTrack: [VP, ABYSS_SUMMON], chooseAmount: 1, doubled: true });
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveMonsterReward', picks: [0] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
	});

	it('no: the usual rewards, the spirit stays, and the next kill asks again', () => {
		let s = afterKill(CAT);
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveDecision', decisionId: card(s)!.id, optionId: 'no' });
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
		expect(s.players.Red!.spirits.map((x) => x.name)).toContain('Eagle Keeper');
	});

	it('claiming without an answer: usual rewards, the card is gone, the spirit stays', () => {
		let s = afterKill(CAT);
		const vp = s.players.Red!.victoryPoints;
		s = ok(s, CAT, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vp + 1);
		expect(card(s)).toBeUndefined();
		expect(s.players.Red!.spirits.map((x) => x.name)).toContain('Eagle Keeper');
	});

	it('no card without a Falconer spirit', () => {
		expect(card(afterKill(CAT, 'none'))).toBeUndefined();
	});

	it('no augments when the Falconer awakens', () => {
		const p = makePlayer({ spirits: [spirit(1, { Falconer: 1 })] });
		applyTrigger(makeState(p), 'Red', 'awakening', [], { catalog: frozen, command: { type: 'awakenSpirit', slotIndex: 1 } });
		expect((p.unplacedAugments ?? []).length).toBe(0);
	});
});

// ── monsterDeckByStage (balance test of 2026-11-18) ──────────────────────────
describe('monsterDeckByStage: a card\'s deck is its stage, not its Barrier band', () => {
	const tough: PlayCatalogMonster = { ...LURKER, id: 'tough', name: 'Tough Stage 2', barrier: 12, stage: 2, permanent: undefined };
	const catalog: PlayCatalog = { ...falconerCatalog(), monsters: [tough, LURKER] };
	const dealt = (c: PlayCatalog) => {
		let s = createLobbyState({ roomCode: 'DECK', guardianNames: ['Myrtle', 'Nyra'] });
		s = ok(s, c, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
		s = ok(s, c, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
		s = ok(s, c, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
		s = ok(s, c, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
		s = ok(s, c, ACTORS.Red, { type: 'startGame', seed: 3 });
		return s.bags.monsters.contents.map((e) => e.difficulty);
	};
	it('Barrier 12 at stage 2 is in the Difficulty 2 deck', () => {
		expect(monsterDifficulty(tough, catalog)).toBe(2);
		expect(dealt(catalog)).toEqual([2]);
	});
	it('the deck does not depend on whether a catalog is passed', () => {
		expect(monsterDifficulty(tough)).toBe(2);
	});
	it('a card without a stage of 1 to 3 keeps its Barrier band', () => {
		expect(monsterDifficulty({ barrier: 5, stage: 0 }, catalog)).toBe(2);
		expect(monsterDifficulty({ barrier: 5, stage: 0 })).toBe(2);
	});
});
