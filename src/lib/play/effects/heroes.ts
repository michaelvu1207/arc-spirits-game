import type { PlayCatalog, PlaySpirit } from '../types';

/**
 * The hero classes (`class_type: 'human'` in the November 2026 catalog). Used only when the
 * play catalog carries no class rows (unit tests, frozen catalogs without `classes`).
 */
const HERO_CLASS_FALLBACK = new Set([
	'Healer',
	'Sharpshooter',
	'Arcane Alchemist',
	'Captain',
	'Battle Adept',
	'Monster Hunter'
]);

/**
 * Is this spirit a Hero? The November 2026 catalog gives the six heroes NO origin, so the old
 * "Human Enclave origin" test no longer finds them. A hero is a spirit with the Human Enclave
 * origin OR a class whose catalog `classType` is `human`.
 */
export function isHeroSpirit(spirit: Pick<PlaySpirit, 'classes' | 'origins'>, catalog?: PlayCatalog): boolean {
	if (Object.keys(spirit.origins ?? {}).includes('Human Enclave')) return true;
	const humanClasses = catalog?.classes?.length
		? new Set(catalog.classes.filter((c) => c.classType === 'human').map((c) => c.name))
		: HERO_CLASS_FALLBACK;
	return Object.entries(spirit.classes ?? {}).some(([name, n]) => (n ?? 0) > 0 && humanClasses.has(name));
}
