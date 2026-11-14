import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssetsData } from '$lib/supabase';
import { buildPlayCatalog } from './catalog';
import { currentClassName } from '../classNames';
import { AWAKEN_HANDLERS, MANUAL_AWAKEN } from '../effects/awakenHandlers';
import { CATALOG_CLASSES, CATALOG_SPIRITS } from '../effects/__fixtures__/catalog-coverage';

/**
 * The gap between the code deploy and migration 20261111120000: the new engine runs on the LIVE
 * database rows. The fixture holds the read-only backup of those rows (2026-11-12, the columns
 * buildPlayCatalog reads). coverage.test.ts proves that every class of the local design data
 * (CATALOG_CLASSES) has engine coverage; this test proves that every live row reaches that coverage.
 */
const LIVE = JSON.parse(readFileSync(new URL('../__fixtures__/live-db-2026-11-12.json', import.meta.url), 'utf8'));

const assets = {
	spirits: LIVE.spirits,
	mats: LIVE.mats,
	customDice: [],
	monsters: [],
	statusIcons: [],
	iconPool: [],
	gameLocations: [],
	guardians: LIVE.guardians,
	classes: LIVE.classes,
	origins: LIVE.origins,
	costDuplicates: null
} as unknown as AssetsData;

const catalog = buildPlayCatalog(assets);
const currentNames = new Set(CATALOG_CLASSES.map((c) => c.name));
const localSpirit = new Map(CATALOG_SPIRITS.map((s) => [s.id, s]));
/** JSON with sorted object keys (the backup and the local file order keys differently). */
const canon = (v: unknown) =>
	JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

describe('live database (backup 2026-11-12) as the catalog, before the migration', () => {
	it('every live class name resolves through the rename chain to a covered class of the same id', () => {
		const localById = new Map(CATALOG_CLASSES.map((c) => [c.id, c.name]));
		const unresolved = LIVE.classes
			.map((c: { id: string; name: string }) => [c.name, currentClassName(c.name), localById.get(c.id)])
			.filter(([, resolved, local]: string[]) => !currentNames.has(resolved) || resolved !== local);
		expect(unresolved).toEqual([]);
		expect(LIVE.classes).toHaveLength(37);
		expect(catalog.classes.every((c) => currentNames.has(c.name))).toBe(true);
	});

	it('every live spirit loads with current class names, and its awaken condition resolves', () => {
		expect(catalog.spirits).toHaveLength(48);
		for (const s of catalog.spirits) {
			for (const name of Object.keys(s.classes)) expect(currentNames.has(name), `${s.name}: ${name}`).toBe(true);
			if (s.awaken?.kind === 'rune_cost') {
				expect(s.awaken.mats.length, s.name).toBeGreaterThan(0);
			}
		}
		// A live text condition without a script goes to the manual-confirm path (owner confirms).
		const manualConfirm = catalog.spirits
			.filter((s) => s.awaken?.kind === 'text' && !AWAKEN_HANDLERS[s.id] && !MANUAL_AWAKEN.has(s.id))
			.map((s) => s.name)
			.sort();
		expect(manualConfirm).toEqual(['The Huntress of All Tides', 'The Solar Reliquarian', 'The Threefold Watcher']);
	});

	it('lists the live texts that the engine already plays by the new rule (the handlers key on spirit id)', () => {
		const differs = catalog.spirits
			.filter((s) => s.awaken?.kind === 'text' && AWAKEN_HANDLERS[s.id])
			.filter((s) => {
				const live = LIVE.spirits.find((r: { id: string }) => r.id === s.id)?.awaken_condition;
				const local = localSpirit.get(s.id)?.awaken_condition;
				return canon(live) !== canon(local);
			})
			.map((s) => s.name)
			.sort();
		expect(differs).toEqual([
			'Briarwing Regent',
			'Cinderwing Regent',
			'Crestwing Regent',
			'Moonrend, the Twice-Striking',
			'The Argent Loom',
			'Vespera, Empress of the Last Moon'
		]);
	});
});
