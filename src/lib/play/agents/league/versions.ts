/**
 * Data versions of the league. The data dir (the design JSON the owner edits) is hashed by its
 * files; when the files change, the catalog is built again. A new catalog hash is a new data
 * version: its catalog is copied to `<league>/data/<hash12>/` (runCatalog.ts) and its games go
 * to `<league>/versions/<hash12>/`. A data dir that cannot be built (half-written or invalid
 * JSON) is reported and skipped until its files change again; the league keeps the last good
 * version.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayCatalog } from '../../types';
import { loadCatalogSpec } from '../catalog';
import { buildRulesBrief } from '../rulesBrief';
import { loadRunCatalog, saveRunCatalog } from '../runCatalog';
import { describeChange, diffCatalogs } from '../strategyCompare';

export interface DataVersion {
	/** Full catalog hash. */
	hash: string;
	/** First 12 characters: the version's folder name. */
	id: string;
	catalog: PlayCatalog;
	rulesBrief: string;
	catalogInfo: { source: string; path: string; hash: string };
}

export const versionId = (hash: string) => hash.slice(0, 12);

/** sha256 over the names and bytes of the data dir's JSON files (cheap; no parse). */
export function dataFilesHash(dataDir: string): string {
	const h = createHash('sha256');
	for (const name of readdirSync(dataDir)
		.filter((f) => f.endsWith('.json'))
		.sort()) {
		h.update(name);
		h.update('\0');
		h.update(readFileSync(join(dataDir, name)));
		h.update('\0');
	}
	return h.digest('hex');
}

function versionFrom(catalog: PlayCatalog, hash: string, source: string, path: string): DataVersion {
	return {
		hash,
		id: versionId(hash),
		catalog,
		rulesBrief: buildRulesBrief(catalog),
		catalogInfo: { source, path, hash }
	};
}

/** A saved version (its catalog copy under `<league>/data/<id>/`). */
export function loadSavedVersion(leagueDir: string, id: string): DataVersion {
	const saved = loadRunCatalog(join(leagueDir, 'data', id));
	return versionFrom(saved.catalog, saved.hash, saved.info.source, saved.info.path);
}

export type DataCheck =
	| { kind: 'same' }
	| { kind: 'version'; version: DataVersion; isNew: boolean }
	| { kind: 'invalid'; error: string };

/** Watches the data dir; `check()` says whether the data changed and how. */
export class DataWatcher {
	readonly #leagueDir: string;
	readonly #dataDir: string;
	readonly #repoRoot: string;
	#filesHash: string | null = null;
	current: DataVersion | null = null;
	/** Why the data dir could not be used at the last change (null: it was fine). */
	problem: string | null = null;

	constructor(leagueDir: string, dataDir: string, repoRoot = process.cwd()) {
		this.#leagueDir = leagueDir;
		this.#dataDir = dataDir;
		this.#repoRoot = repoRoot;
	}

	check(): DataCheck {
		let files: string;
		try {
			files = dataFilesHash(this.#dataDir);
		} catch (err) {
			return this.#invalid(`cannot read the data folder: ${(err as Error).message}`);
		}
		if (files === this.#filesHash) return { kind: 'same' };
		this.#filesHash = files;
		let loaded: ReturnType<typeof loadCatalogSpec>;
		try {
			loaded = loadCatalogSpec(this.#dataDir, this.#repoRoot);
			if (!loaded.catalog.spirits?.length) throw new Error('no spirits in the data');
		} catch (err) {
			return this.#invalid((err as Error).message);
		}
		this.problem = null;
		if (loaded.hash === this.current?.hash) return { kind: 'same' };
		const id = versionId(loaded.hash);
		const dir = join(this.#leagueDir, 'data', id);
		const isNew = !existsSync(join(dir, 'catalog', 'play-catalog.json'));
		if (isNew) saveRunCatalog(dir, loaded);
		this.current = versionFrom(loaded.catalog, loaded.hash, loaded.source, loaded.path);
		return { kind: 'version', version: this.current, isNew };
	}

	#invalid(error: string): DataCheck {
		this.problem = error.slice(0, 300);
		return { kind: 'invalid', error: this.problem };
	}
}

/** The changed cards between two versions, one plain line each (at most `limit`). */
export function changedCards(before: PlayCatalog, after: PlayCatalog, limit = 12): string[] {
	const changes = diffCatalogs(before, after).map(describeChange);
	return changes.length > limit
		? [...changes.slice(0, limit), `… and ${changes.length - limit} more changes`]
		: changes;
}
