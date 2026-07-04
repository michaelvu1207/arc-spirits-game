/**
 * Executable class-effect registry.
 *
 * The DB stores each class's `effect_schema` as free-text prose, which can't be
 * run directly. This file is the hand-authored, machine-executable encoding,
 * keyed by class name (names are stable and already used in spirit.classes).
 *
 * P1 encodes the common Rest / Cultivate / on-kill classes. Classes that are too
 * conditional to encode get a `manual` action, surfacing a prompt for the player
 * to resolve by hand — nothing silently breaks.
 */

import type { DiceTier } from '../types';

import { CLASS_ABILITIES } from './abilities';
import type { GameEvent } from './events';

/**
 * Legacy alias — the canonical event vocabulary now lives in `events.ts` as
 * {@link GameEvent} (the single ordered timeline every ability hooks into). Kept
 * as an alias so existing imports (`apply.ts`, `handlers.ts`, `context.ts`) and the
 * `trigger:`/`on:` strings throughout the registry keep working unchanged.
 */
export type EffectTrigger = GameEvent;

/**
 * A declarative effect action. New kinds added in P1 mutate the additive
 * `PrivatePlayerState` fields (all default to 0/false, so an absent effect is a
 * no-op). `conditional`/`extraAction`/`manual` compose or defer the rest.
 */
export type EffectAction =
	// ── Original kinds (numeric breakpoint path) ────────────────────────────
	| { kind: 'gainAttackDice'; tier: DiceTier; amount: number }
	| { kind: 'gainMaxBarrier'; amount: number }
	/**
	 * Upgrade attack dice. With no `from`/`to`, upgrades the `times` lowest-tier
	 * non-arcane dice one step (the classic Elementalist ladder). When `from`/`to`
	 * are given, it instead converts up to `times` dice that are *exactly* at the
	 * `from` tier into the `to` tier (e.g. Arcane Advisor: exalted → arcane).
	 */
	| { kind: 'upgradeDice'; times: number; from?: DiceTier; to?: DiceTier }
	| { kind: 'gainRune'; amount: number }
	/**
	 * Restore barrier. When `includeColocated` is set, every co-located active
	 * player also restores the same amount (Healer's shared heal).
	 */
	| { kind: 'restoreBarrier'; amount: number; includeColocated?: boolean }
	// ── New kinds (P1 framework) ────────────────────────────────────────────
	| { kind: 'gainVP'; amount: number }
	| { kind: 'gainInitiative'; amount: number }
	| { kind: 'reduceIncomingDamage'; amount: number }
	| { kind: 'deflect'; amount: number }
	| { kind: 'combatBonus'; amount: number }
	| { kind: 'gainAugment'; amount: number }
	| { kind: 'gainRelic'; amount: number }
	/**
	 * Purify broken barrier. A fixed `amount`, or `fraction: 'halfRoundUp'` to
	 * remove half the current broken barrier rounded up (Purifier's rest effect).
	 */
	| { kind: 'purifyArcaneBlood'; amount?: number; fraction?: 'halfRoundUp' }
	// ── P3 kinds (Rest / Cultivate coverage) ────────────────────────────────
	/** Set the passive stun-immunity flag (Soul Weaver). */
	| { kind: 'setStunImmune' }
	/** Discard up to `amount` attack dice (cost half of a discard-to-gain trade). */
	| { kind: 'discardAttackDice'; amount: number }
	/** Discard specific attack dice by instance id (Arc Mage's player-chosen convert). */
	| { kind: 'discardAttackDiceByIds'; instanceIds: string[] }
	// ── P4 kinds (Combat-trigger coverage) ───────────────────────────────────
	/**
	 * Add combat damage equal to the player's current broken barrier, capped at
	 * `max` (Blood Hunter: "deal 1 damage per broken barrier, max 4"). The amount
	 * is computed at trigger time from the live pool, so it can't be expressed
	 * with the static `combatBonus` amount.
	 */
	| { kind: 'combatBonusFromArcaneBlood'; max: number }
	// ── P5 kinds (trigger-wiring + win-con coverage) ─────────────────────────
	/**
	 * Set the per-turn rune-doubling flag (Rune Traveler). When `includeColocated`
	 * is set, every co-located active player's flag is set too (order-stable).
	 * Honored by the rune-gain code (the `gainRune` action + the cultivate grant).
	 */
	| { kind: 'setDoubleRunes'; includeColocated?: boolean }
	| { kind: 'conditional'; when: EffectCondition; then: EffectAction[]; else?: EffectAction[] }
	| { kind: 'extraAction'; actionKey: string; amount: number }
	| { kind: 'manual'; prompt: string }
	/**
	 * Surface a resolvable player-decision card for an optional ("may")/choice
	 * effect. Enqueues a {@link PendingDecision}; the player's pick is routed to the
	 * matching DECISION_RESOLVERS entry keyed by `decisionKind`. Replaces dead
	 * `manual` text with an actual, resolvable card.
	 */
	| { kind: 'choose'; decisionKind: string; prompt: string; options: { id: string; label: string }[] };

/**
 * A predicate evaluated against the {@link EffectContext} for `conditional`
 * actions. Kept declarative (data, not closures) so the registry stays
 * serialisable and inspectable.
 */
export type EffectCondition =
	/** True when the acting player is evil-aligned (status ≥ 2). */
	| { kind: 'isEvil' }
	/** True when the acting player is good-aligned (status < 2). */
	| { kind: 'isGood' }
	/** True when this combat killed the target. */
	| { kind: 'killed' }
	/** True when this combat did NOT kill the target (Adaptive Fighter's else-branch). */
	| { kind: 'notKilled' }
	/** True when overkill damage this combat is at least `amount`. */
	| { kind: 'overkillAtLeast'; amount: number }
	/** True when the acting player's status level is ≥ `level`. */
	| { kind: 'statusAtLeast'; level: number }
	/** True when at least one active player shares the location. */
	| { kind: 'hasColocated' }
	/** True when the acting player holds at least `amount` attack dice. */
	| { kind: 'hasAttackDice'; amount: number }
	// ── P5 conditions (Awakening-Phase status grants + VP win-cons) ───────────
	/** True when the player crossed into Tainted (status 1) this round. */
	| { kind: 'becameTainted' }
	/** True when the player crossed into Corrupt (status 2) this round. */
	| { kind: 'becameCorrupt' }
	/** True when the player crossed into Fallen (status 3) this round. */
	| { kind: 'becameFallen' }
	/** True when the player's status rose at all this round (any corruption). */
	| { kind: 'corruptedThisRound' }
	/** True when the acting player has at least `amount` victory points. */
	| { kind: 'vpAtLeast'; amount: number };

export interface EffectBreakpoint {
	/**
	 * Trait-count threshold for this breakpoint. A numeric value applies once at
	 * a fixed amount (the classic Fighter 2/3/4/5 ladder). The literal `'1+'`
	 * means "for each trait you have" — it applies whenever the count is ≥ 1 and
	 * scales numeric action amounts by the trait count.
	 */
	count: number | '1+';
	actions: EffectAction[];
}

export interface ClassEffect {
	trigger: EffectTrigger;
	breakpoints: EffectBreakpoint[];
}

/**
 * Legacy declarative view, DERIVED from the canonical {@link CLASS_ABILITIES}
 * source. For each class it collects the abilities that carry `breakpoints`,
 * mapping each back to `{ trigger: a.on, breakpoints: a.breakpoints }` so every
 * existing import and the dispatcher's declarative path keep working unchanged.
 *
 * Kept as a mutable plain object (not frozen) because the test harnesses inject
 * synthetic classes by assigning `CLASS_EFFECTS[name] = …` at runtime, and
 * `applyTrigger` reads the live object so those injections fire.
 */
export const CLASS_EFFECTS: Record<string, ClassEffect[]> = Object.fromEntries(
	Object.entries(CLASS_ABILITIES)
		.map(([cls, abilities]) => [
			cls,
			abilities
				.filter((a): a is Extract<typeof a, { breakpoints: EffectBreakpoint[] }> => !!a.breakpoints)
				.map((a) => ({ trigger: a.on, breakpoints: a.breakpoints }))
		] as const)
		.filter(([, effects]) => effects.length > 0)
);

/**
 * Classes intentionally routed to a `manual` prompt because the engine lacks a
 * primitive to resolve them. NOW EMPTY — every class is fully implemented with
 * built-in UX (no manual prompts). Kept as an exported set so the coverage harness
 * and runtime share one allowlist; the `manual` action kind remains available for
 * forward-compat but is unused.
 *
 * The last holdout, Purifier ("place 2 augments on each Cursed Spirit"), now grants
 * placeable Spirit Augments (restricted to Cursed Spirit hosts) that the player places
 * with the standard in-stage Augment-placement UX — see classes/purifier.ts.
 */
export const MANUAL_CLASSES = new Set<string>([]);

/** Outcome of resolving a breakpoint: which one fired, and the amount multiplier. */
export interface SelectedBreakpoint {
	bp: EffectBreakpoint;
	/** 1 for numeric breakpoints; the trait count for a `'1+'` breakpoint. */
	multiplier: number;
}

/**
 * Pick the breakpoint that applies for a given trait `count`.
 *
 * - Numeric breakpoints: choose the highest threshold that is `<= count`; the
 *   multiplier is `1` (classic fixed-amount ladder — unchanged behavior).
 * - A `'1+'` breakpoint: applies whenever `count >= 1`; the multiplier is the
 *   trait `count` so numeric amounts scale per-trait.
 *
 * A numeric breakpoint always wins over a `'1+'` one when both qualify (a class
 * mixing both is encoded so the explicit ladder takes precedence).
 */
export function selectBreakpoint(
	breakpoints: EffectBreakpoint[],
	count: number
): SelectedBreakpoint | null {
	let bestNumeric: EffectBreakpoint | null = null;
	let perTrait: EffectBreakpoint | null = null;
	for (const bp of breakpoints) {
		if (bp.count === '1+') {
			if (count >= 1) perTrait = bp;
			continue;
		}
		if (bp.count <= count && (bestNumeric === null || bp.count > (bestNumeric.count as number))) {
			bestNumeric = bp;
		}
	}
	if (bestNumeric) return { bp: bestNumeric, multiplier: 1 };
	if (perTrait) return { bp: perTrait, multiplier: count };
	return null;
}
