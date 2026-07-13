import { describe, expect, test } from 'vitest';
import type { GameLocationRewardRow, MatSlotSnapshot } from '$lib/types';
import {
	buildLocationInteractions,
	canAfford,
	eligibleCostSlots,
	locationCostRequiresSelection,
	matchRewardCost,
	meaningFor,
	type CostRequirement
} from './locationInteractions';

// Real reward-row icon ids + origin ids — mirror the live DB content
// (`arc_spirits_assets` reward-row model: game_location_rows + reward_row_assignments,
// re-synced 2026-06-17). Reward rows are read live from the DB at runtime; these
// fixtures encode the current map so the tests guard that every row resolves.
const SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const ABYSS = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const REST = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const CULTIVATE = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const BARRIER = '6746f875-a1bc-453c-94b5-718d6ebeb025';
const AVATAR_BARRIER = '16daf8be-6ae0-4ace-b70c-cbb30e357664';
const ANY_RELIC = '6a85e06a-52cc-483c-aa59-38395a377307';
const ANY_RUNE = '36aab6c9-b98c-4e84-b097-e743f45dde82';
// Origin-rune reward tokens + their origin ids.
const TIDAL = '4d34484d-4345-448d-b192-a425841ddbc4';
const MOON_TIDE_ORIGIN = '294cee31-a7ac-4292-9b61-d4293c05c146';
const CYBER = '87d1f1ad-9c0a-4a65-bb2b-16acebc2d019';
const CYBER_ORIGIN = 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e';
const FOREST = '8dd2b283-122b-4965-9184-f1f84e1216f4';
const FLORAL_ORIGIN = 'ad555f03-9b89-4a71-a47c-464fd67d2c05';
const LANTERN = '7248cdca-9b03-4951-bfba-a4d17f7b97c8';
const LANTERN_ORIGIN = '178449e9-cc6b-45ab-8522-5183fe1d9307';
// Special / named runes. Class-linked ones (Sorcerer/Strategist/Swordsman/Support/
// Animal/Cursed Spirit) are spirit AUGMENTS; named ones (Teapot/Magnet/Flower/
// Firecracker) are class-less relics.
const TEAPOT = 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6';
const MAGNET = 'ca4df196-67fb-4507-973d-1dfac277953d';
const FLOWER = '75134075-3347-49de-a740-eb99d20b1f1a';
const FIRECRACKER = '895144a1-e0f6-4bdc-a4db-322423f1b922';
const SORCERER = 'c9b3225f-c8a9-4aa8-8e43-56c39cf68974';
const STRATEGIST = '88facdb6-3374-4891-af8a-fca2e81b79ef';
const SWORDSMAN = 'de816c21-aa17-4e41-9217-20511c11e9c9';
const SUPPORT = '66525fe8-e375-4473-b1c3-88d3c9fd2b1c';
const ANIMAL = '40934631-35fc-4936-943a-c607a9c607be';
const CURSED_SPIRIT = 'faa39f61-98ec-4f63-a873-766dc4e111f3';

// ── Live location reward rows (new model, slot order, 2026-06-17) ───────────────
const CYBER_CITY_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [SUMMON, ABYSS] },
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [{ kind: 'or', icon_ids: [SORCERER, STRATEGIST] }] },
	{ type: 'trade', cost_icon_ids: [CYBER, CYBER], gain_icon_ids: [MAGNET, BARRIER, BARRIER] }
];

const FLORAL_PATCH_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [AVATAR_BARRIER, AVATAR_BARRIER, AVATAR_BARRIER] },
	{ type: 'trade', cost_icon_ids: [FOREST, FOREST], gain_icon_ids: [FLOWER, BARRIER, BARRIER] },
	{ type: 'gain', gain_icon_ids: [REST] }
];

const LANTERN_CANYON_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RUNE], gain_icon_ids: [CURSED_SPIRIT] },
	{ type: 'gain', gain_icon_ids: [CULTIVATE, BARRIER] },
	{ type: 'trade', cost_icon_ids: [LANTERN, LANTERN], gain_icon_ids: [FIRECRACKER, BARRIER, BARRIER] }
];

const TIDAL_COVE_ROWS: GameLocationRewardRow[] = [
	{ type: 'gain', gain_icon_ids: [SUMMON] },
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [{ kind: 'or', icon_ids: [SWORDSMAN, SUPPORT, ANIMAL] }] },
	{ type: 'trade', cost_icon_ids: [TIDAL, TIDAL], gain_icon_ids: [TEAPOT, BARRIER, BARRIER] }
];

const LIVE_LOCATIONS: Record<string, GameLocationRewardRow[]> = {
	'Cyber City': CYBER_CITY_ROWS,
	'Floral Patch': FLORAL_PATCH_ROWS,
	'Lantern Canyon': LANTERN_CANYON_ROWS,
	'Tidal Cove': TIDAL_COVE_ROWS
};

function rune(partial: Partial<MatSlotSnapshot>): MatSlotSnapshot {
	return { slotIndex: 1, hasRune: true, ...partial };
}

describe('meaningFor', () => {
	test('classifies action / heal / wildcard / origin / special icons', () => {
		expect(meaningFor(SUMMON)).toMatchObject({ kind: 'action', action: 'spiritWorldSummon' });
		expect(meaningFor(ABYSS)).toMatchObject({ kind: 'action', action: 'abyssSummon' });
		expect(meaningFor(REST)).toMatchObject({ kind: 'action', action: 'rest' });
		expect(meaningFor(CULTIVATE)).toMatchObject({ kind: 'action', action: 'cultivate' });
		expect(meaningFor(BARRIER)).toMatchObject({ kind: 'restoreBarrier' });
		expect(meaningFor(AVATAR_BARRIER)).toMatchObject({ kind: 'restoreBarrier' });
		expect(meaningFor(ANY_RELIC)).toMatchObject({ kind: 'wildcardRelic' });
		expect(meaningFor(ANY_RUNE)).toMatchObject({ kind: 'anyRune' });
		expect(meaningFor(TIDAL)).toMatchObject({ kind: 'originRune', originId: MOON_TIDE_ORIGIN });
		expect(meaningFor(FOREST)).toMatchObject({ kind: 'originRune', originId: FLORAL_ORIGIN });
		expect(meaningFor(LANTERN)).toMatchObject({ kind: 'originRune', originId: LANTERN_ORIGIN });
		expect(meaningFor(CYBER)).toMatchObject({ kind: 'originRune', originId: CYBER_ORIGIN });
		expect(meaningFor(TEAPOT)).toMatchObject({ kind: 'specialRune', runeName: 'Teapot' });
		expect(meaningFor(SWORDSMAN)).toMatchObject({ kind: 'specialRune', runeName: 'Swordsman' });
		expect(meaningFor(CURSED_SPIRIT)).toMatchObject({ kind: 'specialRune', runeName: 'Cursed Spirit' });
	});

	test('returns null for an unknown icon id', () => {
		expect(meaningFor('not-a-real-icon')).toBeNull();
	});
});

describe('buildLocationInteractions — live map', () => {
	test('every current reward row resolves (no silently-dropped interactions)', () => {
		for (const [name, rows] of Object.entries(LIVE_LOCATIONS)) {
			const nonText = rows.filter((r) => r.type !== 'text');
			const interactions = buildLocationInteractions(rows);
			expect(interactions, `${name}: every non-text row must resolve`).toHaveLength(nonText.length);
			for (const it of interactions) {
				expect(it.gains.length, `${name} row ${it.rowIndex} must grant something`).toBeGreaterThan(0);
				if (it.kind === 'trade') {
					expect(
						it.cost.length,
						`${name} row ${it.rowIndex} trade must resolve a cost`
					).toBeGreaterThan(0);
				}
			}
		}
	});

	test('Tidal Cove: free summon, a "various augments" choice, and a Moon-Tide trade', () => {
		const interactions = buildLocationInteractions(TIDAL_COVE_ROWS);
		expect(interactions).toHaveLength(3);

		// Row 0: free Spirit World Summon.
		expect(interactions[0]).toMatchObject({ rowIndex: 0, kind: 'gain', cost: [] });
		expect(interactions[0].gains).toEqual([{ type: 'action', action: 'spiritWorldSummon' }]);

		// Row 1: pay any relic → choose one of three AUGMENTS (Swordsman / Support /
		// Animal). Each is a class-linked special, so it resolves to a spirit augment.
		expect(interactions[1].cost).toEqual([expect.objectContaining({ match: 'anyRelic' })]);
		const choose = interactions[1].gains[0];
		expect(choose.type).toBe('chooseRune');
		if (choose.type === 'chooseRune') {
			expect(choose.options.map((o) => o.name)).toEqual(['Swordsman', 'Support', 'Animal']);
			expect(choose.options.every((o) => o.type === 'augment')).toBe(true);
			expect(choose.options.every((o) => o.special && o.classId != null)).toBe(true);
		}

		// Row 2: pay 2 Moon Tide runes → a Teapot relic + 2 heal.
		expect(interactions[2].cost).toEqual([
			expect.objectContaining({ match: 'origin', originId: MOON_TIDE_ORIGIN }),
			expect.objectContaining({ match: 'origin', originId: MOON_TIDE_ORIGIN })
		]);
		expect(interactions[2].gains).toEqual([
			{ type: 'rune', rune: expect.objectContaining({ name: 'Teapot', special: true, type: 'relic' }) },
			{ type: 'restoreBarrier', amount: 1 },
			{ type: 'restoreBarrier', amount: 1 }
		]);
	});

	test('Cyber City: a Summon+Abyss trade, an "or" augment choice, and a Cyber trade', () => {
		const interactions = buildLocationInteractions(CYBER_CITY_ROWS);
		expect(interactions).toHaveLength(3);

		expect(interactions[0].gains).toEqual([
			{ type: 'action', action: 'spiritWorldSummon' },
			{ type: 'action', action: 'abyssSummon' }
		]);

		const choose = interactions[1].gains[0];
		expect(choose.type).toBe('chooseRune');
		if (choose.type === 'chooseRune') {
			expect(choose.options.map((o) => o.name)).toEqual(['Sorcerer', 'Strategist']);
			expect(choose.options.every((o) => o.type === 'augment')).toBe(true);
		}

		expect(interactions[2].cost).toEqual([
			expect.objectContaining({ match: 'origin', originId: CYBER_ORIGIN }),
			expect.objectContaining({ match: 'origin', originId: CYBER_ORIGIN })
		]);
		expect(interactions[2].gains[0]).toMatchObject({ type: 'rune', rune: { name: 'Magnet' } });
	});

	test('Lantern Canyon: an any-basic-rune trade for a Cursed Spirit augment', () => {
		const interactions = buildLocationInteractions(LANTERN_CANYON_ROWS);
		expect(interactions).toHaveLength(3);

		// Row 0: pay any one basic (origin) rune → a Cursed Spirit augment.
		expect(interactions[0].kind).toBe('trade');
		expect(interactions[0].cost).toEqual([expect.objectContaining({ match: 'anyBasic' })]);
		expect(interactions[0].gains).toEqual([
			{
				type: 'rune',
				rune: expect.objectContaining({ name: 'Cursed Spirit', special: true, type: 'augment' })
			}
		]);

		// Row 1: free Cultivate + restore 1 health.
		expect(interactions[1].gains).toEqual([
			{ type: 'action', action: 'cultivate' },
			{ type: 'restoreBarrier', amount: 1 }
		]);
		// Row 2: pay 2 Lantern Lights → Firecracker relic + 2 heal.
		expect(interactions[2].cost).toEqual([
			expect.objectContaining({ match: 'origin', originId: LANTERN_ORIGIN }),
			expect.objectContaining({ match: 'origin', originId: LANTERN_ORIGIN })
		]);
		expect(interactions[2].gains[0]).toMatchObject({ type: 'rune', rune: { name: 'Firecracker' } });
	});

	test('Floral Patch: heal trade, forest trade, and free Rest', () => {
		const interactions = buildLocationInteractions(FLORAL_PATCH_ROWS);
		expect(interactions).toHaveLength(3);
		expect(interactions[0].gains).toEqual([
			{ type: 'restoreBarrier', amount: 1 },
			{ type: 'restoreBarrier', amount: 1 },
			{ type: 'restoreBarrier', amount: 1 }
		]);
		expect(interactions[1].gains[0]).toMatchObject({ type: 'rune', rune: { name: 'Flower' } });
		expect(interactions[2].gains).toEqual([{ type: 'action', action: 'rest' }]);
	});

	test('text rows and fully-unresolvable rows are skipped', () => {
		const rows: GameLocationRewardRow[] = [
			{ type: 'text', text: 'Flavor only' },
			{ type: 'gain', gain_icon_ids: ['unknown-icon'] },
			{ type: 'gain', gain_icon_ids: [BARRIER] }
		];
		const interactions = buildLocationInteractions(rows);
		expect(interactions).toHaveLength(1);
		expect(interactions[0].rowIndex).toBe(2);
	});

	test('handles null/empty reward rows', () => {
		expect(buildLocationInteractions(null)).toEqual([]);
		expect(buildLocationInteractions([])).toEqual([]);
	});

	test('the Arcane Abyss location row resolves to a free abyssSummon action', () => {
		// The Abyss summon moved off monster reward tracks into a permanent location
		// interaction (a free "gain" row) on the Arcane Abyss.
		const interactions = buildLocationInteractions([{ type: 'gain', gain_icon_ids: [ABYSS] }]);
		expect(interactions).toHaveLength(1);
		expect(interactions[0].kind).toBe('gain');
		expect(interactions[0].cost).toEqual([]);
		expect(interactions[0].gains).toEqual([{ type: 'action', action: 'abyssSummon' }]);
	});
});

describe('matchRewardCost / canAfford', () => {
	const tidalTrade = buildLocationInteractions(TIDAL_COVE_ROWS)[2]; // 2× Moon Tide origin
	const anyRelicTrade = buildLocationInteractions(CYBER_CITY_ROWS)[0]; // pay any relic
	const anyBasicTrade = buildLocationInteractions(LANTERN_CANYON_ROWS)[0]; // pay any basic rune

	test('origin cost matches by originId', () => {
		const runes = [rune({ originId: MOON_TIDE_ORIGIN }), rune({ originId: MOON_TIDE_ORIGIN })];
		const match = matchRewardCost(tidalTrade.cost, runes);
		expect(match.ok).toBe(true);
		expect(match.consumedArrayIndexes.sort()).toEqual([0, 1]);
		expect(canAfford(tidalTrade, runes)).toBe(true);
	});

	test('origin cost matches by cultivate name fallback ("<Origin> Rune")', () => {
		const runes = [rune({ name: 'Moon Tide Rune' }), rune({ name: 'Moon Tide Rune' })];
		expect(canAfford(tidalTrade, runes)).toBe(true);
	});

	test('origin cost fails when too few matching runes are held', () => {
		expect(canAfford(tidalTrade, [rune({ originId: MOON_TIDE_ORIGIN })])).toBe(false);
		expect(
			canAfford(tidalTrade, [rune({ name: 'Fairy Relic', type: 'relic' }), rune({ originId: CYBER_ORIGIN })])
		).toBe(false);
	});

	test('Any-Relic cost accepts ONLY relics — never runes, augments, or class items', () => {
		// A held relic (e.g. the starting Fairy Relic) pays the cost.
		expect(canAfford(anyRelicTrade, [rune({ name: 'Fairy Relic', type: 'relic' })])).toBe(true);
		// Runes/augments/class items NEVER pay a relic cost — kind is strict.
		expect(canAfford(anyRelicTrade, [rune({ type: 'augment' })])).toBe(false);
		expect(canAfford(anyRelicTrade, [rune({ classId: 'some-class' })])).toBe(false);
		expect(canAfford(anyRelicTrade, [rune({ special: true })])).toBe(false);
		expect(canAfford(anyRelicTrade, [rune({ type: 'rune' })])).toBe(false);
		expect(canAfford(anyRelicTrade, [rune({ originId: MOON_TIDE_ORIGIN })])).toBe(false);
	});

	test('Any-Basic cost accepts any origin rune, not specials or relics', () => {
		expect(canAfford(anyBasicTrade, [rune({ originId: MOON_TIDE_ORIGIN })])).toBe(true);
		expect(canAfford(anyBasicTrade, [rune({ originId: CYBER_ORIGIN })])).toBe(true);
		// Specials, augments and relics are NOT basic runes.
		expect(canAfford(anyBasicTrade, [rune({ special: true })])).toBe(false);
		expect(canAfford(anyBasicTrade, [rune({ type: 'augment' })])).toBe(false);
		expect(canAfford(anyBasicTrade, [rune({ name: 'Fairy Relic', type: 'relic' })])).toBe(false);
		// Nothing held → can't pay.
		expect(canAfford(anyBasicTrade, [])).toBe(false);
	});

	test('only relics with hasRune are spendable', () => {
		expect(canAfford(anyRelicTrade, [rune({ type: 'relic', hasRune: false })])).toBe(false);
	});

	test('a wildcard never steals a rune a specific requirement needs', () => {
		const cost: CostRequirement[] = [
			{ match: 'origin', originId: MOON_TIDE_ORIGIN, originName: 'Moon Tide', label: 'Moon Tide' },
			{ match: 'anyRelic', label: 'Any relic' }
		];
		const ok = matchRewardCost(cost, [rune({ type: 'relic' }), rune({ originId: MOON_TIDE_ORIGIN })]);
		expect(ok.ok).toBe(true);
		expect(ok.consumedArrayIndexes.sort()).toEqual([0, 1]);
		const bad = matchRewardCost(cost, [rune({ originId: MOON_TIDE_ORIGIN })]);
		expect(bad.ok).toBe(false);
	});

	test('empty cost is always affordable', () => {
		expect(matchRewardCost([], []).ok).toBe(true);
	});
});

describe('matchRewardCost — player discard choice for wildcard costs', () => {
	const anyRelicTrade = buildLocationInteractions(CYBER_CITY_ROWS)[0]; // pay any relic

	test('honors the chosen held-slot index for a wildcard cost', () => {
		const runes = [
			rune({ name: 'Fairy Relic', type: 'relic' }), // 0
			rune({ name: 'Teapot Relic', type: 'relic' }), // 1
			rune({ name: 'Flower Relic', type: 'relic' }) // 2
		];
		// No preference → first eligible (auto-pick, unchanged behavior).
		expect(matchRewardCost(anyRelicTrade.cost, runes).consumedArrayIndexes).toEqual([0]);
		// Explicit pick discards the chosen one instead.
		expect(matchRewardCost(anyRelicTrade.cost, runes, [2]).consumedArrayIndexes).toEqual([2]);
	});

	test('ignores an invalid pick and falls back to auto-pick', () => {
		const runes = [rune({ type: 'rune' }), rune({ name: 'Fairy Relic', type: 'relic' })]; // relic at 1
		// Index 0 is a basic rune, not a relic → not valid for anyRelic → use the real relic.
		expect(matchRewardCost(anyRelicTrade.cost, runes, [0]).consumedArrayIndexes).toEqual([1]);
		// Out-of-range pick is ignored too.
		expect(matchRewardCost(anyRelicTrade.cost, runes, [99]).consumedArrayIndexes).toEqual([1]);
	});

	test('eligibleCostSlots lists every held slot that can pay the wildcard', () => {
		const runes = [
			rune({ name: 'Fairy Relic', type: 'relic' }), // 0 ✓
			rune({ originId: MOON_TIDE_ORIGIN }), // 1 ✗ not a relic
			rune({ name: 'Teapot Relic', type: 'relic' }), // 2 ✓
			rune({ type: 'relic', hasRune: false }) // 3 ✗ already spent
		];
		expect(eligibleCostSlots(anyRelicTrade.cost[0], runes)).toEqual([0, 2]);
	});

	test('opens a picker only for surplus, materially different wildcard payments', () => {
		const anyRelic = anyRelicTrade.cost;
		expect(
			locationCostRequiresSelection(anyRelic, [
				rune({ id: 'flower', name: 'Flower', type: 'relic' }),
				rune({ id: 'teapot', name: 'Teapot', type: 'relic' })
			])
		).toBe(true);
		expect(
			locationCostRequiresSelection(anyRelic, [
				rune({ id: 'flower', name: 'Flower', type: 'relic' })
			])
		).toBe(false);
		expect(
			locationCostRequiresSelection(anyRelic, [
				rune({ id: 'flower', name: 'Flower', type: 'relic' }),
				rune({ id: 'flower', name: 'Flower', type: 'relic' })
			])
		).toBe(false);

		const specific: CostRequirement[] = [
			{ match: 'specialRune', runeId: 'flower', runeName: 'Flower', label: 'Flower' }
		];
		expect(
			locationCostRequiresSelection(specific, [
				rune({ id: 'flower', name: 'Flower', type: 'relic' }),
				rune({ id: 'flower', name: 'Flower', type: 'relic' })
			])
		).toBe(false);
	});
});
