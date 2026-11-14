/** Human-readable change list between two packages' tables. */

const IGNORED_FIELDS = new Set(['created_at', 'updated_at', 'name_translations', 'description_translations', 'card_image_path_translations']);
const ART_FIELD = /(_path|_png|_image|_export|_url|art_raw|back_side|psd_folder|manual_game_print)/;
const TITLES = {
	hex_spirits: 'Spirits',
	classes: 'Classes',
	origins: 'Origins',
	monsters_v2: 'Monsters',
	guardians: 'Guardians',
	game_locations: 'Locations',
	game_location_rows: 'Location actions',
	reward_row_assignments: 'Location action slots',
	monster_pools: 'Monster pools',
	rules: 'Rule switches',
	relics: 'Relics',
	mat_items: 'Runes and relics',
	custom_dice: 'Dice',
	dice_sides: 'Dice sides',
	editions: 'Editions',
	icon_pool: 'Icons'
};

const short = (value) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (text === undefined) return '—';
	return text.length > 140 ? `${text.slice(0, 137)}…` : text;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function nameMaps(tables) {
	const byId = new Map();
	for (const table of ['classes', 'origins', 'icon_pool', 'mat_items'])
		for (const row of tables?.[table] ?? []) if (row.id && row.name) byId.set(row.id, row.name);
	return byId;
}

/** Replace known ids (classes, origins, runes, icons) by their names inside a value. */
function named(value, names) {
	if (typeof value === 'string') return names.get(value) ?? value;
	if (Array.isArray(value)) return value.map((v) => named(v, names));
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, named(v, names)]));
	return value;
}

const keyOf = (row, i) => row.id ?? row.name ?? (row.players != null ? `${row.players}p-D${row.difficulty}` : `row ${i + 1}`);
const labelOf = (row, key) => row.name ?? (row.players != null ? `${row.players} players, difficulty ${row.difficulty}` : String(key));

export function describeChanges(before, after) {
	if (!before) return { summary: 'first package', lines: [] };
	const names = new Map([...nameMaps(before), ...nameMaps(after)]);
	const lines = [];
	let added = 0;
	let removed = 0;
	let changed = 0;
	let artOnly = 0;
	for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		const a = new Map((before[table] ?? []).map((row, i) => [keyOf(row, i), row]));
		const b = new Map((after[table] ?? []).map((row, i) => [keyOf(row, i), row]));
		const section = [];
		for (const [key, row] of b) {
			if (!a.has(key)) {
				added++;
				section.push(`- Added **${labelOf(row, key)}**`);
				continue;
			}
			const old = a.get(key);
			const fields = [...new Set([...Object.keys(old), ...Object.keys(row)])].filter(
				(f) => !IGNORED_FIELDS.has(f) && !same(old[f], row[f])
			);
			const rules = fields.filter((f) => !ART_FIELD.test(f));
			if (!fields.length) continue;
			if (!rules.length) {
				artOnly++;
				continue;
			}
			changed++;
			section.push(`- **${labelOf(row, key)}**`);
			for (const f of rules)
				section.push(`  - ${f}: ${short(named(old[f], names))} → ${short(named(row[f], names))}`);
		}
		for (const [key, row] of a)
			if (!b.has(key)) {
				removed++;
				section.push(`- Removed **${labelOf(row, key)}**`);
			}
		if (section.length) lines.push(`## ${TITLES[table] ?? table}`, '', ...section, '');
	}
	const parts = [];
	if (changed) parts.push(`${changed} changed`);
	if (added) parts.push(`${added} added`);
	if (removed) parts.push(`${removed} removed`);
	if (artOnly) parts.push(`${artOnly} with new art only`);
	return { summary: parts.length ? parts.join(', ') : 'no data changes', lines };
}
