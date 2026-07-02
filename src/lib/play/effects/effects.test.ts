import { describe, expect, it } from 'vitest';
import { applyTrigger, applyCultivate, awakenedClassCounts } from './apply';
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
	it('Fighter grants basic attack dice', () => {
		// Super-linear ladder: 4 Fighters → +5 basic dice (below the 10-cap).
		const p = makePlayer({ maxBarrier: 10, spirits: [spirit(1, 'A', { Fighter: 4 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(5);
		expect(p.attackDice.every((d) => d.tier === 'basic')).toBe(true);
	});

	it('attack dice are capped at the flat 10, no longer by potential', () => {
		// Low potential no longer limits dice: Fighter 4+ grants +10 (caps the pool) from empty.
		const p = makePlayer({ maxBarrier: 2, spirits: [spirit(1, 'A', { Fighter: 5 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(10); // not capped at maxTokens=2; tops out at the flat 10

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

	it('Elementalist upgrades a die to the next tier (count 2 → first breakpoint)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [{ instanceId: 'd0', tier: 'basic' }],
			spirits: [spirit(1, 'A', { Elementalist: 2 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice[0].tier).toBe('enchanted');
	});

	it('a lone Elementalist (count 1) upgrades nothing on the super-linear curve', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [{ instanceId: 'd0', tier: 'basic' }],
			spirits: [spirit(1, 'A', { Elementalist: 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice[0].tier).toBe('basic');
	});

	it('Elementalist upgrades cap at exalted — never reach arcane', () => {
		const p = makePlayer({
			maxBarrier: 10,
			// An exalted die plus a basic one, with plenty of upgrade steps.
			attackDice: [
				{ instanceId: 'd0', tier: 'exalted' },
				{ instanceId: 'd1', tier: 'basic' }
			],
			spirits: [spirit(1, 'A', { Elementalist: 4 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		// The basic die climbs to exalted; the exalted die is left alone; no arcane.
		expect(p.attackDice.some((d) => d.tier === 'arcane')).toBe(false);
		expect(p.attackDice.filter((d) => d.tier === 'exalted')).toHaveLength(2);
	});

	it('does nothing for a class with no Rest effect', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { Rogue: 3 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(0);
		expect(p.maxBarrier).toBe(4);
	});
});

describe('Cultivate action (intrinsic origin-rune yield)', () => {
	// Origin keys are origin DISPLAY NAMES (e.g. "Floral Patch"), as built by the catalog
	// loader. The basic rune for the Floral Patch origin is displayed as "Forest", but its
	// resolved slot name is "<Origin> Rune" → "Floral Patch Rune".
	it('grants 1 origin rune for every two spirits of that origin (no class needed)', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Floral Patch': 1 }),
				spirit(2, 'B', {}, { 'Floral Patch': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Floral Patch Rune')).toHaveLength(1);
		expect(p.maxBarrier).toBe(4); // no Cultivator → no potential
	});

	it('the Cultivate action grants ZERO potential without Cultivators (potential is Cultivator-only)', () => {
		// A player with other classes — but NO Cultivator — and even a lone Cultivator
		// (count 1, which grants nothing) gains 0 potential from the Cultivate action.
		const noCultivator = makePlayer({
			maxBarrier: 4,
			barrier: 4,
			spirits: [
				spirit(1, 'A', { Fighter: 2 }, { 'Floral Patch': 1 }),
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

	it('scales: four same-origin spirits → two runes', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Floral Patch': 1 }),
				spirit(2, 'B', {}, { 'Floral Patch': 1 }),
				spirit(3, 'C', {}, { 'Floral Patch': 1 }),
				spirit(4, 'D', {}, { 'Floral Patch': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Floral Patch Rune')).toHaveLength(2);
	});

	it('grants one rune PER origin (two Floral Patch + two Lantern Lights → one each)', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Floral Patch': 1 }),
				spirit(2, 'B', {}, { 'Floral Patch': 1 }),
				spirit(3, 'C', {}, { 'Lantern Lights': 1 }),
				spirit(4, 'D', {}, { 'Lantern Lights': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Floral Patch Rune')).toHaveLength(1);
		expect(p.mats.filter((r) => r.name === 'Lantern Lights Rune')).toHaveLength(1);
	});

	it('counts face-down (unawakened) spirits — origin is always active', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Floral Patch': 1 }, true), // face-down still counts
				spirit(2, 'B', {}, { 'Floral Patch': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Floral Patch Rune')).toHaveLength(1);
	});

	it('grants nothing for a lone spirit, or for an origin without a basic rune', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'Solo', {}, { 'Floral Patch': 1 }), // only one of the origin → 0
				spirit(2, 'Royal A', {}, { 'Royal Family': 1 }), // Royal Family has no basic rune
				spirit(3, 'Royal B', {}, { 'Royal Family': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats).toHaveLength(0);
		expect(p.maxBarrier).toBe(4);
	});
});

describe('Cultivator (onCultivate → potential by awakened count)', () => {
	const cult = (slot: number, name: string, faceDown = false) =>
		spirit(slot, name, { Cultivator: 1 }, { 'Floral Patch': 1 }, faceDown);

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

describe('Soul Weaver (onRest)', () => {
	it('sets stun immunity at 2 traits without restoring health', () => {
		const p = makePlayer({
			barrier: 2,
			maxBarrier: 4,
			brokenBarrier: 2,
			spirits: [spirit(1, 'A', { 'Soul Weaver': 2 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.stunImmune).toBe(true);
		expect(p.barrier).toBe(2); // the restore breakpoint (3) is not reached
	});

	it('at 3 traits sets stun immunity AND restores 2 health', () => {
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			brokenBarrier: 3,
			spirits: [spirit(1, 'A', { 'Soul Weaver': 3 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.stunImmune).toBe(true);
		expect(p.barrier).toBe(3); // +2 health
		expect(p.brokenBarrier).toBe(1);
	});
});

// Purifier is now an opt-in awakening decision that places augments on the player's
// Cursed Spirits (no manual prompt) — covered in classes/purifier.test.ts.

describe('Strategist (onRest)', () => {
	it('enqueues ONE decision card (no immediate discard) when it has ≥3 dice', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [
				attackDie('d0', 'basic'),
				attackDie('d1', 'basic'),
				attackDie('d2', 'basic'),
				attackDie('d3', 'basic')
			],
			spirits: [spirit(1, 'A', { Strategist: 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		// Nothing applied yet — just the opt-in card.
		expect(p.attackDice).toHaveLength(4);
		expect(p.unplacedAugments?.length ?? 0).toBe(0);
		expect(p.pendingDecisions).toHaveLength(1);
		expect(p.pendingDecisions[0].kind).toBe('strategistTrade');
	});

	it("resolving 'yes' discards 3 dice and grants the augment; 'no' does nothing", () => {
		const yes = makePlayer({
			maxBarrier: 10,
			attackDice: [
				attackDie('d0', 'basic'),
				attackDie('d1', 'basic'),
				attackDie('d2', 'basic'),
				attackDie('d3', 'basic')
			]
		});
		DECISION_RESOLVERS.strategistTrade(ctxFor(yes), 'yes');
		expect(yes.attackDice).toHaveLength(1); // 4 − 3
		expect(yes.unplacedAugments?.length ?? 0).toBe(1);

		const no = makePlayer({
			maxBarrier: 10,
			attackDice: [
				attackDie('d0', 'basic'),
				attackDie('d1', 'basic'),
				attackDie('d2', 'basic'),
				attackDie('d3', 'basic')
			]
		});
		DECISION_RESOLVERS.strategistTrade(ctxFor(no), 'no');
		expect(no.attackDice).toHaveLength(4);
		expect(no.unplacedAugments?.length ?? 0).toBe(0);
	});

	it('enqueues no decision (no discard, no augment) with fewer than 3 dice', () => {
		const p = makePlayer({
			maxBarrier: 10,
			attackDice: [attackDie('d0', 'basic'), attackDie('d1', 'basic')],
			spirits: [spirit(1, 'A', { Strategist: 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onRest', []);
		expect(p.attackDice).toHaveLength(2);
		expect(p.unplacedAugments?.length ?? 0).toBe(0);
		expect(p.pendingDecisions).toHaveLength(0);
	});
});

describe('Captain (onCultivate)', () => {
	it('gains 1 spirit augment when cultivating with 3+ Heroes (Human Enclave spirits)', () => {
		const p = makePlayer({
			spirits: [
				spirit(1, 'Cap', { Captain: 1 }, { 'Human Enclave': 1 }),
				spirit(2, 'B', {}, { 'Human Enclave': 1 }),
				spirit(3, 'C', {}, { 'Human Enclave': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.unplacedAugments?.length ?? 0).toBe(1);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
	});

	it('grants nothing with fewer than 3 Heroes', () => {
		const p = makePlayer({
			spirits: [
				spirit(1, 'Cap', { Captain: 1 }, { 'Human Enclave': 1 }),
				spirit(2, 'B', {}, { 'Human Enclave': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.unplacedAugments?.length ?? 0).toBe(0);
	});
});

// ── P4: combat-trigger class coverage (onMonsterKill / awakening) ─────────────

describe('Adaptive Fighter (onMonsterKill)', () => {
	it('gains 1 potential when overkilling by ≥2 on a kill', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [spirit(1, 'A', { 'Adaptive Fighter': 1 }, {})]
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
			spirits: [spirit(1, 'A', { 'Adaptive Fighter': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 5, overkill: 1, killed: true }
		});
		expect(p.maxBarrier).toBe(4);
	});

	it('gains 1 Enchanted attack die when it does NOT kill', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [spirit(1, 'A', { 'Adaptive Fighter': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 2, overkill: 0, killed: false }
		});
		expect(p.attackDice).toHaveLength(1);
		expect(p.attackDice[0].tier).toBe('enchanted');
		expect(p.maxBarrier).toBe(10); // no potential (no overkill)
	});

	it('activates per fighter — two Adaptive Fighters grant two Enchanted dice on a no-kill', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [
				spirit(1, 'A', { 'Adaptive Fighter': 1 }, {}),
				spirit(2, 'B', { 'Adaptive Fighter': 1 }, {})
			]
		});
		applyTrigger(makeState(p), 'Red', 'onMonsterKill', [], {
			combat: { dealt: 2, overkill: 0, killed: false }
		});
		expect(p.attackDice).toHaveLength(2);
		expect(p.attackDice.every((d) => d.tier === 'enchanted')).toBe(true);
	});

	it('activates per fighter — two Adaptive Fighters grant two potential on an overkill', () => {
		const p = makePlayer({
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', { 'Adaptive Fighter': 1 }, {}),
				spirit(2, 'B', { 'Adaptive Fighter': 1 }, {})
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
	it('on awakening, grants 1 exalted die per origin-matching spirit + 3 initiative', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [
				spirit(1, 'F', { Fairy: 1 }, { Forest: 1 }),
				spirit(2, 'B', {}, { Forest: 1 }),
				spirit(3, 'C', {}, { Cyber: 1 })
			]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 1 } });
		// Forest matches the Fairy (F) + B = 2 spirits → 2 exalted dice; +3 initiative.
		expect(p.attackDice.filter((d) => d.tier === 'exalted')).toHaveLength(2);
		expect(p.initiative).toBe(3);
	});

	it('does not fire when the spirit that awakened is not a Fairy', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [
				spirit(1, 'F', { Fairy: 1 }, { Forest: 1 }),
				spirit(2, 'X', { Fighter: 1 }, { Forest: 1 })
			]
		});
		// The Fighter (slot 2) awakened, not the Fairy → no Fairy grant.
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 2 } });
		expect(p.attackDice).toHaveLength(0);
		expect(p.initiative).toBe(0);
	});
});

describe('Dragon Warrior (awakening)', () => {
	it('gains 3 Arcane attack dice on the awakening trigger', () => {
		const p = makePlayer({
			maxBarrier: 10,
			spirits: [spirit(1, 'A', { 'Dragon Warrior': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakening', []);
		expect(p.attackDice).toHaveLength(3);
		expect(p.attackDice.every((d) => d.tier === 'arcane')).toBe(true);
	});

	it('gains 2 initiative on the inCombat trigger', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { 'Dragon Warrior': 1 }, {})] });
		applyTrigger(makeState(p), 'Red', 'inCombat', []);
		expect(p.initiative).toBe(2);
	});
});

describe('Abyss Summoner (onNavigate, Floral Patch decision)', () => {
	it('offers an abyssSummon decision at the Floral Patch (no manual prompt)', () => {
		const p = makePlayer({
			spirits: [spirit(1, 'A', { 'Abyss Summoner': 1 }, {})],
			navigationDestination: 'Floral Patch'
		});
		applyTrigger(makeState(p), 'Red', 'onNavigate', []);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
		expect(p.pendingDecisions.some((d) => d.kind === 'abyssSummonFlorality')).toBe(true);
	});

	it('does NOT offer the decision away from the Floral Patch', () => {
		const p = makePlayer({
			spirits: [spirit(1, 'A', { 'Abyss Summoner': 1 }, {})],
			navigationDestination: 'Cyber City'
		});
		applyTrigger(makeState(p), 'Red', 'onNavigate', []);
		expect(p.pendingDecisions.some((d) => d.kind === 'abyssSummonFlorality')).toBe(false);
	});

	it('is no longer in MANUAL_CLASSES (opt-in decision now)', () => {
		expect(MANUAL_CLASSES.has('Abyss Summoner')).toBe(false);
	});
});

describe('Fairy Droid (awakening)', () => {
	it('grants 2 spirit augments bound to this spirit when it awakens (no manual prompt)', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { 'Fairy Droid': 1 }, {})] });
		// The handler fires for the awakening spirit named by the command's slotIndex.
		applyTrigger(makeState(p), 'Red', 'awakening', [], { command: { slotIndex: 1 } });
		expect(p.unplacedAugments?.length ?? 0).toBe(2);
		expect((p.unplacedAugments ?? []).every((a) => a.boundSlotIndex === 1)).toBe(true);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
	});

	it('is no longer listed in MANUAL_CLASSES', () => {
		expect(MANUAL_CLASSES.has('Fairy Droid')).toBe(false);
	});
});

// ── P5: onNavigate coverage ───────────────────────────────────────────────────

describe('Deep Sea Hunter (onNavigate)', () => {
	it('gains 4 initiative and offers a change-destination decision (no manual prompt)', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { 'Deep Sea Hunter': 1 }, {})] });
		applyTrigger(makeState(p), 'Red', 'onNavigate', []);
		expect(p.initiative).toBe(4);
		expect(p.manualPrompts.filter((m) => m.source === 'class')).toHaveLength(0);
		const dec = p.pendingDecisions.find((d) => d.kind === 'deepSeaHunterRedirect');
		expect(dec).toBeDefined();
		expect(dec!.options.map((o) => o.id)).toContain('Tidal Cove');
		expect(dec!.options.map((o) => o.id)).toContain('keep');
	});

	it('is no longer in MANUAL_CLASSES (built-in decision now)', () => {
		expect(MANUAL_CLASSES.has('Deep Sea Hunter')).toBe(false);
	});
});

// Rune Traveler (the only class that set doubleRunes) was removed from the game; the
// doubleRunes PRIMITIVE remains in the engine, so this keeps direct coverage of it.
describe('doubleRunes primitive (Cultivate yield)', () => {
	it('doubled runes apply to the Cultivate origin-rune yield', () => {
		const p = makePlayer({
			doubleRunes: true,
			maxBarrier: 4,
			spirits: [
				spirit(1, 'A', {}, { 'Floral Patch': 1 }),
				spirit(2, 'B', {}, { 'Floral Patch': 1 }),
				spirit(3, 'C', {}, { 'Floral Patch': 1 }),
				spirit(4, 'D', {}, { 'Floral Patch': 1 })
			]
		});
		applyCultivate(makeState(p), 'Red', []);
		expect(p.mats.filter((r) => r.name === 'Floral Patch Rune')).toHaveLength(4); // floor(4/2)=2 → doubled
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

describe('The Corruptor (inCombat; Awakening grant is a Cleanup claim)', () => {
	it('grants +2 initiative passively in combat', () => {
		const p = makePlayer({ spirits: [spirit(1, 'A', { 'The Corruptor': 1 }, {})] });
		applyTrigger(makeState(p), 'Red', 'inCombat', []);
		expect(p.initiative).toBe(2);
	});

	it('does NOT auto-grant an Arcane die on the awakeningPhase trigger (now a Cleanup claim)', () => {
		const p = makePlayer({
			maxBarrier: 10,
			corruptedThisRound: true,
			spirits: [spirit(1, 'A', { 'The Corruptor': 1 }, {})]
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
	it('Golden Ruler grants no VP and discards nothing on the trigger', () => {
		const good = makePlayer({
			statusLevel: 0,
			spirits: [spirit(1, 'A', { 'Golden Ruler': 1 }, {})]
		});
		applyTrigger(makeState(good), 'Red', 'awakeningPhase', []);
		expect(good.victoryPoints).toBe(0);
		expect(good.spirits).toHaveLength(1);

		const evil = makePlayer({
			statusLevel: 3,
			spirits: [spirit(1, 'A', { 'Golden Ruler': 1 }, {})]
		});
		applyTrigger(makeState(evil), 'Red', 'awakeningPhase', []);
		expect(evil.victoryPoints).toBe(0);
		expect(evil.spirits).toHaveLength(1); // the Evil discard happens on claim, not the trigger
	});

	it('World Guardian grants no VP on the trigger even at ≥24 VP while Good', () => {
		const p = makePlayer({
			statusLevel: 0,
			victoryPoints: 24,
			spirits: [spirit(1, 'A', { 'World Guardian': 1 }, {})]
		});
		applyTrigger(makeState(p), 'Red', 'awakeningPhase', []);
		expect(p.victoryPoints).toBe(24);
	});

	it('World Ender grants a flat +1 VP on the awakeningPhase trigger (reworked)', () => {
		const red = makePlayer({
			playerColor: 'Red',
			statusLevel: 0,
			spirits: [spirit(1, 'A', { 'World Ender': 1 }, {})]
		});
		applyTrigger(makeState(red), 'Red', 'awakeningPhase', []);
		// World Ender is now a flat +1 VP handler (no longer the all-Evil Cleanup claim).
		expect(red.victoryPoints).toBe(1);
	});
});
