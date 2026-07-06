/**
 * Phase state machine for the simultaneous round loop.
 *
 * Arc Spirits has no turn order: every round, all seated players act at once and
 * the round advances only when everyone is ready. We model that as "all-ready
 * gates" — pure functions that mutate the (already-cloned) state in place and are
 * invoked from the runtime reducer's command cases.
 *
 * Round phases:
 *   navigation → encounter → location → cleanup → (next round | finished)
 *
 * The runtime stays a pure reducer; these helpers contain no I/O.
 */

import type {
	AwakenGrant,
	AwakenLockedOffer,
	AwakenOffer,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from './types';
import { VP_TO_WIN, MAX_ROUNDS, ALL_DESTINATIONS, RUNE_CARRY_LIMIT, STATUS_LADDER, isEvilAlignment } from './types';
import { nextInt } from './rng';
import { buildEffectContext } from './effects/context';
import { buildAwakenLockedOffer, buildAwakenOffer, canAutoAwaken } from './effects/awaken';
import { applyTrigger, awakenedClassCounts } from './effects/apply';
import { advanceMonsterIfDefeated } from './combat';

/** Reset the per-phase "ready" flag for every active seat. */
function clearPhaseReady(state: PublicGameState): void {
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (player) player.phaseReady = false;
	}
}

/**
 * Does this seat have anything REAL to do in the current resolution phase
 * (`benefits` / `awakening` / `cleanup`)?
 *
 * This is the engine-side twin of the client's old per-phase auto-pass gates: a
 * seat with no work here is auto-readied at phase entry (and re-checked whenever
 * mid-phase work resolves), so players never sit through — or even SEE — empty
 * resolution steps. A seat with work keeps `phaseReady === false` and the phase
 * stops for it exactly as before.
 */
export function seatHasResolutionWork(state: PublicGameState, seat: SeatColor): boolean {
	const player = state.players[seat];
	if (!player) return false;
	// An in-flight draw/reward or an unplaced Spirit Augment holds the seat in ANY
	// resolution step (advancing would abandon/forfeit it).
	if (player.pendingDraw || player.pendingReward) return true;
	if ((player.pendingDrawQueue?.length ?? 0) > 0) return true;
	if ((player.unplacedAugments?.length ?? 0) > 0) return true;
	switch (state.phase) {
		case 'benefits':
			// The round's class grants must be claimed before Benefits can pass.
			return !!player.pendingAwakenReward;
		case 'awakening': {
			// Anything the awakening stage surfaces: offers, still-eligible face-down
			// flips, hand-resolved effects, or decision cards.
			if ((player.awakenOffers?.length ?? 0) > 0) return true;
			if ((player.manualPrompts?.length ?? 0) > 0) return true;
			if ((player.pendingDecisions?.length ?? 0) > 0) return true;
			return (player.awakenEligible ?? []).some(
				(slot) => player.spirits.find((s) => s.slotIndex === slot)?.isFaceDown
			);
		}
		case 'cleanup': {
			// Rune overflow must be trimmed; a payable corruption debt must be paid.
			if ((player.mats ?? []).filter((r) => r.hasRune).length > RUNE_CARRY_LIMIT) return true;
			return !!(player.pendingCorruptionDiscard && player.spirits.length > 0);
		}
		default:
			return false;
	}
}

/**
 * Auto-ready every seat with no work in the current resolution phase, then advance
 * if that turns out to be everyone. Because each `enter*` step calls this at the end
 * of its setup, a round where NOBODY has resolution work collapses the whole
 * `benefits → awakening → cleanup` sequence inside one reducer step — clients go
 * straight from the location phase to the next round's navigation and never render
 * the empty steps (same pattern as the encounter phase's no-aggressors skip).
 */
export function autoAdvanceResolution(state: PublicGameState, catalog?: PlayCatalog): void {
	const phase = state.phase;
	if (phase !== 'benefits' && phase !== 'awakening' && phase !== 'cleanup') return;
	if (state.status !== 'active') return;
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player || player.phaseReady) continue;
		if (!seatHasResolutionWork(state, seat)) player.phaseReady = true;
	}
	if (phase === 'benefits') tryAdvanceFromBenefits(state, catalog);
	else if (phase === 'awakening') tryAdvanceFromAwakening(state, catalog);
	else tryAdvanceFromCleanup(state, catalog);
}

function allActiveSeatsReady(state: PublicGameState): boolean {
	if (state.activeSeats.length === 0) return false;
	return state.activeSeats.every((seat) => state.players[seat]?.phaseReady === true);
}

/** Initialize navigation tracking for a fresh round. */
function beginNavigation(state: PublicGameState): void {
	state.phase = 'navigation';
	state.revealedDestinations = false;
	state.navigationDeadline = null; // stamped by the service when navigation opens
	state.navigationFullDeadline = null; // ditto — remembers the un-shortened deadline
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	state.locationOccupancy = {};
	state.navigation = {};
	state.combats = [];
	for (const seat of state.activeSeats) {
		state.navigation[seat] = { locked: false };
		const player = state.players[seat];
		if (player) {
			player.pendingDestination = null;
			player.navigationDestination = null;
			player.phaseReady = false;
			player.actionsUsedThisRound = [];
			player.lastAction = null;
			player.pendingReward = null;
			// P5 per-turn / per-round flags reset at the start of each round, BEFORE
			// onNavigate fires (so Rune Traveler's doubleRunes / Soul Weaver's redraw
			// re-arm cleanly) and the corruption-tracking flags zero out for the new
			// round's Awakening-Phase grants.
			player.doubleRunes = false;
			player.redrawAvailable = false;
			player.becameTaintedThisRound = false;
			player.becameCorruptThisRound = false;
			player.becameFallenThisRound = false;
			player.corruptedThisRound = false;
			// Per-round extra-action credits (Ironmane's extra Monster Combat,
			// Child Prodigy's doubled location interactions) are re-granted each
			// round by onNavigate, so clear last round's allowance here first.
			player.extraActions = {};
			// Compact rune slots for the new round: drop spent/discarded slots,
			// re-index, and enforce the carry limit (a host force-advance can bypass
			// the cleanup discard, so trim here as a backstop).
			player.mats = player.mats
				.filter((r) => r.hasRune)
				.slice(0, RUNE_CARRY_LIMIT)
				.map((r, i) => ({ ...r, slotIndex: i + 1 }));
		}
	}
}

/** Called once when the game starts (lobby → active). */
export function initRoundLoop(state: PublicGameState): void {
	state.round = 1;
	beginNavigation(state);
}

/**
 * If every active seat has locked a destination, reveal them, compute occupancy,
 * and advance into the encounter phase (which P0 auto-skips to location).
 */
export function tryRevealNavigation(state: PublicGameState, catalog?: PlayCatalog): void {
	if (state.activeSeats.length === 0) return;
	const allLocked = state.activeSeats.every((seat) => state.navigation[seat]?.locked === true);
	if (!allLocked) return;

	state.revealedDestinations = true;
	state.navigationDeadline = null; // countdown no longer applies once revealed
	state.navigationFullDeadline = null;
	const occupancy: PublicGameState['locationOccupancy'] = {};
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		const destination = player?.pendingDestination ?? null;
		if (!player || !destination) continue;
		player.navigationDestination = destination; // now public
		(occupancy[destination] ??= []).push(seat);
	}
	state.locationOccupancy = occupancy;

	// onNavigate fires once per active player AFTER every destination is public, so
	// co-location is correct (Rune Traveler shares its doubleRunes flag with the
	// players already revealed at the same location). Deep Sea Hunter gains its +4
	// initiative here; manual destination-change / Undercover prompts surface too.
	for (const seat of state.activeSeats) {
		if (!state.players[seat]?.navigationDestination) continue;
		applyTrigger(state, seat, 'onNavigate', [], { catalog });
	}

	enterEncounter(state);
}

/** Evil seats that share a non-Abyss location with a Good seat (potential PvP). */
export function encounterAggressors(state: PublicGameState): Set<SeatColor> {
	const actors = new Set<SeatColor>();
	for (const [dest, seats] of Object.entries(state.locationOccupancy)) {
		if (dest === 'Arcane Abyss') continue;
		const list = (seats ?? []) as SeatColor[];
		const evil = list.filter((s) => isEvilAlignment(state.players[s]?.statusLevel ?? 0));
		const good = list.filter((s) => !isEvilAlignment(state.players[s]?.statusLevel ?? 0));
		if (evil.length > 0 && good.length > 0) {
			for (const s of evil) actors.add(s);
		}
	}
	return actors;
}

/**
 * Encounter (PvP) phase. If any Evil player shares a location with a Good player,
 * those aggressors may initiate combat (or pass) before location actions; everyone
 * else is auto-ready. With no mixed-alignment co-location we skip straight to the
 * location phase (the common case — players only turn Evil late).
 */
export function enterEncounter(state: PublicGameState): void {
	state.phase = 'encounter';
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	// Fresh phase → clear last round's encounter votes for everyone.
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (player) player.encounterVote = null;
	}
	const aggressors = encounterAggressors(state);
	if (aggressors.size === 0) {
		enterLocation(state);
		return;
	}
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (player) player.phaseReady = !aggressors.has(seat);
	}
}

/** Advance out of the encounter phase once every aggressor has acted. */
export function tryAdvanceFromEncounter(state: PublicGameState): void {
	if (state.phase !== 'encounter') return;
	if (!allActiveSeatsReady(state)) return;
	enterLocation(state);
}

export function enterLocation(state: PublicGameState): void {
	state.phase = 'location';
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	clearPhaseReady(state);
}

/** Advance to the Benefits step once every seat has ended its location actions. */
export function tryAdvanceFromLocation(state: PublicGameState, catalog?: PlayCatalog): void {
	if (!allActiveSeatsReady(state)) return;
	enterBenefits(state, catalog);
}

/**
 * Benefits step — first of the three post-location resolution phases
 * (`benefits → awakening → cleanup`).
 *
 * Fire the `awakeningPhase` trigger for EACH active player, in seat order. Within
 * one player the dispatch resolves declarative breakpoints FIRST — the status-driven
 * grants (Cursed Spirit, The Corruptor) — then the bespoke handlers — the VP win-cons
 * (Golden Ruler's VP + self-discard, World Ender, World Guardian). So the order is:
 * status grants → VP win-cons, and every VP grant lands before any winner is declared
 * (findWinner runs in tryAdvanceFromCleanup, strictly after this whole sequence).
 *
 * The grants are not auto-applied — they're surfaced as a claimable selection
 * (`pendingAwakenReward`, claimed via `resolveAwakenReward`) which blocks committing
 * the Benefits step. The Abyss monster also advances here, at the round boundary.
 */
export function enterBenefits(state: PublicGameState, catalog?: PlayCatalog): void {
	state.phase = 'benefits';
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	clearPhaseReady(state);

	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player) continue;
		const awakeningLog: string[] = [];
		applyTrigger(state, seat, 'awakeningPhase', awakeningLog, { catalog });
		// Surface the awakening-phase grants (Cursed Spirit rewards, The Corruptor,
		// Golden Ruler VP, …) so the player sees what they earned this round.
		if (awakeningLog.length > 0) {
			player.lastAction = { key: 'awakening', label: 'Benefits', log: awakeningLog };
		}
	}

	// For each player, gather every grant they're owed this round (gated by their
	// awakened class counts + each class's condition) into one pending claim.
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player) continue;
		// Always start from a clean slate so a stale claim (e.g. a prior round the host
		// force-advanced before it was claimed) can never linger and block this step.
		player.pendingAwakenReward = null;
		const grants = collectBenefitGrants(player);
		if (grants.length > 0) {
			player.pendingAwakenReward = { grants };
		}
	}

	// Round boundary: if the Abyss monster's lives are spent (defeated this round), the
	// next, stronger monster comes out for the coming round — one kill per active player
	// to drive it off. Done here (not mid-fight) so every player faces the same listed
	// monster all round and excess kills never carry over.
	advanceMonsterIfDefeated(state, catalog);

	// Seats with nothing to claim skip the step silently; if that's everyone the whole
	// resolution sequence collapses here (see autoAdvanceResolution).
	autoAdvanceResolution(state, catalog);
}

/**
 * The per-round Benefits grants a player is owed (gated by awakened class counts +
 * each class's condition). Shared by {@link enterBenefits} (surfaced as a claimable
 * `pendingAwakenReward`) and the round-cap final-scoring pass (VP grants applied
 * directly — the game is over, there is nobody left to click a claim).
 */
function collectBenefitGrants(player: PrivatePlayerState): AwakenGrant[] {
	const counts = awakenedClassCounts(player);
	const evil = isEvilAlignment(player.statusLevel);
	const grants: AwakenGrant[] = [];

	// Cursed Spirit — one line per corruption stage entered this round, each ×N.
	const cursed = counts['Cursed Spirit'] ?? 0;
	if (cursed >= 1) {
		if (player.becameTaintedThisRound)
			grants.push({ kind: 'taintedChoice', amount: cursed, source: 'Cursed Spirit' });
		if (player.becameCorruptThisRound)
			grants.push({ kind: 'relicChoice', amount: cursed, source: 'Cursed Spirit' });
		if (player.becameFallenThisRound)
			grants.push({ kind: 'augment', amount: cursed, source: 'Cursed Spirit' });
	}
	// Golden Ruler — +1 VP (the Evil self-discard penalty is applied on claim).
	if ((counts['Golden Ruler'] ?? 0) >= 1) {
		grants.push({
			kind: 'vp',
			amount: 1,
			source: 'Golden Ruler',
			...(evil ? { note: 'You are Evil — claiming also discards a Golden Ruler spirit.' } : {})
		});
	}
	// The Corruptor — +1 Arcane Attack die, only if you corrupted this round.
	if ((counts['The Corruptor'] ?? 0) >= 1 && player.corruptedThisRound) {
		grants.push({ kind: 'attackDice', tier: 'arcane', amount: 1, source: 'The Corruptor' });
	}
	// World Ender — now a flat +1 VP via its awakeningPhase `run` handler
	// (classes/worldEnder.ts), no longer a Cleanup claim.
	// World Guardian — +6 VP, only when you are Good with ≥24 VP.
	if ((counts['World Guardian'] ?? 0) >= 1 && !evil && player.victoryPoints >= 24) {
		grants.push({ kind: 'vp', amount: 6, source: 'World Guardian' });
	}

	return grants;
}

/**
 * FINAL SCORING at the round cap: the round order puts Benefits before Awakening, so a
 * spirit awakened in the last round would never see the Benefits phase its class pays
 * out in — at a physical table players count those points anyway (rules decision,
 * 2026-07-03). So when the game ends on the {@link MAX_ROUNDS} cap, run one last
 * benefits pass for every seat, for scoring only: the `awakeningPhase` trigger (bespoke
 * VP handlers like World Ender) plus the DIRECT application of every VP-kind Benefits
 * grant (World Guardian, Golden Ruler). Non-VP grants (dice, relics, augment picks) are
 * skipped — they cannot affect the result of a finished game. The last vpHistory point
 * is re-synced so the points-over-time chart shows the final score.
 */
function applyFinalScoring(state: PublicGameState, catalog?: PlayCatalog): void {
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player) continue;
		const log: string[] = [];
		applyTrigger(state, seat, 'awakeningPhase', log, { catalog });
		for (const grant of collectBenefitGrants(player)) {
			if (grant.kind === 'vp' && grant.amount > 0) {
				player.victoryPoints = (player.victoryPoints ?? 0) + grant.amount;
				log.push(`Final scoring: +${grant.amount} VP (${grant.source}).`);
			}
		}
		if (log.length > 0) {
			player.lastAction = { key: 'final-scoring', label: 'Final Scoring', log };
		}
		if (player.vpHistory && player.vpHistory.length > 0) {
			player.vpHistory[player.vpHistory.length - 1] = player.victoryPoints;
		}
	}
}

/** Advance to the Awakening step once every seat has confirmed its benefits. */
export function tryAdvanceFromBenefits(state: PublicGameState, catalog?: PlayCatalog): void {
	if (!allActiveSeatsReady(state)) return;
	enterAwakening(state, catalog);
}

/**
 * Awakening step — flip & pay for face-down spirits. Marks every face-down spirit
 * whose awaken condition is auto-satisfiable as awaken-eligible (for the UI + bots)
 * and builds their offer/locked cards.
 */
export function enterAwakening(state: PublicGameState, catalog?: PlayCatalog): void {
	state.phase = 'awakening';
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	clearPhaseReady(state);
	recomputeAwakenEligibility(state, catalog);
	// Seats with nothing to awaken/resolve skip the step silently.
	autoAdvanceResolution(state, catalog);
}

/** Advance to the Cleanup step once every seat has confirmed its awakenings. */
export function tryAdvanceFromAwakening(state: PublicGameState, catalog?: PlayCatalog): void {
	if (!allActiveSeatsReady(state)) return;
	enterCleanup(state, catalog);
}

/**
 * Cleanup step — the final housekeeping phase: trim held runes/relics down to the
 * carry limit and resolve any outstanding corruption sacrifice, then pass. The grants
 * (Benefits) and awaken flips happened in the two prior phases.
 */
export function enterCleanup(state: PublicGameState, catalog?: PlayCatalog): void {
	state.phase = 'cleanup';
	state.phaseDeadline = null; // re-stamped by the service for the new phase
	clearPhaseReady(state);
	// Keep offers/eligibility coherent for any UI that still reads them (no new flips
	// happen here, but a spirit may have been left face-down).
	recomputeAwakenEligibility(state, catalog);
	// Seats with no overflow/corruption housekeeping skip the step silently.
	autoAdvanceResolution(state, catalog);
}

/**
 * Recompute every active player's awaken eligibility + Cleanup offer cards.
 *
 * A face-down spirit is awaken-eligible when its condition is auto-satisfiable
 * right now (free, a payable rune cost, or a scripted text condition currently
 * met); unscripted text + unpayable conditions are excluded (manual path). Each
 * eligible slot also gets an {@link AwakenOffer} naming its cost — and, for
 * discard handlers, the items the owner may choose to spend.
 *
 * Called at `enterCleanup` and again after any awaken / cleanup rune discard, so
 * the offers never go stale as the player's held items change. With no catalog
 * threaded we fall back to offering every face-down slot (free flips) with no
 * offer detail, preserving pre-P2 behavior for callers that don't pass one.
 */
export function recomputeAwakenEligibility(state: PublicGameState, catalog?: PlayCatalog): void {
	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player) continue;
		const eligible: number[] = [];
		const offers: AwakenOffer[] = [];
		const locked: AwakenLockedOffer[] = [];
		for (const s of player.spirits) {
			if (!s.isFaceDown) continue;
			if (!catalog) {
				eligible.push(s.slotIndex);
				continue;
			}
			const ctx = buildEffectContext({
				state,
				seat,
				player,
				trigger: 'awakening',
				log: [],
				traitCount: 0,
				catalog
			});
			if (!canAutoAwaken(ctx, { spirit: s })) {
				// Not yet payable — surface a passive hint of what it needs (Faeries
				// waiting on a relic, location-gated discards, etc.).
				const lockedOffer = buildAwakenLockedOffer(ctx, { spirit: s });
				if (lockedOffer) locked.push(lockedOffer);
				continue;
			}
			eligible.push(s.slotIndex);
			const offer = buildAwakenOffer(ctx, { spirit: s });
			if (offer) offers.push(offer);
		}
		player.awakenEligible = eligible;
		player.awakenOffers = offers;
		player.awakenLocked = locked;
	}
}

/**
 * Once every seat confirms cleanup, either finish the game (a player reached the
 * VP target) or roll into the next round's navigation phase.
 */
export function tryAdvanceFromCleanup(state: PublicGameState, catalog?: PlayCatalog): void {
	if (!allActiveSeatsReady(state)) return;

	// Snapshot each player's VP for the post-game "points over time" chart. This runs
	// once per round as cleanup closes — and on the final round before finishing — so
	// the series captures every round including the last.
	for (const seat of state.activeSeats) {
		const p = state.players[seat];
		if (!p) continue;
		p.vpHistory = [...(p.vpHistory ?? []), p.victoryPoints];
		// Spirit Augments are a place-this-round benefit; any still unplaced at the round
		// boundary are forfeited so the placement prompt never carries into the next round.
		p.unplacedAugments = [];
	}

	const winner = findWinner(state);
	if (winner) {
		state.winnerSeat = winner;
		state.status = 'finished';
		return;
	}

	// End condition: once every player has Fallen (the deepest corruption), the game
	// ends — the player with the most Victory Points wins (ties broken by seat order).
	if (allPlayersFallen(state)) {
		state.winnerSeat = highestVpSeat(state);
		state.status = 'finished';
		return;
	}

	// Hard round cap: round MAX_ROUNDS is the last round. If its cleanup closes with no VP-target
	// winner and not all Fallen, run FINAL SCORING (one last benefits pass — see
	// applyFinalScoring) and end — the player with the most Victory Points wins (ties → seat
	// order). Runs only after allActiveSeatsReady, so round 30 is fully played (all cleanup VP claims
	// and the vpHistory snapshot above have landed) before the winner is read. `>=` is defensive.
	if (state.round >= MAX_ROUNDS) {
		applyFinalScoring(state, catalog);
		state.winnerSeat = highestVpSeat(state);
		state.status = 'finished';
		return;
	}

	state.round += 1;
	beginNavigation(state);
}

/** The first active seat at/over the VP target, in seat order, or null. */
export function findWinner(state: PublicGameState): SeatColor | null {
	let best: { seat: SeatColor; vp: number } | null = null;
	for (const seat of state.activeSeats) {
		const vp = state.players[seat]?.victoryPoints ?? 0;
		if (vp >= VP_TO_WIN && (!best || vp > best.vp)) {
			best = { seat, vp };
		}
	}
	return best?.seat ?? null;
}

/** True when there is at least one active player and EVERY active player has Fallen
 *  (statusLevel at the deepest rung of {@link STATUS_LADDER}). Triggers game end. */
export function allPlayersFallen(state: PublicGameState): boolean {
	const seats = state.activeSeats;
	if (seats.length === 0) return false;
	const fallen = STATUS_LADDER.length - 1; // 3 = Fallen
	return seats.every((seat) => (state.players[seat]?.statusLevel ?? 0) >= fallen);
}

/** The active seat with the most Victory Points; ties broken by seat order. Null when
 *  there are no active seats. */
function highestVpSeat(state: PublicGameState): SeatColor | null {
	let best: { seat: SeatColor; vp: number } | null = null;
	for (const seat of state.activeSeats) {
		const vp = state.players[seat]?.victoryPoints ?? 0;
		if (!best || vp > best.vp) best = { seat, vp };
	}
	return best?.seat ?? null;
}

/**
 * Host override: shove the current phase forward without waiting on stragglers.
 */
export function forceAdvancePhase(state: PublicGameState, catalog?: PlayCatalog): void {
	switch (state.phase) {
		case 'navigation': {
			// Anyone who ran out the clock without choosing gets a random destination.
			for (const seat of state.activeSeats) {
				const player = state.players[seat];
				if (player && !player.pendingDestination) {
					player.pendingDestination = ALL_DESTINATIONS[nextInt(state.rng, ALL_DESTINATIONS.length)];
				}
				state.navigation[seat] = { locked: true };
			}
			tryRevealNavigation(state, catalog);
			return;
		}
		case 'encounter': {
			enterLocation(state);
			return;
		}
		case 'location': {
			enterBenefits(state, catalog);
			return;
		}
		case 'benefits': {
			enterAwakening(state, catalog);
			return;
		}
		case 'awakening': {
			enterCleanup(state, catalog);
			return;
		}
		case 'cleanup': {
			for (const seat of state.activeSeats) {
				const player = state.players[seat];
				if (player) player.phaseReady = true;
			}
			tryAdvanceFromCleanup(state, catalog);
			return;
		}
	}
}
