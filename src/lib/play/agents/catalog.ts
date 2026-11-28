/**
 * Offline PlayCatalog loaders for the agent harness (Node only). No network, no Supabase.
 *
 * - `loadFrozenCatalog()` reads the frozen `ml/catalog.json` (in the repo, stable: CI and tests).
 * - `loadLocalDesignCatalog(dir)` reads the local design JSON (`~/ArcSpiritsArt/game/*.json`,
 *   READ ONLY) and builds the catalog with the SAME transform as `buildPlayCatalog`
 *   (`src/lib/play/server/catalog.ts`) and its room-server port (`server/catalog.ts`). It is a
 *   third copy only because both originals are bound to a Supabase client; keep it identical to
 *   them. Two inputs have no local JSON copy, so they come from the frozen catalog, exactly as the
 *   local play-test proxy does: the rune/relic items (`mat_items`) and, for tables without their
 *   own `reward_rows` on the Arcane Abyss, its reward row (the four region rows come from code,
 *   `regionRules.regionRewardRows`).
 *
 * `catalogHash` is a sha256 of the canonical JSON of the built catalog, so a run records exactly
 * which card data it played.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeMonsterPools } from '../monsterPools';
import { LEGACY_RELIC_TOOL_VP, relicToolVpFromAbilities } from '../effects/relicTools';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeAwaken, type AwakenRuneInfo } from '../awakenConditions';
import { currentClassName } from '../classNames';
import { regionCatalog } from '../regionRules';
import { REGION_ORIGIN_NAMES } from '../regions';
import type { PlayCatalog, PlayCatalogClass } from '../types';

// The working tables are data/ in this repo (commands run from the repo root); the old location
// in the home folder is the fallback for a checkout made before 2026-11-16.
export const DEFAULT_LOCAL_CATALOG_DIR =
	process.env.ARC_DATA_DIR ??
	(existsSync(join(process.cwd(), 'data', 'hex_spirits.json'))
		? join(process.cwd(), 'data')
		: join(homedir(), 'ArcSpiritsArt', 'game'));

export function frozenCatalogPath(repoRoot = process.cwd()): string {
	return resolve(repoRoot, 'ml', 'catalog.json');
}

export function loadFrozenCatalog(repoRoot = process.cwd()): PlayCatalog {
	return regionCatalog(
		JSON.parse(readFileSync(frozenCatalogPath(repoRoot), 'utf8')) as PlayCatalog
	);
}

/** Canonical JSON (sorted keys) → sha256 hex. */
export function catalogHash(catalog: PlayCatalog): string {
	return createHash('sha256').update(stableStringify(catalog)).digest('hex');
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

type Row = Record<string, unknown>;

function readRows(dir: string, table: string): Row[] {
	const rows = JSON.parse(readFileSync(join(dir, `${table}.json`), 'utf8')) as Row[];
	// `local` marks design rows that are not in the database yet; the play-test proxy strips it.
	return rows.map(({ local: _local, ...rest }) => rest);
}

function countRolesByName(ids: string[], names: Map<string, string>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const id of ids) {
		const name = names.get(id) ?? id;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

export interface LoadedCatalog {
	catalog: PlayCatalog;
	source: 'frozen' | 'local-design';
	path: string;
	hash: string;
}

/** Build the PlayCatalog from the local design JSON (see the module comment). */
export function loadLocalDesignCatalog(
	dir = DEFAULT_LOCAL_CATALOG_DIR,
	repoRoot = process.cwd()
): PlayCatalog {
	const frozen = JSON.parse(readFileSync(frozenCatalogPath(repoRoot), 'utf8')) as PlayCatalog;
	const spirits = readRows(dir, 'hex_spirits');
	const classes = readRows(dir, 'classes');
	const origins = readRows(dir, 'origins');
	const monsters = readRows(dir, 'monsters_v2');
	const guardians = readRows(dir, 'guardians');
	const customDice = readRows(dir, 'custom_dice');
	const diceSides = readRows(dir, 'dice_sides');
	const locations = readRows(dir, 'game_locations');
	const editions = readRows(dir, 'editions');

	// mat_items: no local copy (see module comment). Same rename as the play-test proxy.
	const mats = frozen.mats.map((mat) =>
		mat.name === 'Teapot' ? { ...mat, name: 'Cleansing Teapot' } : mat
	);
	// The Arcane Abyss actions: the local table's own `reward_rows` when it has them (an empty list
	// means the Abyss has no action: Abyss Summons come from monster rewards only, 2026-11-20);
	// tables written before that carry no such field and keep the frozen catalog's free Abyss Summon.
	const frozenAbyssRows = frozen.locations?.find((loc) => loc.name === 'Arcane Abyss')?.rewardRows ?? [];
	const localAbyssRows = locations.find((loc) => String(loc.name) === 'Arcane Abyss')?.reward_rows;
	const abyssRows = Array.isArray(localAbyssRows) ? (localAbyssRows as typeof frozenAbyssRows) : frozenAbyssRows;

	const classNames = new Map(classes.map((c) => [String(c.id), currentClassName(String(c.name))]));
	const originNames = new Map(
		origins.map((o) => [String(o.id), REGION_ORIGIN_NAMES[String(o.id)] ?? String(o.name)])
	);
	const runesById = new Map<string, AwakenRuneInfo>(
		mats.map((mat) => [mat.id, { name: mat.name, kind: mat.kind }])
	);

	const sidesByDiceId = new Map<string, Row[]>();
	for (const side of diceSides) {
		const list = sidesByDiceId.get(String(side.dice_id)) ?? [];
		list.push(side);
		sidesByDiceId.set(String(side.dice_id), list);
	}
	const playEdition =
		editions.find((e) => String(e.name ?? '').toLowerCase() === 'complete') ??
		editions.find((e) => e.is_default) ??
		editions[0] ??
		null;

	const catalog: PlayCatalog = {
		guardians: [...guardians]
			.sort((a, b) => String(a.name).localeCompare(String(b.name)))
			.map((g) => ({
				id: String(g.id),
				name: String(g.name),
				originId: (g.origin_id as string | null) ?? null
			})),
		spirits: [...spirits]
			.sort(
				(a, b) =>
					String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
			)
			.map((s) => {
				const traits = (s.traits ?? {}) as { class_ids?: string[]; origin_ids?: string[] };
				return {
					id: String(s.id),
					name: String(s.name),
					cost: Number(s.cost),
					classes: countRolesByName(traits.class_ids ?? [], classNames),
					origins: countRolesByName(traits.origin_ids ?? [], originNames),
					awaken: normalizeAwaken(s.awaken_condition as never, runesById)
				};
			}),
		mats,
		classes: [...classes]
			.sort(
				(a, b) =>
					Number(a.position) - Number(b.position) || String(a.name).localeCompare(String(b.name))
			)
			.map(
				(k): PlayCatalogClass => ({
					id: String(k.id),
					name: currentClassName(String(k.name)),
					classType: (k.class_type as string | null) ?? null,
					isSpecial: (k.is_special as boolean | null) ?? false,
					effectSchema: (k.effect_schema ?? null) as PlayCatalogClass['effectSchema']
				})
			),
		dice: [
			...[...customDice]
				.sort(
					(a, b) =>
						String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
				)
				.map((die) => ({
					id: String(die.id),
					name: String(die.name),
					diceType: die.dice_type as PlayCatalog['dice'][number]['diceType'],
					sides: [...(sidesByDiceId.get(String(die.id)) ?? [])]
						.sort((a, b) => Number(a.side_number) - Number(b.side_number))
						.map((side) => {
							const value = Number.parseFloat(String(side.reward_value ?? '').trim());
							return Number.isFinite(value) ? value : 0;
						})
				})),
			{ id: 'defense_dice', name: 'Defense Dice', diceType: 'defense' as const, sides: [] }
		],
		monsters: [...monsters]
			.map((m) => ({
				id: String(m.id),
				name: String(m.name),
				damage: typeof m.damage === 'number' ? m.damage : 0,
				barrier: typeof m.barrier === 'number' ? m.barrier : 1,
				rewardTrack: Array.isArray(m.reward_track) ? (m.reward_track as string[]) : [],
				dicePool: Array.isArray(m.dice_pool) ? (m.dice_pool as string[]) : [],
				chooseAmount: typeof m.choose_amount === 'number' ? m.choose_amount : 2,
				stage: typeof m.stage === 'number' ? m.stage : Number(m.stage) || 1,
				order: typeof m.order_num === 'number' ? m.order_num : 0,
				// Optional: a monster with no initiative strikes first against everyone (as before).
				...(typeof m.initiative === 'number' ? { initiative: m.initiative } : {}),
				...(m.permanent === true ? { permanent: true } : {})
			}))
			.sort((a, b) => a.stage - b.stage || a.order - b.order || a.name.localeCompare(b.name)),
		locations: [...locations].map((loc) => ({
			name: String(loc.name),
			originId: (loc.origin_id as string | null) ?? null,
			rewardRows: String(loc.name) === 'Arcane Abyss' ? structuredClone(abyssRows) : []
		})),
		costDuplicates: (playEdition?.cost_duplicates as Record<string, number> | null) ?? null
	};
	// Relic tool VP from relics.json ability text ("You may gain N VP or …"). Written only when it
	// is not the legacy 2, so catalogs of the old data keep their hash (relicTools.relicToolVp).
	if (existsSync(join(dir, 'relics.json'))) {
		const vp = relicToolVpFromAbilities(readRows(dir, 'relics'));
		if (vp !== null && vp !== LEGACY_RELIC_TOOL_VP) catalog.relicToolVp = vp;
	}
	// Optional table: without it (or with no valid rows) the catalog and its hash are unchanged.
	if (existsSync(join(dir, 'monster_pools.json'))) {
		const pools = normalizeMonsterPools(readRows(dir, 'monster_pools'));
		if (pools.length) catalog.monsterPools = pools;
	}
	// One ruleset: a folder with a rules.json is the data of a balance test from before 27 November 2026 and
	// cannot be played by this engine (see docs/rules-history-2026-11.md; the last engine with switches is 0d96e29).
	if (existsSync(join(dir, 'rules.json')))
		throw new Error(`${join(dir, 'rules.json')}: this engine has one ruleset and reads no rule switches. This folder holds the rules of an older balance test; replay it with the archived engine.`);
	return regionCatalog(catalog);
}

/**
 * Resolve a `--catalog` argument: `frozen`, `local` (default design dir), or a directory /
 * PlayCatalog JSON file path. `local` falls back to `frozen` with a warning when the design dir
 * does not exist (CI).
 */
export function loadCatalogSpec(
	spec = 'local',
	repoRoot = process.cwd()
): LoadedCatalog & { warning?: string } {
	const finish = (
		catalog: PlayCatalog,
		source: LoadedCatalog['source'],
		path: string,
		warning?: string
	) => ({
		catalog,
		source,
		path,
		hash: catalogHash(catalog),
		...(warning ? { warning } : {})
	});
	if (spec === 'frozen')
		return finish(loadFrozenCatalog(repoRoot), 'frozen', frozenCatalogPath(repoRoot));
	if (spec === 'local') {
		if (!existsSync(join(DEFAULT_LOCAL_CATALOG_DIR, 'hex_spirits.json'))) {
			return finish(
				loadFrozenCatalog(repoRoot),
				'frozen',
				frozenCatalogPath(repoRoot),
				`local design catalog not found at ${DEFAULT_LOCAL_CATALOG_DIR}; using ml/catalog.json`
			);
		}
		return finish(
			loadLocalDesignCatalog(DEFAULT_LOCAL_CATALOG_DIR, repoRoot),
			'local-design',
			DEFAULT_LOCAL_CATALOG_DIR
		);
	}
	const path = resolve(spec);
	if (path.endsWith('.json')) {
		return finish(
			regionCatalog(JSON.parse(readFileSync(path, 'utf8')) as PlayCatalog),
			'frozen',
			path
		);
	}
	return finish(loadLocalDesignCatalog(path, repoRoot), 'local-design', path);
}
