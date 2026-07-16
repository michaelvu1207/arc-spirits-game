export type RankId = 'iron' | 'silver' | 'gold' | 'prism' | 'abyss' | 'ascendant';
export type CosmeticKind =
	| 'border' | 'guardianSkin' | 'banner' | 'boardEnvironment' | 'summonTrail'
	| 'cardFinish' | 'nameplate' | 'emote' | 'victoryPose' | 'profileScene';

export interface RankDefinition {
	id: RankId;
	name: string;
	minXp: number;
	accent: string;
	sheetColumn: number;
}

export interface CosmeticItem {
	id: string;
	kind: CosmeticKind;
	name: string;
	shortName: string;
	description: string;
	price: number;
	accent: string;
	rarity: 'common' | 'rare' | 'epic' | 'mythic';
	targetGuardian?: string;
}

export interface ProgressionState {
	credits: number;
	lifetimeCredits: number;
	rankXp: number;
	ownedItemIds: string[];
	equippedBorderId: string | null;
	equippedBannerId: string | null;
	equippedGuardianSkinIds: Record<string, string>;
	equippedBoardEnvironmentId?: string | null;
	equippedSummonTrailId?: string | null;
	equippedCardFinishId?: string | null;
	equippedNameplateId?: string | null;
	equippedEmoteId?: string | null;
	equippedVictoryPoseId?: string | null;
	equippedProfileSceneId?: string | null;
	guardianMastery?: Array<{ guardianName: string; masteryXp: number; masteryLevel: number; gamesPlayed: number; wins: number }>;
	claimedMatchIds: string[];
}

export interface MatchAwardInput {
	matchId: string;
	victoryPoints: number;
	placement: number;
	won: boolean;
	round: number;
}

export interface MatchAward {
	credits: number;
	rankXp: number;
	reason: string;
}

export const PROGRESSION_STORAGE_KEY = 'arc-spirits-progression-v1';

export const RANKS: RankDefinition[] = [
	{ id: 'iron', name: 'Iron', minXp: 0, accent: '#8a7168', sheetColumn: 0 },
	{ id: 'silver', name: 'Silver', minXp: 80, accent: '#b7c8d7', sheetColumn: 1 },
	{ id: 'gold', name: 'Gold', minXp: 180, accent: '#ffba3d', sheetColumn: 2 },
	{ id: 'prism', name: 'Prism', minXp: 320, accent: '#7ae7ff', sheetColumn: 3 },
	{ id: 'abyss', name: 'Abyss', minXp: 520, accent: '#7b1dff', sheetColumn: 4 },
	{ id: 'ascendant', name: 'Ascendant', minXp: 800, accent: '#bdf8ff', sheetColumn: 5 }
];

export const SHOP_ITEMS: CosmeticItem[] = [
	{
		id: 'border-abyssal-thread',
		kind: 'border',
		name: 'Abyssal Thread',
		shortName: 'Thread',
		description: 'A violet-cyan name border for leaderboard and results rows.',
		price: 120,
		accent: '#9d5cff',
		rarity: 'rare'
	},
	{
		id: 'border-lantern-oath',
		kind: 'border',
		name: 'Lantern Oath',
		shortName: 'Oath',
		description: 'An amber oath frame with a restrained shrine-glow edge.',
		price: 160,
		accent: '#ffba3d',
		rarity: 'epic'
	},
	{
		id: 'border-tidal-veil',
		kind: 'border',
		name: 'Tidal Veil',
		shortName: 'Veil',
		description: 'A quiet cyan border tuned for clean leaderboard scanning.',
		price: 70,
		accent: '#24d4ff',
		rarity: 'common'
	},
	{
		id: 'skin-myrtle-voidbloom',
		kind: 'guardianSkin',
		targetGuardian: 'Myrtle',
		name: 'Myrtle Voidbloom',
		shortName: 'Voidbloom',
		description: 'A dark Floral skin treatment for Myrtle portrait frames.',
		price: 220,
		accent: '#ff2bc7',
		rarity: 'mythic'
	},
	{
		id: 'skin-cyber-glass',
		kind: 'guardianSkin',
		targetGuardian: 'Any Guardian',
		name: 'Cyber Glass',
		shortName: 'Cyber',
		description: 'A cyan-magenta glass pass for guardian icons.',
		price: 180,
		accent: '#20e0c1',
		rarity: 'epic'
	},
	{
		id: 'banner-fallen-sigil',
		kind: 'banner',
		name: 'Fallen Sigil',
		shortName: 'Sigil',
		description: 'A postgame banner mark for players who like the dangerous route.',
		price: 260,
		accent: '#5b2dff',
		rarity: 'mythic'
	},
	{
		id: 'environment-lantern-steps', kind: 'boardEnvironment', name: 'Lantern Steps', shortName: 'Lantern',
		description: 'Low-poly lantern fragments and warm shrine facets.', price: 180, accent: '#ffba3d', rarity: 'epic'
	},
	{
		id: 'trail-prismatic-shards', kind: 'summonTrail', name: 'Prismatic Shards', shortName: 'Shards',
		description: 'Faceted shards follow a summoned spirit.', price: 140, accent: '#65f3e1', rarity: 'rare'
	},
	{
		id: 'finish-arcfoil', kind: 'cardFinish', name: 'Arcfoil', shortName: 'Arcfoil',
		description: 'A restrained animated foil edge for spirit cards.', price: 110, accent: '#8ee7ff', rarity: 'rare'
	},
	{
		id: 'nameplate-veilwalker', kind: 'nameplate', name: 'Veilwalker', shortName: 'Veilwalker',
		description: 'A compact low-poly rune nameplate.', price: 90, accent: '#a48cff', rarity: 'common'
	},
	{
		id: 'emote-spirit-bow', kind: 'emote', name: 'Spirit Bow', shortName: 'Bow',
		description: 'A respectful live-match guardian emote.', price: 80, accent: '#f5d08a', rarity: 'common'
	},
	{
		id: 'pose-guardian-rise', kind: 'victoryPose', name: 'Guardian Rise', shortName: 'Rise',
		description: 'A faceted guardian victory stance.', price: 210, accent: '#ff7fd9', rarity: 'epic'
	},
	{
		id: 'profile-arc-sanctum', kind: 'profileScene', name: 'Arc Sanctum', shortName: 'Sanctum',
		description: 'A low-poly profile scene of rings, shards, and spirit light.', price: 240, accent: '#7b1dff', rarity: 'mythic'
	}
];

export function defaultProgression(): ProgressionState {
	return {
		credits: 80,
		lifetimeCredits: 80,
		rankXp: 0,
		ownedItemIds: [],
		equippedBorderId: null,
		equippedBannerId: null,
		equippedGuardianSkinIds: {},
		equippedBoardEnvironmentId: null,
		equippedSummonTrailId: null,
		equippedCardFinishId: null,
		equippedNameplateId: null,
		equippedEmoteId: null,
		equippedVictoryPoseId: null,
		equippedProfileSceneId: null,
		guardianMastery: [],
		claimedMatchIds: []
	};
}

export function rankForXp(xp: number): RankDefinition {
	let current = RANKS[0]!;
	for (const rank of RANKS) {
		if (xp >= rank.minXp) current = rank;
	}
	return current;
}

export function nextRankForXp(xp: number): RankDefinition | null {
	return RANKS.find((rank) => rank.minXp > xp) ?? null;
}

export function calculateMatchAward(input: MatchAwardInput): MatchAward {
	const vp = Math.max(0, Math.floor(input.victoryPoints));
	const placementBonus = input.placement <= 1 ? 60 : input.placement === 2 ? 32 : input.placement === 3 ? 18 : 10;
	const winBonus = input.won ? 40 : 0;
	const roundBonus = Math.min(25, Math.max(0, Math.floor(input.round / 2)));
	const credits = 20 + vp * 3 + placementBonus + winBonus + roundBonus;
	const rankXp = 12 + vp * 2 + Math.round(placementBonus / 2) + (input.won ? 28 : 0);
	return {
		credits,
		rankXp,
		reason: input.won ? 'Victory payout' : `Placement ${input.placement} payout`
	};
}

export function hasItem(state: ProgressionState, itemId: string): boolean {
	return state.ownedItemIds.includes(itemId);
}

export function itemById(itemId: string | null | undefined): CosmeticItem | null {
	if (!itemId) return null;
	return SHOP_ITEMS.find((item) => item.id === itemId) ?? null;
}
