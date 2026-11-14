import { describe, expect, it } from 'vitest';
import { queryRows } from './query';
import { createPackageFetch } from './packageFetch';
import { LIVE_PACKAGE_VERSION, PACKAGES, loadPackageTables, packageInfo } from './index';

const rows = [
	{ id: 'a', name: 'Alpha', cost: 3, tags: ['x', 'y'], parent: null },
	{ id: 'b', name: 'Beta', cost: 7, tags: ['y'], parent: 'a' },
	{ id: 'c', name: 'Gamma', cost: 1, tags: [], parent: 'a' }
];
const q = (query: string) => queryRows(rows, new URLSearchParams(query));

describe('package table queries', () => {
	it('filters, orders, limits and selects like the PostgREST calls the site makes', () => {
		expect(q('id=eq.b').rows).toEqual([rows[1]]);
		expect(q('id=in.(a,c)').rows.map((r) => r.id)).toEqual(['a', 'c']);
		expect(q('parent=is.null').rows.map((r) => r.id)).toEqual(['a']);
		expect(q('parent=not.is.null&order=cost.desc').rows.map((r) => r.id)).toEqual(['b', 'c']);
		expect(q('tags=cs.{y}').rows.map((r) => r.id)).toEqual(['a', 'b']);
		expect(q('order=cost.asc&limit=2&select=id,cost').rows).toEqual([
			{ id: 'c', cost: 1 },
			{ id: 'a', cost: 3 }
		]);
		expect(q('cost=gt.2').unsupported).toEqual(['cost=gt.2']);
	});
});

describe('the live package', () => {
	it('is listed, loads, and has the tables the game needs', async () => {
		expect(packageInfo()?.version).toBe(LIVE_PACKAGE_VERSION);
		expect(PACKAGES.length).toBeGreaterThan(0);
		const tables = await loadPackageTables();
		for (const table of ['hex_spirits', 'classes', 'origins', 'monsters_v2', 'guardians', 'game_locations', 'mat_items'])
			expect(tables[table]?.length, table).toBeGreaterThan(0);
	});
	it('answers table reads through the package fetch, and refuses writes', async () => {
		const fetchPkg = createPackageFetch(async () => new Response('real', { status: 299 }));
		const read = await fetchPkg('https://x.invalid/rest/v1/hex_spirits?select=id,name&limit=3');
		expect(read.status).toBe(200);
		const body = (await read.json()) as { id: string; name: string }[];
		expect(body).toHaveLength(3);
		expect(Object.keys(body[0])).toEqual(['id', 'name']);
		expect((await fetchPkg('https://x.invalid/rest/v1/no_such_table?select=*')).status).toBe(200);
		expect((await fetchPkg('https://x.invalid/rest/v1/hex_spirits', { method: 'POST', body: '{}' })).status).toBe(405);
		const single = await fetchPkg('https://x.invalid/rest/v1/hex_spirits?select=id', {
			headers: { accept: 'application/vnd.pgrst.object+json' }
		});
		expect(single.status).toBe(406);
		// Storage and anything else still goes to the network.
		expect((await fetchPkg('https://x.invalid/storage/v1/object/public/game_assets/a.png')).status).toBe(299);
	});
});
