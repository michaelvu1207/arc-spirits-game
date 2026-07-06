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
	GameActor,
	GameCommand,
	GamePhase,
	MemberRole,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	SeatColor,
	SpectatorProjection
} from './types';
import { ALL_DESTINATIONS, RUNE_CARRY_LIMIT } from './types';
import { canApply } from './legality';
import { seatHasResolutionWork } from './phases';
import { buildSessionProjection } from './runtime';
import {
	autoPickCostSlots,
	buildLocationInteractions,
	canAfford,
	eligibleCostSlots,
	isWildcardCost,
	type GainEffect,
	type LocationInteraction
} from './locationInteractions';
import { awakenedClassCounts } from './effects/apply';

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

/**
 * The precise, per-seat "what can I pay / claim at this location row" surface (§5.2),
 * so the client's trade-arming takeover (W1b) never re-derives cost legality. One entry
 * per resolvable reward row of the seat's current location. Owner-derived (reads private
 * mats), so it ships only to the seat that owns it.
 */
export interface LocationInteractionAffordance {
	/** Index into the location's reward rows (the `rowIndex` on `resolveLocationInteraction`). */
	rowIndex: number;
	/** Times this row may still be resolved this round (allowance − used, floored at 0). */
	usesRemaining: number;
	/** True when the seat can resolve the row right now — cost payable OR a waiver applies. */
	affordable: boolean;
	/** A cost-waiver in effect for this trade, and which class grants it. Absent = pay normally. */
	freeTrade?: 'modInjector' | 'undercover';
	/** One entry per cost requirement, in cost order. Empty for a free (gain) row. */
	costSlots: {
		/** Requirement label ("Cyber City rune", "Any relic"). */
		need: string;
		/** True for a wildcard cost ("any relic" / "any basic rune") — the only kind with a real
		 *  choice of WHICH held copy to spend. */
		wildcard: boolean;
		/** ARRAY indices into `player.mats` of every held slot that could pay this requirement —
		 *  the values the client passes back as `costChoices`. */
		eligibleMatSlotIndexes: number[];
		/** The mats array index auto-match would spend for this slot (pre-fill), or null if the
		 *  cost cannot currently be paid. */
		autoPick: number | null;
	}[];
	/** "Or" gains (one group per `chooseRune` gain, in gain order) — no default is pre-selected,
	 *  so the client must force a choice (fixes S6). */
	choiceGroups: { options: { runeId: string; name: string }[] }[];
	/** True when resolving the row would currently do nothing useful (e.g. restore-barrier at
	 *  full barrier) — the client shows a "no effect now" warning instead of a bright CTA. */
	noEffectNow?: boolean;
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
	/** Why `canPass` is false while a pass command exists for the phase (drives the
	 *  disabled Pass-Turn tooltip, F3). Absent when the seat can pass, or when the phase
	 *  has no pass command (navigation). Engine-owned label. */
	passBlockedReason?: string;
	/** The seat's location reward rows with precise cost/eligibility (§5.2). Present only in
	 *  the Location phase when the seat is at a location; absent otherwise. */
	locationInteractions?: LocationInteractionAffordance[];
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
	if (state.status !== 'active') return [];
	const player = state.players[seat];
	if (!player) return [];

	// Actor exactly as the reducer would see this seat. canApply only reads `seatColor`
	// (via seatPlayer), so the id/name coercions here never affect a verdict — they just
	// satisfy GameActor's non-null string fields.
	const actor: GameActor = {
		memberId: state.seats[seat]?.memberId ?? '',
		displayName: state.players[seat]?.displayName ?? '',
		role: 'player',
		seatColor: seat
	};

	const out: GameCommandType[] = [];
	for (const type of CANDIDATE_TYPES_BY_PHASE[state.phase] ?? []) {
		const command = representativeCommand(type, player);
		if (!command) continue;
		// Superset-safe: keep on `true` OR `undefined` (not cheaply decidable), drop only on a
		// provable `false`. The server still authoritatively validates the real command on submit.
		if (canApply(state, actor, command, catalog) !== false) out.push(type);
	}
	return out;
}

/**
 * The command types plausibly available in each phase — the probe set computeLegalCommandTypes
 * runs through canApply. Kept phase-scoped and small so the per-view probe stays cheap: a type is
 * only listed under a phase where it could realistically be legal (the reducer's own phase guards
 * reject the rest anyway, but not listing them avoids pointless probes). `dismissManualPrompt` is
 * unconditionally legal for any seated player per canApply, so it always appears in awakening — the
 * client uses `pendingWork` (not this list) to decide whether a prompt actually needs surfacing.
 */
const CANDIDATE_TYPES_BY_PHASE: Record<GamePhase, GameCommandType[]> = {
	navigation: ['lockNavigation', 'unlockNavigation'],
	encounter: ['passEncounter', 'initiatePvp'],
	location: [
		'spawnHandSpirit',
		'discardHandDraws',
		'redrawHandDraws',
		'startCombat',
		'resolveMonsterReward',
		'resolveLocationInteraction',
		'endLocationActions'
	],
	benefits: ['resolveAwakenReward', 'placeAugmentOnSpirit', 'commitBenefits'],
	awakening: [
		'awakenSpirit',
		'manualAwaken',
		'resolveDecision',
		'placeAugmentOnSpirit',
		'dismissManualPrompt',
		'commitAwakening'
	],
	cleanup: ['discardSpirit', 'discardRune', 'commitCleanup']
};

/** First face-down spirit's slot (the one that could actually awaken), else the first spirit's,
 *  else 1 — so awaken probes point at a flippable target when one exists. */
function firstFaceDownSlot(player: PrivatePlayerState): number {
	return player.spirits.find((s) => s.isFaceDown)?.slotIndex ?? player.spirits[0]?.slotIndex ?? 1;
}

/**
 * ONE representative GameCommand for a candidate type, parameterized from live seat state so the
 * canApply probe points at the seat's most-likely-legal instance (a real hand-draw guid, a
 * face-down spirit slot, a held rune slot). Returns null for a type we can't represent.
 */
function representativeCommand(
	type: GameCommandType,
	player: PrivatePlayerState
): GameCommand | null {
	switch (type) {
		case 'lockNavigation':
			return { type, destination: ALL_DESTINATIONS[0] };
		case 'unlockNavigation':
		case 'passEncounter':
		case 'initiatePvp':
		case 'discardHandDraws':
		case 'redrawHandDraws':
		case 'startCombat':
		case 'endLocationActions':
		case 'resolveAwakenReward':
		case 'commitBenefits':
		case 'commitAwakening':
		case 'commitCleanup':
			return { type };
		case 'spawnHandSpirit':
			return { type, guid: player.handDraws?.[0]?.guid ?? '' };
		case 'resolveMonsterReward':
			return { type, picks: [] };
		case 'resolveLocationInteraction':
			return { type, rowIndex: 0 };
		case 'placeAugmentOnSpirit':
			return {
				type,
				augmentIndex: 0,
				augmentRuneId: player.unplacedAugments?.[0]?.runeId ?? '',
				spiritSlotIndex: player.spirits[0]?.slotIndex ?? 1
			};
		case 'awakenSpirit':
		case 'manualAwaken':
			return { type, slotIndex: firstFaceDownSlot(player) };
		case 'resolveDecision':
			return {
				type,
				decisionId: player.pendingDecisions?.[0]?.id ?? '',
				optionId: player.pendingDecisions?.[0]?.options?.[0]?.id ?? ''
			};
		case 'dismissManualPrompt':
			return { type, id: player.manualPrompts?.[0]?.id ?? '' };
		case 'discardSpirit':
			return { type, slotIndex: player.spirits[0]?.slotIndex ?? 1 };
		case 'discardRune':
			return { type, slotIndex: player.mats.find((r) => r.hasRune)?.slotIndex ?? 1 };
		default:
			return null;
	}
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
	const work: PendingWorkDescriptor[] = [];
	if (!player) return work;

	// Phase-independent obligations — mirror seatHasResolutionWork's pre-switch checks
	// (an in-flight draw/reward or an unplaced augment holds the seat in ANY resolution step).
	if (player.pendingDraw) work.push({ kind: 'draw', label: 'Resolve summon' });
	if (player.pendingReward) work.push({ kind: 'reward', label: 'Claim monster reward' });
	const queued = player.pendingDrawQueue?.length ?? 0;
	if (queued > 0) {
		work.push({
			kind: 'draw',
			label: queued === 1 ? 'Resolve queued summon' : `Resolve ${queued} queued summons`,
			count: queued
		});
	}
	const augments = player.unplacedAugments?.length ?? 0;
	if (augments > 0) {
		work.push({
			kind: 'augment',
			label: augments === 1 ? 'Place Spirit Augment' : `Place ${augments} Spirit Augments`,
			count: augments
		});
	}

	// Phase-specific obligations — mirror seatHasResolutionWork's switch exactly, so
	// (work.length > 0) === seatHasResolutionWork(state, seat) for the same player.
	switch (state.phase) {
		case 'benefits':
			if (player.pendingAwakenReward) work.push({ kind: 'claim', label: 'Claim class rewards' });
			break;
		case 'awakening': {
			const offers = player.awakenOffers ?? [];
			if (offers.length > 0) {
				work.push({
					kind: 'awaken',
					label: offers.length === 1 ? 'Awaken a spirit' : `Awaken ${offers.length} spirits`,
					count: offers.length,
					slotIndexes: offers.map((o) => o.slotIndex)
				});
			}
			const prompts = player.manualPrompts ?? [];
			if (prompts.length > 0) {
				work.push({
					kind: 'manualPrompt',
					label:
						prompts.length === 1
							? 'Confirm a hand-resolved effect'
							: `Confirm ${prompts.length} hand-resolved effects`,
					count: prompts.length,
					ids: prompts.map((p) => p.id)
				});
			}
			const decisions = player.pendingDecisions ?? [];
			if (decisions.length > 0) {
				work.push({
					kind: 'decision',
					label:
						decisions.length === 1 ? 'Resolve a decision' : `Resolve ${decisions.length} decisions`,
					count: decisions.length,
					ids: decisions.map((d) => d.id)
				});
			}
			// Still-eligible face-down flips: awakenEligible ∩ isFaceDown (mirrors the `.some` check).
			const flippable = (player.awakenEligible ?? []).filter(
				(slot) => player.spirits.find((s) => s.slotIndex === slot)?.isFaceDown
			);
			if (flippable.length > 0) {
				work.push({
					kind: 'awaken',
					label:
						flippable.length === 1
							? 'Flip a face-down spirit'
							: `Flip ${flippable.length} face-down spirits`,
					count: flippable.length,
					slotIndexes: flippable
				});
			}
			break;
		}
		case 'cleanup': {
			const heldRunes = (player.mats ?? []).filter((r) => r.hasRune).length;
			if (heldRunes > RUNE_CARRY_LIMIT) {
				const overflow = heldRunes - RUNE_CARRY_LIMIT;
				work.push({
					kind: 'overflow',
					label: overflow === 1 ? 'Trim 1 rune' : `Trim ${overflow} runes`,
					count: overflow
				});
			}
			if (player.pendingCorruptionDiscard && player.spirits.length > 0) {
				const count = player.pendingCorruptionDiscard.count;
				work.push({
					kind: 'corruptionDiscard',
					label: count === 1 ? 'Discard 1 corrupted spirit' : `Discard ${count} corrupted spirits`,
					count
				});
			}
			break;
		}
		default:
			break;
	}
	return work;
}

/** Which item kinds a trade row grants (drives the free-trade waivers). Considers every
 *  option of an "or" gain, since any of them could be the chosen grant — an OPTIMISTIC
 *  read (like legalCommandTypes): the reducer re-checks against the actual choice. */
function tradeGrantKinds(interaction: LocationInteraction): { augment: boolean; relic: boolean } {
	let augment = false;
	let relic = false;
	for (const gain of interaction.gains) {
		if (gain.type === 'rune') {
			if (gain.rune.type === 'augment') augment = true;
			if (gain.rune.type === 'relic') relic = true;
		} else if (gain.type === 'chooseRune') {
			for (const opt of gain.options) {
				if (opt.type === 'augment') augment = true;
				if (opt.type === 'relic') relic = true;
			}
		}
	}
	return { augment, relic };
}

/** The cost waiver in effect for a trade row, mirroring the reducer's Mod Injector /
 *  Undercover rules (runtime.ts resolveLocationInteraction). Undefined when the player pays. */
function freeTradeFor(
	interaction: LocationInteraction,
	player: PrivatePlayerState,
	classCounts: Record<string, number>
): 'modInjector' | 'undercover' | undefined {
	if (interaction.cost.length === 0) return undefined;
	const { augment, relic } = tradeGrantKinds(interaction);
	if ((classCounts['Mod Injector'] ?? 0) >= 1 && augment) return 'modInjector';
	if (player.freeNextRelicTrade && relic) return 'undercover';
	return undefined;
}

/** A row does nothing useful right now iff every gain is a barrier restore and the player is
 *  already at full barrier (brokenBarrier === 0). Other gains always do something. */
function interactionHasNoEffect(interaction: LocationInteraction, player: PrivatePlayerState): boolean {
	if (interaction.gains.length === 0) return false;
	return (
		interaction.gains.every((g) => g.type === 'restoreBarrier') && (player.brokenBarrier ?? 0) === 0
	);
}

/**
 * The seat's location reward rows as precise affordances (§5.2), reusing the same
 * locationInteractions helpers the reducer + menu use so cost legality never diverges.
 * Empty unless the seat is in the Location phase AND parked at a location with rows.
 */
export function computeLocationInteractions(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog: PlayCatalog
): LocationInteractionAffordance[] {
	if (state.phase !== 'location') return [];
	const destination = player.navigationDestination;
	if (!destination) return [];
	const locEntry = (catalog.locations ?? []).find((l) => l.name === destination);
	const interactions = buildLocationInteractions(locEntry?.rewardRows);
	if (interactions.length === 0) return [];

	const mats = player.mats ?? [];
	const rowAllowance = 1 + (player.extraActions?.locationInteraction ?? 0);
	const classCounts = awakenedClassCounts(player);

	return interactions.map((interaction) => {
		const usedKey = `row:${interaction.rowIndex}`;
		const rowUsed = (player.actionsUsedThisRound ?? []).filter((a) => a === usedKey).length;
		const auto = autoPickCostSlots(interaction.cost, mats);
		const costSlots = interaction.cost.map((req, ci) => ({
			need: req.label,
			wildcard: isWildcardCost(req),
			eligibleMatSlotIndexes: eligibleCostSlots(req, mats),
			autoPick: auto[ci] ?? null
		}));
		const choiceGroups = interaction.gains
			.filter((g): g is Extract<GainEffect, { type: 'chooseRune' }> => g.type === 'chooseRune')
			.map((g) => ({ options: g.options.map((o) => ({ runeId: o.runeId, name: o.name })) }));
		const freeTrade = freeTradeFor(interaction, player, classCounts);
		const affordable = canAfford(interaction, mats) || freeTrade != null;
		const noEffectNow = interactionHasNoEffect(interaction, player);

		return {
			rowIndex: interaction.rowIndex,
			usesRemaining: Math.max(0, rowAllowance - rowUsed),
			affordable,
			...(freeTrade ? { freeTrade } : {}),
			costSlots,
			choiceGroups,
			...(noEffectNow ? { noEffectNow: true } : {})
		};
	});
}

/**
 * Why a seat can't pass while a pass command exists (F3 tooltip). Reuses the
 * describePendingWork labels for the obligations it already enumerates, plus a Location-
 * phase corruption fallback (the one blocker describePendingWork keys to Cleanup only —
 * a payable corruption debt blocks endLocationActions too, legality.ts). Only called when
 * a pass command exists and canPass is false.
 */
function passBlockedReasonFor(
	phase: GamePhase,
	player: PrivatePlayerState,
	pendingWork: PendingWorkDescriptor[]
): string {
	if (pendingWork.length > 0) return pendingWork[0].label;
	if (phase === 'location' && player.pendingCorruptionDiscard && player.spirits.length > 0) {
		return 'Discard your corrupted spirits first.';
	}
	return 'Resolve your pending actions first.';
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
	const phase = state.phase;
	const legalCommandTypes = computeLegalCommandTypes(state, seat, catalog);
	const passCommand = PASS_COMMAND_BY_PHASE[phase];
	const player = state.players[seat];
	const canPass = !!passCommand && legalCommandTypes.includes(passCommand);
	const pendingWork = player ? describePendingWork(state, player) : [];
	const locationInteractions =
		player && state.status === 'active' ? computeLocationInteractions(state, player, catalog) : [];
	return {
		seat,
		phase,
		phaseLabel: PHASE_LABELS[phase],
		legalCommandTypes,
		hasResolutionWork: state.status === 'active' && seatHasResolutionWork(state, seat),
		canPass,
		pendingWork,
		...(passCommand && !canPass && player
			? { passBlockedReason: passBlockedReasonFor(phase, player, pendingWork) }
			: {}),
		...(locationInteractions.length > 0 ? { locationInteractions } : {}),
		deadline: state.phaseDeadline
	};
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
	const projection = buildSessionProjection(state, viewer);
	const affordances: Partial<Record<SeatColor, SeatAffordances>> = viewer.seatColor
		? { [viewer.seatColor]: computeAffordances(state, viewer.seatColor, catalog) }
		: {};
	return { version: 2, projection, member, affordances };
}
