/**
 * November 2026 catalog — deterministic tests for every new or changed class ability and for
 * the relic tools. Texts quoted from ~/ArcSpiritsArt/game/classes.json (`effect_schema`) and
 * relics.json (`ability`).
 */

import { describe, expect, it } from 'vitest';
import { fire, makePlayer, makeState, spirit } from './classes/testHelpers';
import { applyCultivate, applyTrigger } from './apply';
import { checkAwakenCondition } from './awaken';
import { buildEffectContext } from './context';
import { DECISION_RESOLVERS } from './decisions';
import { offerHeldRelicTools, CLEANSING_TEAPOT_ID, FIRECRACKER_ID, FLOWER_ID, DIAMOND_ID } from './relicTools';
import {
	fightMonster,
	resetCombatFlags,
	resolveEncounterCombat,
	rollAttack,
	takeDamage
} from '../combat';
import { WILDCARD_MAT_IDS } from '../awakenConditions';
import { upgradeRelicRuneSlots } from '../baseRunes';
import { addGainedRune } from '../runtime';
import { autoPickCostSlots, matchRewardCost, type CostRequirement } from '../locationInteractions';
import type { MonsterState, PlayCatalog, PrivatePlayerState, PublicGameState, SeatColor } from '../types';
import type { MatSlotSnapshot } from '$lib/types';

const WATER_RUNE = '5eba8681-16b8-4563-b017-22c80a84b35b';
const FIRE_RUNE = '480cd5f7-adea-481d-8ea9-aad776599d7b';
const WATER_ORIGIN = '294cee31-a7ac-4292-9b61-d4293c05c146';
const FIRE_ORIGIN = '178449e9-cc6b-45ab-8522-5183fe1d9307';
const MOUNTAIN_RUNE = '356f3ad2-4cac-4b69-a3cc-7559f8891d8e';
const MOUNTAIN_ORIGIN = 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e';

function rune(slotIndex: number, id: string, name: string, originId: string): MatSlotSnapshot {
	return { slotIndex, hasRune: true, id, name, type: 'rune', originId };
}

function relicTool(slotIndex: number, id: string, name: string): MatSlotSnapshot {
	return { slotIndex, hasRune: true, id, name, type: 'relic', special: true, relicTool: true };
}

/** A two-seat PvP state: Red (Good) and Blue (Evil) at the same location. */
function pvp(red: Partial<PrivatePlayerState>, blue: Partial<PrivatePlayerState>, seed = 1) {
	const r = makePlayer({ playerColor: 'Red', navigationDestination: 'Forest Region', ...red });
	const b = makePlayer({
		playerColor: 'Blue',
		statusLevel: 3,
		statusToken: 'Fallen',
		navigationDestination: 'Forest Region',
		...blue
	});
	const state = makeState(r, { Blue: b }, seed);
	return { state, red: r, blue: b };
}

function monster(damage: number, hp: number): MonsterState {
	return {
		id: 'm',
		name: 'Test Monster',
		hp,
		maxHp: hp,
		damage,
		rewardTrack: [],
		chooseAmount: 0,
		livesRemaining: 1,
		livesTotal: 1,
		ladderIndex: 0,
		ladderMax: 1
	} as MonsterState;
}

describe('Paladin — "If both sides have the same initiative (1 or more), your side attacks first."', () => {
	it('sets the tie-break flag in combat and gives no initiative number', () => {
		const { player } = fire({ Paladin: 1 }, 'inCombat');
		expect(player.initiative).toBe(0);
		expect(player.winsInitiativeTies).toBe(true);
	});

	it('breaks a PvP initiative tie for its side', () => {
		// Spellblade on both sides: each side has exactly 1 initiative (one die, or the ability). Tied at 1.
		const { state } = pvp(
			{ spirits: [spirit(1, { Paladin: 1 }), spirit(2, { Spellblade: 1 })] },
			{ spirits: [spirit(1, { Spellblade: 1 })] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(combat.log).toContain('Both sides have 1 initiative — Good attacks first through Paladin.');
	});

	it('both sides with a Paladin stay tied (simultaneous)', () => {
		const { state } = pvp(
			{ spirits: [spirit(1, { Paladin: 1 }), spirit(2, { Spellblade: 1 })] },
			{ spirits: [spirit(1, { Paladin: 1 }), spirit(2, { Spellblade: 1 })] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(combat.log).toContain('Both sides have 1 initiative — they attack at the same time.');
	});

	it('no longer restores barrier when max barrier grows (old Aegis Weaver text)', () => {
		const player = makePlayer({
			barrier: 2,
			maxBarrier: 4,
			spirits: [spirit(1, { Paladin: 1 }), spirit(2, { Cultivator: 2 })]
		});
		applyTrigger(makeState(player), 'Red', 'onCultivate', []);
		// Cultivator (2): +1 Max Barrier, which arrives intact; Paladin restores nothing on top.
		expect(player.maxBarrier).toBe(5);
		expect(player.barrier).toBe(3);
	});
});

describe('Bastion — "If the opponent\'s side has more initiative than your side, or is a monster, when you Take Damage, half it (rounding up)."', () => {
	it('halves a 5-damage hit to 3 when the opponent is faster', () => {
		const { state, red } = pvp({ spirits: [spirit(1, { Bastion: 1 })], barrier: 10, maxBarrier: 10 }, { initiative: 5 });
		resetCombatFlags(red);
		takeDamage(red, 5, { state, seat: 'Red', opponent: 'Blue', opponentInitiative: 5 }, []);
		expect(red.barrier).toBe(7);
	});
});

describe('Sentinel — "Before you roll in combat, you may discard attack dice. For each dice that you discard, deal 1 more damage."', () => {
	it('monster combat: 2 chosen dice are discarded before the roll and deal 2 more damage, once', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Sentinel: 1 })],
			attackDice: [
				{ instanceId: 'a', tier: 'basic' },
				{ instanceId: 'b', tier: 'basic' }
			],
			sentinelDiscardIds: ['a', 'b'],
			monsterHand: [monster(0, 10)]
		});
		const state = makeState(player);
		const result = fightMonster(state, 'Red', undefined, 0)!;
		expect(result.playerDamage).toBe(2); // no dice left to roll: 0 + 2 × 1
		expect(player.attackDice).toHaveLength(0);
		expect(result.log.some((l) => l.includes('Sentinel: discarded 2 attack dice'))).toBe(true);
		// The bonus is for that combat only.
		expect(fightMonster(state, 'Red', undefined, 0)!.playerDamage).toBe(0);
	});

	it('with no chosen dice, a Sentinel adds nothing (the even-value rule is gone)', () => {
		const player = makePlayer({ spirits: [spirit(1, { Sentinel: 1 })], monsterHand: [monster(0, 10)] });
		expect(fightMonster(makeState(player), 'Red', undefined, 0)!.playerDamage).toBe(0);
	});

	it('PvP: the chosen dice are discarded before the locked roll and add 1 damage each', () => {
		const { state, red } = pvp(
			{
				spirits: [spirit(1, { Sentinel: 1 })],
				attackDice: [{ instanceId: 'r1', tier: 'basic' }],
				sentinelDiscardIds: ['r1']
			},
			{ spirits: [] }
		);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(red.attackDice).toHaveLength(0);
		expect(combat.sides.find((s) => s.seat === 'Red')!.damageDealt).toBe(1);
	});
});

describe('Bastion — "If the opponent\'s side has more initiative than your side, or is a monster, when you Take Damage, half it (rounding up)."', () => {
	it('halves a monster hit (monsters have infinite initiative)', () => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Bastion: 1 })],
			monsterHand: [monster(5, 99)]
		});
		const result = fightMonster(makeState(player), 'Red', undefined, 0)!;
		expect(result.barrierLost).toBe(3); // ceil(5 / 2)
		expect(player.barrier).toBe(7);
	});

	it('without Bastion the same monster hit lands in full', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, monsterHand: [monster(5, 99)] });
		expect(fightMonster(makeState(player), 'Red', undefined, 0)!.barrierLost).toBe(5);
	});
});

describe('Princess — "In the Awakening Phase, if you are not Evil and all your spirits are awakened, gain 1 Any basic Rune."', () => {
	it('gains 1 Any Rune (and no VP) when Good and every spirit is awake', () => {
		const { player } = fire({ Princess: 1 }, 'awakeningPhase');
		expect(player.victoryPoints).toBe(0);
		expect(player.mats).toHaveLength(1);
		expect(player.mats[0]).toMatchObject({ id: WILDCARD_MAT_IDS.anyRune, type: 'rune', hasRune: true });
	});
	it('gains nothing while Evil, or with a face-down spirit', () => {
		expect(fire({ Princess: 1 }, 'awakeningPhase', { player: { statusLevel: 3 } }).player.mats).toHaveLength(0);
		const faceDown = fire({ Princess: 1 }, 'awakeningPhase', {
			player: { spirits: [spirit(1, { Princess: 1 }), spirit(2, {}, { faceDown: true })] }
		});
		expect(faceDown.player.mats).toHaveLength(0);
	});
});

describe('Feral — "When an Evil player or a monster attacks you, your side gains the initiative if it does not have it."', () => {
	it('the Good Feral side has the initiative against an Evil attacker and deals no extra damage', () => {
		const { state } = pvp({ spirits: [spirit(1, { Feral: 1 })] }, { spirits: [spirit(1, { Assassin: 1 })] });
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		const red = combat.sides.find((s) => s.seat === 'Red')!;
		expect(red.initiative).toBe(1); // the die, or Feral when it misses
		expect(red.damageDealt).toBe(0); // no dice and no bonus
	});
	it('a monster fight: the initiative (attack at the same time as the monster), no extra damage', () => {
		const { player } = fire({ Feral: 1 }, 'inCombat');
		expect(player.alwaysAttackFirst).toBe(true);
		expect(player.combatDamageBonus).toBe(0);
		const fighter = makePlayer({ barrier: 10, maxBarrier: 10, spirits: [spirit(1, { Feral: 1 })], monsterHand: [monster(2, 3)] });
		const result = fightMonster(makeState(fighter), 'Red', undefined, 0)!;
		expect(fighter.initiative).toBe(1);
		expect(result.log).toContain('Test Monster has the initiative too — you attack at the same time.');
		expect(result.playerDamage).toBe(0);
		expect(fighter.barrier).toBe(8); // the monster still hits
	});
	it('a face-down Feral: no initiative from it and no bonus against a monster', () => {
		const fighter = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Feral: 1 }, { faceDown: true })],
			monsterHand: [monster(2, 3)]
		});
		const result = fightMonster(makeState(fighter), 'Red', undefined, 0)!;
		expect(fighter.alwaysAttackFirst).toBeFalsy();
		expect(result.playerDamage).toBe(0);
		expect(fighter.barrier).toBe(8);
	});
	it('with Bastion: having the initiative does not change the halving of a monster hit', () => {
		const fighter = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Feral: 1 }), spirit(2, { Bastion: 1 })],
			monsterHand: [monster(6, 30)]
		});
		const result = fightMonster(makeState(fighter), 'Red', undefined, 0)!;
		expect(result.playerDamage).toBe(0);
		expect(fighter.barrier).toBe(7); // 6 halved to 3
	});
	it('a Good opponent in PvP: nothing', () => {
		const { state, red } = pvp({ spirits: [spirit(1, { Feral: 1 })] }, { statusLevel: 0, statusToken: 'Pure' });
		resetCombatFlags(red);
		applyTrigger(state, 'Red', 'inCombat', [], { opponent: 'Blue' });
		expect(red.alwaysAttackFirst).toBeFalsy();
		expect(red.combatDamageBonus).toBe(0);
	});
});

describe('Trader — "You may pay your runes as runes of any type."', () => {
	const catalog: PlayCatalog = {
		guardians: [],
		classes: [],
		mats: [],
		dice: [],
		monsters: [],
		spirits: [
			{
				id: 'fire-cost',
				name: 'Fire Cost',
				cost: 7,
				classes: {},
				origins: {},
				awaken: {
					kind: 'rune_cost',
					mats: [{ runeId: FIRE_RUNE, name: 'Fire Rune', kind: 'rune', count: 2, wildcard: false }]
				}
			}
		]
	};
	const target = { slotIndex: 2, id: 'fire-cost', name: 'Fire Cost', cost: 7, classes: {}, origins: {}, isFaceDown: true };
	const check = (classes: Record<string, number>, second = rune(2, WATER_RUNE, 'Water Rune', WATER_ORIGIN)) => {
		const player = makePlayer({
			spirits: [spirit(1, classes), target],
			mats: [rune(1, FIRE_RUNE, 'Fire Rune', FIRE_ORIGIN), second]
		});
		const ctx = buildEffectContext({ state: makeState(player), seat: 'Red', player, trigger: 'awakening', log: [], traitCount: 0, catalog });
		return checkAwakenCondition(ctx, { spirit: target }).ok;
	};
	it('a Water Rune pays a Fire Rune cost with an awakened Trader', () => {
		expect(check({ Trader: 1 })).toBe(true);
	});
	it('without Trader the Water Rune does not pay it', () => {
		expect(check({ Fighter: 1 })).toBe(false);
	});
	it('any rune pays now, not only Water Runes (a Mountain Rune pays a Fire Rune cost)', () => {
		const mountain = rune(2, MOUNTAIN_RUNE, 'Mountain Rune', MOUNTAIN_ORIGIN);
		expect(check({ Trader: 1 }, mountain)).toBe(true);
		expect(check({ Fighter: 1 }, mountain)).toBe(false);
	});
	it('a relic tool (a named relic) does not pay a rune cost with Trader', () => {
		expect(check({ Trader: 1 }, relicTool(2, 'relic-x', 'Some Relic'))).toBe(false);
	});
	it('trades: any held basic rune pays a rune-of-an-origin cost; an exact rune is spent first', () => {
		const waterCost: CostRequirement[] = [
			{ match: 'origin', originId: WATER_ORIGIN, originName: 'Water Region', label: 'Water Rune' }
		];
		const mats = [rune(1, FIRE_RUNE, 'Fire Rune', FIRE_ORIGIN), rune(2, WATER_RUNE, 'Water Rune', WATER_ORIGIN)];
		expect(matchRewardCost(waterCost, [mats[0]]).ok).toBe(false);
		expect(matchRewardCost(waterCost, [mats[0]], [], { runesWild: true }).ok).toBe(true);
		expect(matchRewardCost(waterCost, mats, [], { runesWild: true }).consumedArrayIndexes).toEqual([1]);
		expect(autoPickCostSlots(waterCost, mats, { runesWild: true })).toEqual([1]);
		const relicOnly = [relicTool(1, 'relic-x', 'Some Relic')];
		expect(matchRewardCost(waterCost, relicOnly, [], { runesWild: true }).ok).toBe(false);
	});
});

describe('Master — "On Cultivate, gain 2 Max Barrier or restore 2 Barrier."', () => {
	it('gains 2 max barrier on Cultivate at full Barrier (restoring would give nothing, so no choice)', () => {
		const player = makePlayer({ maxBarrier: 4, barrier: 4, spirits: [spirit(1, { Master: 1 })] });
		applyCultivate(makeState(player), 'Red', []);
		expect(player.maxBarrier).toBe(6);
	});
});

describe('Wildling — "When you gain an attack dice, gain 1 Exalted Attack Dice."', () => {
	it('each gain of attack dice adds one Exalted die (not one per die, not recursive)', () => {
		const player = makePlayer({ spirits: [spirit(1, { Wildling: 1 }), spirit(2, { Fighter: 3 })] });
		applyTrigger(makeState(player), 'Red', 'onRest', []);
		// Fighter ×3 → 2 basic; Wildling → +1 exalted.
		expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['basic', 'basic', 'exalted']);
	});
	it('without Wildling there is no extra die', () => {
		const player = makePlayer({ spirits: [spirit(2, { Fighter: 3 })] });
		applyTrigger(makeState(player), 'Red', 'onRest', []);
		expect(player.attackDice).toHaveLength(2);
	});
});

describe('Wanderer — "When you enter a location where you were not last round, gain 2 Basic Attack Dice."', () => {
	it('gains 2 basic dice at a new location', () => {
		const { player } = fire({ Wanderer: 1 }, 'onNavigate', {
			player: { navigationDestination: 'Water Region', previousDestination: 'Fire Region' }
		});
		expect(player.attackDice.map((d) => d.tier)).toEqual(['basic', 'basic']);
	});
	it('gains nothing at the same location as last round', () => {
		const { player } = fire({ Wanderer: 1 }, 'onNavigate', {
			player: { navigationDestination: 'Water Region', previousDestination: 'Water Region' }
		});
		expect(player.attackDice).toHaveLength(0);
	});
});


/** A seed at which the Evil (Fallen) side's initiative die misses in the Prince fight below; at seed 1 it hits. */
const PRINCE_SEED = 2;

describe('Prince — "When your side has more initiative than the enemy, deal 2 more damage."', () => {
	it('PvP: its side has the initiative and the enemy does not — 2 more damage', () => {
		const { state } = pvp({ spirits: [spirit(1, { Prince: 1 }), spirit(2, { Spellblade: 1 })] }, {}, PRINCE_SEED);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(combat.sides.find((s) => s.seat === 'Blue')!.initiative).toBe(0);
		expect(combat.sides.find((s) => s.seat === 'Red')!.initiative).toBe(1);
		expect(combat.sides.find((s) => s.seat === 'Red')!.damageDealt).toBe(2);
	});
	it('PvP: the same initiative on both sides is not more — nothing', () => {
		const { state } = pvp({ spirits: [spirit(1, { Prince: 1 }), spirit(2, { Spellblade: 1 })] }, {}, 1);
		const combat = resolveEncounterCombat(state, undefined, ['Blue'], ['Red']);
		expect(combat.sides.find((s) => s.seat === 'Blue')!.initiative).toBe(1);
		expect(combat.sides.find((s) => s.seat === 'Red')!.damageDealt).toBe(0);
	});
	it('adds nothing against a monster, which always has the initiative (Spellblade only ties it)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Prince: 1 }), spirit(2, { Spellblade: 1 })],
			monsterHand: [monster(1, 10)]
		});
		const result = fightMonster(makeState(player), 'Red', undefined, 0)!;
		expect(result.playerDamage).toBe(0);
	});
	it('adds nothing when the monster strikes first', () => {
		const player = makePlayer({ spirits: [spirit(1, { Prince: 1 })], monsterHand: [monster(1, 10)] });
		const result = fightMonster(makeState(player), 'Red', undefined, 0)!;
		expect(result.playerDamage).toBe(0);
	});
});

describe('Salamander — "In combat, roll again each attack dice that shows 0, once."', () => {
	it('rolls more total damage than the same seed without the reroll (zeros are re-rolled)', () => {
		const dice = Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }));
		const totals = (reroll: boolean) => {
			let sum = 0;
			for (let seed = 1; seed <= 20; seed += 1) {
				const player = makePlayer({ attackDice: dice, rerollZeroDice: reroll });
				sum += rollAttack(makeState(player, {}, seed), player);
			}
			return sum;
		};
		expect(totals(true)).toBeGreaterThan(totals(false));
	});
	it('arms the reroll flag in combat', () => {
		expect(fire({ Salamander: 1 }, 'inCombat').player.rerollZeroDice).toBe(true);
	});
});

describe('Firetail — "In a round when another player is at your location, deal 3 more damage in combat."', () => {
	it('+3 damage (and no initiative) when another player shares the location', () => {
		const other = makePlayer({ playerColor: 'Blue', navigationDestination: 'Fire Region' });
		const { player } = fire({ Firetail: 1 }, 'inCombat', {
			player: { navigationDestination: 'Fire Region' },
			extra: { Blue: other }
		});
		expect(player.combatDamageBonus).toBe(3);
		expect(player.initiative).toBe(0);
	});
	it('nothing when alone', () => {
		expect(fire({ Firetail: 1 }, 'inCombat', { player: { navigationDestination: 'Fire Region' } }).player.combatDamageBonus).toBe(0);
	});
});

describe('Chorus — "When you awaken a spirit (this one included), restore all your Barrier and gain 2 Max Barrier."', () => {
	it('restores all Barrier and adds 2 max barrier on an awakening', () => {
		const { player } = fire({ Chorus: 1 }, 'awakening', {
			command: { slotIndex: 1 },
			player: { barrier: 1, maxBarrier: 6, brokenBarrier: 5 }
		});
		expect(player.maxBarrier).toBe(8);
		expect(player.barrier).toBe(8); // restored to 6, + 2 intact new capacity
	});
});

describe('Relic Envoy — its old +3 initiative is gone (not in the text)', () => {
	it('starts combat with 0 initiative', () => {
		const player = makePlayer({ spirits: [spirit(1, { 'Relic Envoy': 1 })] });
		resetCombatFlags(player);
		expect(player.initiative).toBe(0);
	});
});

describe('Gained relics stay relics — a Firecracker / Flower / Diamond / Teapot gain is a relic tool', () => {
	it('a gained Firecracker is held as a relic tool, not converted to a Fire Rune', () => {
		const player = makePlayer();
		addGainedRune(player, {
			runeId: FIRECRACKER_ID,
			name: 'Firecracker Relic',
			originId: null,
			classId: null,
			special: true,
			type: 'relic'
		});
		expect(player.mats).toHaveLength(1);
		expect(player.mats[0]).toMatchObject({ id: FIRECRACKER_ID, type: 'relic', relicTool: true, hasRune: true });
		expect(player.relics).toBe(1);
	});
});

describe('Relic tools — "You may <effect>, then discard this." (no VP side)', () => {
	// Current data (relics.json without a VP clause): the catalog carries relicToolVp 0.
	const NO_VP = { guardians: [], spirits: [], mats: [], classes: [], dice: [], relicToolVp: 0 } as PlayCatalog;
	const resolve = (player: PrivatePlayerState, state: PublicGameState, optionId: string, catalog: PlayCatalog = NO_VP) => {
		const card = player.pendingDecisions.find((d) => d.kind === 'relicTool')!;
		const ctx = buildEffectContext({ state, seat: 'Red', player, trigger: 'awakeningPhase', log: [], traitCount: 0, catalog });
		DECISION_RESOLVERS.relicTool(ctx, optionId);
	};

	it('the Teapot cannot awaken a "Have 7 <Origin> Spirits" spirit without that board', () => {
		const capstone = { id: 'cap', name: 'Hollowbloom', cost: 9, classes: {}, origins: { 'Forest Region': 1 }, awaken: { kind: 'text', text: 'Have 7 Forest Spirits.' } };
		const plain = { id: 'plain', name: 'Tide Warden', cost: 7, classes: {}, origins: { 'Water Region': 1 }, awaken: { kind: 'text', text: 'Cultivate.' } };
		const catalog = { ...NO_VP, spirits: [capstone, plain] } as unknown as PlayCatalog;
		const board = (forest: number) => [
			{ slotIndex: 1, id: 'cap', name: 'Hollowbloom', cost: 9, classes: {}, origins: { 'Forest Region': 1 }, isFaceDown: true },
			{ slotIndex: 2, id: 'plain', name: 'Tide Warden', cost: 7, classes: {}, origins: { 'Water Region': 1 }, isFaceDown: true },
			...Array.from({ length: forest }, (_, i) => ({ slotIndex: 3 + i, id: `f${i}`, name: `Forest ${i}`, cost: 3, classes: {}, origins: { 'Forest Region': 1 }, isFaceDown: false }))
		];
		const offered = (forest: number) => {
			const player = makePlayer({ mats: [relicTool(1, CLEANSING_TEAPOT_ID, 'Cleansing Teapot')], relics: 1, spirits: board(forest) as never });
			offerHeldRelicTools(makeState(player), player, [], catalog);
			const card = player.pendingDecisions.find((d) => d.kind === 'relicTool')!;
			return { ids: card.options.filter((o) => o.id.startsWith('awaken:')).map((o) => o.id.split(':').pop()), prompt: card.prompt };
		};
		expect(offered(4).ids).toEqual(['2']); // 5 Forest spirits with the capstone: not enough
		expect(offered(5).ids).toEqual(['2']); // 6
		expect(offered(6).ids).toEqual(['1', '2']); // 7 with the capstone itself
		expect(offered(4).prompt).toContain('full origin board');
	});

	it('each held relic tool is offered once (keep / effect; no VP option)', () => {
		const player = makePlayer({ mats: [relicTool(1, FLOWER_ID, 'Flower')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		offerHeldRelicTools(state, player, [], NO_VP); // a new round replaces the old card
		const cards = player.pendingDecisions.filter((d) => d.kind === 'relicTool');
		expect(cards).toHaveLength(1);
		// The card header names the relic (it is not a class ability).
		expect(cards[0].sourceLabel).toBe('Relic: Flower');
		expect(cards[0].options.map((o) => o.id)).toEqual([
			`keep:1:${FLOWER_ID}`,
			`effect:1:${FLOWER_ID}`
		]);
	});

	it('a vp answer gives no VP and keeps the relic', () => {
		const player = makePlayer({ mats: [relicTool(1, DIAMOND_ID, 'Diamond')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `vp:1:${DIAMOND_ID}`);
		expect(player.victoryPoints).toBe(0);
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.relics).toBe(1);
	});

	it('keep leaves the relic held', () => {
		const player = makePlayer({ mats: [relicTool(1, DIAMOND_ID, 'Diamond')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `keep:1:${DIAMOND_ID}`);
		expect(player.mats[0].hasRune).toBe(true);
	});

	it('a stale card (the relic slot now holds something else) does nothing', () => {
		const player = makePlayer({ mats: [relicTool(1, DIAMOND_ID, 'Diamond')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		player.mats[0] = relicTool(1, FLOWER_ID, 'Flower');
		resolve(player, state, `vp:1:${DIAMOND_ID}`);
		expect(player.victoryPoints).toBe(0);
		expect(player.mats[0].hasRune).toBe(true);
	});

	it('Flower restores Barrier to full', () => {
		const player = makePlayer({ barrier: 1, maxBarrier: 7, brokenBarrier: 6, mats: [relicTool(1, FLOWER_ID, 'Flower')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `effect:1:${FLOWER_ID}`);
		expect(player.barrier).toBe(7);
		expect(player.brokenBarrier).toBe(0);
		expect(player.mats[0].hasRune).toBe(false);
	});

	it('Diamond gives 1 Spirit Augment of your choice', () => {
		const player = makePlayer({ mats: [relicTool(1, DIAMOND_ID, 'Diamond')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `effect:1:${DIAMOND_ID}`);
		expect(player.unplacedAugments).toHaveLength(1);
	});

	it('Firecracker: in your next combat you gain the initiative if you do not have it (one use)', () => {
		const player = makePlayer({ mats: [relicTool(1, FIRECRACKER_ID, 'Firecracker')], relics: 1, monsterHand: [monster(5, 10), monster(5, 10)] });
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `effect:1:${FIRECRACKER_ID}`);
		expect(player.strikeFirstCharges).toBe(1);
		// The view shows the armed initiative at once, and a flag reset keeps it while armed.
		expect(player.alwaysAttackFirst).toBe(true);
		resetCombatFlags(player);
		expect(player.alwaysAttackFirst).toBe(true);
		const first = fightMonster(state, 'Red', undefined, 0)!;
		expect(first.log).toContain('Firecracker: gains the initiative in this combat if the die misses.');
		expect(player.initiative).toBe(1);
		expect(first.log).toContain('Test Monster has the initiative too — you attack at the same time.');
		expect(player.strikeFirstCharges).toBe(0);
		expect(player.alwaysAttackFirst).toBe(true); // what that combat did
		const second = fightMonster(state, 'Red', undefined, 0)!;
		expect(second.log.some((l) => l.includes('Firecracker'))).toBe(false);
		expect(player.alwaysAttackFirst).toBe(false); // spent: the next combat has no such ability
	});

	it('Cleansing Teapot awakens a chosen face-down spirit (cost ignored) and fires awakening effects', () => {
		const player = makePlayer({
			barrier: 1,
			maxBarrier: 6,
			mats: [relicTool(1, CLEANSING_TEAPOT_ID, 'Cleansing Teapot')],
			relics: 1,
			spirits: [spirit(1, { Chorus: 1 }), spirit(2, { Huntress: 1 }, { faceDown: true, name: 'Tide Huntress' })]
		});
		const state = makeState(player);
		offerHeldRelicTools(state, player, [], NO_VP);
		resolve(player, state, `awaken:1:${CLEANSING_TEAPOT_ID}:2`);
		expect(player.spirits[1].isFaceDown).toBe(false);
		expect(player.attackDice.filter((d) => d.tier === 'arcane')).toHaveLength(3); // Huntress on awaken
		expect(player.maxBarrier).toBe(8); // Chorus: restore all Barrier, then 2 Max Barrier (intact)
		expect(player.barrier).toBe(8);
		expect(player.mats[0].hasRune).toBe(false);
	});

	it('the legacy relic → rune save migration leaves relic tools alone', () => {
		const player = makePlayer({
			mats: [
				relicTool(1, FIRECRACKER_ID, 'Firecracker'),
				{ slotIndex: 2, hasRune: true, id: FIRECRACKER_ID, name: 'Firecracker', type: 'relic' }
			]
		});
		const state = makeState(player);
		upgradeRelicRuneSlots(state);
		expect(player.mats[0]).toMatchObject({ type: 'relic', id: FIRECRACKER_ID });
		expect(player.mats[1]).toMatchObject({ type: 'rune', id: FIRE_RUNE }); // legacy slot converts
	});

	it('the Benefits step offers held relic tools', async () => {
		const { enterBenefits } = await import('../phases');
		const player = makePlayer({ mats: [relicTool(1, FLOWER_ID, 'Flower')], relics: 1 });
		const state = makeState(player);
		state.status = 'active';
		enterBenefits(state);
		expect(player.pendingDecisions.some((d) => d.kind === 'relicTool')).toBe(true);
	});
	it('a catalog without relicToolVp (saved before 2026-11-13) keeps the old 2 VP side, so old records replay', () => {
		const player = makePlayer({ mats: [relicTool(1, DIAMOND_ID, 'Diamond')], relics: 1 });
		const state = makeState(player);
		offerHeldRelicTools(state, player, []);
		const card = player.pendingDecisions.find((d) => d.kind === 'relicTool')!;
		expect(card.options.map((o) => o.id)).toContain(`vp:1:${DIAMOND_ID}`);
		expect(card.prompt).toBe('Diamond: You may gain 2 VP or gain 1 Spirit Augment of your choice, then discard this.');
		const legacy = { guardians: [], spirits: [], mats: [], classes: [], dice: [] } as PlayCatalog;
		resolve(player, state, `vp:1:${DIAMOND_ID}`, legacy);
		expect(player.victoryPoints).toBe(2);
		expect(player.mats[0].hasRune).toBe(false);
	});
});

describe('A spirit with no awaken requirement (fallback; no catalog spirit uses it since 2026-11-11)', () => {
	it('a cost-7 spirit with no awaken condition (null in the data) awakens for free', () => {
		const target = { slotIndex: 1, id: 'free', name: 'Free Spirit', cost: 7, classes: { Princess: 1 }, origins: {}, isFaceDown: true };
		const player = makePlayer({ spirits: [target] });
		const catalog: PlayCatalog = {
			guardians: [],
			classes: [],
			mats: [],
			dice: [],
			monsters: [],
			spirits: [{ id: 'free', name: 'Free Spirit', cost: 7, classes: { Princess: 1 }, origins: {}, awaken: undefined }]
		};
		const ctx = buildEffectContext({ state: makeState(player), seat: 'Red' as SeatColor, player, trigger: 'awakening', log: [], traitCount: 0, catalog });
		expect(checkAwakenCondition(ctx, { spirit: target }).ok).toBe(true);
	});
});
