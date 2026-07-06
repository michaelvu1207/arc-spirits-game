/**
 * Picker-style decision specs — the SINGLE source of truth for which pending
 * decisions carry an instance picker (currently only Arc Mage's "convert 4 attack
 * dice") and, for those, exactly how many instances must be chosen and which are
 * eligible.
 *
 * Both the view layer (viewV2 → PendingWorkDescriptor.pickerSpecs, so the UI lights
 * only the eligible dice and its commit meter knows the count) AND the reducer
 * (resolveDecision's wrong-count rejection) call these helpers, so UI-eligibility and
 * reducer-acceptance cannot drift — the same drift guarantee the W1 awaken cost slots
 * gave. Pure reads over the decision + owner state; no catalog needed.
 */

import type { PendingDecision, PrivatePlayerState } from './types';
import { ARC_MAGE_TRADE_COST } from './effects/classes/arcMage';

/** A decision that requires the owner to pick a fixed number of their own instances
 *  (e.g. Arc Mage choosing WHICH 4 attack dice to convert). */
export interface DecisionPickerSpec {
	/** The decision this picker belongs to (so a client with several pending decisions
	 *  can route each picker to its card). */
	decisionId: string;
	/** The instance family the picker draws from. Only attack dice today. */
	kind: 'attackDice';
	/** Exactly this many DISTINCT eligible instances must be selected. */
	count: number;
	/** The instance ids the owner may choose among (their current attack-dice pool). */
	eligibleInstanceIds: string[];
}

/**
 * The picker spec for one pending decision, or null when the decision is a plain
 * option choice (Yes/No) with no instance picker. Computed live from the owner's
 * current state so `eligibleInstanceIds` never goes stale between the card appearing
 * and being resolved.
 */
export function decisionPickerSpec(
	decision: PendingDecision,
	player: PrivatePlayerState
): DecisionPickerSpec | null {
	if (decision.kind === 'arcMageTrade') {
		return {
			decisionId: decision.id,
			kind: 'attackDice',
			count: ARC_MAGE_TRADE_COST,
			eligibleInstanceIds: (player.attackDice ?? []).map((d) => d.instanceId)
		};
	}
	return null;
}

/**
 * Validate a picker selection the owner submitted with `resolveDecision`. Returns a
 * failure code when the selection is unusable — the wrong number of instances, or any
 * id not in the eligible pool — else null (a legal pick). Mirrors the resolver's
 * accept condition (`arcMage.ts`: a pick is honored only when it is exactly
 * `TRADE_COST` owned dice), so the reducer can REJECT a malformed pick instead of
 * silently falling back to auto-pick. Only consulted when the client actually sent a
 * selection; an omitted selection (bots) keeps the resolver's auto-pick and never
 * reaches here.
 */
export function validateDecisionSelection(
	spec: DecisionPickerSpec,
	selectedInstanceIds: string[]
): 'invalid_selection' | null {
	const eligible = new Set(spec.eligibleInstanceIds);
	const distinct = [...new Set(selectedInstanceIds)];
	if (distinct.length !== spec.count) return 'invalid_selection';
	if (!distinct.every((id) => eligible.has(id))) return 'invalid_selection';
	return null;
}
