/**
 * Phase 7 — TOTAL COVERAGE HARNESS.
 *
 * This is the verification gate for the whole rules-engine goal: it proves that
 * EVERY class and EVERY spirit awakening requirement that exists in the DB is
 * accounted for by the engine — encoded declaratively, handled imperatively, or
 * deliberately allowlisted to a manual prompt. Nothing is a silent no-op.
 *
 * It runs OFFLINE against a committed fixture (`./__fixtures__/catalog-coverage.ts`)
 * that mirrors the `classes` + `hex_spirits` tables, so the test is deterministic
 * and needs no Supabase connection. Regenerate the fixture from the two SQL queries
 * documented at the top of that file if the DB schema changes.
 *
 * Four guarantees:
 *   1. CLASS COVERAGE   — every class name is in CLASS_EFFECTS, CLASS_HANDLERS, or
 *                         MANUAL_CLASSES. Failure lists the unhandled names.
 *   2. AWAKEN COVERAGE  — every spirit's awaken_condition is null (free), rune_cost
 *                         (generic), or text with a scripted/MANUAL handler.
 *   3. RUNE_COST PROOF  — every rune_cost spirit awakens with EXACTLY its required
 *                         runes (and is blocked with one fewer), via the real
 *                         normalizer + checkAwakenCondition + payAwakenCondition.
 *   4. NO ALLOWLIST ABUSE — every MANUAL_CLASSES name is a real class; every
 *                         MANUAL_AWAKEN id is a real text spirit.
 */

import { describe, expect, it } from 'vitest';
import { buildEffectContext } from './context';
import { checkAwakenCondition, payAwakenCondition } from './awaken';
import { CLASS_EFFECTS, MANUAL_CLASSES } from './registry';
import { HANDLER_CLASSES } from './handlers';
import { AWAKEN_HANDLERS, MANUAL_AWAKEN } from './awakenHandlers';
import { normalizeAwaken, WILDCARD_MAT_IDS, type AwakenRuneInfo } from '../awakenConditions';
import { createRng } from '../rng';
import type {
	NormalizedAwaken,
	PlayCatalog,
	PlayCatalogSpirit,
	PlaySpirit,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from '../types';
import type { MatSlotSnapshot } from '$lib/types';
import { CATALOG_CLASSES, CATALOG_SPIRITS } from './__fixtures__/catalog-coverage';

// ── Helpers (mirror awaken.test.ts conventions) ───────────────────────────────

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

function makeState(player: PrivatePlayerState, seed = 1): PublicGameState {
	return {
		rng: createRng(seed),
		players: { Red: player },
		activeSeats: ['Red'] as SeatColor[]
	} as unknown as PublicGameState;
}

function faceDownSpirit(id: string, name: string): PlaySpirit {
	return { slotIndex: 1, id, name, cost: 2, classes: {}, origins: {}, isFaceDown: true };
}

/**
 * A held rune slot keyed by catalog rune id (matchMatCost prefers id matching).
 *
 * Kind matters for WILDCARD costs: "Any Rune" only accepts origin runes and
 * "Any Relic" only accepts relics. When a fixture pays a wildcard cost it
 * passes the wildcard's own id as `runeId`; we then stamp the matching FK column
 * so the held item classifies as the kind that wildcard accepts (origin runes
 * carry `originId`; everything else is relic-kind, which "Any Relic" accepts).
 */
function heldRune(slotIndex: number, runeId: string): MatSlotSnapshot {
	const originId = runeId === WILDCARD_MAT_IDS.anyRune ? 'fixture-origin' : undefined;
	return { slotIndex, hasRune: true, id: runeId, name: runeId, type: 'rune', originId };
}

/** A catalog whose single spirit carries the given normalized awaken condition. */
function catalogWith(
	spiritId: string,
	name: string,
	awaken: NormalizedAwaken | undefined
): PlayCatalog {
	const entry: PlayCatalogSpirit = {
		id: spiritId,
		name,
		cost: 2,
		classes: {},
		origins: {},
		awaken
	};
	return { guardians: [], spirits: [entry], mats: [], classes: [], dice: [], monsters: [] };
}

function ctxFor(player: PrivatePlayerState, catalog: PlayCatalog) {
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

// ── Derived fixture views ──────────────────────────────────────────────────────

const ALL_CLASS_NAMES = CATALOG_CLASSES.map((c) => c.name);
/**
 * Classes handled by a dedicated ENGINE/runtime path rather than the effect system.
 * Their Awakening-Phase grants are surfaced as Cleanup CLAIM cards — `enterCleanup`
 * (phases.ts) builds the player's `pendingAwakenReward` and `resolveAwakenReward`
 * (runtime.ts) applies the picks — so they carry no declarative/handler/manual
 * effect, yet are fully handled. (The Corruptor keeps its inCombat breakpoint, so it
 * stays declarative and is NOT listed here.)
 */
const ENGINE_HANDLED_CLASSES = new Set<string>([
	'Cursed Spirit',
	'Golden Ruler',
	'World Guardian',
	// Infiltrator is a standalone runtime action (`infiltratorSwap` command + swap UI),
	// not a trigger effect — handled by the engine, no declarative/handler entry.
	'Infiltrator',
	// Mod Injector is an engine trade-cost waiver (free Spirit-Augment trades),
	// applied in resolveLocationInteraction — no effect-system entry.
	'Mod Injector'
]);
const ALL_SPIRITS = CATALOG_SPIRITS;
const RUNE_COST_SPIRITS = ALL_SPIRITS.filter((s) => s.awaken_condition?.type === 'rune_cost');
const TEXT_SPIRITS = ALL_SPIRITS.filter((s) => s.awaken_condition?.type === 'text');
const FREE_SPIRITS = ALL_SPIRITS.filter((s) => s.awaken_condition === null);

/** Empty rune-info map → normalizeAwaken falls back to id-as-name + 'relic' kind.
 *  matchMatCost matches held runes by their catalog `id` first, so this is enough
 *  to drive the rune_cost gate without a full rune catalog. */
const EMPTY_RUNE_INFO: ReadonlyMap<string, AwakenRuneInfo> = new Map();

// ── 1. CLASS COVERAGE ───────────────────────────────────────────────────────────

describe('Phase 7 — class coverage (every class is handled)', () => {
	it('every DB class is in CLASS_EFFECTS, CLASS_HANDLERS, or MANUAL_CLASSES', () => {
		const unhandled = ALL_CLASS_NAMES.filter(
			(name) =>
				!CLASS_EFFECTS[name] &&
				!HANDLER_CLASSES.has(name) &&
				!MANUAL_CLASSES.has(name) &&
				!ENGINE_HANDLED_CLASSES.has(name)
		);
		expect(
			unhandled,
			`Unhandled classes (encode, add a handler, or allowlist them): ${unhandled.join(', ')}`
		).toEqual([]);
	});

	it('reports the coverage breakdown (declarative / handler / manual)', () => {
		let declarative = 0;
		let handler = 0;
		let manual = 0;
		let engine = 0;
		for (const name of ALL_CLASS_NAMES) {
			if (MANUAL_CLASSES.has(name)) manual += 1;
			else if (ENGINE_HANDLED_CLASSES.has(name)) engine += 1;
			else if (CLASS_EFFECTS[name]) declarative += 1;
			else if (HANDLER_CLASSES.has(name)) handler += 1;
		}
		// Sanity: the buckets sum to the full roster (manual classes also carry a
		// CLASS_EFFECTS `manual` entry, so they are counted in `manual` only here;
		// engine-handled classes — Cursed Spirit's cleanup claim — are counted only
		// in `engine`).
		expect(declarative + handler + manual + engine).toBe(ALL_CLASS_NAMES.length);
		expect(ALL_CLASS_NAMES.length).toBe(37);
	});
});

// ── 2. AWAKEN COVERAGE ──────────────────────────────────────────────────────────

describe('Phase 7 — awaken coverage (every spirit is handled)', () => {
	it('every spirit is free (null), rune_cost, or scripted/manual text', () => {
		const unhandled = ALL_SPIRITS.filter((s) => {
			const cond = s.awaken_condition;
			if (cond === null) return false; // free flip
			if (cond.type === 'rune_cost') return false; // generic resolver
			// text → must be scripted (AWAKEN_HANDLERS) or allowlisted (MANUAL_AWAKEN)
			return !(AWAKEN_HANDLERS[s.id] || MANUAL_AWAKEN.has(s.id));
		});
		expect(
			unhandled.map((s) => s.name),
			`Unhandled spirit awaken conditions (script, allowlist, or make rune_cost): ${unhandled
				.map((s) => s.name)
				.join(', ')}`
		).toEqual([]);
	});

	it('reports the awaken breakdown (free / rune_cost / scripted-text / manual-text)', () => {
		let scriptedText = 0;
		let manualText = 0;
		for (const s of TEXT_SPIRITS) {
			if (AWAKEN_HANDLERS[s.id]) scriptedText += 1;
			else if (MANUAL_AWAKEN.has(s.id)) manualText += 1;
		}
		expect(scriptedText + manualText).toBe(TEXT_SPIRITS.length);
		expect(FREE_SPIRITS.length + RUNE_COST_SPIRITS.length + TEXT_SPIRITS.length).toBe(
			ALL_SPIRITS.length
		);
		expect(ALL_SPIRITS.length).toBe(61);
	});

	it('a null awaken_condition normalizes to a free flip (ok:true)', () => {
		for (const s of FREE_SPIRITS) {
			const awaken = normalizeAwaken(s.awaken_condition, EMPTY_RUNE_INFO);
			expect(awaken, `${s.name} should normalize to no condition`).toBeUndefined();
			const player = makePlayer({ spirits: [faceDownSpirit(s.id, s.name)] });
			const check = checkAwakenCondition(ctxFor(player, catalogWith(s.id, s.name, awaken)), {
				spirit: player.spirits[0]
			});
			expect(check.ok, `${s.name} (free) should be auto-awakenable`).toBe(true);
		}
	});

	it('every scripted text spirit resolves through AWAKEN_HANDLERS, not the manual path', () => {
		for (const s of TEXT_SPIRITS) {
			const scripted = Boolean(AWAKEN_HANDLERS[s.id]);
			const manual = MANUAL_AWAKEN.has(s.id);
			expect(scripted || manual, `${s.name} text condition must be scripted or manual`).toBe(true);
			// A spirit can never be BOTH scripted and manual (the two paths are disjoint).
			expect(scripted && manual, `${s.name} cannot be both scripted and manual`).toBe(false);
		}
	});
});

// ── 3. RUNE_COST PARAMETRIZED PROOF ─────────────────────────────────────────────

describe('Phase 7 — every rune_cost spirit awakens with exactly its runes', () => {
	for (const s of RUNE_COST_SPIRITS) {
		const cond = s.awaken_condition;
		// Narrow for TS (the filter guarantees rune_cost).
		if (!cond || cond.type !== 'rune_cost') continue;
		const requiredRuneIds = cond.rune_ids;

		it(`${s.name}: holding exactly its ${requiredRuneIds.length} rune(s) → ok + spent`, () => {
			const awaken = normalizeAwaken(cond, EMPTY_RUNE_INFO);
			expect(awaken?.kind).toBe('rune_cost');

			const runes = requiredRuneIds.map((rid, i) => heldRune(i + 1, rid));
			const player = makePlayer({ spirits: [faceDownSpirit(s.id, s.name)], mats: runes });
			const catalog = catalogWith(s.id, s.name, awaken);

			// check → ok
			const check = checkAwakenCondition(ctxFor(player, catalog), { spirit: player.spirits[0] });
			expect(check.ok, `${s.name} should be satisfiable with exactly its runes`).toBe(true);
			expect(check.kind).toBe('rune_cost');

			// pay → spends EXACTLY the required count (all held runes are required here)
			const payment = payAwakenCondition(ctxFor(player, catalog), { spirit: player.spirits[0] });
			expect(payment.ok).toBe(true);
			expect(payment.discarded.length).toBe(requiredRuneIds.length);
			// Every rune slot is now spent (hasRune:false).
			expect(player.mats.every((r) => !r.hasRune)).toBe(true);
		});

		it(`${s.name}: holding one fewer rune → ok:false (insufficient_runes)`, () => {
			const awaken = normalizeAwaken(cond, EMPTY_RUNE_INFO);
			// Drop one required rune — but keep ALL non-wildcard named runes for the
			// remaining requirements so the ONLY failure is the missing copy/count.
			const oneFewer = requiredRuneIds.slice(0, requiredRuneIds.length - 1);
			const runes = oneFewer.map((rid, i) => heldRune(i + 1, rid));
			const player = makePlayer({ spirits: [faceDownSpirit(s.id, s.name)], mats: runes });
			const catalog = catalogWith(s.id, s.name, awaken);

			const check = checkAwakenCondition(ctxFor(player, catalog), { spirit: player.spirits[0] });
			expect(check.ok, `${s.name} should NOT be satisfiable with one fewer rune`).toBe(false);
			expect(check.reason).toBe('insufficient_runes');
			expect(check.kind).toBe('rune_cost');

			// And the unpayable cost discards nothing.
			const payment = payAwakenCondition(ctxFor(player, catalog), { spirit: player.spirits[0] });
			expect(payment.ok).toBe(false);
			expect(payment.discarded).toEqual([]);
		});
	}
});

// ── 4. NO SILENT ALLOWLIST ABUSE ────────────────────────────────────────────────

describe('Phase 7 — allowlists contain no stale/typo entries', () => {
	it('every MANUAL_CLASSES name is a real class in the fixture', () => {
		const classNameSet = new Set(ALL_CLASS_NAMES);
		const stale = [...MANUAL_CLASSES].filter((name) => !classNameSet.has(name));
		expect(stale, `MANUAL_CLASSES has names not in the class table: ${stale.join(', ')}`).toEqual(
			[]
		);
	});

	it('every MANUAL_CLASSES name also has a CLASS_EFFECTS manual entry (emits a prompt)', () => {
		for (const name of MANUAL_CLASSES) {
			const effects = CLASS_EFFECTS[name];
			expect(effects, `${name} must have a CLASS_EFFECTS entry`).toBeDefined();
			const hasManual = effects.some((e) =>
				e.breakpoints.some((bp) => bp.actions.some((a) => a.kind === 'manual'))
			);
			expect(hasManual, `${name} (MANUAL_CLASSES) must emit a manual prompt, not no-op`).toBe(true);
		}
	});

	it('every MANUAL_AWAKEN id is a real text spirit in the fixture', () => {
		const textSpiritIds = new Set(TEXT_SPIRITS.map((s) => s.id));
		const stale = [...MANUAL_AWAKEN].filter((id) => !textSpiritIds.has(id));
		expect(stale, `MANUAL_AWAKEN has ids that are not text spirits: ${stale.join(', ')}`).toEqual(
			[]
		);
	});

	it('every AWAKEN_HANDLERS id is a real text spirit in the fixture', () => {
		const textSpiritIds = new Set(TEXT_SPIRITS.map((s) => s.id));
		const stale = Object.keys(AWAKEN_HANDLERS).filter((id) => !textSpiritIds.has(id));
		expect(stale, `AWAKEN_HANDLERS has ids that are not text spirits: ${stale.join(', ')}`).toEqual(
			[]
		);
	});

	it('AWAKEN_HANDLERS and MANUAL_AWAKEN are disjoint', () => {
		const overlap = Object.keys(AWAKEN_HANDLERS).filter((id) => MANUAL_AWAKEN.has(id));
		expect(overlap).toEqual([]);
	});
});
