/**
 * RoomView v2 — the existing per-viewer SpectatorProjection PLUS an engine-computed
 * per-seat "affordances" block, so a client (Godot, web) never re-derives the rules to
 * know what a seat may legally do, what still blocks it, and when its clock runs out.
 *
 * ADDITIVE ONLY: this file introduces new exports and does not change any existing
 * exported type. A v1 consumer that reads `.projection` / `.member` off a RoomViewV2 is
 * unaffected; the new fields (`version`, `affordances`) are pure additions.
 *
 * Affordances generalize the commit-4fd36fd pattern (seatHasResolutionWork /
 * autoAdvanceResolution in phases.ts) from "does this seat still hold up the phase?" to a
 * full per-seat action surface.
 *
 * IMPLEMENTATION STATUS: the TYPES and function SIGNATURES here are the committed contract.
 * The function bodies are stubbed (TODO throws) — the M0c-impl task fills them in against
 * the design notes inlined on each stub. `computeAffordances` is the entry point.
 */

import type {
	GameCommand,
	GamePhase,
	MemberRole,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	SeatColor,
	SpectatorProjection
} from './types';

/** The command discriminant, narrowed to the real GameCommand union — never a bare string. */
export type GameCommandType = GameCommand['type'];

/** Member identity block — structurally identical to RoomView['member'] in server/service.ts.
 *  Declared here (not imported from server code) so this engine module stays free of any
 *  server-only dependency. */
export interface RoomViewMember {
	id: string | null;
	role: MemberRole;
	seatColor: SeatColor | null;
	displayName: string | null;
}

/** One outstanding obligation on a seat, described richly enough for a client to route the
 *  UI to it (deep-link a slot / a card) without re-deriving why it exists. Mirrors the exact
 *  conditions seatHasResolutionWork checks (phases.ts:49). */
export interface PendingWorkDescriptor {
	kind:
		| 'draw' // pendingDraw / pendingDrawQueue / handDraws — a summon in flight
		| 'reward' // pendingReward — an unclaimed monster/location reward
		| 'claim' // pendingAwakenReward — Benefits class grants to claim
		| 'awaken' // awakenOffers / still-eligible face-down flips (Awakening)
		| 'decision' // pendingDecisions — a class decision card to resolve
		| 'manualPrompt' // manualPrompts — a hand-resolved text awaken to confirm/dismiss
		| 'augment' // unplacedAugments — a Spirit Augment staged but not placed
		| 'overflow' // held runes over RUNE_CARRY_LIMIT (Cleanup must trim)
		| 'corruptionDiscard'; // pendingCorruptionDiscard — payable corruption debt
	/** Short human label for the obligation ("Claim class rewards", "Trim 2 runes"). */
	label: string;
	/** How many items the obligation involves, when countable (runes to trim, cards pending). */
	count?: number;
	/** Spirit slot indexes the client can deep-link to (e.g. flippable face-down spirits). */
	slotIndexes?: number[];
	/** Opaque ids the client can deep-link to (decisionId, promptId). */
	ids?: string[];
}

/** Everything a single seat needs to render its own controls, computed server-side. All
 *  fields are derived from state the OWNER may see — see the secrecy note below; the server
 *  must only ever hand a seat its OWN SeatAffordances. */
export interface SeatAffordances {
	seat: SeatColor;
	/** The live phase this affordance set was computed against. */
	phase: GamePhase;
	/** Display label for `phase` ("Navigation", "Awakening", …). */
	phaseLabel: string;
	/**
	 * The set of command TYPES this seat may legally submit right now, narrowed to the
	 * GameCommand union. OPTIMISTIC / SUPERSET-SAFE: a type is included when canApply
	 * returns `true` OR `undefined` (not-cheaply-decidable). It is excluded only when
	 * canApply provably rejects (`false`). So this is a safe hint for enabling buttons —
	 * the server still authoritatively validates the actual parameterized command on
	 * submit (a `undefined`-included type may still be rejected then). It is NOT a promise
	 * that every command of that type succeeds.
	 */
	legalCommandTypes: GameCommandType[];
	/** True when this seat still holds up a resolution phase (delegates to
	 *  seatHasResolutionWork). Drives the "waiting on you" indicator. */
	hasResolutionWork: boolean;
	/** True when the phase's advance/pass command (commitBenefits / commitAwakening /
	 *  commitCleanup / endLocationActions / passEncounter) is currently legal for this
	 *  seat. `false` in navigation, which advances by locking, not passing. */
	canPass: boolean;
	/** Every outstanding obligation on the seat, richest-first. Empty when the seat is
	 *  clear to pass. */
	pendingWork: PendingWorkDescriptor[];
	/** Server-clock wall-time (ms epoch) this seat's current phase auto-advances, or null
	 *  when untimed. Mirrors projection.phaseDeadline. */
	deadline: number | null;
}

/**
 * RoomView v2 wire object. `projection` and `member` are the UNCHANGED v1 payload
 * (SpectatorProjection is already viewer-filtered). `version` lets a client branch, and
 * `affordances` carries the per-seat action surface.
 *
 * SECRECY: the server populates `affordances` ONLY for the seat the receiving connection
 * is authenticated as (plus none for a spectator). Affordances are derived from
 * owner-private fields (hand draws, decisions, secret destination legality), so shipping
 * another seat's affordances would leak hidden information. Modeled as a Partial map (not a
 * single block) so a future "show me a bot's affordances for debugging" mode is expressible
 * without a type change, but in normal play at most one entry is present.
 */
export interface RoomViewV2 {
	version: 2;
	projection: SpectatorProjection;
	member: RoomViewMember;
	affordances: Partial<Record<SeatColor, SeatAffordances>>;
}

// ── Phase metadata (data the impl consumes; exported so it is shared, not duplicated) ──

export const PHASE_LABELS: Record<GamePhase, string> = {
	navigation: 'Navigation',
	encounter: 'Encounter',
	location: 'Location',
	benefits: 'Benefits',
	awakening: 'Awakening',
	cleanup: 'Cleanup'
};

/** The single "advance this phase" command per phase (navigation has none — it advances
 *  when all seats lock). Used to compute `canPass`. */
export const PASS_COMMAND_BY_PHASE: Partial<Record<GamePhase, GameCommandType>> = {
	encounter: 'passEncounter',
	location: 'endLocationActions',
	benefits: 'commitBenefits',
	awakening: 'commitAwakening',
	cleanup: 'commitCleanup'
};

// ── Entry points (SIGNATURES are the contract; bodies are for the M0c-impl task) ──────

/**
 * The legal command TYPES for a seat right now (superset-safe — see SeatAffordances).
 *
 * TODO(M0c-impl): implement by probing ONE representative GameCommand per candidate type
 * for `state.phase` (parameterized from live seat state) through
 * `canApply(state, actor, cmd, catalog)` from './legality'. Include the type when canApply
 * returns `true` OR `undefined`; exclude only on `false`. Build the actor locally from
 * `{ memberId: state.seats[seat]?.memberId, displayName: state.players[seat]?.displayName,
 * role: 'player', seatColor: seat }`. Do NOT call ml/actions.ts::legalActions — it fans out
 * over ALL_DESTINATIONS × spirit slots × location rows and CLONES the ~38 KB state on every
 * `undefined` verdict (the sim hot path, not a per-view path). Return `[]` when the player
 * is missing or `state.status !== 'active'`.
 */
export function computeLegalCommandTypes(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): GameCommandType[] {
	throw new Error(
		`computeLegalCommandTypes not implemented (M0c-impl): seat=${seat} phase=${state.phase} catalog=${catalog ? 'present' : 'missing'}`
	);
}

/**
 * Enumerate a seat's outstanding obligations — the same conditions seatHasResolutionWork
 * (phases.ts:49) tests, surfaced as routable descriptors.
 *
 * TODO(M0c-impl): mirror seatHasResolutionWork's field checks as PendingWorkDescriptors:
 * pendingDraw/pendingDrawQueue → 'draw'; pendingReward → 'reward'; unplacedAugments →
 * 'augment'; and per phase — benefits: pendingAwakenReward → 'claim'; awakening:
 * awakenOffers → 'awaken', manualPrompts → 'manualPrompt' (ids), pendingDecisions →
 * 'decision' (ids), still-eligible face-down flips (awakenEligible ∩ isFaceDown) → 'awaken'
 * (slotIndexes); cleanup: held runes > RUNE_CARRY_LIMIT → 'overflow' (count = overflow),
 * pendingCorruptionDiscard when spirits.length > 0 → 'corruptionDiscard' (count).
 */
export function describePendingWork(
	state: PublicGameState,
	player: PrivatePlayerState
): PendingWorkDescriptor[] {
	throw new Error(
		`describePendingWork not implemented (M0c-impl): phase=${state.phase} player=${player ? 'present' : 'missing'}`
	);
}

/**
 * The pure affordances projection for ONE seat. Reads owner-private state, so the caller
 * MUST only build this for the seat a connection is authenticated as.
 *
 * TODO(M0c-impl): compose from the helpers above:
 *   seat, phase = state.phase, phaseLabel = PHASE_LABELS[phase],
 *   legalCommandTypes = computeLegalCommandTypes(state, seat, catalog),
 *   hasResolutionWork = state.status === 'active' && seatHasResolutionWork(state, seat)
 *     (import seatHasResolutionWork from './phases'),
 *   canPass = a phase pass command exists (PASS_COMMAND_BY_PHASE[phase]) AND is in
 *     legalCommandTypes,
 *   pendingWork = the seat's player ? describePendingWork(state, player) : [],
 *   deadline = state.phaseDeadline.
 */
export function computeAffordances(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): SeatAffordances {
	throw new Error(
		`computeAffordances not implemented (M0c-impl): seat=${seat} phase=${state.phase} catalog=${catalog ? 'present' : 'missing'}`
	);
}

/**
 * Compose a full RoomViewV2 from authoritative state for a given viewer. Pure convenience:
 * the WS room server calls buildSessionProjection + computeAffordances itself when it also
 * needs to attach async bot-seat flags (attachBotSeatFlags in service.ts). Only the
 * viewer's own seat gets affordances (secrecy).
 *
 * TODO(M0c-impl): projection = buildSessionProjection(state, viewer) (import from
 * './runtime'); affordances = viewer.seatColor
 *   ? { [viewer.seatColor]: computeAffordances(state, viewer.seatColor, catalog) }
 *   : {}; return { version: 2, projection, member, affordances }.
 */
export function buildRoomViewV2(
	state: PublicGameState,
	viewer: SpectatorProjection['viewer'],
	member: RoomViewMember,
	catalog: PlayCatalog
): RoomViewV2 {
	throw new Error(
		`buildRoomViewV2 not implemented (M0c-impl): viewerSeat=${viewer.seatColor} member=${member.id} phase=${state.phase} catalog=${catalog ? 'present' : 'missing'}`
	);
}
