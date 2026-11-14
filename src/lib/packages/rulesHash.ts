import { createHash } from 'node:crypto';
import { stableStringify } from '../play/agents/catalog';
import type { PlayCatalog } from '../play/types';

/**
 * Hash of everything in a catalog that the engine plays by. Rune and relic display names and the
 * order of the mats list are left out: the site (and the local game) name them from the design
 * data ("Any basic rune", "Diamond"), the agent harness from the frozen catalog ("Any Rune",
 * "Magnet"); the engine works by id. Used to prove that the catalog the site builds from a
 * package is the one the release check played on.
 */
export function rulesHash(catalog: PlayCatalog): string {
	const mats = [...catalog.mats]
		.map(({ name: _name, ...rest }) => rest)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return createHash('sha256')
		.update(stableStringify({ ...catalog, mats }))
		.digest('hex');
}
