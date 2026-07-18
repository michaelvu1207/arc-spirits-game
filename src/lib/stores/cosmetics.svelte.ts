import { browser } from '$app/environment';
import { auth } from '$lib/auth/auth.svelte';
import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
import {
	SHOP_ITEMS,
	defaultProgression,
	itemById,
	nextRankForXp,
	rankForXp,
	type CosmeticItem,
	type ProgressionState,
} from '$lib/cosmetics/progression';

let progression = $state<ProgressionState>(defaultProgression());
let loaded = false;
let syncing: Promise<ProgressionState> | null = null;

function normalize(raw: unknown): ProgressionState {
	const fallback = defaultProgression();
	if (!raw || typeof raw !== 'object') return fallback;
	const value = raw as Partial<ProgressionState>;
	return {
		credits: Math.max(0, Number(value.credits ?? fallback.credits) || 0),
		lifetimeCredits: Math.max(0, Number(value.lifetimeCredits ?? fallback.lifetimeCredits) || 0),
		rankXp: Math.max(0, Number(value.rankXp ?? fallback.rankXp) || 0),
		ownedItemIds: Array.isArray(value.ownedItemIds)
			? value.ownedItemIds.filter((id): id is string => typeof id === 'string')
			: [],
		equippedBorderId: typeof value.equippedBorderId === 'string' ? value.equippedBorderId : null,
		equippedBannerId: typeof value.equippedBannerId === 'string' ? value.equippedBannerId : null,
		equippedGuardianSkinIds:
			value.equippedGuardianSkinIds && typeof value.equippedGuardianSkinIds === 'object'
				? Object.fromEntries(
						Object.entries(value.equippedGuardianSkinIds).filter(
							([key, id]) => typeof key === 'string' && typeof id === 'string'
						)
					)
				: {},
		equippedBoardEnvironmentId: typeof value.equippedBoardEnvironmentId === 'string' ? value.equippedBoardEnvironmentId : null,
		equippedSummonTrailId: typeof value.equippedSummonTrailId === 'string' ? value.equippedSummonTrailId : null,
		equippedCardFinishId: typeof value.equippedCardFinishId === 'string' ? value.equippedCardFinishId : null,
		equippedNameplateId: typeof value.equippedNameplateId === 'string' ? value.equippedNameplateId : null,
		equippedEmoteId: typeof value.equippedEmoteId === 'string' ? value.equippedEmoteId : null,
		equippedVictoryPoseId: typeof value.equippedVictoryPoseId === 'string' ? value.equippedVictoryPoseId : null,
		equippedProfileSceneId: typeof value.equippedProfileSceneId === 'string' ? value.equippedProfileSceneId : null,
		guardianMastery: Array.isArray(value.guardianMastery) ? value.guardianMastery : [],
		claimedMatchIds: Array.isArray(value.claimedMatchIds)
			? value.claimedMatchIds.filter((id): id is string => typeof id === 'string')
			: []
	};
}

export function loadCosmetics(): ProgressionState {
	if (loaded) return progression;
	loaded = true;
	// Never hydrate currency/ownership from localStorage: those values are canonical
	// server state. The default is a paint-only placeholder until the authenticated
	// reconciliation request returns.
	if (browser) void syncCosmetics().catch(() => {});
	return progression;
}

async function progressionRequest(path: string, method = 'GET', body?: Record<string, unknown>): Promise<ProgressionState> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (body) headers['content-type'] = 'application/json';
	if (isCrossOrigin && auth.session?.access_token) headers.Authorization = `Bearer ${auth.session.access_token}`;
	const response = await fetch(apiUrl(path), {
		method, headers, body: body ? JSON.stringify(body) : undefined,
		credentials: isCrossOrigin ? 'include' : 'same-origin'
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(typeof payload?.message === 'string' ? payload.message : 'Progression request failed.');
	progression = normalize(payload);
	return progression;
}

export function syncCosmetics(): Promise<ProgressionState> {
	if (!browser) return Promise.resolve(progression);
	if (syncing) return syncing;
	// Layout children can ask for cosmetics before the auth store has finished
	// restoring/creating the canonical identity. Firing the protected endpoint in
	// that gap produces a noisy 401 and can briefly paint ownership as an error.
	// Wait for the one shared auth initialization fence, then fetch only when a
	// real (permanent or anonymous) identity exists.
	syncing = (async () => {
		await auth.whenInitialized();
		if (!auth.isSignedIn) return progression;
		return progressionRequest('/api/play/progression');
	})().finally(() => { syncing = null; });
	return syncing;
}

export function getCosmeticsState() {
	loadCosmetics();
	return {
		get progression() {
			return progression;
		},
		get rank() {
			return rankForXp(progression.rankXp);
		},
		get nextRank() {
			return nextRankForXp(progression.rankXp);
		},
		get equippedBorder() {
			return itemById(progression.equippedBorderId);
		},
		get equippedBanner() {
			return itemById(progression.equippedBannerId);
		}
	};
}

export async function buyItem(itemId: string): Promise<{ ok: true; item: CosmeticItem } | { ok: false; message: string }> {
	const item = SHOP_ITEMS.find((entry) => entry.id === itemId);
	if (!item) return { ok: false, message: 'That cosmetic is no longer in the shop.' };
	try {
		await progressionRequest('/api/play/progression/purchase', 'POST', { itemId });
		return { ok: true, item };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Purchase failed.' };
	}
}

export async function equipItem(itemId: string, guardianName?: string): Promise<{ ok: true; item: CosmeticItem } | { ok: false; message: string }> {
	const item = SHOP_ITEMS.find((entry) => entry.id === itemId);
	if (!item) return { ok: false, message: 'That cosmetic is unavailable.' };
	try {
		await progressionRequest('/api/play/progression/equip', 'POST', { itemId, guardianName });
		return { ok: true, item };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Equip failed.' };
	}
}
