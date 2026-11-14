/**
 * Game-data packages. A package is an immutable snapshot of the design tables (spirits, classes,
 * monsters, locations, dice, guardians, rule switches, …) in `packages/<version>/` at the repo
 * root, made by `scripts/package/release.mjs`. `packages/index.json` names the live one.
 *
 * The site reads game data ONLY from the live package: nothing is read from a database, so a
 * local change reaches players only when a new package is published (a push that Vercel deploys).
 * Every package stays in the build as its own lazy chunk, so old versions remain readable.
 */
import index from '../../../packages/index.json';

export interface PackageInfo {
	version: string;
	createdAt: string;
	parent: string | null;
	notes: string;
	/** sha256 of tables.json. */
	sha256: string;
	/** ./rulesHash.ts of the engine catalog the release check played on. */
	rulesHash?: string;
	counts?: Record<string, number>;
	/** Display-size art uploaded for this package: storage folder `game_assets/art/<id>/` of the
	 *  play project (scripts/package/art.mjs). null/absent ⇒ the art of the old project's bucket. */
	art?: { id: string; files: number } | null;
}
export type PackageTables = Record<string, Record<string, unknown>[]>;

const tableLoaders = import.meta.glob<PackageTables>('../../../packages/*/tables.json', {
	import: 'default'
});
const changeLoaders = import.meta.glob<string>('../../../packages/*/CHANGES.md', {
	query: '?raw',
	import: 'default'
});
const keyFor = (version: string, file: string) => `../../../packages/${version}/${file}`;

export const LIVE_PACKAGE_VERSION: string = index.live;
/** Newest first. */
export const PACKAGES: PackageInfo[] = [...(index.versions as PackageInfo[])].reverse();

export function packageInfo(version: string = LIVE_PACKAGE_VERSION): PackageInfo | null {
	return PACKAGES.find((p) => p.version === version) ?? null;
}

const loaded = new Map<string, Promise<PackageTables>>();
/** The design tables of a package (default: the live one). Loaded once per process/page. */
export function loadPackageTables(version: string = LIVE_PACKAGE_VERSION): Promise<PackageTables> {
	let pending = loaded.get(version);
	if (!pending) {
		const loader = tableLoaders[keyFor(version, 'tables.json')];
		if (!loader) return Promise.reject(new Error(`game package "${version}" is not in this build`));
		pending = loader();
		loaded.set(version, pending);
	}
	return pending;
}

/** The change list of a package (Markdown), or '' when it has none. */
export async function loadPackageChanges(version: string): Promise<string> {
	const loader = changeLoaders[keyFor(version, 'CHANGES.md')];
	return loader ? loader() : '';
}
