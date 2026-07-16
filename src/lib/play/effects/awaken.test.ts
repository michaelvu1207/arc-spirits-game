/**
 * P2 awakening-gate tests.
 *
 * Covers the generic rune-cost resolver (`checkAwakenCondition` /
 * `payAwakenCondition`), the runtime `awakenSpirit` command path (gate → pay →
 * flip → fire the `awakening` trigger), the `text`-condition manual path, and
 * the `enterAwakening` eligibility intersection. Mixes pure unit tests with
 * full-runtime command-path tests, mirroring framework.test.ts conventions.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import { enterAwakening } from '../phases';
import { buildEffectContext } from './context';
import {
	checkAwakenCondition,
	payAwakenCondition,
	canAutoAwaken,
	needsManualAwaken,
	buildAwakenOffer,
	buildAwakenLockedOffer
} from './awaken';
import { CLASS_EFFECTS, MANUAL_CLASSES, type ClassEffect } from './registry';
import { HANDLER_CLASSES } from './handlers';
import {
	AWAKEN_HANDLERS,
	AWAKEN_PROGRESS_KEYS,
	AWAKEN_SPIRIT_IDS,
	MANUAL_AWAKEN,
	recordRestAwakenProgress
} from './awakenHandlers';
import { applyCultivate } from './apply';
import { createRng } from '../rng';
import type {
	AwakenDiscardRef,
	GameActor,
	GameCommand,
	NormalizedAwaken,
	PlayCatalog,
	PlayCatalogSpirit,
	PlaySpirit,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from '../types';
import type { MatSlotSnapshot } from '$lib/types';

const ANY_RELIC = '19d72567-4ac8-4214-a21f-596bc88de8f7';
const ANY_RUNE = '7ca279f0-1ca8-484a-a86e-0a87aaa7b312';
const FIRE_RUNE = '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86';
const WATER_RUNE = 'a6111d01-2c55-4b1f-854a-32887d92b8e1';

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

function spirit(slotIndex: number, id: string, name: string, isFaceDown = true): PlaySpirit {
	return { slotIndex, id, name, cost: 2, classes: {}, origins: {}, isFaceDown };
}

/** The `slotIndex` of a rune/spirit discard ref (augment refs are slotless → -1). */
function runeSlot(ref: AwakenDiscardRef): number {
	return ref.kind === 'rune' || ref.kind === 'spirit' ? ref.slotIndex : -1;
}

/**
 * A held rune slot. `id` matches a catalog rune id; `name` is the display
 * fallback. `originId`/`classId`/`special` let a fixture pin the item's KIND so
 * wildcard matching (Any Rune ⇒ origin runes, Any Relic ⇒ relics) is exercised
 * faithfully: classId ⇒ augment, else originId ⇒ rune, else relic.
 */
function rune(
	slotIndex: number,
	opts: {
		id?: string;
		name?: string;
		guid?: string;
		hasRune?: boolean;
		originId?: string;
		classId?: string;
		special?: boolean;
	} = {}
): MatSlotSnapshot {
	return {
		slotIndex,
		hasRune: opts.hasRune ?? true,
		id: opts.id,
		name: opts.name,
		guid: opts.guid,
		type: 'rune',
		originId: opts.originId,
		classId: opts.classId,
		special: opts.special
	};
}

function makeState(player: PrivatePlayerState, seed = 1): PublicGameState {
	return {
		rng: createRng(seed),
		players: { Red: player },
		activeSeats: ['Red'] as SeatColor[]
	} as unknown as PublicGameState;
}

/** A catalog whose only spirit carries the given normalized awaken condition. */
function catalogWith(
	spiritId: string,
	awaken: NormalizedAwaken | undefined,
	extra: Partial<PlayCatalogSpirit> = {}
): PlayCatalog {
	const entry: PlayCatalogSpirit = {
		id: spiritId,
		name: spiritId,
		cost: 2,
		classes: {},
		origins: {},
		awaken,
		...extra
	};
	return { guardians: [], spirits: [entry], mats: [], classes: [], dice: [], monsters: [] };
}

function ctxFor(
	player: PrivatePlayerState,
	catalog: PlayCatalog
): ReturnType<typeof buildEffectContext> {
	return buildEffectContext({
		state: makeState(player),
		seat: 'Red',
		player,
		trigger: 'awakening',
		log: [],
		traitCount: 0,
		catalog
	});
}

// ── Unit: checkAwakenCondition ────────────────────────────────────────────────

describe('checkAwakenCondition', () => {
	it('a null/undefined condition is a free flip (ok:true)', () => {
		const player = makePlayer({ spirits: [spirit(1, 'free', 'Free')] });
		const check = checkAwakenCondition(ctxFor(player, catalogWith('free', undefined)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(true);
	});

	it('insufficient runes → ok:false with a reason', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'fire3', 'Golem')],
			mats: [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE })] // only 2 of 3
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 3, wildcard: false }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('fire3', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(false);
		expect(check.reason).toBe('insufficient_runes');
		expect(check.kind).toBe('rune_cost');
	});

	it('exact runes → ok:true', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'fire3', 'Golem')],
			mats: [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE }), rune(3, { id: FIRE_RUNE })]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 3, wildcard: false }]
		};
		expect(
			checkAwakenCondition(ctxFor(player, catalogWith('fire3', awaken)), {
				spirit: player.spirits[0]
			}).ok
		).toBe(true);
	});

	// Regression: wildcard costs are KIND-STRICT. "Any Relic" counts ONLY relic-kind
	// held items — origin runes never pay it; "Any Rune" counts ONLY origin runes —
	// relics never pay it. Modeled on "Mod Injector" = three of any relic.
	// See runeMatch.ts wildcardMatch.
	const FAIRY_RELIC = 'e02af831-e599-4676-9e37-820d19bfc3e1';
	it('Mod Injector (3 "any relic"): 2 relics + 2 origin runes held → NOT awakenable', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'mod', 'Mod Injector')],
			mats: [
				rune(1, { id: FAIRY_RELIC, name: 'Fairy' }), // relic (no originId/classId)
				rune(2, { id: FAIRY_RELIC, name: 'Fairy' }), // relic
				rune(3, { id: WATER_RUNE, name: 'Water', originId: 'water-origin' }), // origin rune
				rune(4, { id: 'cyber', name: 'Cyber', originId: 'cyber-origin' }) // origin rune
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 3, wildcard: true }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('mod', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(false);
		expect(check.reason).toBe('insufficient_runes');
		expect(check.kind).toBe('rune_cost');
	});

	// (a) a 3× any-relic cost with held = 3 origin RUNES → NOT awakenable (a rune
	//     never pays a relic cost).
	it('any-relic cost (×3): 3 origin RUNES held → NOT awakenable (rune ≠ relic)', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'mod', 'Mod Injector')],
			mats: [
				rune(1, { id: WATER_RUNE, name: 'Water', originId: 'water-origin' }),
				rune(2, { id: 'fire', name: 'Fire', originId: 'fire-origin' }),
				rune(3, { id: 'cyber', name: 'Cyber', originId: 'cyber-origin' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 3, wildcard: true }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('mod', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(false);
		expect(check.reason).toBe('insufficient_runes');
	});

	// (b) a 1× any-rune cost with held = 1 RELIC only → NOT awakenable (a relic
	//     never pays a rune cost).
	it('any-rune cost (×1): 1 RELIC held → NOT awakenable (relic ≠ rune)', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'sleeper', 'Sleeper')],
			mats: [rune(1, { id: FAIRY_RELIC, name: 'Fairy' })] // relic, no originId
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 1, wildcard: true }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('sleeper', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(false);
		expect(check.reason).toBe('insufficient_runes');
	});

	// (c) positive controls: 3 relics → any-relic ok; 1 origin rune → any-rune ok.
	it('Mod Injector (3 "any relic"): 3 relics held → awakenable (positive control)', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'mod', 'Mod Injector')],
			mats: [
				rune(1, { id: FAIRY_RELIC, name: 'Fairy' }),
				rune(2, { id: FAIRY_RELIC, name: 'Fairy' }),
				rune(3, { id: FAIRY_RELIC, name: 'Fairy' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 3, wildcard: true }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('mod', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(true);
		expect(check.kind).toBe('rune_cost');
	});

	it('any-rune cost (×1): 1 origin rune held → awakenable (positive control)', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'sleeper', 'Sleeper')],
			mats: [rune(1, { id: WATER_RUNE, name: 'Water', originId: 'water-origin' })]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 1, wildcard: true }]
		};
		const check = checkAwakenCondition(ctxFor(player, catalogWith('sleeper', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(true);
	});

	it('a text condition is never auto-satisfiable and carries the verbatim text', () => {
		const player = makePlayer({ spirits: [spirit(1, 'txt', 'Aquamaiden')] });
		const awaken: NormalizedAwaken = { kind: 'text', text: 'Discard 2 Teapots at the Tidal Cove' };
		const check = checkAwakenCondition(ctxFor(player, catalogWith('txt', awaken)), {
			spirit: player.spirits[0]
		});
		expect(check.ok).toBe(false);
		expect(check.kind).toBe('text');
		expect(check.text).toBe('Discard 2 Teapots at the Tidal Cove');
	});
});

// ── Unit: payAwakenCondition + matching strategy ─────────────────────────────

describe('payAwakenCondition', () => {
	it('discards exactly the required runes, leaving others untouched', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'fire3', 'Golem')],
			mats: [
				rune(1, { id: FIRE_RUNE }),
				rune(2, { id: FIRE_RUNE }),
				rune(3, { id: FIRE_RUNE }),
				rune(4, { name: 'Keepsake', id: 'unrelated' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 3, wildcard: false }]
		};
		const pay = payAwakenCondition(ctxFor(player, catalogWith('fire3', awaken)), {
			spirit: player.spirits[0]
		});
		expect(pay.ok).toBe(true);
		expect(pay.discarded).toHaveLength(3);
		// The three Fire runes are spent; the unrelated rune is still held.
		expect(player.mats.filter((r) => r.id === FIRE_RUNE).every((r) => r.hasRune === false)).toBe(
			true
		);
		expect(player.mats.find((r) => r.id === 'unrelated')!.hasRune).toBe(true);
	});

	it('Water Dragon mixed cost: 2 named + 1 Any-Relic wildcard, wildcard eats a relic', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'water', 'Water Dragon')],
			mats: [
				rune(1, { id: WATER_RUNE }),
				rune(2, { id: WATER_RUNE }),
				rune(3, { name: 'Random Relic', id: 'misc' }) // relic-kind → satisfies Any Relic
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [
				{ runeId: WATER_RUNE, name: 'Water', kind: 'rune', count: 2, wildcard: false },
				{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 1, wildcard: true }
			]
		};
		const pay = payAwakenCondition(ctxFor(player, catalogWith('water', awaken)), {
			spirit: player.spirits[0]
		});
		expect(pay.ok).toBe(true);
		// All three runes consumed (2 Water named + 1 wildcard = the misc relic).
		expect(player.mats.every((r) => r.hasRune === false)).toBe(true);
	});

	it('prefers consuming the exact-name match before spending a wildcard', () => {
		// Cost = 1 named Water + 1 wildcard. Held = 1 Water + 1 misc. The named
		// requirement must take the Water rune, leaving the wildcard the misc one.
		const player = makePlayer({
			spirits: [spirit(1, 'w', 'W')],
			// The misc rune is an ORIGIN rune so it can satisfy the Any-Rune wildcard.
			mats: [
				rune(1, { id: WATER_RUNE, originId: 'water-origin' }),
				rune(2, { name: 'misc', id: 'misc', originId: 'misc-origin' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [
				{ runeId: WATER_RUNE, name: 'Water', kind: 'rune', count: 1, wildcard: false },
				{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 1, wildcard: true }
			]
		};
		const pay = payAwakenCondition(ctxFor(player, catalogWith('w', awaken)), {
			spirit: player.spirits[0]
		});
		expect(pay.ok).toBe(true);
		expect(player.mats.every((r) => r.hasRune === false)).toBe(true);
	});

	it('count-via-repeats: needs 3, succeeds with 3 and fails with 2', () => {
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 3, wildcard: false }]
		};
		const withThree = makePlayer({
			spirits: [spirit(1, 'f', 'F')],
			mats: [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE }), rune(3, { id: FIRE_RUNE })]
		});
		expect(
			payAwakenCondition(ctxFor(withThree, catalogWith('f', awaken)), {
				spirit: withThree.spirits[0]
			}).ok
		).toBe(true);

		const withTwo = makePlayer({
			spirits: [spirit(1, 'f', 'F')],
			mats: [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE })]
		});
		const failed = payAwakenCondition(ctxFor(withTwo, catalogWith('f', awaken)), {
			spirit: withTwo.spirits[0]
		});
		expect(failed.ok).toBe(false);
		// Nothing discarded on a failed pay.
		expect(withTwo.mats.every((r) => r.hasRune === true)).toBe(true);
	});

	it('text conditions cannot be paid (manual path)', () => {
		const player = makePlayer({
			spirits: [spirit(1, 't', 'T')],
			mats: [rune(1, { id: FIRE_RUNE })]
		});
		const awaken: NormalizedAwaken = { kind: 'text', text: 'do something' };
		const pay = payAwakenCondition(ctxFor(player, catalogWith('t', awaken)), {
			spirit: player.spirits[0]
		});
		expect(pay.ok).toBe(false);
	});

	it('runeInstanceIds prefers a specific copy when several match a wildcard', () => {
		const player = makePlayer({
			spirits: [spirit(1, 'w', 'W')],
			// Both copies are ORIGIN runes so either can satisfy the Any-Rune wildcard.
			mats: [
				rune(1, { id: 'a', guid: 'g1', originId: 'o-a' }),
				rune(2, { id: 'b', guid: 'g2', originId: 'o-b' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 1, wildcard: true }]
		};
		payAwakenCondition(ctxFor(player, catalogWith('w', awaken)), { spirit: player.spirits[0] }, [
			'g2'
		]);
		// The g2 copy is spent; g1 is preserved.
		expect(player.mats.find((r) => r.guid === 'g2')!.hasRune).toBe(false);
		expect(player.mats.find((r) => r.guid === 'g1')!.hasRune).toBe(true);
	});

	// Regression (F1 guid hole): a strict selection binds by SLOT INDEX on guid-less
	// mats (the production shape). A wrong complete selection is rejected and spends
	// nothing; the correct one spends exactly the chosen slots. Pre-fix, guid-less mats
	// made strict binding a no-op and auto-pick silently paid the wrong cost.
	it('strict selection binds by slotIndex on guid-less mats (wrong reject, right pay)', () => {
		const FLOWER = 'flower-id';
		const FAIRY = 'fairy-id';
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FLOWER, name: 'Flower', kind: 'relic', count: 2, wildcard: false }]
		};
		const makeMats = () => [
			rune(1, { id: FLOWER, name: 'Flower' }),
			rune(2, { id: FLOWER, name: 'Flower' }),
			rune(3, { id: FAIRY, name: 'Fairy' }),
			rune(4, { id: FAIRY, name: 'Fairy' })
		];

		// Two Fairy slots (3,4) for a Flower ×2 cost → rejected, nothing spent.
		const wrong = makePlayer({ spirits: [spirit(1, 'rc', 'RC')], mats: makeMats() });
		const rejected = payAwakenCondition(
			ctxFor(wrong, catalogWith('rc', awaken)),
			{ spirit: wrong.spirits[0] },
			['3', '4'],
			true
		);
		expect(rejected.ok).toBe(false);
		expect(rejected.reason).toBe('invalid_discard_selection');
		expect(wrong.mats.every((r) => r.hasRune)).toBe(true);

		// The two Flower slots (1,2) → pays exactly the Flowers, Fairies untouched.
		const right = makePlayer({ spirits: [spirit(1, 'rc', 'RC')], mats: makeMats() });
		const paid = payAwakenCondition(
			ctxFor(right, catalogWith('rc', awaken)),
			{ spirit: right.spirits[0] },
			['1', '2'],
			true
		);
		expect(paid.ok).toBe(true);
		expect(right.mats.filter((r) => r.id === FLOWER).every((r) => !r.hasRune)).toBe(true);
		expect(right.mats.filter((r) => r.id === FAIRY).every((r) => r.hasRune)).toBe(true);
	});
});

describe('canAutoAwaken', () => {
	it('is true for free + payable, false for unpayable + text', () => {
		const free = makePlayer({ spirits: [spirit(1, 'free', 'Free')] });
		expect(
			canAutoAwaken(ctxFor(free, catalogWith('free', undefined)), { spirit: free.spirits[0] })
		).toBe(true);

		const payable = makePlayer({
			spirits: [spirit(1, 'f', 'F')],
			mats: [rune(1, { id: FIRE_RUNE })]
		});
		const payAwaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 1, wildcard: false }]
		};
		expect(
			canAutoAwaken(ctxFor(payable, catalogWith('f', payAwaken)), { spirit: payable.spirits[0] })
		).toBe(true);

		const broke = makePlayer({ spirits: [spirit(1, 'f', 'F')], mats: [] });
		expect(
			canAutoAwaken(ctxFor(broke, catalogWith('f', payAwaken)), { spirit: broke.spirits[0] })
		).toBe(false);

		const txt = makePlayer({ spirits: [spirit(1, 't', 'T')] });
		const textAwaken: NormalizedAwaken = { kind: 'text', text: 'x' };
		expect(
			canAutoAwaken(ctxFor(txt, catalogWith('t', textAwaken)), { spirit: txt.spirits[0] })
		).toBe(false);
	});
});

// ── enterAwakening eligibility intersection ────────────────────────────────────

describe('enterAwakening awakenEligible', () => {
	it('includes free/null + payable; excludes unsatisfiable + text', () => {
		const player = makePlayer({
			spirits: [
				spirit(1, 'free', 'Free'), // free → eligible
				spirit(2, 'payable', 'Payable'), // payable rune_cost → eligible
				spirit(3, 'broke', 'Broke'), // unpayable rune_cost → excluded
				spirit(4, 'txt', 'Text'), // text → excluded
				{ ...spirit(5, 'faceup', 'FaceUp'), isFaceDown: false } // not face-down → excluded
			],
			mats: [rune(1, { id: FIRE_RUNE })] // funds exactly one rune cost
		});
		const payAwaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 1, wildcard: false }]
		};
		const brokeAwaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 3, wildcard: true }]
		};
		const textAwaken: NormalizedAwaken = { kind: 'text', text: 'do it by hand' };
		const catalog: PlayCatalog = {
			guardians: [],
			mats: [],
			classes: [],
			dice: [],
			monsters: [],
			spirits: [
				{ id: 'free', name: 'Free', cost: 2, classes: {}, origins: {}, awaken: undefined },
				{ id: 'payable', name: 'Payable', cost: 2, classes: {}, origins: {}, awaken: payAwaken },
				{ id: 'broke', name: 'Broke', cost: 2, classes: {}, origins: {}, awaken: brokeAwaken },
				{ id: 'txt', name: 'Text', cost: 2, classes: {}, origins: {}, awaken: textAwaken }
			]
		};
		const state = makeState(player);
		state.phase = 'location';
		enterAwakening(state, catalog);
		expect(state.players.Red!.awakenEligible.sort()).toEqual([1, 2]);
	});

	it('without a catalog, offers every face-down slot (pre-P2 fallback)', () => {
		const player = makePlayer({
			spirits: [
				spirit(1, 'a', 'A'),
				spirit(2, 'b', 'B'),
				{ ...spirit(3, 'c', 'C'), isFaceDown: false }
			]
		});
		const state = makeState(player);
		state.phase = 'location';
		enterAwakening(state);
		expect(state.players.Red!.awakenEligible.sort()).toEqual([1, 2]);
	});
});

// ── Full-runtime command path ─────────────────────────────────────────────────

const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };

/** Register a synthetic onAwaken class effect for the duration of one test. */
const SYNTHETIC: string[] = [];
function withSynthClass(name: string, effects: ClassEffect[]): void {
	CLASS_EFFECTS[name] = effects;
	SYNTHETIC.push(name);
}
afterEach(() => {
	for (const name of SYNTHETIC.splice(0)) delete CLASS_EFFECTS[name];
});

function awakenCatalog(
	awaken: NormalizedAwaken | undefined,
	classes: Record<string, number> = {}
): PlayCatalog {
	return {
		guardians: [{ id: 'g-myrtle', name: 'Myrtle', originId: null }],
		mats: [],
		classes: [],
		dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
		monsters: [],
		spirits: [{ id: 'sleeper', name: 'Sleeper', cost: 2, classes, origins: {}, awaken }]
	};
}

function startedGame(catalog: PlayCatalog): PublicGameState {
	let state = createLobbyState({ roomCode: 'AWK1', guardianNames: ['Myrtle'] });
	const claim = applyGameCommand(state, HOST, { type: 'claimSeat', seatColor: 'Red' }, catalog);
	if (!claim.ok) throw new Error(claim.error.message);
	state = claim.state;
	const guardian = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'selectGuardian', guardianName: 'Myrtle' },
		catalog
	);
	if (!guardian.ok) throw new Error(guardian.error.message);
	state = guardian.state;
	const started = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'startGame' },
		catalog
	);
	if (!started.ok) throw new Error(started.error.message);
	// These suites exercise the awaken command path, which is gated to the Awakening
	// phase; park the started game there. (Tests that need another phase set it after.)
	started.state.phase = 'awakening';
	return started.state;
}

describe('runtime awakenSpirit gate', () => {
	it('insufficient runes → ok:false awaken_unmet; spirit stays face-down', () => {
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 2, wildcard: false }]
		};
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.mats = [rune(1, { id: FIRE_RUNE })]; // only one of two

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected failure');
		expect(result.error.code).toBe('awaken_unmet');
		// Re-read state (command clones): the original spirit is unchanged.
		expect(state.players.Red!.spirits[0].isFaceDown).toBe(true);
	});

	it('exact runes → ok:true, isFaceDown=false, required runes discarded, others untouched', () => {
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 2, wildcard: false }]
		};
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.mats = [
			rune(1, { id: FIRE_RUNE }),
			rune(2, { id: FIRE_RUNE }),
			rune(3, { id: 'keep', name: 'Keep' })
		];

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		const out = result.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false);
		expect(out.mats.filter((r) => r.id === FIRE_RUNE).every((r) => r.hasRune === false)).toBe(true);
		expect(out.mats.find((r) => r.id === 'keep')!.hasRune).toBe(true);
	});

	it('Water Dragon mixed cost resolves through the command path; wildcard accepts a relic', () => {
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [
				{ runeId: WATER_RUNE, name: 'Water', kind: 'rune', count: 2, wildcard: false },
				{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 1, wildcard: true }
			]
		};
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.mats = [
			rune(1, { id: WATER_RUNE }),
			rune(2, { id: WATER_RUNE }),
			rune(3, { id: 'unrelated', name: 'Trinket' })
		];

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		const out = result.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false);
		expect(out.mats.every((r) => r.hasRune === false)).toBe(true);
	});

	it('count-via-repeats: a 3-of-a-rune cost needs 3 (fails with 2)', () => {
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire', kind: 'rune', count: 3, wildcard: false }]
		};
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.mats = [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE })];

		const failed = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(failed.ok).toBe(false);

		red.mats = [rune(1, { id: FIRE_RUNE }), rune(2, { id: FIRE_RUNE }), rune(3, { id: FIRE_RUNE })];
		const ok = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(ok.ok).toBe(true);
	});

	// F1: an EXPLICIT, COMPLETE discard selection is BINDING — the exact case from the
	// audit (cost "Flower ×2", player selected two Fairy Relics, engine silently discarded
	// two Flowers). Wrong picks now reject; right picks pay; no picks still auto-pick.
	//
	// Regression: the mats carry NO `guid` — the production snapshot shape. The prior
	// binding keyed on guid, so server-side (guid-less) mats made the ref→id translation
	// come out EMPTY and strict binding silently degraded to auto-pick, letting the forged
	// Fairy selection through. Binding on slotIndex closes that hole. (Adding guids here
	// would mask the bug — which is exactly why the earlier unit test missed it.)
	it('F1: complete explicit discardRefs are binding — wrong reject, right pay, none auto-pick', () => {
		const FLOWER = 'flower-id';
		const FAIRY = 'fairy-id';
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FLOWER, name: 'Flower', kind: 'relic', count: 2, wildcard: false }]
		};
		const catalog = awakenCatalog(awaken);
		const seed = () => {
			const state = startedGame(catalog);
			const red = state.players.Red!;
			red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
			// No guids — mirrors the real server snapshot (see MatSlotSnapshot: guid?).
			red.mats = [
				rune(1, { id: FLOWER, name: 'Flower' }),
				rune(2, { id: FLOWER, name: 'Flower' }),
				rune(3, { id: FAIRY, name: 'Fairy' }),
				rune(4, { id: FAIRY, name: 'Fairy' })
			];
			return state;
		};
		const RED_A = { ...HOST, seatColor: 'Red' as const };

		// Wrong items: two Fairy Relics for a Flower ×2 cost → REJECTED, nothing spent.
		const wrong = seed();
		const rejected = applyGameCommand(
			wrong,
			RED_A,
			{
				type: 'awakenSpirit',
				slotIndex: 1,
				discardRefs: [
					{ kind: 'rune', slotIndex: 3 },
					{ kind: 'rune', slotIndex: 4 }
				]
			},
			catalog
		);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error('expected rejection');
		expect(rejected.error.code).toBe('invalid_discard_selection');
		expect(wrong.players.Red!.spirits[0].isFaceDown).toBe(true);
		expect(wrong.players.Red!.mats.every((r) => r.hasRune)).toBe(true);

		// Right items: the two Flowers → SUCCEEDS, spends exactly the Flowers (not the Fairies).
		const right = seed();
		const paid = applyGameCommand(
			right,
			RED_A,
			{
				type: 'awakenSpirit',
				slotIndex: 1,
				discardRefs: [
					{ kind: 'rune', slotIndex: 1 },
					{ kind: 'rune', slotIndex: 2 }
				]
			},
			catalog
		);
		expect(paid.ok).toBe(true);
		if (!paid.ok) throw new Error(paid.error.message);
		const outPaid = paid.state.players.Red!;
		expect(outPaid.spirits[0].isFaceDown).toBe(false);
		expect(outPaid.mats.filter((r) => r.id === FLOWER).every((r) => r.hasRune === false)).toBe(
			true
		);
		expect(outPaid.mats.filter((r) => r.id === FAIRY).every((r) => r.hasRune === true)).toBe(true);

		// No refs: auto-pick unchanged (spends the two Flowers, the only cost-eligible mats).
		const auto = seed();
		const autoRes = applyGameCommand(auto, RED_A, { type: 'awakenSpirit', slotIndex: 1 }, catalog);
		expect(autoRes.ok).toBe(true);
		if (!autoRes.ok) throw new Error(autoRes.error.message);
		expect(
			autoRes.state.players.Red!.mats.filter((r) => r.id === FLOWER).every((r) => !r.hasRune)
		).toBe(true);
	});

	// Bot / old-client compat: a PARTIAL selection (fewer refs than the cost needs) is a
	// PREFERENCE, not a binding — it must still auto-pick the remainder, never reject.
	it('a partial explicit selection stays a preference (auto-pick fills the rest)', () => {
		const FLOWER = 'flower-id';
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FLOWER, name: 'Flower', kind: 'relic', count: 2, wildcard: false }]
		};
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.mats = [rune(1, { id: FLOWER, name: 'Flower' }), rune(2, { id: FLOWER, name: 'Flower' })];
		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1, discardRefs: [{ kind: 'rune', slotIndex: 1 }] },
			catalog
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);
		const out = res.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false);
		expect(out.mats.every((r) => r.hasRune === false)).toBe(true);
	});

	it("fires the 'awakening' trigger on success (onAwaken CLASS_EFFECTS resolve)", () => {
		withSynthClass('SynthAwaken', [
			{
				trigger: 'awakening',
				breakpoints: [{ count: 1, actions: [{ kind: 'gainAttackDice', tier: 'basic', amount: 2 }] }]
			}
		]);
		// Free flip; the awakened spirit carries the SynthAwaken class so its
		// onAwaken effect should fire once it becomes face-up.
		const catalog = awakenCatalog(undefined, { SynthAwaken: 1 });
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [{ ...spirit(1, 'sleeper', 'Sleeper'), classes: { SynthAwaken: 1 } }];
		red.maxBarrier = 10;
		red.attackDice = [];

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		const out = result.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false);
		// The awakening trigger granted 2 basic attack dice.
		expect(out.attackDice).toHaveLength(2);
		expect(out.attackDice.every((d) => d.tier === 'basic')).toBe(true);
	});

	it('a text-condition spirit stays face-down + raises exactly one manualPrompt with the DB text', () => {
		// A `text` awaken can't be auto-resolved: the command surfaces a manual
		// prompt (so the runtime clone carrying it is observable) and leaves the
		// spirit face-down. checkAwakenCondition itself returns ok:false (unit test
		// above) — the runtime represents "blocked" by NOT flipping.
		const text = 'Discard 2 Teapots at the Tidal Cove';
		const awaken: NormalizedAwaken = { kind: 'text', text };
		const catalog = awakenCatalog(awaken);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, 'sleeper', 'Sleeper')];
		red.manualPrompts = [];

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		const out = result.state.players.Red!;
		// Flip is blocked.
		expect(out.spirits[0].isFaceDown).toBe(true);
		// Exactly one prompt, carrying the verbatim DB text.
		const awakenPrompts = out.manualPrompts.filter((p) => p.source === 'awaken');
		expect(awakenPrompts).toHaveLength(1);
		expect(awakenPrompts[0].text).toContain(text);
		expect(awakenPrompts[0].text).toContain('Sleeper');
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 6: scripted text-awaken handlers + manual-confirm + interaction classes
// ══════════════════════════════════════════════════════════════════════════════

const IDS = AWAKEN_SPIRIT_IDS;

/** A held relic slot (type='relic'); `name` drives the substring filter. */
function relic(slotIndex: number, name: string, hasRune = true): MatSlotSnapshot {
	return { slotIndex, hasRune, name, type: 'relic' };
}

/** Build an awaken-handler context (effect context + the spirit being flipped). */
function handlerCtx(player: PrivatePlayerState, spiritSlot: PlaySpirit, command?: GameCommand) {
	return {
		...buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening' as const,
			log: [],
			traitCount: 0,
			catalog: { guardians: [], spirits: [], mats: [], classes: [], dice: [], monsters: [] },
			command
		}),
		spirit: spiritSlot
	};
}

/** A catalog carrying a single text spirit with the given id + name. */
function textCatalog(spiritId: string, name: string, text: string): PlayCatalog {
	return {
		guardians: [],
		mats: [],
		classes: [],
		dice: [],
		monsters: [],
		spirits: [
			{ id: spiritId, name, cost: 2, classes: {}, origins: {}, awaken: { kind: 'text', text } }
		]
	};
}

describe('AWAKEN_HANDLERS discard choice (let-me-choose)', () => {
	it('Tidal Fairy offers both "X or Y" candidates and discards the chosen one', () => {
		const sp = spirit(1, IDS.tidalFairy, 'Tidal Fairy');
		// Both candidates are RELICS ("Discard a Fairy or Teapot Relic").
		const player = makePlayer({
			spirits: [sp],
			mats: [relic(1, 'Fairy'), relic(2, 'Teapot')]
		});
		const handler = AWAKEN_HANDLERS[IDS.tidalFairy];
		const choice = handler.discardChoice!(handlerCtx(player, sp));
		expect(choice).not.toBeNull();
		expect(choice!.count).toBe(1);
		// Both the Fairy Relic and the Teapot Relic are offered (union of branches).
		expect(choice!.options.map((o) => o.label).sort()).toEqual(['Fairy', 'Teapot']);

		// Choose to spend the Teapot (held slot 2) → the Fairy Relic survives.
		const payCtx = {
			...handlerCtx(player, sp),
			command: { type: 'awakenSpirit', slotIndex: 1, discardRefs: [{ kind: 'rune', slotIndex: 2 }] }
		};
		handler.pay(payCtx);
		expect(player.mats.find((r) => r.name === 'Teapot')!.hasRune).toBe(false);
		expect(player.mats.find((r) => r.name === 'Fairy')!.hasRune).toBe(true);
	});

	it('buildAwakenOffer surfaces the requirement text + candidate options', () => {
		const sp = spirit(1, IDS.tidalFairy, 'Tidal Fairy');
		const player = makePlayer({
			spirits: [sp],
			mats: [relic(1, 'Fairy'), relic(2, 'Teapot')]
		});
		const catalog = textCatalog(IDS.tidalFairy, 'Tidal Fairy', 'Discard a Fairy or Teapot Relic');
		const ctx = buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening',
			log: [],
			traitCount: 0,
			catalog
		});
		const offer = buildAwakenOffer(ctx, { spirit: sp });
		expect(offer).not.toBeNull();
		expect(offer!.spiritName).toBe('Tidal Fairy');
		expect(offer!.requirement).toBe('Discard a Fairy or Teapot Relic');
		expect(offer!.discardCount).toBe(1);
		expect(offer!.options).toHaveLength(2);
	});

	it('an invalid selection falls back to auto-pick (still pays the cost)', () => {
		const sp = spirit(1, IDS.tidalFairy, 'Tidal Fairy');
		const player = makePlayer({ spirits: [sp], mats: [relic(1, 'Fairy')] });
		const handler = AWAKEN_HANDLERS[IDS.tidalFairy];
		const payCtx = {
			...handlerCtx(player, sp),
			command: {
				type: 'awakenSpirit',
				slotIndex: 1,
				discardRefs: [{ kind: 'rune', slotIndex: 99 }]
			}
		};
		handler.pay(payCtx);
		// Bad ref ⇒ auto-pick the only valid candidate (the Fairy Relic) instead.
		expect(player.mats.find((r) => r.name === 'Fairy')!.hasRune).toBe(false);
	});

	it('buildAwakenOffer lists the player spendable runes to choose which to spend', () => {
		const sp = spirit(1, 'rc-spirit', 'Rune Cost Spirit');
		const player = makePlayer({ spirits: [sp], mats: [rune(1, { id: FIRE_RUNE })] });
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FIRE_RUNE, name: 'Fire Rune', kind: 'rune', count: 1, wildcard: false }]
		};
		const catalog: PlayCatalog = {
			guardians: [],
			mats: [],
			classes: [],
			dice: [],
			monsters: [],
			spirits: [
				{ id: 'rc-spirit', name: 'Rune Cost Spirit', cost: 2, classes: {}, origins: {}, awaken }
			]
		};
		const ctx = buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening',
			log: [],
			traitCount: 0,
			catalog
		});
		const offer = buildAwakenOffer(ctx, { spirit: sp });
		expect(offer!.requirement).toBe('Discard Fire Rune');
		expect(offer!.discardCount).toBe(1);
		// The held rune is offered so the owner picks WHICH copy to spend.
		expect(offer!.options).toHaveLength(1);
		expect(offer!.options[0].ref).toEqual({ kind: 'rune', slotIndex: 1 });
		expect(offer!.options[0].runeId).toBe(FIRE_RUNE);
	});

	it('rune_cost costSlots list ONLY cost-eligible mats per slot; ineligible carries the rest (S2)', () => {
		const FLOWER = 'flower-id';
		const sp = spirit(1, 'rc', 'Rune Cost');
		const player = makePlayer({
			spirits: [sp],
			mats: [
				rune(1, { id: FLOWER, name: 'Flower' }),
				rune(2, { id: FLOWER, name: 'Flower' }),
				rune(3, { id: 'fairy-id', name: 'Fairy' }),
				rune(4, { id: 'magnet-id', name: 'Magnet' })
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: FLOWER, name: 'Flower', kind: 'relic', count: 2, wildcard: false }]
		};
		const offer = buildAwakenOffer(ctxFor(player, catalogWith('rc', awaken)), { spirit: sp })!;
		// One cost slot per required unit (Flower ×2), each eligible only to the two Flowers.
		expect(offer.costSlots).toHaveLength(2);
		expect(offer.costSlots!.every((s) => s.need === 'Flower' && s.wildcard === false)).toBe(true);
		expect(offer.costSlots![0].needRuneId).toBe(FLOWER);
		expect(offer.costSlots![0].eligibleRefs).toEqual([
			{ kind: 'rune', slotIndex: 1 },
			{ kind: 'rune', slotIndex: 2 }
		]);
		expect(offer.requiresSelection).toBeUndefined();
		// options narrowed to the eligible Flowers — NOT the whole rack (S2 fix).
		expect(offer.options.map((o) => runeSlot(o.ref)).sort()).toEqual([1, 2]);
		// Fairy + Magnet are surfaced as ineligible with an engine-owned reason.
		expect(offer.ineligible!.map((i) => runeSlot(i.ref)).sort()).toEqual([3, 4]);
		expect(offer.ineligible!.every((i) => i.reason.includes('Flower'))).toBe(true);
	});

	it('rune_cost costSlots: a WILDCARD slot lists every held mat of its kind, no others', () => {
		const sp = spirit(1, 'rc', 'Rune Cost');
		const player = makePlayer({
			spirits: [sp],
			mats: [
				rune(1, { id: 'fairy-id', name: 'Fairy' }), // relic (no originId)
				rune(2, { id: 'teapot-id', name: 'Teapot' }), // relic
				rune(3, { id: 'cyber-id', name: 'Cyber', originId: 'o-cyber' }) // origin rune
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RELIC, name: 'Any Relic', kind: 'relic', count: 1, wildcard: true }]
		};
		const offer = buildAwakenOffer(ctxFor(player, catalogWith('rc', awaken)), { spirit: sp })!;
		expect(offer.costSlots).toHaveLength(1);
		expect(offer.costSlots![0].wildcard).toBe(true);
		// Wildcards have no named icon id.
		expect(offer.costSlots![0].needRuneId).toBeUndefined();
		expect(offer.costSlots![0].eligibleRefs.map(runeSlot)).toEqual([1, 2]);
		expect(offer.requiresSelection).toBe(true);
		// The origin rune can't pay an "Any Relic" cost → ineligible.
		expect(offer.ineligible!.map((i) => runeSlot(i.ref))).toEqual([3]);
	});

	it('Any Rune excludes relics and includes eligible overflow beyond carry capacity', () => {
		const sp = spirit(1, 'rc', 'Rune Cost');
		const player = makePlayer({
			spirits: [sp],
			mats: [
				rune(1, { id: 'fairy-id', name: 'Fairy' }), // relic — excluded
				rune(2, { id: 'forest-id', name: 'Forest', originId: 'o-forest' }),
				rune(3, { id: 'teapot-id', name: 'Teapot' }), // relic — excluded
				rune(4, { id: 'cyber-id', name: 'Cyber', originId: 'o-cyber' }),
				rune(5, { id: 'tidal-id', name: 'Tidal', originId: 'o-tidal' }), // overflow
				rune(6, { id: 'lantern-id', name: 'Lantern', originId: 'o-lantern' }) // overflow
			]
		});
		const awaken: NormalizedAwaken = {
			kind: 'rune_cost',
			mats: [{ runeId: ANY_RUNE, name: 'Any Rune', kind: 'rune', count: 2, wildcard: true }]
		};
		const offer = buildAwakenOffer(ctxFor(player, catalogWith('rc', awaken)), { spirit: sp })!;

		expect(offer.costSlots).toHaveLength(2);
		expect(offer.costSlots![0].eligibleRefs.map(runeSlot)).toEqual([2, 4, 5, 6]);
		expect(offer.costSlots![1].eligibleRefs.map(runeSlot)).toEqual([2, 4, 5, 6]);
		expect(offer.options.map((option) => runeSlot(option.ref))).toEqual([2, 4, 5, 6]);
		expect(offer.requiresSelection).toBe(true);
	});

	// Discoverability: a Faerie the player CANNOT yet pay for produces no clickable
	// offer, but DOES produce a passive locked hint spelling out what it needs — so
	// the Cleanup UI can always show "Tidal Fairy — Discard 1 Fairy Rune or …".
	it('buildAwakenLockedOffer surfaces the requirement when NOT yet payable', () => {
		const sp = spirit(1, IDS.tidalFairy, 'Tidal Fairy');
		// Holds neither a Fairy nor a Teapot relic → not awakenable.
		const player = makePlayer({ spirits: [sp], mats: [relic(1, 'Keepsake')] });
		const catalog = textCatalog(IDS.tidalFairy, 'Tidal Fairy', 'Discard a Fairy or Teapot Relic');
		const ctx = buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening',
			log: [],
			traitCount: 0,
			catalog
		});
		// No clickable offer (can't pay)…
		expect(buildAwakenOffer(ctx, { spirit: sp })).toBeNull();
		// …but a locked hint with the verbatim requirement.
		const hint = buildAwakenLockedOffer(ctx, { spirit: sp });
		expect(hint).not.toBeNull();
		expect(hint!.spiritName).toBe('Tidal Fairy');
		expect(hint!.requirement).toBe('Discard a Fairy or Teapot Relic');
	});

	it('buildAwakenLockedOffer returns null once the spirit IS payable (it gets a real offer)', () => {
		const sp = spirit(1, IDS.tidalFairy, 'Tidal Fairy');
		const player = makePlayer({ spirits: [sp], mats: [relic(2, 'Teapot')] });
		const catalog = textCatalog(IDS.tidalFairy, 'Tidal Fairy', 'Discard a Fairy or Teapot Relic');
		const ctx = buildEffectContext({
			state: makeState(player),
			seat: 'Red',
			player,
			trigger: 'awakening',
			log: [],
			traitCount: 0,
			catalog
		});
		expect(buildAwakenOffer(ctx, { spirit: sp })).not.toBeNull();
		expect(buildAwakenLockedOffer(ctx, { spirit: sp })).toBeNull();
	});
});

describe('AWAKEN_HANDLERS discard-at-location', () => {
	it('Arcane Synthesizer: discards 2 of your OTHER Arcane Abyss spirits (cost 7-9)', () => {
		const sp = { ...spirit(1, IDS.arcaneSynthesizer, 'Arcane Synthesizer'), cost: 7 };
		const player = makePlayer({
			spirits: [
				sp,
				{ ...spirit(2, 'a1', 'Abyss 1', false), cost: 7 },
				{ ...spirit(3, 'a2', 'Abyss 2', false), cost: 9 },
				{ ...spirit(4, 'w1', 'World 1', false), cost: 3 } // a Spirit-World spirit — NOT a candidate
			]
		});
		const handler = AWAKEN_HANDLERS[IDS.arcaneSynthesizer];
		const ctx = handlerCtx(player, sp);
		// Only the two cost 7-9 spirits (excluding self) are candidates.
		expect(
			handler.discardChoice!(ctx)!
				.options.map((o) => o.label)
				.sort()
		).toEqual(['Abyss 1', 'Abyss 2']);
		expect(handler.check(ctx).ok).toBe(true);
		handler.pay(ctx);
		// The two abyss spirits are gone; the Synthesizer + the World spirit remain.
		expect(player.spirits.map((s) => s.slotIndex).sort()).toEqual([1, 4]);
	});

	it('Arcane Synthesizer: fails with fewer than 2 other Abyss spirits', () => {
		const sp = { ...spirit(1, IDS.astrobiologist, 'Astrobiologist'), cost: 7 };
		const player = makePlayer({
			spirits: [sp, { ...spirit(2, 'a1', 'Abyss 1', false), cost: 8 }] // only one other abyss spirit
		});
		expect(AWAKEN_HANDLERS[IDS.astrobiologist].check(handlerCtx(player, sp)).ok).toBe(false);
	});

	it('Floral Fairy: the "or" alternative (Flower Relic) satisfies, no location gate', () => {
		const sp = spirit(1, IDS.floralFairy, 'Floral Fairy');
		const player = makePlayer({
			spirits: [sp],
			// No navigationDestination — the DB condition has no location requirement.
			mats: [relic(1, 'Flower Charm')] // a relic matching "Flower"
		});
		const handler = AWAKEN_HANDLERS[IDS.floralFairy];
		const ctx = handlerCtx(player, sp);
		expect(handler.check(ctx).ok).toBe(true);
		handler.pay(ctx);
		expect(player.mats[0].hasRune).toBe(false);
	});

	it('Floral Fairy: a Fairy Relic also satisfies (Fairy is a relic, not a rune)', () => {
		const sp = spirit(1, IDS.floralFairy, 'Floral Fairy');
		const player = makePlayer({ spirits: [sp], mats: [relic(1, 'Fairy')] });
		const handler = AWAKEN_HANDLERS[IDS.floralFairy];
		const ctx = handlerCtx(player, sp);
		expect(handler.check(ctx).ok).toBe(true);
		handler.pay(ctx);
		expect(player.mats[0].hasRune).toBe(false);
	});

	it('Space Invader: needs 4 attack dice; pay discards exactly 4', () => {
		const sp = spirit(1, IDS.spaceInvader, 'Space Invader');
		const player = makePlayer({
			spirits: [sp],
			attackDice: [
				{ instanceId: 'a', tier: 'basic' },
				{ instanceId: 'b', tier: 'basic' },
				{ instanceId: 'c', tier: 'enchanted' },
				{ instanceId: 'd', tier: 'exalted' },
				{ instanceId: 'e', tier: 'arcane' }
			]
		});
		const handler = AWAKEN_HANDLERS[IDS.spaceInvader];
		const ctx = handlerCtx(player, sp);
		expect(handler.check(ctx).ok).toBe(true);
		const choice = handler.discardChoice?.(ctx);
		expect(choice?.count).toBe(4);
		expect(choice?.requiresSelection).toBe(true);
		expect(choice?.options.map((option) => option.ref)).toEqual([
			{ kind: 'attackDie', instanceId: 'a' },
			{ kind: 'attackDie', instanceId: 'b' },
			{ kind: 'attackDie', instanceId: 'c' },
			{ kind: 'attackDie', instanceId: 'd' },
			{ kind: 'attackDie', instanceId: 'e' }
		]);
		const exactCostPlayer = makePlayer({
			spirits: [sp],
			attackDice: player.attackDice.slice(0, 4)
		});
		expect(
			handler.discardChoice?.(handlerCtx(exactCostPlayer, sp))?.requiresSelection
		).toBeUndefined();
		handler.pay(ctx);
		expect(player.attackDice).toHaveLength(1); // 5 - 4 discarded
		expect(player.attackDice[0]).toMatchObject({ instanceId: 'e', tier: 'arcane' });

		const broke = makePlayer({ spirits: [sp], attackDice: [{ instanceId: 'a', tier: 'basic' }] });
		expect(AWAKEN_HANDLERS[IDS.spaceInvader].check(handlerCtx(broke, sp)).ok).toBe(false);
	});

	it('Space Invader: awakenSpirit spends the exact four attack dice selected by the owner', () => {
		const catalog = textCatalog(IDS.spaceInvader, 'Space Invader', 'Discard 4 of any attack dice.');
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, IDS.spaceInvader, 'Space Invader')];
		red.attackDice = [
			{ instanceId: 'basic-1', tier: 'basic' },
			{ instanceId: 'enchanted-1', tier: 'enchanted' },
			{ instanceId: 'exalted-1', tier: 'exalted' },
			{ instanceId: 'arcane-1', tier: 'arcane' },
			{ instanceId: 'arcane-keep', tier: 'arcane' }
		];

		const result = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{
				type: 'awakenSpirit',
				slotIndex: 1,
				discardRefs: ['basic-1', 'enchanted-1', 'exalted-1', 'arcane-1'].map((instanceId) => ({
					kind: 'attackDie' as const,
					instanceId
				}))
			},
			catalog
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.state.players.Red!.attackDice).toEqual([
			{ instanceId: 'arcane-keep', tier: 'arcane' }
		]);
		expect(result.state.players.Red!.spirits[0].isFaceDown).toBe(false);
	});

	it('awakenSpirit command flips a scripted text spirit and pays the cost (Blood Hound)', () => {
		const catalog = textCatalog(
			IDS.bloodHound,
			'Blood Hound',
			'Discard 1 relic with 2 or less barriers.'
		);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, IDS.bloodHound, 'Blood Hound')];
		red.mats = [relic(1, 'Teapot'), relic(2, 'Keepsake')];

		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);
		const out = res.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false); // flipped, no manual prompt
		expect(out.manualPrompts.filter((p) => p.source === 'awaken')).toHaveLength(0);
		// Exactly one relic was spent to pay the cost.
		expect(out.mats.filter((r) => r.hasRune).length).toBe(1);
	});

	it('awakenSpirit on an unsatisfiable scripted text spirit hard-blocks (no manual prompt)', () => {
		const catalog = textCatalog(
			IDS.bloodHound,
			'Blood Hound',
			'Discard 1 relic with 2 or less barriers.'
		);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, IDS.bloodHound, 'Blood Hound')];
		red.mats = []; // no relic to discard → unsatisfiable

		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error('expected hard block');
		expect(res.error.code).toBe('awaken_unmet');
		// No manual prompt was raised (scripted text just isn't ready yet).
		expect(state.players.Red!.manualPrompts.filter((p) => p.source === 'awaken')).toHaveLength(0);
	});
});

describe('AWAKEN_HANDLERS alignment + cultivate (Contessa)', () => {
	it('Contessa: cultivating while Evil sets the flag → satisfiable', () => {
		const contessa = spirit(1, IDS.contessa, 'Contessa');
		// Actor is Evil (Fallen = 3). DB condition is simply "Cultivate while Evil."
		const actor = makePlayer({ playerColor: 'Red', statusLevel: 3, spirits: [contessa] });
		const state = {
			rng: createRng(1),
			players: { Red: actor },
			activeSeats: ['Red'] as SeatColor[]
		} as unknown as PublicGameState;

		// Before cultivate: not satisfiable.
		expect(AWAKEN_HANDLERS[IDS.contessa].check(handlerCtx(actor, contessa)).ok).toBe(false);

		applyCultivate(state, 'Red', []);
		expect(actor.awakenProgress[AWAKEN_PROGRESS_KEYS.contessa]).toBe(true);

		// After cultivate: satisfiable; pay consumes the flag.
		const ctx = handlerCtx(actor, contessa);
		expect(AWAKEN_HANDLERS[IDS.contessa].check(ctx).ok).toBe(true);
		AWAKEN_HANDLERS[IDS.contessa].pay(ctx);
		expect(actor.awakenProgress[AWAKEN_PROGRESS_KEYS.contessa]).toBeFalsy();
	});

	it('Contessa: cultivating while Good does NOT set the flag', () => {
		const contessa = spirit(1, IDS.contessa, 'Contessa');
		const actorGood = makePlayer({ playerColor: 'Red', statusLevel: 0, spirits: [contessa] });
		const state = {
			rng: createRng(1),
			players: { Red: actorGood },
			activeSeats: ['Red'] as SeatColor[]
		} as unknown as PublicGameState;
		applyCultivate(state, 'Red', []);
		expect(actorGood.awakenProgress[AWAKEN_PROGRESS_KEYS.contessa]).toBeFalsy();
	});

	it('Arcane Huntress: cultivating while Fallen with ≥10 potential sets the flag', () => {
		const huntress = spirit(1, IDS.arcaneHuntress, 'Arcane Huntress');
		const actor = makePlayer({
			playerColor: 'Red',
			statusLevel: 3,
			maxBarrier: 10,
			spirits: [huntress]
		});
		const state = {
			rng: createRng(1),
			players: { Red: actor },
			activeSeats: ['Red'] as SeatColor[]
		} as unknown as PublicGameState;
		expect(AWAKEN_HANDLERS[IDS.arcaneHuntress].check(handlerCtx(actor, huntress)).ok).toBe(false);
		applyCultivate(state, 'Red', []);
		expect(actor.awakenProgress[AWAKEN_PROGRESS_KEYS.arcaneHuntress]).toBe(true);
	});

	it('Arcane Huntress: NOT Fallen, or <10 potential, does NOT set the flag', () => {
		const mk = (statusLevel: number, maxBarrier: number) => {
			const huntress = spirit(1, IDS.arcaneHuntress, 'Arcane Huntress');
			const actor = makePlayer({
				playerColor: 'Red',
				statusLevel,
				maxBarrier,
				spirits: [huntress]
			});
			const state = {
				rng: createRng(1),
				players: { Red: actor },
				activeSeats: ['Red'] as SeatColor[]
			} as unknown as PublicGameState;
			applyCultivate(state, 'Red', []);
			return actor.awakenProgress[AWAKEN_PROGRESS_KEYS.arcaneHuntress];
		};
		expect(mk(3, 4)).toBeFalsy(); // Fallen but only 4 potential
		expect(mk(2, 10)).toBeFalsy(); // 10 potential but Corrupt (not Fallen)
	});
});

describe('AWAKEN_HANDLERS rest progress (Meteor Shower)', () => {
	it('Meteor Shower: resting with ≥10 potential sets the flag → satisfiable', () => {
		const meteor = spirit(1, IDS.meteorShower, 'Meteor Shower');
		const actor = makePlayer({ playerColor: 'Red', maxBarrier: 10, spirits: [meteor] });
		expect(AWAKEN_HANDLERS[IDS.meteorShower].check(handlerCtx(actor, meteor)).ok).toBe(false);
		recordRestAwakenProgress(actor);
		expect(actor.awakenProgress[AWAKEN_PROGRESS_KEYS.meteorShower]).toBe(true);
		expect(AWAKEN_HANDLERS[IDS.meteorShower].check(handlerCtx(actor, meteor)).ok).toBe(true);
	});

	it('Meteor Shower: resting with <10 potential does NOT set the flag', () => {
		const meteor = spirit(1, IDS.meteorShower, 'Meteor Shower');
		const actor = makePlayer({ playerColor: 'Red', maxBarrier: 9, spirits: [meteor] });
		recordRestAwakenProgress(actor);
		expect(actor.awakenProgress[AWAKEN_PROGRESS_KEYS.meteorShower]).toBeFalsy();
	});
});

describe('combat-event awaken progress (Hollow Eyes)', () => {
	// Build a 2-player started game with a fixed seed so PvP damage is deterministic.
	function startedPvpGame(seed: number): PublicGameState {
		const catalog: PlayCatalog = {
			guardians: [
				{ id: 'g-a', name: 'Myrtle', originId: null },
				{ id: 'g-b', name: 'Nyra', originId: null }
			],
			mats: [],
			classes: [],
			dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
			monsters: [],
			spirits: Array.from({ length: 12 }, (_, i) => ({
				id: `s-${i}`,
				name: `Spirit ${i}`,
				cost: (i % 5) + 1,
				classes: {},
				origins: {}
			}))
		};
		let state = createLobbyState({ roomCode: 'PVP1', guardianNames: ['Myrtle', 'Nyra'] });
		for (const [seat, guardian, member] of [
			['Red', 'Myrtle', 'm-red'],
			['Blue', 'Nyra', 'm-blue']
		] as const) {
			// Distinct member ids per seat — one member can only hold one seat.
			const actor: GameActor = {
				memberId: member,
				displayName: member,
				role: 'player',
				seatColor: null
			};
			const claim = applyGameCommand(state, actor, { type: 'claimSeat', seatColor: seat }, catalog);
			if (!claim.ok) throw new Error(claim.error.message);
			state = claim.state;
			const g = applyGameCommand(
				state,
				{ ...actor, seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardian },
				catalog
			);
			if (!g.ok) throw new Error(g.error.message);
			state = g.state;
		}
		const started = applyGameCommand(state, HOST, { type: 'startGame', seed }, catalog);
		if (!started.ok) throw new Error(started.error.message);
		return started.state;
	}

	/** Drive both seats into the encounter phase, co-located, attacker Evil. */
	function intoEncounter(
		state: PublicGameState,
		catalog: PlayCatalog,
		attackerEvil = true
	): PublicGameState {
		const red = state.players.Red!;
		const blue = state.players.Blue!;
		red.statusLevel = attackerEvil ? 3 : 0; // Fallen attacker
		blue.statusLevel = 0; // Good target
		// Lock both to the same non-Abyss location so the encounter opens with an aggressor.
		let s = state;
		for (const seat of ['Red', 'Blue'] as const) {
			const r = applyGameCommand(
				s,
				{ ...HOST, seatColor: seat },
				{ type: 'lockNavigation', destination: 'Cyber City' },
				catalog
			);
			if (!r.ok) throw new Error(r.error.message);
			s = r.state;
		}
		// Locking no longer reveals instantly; force-advance to open the encounter
		// (both seats already locked → just reveals their chosen destinations).
		const fa = applyGameCommand(s, HOST, { type: 'forceAdvancePhase' }, catalog);
		if (!fa.ok) throw new Error(fa.error.message);
		return fa.state;
	}

	const pvpCatalog: PlayCatalog = {
		guardians: [
			{ id: 'g-a', name: 'Myrtle', originId: null },
			{ id: 'g-b', name: 'Nyra', originId: null }
		],
		mats: [],
		classes: [],
		dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
		monsters: [],
		spirits: []
	};

	it('Hollow Eyes: dealing >3 damage to a player sets the flag → awaken satisfiable', () => {
		let state = startedPvpGame(2024);
		state = intoEncounter(state, pvpCatalog);
		expect(state.phase).toBe('encounter');
		// Give the attacker a big arcane dice pool so the roll exceeds 3 deterministically.
		const red = state.players.Red!;
		red.maxBarrier = 10;
		red.attackDice = Array.from({ length: 10 }, (_, i) => ({
			instanceId: `d${i}`,
			tier: 'arcane' as const
		}));
		red.spirits = [spirit(1, IDS.hollowEyes, 'Hollow Eyes')];

		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'initiatePvp' },
			pvpCatalog
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);
		const outRed = res.state.players.Red!;
		// >3 damage from 10 arcane dice (min face 1 ⇒ ≥10) → Hollow Eyes flag set.
		expect(outRed.awakenProgress[AWAKEN_PROGRESS_KEYS.hollowEyes]).toBe(true);
		// And the scripted handler now reports satisfiable.
		const ctx = handlerCtx(outRed, outRed.spirits[0]);
		expect(AWAKEN_HANDLERS[IDS.hollowEyes].check(ctx).ok).toBe(true);
	});

	it('is deterministic: same seed → same PvP damage + same flag outcome', () => {
		const run = () => {
			let state = startedPvpGame(999);
			state = intoEncounter(state, pvpCatalog);
			const red = state.players.Red!;
			red.maxBarrier = 10;
			red.attackDice = Array.from({ length: 6 }, (_, i) => ({
				instanceId: `d${i}`,
				tier: 'basic' as const
			}));
			red.spirits = [spirit(1, IDS.hollowEyes, 'Hollow Eyes')];
			const res = applyGameCommand(
				state,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'initiatePvp' },
				pvpCatalog
			);
			if (!res.ok) throw new Error(res.error.message);
			return res.state.players.Red!.awakenProgress[AWAKEN_PROGRESS_KEYS.hollowEyes] ?? false;
		};
		expect(run()).toBe(run());
	});
});

describe('manualAwaken command', () => {
	it('confirms a NON-scripted text spirit and flips it face-up', () => {
		// A text spirit id that has NO scripted handler.
		const UNSCRIPTED = 'unscripted-text-spirit';
		expect(AWAKEN_HANDLERS[UNSCRIPTED]).toBeUndefined();
		const text = 'Resolve some bespoke condition by hand.';
		const catalog = textCatalog(UNSCRIPTED, 'Mystery', text);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, UNSCRIPTED, 'Mystery')];

		// awakenSpirit on it raises a manual prompt + leaves it face-down.
		const auto = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'awakenSpirit', slotIndex: 1 },
			catalog
		);
		expect(auto.ok).toBe(true);
		if (!auto.ok) throw new Error(auto.error.message);
		const afterAuto = auto.state.players.Red!;
		expect(afterAuto.spirits[0].isFaceDown).toBe(true);
		expect(afterAuto.manualPrompts.filter((p) => p.source === 'awaken')).toHaveLength(1);
		// The prompt names its slot so clients answer with manualAwaken{slotIndex}
		// (flip + clear) instead of a generic dismissManualPrompt (clear only).
		expect(afterAuto.manualPrompts.find((p) => p.source === 'awaken')?.slotIndex).toBe(1);

		// manualAwaken confirms it: flip + clear the prompt.
		const confirm = applyGameCommand(
			auto.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'manualAwaken', slotIndex: 1 },
			catalog
		);
		expect(confirm.ok).toBe(true);
		if (!confirm.ok) throw new Error(confirm.error.message);
		const out = confirm.state.players.Red!;
		expect(out.spirits[0].isFaceDown).toBe(false);
		expect(out.manualPrompts.filter((p) => p.source === 'awaken')).toHaveLength(0);
	});

	it('clears only the confirmed slot when two same-named spirits both hold prompts', () => {
		const UNSCRIPTED = 'unscripted-text-spirit';
		const catalog = textCatalog(UNSCRIPTED, 'Mystery', 'Resolve by hand.');
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, UNSCRIPTED, 'Mystery'), spirit(2, UNSCRIPTED, 'Mystery')];

		let cur = state;
		for (const slotIndex of [1, 2]) {
			const res = applyGameCommand(
				cur,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'awakenSpirit', slotIndex },
				catalog
			);
			if (!res.ok) throw new Error(res.error.message);
			cur = res.state;
		}
		expect(cur.players.Red!.manualPrompts.filter((p) => p.source === 'awaken')).toHaveLength(2);

		// Confirm slot 1: slot-keyed clearing must keep slot 2's prompt (a pure
		// text-includes match would wipe both — the names are identical).
		const confirm = applyGameCommand(
			cur,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'manualAwaken', slotIndex: 1 },
			catalog
		);
		expect(confirm.ok).toBe(true);
		if (!confirm.ok) throw new Error(confirm.error.message);
		const out = confirm.state.players.Red!;
		expect(out.spirits.find((s) => s.slotIndex === 1)?.isFaceDown).toBe(false);
		expect(out.spirits.find((s) => s.slotIndex === 2)?.isFaceDown).toBe(true);
		const remaining = out.manualPrompts.filter((p) => p.source === 'awaken');
		expect(remaining).toHaveLength(1);
		expect(remaining[0].slotIndex).toBe(2);
	});

	it('rejects manualAwaken on a SCRIPTED text spirit (must use awakenSpirit)', () => {
		const catalog = textCatalog(IDS.spaceInvader, 'Space Invader', 'Discard 4 of any attack dice.');
		const state = startedGame(catalog);
		const red = state.players.Red!;
		red.spirits = [spirit(1, IDS.spaceInvader, 'Space Invader')];
		red.attackDice = Array.from({ length: 4 }, (_, i) => ({
			instanceId: `d${i}`,
			tier: 'basic' as const
		}));
		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'manualAwaken', slotIndex: 1 },
			catalog
		);
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error('expected rejection');
		expect(res.error.code).toBe('not_manual_awaken');
	});

	it('needsManualAwaken is true only for unscripted text', () => {
		const player = makePlayer({ spirits: [spirit(1, 'x', 'X')] });
		const unscripted = checkCtx(player, 'x', { kind: 'text', text: 'bespoke' });
		expect(needsManualAwaken(unscripted.ctx, { spirit: unscripted.spirit })).toBe(true);

		const scriptedPlayer = makePlayer({ spirits: [spirit(1, IDS.spaceInvader, 'SI')] });
		const scripted = checkCtx(scriptedPlayer, IDS.spaceInvader, {
			kind: 'text',
			text: 'Discard 4 of any attack dice.'
		});
		expect(needsManualAwaken(scripted.ctx, { spirit: scripted.spirit })).toBe(false);
	});
});

/** Helper: build a ctx + target for a single-spirit catalog. */
function checkCtx(player: PrivatePlayerState, spiritId: string, awaken: NormalizedAwaken) {
	const catalog = catalogWith(spiritId, awaken);
	return { ctx: ctxFor(player, catalog), spirit: player.spirits[0] };
}

describe('Phase 6 interaction classes emit one manual prompt with DB text', () => {
	function startedClassGame(
		classCounts: Record<string, number>,
		awaken: NormalizedAwaken | undefined = undefined
	): {
		state: PublicGameState;
		catalog: PlayCatalog;
	} {
		const catalog = awakenCatalog(awaken, classCounts);
		const state = startedGame(catalog);
		const red = state.players.Red!;
		// One AWAKENED spirit carrying the class so its trait count is active.
		red.spirits = [{ ...spirit(1, 'sleeper', 'Sleeper', false), classes: classCounts }];
		return { state, catalog };
	}

	it('Rune Mage: grants per-trade now (no manual prompt on the bare end-of-location beat)', () => {
		const { state, catalog } = startedClassGame({ 'Rune Mage': 1 });
		const red = state.players.Red!;
		red.navigationDestination = 'Cyber City';
		// Drive to the location phase so endLocationActions is legal.
		state.phase = 'location';
		red.phaseReady = false;
		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'endLocationActions' },
			catalog
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);
		// Rune Mage is now a real onLocationInteraction trade handler — it grants
		// Enchanted/Exalted dice per rune/relic traded (covered in effects.test.ts) and
		// emits NO manual prompt on the bare end-of-location beat (no trade ⇒ no grant).
		const prompts = res.state.players.Red!.manualPrompts.filter((p) => p.source === 'class');
		expect(prompts).toHaveLength(0);
	});

	it('Infiltrator: infiltratorSwap exchanges a die with a co-located player (no prompt)', () => {
		const { state, catalog } = startedClassGame({ Infiltrator: 1 });
		const red = state.players.Red!;
		const blue = makePlayer({
			playerColor: 'Blue',
			statusLevel: 0,
			navigationDestination: 'Cyber City'
		});
		state.players.Blue = blue;
		state.activeSeats = ['Red', 'Blue'];
		red.navigationDestination = 'Cyber City';
		red.attackDice = [{ instanceId: 'r0', tier: 'basic' }];
		blue.attackDice = [{ instanceId: 'b0', tier: 'arcane' }];
		state.phase = 'location';
		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{
				type: 'infiltratorSwap',
				swaps: [{ targetSeat: 'Blue', myInstanceId: 'r0', theirInstanceId: 'b0' }]
			},
			catalog
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);
		// Red takes Blue's arcane die; Blue is left with Red's basic die.
		expect(res.state.players.Red!.attackDice.map((d) => d.tier)).toEqual(['arcane']);
		expect(res.state.players.Blue!.attackDice.map((d) => d.tier)).toEqual(['basic']);
		// Built-in action — no manual prompt.
		expect(res.state.players.Red!.manualPrompts.filter((p) => p.source === 'class')).toHaveLength(
			0
		);
		// Once per round — a second swap is rejected.
		const again = applyGameCommand(
			res.state,
			{ ...HOST, seatColor: 'Red' },
			{
				type: 'infiltratorSwap',
				swaps: [{ targetSeat: 'Blue', myInstanceId: 'b0', theirInstanceId: 'r0' }]
			},
			catalog
		);
		expect(again.ok).toBe(false);
	});

	it('Ironmane: extraActions["combat"] lets the player fight the monster twice', () => {
		const { state, catalog } = startedClassGame({ Ironmane: 1 });
		const red = state.players.Red!;
		red.navigationDestination = 'Arcane Abyss';
		red.attackDice = [{ instanceId: 'd0', tier: 'basic' }];
		// Re-grant Ironmane's combat allowance (onNavigate would; set it directly here).
		red.extraActions = { combat: 1 };
		state.phase = 'location';
		state.monster = {
			id: 'm',
			name: 'Maw',
			hp: 100,
			maxHp: 100,
			damage: 0,
			rewardTrack: [],
			chooseAmount: 1,
			livesRemaining: 1,
			livesTotal: 1,
			ladderIndex: 0,
			ladderMax: 3
		};
		const first = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'startCombat' },
			catalog
		);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.error.message);
		const second = applyGameCommand(
			first.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'startCombat' },
			catalog
		);
		expect(second.ok).toBe(true); // second combat allowed by the extra allowance
		if (!second.ok) throw new Error(second.error.message);
		// A third is blocked (allowance exhausted: base 1 + 1 extra = 2).
		const third = applyGameCommand(
			second.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'startCombat' },
			catalog
		);
		expect(third.ok).toBe(false);
	});
});

// ── Coverage closure (Phase 6 → enables Phase 7) ──────────────────────────────

describe('Phase 6 coverage closure', () => {
	const TEXT_SPIRIT_IDS = Object.values(AWAKEN_SPIRIT_IDS);

	it('every text spirit is scripted (AWAKEN_HANDLERS) or manual (MANUAL_AWAKEN)', () => {
		for (const id of TEXT_SPIRIT_IDS) {
			const handled = Boolean(AWAKEN_HANDLERS[id]) || MANUAL_AWAKEN.has(id);
			expect(handled, `text spirit ${id} must be scripted or manual`).toBe(true);
		}
	});

	it('AWAKEN_HANDLERS + MANUAL_AWAKEN are disjoint', () => {
		for (const id of Object.keys(AWAKEN_HANDLERS)) {
			expect(MANUAL_AWAKEN.has(id)).toBe(false);
		}
	});

	it('the Phase-6 interaction classes are all accounted for', () => {
		// Ironmane is encoded (extraAction); Rune Mage is now a real trade handler;
		// Fairy Droid is now a run-handler (grants 2 augments bound to itself).
		expect(CLASS_EFFECTS.Ironmane).toBeDefined();
		expect(CLASS_EFFECTS['Child Prodigy']).toBeDefined();
		expect(MANUAL_CLASSES.has('Child Prodigy')).toBe(false);
		expect(HANDLER_CLASSES.has('Rune Mage')).toBe(true);
		// Infiltrator is now an ENGINE-handled standalone action (infiltratorSwap command
		// + swap UI) — no longer a manual prompt, and carries no CLASS_EFFECTS entry.
		expect(MANUAL_CLASSES.has('Infiltrator'), 'Infiltrator is engine-handled now').toBe(false);
		expect(CLASS_EFFECTS['Infiltrator'], 'Infiltrator has no effect-system entry').toBeUndefined();
		// Fairy Droid is no longer manual — it is a run-handler (bound-augment grant).
		expect(MANUAL_CLASSES.has('Fairy Droid'), 'Fairy Droid is handler-driven now').toBe(false);
		expect(HANDLER_CLASSES.has('Fairy Droid'), 'Fairy Droid must be a handler class').toBe(true);
	});

	it('every class in the game is encoded, handled, or allowlisted (no silent no-op)', () => {
		// The full 37-class roster from the `classes` table (English names).
		const ALL_CLASSES = [
			'Abyss Summoner',
			'Adaptive Fighter',
			'Ancient Magus',
			'Aquamaiden',
			'Arc Mage',
			'Arcane Advisor',
			'Blood Hunter',
			'Captain',
			'Child Prodigy',
			'Cursed Spirit',
			'Dark Assassin',
			'Dark Fighter',
			'Deep Sea Hunter',
			'Disruptor',
			'Dragon Warrior',
			'Elementalist',
			'Cultivator',
			'Fairy',
			'Fairy Droid',
			'Fighter',
			'Firekeeper',
			'Golden Ruler',
			'Golem of Wishes',
			'Healer',
			'Infiltrator',
			'Ironmane',
			'Mod Injector',
			'Purifier',
			'Rune Mage',
			'Sharpshooter',
			'Soul Weaver',
			'Spirit Animal',
			'Strategist',
			'The Corruptor',
			'Undercover',
			'World Ender',
			'World Guardian'
		];
		// Classes handled by a dedicated ENGINE/runtime path rather than the effect
		// system (declarative/handler/manual). Cursed Spirit's Awakening-Phase rewards
		// are surfaced as a Cleanup CLAIM — `enterAwakening` (phases.ts) builds the
		// player's `pendingAwakenReward` and `resolveAwakenReward` (runtime.ts) applies
		// the picks — so it carries no declarative/handler/manual effect, yet is fully
		// handled. Mirrors ENGINE_HANDLED_CLASSES in coverage.test.ts.
		const ENGINE_HANDLED_CLASSES = new Set<string>([
			'Cursed Spirit',
			'Golden Ruler',
			'World Guardian',
			// Infiltrator: standalone `infiltratorSwap` runtime action + swap UI.
			'Infiltrator',
			// Mod Injector: engine trade-cost waiver (free Spirit-Augment trades).
			'Mod Injector'
		]);
		for (const cls of ALL_CLASSES) {
			const handled =
				Boolean(CLASS_EFFECTS[cls]) ||
				HANDLER_CLASSES.has(cls) ||
				MANUAL_CLASSES.has(cls) ||
				ENGINE_HANDLED_CLASSES.has(cls);
			expect(handled, `class "${cls}" must be encoded, handled, or allowlisted`).toBe(true);
		}
	});
});
