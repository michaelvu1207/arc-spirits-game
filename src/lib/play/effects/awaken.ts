/**
 * Awakening gate + generic rune-cost payment.
 *
 * A face-down spirit can only be flipped face-up if its `awaken_condition` is
 * satisfied. This module reads the spirit's normalized {@link NormalizedAwaken}
 * from the catalog and decides — generically, with no per-spirit code — whether
 * the player can pay:
 *
 *   - no condition (`undefined`)  → free flip (current behavior).
 *   - `rune_cost`                 → match the required mats against the player's
 *                                   held mats via {@link matchMatCost}; pay by
 *                                   discarding the chosen mats.
 *   - `text`                      → never auto-satisfiable; the runtime surfaces a
 *                                   manualPrompt and the flip is blocked (Phase 6
 *                                   scripts the encodable text conditions).
 *
 * `check` and `pay` are kept separate so callers (runtime, cleanup, bots) can
 * test satisfiability without mutating state.
 */

import type {
	AwakenCostSlot,
	AwakenDiscardOption,
	AwakenDiscardRef,
	AwakenIneligibleMat,
	AwakenLockedOffer,
	AwakenOffer,
	NormalizedAwaken,
	PlayCatalogSpirit,
	PlaySpirit
} from '../types';
import type { EffectContext } from './context';
import { matchMatCost, matSatisfiesRequirement, spendableMats, type SpendableMat } from './matMatch';
import { AWAKEN_HANDLERS, type AwakenHandlerContext } from './awakenHandlers';

/** Named requirements are fungible and auto-pay. Owner input is needed only
 * when a wildcard has surplus candidates of materially different identities. */
function runeCostRequiresSelection(
	requirements: Extract<NormalizedAwaken, { kind: 'rune_cost' }>['mats'],
	spendable: SpendableMat[]
): boolean {
	const namedPayment = matchMatCost(
		requirements.filter((requirement) => !requirement.wildcard),
		spendable
	);
	const consumedByNamed = new Set(namedPayment.ok ? namedPayment.consumedIndices : []);
	for (const kind of ['rune', 'relic'] as const) {
		const wildcardCount = requirements
			.filter((requirement) => requirement.wildcard && requirement.kind === kind)
			.reduce((sum, requirement) => sum + requirement.count, 0);
		if (wildcardCount === 0) continue;
		const candidates = spendable.filter(
			(mat) => mat.kind === kind && !consumedByNamed.has(mat.arrayIndex)
		);
		if (candidates.length <= wildcardCount) continue;
		const identities = new Set(
			candidates.map((mat) => mat.id ?? `${mat.name ?? ''}:${mat.kind}`)
		);
		if (identities.size > 1) return true;
	}
	return false;
}

/** Result of {@link checkAwakenCondition}: satisfiable + an optional reason. */
export interface AwakenCheck {
	ok: boolean;
	/** Human-readable explanation when `ok` is false. */
	reason?: string;
	/** For an unmet/met `text` condition, the verbatim text to surface by hand. */
	text?: string;
	/** The normalized condition kind, for callers that branch on it. */
	kind?: NormalizedAwaken['kind'];
	/**
	 * True when this condition has a SCRIPTED handler that resolves it
	 * deterministically (a Phase-6 text spirit). Such a spirit is auto-awakenable
	 * even though its kind is `text` — it does NOT need the manual-confirm path.
	 * Unscripted text conditions have `scripted` false/undefined.
	 */
	scripted?: boolean;
}

/** The acting spirit (slot) the awaken context is resolving. */
export interface AwakenTarget {
	/** The player's face-down spirit slot being awakened. */
	spirit: PlaySpirit;
}

/** Find the catalog entry (carrying the normalized `awaken`) for a slot. */
function catalogSpiritFor(ctx: EffectContext, spirit: PlaySpirit): PlayCatalogSpirit | undefined {
	return ctx.catalog.spirits.find((entry) => entry.id === spirit.id || entry.name === spirit.name);
}

/**
 * Can the spirit in `target` be awakened given the player's current runes?
 *
 * Reads the catalog spirit's normalized `awaken`. A missing condition is free.
 * A `rune_cost` is satisfiable iff {@link matchMatCost} can assign every
 * requirement to a distinct held mat. A `text` condition is never
 * auto-satisfiable here (manual path), but the verbatim text is returned so the
 * caller can prompt for it.
 */
export function checkAwakenCondition(ctx: EffectContext, target: AwakenTarget): AwakenCheck {
	const catalogSpirit = catalogSpiritFor(ctx, target.spirit);
	const awaken = catalogSpirit?.awaken;

	// No condition → free flip (null/undefined in the DB).
	if (!awaken) return { ok: true };

	if (awaken.kind === 'text') {
		// A scripted text condition (Phase 6) is checked by its handler. An
		// unscripted text condition stays manual-only (block + surface the text).
		const handler = catalogSpirit ? AWAKEN_HANDLERS[catalogSpirit.id] : undefined;
		if (handler) {
			const handlerCtx: AwakenHandlerContext = { ...ctx, spirit: target.spirit };
			const result = handler.check(handlerCtx);
			if (result.ok) return { ok: true, kind: 'text', scripted: true };
			return {
				ok: false,
				reason: result.reason ?? 'awaken_text',
				text: awaken.text,
				kind: 'text',
				scripted: true
			};
		}
		return { ok: false, reason: 'awaken_text', text: awaken.text, kind: 'text' };
	}

	// rune_cost → generic resolver.
	const match = matchMatCost(awaken.mats, spendableMats(ctx.player.mats));
	if (!match.ok) {
		return { ok: false, reason: 'insufficient_runes', kind: 'rune_cost' };
	}
	return { ok: true, kind: 'rune_cost' };
}

/** Result of {@link payAwakenCondition}: paid + the runes that were discarded. */
export interface AwakenPayment {
	ok: boolean;
	reason?: string;
	/** Display names of the runes discarded to pay the cost (for the log). */
	discarded: string[];
}

/**
 * Pay a `rune_cost` awakening by discarding the matched runes (sets `hasRune`
 * to false on the chosen slots). `runeSelection` — the mats the caller chose,
 * named by slot index (what the picker's refs carry) or snapshot `guid` — lets
 * the caller disambiguate which copies to spend; otherwise the matcher auto-picks
 * per its named-before-wildcard preference. A free/`text` condition is a no-op pay
 * (free succeeds, text is rejected — it has no payable cost).
 *
 * `strict` (F1): treat `runeSelection` as a BINDING selection — the cost must be
 * payable using ONLY those mats, else the pay fails with `invalid_discard_selection`
 * (no silent auto-pick of other mats). The caller enables strict only when the
 * selection is complete (one entry per required unit); a partial/omitted selection
 * stays a preference so bots and old clients keep auto-pick.
 *
 * Returns `ok:false` (and discards nothing) if the cost cannot be met, so the
 * caller can keep `check` and `pay` consistent.
 */
export function payAwakenCondition(
	ctx: EffectContext,
	target: AwakenTarget,
	runeSelection?: string[],
	strict = false
): AwakenPayment {
	const catalogSpirit = catalogSpiritFor(ctx, target.spirit);
	const awaken = catalogSpirit?.awaken;

	// Free flip → nothing to pay.
	if (!awaken) return { ok: true, discarded: [] };

	if (awaken.kind === 'text') {
		// A scripted text condition pays through its handler (discard relics/runes/
		// spirits/dice, consume an event progress flag). An unscripted text
		// condition cannot be paid here — it needs the manual-confirm command.
		const handler = catalogSpirit ? AWAKEN_HANDLERS[catalogSpirit.id] : undefined;
		if (!handler) return { ok: false, reason: 'awaken_text', discarded: [] };
		const handlerCtx: AwakenHandlerContext = { ...ctx, spirit: target.spirit };
		if (!handler.check(handlerCtx).ok) {
			return { ok: false, reason: 'awaken_text', discarded: [] };
		}
		const before = ctx.log.length;
		handler.pay(handlerCtx);
		// Surface the handler's own log lines as the "discarded" summary.
		return { ok: true, discarded: ctx.log.slice(before) };
	}

	const mats = ctx.player.mats;
	// Bind the selection only when it is COMPLETE (one chosen id per required unit).
	// A partial/omitted selection stays a preference so bots + old clients keep
	// auto-pick; a complete-but-wrong selection is rejected (F1).
	const totalRequired = awaken.mats.reduce((sum, r) => sum + r.count, 0);
	const bindExact = strict && !!runeSelection && runeSelection.length === totalRequired;
	const match = matchMatCost(awaken.mats, spendableMats(mats), runeSelection, { strict: bindExact });
	if (!match.ok) {
		// A failed strict match means the player's explicit picks don't pay the cost
		// (wrong items); otherwise the cost is simply unaffordable.
		return {
			ok: false,
			reason: bindExact ? 'invalid_discard_selection' : 'insufficient_runes',
			discarded: []
		};
	}

	const discarded: string[] = [];
	for (const arrayIndex of match.consumedIndices) {
		const slot = mats[arrayIndex];
		if (!slot) continue;
		slot.hasRune = false;
		discarded.push(slot.name ?? slot.id ?? 'rune');
	}
	return { ok: true, discarded };
}

/**
 * Lightweight satisfiability test for the cleanup phase + bots: can this slot be
 * awakened right now without manual intervention? True for free/null conditions,
 * payable `rune_cost` conditions, and SCRIPTED `text` conditions that are
 * currently satisfiable. False for unmet rune costs and for unscripted `text`
 * conditions (which need the manual-confirm command).
 */
export function canAutoAwaken(ctx: EffectContext, target: AwakenTarget): boolean {
	const check = checkAwakenCondition(ctx, target);
	if (!check.ok) return false;
	// Free / rune_cost are always auto. A scripted text spirit is auto when its
	// handler reports satisfiable; an unscripted text spirit is never auto.
	return check.kind !== 'text' || check.scripted === true;
}

/**
 * True iff this slot's condition is an UNSCRIPTED `text` condition — the only kind
 * that goes through the manual-confirm (`manualAwaken`) command. Scripted text and
 * rune_cost conditions resolve through `awakenSpirit`.
 */
export function needsManualAwaken(ctx: EffectContext, target: AwakenTarget): boolean {
	const check = checkAwakenCondition(ctx, target);
	return check.kind === 'text' && check.scripted !== true;
}

/**
 * Build the Cleanup {@link AwakenOffer} for an awaken-eligible face-down spirit:
 * its requirement spelled out for the card, plus — for scripted discard handlers
 * — how many items to spend and which the owner may choose. Returns null when the
 * spirit is not auto-awakenable right now (caller should not offer it).
 *
 * Free flips and `rune_cost` flips carry no `options` (no per-item choice is
 * surfaced — rune copies are auto-matched); discard handlers (Faeries, relic/
 * trait discards) surface their candidates so the owner picks which to discard.
 */
export function buildAwakenOffer(ctx: EffectContext, target: AwakenTarget): AwakenOffer | null {
	const check = checkAwakenCondition(ctx, target);
	if (!check.ok) return null;

	const spirit = target.spirit;
	const base = { slotIndex: spirit.slotIndex, spiritName: spirit.name };

	const catalogSpirit = catalogSpiritFor(ctx, spirit);
	const awaken = catalogSpirit?.awaken;

	// Free flip — no condition.
	if (!awaken) {
		return { ...base, requirement: 'Free', discardCount: 0, options: [] };
	}

	// rune_cost — surface the cost-eligible mats so the owner picks WHICH to spend.
	// Per-slot `costSlots` carry the precise eligibility the payment takeover lights
	// (fixes S2: no longer the whole rack); `ineligible` lists what stays dimmed.
	if (awaken.kind === 'rune_cost') {
		const summary = awaken.mats
			.map((r) => (r.count > 1 ? `${r.name} ×${r.count}` : r.name))
			.join(', ');
		const discardCount = awaken.mats.reduce((sum, r) => sum + r.count, 0);
		const spendable = spendableMats(ctx.player.mats);
		const refFor = (m: SpendableMat): AwakenDiscardRef => ({
			kind: 'rune',
			slotIndex: ctx.player.mats[m.arrayIndex].slotIndex
		});
		const fillsSomeSlot = (m: SpendableMat) =>
			awaken.mats.some((req) => matSatisfiesRequirement(req, m));

		// One cost slot per required unit, in payment order; each lists only ITS legal payers.
		const costSlots: AwakenCostSlot[] = [];
		for (const req of awaken.mats) {
			const eligibleRefs = spendable
				.filter((m) => matSatisfiesRequirement(req, m))
				.map(refFor);
			for (let n = 0; n < req.count; n += 1) {
				costSlots.push({
					need: req.name ?? (req.wildcard ? 'Any mat' : 'Rune'),
					...(!req.wildcard && req.runeId ? { needRuneId: req.runeId } : {}),
					wildcard: req.wildcard,
					eligibleRefs
				});
			}
		}

		// `options` narrows to only the cost-eligible mats (S2 fix): what the picker may pick.
		const options: AwakenDiscardOption[] = spendable.filter(fillsSomeSlot).map((m) => ({
			ref: refFor(m),
			label: m.name ?? 'Rune',
			...(m.id ? { runeId: m.id } : {})
		}));

		// Held mats that fill no slot — dim + reason chips.
		const ineligible: AwakenIneligibleMat[] = spendable
			.filter((m) => !fillsSomeSlot(m))
			.map((m) => ({ ref: refFor(m), label: m.name ?? 'Rune', reason: `Needs ${summary}` }));

		return {
			...base,
			requirement: `Discard ${summary}`,
			discardCount,
			options,
			costSlots,
			ineligible,
			...(runeCostRequiresSelection(awaken.mats, spendable)
				? { requiresSelection: true as const }
				: {})
		};
	}

	// Scripted text — discard handlers expose a choice; event/flag handlers don't.
	const handler = catalogSpirit ? AWAKEN_HANDLERS[catalogSpirit.id] : undefined;
	const requirement = awaken.text || 'Awaken';
	const choice = handler?.discardChoice?.({ ...ctx, spirit });
	if (choice) {
		return {
			...base,
			requirement,
			discardCount: choice.count,
			options: choice.options,
			...(choice.requiresSelection ? { requiresSelection: true as const } : {})
		};
	}
	return { ...base, requirement, discardCount: 0, options: [] };
}

/**
 * Spell out a face-down spirit's awaken requirement REGARDLESS of payability — the
 * verbatim text condition, or a rune-cost summary. Used to surface a passive hint
 * for spirits the player can't yet awaken (Faeries waiting on a relic, etc.).
 */
function describeRequirement(ctx: EffectContext, spirit: PlaySpirit): string {
	const awaken = catalogSpiritFor(ctx, spirit)?.awaken;
	if (!awaken) return 'Free';
	if (awaken.kind === 'rune_cost') {
		const summary = awaken.mats
			.map((r) => (r.count > 1 ? `${r.name} ×${r.count}` : r.name))
			.join(', ');
		return `Discard ${summary}`;
	}
	return awaken.text || 'Awaken';
}

/**
 * Build a passive Cleanup hint for a face-down spirit that is NOT yet awakenable
 * (its discard/rune/location condition is unmet). Returns null for spirits that ARE
 * awakenable (those get a real {@link AwakenOffer} instead) and for free flips. Lets
 * the UI always show what a Faerie etc. needs, even before the player can pay it.
 */
export function buildAwakenLockedOffer(ctx: EffectContext, target: AwakenTarget): AwakenLockedOffer | null {
	if (canAutoAwaken(ctx, target)) return null;
	const spirit = target.spirit;
	const awaken = catalogSpiritFor(ctx, spirit)?.awaken;
	// No condition would be a free flip (already awakenable) — nothing to hint.
	if (!awaken) return null;
	return {
		slotIndex: spirit.slotIndex,
		spiritName: spirit.name,
		requirement: describeRequirement(ctx, spirit)
	};
}
