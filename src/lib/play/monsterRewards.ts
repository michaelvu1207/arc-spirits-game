/**
 * Monster-kill rewards — derived from a monster's `reward_track` (a flat list of
 * icon_pool tokens). Defeating the Arcane Abyss monster lets the player claim up
 * to `chooseAmount` (default 2) tokens from this pool; you do NOT get them all.
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
export function monsterGainFor(iconId: string): GainEffect | null {
	const m = meaningFor(iconId);
	if (!m) return null;
	switch (m.kind) {
		case 'navigationPower': return null;
		case 'victoryPoints':
			return { type: 'vp', amount: m.amount };
		case 'action':
			return { type: 'action', action: m.action };
		case 'gainMaxBarrier':
			return { type: 'gainMaxBarrier', amount: 1 };
		case 'restoreBarrier':
			return { type: 'restoreBarrier', amount: 1 };
		case 'anyRune':
			return { type: 'chooseRune', options: originRuneOptions() };
		case 'wildcardRelic':
			// "Any relic" gain — choose one of the five relics.
			return { type: 'chooseRune', options: relicOptions() };
		case 'originRune':
		case 'specialRune': {
			const rune = toResolvedRune(m);
			return rune ? { type: 'rune', rune } : null;
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
		out.push({ index, token, effect, label: meaningFor(token)?.label ?? 'Reward' });
	});
	return out;
}

/** How many tokens a player may actually claim from `rewardTrack`. */
export function rewardClaimCount(
	rewardTrack: string[] | null | undefined,
	chooseAmount: number
): number {
	return Math.min(Math.max(0, chooseAmount), buildMonsterRewards(rewardTrack).length);
}
