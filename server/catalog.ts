/**
 * PlayCatalog loader for the room server.
 *
 * REIMPLEMENTS `src/lib/play/server/catalog.ts` + the `fetchAssetsData` half of
 * `src/lib/supabase.ts`, which are SvelteKit-bound (`$env/static/public`). The pure
 * transform is a faithful port of `buildPlayCatalog` — kept structurally identical to
 * its source so the two stay easy to diff. The one genuinely shared pure helper,
 * `normalizeAwaken`, IS imported from the engine (it is `$lib`-free at runtime), so the
 * awaken-cost normalization is not duplicated.
 *
 * If `buildPlayCatalog` in the engine changes, update this port to match.
 */

import { normalizeAwaken, type AwakenRuneInfo } from '../src/lib/play/awakenConditions';
import type { PlayCatalog, PlayCatalogClass, PlayCatalogRune } from '../src/lib/play/types';
import type { AwakenCondition, GameLocationRewardRow } from '../src/lib/types';
import { getAssetsClient } from './supabase';

const CACHE_TTL_MS = 60_000;

// Table names — copied from the TABLES const in src/lib/supabase.ts.
const TABLES = {
	HEX_SPIRITS: 'hex_spirits',
	MAT_ITEMS: 'mat_items',
	MONSTERS: 'monsters_v2',
	GUARDIANS: 'guardians',
	CLASSES: 'classes',
	ORIGINS: 'origins',
	CUSTOM_DICE: 'custom_dice',
	DICE_SIDES: 'dice_sides',
	GAME_LOCATIONS: 'game_locations',
	GAME_LOCATION_ROWS: 'game_location_rows',
	REWARD_ROW_ASSIGNMENTS: 'reward_row_assignments',
	EDITIONS: 'editions'
} as const;

interface SpiritRow {
	id: string;
	name: string;
	cost: number;
	traits: { class_ids?: string[]; origin_ids?: string[] } | null;
	awaken_condition: AwakenCondition | null;
}
interface MatRow {
	id: string;
	name: string;
	origin_id: string | null;
}
interface DiceSideRow {
	id: string;
	dice_id: string;
	side_number: number;
	reward_value: string | null;
}
interface CustomDiceRow {
	id: string;
	name: string;
	dice_type: PlayCatalog['dice'][number]['diceType'];
}
interface MonsterRow {
	id: string;
	name: string;
	stage: number | string;
	order_num: number;
	damage: number | null;
	barrier: number | null;
	reward_track: unknown[] | null;
	dice_pool: unknown[] | null;
	choose_amount: number | null;
}
interface GuardianRow {
	id: string;
	name: string;
	origin_id: string | null;
}
interface NamedRow {
	id: string;
	name: string;
	position: number;
	class_type?: string | null;
	is_special?: boolean | null;
	effect_schema?: unknown;
}
interface LocationRow {
	id: string;
	name: string;
	origin_id: string | null;
}
interface EditionRow {
	name: string;
	is_default: boolean;
	cost_duplicates: Record<string, number> | null;
}

function matKind(mat: { origin_id: string | null }): PlayCatalogRune['kind'] {
	return mat.origin_id ? 'rune' : 'relic';
}

function countRolesByName(ids: string[], names: Map<string, string>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const id of ids) {
		const name = names.get(id) ?? id;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

let cached: PlayCatalog | null = null;
let cachedAt = 0;

/** Load + build the PlayCatalog from the assets schema. 60s in-process cache. */
export async function loadCatalog(): Promise<PlayCatalog> {
	const now = Date.now();
	if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

	// Offline/dev override: load a canned PlayCatalog JSON (e.g. ml/catalog.json, the
	// same fixture the ML tooling replays) instead of fetching the assets schema.
	// Lets the room server run against a local store with no Supabase reachability —
	// used by the authority smoke's local PostgREST emulator.
	const fileOverride = process.env.ARC_WS_CATALOG_FILE;
	if (fileOverride) {
		const { readFileSync } = await import('node:fs');
		cached = JSON.parse(readFileSync(fileOverride, 'utf8')) as PlayCatalog;
		cachedAt = now;
		return cached;
	}

	const db = getAssetsClient();
	const [
		spiritsRes,
		matsRes,
		diceRes,
		diceSidesRes,
		monstersRes,
		guardiansRes,
		classesRes,
		originsRes,
		editionsRes,
		locationsRes,
		assignmentsRes,
		locationRowsRes
	] = await Promise.all([
		db.from(TABLES.HEX_SPIRITS).select('id, name, cost, traits, awaken_condition'),
		db.from(TABLES.MAT_ITEMS).select('id, name, origin_id'),
		db.from(TABLES.CUSTOM_DICE).select('id, name, dice_type'),
		db.from(TABLES.DICE_SIDES).select('id, dice_id, side_number, reward_value'),
		db
			.from(TABLES.MONSTERS)
			.select(
				'id, name, stage, order_num, damage, barrier, reward_track, dice_pool, choose_amount'
			),
		db.from(TABLES.GUARDIANS).select('id, name, origin_id'),
		db.from(TABLES.CLASSES).select('id, name, position, class_type, is_special, effect_schema'),
		db.from(TABLES.ORIGINS).select('id, name, position'),
		db.from(TABLES.EDITIONS).select('name, is_default, cost_duplicates'),
		db.from(TABLES.GAME_LOCATIONS).select('id, name, origin_id'),
		db.from(TABLES.REWARD_ROW_ASSIGNMENTS).select('location_id, row_id, row_index'),
		db.from(TABLES.GAME_LOCATION_ROWS).select('id, config')
	]);

	for (const res of [
		spiritsRes,
		matsRes,
		diceRes,
		diceSidesRes,
		monstersRes,
		guardiansRes,
		classesRes,
		originsRes
	]) {
		if (res.error) throw new Error(`Catalog fetch failed: ${res.error.message}`);
	}

	const spirits = (spiritsRes.data as SpiritRow[] | null) ?? [];
	const mats = (matsRes.data as MatRow[] | null) ?? [];
	const customDice = (diceRes.data as CustomDiceRow[] | null) ?? [];
	const diceSides = (diceSidesRes.data as DiceSideRow[] | null) ?? [];
	const monsters = (monstersRes.data as MonsterRow[] | null) ?? [];
	const guardians = (guardiansRes.data as GuardianRow[] | null) ?? [];
	const classes = (classesRes.data as NamedRow[] | null) ?? [];
	const origins = (originsRes.data as NamedRow[] | null) ?? [];
	const editions = (editionsRes.data as EditionRow[] | null) ?? [];
	const rawLocations = (locationsRes.data as LocationRow[] | null) ?? [];
	const assignments =
		(assignmentsRes.data as { location_id: string; row_id: string; row_index: number | null }[]
			| null) ?? [];
	const locationRows = (locationRowsRes.data as { id: string; config: unknown }[] | null) ?? [];

	const sidesByDiceId = new Map<string, DiceSideRow[]>();
	for (const side of diceSides) {
		const list = sidesByDiceId.get(side.dice_id) ?? [];
		list.push(side);
		sidesByDiceId.set(side.dice_id, list);
	}

	// Reward rows: rebuild each location's ordered list from the assignment → row-config join.
	const rowConfigById = new Map<string, Record<string, unknown>>();
	for (const row of locationRows) {
		if (row.config && typeof row.config === 'object') {
			rowConfigById.set(row.id, row.config as Record<string, unknown>);
		}
	}
	const rewardRowsByLocation = new Map<string, GameLocationRewardRow[]>();
	for (const a of [...assignments].sort((x, y) => (x.row_index ?? 0) - (y.row_index ?? 0))) {
		const config = rowConfigById.get(a.row_id);
		if (!config) continue;
		const list = rewardRowsByLocation.get(a.location_id) ?? [];
		list.push(config as GameLocationRewardRow);
		rewardRowsByLocation.set(a.location_id, list);
	}

	// Complete edition is the canonical play set; fall back to default, then first.
	const playEdition =
		editions.find((e) => e.name?.toLowerCase() === 'complete') ??
		editions.find((e) => e.is_default) ??
		editions[0] ??
		null;

	// ── Pure transform: faithful port of buildPlayCatalog (src/lib/play/server/catalog.ts) ──
	const classNames = new Map(classes.map((c) => [c.id, c.name]));
	const originNames = new Map(origins.map((o) => [o.id, o.name]));
	const runesById = new Map<string, AwakenRuneInfo>(
		mats.map((mat) => [mat.id, { name: mat.name, kind: matKind(mat) }])
	);

	const catalog: PlayCatalog = {
		guardians: [...guardians]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((g) => ({ id: g.id, name: g.name, originId: g.origin_id })),
		spirits: [...spirits]
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
			.map((s) => ({
				id: s.id,
				name: s.name,
				cost: s.cost,
				classes: countRolesByName(s.traits?.class_ids ?? [], classNames),
				origins: countRolesByName(s.traits?.origin_ids ?? [], originNames),
				awaken: normalizeAwaken(s.awaken_condition, runesById)
			})),
		mats: [...mats]
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
			.map((mat) => ({ id: mat.id, name: mat.name, kind: matKind(mat), originId: mat.origin_id })),
		classes: [...classes]
			.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
			.map(
				(k): PlayCatalogClass => ({
					id: k.id,
					name: k.name,
					classType: k.class_type ?? null,
					isSpecial: k.is_special ?? false,
					effectSchema: (k.effect_schema ?? null) as PlayCatalogClass['effectSchema']
				})
			),
		dice: [
			...[...customDice]
				.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
				.map((die) => ({
					id: die.id,
					name: die.name,
					diceType: die.dice_type,
					sides: [...(sidesByDiceId.get(die.id) ?? [])]
						.sort((a, b) => a.side_number - b.side_number)
						.map((side) => {
							const value = Number.parseFloat((side.reward_value ?? '').trim());
							return Number.isFinite(value) ? value : 0;
						})
				})),
			{ id: 'defense_dice', name: 'Defense Dice', diceType: 'defense' as const, sides: [] }
		],
		monsters: [...monsters]
			.map((m) => ({
				id: m.id,
				name: m.name,
				damage: typeof m.damage === 'number' ? m.damage : 0,
				barrier: typeof m.barrier === 'number' ? m.barrier : 1,
				rewardTrack: Array.isArray(m.reward_track) ? (m.reward_track as string[]) : [],
				dicePool: Array.isArray(m.dice_pool) ? (m.dice_pool as string[]) : [],
				chooseAmount: typeof m.choose_amount === 'number' ? m.choose_amount : 2,
				stage: typeof m.stage === 'number' ? m.stage : Number(m.stage) || 1,
				order: typeof m.order_num === 'number' ? m.order_num : 0
			}))
			.sort((a, b) => a.stage - b.stage || a.order - b.order || a.name.localeCompare(b.name)),
		locations: [...rawLocations].map((loc) => ({
			name: loc.name,
			originId: loc.origin_id,
			rewardRows: rewardRowsByLocation.get(loc.id) ?? []
		})),
		costDuplicates: playEdition?.cost_duplicates ?? null
	};

	cached = catalog;
	cachedAt = now;
	return catalog;
}
