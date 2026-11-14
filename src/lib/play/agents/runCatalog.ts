/**
 * Each run folder keeps a copy of the card data it played, so "old data" and "new data" stay
 * clear later (Step 3 compares two runs):
 *
 *   <run>/catalog/play-catalog.json   the built PlayCatalog the engine used (its sha256 = the hash)
 *   <run>/catalog/source/*.json       the design JSON files it was built from (design-dir runs)
 *   <run>/catalog/catalog-info.json   source, path, hash, and a sha256 per source file
 */

import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { PlayCatalog } from '../types';
import { catalogHash, type LoadedCatalog } from './catalog';

export const RUN_CATALOG_DIR = 'catalog';

export interface RunCatalogInfo {
	source: LoadedCatalog['source'];
	path: string;
	hash: string;
	savedAt: string;
	/** Design JSON files copied to `catalog/source/` with their sha256. */
	files: { name: string; sha256: string }[];
}

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Copy the run's catalog into `<runDir>/catalog/`. */
export function saveRunCatalog(runDir: string, loaded: LoadedCatalog): RunCatalogInfo {
	const dir = join(runDir, RUN_CATALOG_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'play-catalog.json'), JSON.stringify(loaded.catalog));
	const files: RunCatalogInfo['files'] = [];
	if (loaded.source === 'local-design' && existsSync(loaded.path)) {
		mkdirSync(join(dir, 'source'), { recursive: true });
		for (const name of readdirSync(loaded.path)
			.filter((f) => f.endsWith('.json'))
			.sort()) {
			copyFileSync(join(loaded.path, name), join(dir, 'source', name));
			files.push({ name, sha256: fileHash(join(loaded.path, name)) });
		}
	}
	const info: RunCatalogInfo = {
		source: loaded.source,
		path: loaded.path,
		hash: loaded.hash,
		savedAt: new Date().toISOString(),
		files
	};
	writeFileSync(join(dir, 'catalog-info.json'), `${JSON.stringify(info, null, 2)}\n`);
	return info;
}

/** The catalog a run played, from its folder copy (the hash is checked). */
export function loadRunCatalog(runDir: string): {
	catalog: PlayCatalog;
	hash: string;
	info: RunCatalogInfo;
} {
	const dir = join(runDir, RUN_CATALOG_DIR);
	const path = join(dir, 'play-catalog.json');
	if (!existsSync(path))
		throw new Error(`${runDir} has no catalog copy (${RUN_CATALOG_DIR}/play-catalog.json)`);
	const catalog = JSON.parse(readFileSync(path, 'utf8')) as PlayCatalog;
	const info = JSON.parse(readFileSync(join(dir, 'catalog-info.json'), 'utf8')) as RunCatalogInfo;
	const hash = catalogHash(catalog);
	if (hash !== info.hash)
		throw new Error(`${path}: hash ${hash.slice(0, 12)} ≠ recorded ${info.hash.slice(0, 12)}`);
	return { catalog, hash, info };
}
