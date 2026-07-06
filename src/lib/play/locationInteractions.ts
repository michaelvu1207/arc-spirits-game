/**
 * Location interactions — derived from each Spirit World location's DB reward
 * rows (`game_locations.reward_rows`). A location's available actions ARE its
 * reward rows: there are no generic Summon/Cultivate/Rest buttons. Each row is
 * one interaction:
 *   • gain  → resolve for free, receiving the listed icons.
 *   • trade → pay the cost icons (runes) to receive the gain icons.
 *   • text  → flavor only, not interactive (skipped here).
 *
 * The engine is pure + offline-testable and works in terms of resolved effects,
 * not raw icon_pool UUIDs. This module is the single place that maps a reward
 * icon id to its meaning. The table below is GENERATED from the live DB
 * (`arc_spirits_assets` schema). Reward-row *content* is read live from
 * `game_locations.reward_rows` (so map changes need no code change); only this
 * icon→meaning table is in code. Icon coverage re-verified against live on
 * 2026-06-17 — refresh it (and the fixtures in locationInteractions.test.ts) if a
 * reward row ever references a NEW icon id not listed below.
 *
 * Shared by the engine (runtime.ts), the UI menu (LocationInteractionMenu) and
 * the bot policy, so all three agree on what each row costs and grants.
 */

import type { GameLocationRewardRow, RewardIconToken, MatSlotSnapshot } from '$lib/types';

export type RewardActionKind = 'spiritWorldSummon' | 'abyssSummon' | 'cultivate' | 'rest';

/** What a single reward-row icon means, once resolved against the catalog. */
export type RewardIconMeaning =
	| { kind: 'action'; action: RewardActionKind; label: string }
	| { kind: 'restoreBarrier'; label: string }
	| { kind: 'originRune'; runeId: string; originId: string; originName: string; runeName: string; label: string }
	| { kind: 'specialRune'; runeId: string; classId: string | null; runeName: string; label: string }
	/** Wildcard for "any one relic": a cost in trades (pay any held relic), a gain
	 *  in monster rewards (choose any one relic). Relic-only — runes/augments never match. */
	| { kind: 'wildcardRelic'; label: string }
	/** Victory points (monster-kill reward token). */
	| { kind: 'victoryPoints'; amount: number; label: string }
	/** "Any basic rune" gain wildcard — choose one of the four origin runes. */
	| { kind: 'anyRune'; label: string };

// ── icon_pool ids (stable DB content) ────────────────────────────────────────
const SUMMON_ICON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const ABYSS_SUMMON_ICON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const CULTIVATE_ICON = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const REST_ICON = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const BARRIER_ICON = '6746f875-a1bc-453c-94b5-718d6ebeb025';
const ARCANE_BARRIER_ICON = 'c22cda08-e1f7-42ba-934b-2e9ffd105c80';
const AVATAR_BARRIER_ICON = '16daf8be-6ae0-4ace-b70c-cbb30e357664';
const ANY_RELIC_ICON = '6a85e06a-52cc-483c-aa59-38395a377307';
// Victory-point reward tokens (monster reward tracks). The live `monsters_v2`
// data uses `victory_point` (1), `2vp` (2), `3vp` (3) and `5vp` (5); `vp_raw` (1)
// appears in the legacy `monsters` table. All map to a flat VP gain.
const VP_RAW_ICON = '24278b1c-c935-4d4e-aed5-408ce9c9a043';
const VP_TWO_ICON = '22e7f408-fa65-417e-a555-56ad87ecb428';
const VP_THREE_ICON = '54a61c34-6e05-44df-a4d1-115e004af31e';
const VP_FIVE_ICON = '9cf8e1dd-55e0-4926-8dc8-2fb5b7b96bd4';
const VICTORY_POINT_ICON = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
// "Any basic rune" wildcard gain — choose one of the four origin runes.
const ANY_RUNE_ICON = '36aab6c9-b98c-4e84-b097-e743f45dde82';

/**
 * Reward-icon → meaning. The single source of truth for reward-row semantics.
 * Generated from icon_pool + runes + origins/classes joins.
 */
export const REWARD_ICON_SEMANTICS: Record<string, RewardIconMeaning> = {
	// Action tokens (uploaded icons; resolving the row performs the action).
	[SUMMON_ICON]: { kind: 'action', action: 'spiritWorldSummon', label: 'Spirit World Summon' },
	[ABYSS_SUMMON_ICON]: { kind: 'action', action: 'abyssSummon', label: 'Arcane Abyss Summon' },
	[CULTIVATE_ICON]: { kind: 'action', action: 'cultivate', label: 'Cultivate' },
	[REST_ICON]: { kind: 'action', action: 'rest', label: 'Rest' },

	// Barrier restore tokens — the plain, arcane-flavored, and avatar barrier icons all
	// RESTORE BARRIER (flip broken barrier tokens back to the barrier side). They do NOT
	// grant max barrier; capacity grows only through class effects (e.g. Cultivator).
	[BARRIER_ICON]: { kind: 'restoreBarrier', label: 'Restore Barrier' },
	[ARCANE_BARRIER_ICON]: { kind: 'restoreBarrier', label: 'Restore Barrier' },
	[AVATAR_BARRIER_ICON]: { kind: 'restoreBarrier', label: 'Restore Barrier' },

	// Wildcard for "any one relic". As a trade COST it is paid by any held relic
	// (runes/augments never qualify); as a monster-reward GAIN the reward builder
	// reinterprets it as "choose any one relic".
	[ANY_RELIC_ICON]: { kind: 'wildcardRelic', label: 'Any relic' },

	// Victory-point reward tokens (monster reward tracks).
	[VP_RAW_ICON]: { kind: 'victoryPoints', amount: 1, label: '1 Victory Point' },
	[VICTORY_POINT_ICON]: { kind: 'victoryPoints', amount: 1, label: '1 Victory Point' },
	[VP_TWO_ICON]: { kind: 'victoryPoints', amount: 2, label: '2 Victory Points' },
	[VP_THREE_ICON]: { kind: 'victoryPoints', amount: 3, label: '3 Victory Points' },
	[VP_FIVE_ICON]: { kind: 'victoryPoints', amount: 5, label: '5 Victory Points' },

	// "Any basic rune" wildcard gain — choose one of the four origin runes.
	[ANY_RUNE_ICON]: { kind: 'anyRune', label: 'Any basic rune' },

	// Origin runes (matched against held runes by originId).
	'87d1f1ad-9c0a-4a65-bb2b-16acebc2d019': {
		kind: 'originRune',
		runeId: '356f3ad2-4cac-4b69-a3cc-7559f8891d8e',
		originId: 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e',
		originName: 'Cyber City',
		runeName: 'Cyber City',
		label: 'Cyber City rune'
	},
	'8dd2b283-122b-4965-9184-f1f84e1216f4': {
		kind: 'originRune',
		runeId: '34b2a963-f8c6-4fc0-8272-ddc50b0036a8',
		originId: 'ad555f03-9b89-4a71-a47c-464fd67d2c05',
		originName: 'Floral Patch',
		runeName: 'Forest',
		label: 'Forest rune'
	},
	'7248cdca-9b03-4951-bfba-a4d17f7b97c8': {
		kind: 'originRune',
		runeId: '480cd5f7-adea-481d-8ea9-aad776599d7b',
		originId: '178449e9-cc6b-45ab-8522-5183fe1d9307',
		originName: 'Lantern Lights',
		runeName: 'Lantern Lights',
		label: 'Lantern Lights rune'
	},
	'4d34484d-4345-448d-b192-a425841ddbc4': {
		kind: 'originRune',
		runeId: '5eba8681-16b8-4563-b017-22c80a84b35b',
		originId: '294cee31-a7ac-4292-9b61-d4293c05c146',
		originName: 'Moon Tide',
		runeName: 'Tidal Tribe',
		label: 'Tidal Tribe rune'
	},

	// Special (class) runes — class-linked.
	'40934631-35fc-4936-943a-c607a9c607be': {
		kind: 'specialRune',
		runeId: 'f1c4f059-61e0-40ad-ad9a-4e25a8531f49',
		classId: 'f5438f3c-2052-4093-b402-893a45cf7046',
		runeName: 'Animal',
		label: 'Animal rune'
	},
	'c9b3225f-c8a9-4aa8-8e43-56c39cf68974': {
		kind: 'specialRune',
		runeId: 'd0b484ed-733c-4d55-b549-30e631eec857',
		classId: '173589ed-9bec-4965-94e6-dadbc6b5310a',
		runeName: 'Sorcerer',
		label: 'Sorcerer rune'
	},
	'88facdb6-3374-4891-af8a-fca2e81b79ef': {
		kind: 'specialRune',
		runeId: '33f343e7-6bdb-43cc-8b27-115eaa16826f',
		classId: '17e08cde-f3d2-480b-8386-1e3047e2f85a',
		runeName: 'Strategist',
		label: 'Strategist rune'
	},
	'66525fe8-e375-4473-b1c3-88d3c9fd2b1c': {
		kind: 'specialRune',
		runeId: 'a844c161-3f67-42d7-ba59-d5efd5df5f98',
		classId: 'aa90084b-a07a-4b00-9448-9f5dae83bd03',
		runeName: 'Support',
		label: 'Support rune'
	},
	'de816c21-aa17-4e41-9217-20511c11e9c9': {
		kind: 'specialRune',
		runeId: 'efa4b29a-06f0-43af-bd11-d60c180e793e',
		classId: 'dd17c072-159c-4b43-831f-1f51bb8b7720',
		runeName: 'Swordsman',
		label: 'Swordsman rune'
	},
	'faa39f61-98ec-4f63-a873-766dc4e111f3': {
		kind: 'specialRune',
		runeId: '44d0b158-8892-42c7-9ce8-1a033da9440d',
		classId: '20d2a252-3655-4839-93a4-04db111c0617',
		runeName: 'Cursed Spirit',
		label: 'Cursed Spirit rune'
	},

	// Named relics — no class FK. As class-less specials they resolve to the 'relic'
	// item kind, so they pay an "Any relic" trade cost.
	'895144a1-e0f6-4bdc-a4db-322423f1b922': {
		kind: 'specialRune',
		runeId: '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86',
		classId: null,
		runeName: 'Firecracker',
		label: 'Firecracker rune'
	},
	'75134075-3347-49de-a740-eb99d20b1f1a': {
		kind: 'specialRune',
		runeId: '690a7e3b-5737-4494-bb8a-b58bee13f473',
		classId: null,
		runeName: 'Flower',
		label: 'Flower rune'
	},
	'ca4df196-67fb-4507-973d-1dfac277953d': {
		kind: 'specialRune',
		runeId: 'ee1486a0-8b61-499c-809b-b4de9920aa8f',
		classId: null,
		runeName: 'Magnet',
		label: 'Magnet rune'
	},
	'c8ef5d48-2289-4fee-a34d-b041d3e8bea6': {
		kind: 'specialRune',
		runeId: 'a6111d01-2c55-4b1f-854a-32887d92b8e1',
		classId: null,
		runeName: 'Teapot',
		label: 'Teapot rune'
	}
};

export function meaningFor(iconId: string): RewardIconMeaning | null {
	return REWARD_ICON_SEMANTICS[iconId] ?? null;
}

/** The four basic origin runes — the options for an "Any basic rune" wildcard gain. */
export function originRuneOptions(): ResolvedRune[] {
	return Object.values(REWARD_ICON_SEMANTICS)
		.filter((m) => m.kind === 'originRune')
		.map(toResolvedRune)
		.filter((r): r is ResolvedRune => r !== null);
}

/**
 * The five RELICS — the game's relic item type (the other type is runes). An "Any relic"
 * wildcard gain lets the player choose one of these. Listed by rune id directly (Fairy
 * has no reward-icon entry but is still a relic).
 */
const RELIC_RUNES: { runeId: string; name: string }[] = [
	{ runeId: 'e02af831-e599-4676-9e37-820d19bfc3e1', name: 'Fairy' },
	{ runeId: 'a6111d01-2c55-4b1f-854a-32887d92b8e1', name: 'Teapot' },
	{ runeId: '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86', name: 'Firecracker' },
	{ runeId: '690a7e3b-5737-4494-bb8a-b58bee13f473', name: 'Flower' },
	{ runeId: 'ee1486a0-8b61-499c-809b-b4de9920aa8f', name: 'Magnet' }
];

export function relicOptions(): ResolvedRune[] {
	return RELIC_RUNES.map((r) => ({
		runeId: r.runeId,
		name: `${r.name} Relic`,
		originId: null,
		classId: null,
		special: true,
		type: 'relic' as const
	}));
}

/**
 * The basic origin rune (if any) for an origin display name — the key used in
 * `spirit.origins` (e.g. "Floral Patch", "Cyber City"). Only the FOUR core origins
 * with a rune (Cyber City / Floral Patch / Lantern Lights / Moon Tide) resolve; every
 * other origin (Royal Family, Human Enclave, Abyss, …) returns null. The Cultivate
 * action uses this to grant origin runes per the player's spirit origins.
 */
export function originRuneForName(originName: string): ResolvedRune | null {
	for (const m of Object.values(REWARD_ICON_SEMANTICS)) {
		if (m.kind === 'originRune' && m.originName === originName) return toResolvedRune(m);
	}
	return null;
}

// ── Resolved interaction model ────────────────────────────────────────────────

/** A rune as it will be added to a player's rune slots when gained. */
export interface ResolvedRune {
	runeId: string;
	name: string;
	originId: string | null;
	classId: string | null;
	/** True for class augments + relics. (Relics also have type==='relic', which is what
	 *  actually pays an "Any relic" trade cost; this flag is only a display/data hint.) */
	special: boolean;
	/** Mat-item kind stored on the slot: origin `rune`, class `augment`, or `relic`. */
	type: 'rune' | 'augment' | 'relic';
}

export type GainEffect =
	| { type: 'action'; action: RewardActionKind }
	| { type: 'restoreBarrier'; amount: number }
	| { type: 'rune'; rune: ResolvedRune }
	/** Victory points (monster-kill reward). */
	| { type: 'vp'; amount: number }
	/** Player/bot picks one of `options` (an "or" gain). */
	| { type: 'chooseRune'; options: ResolvedRune[] };

export type CostRequirement =
	| { match: 'origin'; originId: string; originName: string; label: string }
	| { match: 'specialRune'; runeId: string; runeName: string; label: string }
	/** "Pay any one relic" — satisfied ONLY by a held relic (type==='relic'). */
	| { match: 'anyRelic'; label: string }
	/** "Pay any one basic rune" — satisfied by any held origin rune. */
	| { match: 'anyBasic'; label: string };

export interface LocationInteraction {
	rowIndex: number;
	kind: 'gain' | 'trade';
	cost: CostRequirement[];
	gains: GainEffect[];
	/** Raw tokens, kept for icon rendering in the UI. */
	costTokens: RewardIconToken[];
	gainTokens: RewardIconToken[];
}

export function toResolvedRune(m: RewardIconMeaning): ResolvedRune | null {
	if (m.kind === 'originRune') {
		return {
			runeId: m.runeId,
			name: `${m.originName} Rune`,
			originId: m.originId,
			classId: null,
			special: false,
			type: 'rune'
		};
	}
	if (m.kind === 'specialRune') {
		return {
			runeId: m.runeId,
			name: m.runeName,
			originId: null,
			classId: m.classId,
			special: true,
			// Class-linked specials are spirit augments; class-less specials
			// (Fairy / Teapot / Firecracker / Flower / Magnet) are RELICS — one of the game's
			// two item types (the other being runes), held in rune slots.
			type: m.classId ? 'augment' : 'relic'
		};
	}
	return null;
}

function gainEffectFor(token: RewardIconToken): GainEffect | null {
	if (typeof token !== 'string') {
		// "or" choice — all options are runes in the data; keep only the runes.
		const options = token.icon_ids
			.map((id) => {
				const m = meaningFor(id);
				return m ? toResolvedRune(m) : null;
			})
			.filter((r): r is ResolvedRune => r !== null);
		return options.length > 0 ? { type: 'chooseRune', options } : null;
	}
	const m = meaningFor(token);
	if (!m) return null;
	switch (m.kind) {
		case 'action':
			return { type: 'action', action: m.action };
		case 'restoreBarrier':
			return { type: 'restoreBarrier', amount: 1 };
		case 'victoryPoints':
			return { type: 'vp', amount: m.amount };
		case 'anyRune':
			return { type: 'chooseRune', options: originRuneOptions() };
		case 'originRune':
		case 'specialRune': {
			const rune = toResolvedRune(m);
			return rune ? { type: 'rune', rune } : null;
		}
		case 'wildcardRelic':
			return null; // wildcard is a cost, never a gain (monster rewards handle it separately)
	}
}

function costRequirementFor(token: RewardIconToken): CostRequirement | null {
	// Costs in the data are always single icons; fall back to the first option of
	// an "or" cost for forward-compatibility.
	const id = typeof token === 'string' ? token : token.icon_ids[0];
	if (!id) return null;
	const m = meaningFor(id);
	if (!m) return null;
	switch (m.kind) {
		case 'wildcardRelic':
			return { match: 'anyRelic', label: m.label };
		case 'anyRune':
			// "Any basic rune" — a gain wildcard when on the gain side, a "pay any one
			// origin rune" requirement when on the cost side.
			return { match: 'anyBasic', label: m.label };
		case 'originRune':
			return { match: 'origin', originId: m.originId, originName: m.originName, label: m.label };
		case 'specialRune':
			return { match: 'specialRune', runeId: m.runeId, runeName: m.runeName, label: m.label };
		default:
			return null; // actions/restoreBarrier are never costs
	}
}

/** Convert a location's reward rows into resolved, interactive interactions. */
export function buildLocationInteractions(
	rewardRows: GameLocationRewardRow[] | null | undefined
): LocationInteraction[] {
	const out: LocationInteraction[] = [];
	(rewardRows ?? []).forEach((row, rowIndex) => {
		if (row.type === 'text') return;
		const gains = row.gain_icon_ids
			.map(gainEffectFor)
			.filter((g): g is GainEffect => g !== null);
		if (gains.length === 0) return; // nothing resolvable to grant
		const costTokens = row.type === 'trade' ? row.cost_icon_ids : [];
		const cost =
			row.type === 'trade'
				? costTokens
						.map(costRequirementFor)
						.filter((c): c is CostRequirement => c !== null)
				: [];
		out.push({
			rowIndex,
			kind: row.type,
			cost,
			gains,
			costTokens,
			gainTokens: row.gain_icon_ids
		});
	});
	return out;
}

// ── Cost matching against held runes ──────────────────────────────────────────

/**
 * A held rune slot is a RELIC (payable for an "Any relic" cost) ONLY if its item kind is
 * 'relic'. Relics are the named relics (Firecracker / Flower / Magnet / Teapot) AND the
 * starting Fairy Relic every player begins with. A rune NEVER pays a relic cost and a
 * class augment never sits in the spendable pool, so neither one matches.
 */
export function isRelic(slot: MatSlotSnapshot): boolean {
	return slot.type === 'relic';
}

export function slotSatisfies(slot: MatSlotSnapshot, req: CostRequirement): boolean {
	switch (req.match) {
		case 'origin':
			return slot.originId === req.originId || slot.name === `${req.originName} Rune`;
		case 'specialRune':
			return slot.id === req.runeId || slot.name === req.runeName;
		case 'anyRelic':
			// Relic-only: a rune or augment can never pay an "Any relic" cost.
			return isRelic(slot);
		case 'anyBasic':
			// A basic rune is an origin rune (Cyber / Forest / Lantern / Tidal) — it
			// carries an origin and is not a relic.
			return slot.originId != null && !isRelic(slot);
	}
}

/** A wildcard cost ("any relic" / "any basic rune") is the only kind where the
 *  player has a meaningful choice of WHICH held item to discard — specific costs
 *  resolve to identical/interchangeable runes. */
export function isWildcardCost(req: CostRequirement): boolean {
	return req.match === 'anyRelic' || req.match === 'anyBasic';
}

/** Array indices into `mats` of every held slot that could pay `req` — the options
 *  the UI offers when letting the player pick which item to discard. */
export function eligibleCostSlots(req: CostRequirement, mats: MatSlotSnapshot[]): number[] {
	const out: number[] = [];
	mats.forEach((slot, i) => {
		if (slot.hasRune && slotSatisfies(slot, req)) out.push(i);
	});
	return out;
}

export interface CostMatch {
	ok: boolean;
	/** Array indices into `runes` to consume (set hasRune=false). */
	consumedArrayIndexes: number[];
}

/**
 * Greedily assign held runes to the cost requirements. Specific requirements
 * (origin / named) are assigned before the wildcards so a wildcard never "steals"
 * a rune a specific requirement needs.
 *
 * `preferred` is an optional list of player-chosen array indices: for a WILDCARD
 * requirement we discard the player's pick (when it's valid, unused, and satisfies
 * the wildcard) instead of greedily grabbing the first match. Invalid/missing picks
 * fall back to the greedy choice, so callers (bots, specific costs) that pass nothing
 * keep the original behavior.
 */
export function matchRewardCost(
	cost: CostRequirement[],
	runes: MatSlotSnapshot[],
	preferred: number[] = []
): CostMatch {
	if (cost.length === 0) return { ok: true, consumedArrayIndexes: [] };

	const available = runes
		.map((slot, arrayIndex) => ({ slot, arrayIndex }))
		.filter((entry) => entry.slot.hasRune);
	const byIndex = new Map(available.map((entry) => [entry.arrayIndex, entry]));

	const used = new Set<number>();
	// Specific requirements first; wildcards ('anyRelic' / 'anyBasic') last so they
	// never steal a rune a specific requirement needs. The two wildcards match
	// disjoint pools (relics vs. basic/origin runes), so their order is immaterial.
	const ordered = [...cost].sort((a, b) => Number(isWildcardCost(a)) - Number(isWildcardCost(b)));

	for (const req of ordered) {
		let hit: { slot: MatSlotSnapshot; arrayIndex: number } | undefined;
		// Honor the player's explicit discard pick for a wildcard cost.
		if (isWildcardCost(req)) {
			for (const i of preferred) {
				const entry = byIndex.get(i);
				if (entry && !used.has(entry.arrayIndex) && slotSatisfies(entry.slot, req)) {
					hit = entry;
					break;
				}
			}
		}
		if (!hit) {
			hit = available.find((entry) => !used.has(entry.arrayIndex) && slotSatisfies(entry.slot, req));
		}
		if (!hit) return { ok: false, consumedArrayIndexes: [] };
		used.add(hit.arrayIndex);
	}
	return { ok: true, consumedArrayIndexes: [...used] };
}

export function canAfford(interaction: LocationInteraction, runes: MatSlotSnapshot[]): boolean {
	return matchRewardCost(interaction.cost, runes).ok;
}

/**
 * For each cost requirement (in ORIGINAL cost order), the mats array index auto-match
 * would spend to pay it — the pre-fill the payment takeover shows before the player
 * overrides a wildcard slot. Mirrors {@link matchRewardCost}'s greedy assignment
 * (specific requirements claim their mats before wildcards) so the pre-fill never
 * disagrees with what an un-chosen resolve actually consumes. An entry is `null` when
 * the cost cannot currently be paid (no mat left for that slot). Returns `[]` for a
 * free (no-cost) row.
 */
export function autoPickCostSlots(cost: CostRequirement[], mats: MatSlotSnapshot[]): (number | null)[] {
	const picks: (number | null)[] = cost.map(() => null);
	if (cost.length === 0) return picks;

	const used = new Set<number>();
	// Assign specific requirements before wildcards (same priority as matchRewardCost),
	// but record each pick against its ORIGINAL cost index so the caller sees cost order.
	const order = cost
		.map((req, costIndex) => ({ req, costIndex }))
		.sort((a, b) => Number(isWildcardCost(a.req)) - Number(isWildcardCost(b.req)));

	for (const { req, costIndex } of order) {
		for (let arrayIndex = 0; arrayIndex < mats.length; arrayIndex += 1) {
			const slot = mats[arrayIndex];
			if (!slot?.hasRune || used.has(arrayIndex)) continue;
			if (!slotSatisfies(slot, req)) continue;
			used.add(arrayIndex);
			picks[costIndex] = arrayIndex;
			break;
		}
	}
	return picks;
}
