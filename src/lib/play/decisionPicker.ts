/**
 * Picker-style decision specs — the SINGLE source of truth for which pending
 * decisions carry an instance picker (currently Sentinel's attack-dice discard)
 * and, for those, how many instances may be chosen and which are eligible.
 *
 * Both the view layer (viewV2 → PendingWorkDescriptor.pickerSpecs, so the UI lights
 * only the eligible dice and its commit meter knows the count) AND the reducer
 * (resolveDecision's wrong-count rejection) call these helpers, so UI-eligibility and
 * reducer-acceptance cannot drift — the same drift guarantee the W1 awaken cost slots
 * gave. Pure reads over the decision + owner state; no catalog needed.
 */

import type { PendingDecision, PrivatePlayerState } from './types';

/** Sentinel's discard card (`effects/classes/firekeeper.ts`): pick any number of dice. */
const SENTINEL_DISCARD_KIND = 'sentinelDiscard';

/** A decision that requires the owner to pick some of their own instances
 *  (e.g. Sentinel choosing WHICH attack dice to discard). */
export interface DecisionPickerSpec {
	/** The decision this picker belongs to (so a client with several pending decisions
	 *  can route each picker to its card). */
	decisionId: string;
	/** The instance family the picker draws from. Only attack dice today. */
	kind: 'attackDice';
	/** Exactly this many DISTINCT eligible instances must be selected — or, when
	 *  `minCount` is set, at most this many. */
	count: number;
	/** Set for a free-size pick (Sentinel's discard): from `minCount` up to `count`. */
	minCount?: number;
	/** The instance ids the owner may choose among (their current attack-dice pool). */
	eligibleInstanceIds: string[];
}

/**
 * The picker spec for one pending decision, or null when the decision is a plain
 * option choice or all eligible instances are materially fungible. Computed live from the owner's
 * current state so `eligibleInstanceIds` never goes stale between the card appearing
 * and being resolved.
 */
export function decisionPickerSpec(
	decision: PendingDecision,
	player: PrivatePlayerState
): DecisionPickerSpec | null {
	if (decision.kind === SENTINEL_DISCARD_KIND) {
		// How many dice is the owner's choice, so the picker shows even for same-tier dice.
		const dice = player.attackDice ?? [];
		if (dice.length === 0) return null;
		return {
			decisionId: decision.id,
			kind: 'attackDice',
			count: dice.length,
			minCount: 1,
			eligibleInstanceIds: dice.map((d) => d.instanceId)
		};
	}
	return null;
}

/**
 * Validate a picker selection the owner submitted with `resolveDecision`. Returns a
 * failure code when the selection is unusable — the wrong number of instances, or any
 * id not in the eligible pool — else null (a legal pick), so the reducer can REJECT a
 * malformed pick instead of silently falling back to auto-pick. Only consulted when the client actually sent a
 * selection; an omitted selection (bots) keeps the resolver's auto-pick and never
 * reaches here.
 */
export function validateDecisionSelection(
	spec: DecisionPickerSpec,
	selectedInstanceIds: string[]
): 'invalid_selection' | null {
	const eligible = new Set(spec.eligibleInstanceIds);
	const distinct = [...new Set(selectedInstanceIds)];
	if (spec.minCount != null) {
		if (distinct.length < spec.minCount || distinct.length > spec.count) return 'invalid_selection';
	} else if (distinct.length !== spec.count) return 'invalid_selection';
	if (!distinct.every((id) => eligible.has(id))) return 'invalid_selection';
	return null;
}
