import { BASE_RUNES, RELIC_TO_RUNE } from './baseRunes';
/**
 * Monster-kill rewards — derived from a monster's `reward_track` (a flat list of
 * icon_pool tokens). Defeating the Arcane Abyss monster grants EVERY token on the
 * card (owner rule, 2026-11-03: no "choose 2"). A "choose a rune" token still asks
 * the player which rune.
 *
 * Reward semantics reuse the single source of truth in `locationInteractions.ts`
 * (`REWARD_ICON_SEMANTICS`). The one contextual difference: the "Any relic" and
 * "Any basic rune" wildcard icons are COSTS in a location trade row, but as a
 * monster reward they are GAINS — "choose any one of these items". This module is
 * the single place that maps a monster reward token to its claimable effect, so
 * the engine (runtime.ts), the UI menu (MonsterRewardMenu) and the bot policy all
 * agree.
 */

import {
	meaningFor,
	toResolvedRune,
	originRuneOptions,
	relicOptions,
	type GainEffect
} from './locationInteractions';
import { RELIC_TOOLS } from './effects/relicTools';

/** One selectable reward in a monster's pool. */
export interface MonsterRewardOption {
	/** Position in the monster's `rewardTrack` — the stable id the player picks by. */
	index: number;
	/** icon_pool id, kept for rendering the reward glyph. */
	token: string;
	/** Resolved, claimable effect. */
	effect: GainEffect;
	/** Human-readable label (e.g. "3 Victory Points", "Arcane Abyss Summon"). */
	label: string;
}

/**
 * Resolve one reward-track icon to its claimable gain effect, or null if the icon
 * has no engine meaning. Unlike the location `gainEffectFor`, the wildcard tokens
 * resolve to rune CHOICES (they are gains here, not costs).
 */
function downgradedRune(rune: ReturnType<typeof relicOptions>[number]) {
 const runeId=RELIC_TO_RUNE[rune.runeId];
 const base=runeId ? BASE_RUNES[runeId] : undefined;
 return base ? {...rune,runeId,name:base.name,originId:base.originId,classId:null,special:false,type:'rune' as const} : rune;
}

export function monsterGainFor(iconId: string): GainEffect | null {
	const m = meaningFor(iconId);
	if (!m) return null;
	switch (m.kind) {
		case 'navigationPower': return null;
		case 'victoryPoints':
			return { type: 'vp', amount: m.amount };
		case 'attackDice':
			// One die-face token = one attack die of that tier (owner rule, 2026-11-11).
			return { type: 'attackDice', tier: m.tier, amount: m.amount };
		case 'action':
			return { type: 'action', action: m.action };
		case 'gainMaxBarrier':
			return { type: 'gainMaxBarrier', amount: 1 };
		case 'restoreBarrier':
			return { type: 'restoreBarrier', amount: 1 };
		case 'anyRune':
			return { type: 'chooseRune', options: originRuneOptions() };
		case 'wildcardRelic':
			// "Any relic" gain — choose one of the five relics. No rule yet says which relic
			// tools it may give, so it keeps its earlier mapping to a basic rune.
			return { type: 'chooseRune', options: relicOptions().map(downgradedRune) };
		case 'originRune':
		case 'specialRune': {
			const rune = toResolvedRune(m);
			if (!rune) return null;
			// A named relic on the card (Firecracker, Flower, Diamond, Cleansing Teapot) gives that
			// relic (owner rule, 2026-11-12); `addGainedRune` makes it a relic tool.
			return { type: 'rune', rune: RELIC_TOOLS[rune.runeId] ? rune : downgradedRune(rune) };
		}
	}
}

/**
 * Convert a monster's `rewardTrack` into its claimable reward options. Each entry
 * keeps its original track `index` (so duplicate tokens are distinct selectable
 * slots); icons with no engine meaning are dropped.
 */
export function buildMonsterRewards(
	rewardTrack: string[] | null | undefined
): MonsterRewardOption[] {
	const out: MonsterRewardOption[] = [];
	(rewardTrack ?? []).forEach((token, index) => {
		const effect = monsterGainFor(token);
		if (!effect) return;
		const relic = effect.type === 'rune' ? RELIC_TOOLS[effect.rune.runeId] : undefined;
		const label =
			effect.type === 'rune' && BASE_RUNES[effect.rune.runeId]
				? effect.rune.name
				: relic
					? `${relic.name} relic`
					: (meaningFor(token)?.label ?? 'Reward');
		out.push({ index, token, effect, label });
	});
	return out;
}

/** How many rewards a kill grants: every resolvable token on the card. */
export function rewardClaimCount(rewardTrack: string[] | null | undefined): number {
	return buildMonsterRewards(rewardTrack).length;
}
