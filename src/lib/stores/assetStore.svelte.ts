/**
 * Asset store using Svelte 5 runes
 * Manages spirit and guardian assets for display
 */

import { fetchAssetsData } from '$lib/supabase';
import { gameImageUrl } from '$lib/storageImages';
import { preloadImages } from '$lib/utils/preloadImages';
import { prefersReducedData } from '$lib/play/dataSaver';
import type {
	HexSpiritAsset,
	GuardianAsset,
	MatAsset,
	CustomDiceAsset,
	MonsterAsset,
	IconPoolEntry,
	GameLocationAsset,
	ClassTrait,
	OriginTrait,
	ResolvedSpiritAsset,
	ResolvedGuardianAsset
} from '$lib/types';

// Reactive state using Svelte 5 runes
let spiritAssets = $state<Map<string, HexSpiritAsset>>(new Map());
let matAssets = $state<Map<string, MatAsset>>(new Map());
let customDiceAssets = $state<Map<string, CustomDiceAsset>>(new Map());
let monsterAssets = $state<Map<string, MonsterAsset>>(new Map());
let guardianAssets = $state<Map<string, GuardianAsset>>(new Map());
let classTraits = $state<Map<string, ClassTrait>>(new Map());
let originTraits = $state<Map<string, OriginTrait>>(new Map());
let statusIcons = $state<Map<string, IconPoolEntry>>(new Map()); // key: normalized status token (e.g. "corrupt")
let iconPool = $state<Map<string, IconPoolEntry>>(new Map()); // key: icon_pool id
let gameLocations = $state<Map<string, GameLocationAsset>>(new Map()); // key: location name
let isLoaded = $state<boolean>(false);
let isLoading = $state<boolean>(false);
let error = $state<string | null>(null);

// Image cache warming — separate from data loading so only the play board gates
// on it (the other routes consume asset data without waiting for every image).
let imagesReady = $state<boolean>(false);
let imageProgress = $state<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
let imagePreloadStarted = false;

// Display-size URL for a storage path (see storageImages.ts — originals are print-size).
function getStorageUrl(path: string | null): string | null {
	return gameImageUrl(path);
}

function statusKeyFromIconName(name: string): string | null {
	const match = name.toLowerCase().match(/^status_\d+_(.+)$/);
	return match?.[1] ?? null;
}

// Load all assets from Supabase
export async function loadAssets() {
	if (isLoaded || isLoading) return;

	isLoading = true;
	error = null;

	try {
		const assets = await fetchAssetsData();

		// Build maps
		const newSpirits = new Map<string, HexSpiritAsset>();
		for (const spirit of assets.spirits) {
			newSpirits.set(spirit.id, spirit);
		}
		spiritAssets = newSpirits;

		const newMats = new Map<string, MatAsset>();
		for (const mat of assets.mats) {
			newMats.set(mat.id, mat);
		}
		matAssets = newMats;

		const newCustomDice = new Map<string, CustomDiceAsset>();
		for (const die of assets.customDice) {
			newCustomDice.set(die.id, die);
		}
		customDiceAssets = newCustomDice;

		const newMonsters = new Map<string, MonsterAsset>();
		for (const monster of assets.monsters) {
			newMonsters.set(monster.id, monster);
		}
		monsterAssets = newMonsters;

		const newGuardians = new Map<string, GuardianAsset>();
		for (const guardian of assets.guardians) {
			newGuardians.set(guardian.name, guardian); // Keyed by name for easy lookup
		}
		guardianAssets = newGuardians;

		const newClasses = new Map<string, ClassTrait>();
		for (const cls of assets.classes) {
			newClasses.set(cls.id, cls);
		}
		classTraits = newClasses;

		const newOrigins = new Map<string, OriginTrait>();
		for (const origin of assets.origins) {
			newOrigins.set(origin.id, origin);
		}
		originTraits = newOrigins;

		const newStatusIcons = new Map<string, IconPoolEntry>();
		for (const icon of assets.statusIcons) {
			const key = statusKeyFromIconName(icon.name) ?? icon.name.toLowerCase();
			newStatusIcons.set(key, icon);
		}
		statusIcons = newStatusIcons;

		const newIconPool = new Map<string, IconPoolEntry>();
		for (const icon of assets.iconPool) newIconPool.set(icon.id, icon);
		iconPool = newIconPool;

		const newLocations = new Map<string, GameLocationAsset>();
		for (const loc of assets.gameLocations) newLocations.set(loc.name, loc);
		gameLocations = newLocations;

		isLoaded = true;
	} catch (e) {
		error = e instanceof Error ? e.message : 'Failed to load assets';
		console.error('Error loading assets:', e);
	} finally {
		isLoading = false;
	}
}

// Gather every *compressed* game image URL from the loaded asset maps. For
// spirits we deliberately take only `game_print_image_path` (the print-ready,
// compressed art) and never `art_raw_image_path` (the heavy raw source). All
// other asset types have a single, already-lightweight image variant.
function collectCompressedImageUrls(): string[] {
	const urls = new Set<string>();
	const add = (path: string | null | undefined) => {
		const url = getStorageUrl(path ?? null);
		if (url) urls.add(url);
	};

	for (const spirit of spiritAssets.values()) add(spirit.game_print_image_path); // compressed only
	for (const mat of matAssets.values()) add(mat.icon_path);
	for (const die of customDiceAssets.values()) {
		add(die.background_image_path);
		add(die.template_image_path);
		add(die.exported_template_path);
		for (const side of die.sides) add(side.image_path);
	}
	// Monster card faces are NOT preloaded: 108 printed cards, of which a player sees a few.
	// MonsterCard loads a face when its card is dealt and draws the card until it is in.
	for (const icon of statusIcons.values()) add(icon.file_path);
	for (const icon of iconPool.values()) add(icon.file_path);
	for (const loc of gameLocations.values()) add(loc.background_image_path);
	for (const guardian of guardianAssets.values()) {
		add(guardian.icon_image_path);
		add(guardian.image_mat_path);
		add(guardian.chibi_image_path);
	}
	for (const cls of classTraits.values()) {
		add(cls.icon_png);
		add(cls.augment_token_path);
	}
	for (const origin of originTraits.values()) {
		add(origin.icon_png);
		add(origin.icon_token_png);
	}

	return [...urls];
}

/**
 * Warm the browser cache with every compressed game image. Loads asset data
 * first if needed, then preloads. Safe to call repeatedly — only the first call
 * does work; a call aborted before completion (e.g. unmount) may be retried.
 */
export async function preloadAssetImages(signal?: AbortSignal): Promise<void> {
	if (imagePreloadStarted) return;
	imagePreloadStarted = true;

	try {
		if (!isLoaded) await loadAssets();
		if (signal?.aborted) return;

		// On metered/slow connections reduce concurrency and use a tighter per-image
		// timeout so a stalled asset can't block the game for too long.
		const slowLink = prefersReducedData();
		await preloadImages(collectCompressedImageUrls(), {
			concurrency: slowLink ? 3 : 8,
			timeoutMs: slowLink ? 5000 : 8000,
			signal,
			onProgress: (p) => {
				imageProgress = p;
			}
		});

		if (!signal?.aborted) imagesReady = true;
	} finally {
		// Allow a fresh attempt if we bailed out before finishing.
		if (!imagesReady) imagePreloadStarted = false;
	}
}

/**
 * E2E hook: load asset DATA (the JSON the board needs to render) but SKIP the
 * bandwidth-heavy image preload, marking the board ready as soon as data is in.
 * Playwright drives this via `?e2e` on the room URL so the suite isn't gated on (and
 * starved by) caching ~240 images from storage — the game logic under test renders
 * fine with placeholder art. Production paths never call this.
 */
export async function loadAssetDataSkipImages(): Promise<void> {
	if (!isLoaded) await loadAssets();
	imagePreloadStarted = true; // block the real preloader from also saturating the network
	imageProgress = { loaded: 0, total: 0 };
	imagesReady = true;
}

// Get a resolved spirit asset by ID
export function getSpiritAsset(spiritId: string): ResolvedSpiritAsset | null {
	const spirit = spiritAssets.get(spiritId);
	if (!spirit) return null;

	// Resolve class and origin traits
	const resolvedClasses: ClassTrait[] = [];
	const resolvedOrigins: OriginTrait[] = [];

	if (spirit.traits?.class_ids) {
		for (const classId of spirit.traits.class_ids) {
			const cls = classTraits.get(classId);
			if (cls) resolvedClasses.push(cls);
		}
	}

	if (spirit.traits?.origin_ids) {
		for (const originId of spirit.traits.origin_ids) {
			const origin = originTraits.get(originId);
			if (origin) resolvedOrigins.push(origin);
		}
	}

	return {
		id: spirit.id,
		name: spirit.name,
		cost: spirit.cost,
		imageUrl: getStorageUrl(spirit.game_print_image_path || spirit.art_raw_image_path),
		traits: {
			classes: resolvedClasses,
			origins: resolvedOrigins
		}
	};
}

// Get a resolved guardian asset by name
export function getGuardianAsset(guardianName: string): ResolvedGuardianAsset | null {
	const guardian = guardianAssets.get(guardianName);
	if (!guardian) return null;

	const origin = guardian.origin_id ? originTraits.get(guardian.origin_id) : null;

	return {
		id: guardian.id,
		name: guardian.name,
		iconUrl: getStorageUrl(guardian.icon_image_path),
		matUrl: getStorageUrl(guardian.image_mat_path),
		chibiUrl: getStorageUrl(guardian.chibi_image_path),
		origin: origin ?? null
	};
}

// Get class trait by ID
export function getClassTrait(classId: string): ClassTrait | null {
	return classTraits.get(classId) ?? null;
}

// Get origin trait by ID
export function getOriginTrait(originId: string): OriginTrait | null {
	return originTraits.get(originId) ?? null;
}

export function getCustomDiceAsset(diceId: string): CustomDiceAsset | null {
	return customDiceAssets.get(diceId) ?? null;
}

// Export reactive getters for use in components
export function getAssetState() {
	return {
		get spiritAssets() {
			return spiritAssets;
		},
		get matAssets() {
			return matAssets;
		},
		get customDiceAssets() {
			return customDiceAssets;
		},
		get monsterAssets() {
			return monsterAssets;
		},
		get guardianAssets() {
			return guardianAssets;
		},
		get classTraits() {
			return classTraits;
		},
		get originTraits() {
			return originTraits;
		},
		get statusIcons() {
			return statusIcons;
		},
		get iconPool() {
			return iconPool;
		},
		get gameLocations() {
			return gameLocations;
		},
		get isLoaded() {
			return isLoaded;
		},
		get isLoading() {
			return isLoading;
		},
		get imagesReady() {
			return imagesReady;
		},
		get imageProgress() {
			return imageProgress;
		},
		get error() {
			return error;
		}
	};
}
