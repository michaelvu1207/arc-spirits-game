import type { GameLocationRewardRow } from '../types';
import type { PublicGameState } from './types';
import { normalizeRegionContent, regionText } from './regions';

export const POWER_ICON = 'navigation-power';
export const REPLACE_POWER_ICON = 'replace-navigation-power';
export const ANY_RUNE_ICON = '36aab6c9-b98c-4e84-b097-e743f45dde82';
const REST = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const CULTIVATE = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const CURSED_SPIRIT = 'faa39f61-98ec-4f63-a873-766dc4e111f3';

/** The current map has exactly two actions per region, independent of legacy DB rows. */
const REGION_ACTIONS: Record<string, GameLocationRewardRow[]> = {
	'Forest Region': [
		{ type: 'gain', gain_icon_ids: [REST] },
		{ type: 'trade', cost_icon_ids: [ANY_RUNE_ICON], gain_icon_ids: [POWER_ICON] }
	],
	'Water Region': [
		{ type: 'gain', gain_icon_ids: [SUMMON] },
		{
			type: 'trade',
			cost_icon_ids: [ANY_RUNE_ICON],
			gain_icon_ids: [
				{
					kind: 'or',
					icon_ids: [
						'de816c21-aa17-4e41-9217-20511c11e9c9',
						'66525fe8-e375-4473-b1c3-88d3c9fd2b1c',
						'40934631-35fc-4936-943a-c607a9c607be'
					]
				}
			]
		}
	],
	'Mountain Region': [
		{
			type: 'trade',
			cost_icon_ids: [ANY_RUNE_ICON],
			gain_icon_ids: [
				{
					kind: 'or',
					icon_ids: ['c9b3225f-c8a9-4aa8-8e43-56c39cf68974', '88facdb6-3374-4891-af8a-fca2e81b79ef']
				}
			]
		},
		{ type: 'trade', cost_icon_ids: [ANY_RUNE_ICON], gain_icon_ids: [REPLACE_POWER_ICON] }
	],
	'Fire Region': [
		{ type: 'gain', gain_icon_ids: [CULTIVATE] },
		{ type: 'trade', cost_icon_ids: [ANY_RUNE_ICON], gain_icon_ids: [CURSED_SPIRIT] }
	]
};

export function regionRewardRows(
	name: string,
	rows: GameLocationRewardRow[] = []
): GameLocationRewardRow[] {
	return normalizeRegionContent(REGION_ACTIONS[regionText(name)] ?? rows);
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

export const REGION_ACTIONS_VERSION = 2;
/** Keep actions already used in saved rounds attached to the surviving action. */
export function upgradeRegionActionUses(state: PublicGameState): void {
	if (state.regionActionsVersion === REGION_ACTIONS_VERSION) return;
	const indexes: Record<string, Record<number, number>> = {
		'Forest Region': { 1: 1, 2: 0 },
		'Water Region': { 0: 0, 1: 1 },
		'Mountain Region': { 1: 0 },
		'Fire Region': { 0: 1, 1: 0 }
	};
	for (const player of Object.values(state.players ?? {})) {
		if (!player) continue;
		const map = indexes[regionText(player.navigationDestination ?? '')];
		if (!map) continue;
		player.actionsUsedThisRound = (player.actionsUsedThisRound ?? []).flatMap((key) => {
			const match = /^row:(\d+)$/.exec(key);
			if (!match) return [key];
			const index = map[Number(match[1])];
			return index === undefined ? [] : [`row:${index}`];
		});
	}
	state.regionActionsVersion = REGION_ACTIONS_VERSION;
}
