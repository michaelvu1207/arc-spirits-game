import { describe, expect, it } from 'vitest';
import { applyTrigger, applyCultivate, applyRest, awakenedClassCounts } from './apply';
import { MANUAL_CLASSES } from './registry';
import { DECISION_RESOLVERS } from './decisions';
import { buildEffectContext } from './context';
import { createRng } from '../rng';
import type { PlaySpirit, PrivatePlayerState, PublicGameState } from '../types';

function makePlayer(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
	return {
		playerColor: 'Red',
		displayName: 'Tester',
		selectedGuardian: 'Myrtle',
		navigationDestination: null,
		brokenBarrier: 0,
		victoryPoints: 0,
		vpHistory: [],
		barrier: 4,
		maxBarrier: 4,
		statusLevel: 0,
		statusToken: 'Pure',
		spirits: [],
		mats: [],
		handDraws: [],
		pendingDraw: null,
		pendingDrawQueue: [],
		spawnedDice: [],
		spawnedItems: [],
		spiritAugmentAttachments: [],
		pendingDestination: null,
		attackDice: [],
		initiative: 0,
		actionsUsedThisRound: [],
		awakenEligible: [],
		awakenOffers: [],
		awakenLocked: [],
		phaseReady: false,
		manualPrompts: [],
		pendingDecisions: [],
		lastAction: null,
		pendingReward: null,
		pendingAwakenReward: null,
		damageReduction: 0,
		deflect: 0,
		combatDamageBonus: 0,
		stunImmune: false,
		spiritAugments: 0,
		relics: 0,
		extraActions: {},
		combatDamageMultiplier: 1,
		attackRollAdvantage: false,
		halveIncoming: false,
		skipTakeDamage: false,
		doubleRunes: false,
		redrawAvailable: false,
		freeNextRelicTrade: false,
		becameTaintedThisRound: false,
		becameCorruptThisRound: false,
		becameFallenThisRound: false,
		corruptedThisRound: false,
		awakenProgress: {},
		...overrides
	};
}

function spirit(
	slotIndex: number,
	name: string,
	classes: Record<string, number>,
	origins: Record<string, number>,
	isFaceDown = false
): PlaySpirit {
	return { slotIndex, id: `s${slotIndex}`, name, cost: 2, classes, origins, isFaceDown };
}

function makeState(player: PrivatePlayerState, seed = 1): PublicGameState {
	return {
		rng: createRng(seed),
		players: { Red: player },
		activeSeats: ['Red']
	} as unknown as PublicGameState;
}

/** A minimal EffectContext for driving a decision resolver against one player. */
function ctxFor(player: PrivatePlayerState) {
	return buildEffectContext({
		state: makeState(player),
		seat: 'Red',
		player,
		trigger: 'awakeningPhase',
		log: [],
		traitCount: 0
	});
}

describe('awakenedClassCounts', () => {
	it('ignores unawakened (face-down) spirits', () => {
		const p = makePlayer({
			spirits: [
				spirit(1, 'A', { Fighter: 2 }, {}),
				spirit(2, 'B', { Fighter: 2 }, {}, true) // unawakened — inactive
			]
		});
		expect(awakenedClassCounts(p).Fighter).toBe(2);
	});
});

describe('Rest effects', () => {
	it('intrinsically restores barrier by status (4 at Pure) and fires every onRest class ability', () => {
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 6,
			brokenBarrier: 5,
			spirits: [spirit(1, 'A', { Fighter: 2 }, {})]
		});
		const log: string[] = [];
		applyRest(makeState(p), 'Red', log);
		expect(p.barrier).toBe(5);
		expect(p.brokenBarrier).toBe(1);
		expect(p.attackDice).toHaveLength(1);
		expect(log).toContain('Restored 4 barrier.');
		expect(log).toContain('Rested.');
	});

	it('Fighter grants basic attack dice', () => {
		// Ladder 2/3/4/5 Fighters → +1/+2/+3/+5 basic dice: 4 Fighters → +3.
		const p = makePlayer({ maxBarrier: 10, spirits: [spirit(1, 'A', { Fighter: 4 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(3);
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
	});

	it('attack dice are capped at the flat 10, no longer by potential', () => {
		// Low potential does not limit dice: Fighter 5 grants +5 from empty.
		const p = makePlayer({ maxBarrier: 2, spirits: [spirit(1, 'A', { Fighter: 5 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(5); // not capped at maxTokens=2

		// The hard cap is 10: starting near it, a big grant tops out at 10.
		const q = makePlayer({
			maxBarrier: 2,
			attackDice: Array.from({ length: 8 }, (_, i) => ({
				instanceId: `d${i}`,
				tier: 'basic' as const
			})),
			spirits: [spirit(1, 'A', { Fighter: 5 }, {})]
		});
		applyTrigger(makeState(q), 'Red', 'onRest', []);
		expect(q.attackDice).toHaveLength(10);
	});

	it('Elementalist upgrades nothing on Rest (its upgrades come on Cultivate)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [{ instanceId: 'd0', tier: 'basic' }],
			spirits: [spirit(1, 'A', { 'Elementalist': 4 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice[0].tier).toBe('basic');
	});

	it('does nothing for a class with no Rest effect', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { Rogue: 3 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(0);
		expect(p.maxBarrier).toBe(4);
	});
});

describe('Elementalist (onCultivate: 1/2/3/5 upgrades at 2/3/4/5)', () => {
	it('upgrades a die to the next tier (count 2 → first breakpoint)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [{ instanceId: 'd0', tier: 'basic' }],
			spirits: [spirit(1, 'A', { 'Elementalist': 2 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		expect(p.attackDice[0].tier).toBe('enchanted');
	});

	it('a lone Elementalist (count 1) upgrades nothing', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [{ instanceId: 'd0', tier: 'basic' }],
			spirits: [spirit(1, 'A', { 'Elementalist': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		expect(p.attackDice[0].tier).toBe('basic');
	});

	it('upgrades cap at exalted — never reach arcane', () => {
		const p = makePlayer({
			maxBarrier: 10,
			// An exalted die plus a basic one; 4 Elementalists give 3 upgrades.
			attackDice: [
				{ instanceId: 'd0', tier: 'exalted' },
				{ instanceId: 'd1', tier: 'basic' }
			],
			spirits: [spirit(1, 'A', { 'Elementalist': 4 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onCultivate', []);
		// The basic die climbs to exalted; the exalted die is left alone; no arcane.
		expect(p.attackDice.some((d) => d.tier === 'arcane')).toBe(false);
		expect(p.attackDice.filter((d) => d.tier === 'exalted')).toHaveLength(2);
	});
});

describe('Cultivate action (origin rewards: 3 spirits → 1 rune, 5 → the rune or the relic once)', () => {
	// Origin keys are the engine origin names (e.g. "Forest Region", regions.ts); the rune
	// slot carries the BASE_RUNES name ("Forest Rune"). Calling card (origins.json):
	// 3 spirits → "On Cultivate: 1 <origin> Rune"; 5 → "On Cultivate: <relic> (one time)".
	it('Sun and Moon (origins with no reward) give nothing: 3 or 5 spirits, no rune, no relic', () => {
		for (const origin of ['Sun', 'Moon']) {
			for (const n of [3, 5]) {
				const p = makePlayer({
					spirits: Array.from({ length: n }, (_, i) => spirit(i + 1, `${origin} ${i}`, {}, { [origin]: 1 }))
				});
				const log: string[] = [];
				expect(() => applyCultivate(makeState(p), 'Red', log)).not.toThrow();
				expect(p.mats).toHaveLength(0);
				expect(p.relics ?? 0).toBe(0);
				expect(p.originRelicsGained ?? []).toHaveLength(0);
			}
		}
		// Mixed with a region: only the region pays (3 Forest + 5 Sun → 1 Forest Rune).
		const mixed = makePlayer({
			spirits: [
				...Array.from({ length: 3 }, (_, i) => spirit(i + 1, `F${i}`, {}, { 'Forest Region': 1 })),
				...Array.from({ length: 5 }, (_, i) => spirit(i + 4, `S${i}`, {}, { Sun: 1 }))
			]
		});
		applyCultivate(makeState(mixed), 'Red', []);
		expect(mixed.mats.map((m) => m.name)).toEqual(['Forest Rune']);
	});

	it('grants 1 origin rune without restoring barriers', () => {
		const p = makePlayer({
			maxBarrier: 4,
			barrier: 2,
			brokenBarrier: 2,
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 1 }),
				spirit(2, 'B', {}, { 'Forest Region': 1 }),
				spirit(3, 'C', {}, { 'Forest Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Forest Rune')).toHaveLength(1);
		expect(p.barrier).toBe(2);
		expect(p.brokenBarrier).toBe(2);
		expect(p.maxBarrier).toBe(4); // no Cultivator → no potential
	});

	it('the Cultivate action grants ZERO potential without Cultivators (potential is Cultivator-only)', () => {
		// A player with other classes — but NO Cultivator — and even a lone Cultivator
		// (count 1, which grants nothing) gains 0 potential from the Cultivate action.
		const noCultivator = makePlayer({
			maxBarrier: 4,
			barrier: 4,
			spirits: [
				spirit(1, 'A', { Fighter: 2 }, { 'Forest Region': 1 }),
				spirit(2, 'B', { Healer: 1 }, {})
			]
		});
		applyCultivate(makeState(noCultivator), 'Red', []);
		expect(noCultivator.maxBarrier).toBe(4); // unchanged — no potential

		const loneCultivator = makePlayer({
			maxBarrier: 4,
			spirits: [spirit(1, 'A', { Cultivator: 1 }, {})]
		});
		applyCultivate(makeState(loneCultivator), 'Red', []);
		expect(loneCultivator.maxBarrier).toBe(4); // a single Cultivator (count 1) grants nothing

		// Sanity: a Cultivator POOL (count ≥2) is the only thing that yields potential.
		const pool = makePlayer({
			maxBarrier: 0,
			barrier: 0,
			brokenBarrier: 0,
			spirits: [spirit(1, 'A', { Cultivator: 2 }, {})]
		});
		applyCultivate(makeState(pool), 'Red', []);
		expect(pool.maxBarrier).toBe(1); // count 2 → +1 potential
	});

	it('six same-origin spirits still give ONE rune (a breakpoint, not one per three)', () => {
		const p = makePlayer({
			maxBarrier: 4,
			barrier: 1,
			brokenBarrier: 3,
			// The Forest relic is already taken, so 5+ spirits give the rune with no choice card.
			originRelicsGained: ['Forest Region'],
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 1 }),
				spirit(2, 'B', {}, { 'Forest Region': 1 }),
				spirit(3, 'C', {}, { 'Forest Region': 1 }),
				spirit(4, 'D', {}, { 'Forest Region': 1 }),
				spirit(5, 'E', {}, { 'Forest Region': 1 }),
				spirit(6, 'F', {}, { 'Forest Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Forest Rune')).toHaveLength(1);
		expect(p.barrier).toBe(1);
		expect(p.brokenBarrier).toBe(3);
	});

	it('grants one rune PER origin (three Forest Region + three Fire Region → one each)', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 1 }),
				spirit(2, 'B', {}, { 'Forest Region': 1 }),
				spirit(3, 'C', {}, { 'Forest Region': 1 }),
				spirit(4, 'D', {}, { 'Fire Region': 1 }),
				spirit(5, 'E', {}, { 'Fire Region': 1 }),
				spirit(6, 'F', {}, { 'Fire Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Forest Rune')).toHaveLength(1);
		expect(p.mats.filter((r) => r.name === 'Fire Rune')).toHaveLength(1);
	});

	it('counts face-down (unawakened) spirits — origin is always active', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 1 }, true), // face-down still counts
				spirit(2, 'B', {}, { 'Forest Region': 1 }),
				spirit(3, 'C', {}, { 'Forest Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Forest Rune')).toHaveLength(1);
	});

	it('grants nothing for a lone spirit, or for an origin without a basic rune', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'Solo', {}, { 'Forest Region': 1 }), // only one of the origin → 0
				spirit(2, 'Royal A', {}, { 'Royal Family': 1 }), // Royal Family has no basic rune
				spirit(3, 'Royal B', {}, { 'Royal Family': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats).toHaveLength(0);
		expect(p.maxBarrier).toBe(4);
	});

	it('five spirits of an origin offer its rune or its relic tool, the relic one time only', () => {
		const p = makePlayer({
			spirits: Array.from({ length: 5 }, (_, i) => spirit(i + 1, `W${i}`, {}, { 'Water Region': 1 }))
		});
		const state = makeState(p);
		applyCultivate(state, 'Red', []);
		const teapots = () => p.mats.filter((m) => m.name === 'Cleansing Teapot' && m.type === 'relic');
		// One reward: a card "the relic or the rune", nothing given yet.
		const card = p.pendingDecisions.find((d) => d.kind === 'originCultivate');
		expect(card?.options.map((o) => o.id)).toEqual(['relic|Water Region|1', 'rune|Water Region|1']);
		expect(p.mats).toHaveLength(0);
		DECISION_RESOLVERS.originCultivate(ctxFor(p), 'relic|Water Region|1');
		expect(teapots()).toHaveLength(1);
		expect(teapots()[0].relicTool).toBe(true);
		expect(p.mats.filter((m) => m.name === 'Water Rune')).toHaveLength(0);
		expect(p.relics).toBe(1);
		expect(p.originRelicsGained).toEqual(['Water Region']);
		// The relic is taken: the next Cultivate gives the rune at once, no card.
		p.pendingDecisions = [];
		applyCultivate(state, 'Red', []);
		expect(p.pendingDecisions.filter((d) => d.kind === 'originCultivate')).toHaveLength(0);
		expect(teapots()).toHaveLength(1); // one time per player
		expect(p.mats.filter((m) => m.name === 'Water Rune')).toHaveLength(1);
	});

	it('four spirits give the rune but not the relic; each land has its own relic', () => {
		const four = makePlayer({
			spirits: Array.from({ length: 4 }, (_, i) => spirit(i + 1, `F${i}`, {}, { 'Fire Region': 1 }))
		});
		applyCultivate(makeState(four), 'Red', []);
		expect(four.mats.map((m) => m.name)).toEqual(['Fire Rune']);
		expect(four.pendingDecisions).toHaveLength(0);
		const relicFor = (origin: string) => {
			const p = makePlayer({
				spirits: Array.from({ length: 5 }, (_, i) => spirit(i + 1, `S${i}`, {}, { [origin]: 1 }))
			});
			applyCultivate(makeState(p), 'Red', []);
			DECISION_RESOLVERS.originCultivate(ctxFor(p), `relic|${origin}|1`);
			return p.mats.find((m) => m.type === 'relic')?.name;
		};
		expect(relicFor('Fire Region')).toBe('Firecracker');
		expect(relicFor('Forest Region')).toBe('Flower');
		expect(relicFor('Mountain Region')).toBe('Diamond');
		expect(relicFor('Water Region')).toBe('Cleansing Teapot');
	});

	it('a spirit counts once even with a doubled origin trait', () => {
		const p = makePlayer({
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 2 }),
				spirit(2, 'B', {}, { 'Forest Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats).toHaveLength(0); // 2 spirits < 3
	});
});

describe('Cultivator (onCultivate → potential by awakened count)', () => {
	const cult = (slot: number, name: string, faceDown = false) =>
		spirit(slot, name, { Cultivator: 1 }, { 'Forest Region': 1 }, faceDown);

	it('two awakened Cultivators → +1 potential', () => {
		const p = makePlayer({ maxBarrier: 4, spirits: [cult(1, 'C1'), cult(2, 'C2')] });
		applyCultivate(makeState(p), 'Red', []);
		expect(p.maxBarrier).toBe(5);
	});

	it('three awakened Cultivators → +2 potential', () => {
		const p = makePlayer({ maxBarrier: 4, spirits: [cult(1, 'C1'), cult(2, 'C2'), cult(3, 'C3')] });
		applyCultivate(makeState(p), 'Red', []);
		expect(p.maxBarrier).toBe(6);
	});

	it('a lone Cultivator grants no potential (the ladder starts at 2)', () => {
		const p = makePlayer({ maxBarrier: 4, spirits: [cult(1, 'C1')] });
		applyCultivate(makeState(p), 'Red', []);
		expect(p.maxBarrier).toBe(4);
	});

	it('only AWAKENED Cultivators count (face-down are inactive)', () => {
		const p = makePlayer({ maxBarrier: 4, spirits: [cult(1, 'C1'), cult(2, 'C2', true)] });
		applyCultivate(makeState(p), 'Red', []);
		expect(p.maxBarrier).toBe(4); // one awakened → below the count-2 breakpoint
	});

	it('potential is capped at 10', () => {
		const p = makePlayer({
			maxBarrier: 9,
			spirits: [cult(1, 'C1'), cult(2, 'C2'), cult(3, 'C3'), cult(4, 'C4')] // count 4 → +3
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.maxBarrier).toBe(10);
	});
});

// ── P3: per-class Rest / Cultivate coverage ──────────────────────────────────

const attackDie = (id: string, tier: PrivatePlayerState['attackDice'][number]['tier']) => ({
	instanceId: id,
	tier
});

describe('Mystic (engine-handled breakpoints)', () => {
	it('does not use the old onRest stun-immunity effect at 2 traits', () => {
		const p = makePlayer({
			barrier: 2,
			maxBarrier: 4,
			brokenBarrier: 2,
			spirits: [spirit(1, 'A', { 'Mystic': 2 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.stunImmune).toBe(false);
		expect(p.barrier).toBe(2);
	});

	it('does not use the old onRest restore effect at 3 traits', () => {
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			brokenBarrier: 3,
			spirits: [spirit(1, 'A', { 'Mystic': 3 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.stunImmune).toBe(false);
		expect(p.barrier).toBe(1);
		expect(p.brokenBarrier).toBe(3);
	});
});

// Mystic's active rules are covered at their engine integration points.

describe('Monk (the old onTakeDamage rule is gone)', () => {
	it('placed Spirit Augments no longer reduce incoming damage', () => {
		const p = makePlayer({
			spirits: [spirit(1, 'A', { 'Monk': 1 }, {})],
			spiritAugmentAttachments: [
				{ spiritSlotIndex: 1, runeId: 'a' },
				{ spiritSlotIndex: 1, runeId: 'b' }
			] as never
		});
		applyTrigger(makeState(p), 'Red', 'onTakeDamage', []);
		expect(p.damageReduction).toBe(0);
	});
});

// ── P4: combat-trigger class coverage (onMonsterKill / awakening) ─────────────

describe('Battle Adept (onMonsterKill)', () => {
	it('gains 1 potential when overkilling by ≥2 on a kill', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [spirit(1, 'A', { 'Battle Adept': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 7, overkill: 3, killed: true }
		});
		expect(p.maxBarrier).toBe(5); // +1 potential
		expect(p.attackDice).toHaveLength(0); // no enchanted die (it killed)
	});

	it('does NOT gain potential when overkill is below 2', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [spirit(1, 'A', { 'Battle Adept': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 5, overkill: 1, killed: true }
		});
		expect(p.maxBarrier).toBe(4);
	});

	it('gains nothing when it does NOT kill (no attack die)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [spirit(1, 'A', { 'Battle Adept': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 2, overkill: 0, killed: false }
		});
		expect(p.attackDice).toHaveLength(0);
		expect(p.maxBarrier).toBe(10); // no potential (no overkill)
	});

	it('activates per fighter — two Adaptive Fighters grant two potential on an overkill', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', { 'Battle Adept': 1 }, {}),
				spirit(2, 'B', { 'Battle Adept': 1 }, {})
			]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 7, overkill: 3, killed: true }
		});
		expect(p.maxBarrier).toBe(6); // +1 potential × 2 fighters
		expect(p.attackDice).toHaveLength(0); // killed → no enchanted die
	});
});

describe('Fairy (awakening)', () => {
	it('on awakening, grants 1 enchanted die per origin-matching spirit and no initiative number', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [
				spirit(1, 'F', { 'Fairy': 1 }, { Forest: 1 }),
				spirit(2, 'B', {}, { Forest: 1 }),
				spirit(3, 'C', {}, { Cyber: 1 })
			]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 1 } });
		// Forest matches the Fairy (F) + B = 2 spirits → 2 enchanted dice; initiative is the die only.
		expect(p.attackDice).toHaveLength(2);
		expect(p.attackDice.every((d) => d.tier === 'enchanted')).toBe(true);
		expect(p.initiative).toBe(0);
	});

	it('does not fire when the spirit that awakened is not a Fairy', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [
				spirit(1, 'F', { 'Fairy': 1 }, { Forest: 1 }),
				spirit(2, 'X', { Fighter: 1 }, { Forest: 1 })
			]
		});
		// The Fighter (slot 2) awakened, not the Fairy → no Fairy grant.
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 2 } });
		expect(p.attackDice).toHaveLength(0);
		expect(p.initiative).toBe(0);
	});
});

describe('Huntress (awakening)', () => {
	it('gains 3 Arcane attack dice on the awakening trigger', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [spirit(1, 'A', { 'Huntress': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 1 } });
		expect(p.attackDice).toHaveLength(3);
		expect(p.attackDice.every((d) => d.tier === 'arcane')).toBe(true);
	});
});

describe('Summoner (runtime bag behavior)', () => {
	it('does not use the obsolete Forest Region navigation trigger', () => {
		const p = makePlayer({
			spirits: [spirit(1, 'A', { 'Summoner': 1 }, {})],
			navigationDestination: 'Forest Region'
		});
		applyTrigger(makeState(p), 'Red', 'onNavigate', []);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
		expect(p.pendingDecisions).toHaveLength(0);
	});

	it('is no longer in MANUAL_CLASSES (opt-in decision now)', () => {
		expect(MANUAL_CLASSES.has('Summoner')).toBe(false);
	});
});

describe('Herder', () => {
	it('is no longer listed in MANUAL_CLASSES', () => {
		expect(MANUAL_CLASSES.has('Herder')).toBe(false);
	});
});

// ── P5: onNavigate coverage ───────────────────────────────────────────────────

describe('Spellblade (onNavigate)', () => {
	it('offers a change-destination decision without the removed +4 initiative', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { 'Spellblade': 1 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onNavigate', []);
		expect(p.initiative).toBe(0);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
		const dec = p.pendingDecisions.find((d) => d.kind === 'deepSeaHunterRedirect');
		expect(dec).toBeDefined();
		expect(dec!.options.map((o) => o.id)).toContain('Water Region');
		expect(dec!.options.map((o) => o.id)).toContain('keep');
	});

	it('is no longer in MANUAL_CLASSES (built-in decision now)', () => {
		expect(MANUAL_CLASSES.has('Spellblade')).toBe(false);
	});
});

// Rune Traveler (the only class that set doubleRunes) was removed from the game; the
// doubleRunes PRIMITIVE remains in the engine, so this keeps direct coverage of it.
describe('doubleRunes primitive (Cultivate yield)', () => {
	it('doubled runes apply to the Cultivate origin-rune yield', () => {
		const p = makePlayer({
			doubleRunes: true,
			maxBarrier: 4,
			barrier: 1,
			brokenBarrier: 3,
			spirits: [
				spirit(1, 'A', {}, { 'Forest Region': 1 }),
				spirit(2, 'B', {}, { 'Forest Region': 1 }),
				spirit(3, 'C', {}, { 'Forest Region': 1 }),
				spirit(4, 'D', {}, { 'Forest Region': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Forest Rune')).toHaveLength(2); // 1 rune (4 ≥ 3) → doubled
		// Cultivate does not restore barriers, even when rune yield is doubled.
		expect(p.barrier).toBe(1);
		expect(p.brokenBarrier).toBe(3);
	});
});

// ── P5: Awakening-Phase status grants ─────────────────────────────────────────

describe('Cursed Spirit (cleanup claim — no longer an awakeningPhase auto-grant)', () => {
	// Cursed Spirit's rewards are now a CLAIMABLE Cleanup selection: enterCleanup
	// builds the player's pendingAwakenReward and resolveAwakenReward applies them
	// (incl. the Tainted "potential OR Enchanted Attack" choice). The effect trigger
	// itself no longer auto-grants anything — the claim flow is covered in the
	// runtime/phases tests.
	it('grants nothing via the awakeningPhase trigger, even across all three thresholds', () => {
		const p = makePlayer({
			maxBarrier: 10,
			becameTaintedThisRound: true,
			becameCorruptThisRound: true,
			becameFallenThisRound: true,
			spirits: [spirit(1, 'A', { 'Cursed Spirit': 2 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', []);
		expect(p.attackDice).toHaveLength(0);
		expect(p.relics).toBe(0);
		expect(p.unplacedAugments?.length ?? 0).toBe(0);
	});
});

describe('Abyss Harbinger (Awakening grant is a Cleanup claim)', () => {
	it('does NOT auto-grant an Arcane die on the awakeningPhase trigger (now a Cleanup claim)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			corruptedThisRound: true,
			spirits: [spirit(1, 'A', { 'Corruptor': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', []);
		// The Arcane die is now granted via the Cleanup claim (resolveAwakenReward),
		// not by the awakeningPhase trigger — see runtime.test.ts.
		expect(p.attackDice).toHaveLength(0);
	});
});

// ── P5: Awakening-Phase grants are now CLEANUP CLAIM cards (built in enterCleanup,
// applied by resolveAwakenReward — see runtime.test.ts). The awakeningPhase TRIGGER
// no longer auto-applies them; these guard against accidentally re-adding auto-grant
// (which would double-grant alongside the claim). ────────────────────────────────

describe('Awakening-Phase win-cons no longer auto-apply on the trigger', () => {
	it('Dawn Sovereign grants no VP and discards nothing on the trigger', () => {
		const good = makePlayer({
			statusLevel: 0,
			spirits: [spirit(1, 'A', { 'King': 1 }, {})]
		});
		applyTrigger(makeState(good), 'Red', 'awakeningPhase', []);
		expect(good.victoryPoints).toBe(0);
		expect(good.spirits).toHaveLength(1);

		const evil = makePlayer({
			statusLevel: 3,
			spirits: [spirit(1, 'A', { 'King': 1 }, {})]
		});
		applyTrigger(makeState(evil), 'Red', 'awakeningPhase', []);
		expect(evil.victoryPoints).toBe(0);
		expect(evil.spirits).toHaveLength(1); // the Evil discard happens on claim, not the trigger
	});

	it('Relic Sentinel grants no VP on the trigger even at ≥24 VP while Good', () => {
		const p = makePlayer({
			statusLevel: 0,
			victoryPoints: 24,
			spirits: [spirit(1, 'A', { 'Relic Sentinel': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', []);
		expect(p.victoryPoints).toBe(24);
	});

	it('Queen grants no VP on the awakeningPhase trigger (her ability is on her own awakening)', () => {
		const red = makePlayer({
			playerColor: 'Red',
			statusLevel: 0,
			spirits: [spirit(1, 'A', { 'Queen': 1 }, {})]
		});
		applyTrigger(makeState(red), 'Red', 'awakeningPhase', []);
		expect(red.victoryPoints).toBe(0);
	});
});
