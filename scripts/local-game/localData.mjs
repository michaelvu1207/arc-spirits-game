// The `arc_spirits_assets` tables for the local game, built from the design JSON in
// ~/ArcSpiritsArt/game (read only, read once at start).
//
// Two tables have no local JSON copy. They are built here from data in this repo, the same
// way the agent harness builds its local catalog (src/lib/play/agents/catalog.ts):
// - mat_items (runes and relics): the rows of the frozen ml/catalog.json, with the names from
//   the local runes.json / relics.json. A rune or relic that is only in the local JSON is added.
// - reward_row_assignments: only the Arcane Abyss row (the Abyss summon), from
//   ml/catalog.json. The four regions get their rows from code (regionRewardRows).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tables read from <gameDir>/<table>.json. */
export const JSON_TABLES = [
	'hex_spirits',
	'classes',
	'origins',
	'monsters_v2',
	'icon_pool',
	'game_locations',
	'guardians',
	'editions',
	'custom_dice',
	'dice_sides',
	'game_location_rows',
	'monster_pools', // optional: limited Abyss monster decks (absent ⇒ unlimited)
	'relics', // relic ability text → the catalog's relic tool VP (src/lib/play/server/catalog.ts)
	'rules' // optional: rule switches (src/lib/play/rules.ts; absent ⇒ every rule as before)
];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function readTable(gameDir, table, notes) {
	const file = join(gameDir, `${table}.json`);
	if (!existsSync(file)) {
		notes.push(`${table}.json not found: the table is empty`);
		return [];
	}
	// `local` holds editor-only data; the database rows do not have it. A table stored as one
	// object (rules.json) is served as a one-row table.
	const json = readJson(file);
	return (Array.isArray(json) ? json : [json]).map(({ local: _local, ...row }) => row);
}

function buildMatItems(frozenMats, gameDir, origins, notes) {
	const localRows = [];
	for (const [file, kind] of [
		['runes.json', 'rune'],
		['relics.json', 'relic']
	]) {
		const path = join(gameDir, file);
		if (existsSync(path)) for (const row of readJson(path)) localRows.push({ ...row, kind });
		else notes.push(`${file} not found: mat names come from ml/catalog.json`);
	}
	const localById = new Map(localRows.map((row) => [row.id, row]));
	// A mat with an origin is a rune, one without is a relic (catalog.ts matKind). The frozen
	// rows keep the origins the live database has ("Any relic" has the Lost origin there).
	const rows = frozenMats.map((mat) => ({
		id: mat.id,
		name: localById.get(mat.id)?.name ?? (mat.name === 'Teapot' ? 'Cleansing Teapot' : mat.name),
		origin_id: mat.originId ?? null,
		icon_path: `runes/${mat.id}/icon.png`
	}));
	const originByName = new Map(origins.map((o) => [String(o.name).toLowerCase(), o.id]));
	const lostId = originByName.get('lost') ?? null;
	for (const row of localRows) {
		if (rows.some((mat) => mat.id === row.id)) continue;
		const region = String(row.owner ?? '').replace(/ Region$/, '').toLowerCase();
		rows.push({
			id: row.id,
			name: row.name,
			origin_id: row.kind === 'rune' ? (originByName.get(region) ?? lostId) : null,
			icon_path: `runes/${row.id}/icon.png`
		});
		notes.push(`mat_items: added ${row.kind} "${row.name}" from the local JSON`);
	}
	return { rows, localRows };
}

function buildAbyssRows(frozen, locations, notes) {
	const abyss = locations.find((loc) => loc.name === 'Arcane Abyss');
	const frozenRows = frozen.locations?.find((loc) => loc.name === 'Arcane Abyss')?.rewardRows ?? [];
	if (!abyss || frozenRows.length === 0) {
		notes.push('no Arcane Abyss reward row: the Abyss has no summon action');
		return { rows: [], assignments: [] };
	}
	const rows = frozenRows.map((config, index) => ({
		id: `local-abyss-row-${index}`,
		name: `Arcane Abyss row ${index + 1} (ml/catalog.json)`,
		type: config.type,
		config
	}));
	const assignments = rows.map((row, index) => ({ location_id: abyss.id, row_id: row.id, row_index: index }));
	return { rows, assignments };
}

/**
 * Read all tables. Returns `{ tables, extras, notes }`: `tables` maps a table name to its rows,
 * `extras` holds the local rune/relic rows (their `icon` field names an icon_pool row), and
 * `notes` lists what was missing or added.
 */
export function loadLocalTables({ gameDir, repoRoot }) {
	const notes = [];
	const tables = {};
	for (const table of JSON_TABLES) tables[table] = readTable(gameDir, table, notes);
	const frozen = readJson(join(repoRoot, 'ml/catalog.json'));
	const mats = buildMatItems(frozen.mats ?? [], gameDir, tables.origins, notes);
	tables.mat_items = mats.rows;
	const abyss = buildAbyssRows(frozen, tables.game_locations, notes);
	tables.game_location_rows = [...tables.game_location_rows, ...abyss.rows];
	tables.reward_row_assignments = abyss.assignments;
	return { tables, extras: { runesAndRelics: mats.localRows }, notes };
}
