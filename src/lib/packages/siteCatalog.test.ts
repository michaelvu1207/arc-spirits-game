/**
 * The catalog the SITE builds from the live package (server loader → assets client → package
 * fetch) must be the catalog the release check played on (manifest rulesHash, built by the
 * agent harness's loadLocalDesignCatalog from the same data; see rulesHash.ts for what it covers).
 */
import { describe, expect, it } from 'vitest';
import { loadPlayCatalog } from '$lib/play/server/catalog';
import { rulesHash } from './rulesHash';
import { packageInfo } from './index';

describe('site catalog from the live package', () => {
	it('builds, and matches the hash recorded at release', async () => {
		const catalog = await loadPlayCatalog();
		expect(catalog.spirits.length).toBeGreaterThan(50);
		expect(catalog.monsters?.length).toBeGreaterThan(100);
		expect(catalog.locations?.length).toBeGreaterThan(3);
		expect(rulesHash(catalog)).toBe(packageInfo()?.rulesHash);
	});
});
