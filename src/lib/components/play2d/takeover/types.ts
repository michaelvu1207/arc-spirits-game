/**
 * Shared shapes for the Stage Takeover pattern (plans/ux-overhaul.md §4.1).
 * One vocabulary for every multi-step game decision: a rack of candidates
 * (real game objects, eligibility engine-supplied), a cost meter that fills
 * per selection, and a commit bar that stages everything until Confirm.
 */

/** One card in the candidate rack. Identical copies collapse into one card
 *  (`count` ≥ 1) with a live `selected` count instead of duplicate cards. */
export interface RackCandidate {
	/** Stable group key (runeId / instance identity). */
	key: string;
	label: string;
	/** Art URL for the real game object (mat card, spirit back, …). */
	image: string | null;
	/** How many identical copies this card represents. */
	count: number;
	/** How many of those copies are currently staged. */
	selected: number;
	/** Engine-supplied verdict — an ineligible card stays visible, dimmed + locked. */
	eligible: boolean;
	/** Why the card is locked (engine-supplied); shown as a chip on hover/tap. */
	reason?: string;
	/** Pre-committed by the engine's auto-match (specific trade costs): shown
	 *  selected but not player-toggleable. */
	auto?: boolean;
}

/** One requirement slot in the commit bar's cost meter. */
export interface MeterSlot {
	/** Requirement label ("Flower", "Any relic", "Discard"). */
	need: string;
	/** Requirement icon (dim until filled). */
	needIcon?: string | null;
	/** The staged item once the player picks one (icon pops into the slot). */
	filled?: { label: string; icon?: string | null } | null;
}
