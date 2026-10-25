/** Legacy content/save aliases. IDs and asset filenames remain stable. */
const REGION_ALIASES: Record<string, string> = {
	'Floral Patch': 'Forest Region',
	'Cyber City': 'Mountain Region',
	'Tidal Cove': 'Water Region',
	'Lantern Canyon': 'Fire Region',
	'Lantern Lights': 'Fire Region',
	'Moon Tide': 'Water Region',
	'Tidal Tribe': 'Water Region'
};

export function regionText(value: string): string {
	for (const [oldName, newName] of Object.entries(REGION_ALIASES))
		value = value.replaceAll(oldName, newName);
	return value;
}

/** Apply names at external JSON boundaries, including dictionary keys in old saves. */
export function normalizeRegionContent<T>(value: T): T {
	if (typeof value === 'string') return regionText(value) as T;
	if (Array.isArray(value)) return value.map(normalizeRegionContent) as T;
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [regionText(key), normalizeRegionContent(entry)])
		) as T;
	}
	return value;
}

/** Stable origin identities shared by both authoritative catalog loaders. */
export const REGION_ORIGIN_NAMES: Record<string, string> = {
	'ad555f03-9b89-4a71-a47c-464fd67d2c05': 'Forest Region',
	'fa7db249-d99d-4c1d-a37d-9027c9f5a31e': 'Mountain Region',
	'178449e9-cc6b-45ab-8522-5183fe1d9307': 'Fire Region',
	'294cee31-a7ac-4292-9b61-d4293c05c146': 'Water Region'
};
