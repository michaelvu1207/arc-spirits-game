import { browser } from '$app/environment';
import {
	PROGRESSION_STORAGE_KEY,
	SHOP_ITEMS,
	calculateMatchAward,
	defaultProgression,
	hasItem,
	itemById,
	nextRankForXp,
	rankForXp,
	type CosmeticItem,
	type MatchAward,
	type MatchAwardInput,
	type ProgressionState,
	type RankDefinition
} from '$lib/cosmetics/progression';

type ClaimResult =
	| { claimed: true; award: MatchAward; previousRank: RankDefinition; currentRank: RankDefinition }
	| { claimed: false; award: null; previousRank: null; currentRank: null };

let progression = $state<ProgressionState>(defaultProgression());
let loaded = false;

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
		claimedMatchIds: Array.isArray(value.claimedMatchIds)
			? value.claimedMatchIds.filter((id): id is string => typeof id === 'string')
			: []
	};
}

function save() {
	if (!browser) return;
	localStorage.setItem(PROGRESSION_STORAGE_KEY, JSON.stringify(progression));
}

export function loadCosmetics(): ProgressionState {
	if (loaded) return progression;
	loaded = true;
	if (!browser) return progression;
	try {
		progression = normalize(JSON.parse(localStorage.getItem(PROGRESSION_STORAGE_KEY) ?? 'null'));
	} catch {
		progression = defaultProgression();
	}
	save();
	return progression;
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

export function buyItem(itemId: string): { ok: true; item: CosmeticItem } | { ok: false; message: string } {
	loadCosmetics();
	const item = SHOP_ITEMS.find((entry) => entry.id === itemId);
	if (!item) return { ok: false, message: 'That cosmetic is no longer in the shop.' };
	if (hasItem(progression, item.id)) return { ok: false, message: 'Already owned.' };
	if (progression.credits < item.price) return { ok: false, message: 'Not enough Abyss Credits.' };
	progression = {
		...progression,
		credits: progression.credits - item.price,
		ownedItemIds: [...progression.ownedItemIds, item.id]
	};
	save();
	return { ok: true, item };
}

export function equipItem(itemId: string): { ok: true; item: CosmeticItem } | { ok: false; message: string } {
	loadCosmetics();
	const item = SHOP_ITEMS.find((entry) => entry.id === itemId);
	if (!item) return { ok: false, message: 'That cosmetic is unavailable.' };
	if (!hasItem(progression, item.id)) return { ok: false, message: 'Buy this cosmetic before equipping it.' };

	if (item.kind === 'border') {
		progression = { ...progression, equippedBorderId: item.id };
	} else if (item.kind === 'banner') {
		progression = { ...progression, equippedBannerId: item.id };
	} else {
		const key = item.targetGuardian ?? 'Any Guardian';
		progression = {
			...progression,
			equippedGuardianSkinIds: { ...progression.equippedGuardianSkinIds, [key]: item.id }
		};
	}
	save();
	return { ok: true, item };
}

export function claimMatchAward(input: MatchAwardInput): ClaimResult {
	loadCosmetics();
	if (progression.claimedMatchIds.includes(input.matchId)) {
		return { claimed: false, award: null, previousRank: null, currentRank: null };
	}
	const award = calculateMatchAward(input);
	const previousRank = rankForXp(progression.rankXp);
	const currentRank = rankForXp(progression.rankXp + award.rankXp);
	progression = {
		...progression,
		credits: progression.credits + award.credits,
		lifetimeCredits: progression.lifetimeCredits + award.credits,
		rankXp: progression.rankXp + award.rankXp,
		claimedMatchIds: [...progression.claimedMatchIds, input.matchId].slice(-80)
	};
	save();
	return { claimed: true, award, previousRank, currentRank };
}
