import type { GameLocationRewardRow, RewardIconToken } from '../types';
import { normalizeRegionContent, regionText } from './regions';

export const POWER_ICON = 'navigation-power';
export const REPLACE_POWER_ICON = 'replace-navigation-power';
export const ANY_RUNE_ICON = '36aab6c9-b98c-4e84-b097-e743f45dde82';
const ANY_RELIC_ICON = '6a85e06a-52cc-483c-aa59-38395a377307';
const RELIC_ICONS = new Set([
	'895144a1-e0f6-4bdc-a4db-322423f1b922',
	'75134075-3347-49de-a740-eb99d20b1f1a',
	'ca4df196-67fb-4507-973d-1dfac277953d',
	'c8ef5d48-2289-4fee-a34d-b041d3e8bea6'
]);

/** Apply the current map rules to old database rows and frozen catalogs alike. */
export function regionRewardRows(
	name: string,
	rows: GameLocationRewardRow[] = []
): GameLocationRewardRow[] {
	if (
		!['Forest Region', 'Fire Region', 'Water Region', 'Mountain Region'].includes(regionText(name))
	)
		return rows;
	const ids = (token: RewardIconToken) => (typeof token === 'string' ? [token] : token.icon_ids);
	return rows.map((row) => {
		if (row.type !== 'trade') return row;
		if (row.gain_icon_ids.some((token) => ids(token).some((id) => RELIC_ICONS.has(id)))) {
			return {
				type: 'trade',
				cost_icon_ids: [ANY_RUNE_ICON],
				gain_icon_ids: [regionText(name) === 'Fire Region' ? REPLACE_POWER_ICON : POWER_ICON]
			};
		}
		return {
			...row,
			cost_icon_ids: row.cost_icon_ids.map((token) =>
				token === ANY_RELIC_ICON ? ANY_RUNE_ICON : token
			)
		};
	});
}

export function regionCatalog<
	T extends { locations?: { name: string; rewardRows: GameLocationRewardRow[] }[] }
>(catalog: T): T {
	const normalized = normalizeRegionContent(catalog);
	for (const loc of normalized.locations ?? [])
		loc.rewardRows = regionRewardRows(loc.name, loc.rewardRows);
	return normalized;
}

/** Bundled glyphs for app-defined reward tokens, which have no database icon row. */
export function powerIconUrl(id: string): string | null {
	if (id === POWER_ICON) return '/icons/navigation-power.svg';
	if (id === REPLACE_POWER_ICON) return '/icons/replace-navigation-power.svg';
	return null;
}
