import type { PageServerLoad } from './$types';
import { LIVE_PACKAGE_VERSION, PACKAGES, loadPackageChanges } from '$lib/packages';

/** Every game-data package in this build, newest first, with its change list. */
export const load: PageServerLoad = async () => {
	const versions = await Promise.all(
		PACKAGES.map(async (info) => ({
			version: info.version,
			createdAt: info.createdAt,
			parent: info.parent,
			notes: info.notes,
			rulesHash: info.rulesHash ?? null,
			counts: info.counts ?? {},
			changes: await loadPackageChanges(info.version)
		}))
	);
	return { live: LIVE_PACKAGE_VERSION, versions };
};
