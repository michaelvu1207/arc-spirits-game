/**
 * Code-defined Spirit World location presentation config.
 *
 * Reward-row content (the per-location actions) is authored in Supabase
 * (`game_location_rows` + `reward_row_assignments`) and loaded by the catalog —
 * it does NOT live here. What lives here is app-local presentation that has no
 * business in the data layer: each location's origin/element flavor, brand accent
 * color, and the static splat/music asset paths bundled with the client.
 */

import type { NavigationDestination } from './types';

export interface LocationConfig {
	name: NavigationDestination;
	/** Origin (element) flavor, if any — drives accent color + cultivate output. */
	origin: string | null;
	/**
	 * Abyss is combat-only (fight the monster). Every Spirit World location's available
	 * actions ARE its DB reward rows (see `locationInteractions.ts` + `game_locations`):
	 * Rest lives at Forest Region, Cultivate at Fire Region, Summon at Water Region, etc.
	 * There is NO generic always-available action set — reward-row interactions are the
	 * only way to act at a location.
	 */
	combatOnly: boolean;
}

export const LOCATIONS: Record<NavigationDestination, LocationConfig> = {
	'Forest Region': { name: 'Forest Region', origin: 'Forest', combatOnly: false },
	'Mountain Region': { name: 'Mountain Region', origin: 'Mountain', combatOnly: false },
	'Water Region': { name: 'Water Region', origin: 'Water', combatOnly: false },
	'Fire Region': { name: 'Fire Region', origin: 'Fire', combatOnly: false },
	'Arcane Abyss': { name: 'Arcane Abyss', origin: null, combatOnly: true }
};

/** Accent color per location, aligned with the brand palette. */
export const LOCATION_ACCENT: Record<NavigationDestination, string> = {
	'Forest Region': '#4cba6a',
	'Mountain Region': '#5cdfff',
	'Water Region': '#4d8bf0',
	'Fire Region': '#ffba3d',
	'Arcane Abyss': '#ff2bc7'
};

export function getLocationConfig(name: string): LocationConfig | null {
	return (LOCATIONS as Record<string, LocationConfig>)[name] ?? null;
}

// ── Per-destination presentation: splat world + music ────────────────────────
// Single source of truth so the board, the splat background layer and the music
// resolver never drift (e.g. a new location added to one map but not another).

/** Gaussian-splat world (static .spz under /static/splats) per destination. */
export const SPLAT_BY_DESTINATION: Partial<Record<NavigationDestination, string>> = {
	'Mountain Region': '/splats/cyber-city.spz',
	'Forest Region': '/splats/forest-clearing.spz',
	'Water Region': '/splats/underwater-cave.spz',
	'Fire Region': '/splats/lantern-market.spz',
	'Arcane Abyss': '/splats/abyssal-portal.spz'
};
/** Shown before a destination is picked (the sunset valley). */
export const DEFAULT_SPLAT = '/splats/misty-valley.spz';

/** Ambient world theme per destination (location/interaction phase). */
export const WORLD_MUSIC: Partial<Record<NavigationDestination, string>> = {
	'Mountain Region': '/music/worlds/cyber-city.mp3',
	'Forest Region': '/music/worlds/forest-clearing.mp3',
	'Water Region': '/music/worlds/underwater-cave.mp3',
	'Fire Region': '/music/worlds/lantern-market.mp3',
	'Arcane Abyss': '/music/worlds/abyssal-portal.mp3'
};
export const DEFAULT_WORLD_MUSIC = '/music/worlds/misty-valley.mp3';

/** Combat theme per destination (encounter phase / monster fight). */
export const COMBAT_MUSIC: Partial<Record<NavigationDestination, string>> = {
	'Mountain Region': '/music/combat/cyber-city.mp3',
	'Forest Region': '/music/combat/floral-patch.mp3',
	'Water Region': '/music/combat/tidal-cove.mp3',
	'Fire Region': '/music/combat/lantern-canyon.mp3',
	'Arcane Abyss': '/music/combat/arcane-abyss.mp3'
};
export const DEFAULT_COMBAT_MUSIC = '/music/combat/arcane-abyss.mp3';

/** Scene themes not tied to a single world. */
export const NAVIGATION_MUSIC = '/music/scenes/navigation.mp3';
export const CLEANUP_MUSIC = '/music/scenes/cleanup.mp3';

export function splatFor(dest: NavigationDestination | null | undefined): string {
	return (dest && SPLAT_BY_DESTINATION[dest]) || DEFAULT_SPLAT;
}
export function worldMusicFor(dest: NavigationDestination | null | undefined): string {
	return (dest && WORLD_MUSIC[dest]) || DEFAULT_WORLD_MUSIC;
}
export function combatMusicFor(dest: NavigationDestination | null | undefined): string {
	return (dest && COMBAT_MUSIC[dest]) || DEFAULT_COMBAT_MUSIC;
}
