import { powerIconUrl } from '$lib/play/regionRules';
import { meaningFor } from '$lib/play/locationInteractions';
/** Shared helpers for the 2D play board. */
import { gameImageUrl } from '$lib/storageImages';
import type { HexSpiritAsset, IconPoolEntry, MatAsset, MatSlotSnapshot } from '$lib/types';
import { PLAYER_COLOR_HEX, type PlayerColor } from '$lib/types';
import type { DiceTier, SeatColor } from '$lib/play/types';
import { getAssetState } from '$lib/stores/assetStore.svelte';

/** icon_pool ids for the core resource icons shown on the player bar. */
export const RESOURCE_ICON_IDS = {
	vp: '70792514-aa43-4526-a7a4-0f1e4ca55d71', // victory_point
	barrier: '6746f875-a1bc-453c-94b5-718d6ebeb025', // barrier / potential token
	brokenBarrier: '80f1d5a8-812e-4bb2-b341-68e69d9a3e38',
	rune: '36aab6c9-b98c-4e84-b097-e743f45dde82' // Rune: Any Rune (generic)
} as const;

export function iconPoolUrl(iconPool: Map<string, IconPoolEntry>, id: string): string | null {
	return powerIconUrl(id) ?? storageUrl(iconPool.get(id)?.file_path ?? null);
}

/**
 * Resolve a rune slot to its OWN rune art. Slots store varying identity depending
 * on how they were gained — a rune id (reward gains), an origin/class link, or just
 * a name ("Mountain Region Rune", "Fairy Relic"). Resolve in that order, bridging an
 * origin NAME → origin id → its rune (handles e.g. "Forest Region" → "Forest").
 */
export function runeAssetFor(
	assets: ReturnType<typeof getAssetState>,
	rune: MatSlotSnapshot
): MatAsset | null {
	const all = [...assets.matAssets.values()];
	if (rune.id) {
		const a = assets.matAssets.get(rune.id);
		if (a?.icon_path) return a;
	}
	if (rune.originId) {
		const a = all.find((r) => r.origin_id === rune.originId);
		if (a?.icon_path) return a;
	}
	if (rune.type === 'relic') {
		const a = all.find((r) => r.name.toLowerCase() === 'fairy rune');
		if (a?.icon_path) return a;
	}
	if (rune.name) {
		const lower = rune.name.toLowerCase();
		const exact = all.find((r) => r.name.toLowerCase() === lower);
		if (exact?.icon_path) return exact;
		const base = lower.replace(/\s+rune$/i, '');
		const origin = [...assets.originTraits.values()].find((o) => o.name.toLowerCase() === base);
		if (origin) {
			const a = all.find((r) => r.origin_id === origin.id);
			if (a?.icon_path) return a;
		}
		const byBase = all.find((r) => r.name.toLowerCase() === base);
		if (byBase?.icon_path) return byBase;
	}
	return null;
}

/** Rune-slot icon URL, falling back to the generic rune glyph. */
export function runeIconUrl(
	assets: ReturnType<typeof getAssetState>,
	rune: MatSlotSnapshot
): string | null {
	return (
		storageUrl(runeAssetFor(assets, rune)?.icon_path ?? null) ??
		iconPoolUrl(assets.iconPool, RESOURCE_ICON_IDS.rune)
	);
}

/**
 * The Spirit Augment token icon for a given augment CLASS. Augments are derived
 * purely from the 6 augment classes (no catalog rows), so the token uses the
 * CLASS's own icon (`classes.icon_png`), keyed by class name. Returns null if the
 * class isn't loaded or has no icon.
 */
export function augmentIconForClass(
	assets: ReturnType<typeof getAssetState>,
	className: string | null | undefined
): string | null {
	if (!className) return null;
	for (const cls of assets.classTraits.values()) {
		// Prefer the dedicated hexagon Spirit-Augment token art; fall back to the plain
		// class icon if a class has no augment token.
		if (cls.name === className) return storageUrl(cls.augment_token_path ?? cls.icon_png ?? null);
	}
	return null;
}

export function statusIconUrl(
	statusIcons: Map<string, IconPoolEntry>,
	token: string | null | undefined
): string | null {
	if (!token) return null;
	return storageUrl(statusIcons.get(token.toLowerCase())?.file_path ?? null);
}

/** Display-size URL for a Supabase storage path (or pass through a foreign absolute URL). */
export function storageUrl(path: string | null | undefined): string | null {
	return gameImageUrl(path);
}

const ATTACK_DIE_ASSET_NAME: Record<DiceTier, string> = {
	basic: 'Basic Attack',
	enchanted: 'Enchanted Attack',
	exalted: 'Exalted Attack',
	arcane: 'Arcane Attack'
};

/** The same rendered custom-die face used by player info, pickers, and legends. */
export function attackDieImageUrl(
	assets: ReturnType<typeof getAssetState>,
	tier: DiceTier
): string | null {
	const want = ATTACK_DIE_ASSET_NAME[tier].toLowerCase();
	for (const die of assets.customDiceAssets.values()) {
		if (die.name.toLowerCase() !== want) continue;
		const firstFace = die.sides?.slice().sort((a, b) => a.side_number - b.side_number)[0];
		return storageUrl(
			firstFace?.image_path ?? die.background_image_path ?? die.exported_template_path
		);
	}
	return null;
}

/**
 * Icon for one reward token (monster reward tracks): its icon_pool file, else, for an
 * attack-die reward, the rendered die face of that tier (the "Enchanted Attack" token has
 * no icon file in storage).
 */
export function rewardTokenIconUrl(
	assets: ReturnType<typeof getAssetState>,
	token: string
): string | null {
	const icon = iconPoolUrl(assets.iconPool, token);
	if (icon) return icon;
	const meaning = meaningFor(token);
	return meaning?.kind === 'attackDice' ? attackDieImageUrl(assets, meaning.tier) : null;
}

/** Build an id → image-url map for HexGrid from the spirit asset map. */
export function spiritImageMap(spiritAssets: Map<string, HexSpiritAsset>): Map<string, string> {
	const map = new Map<string, string>();
	for (const [id, asset] of spiritAssets) {
		const url = storageUrl(asset.game_print_image_path || asset.art_raw_image_path);
		if (url) map.set(id, url);
	}
	return map;
}

/**
 * Use the active versioned back on the asset record. Retain the legacy path for
 * older catalogs that do not expose a back-side field.
 */
export function spiritBackImageUrl(id: string): string {
	return storageUrl(getAssetState().spiritAssets.get(id)?.back_side_export) ?? gameImageUrl(`hex_spirits/${id}/rework-2026-10-29-card-icons-v2/game-fit-v2/back.png`)!;
}

/**
 * Presentation-only cleanup for raw catalog names that leak internal ids into the
 * UI (the seeded monsters are literally named "S1Monster"). Never used for
 * matching/lookups — those stay on the raw name.
 */
export function displayName(raw: string | null | undefined, fallback = 'Unknown'): string {
	const name = raw?.trim();
	if (!name) return fallback;
	// The monster catalog's "S<stage>Monster" code names.
	const staged = /^s(\d+)monster$/i.exec(name);
	if (staged) return `Stage ${staged[1]} Monster`;
	// Other un-spaced code names (camelCase / letter-digit runs) split into words;
	// anything already containing a space is human-authored and passes through.
	if (/\s/.test(name)) return name;
	return name
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.replace(/(\d)([A-Za-z])/g, '$1 $2');
}

// ── Arcane Abyss monster cards ──────────────────────────────────────────────

export type MonsterDifficulty = 1 | 2 | 3;

export const MONSTER_NUMERAL: Record<MonsterDifficulty, string> = { 1: 'I', 2: 'II', 3: 'III' };

/** One colour per difficulty deck: I cyan, II amber, III magenta. */
export const MONSTER_DIFFICULTY_COLOR: Record<MonsterDifficulty, string> = {
	1: '#5cdfff',
	2: '#ffb54d',
	3: '#ff4fc3'
};

export function monsterDifficulty(card: { difficulty?: MonsterDifficulty } | null | undefined): MonsterDifficulty {
	return card?.difficulty ?? 1;
}

/** The card back of a difficulty deck (static art). */
export function monsterBackUrl(difficulty: MonsterDifficulty): string {
	return `/monster-cards/difficulty-${difficulty}-back.webp`;
}

/**
 * The catalog row's `card_image_path` for a monster card, matched by id and then by name: the
 * finished card face WITH its info (name, stats, rewards), not bare art. See `monsterCardFace`.
 */
export function monsterCatalogCardPath(
	assets: ReturnType<typeof getAssetState>,
	card: { id: string; name: string }
): string | null {
	const byId = assets.monsterAssets.get(card.id);
	const found =
		byId ??
		Array.from(assets.monsterAssets.values()).find(
			(m) => m.name?.toLowerCase() === card.name.toLowerCase()
		);
	return found?.card_image_path ?? null;
}

/** "1–3", or "2" when the range is one value. */
export function rangeText(min: number, max: number): string {
	return min === max ? `${min}` : `${min}–${max}`;
}

/** Deck VP totals: "1–2" when consecutive, "3 / 5" when a value is skipped. */
export function vpText(values: number[], joiner = ' / '): string {
	if (values.length === 0) return '0';
	const min = values[0];
	const max = values[values.length - 1];
	return max - min === values.length - 1 ? rangeText(min, max) : values.join(joiner);
}

const ACCENT_FALLBACK = '#8d8aa1';

export function seatAccent(seat: SeatColor | string | null | undefined): string {
	if (!seat) return ACCENT_FALLBACK;
	return PLAYER_COLOR_HEX[seat as PlayerColor] ?? ACCENT_FALLBACK;
}

const STATUS_ACCENT: Record<string, string> = {
	pure: '#4cba6a',
	purified: '#4cba6a',
	tainted: '#e6c547',
	corrupt: '#a070e0',
	fallen: '#e05858'
};

export function statusAccent(token: string | null | undefined): string {
	if (!token) return ACCENT_FALLBACK;
	return STATUS_ACCENT[token.toLowerCase()] ?? ACCENT_FALLBACK;
}
