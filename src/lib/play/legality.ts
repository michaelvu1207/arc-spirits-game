/**
 * canApply — a PURE, side-effect-free legality oracle for the simulator's hot path.
 *
 * Determining "is this command legal?" by deep-cloning the state and trial-applying it
 * (the `applyGameCommand` clone oracle) is ~71% of all simulation time — we clone a ~38 KB
 * state thousands of times per game just to read one boolean. `canApply` answers the same
 * question by READING the state (no clone, no mutation), so `legalActions` can decide a
 * candidate without a clone.
 *
 * Contract:
 *   - returns `true`  → the reducer WOULD accept this command (provably, from pure reads)
 *   - returns `false` → the reducer WOULD reject it (a precondition provably fails)
 *   - returns `undefined` → not cheaply decidable; the caller MUST fall back to the clone oracle
 *
 * FIDELITY GUARANTEE: `_canApply.test.ts` drives full games across every profile/phase and, for
 * every enumerated candidate, asserts `canApply(...) === undefined || canApply(...) === applyGameCommand(...).ok`.
 * So `canApply` can only ever be MORE conservative than the reducer (defer), never WRONG — the
 * legal action set stays a faithful, complete oracle of the real game (the binding directive).
 * When in any doubt about a command's guards, return `undefined` (correct but slow) rather than a
 * guess (fast but potentially unfaithful).
 *
 * Each `case` reads only state/player/catalog (no RNG, no mutation) and mirrors the reducer's
 * reachable `failure(...)` guards for that command type. The guard set per command was mapped from
 * src/lib/play/runtime.ts (see docs/sim-optimization-plan.md). Commands whose acceptance depends on
 * impure / ctx-heavy checks (combat, awaken conditions, augment placement) reject on their cheap
 * pure guards and otherwise DEFER (`undefined`).
 */

import { ALL_DESTINATIONS, isEvilAlignment, RUNE_CARRY_LIMIT } from './types';
import type { GameActor, GameCommand, PlayCatalog, PrivatePlayerState, PublicGameState } from './types';
import { buildLocationInteractions, matchRewardCost } from './locationInteractions';
import { awakenedClassCounts } from './effects/apply';

/** Pure mirror of activePlayerForActor's null-ness (no mutating ensurePlayerCollections backfill). */
function seatPlayer(state: PublicGameState, actor: GameActor): PrivatePlayerState | null {
	const seat = actor.seatColor;
	if (!seat) return null;
	return state.players[seat] ?? null;
}

/** Pure replica of runtime.ts firstOpenSpiritSlot — first 1..7 slot not occupied, else undefined. */
function firstOpenSpiritSlot(player: PrivatePlayerState): number | undefined {
	for (let i = 1; i <= 7; i++) {
		if (!player.spirits.some((s) => s.slotIndex === i)) return i;
	}
	return undefined;
}

export function canApply(
	state: PublicGameState,
	actor: GameActor,
	command: GameCommand,
	catalog: PlayCatalog
): boolean | undefined {
	const active = state.status === 'active';

	switch (command.type) {
		// ─── No reducer case exists → switch `default` always returns failure('unsupported_command').
		//     These are enumerated (× spirits / × mats) but rejected 100% of the time — pure free win.
		case 'absorbSpirit':
		case 'attachRuneToSpirit':
		case 'detachRuneFromSpirit':
			return false;

		// ─── Navigation phase ───────────────────────────────────────────────
		case 'lockNavigation': {
			if (!active || state.phase !== 'navigation' || state.revealedDestinations) return false;
			if (!seatPlayer(state, actor)) return false;
			return ALL_DESTINATIONS.includes(command.destination as (typeof ALL_DESTINATIONS)[number]);
		}
		case 'unlockNavigation': {
			if (!active || state.phase !== 'navigation' || state.revealedDestinations) return false;
			return seatPlayer(state, actor) !== null;
		}

		// ─── Encounter phase ────────────────────────────────────────────────
		case 'passEncounter': {
			if (!active || state.phase !== 'encounter') return false;
			return seatPlayer(state, actor) !== null;
		}
		case 'initiatePvp': {
			if (!active || state.phase !== 'encounter') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (!isEvilAlignment(me.statusLevel)) return false;
			return undefined; // no_targets needs encounterGoodTargets(state, seat) — defer (1 candidate)
		}

		// ─── Location phase: market ─────────────────────────────────────────
		case 'takeSpirit':
		case 'replaceSpirit': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			const slot = state.market?.[command.marketIndex];
			if (!slot || !slot.spiritId) return false;
			if (!catalog.spirits.find((e) => e.id === slot.spiritId)) return false;
			const slotIndex = command.type === 'takeSpirit' ? command.slotIndex ?? firstOpenSpiritSlot(me) : command.slotIndex;
			if (!slotIndex || slotIndex < 1 || slotIndex > 7) return false;
			return true;
		}
		case 'refillMarket': {
			return active ? true : false;
		}

		// ─── Location phase: hand draws (summoning) ─────────────────────────
		case 'spawnHandSpirit': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (!me.pendingDraw || (me.handDraws?.length ?? 0) === 0) return false;
			const draw = (me.handDraws ?? []).find((e) => e.guid === command.guid);
			if (!draw?.id) return false;
			if (!catalog.spirits.find((e) => e.id === draw.id)) return false;
			const slotIndex = command.slotIndex ?? firstOpenSpiritSlot(me);
			if (!slotIndex || slotIndex < 1 || slotIndex > 7) return false;
			return true;
		}
		case 'discardHandDraws': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return (me.handDraws?.length ?? 0) > 0;
		}
		case 'redrawHandDraws': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (!me.redrawAvailable) return false;
			return !!me.pendingDraw && (me.handDraws?.length ?? 0) > 0;
		}

		// ─── Location phase: combat / reward / yield ────────────────────────
		case 'startCombat': {
			if (!active || state.phase !== 'location') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (me.navigationDestination !== 'Arcane Abyss') return false;
			if (!state.monster) return false;
			const used = (me.actionsUsedThisRound ?? []).filter((a) => a === 'combat').length;
			if (used >= 1 + (me.extraActions?.combat ?? 0)) return false;
			return undefined; // mutate-before-reject handler; all reachable rejects covered, defer on pass (1 candidate)
		}
		case 'resolveMonsterReward': {
			if (!active || state.phase !== 'location') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (!me.pendingReward) return false;
			return undefined; // picks/choice validity needs buildMonsterRewards — defer on pass
		}
		case 'endLocationActions': {
			if (!active || state.phase !== 'location') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (me.pendingDraw || (me.handDraws?.length ?? 0) > 0 || (me.pendingDrawQueue?.length ?? 0) > 0) return false;
			if (me.pendingCorruptionDiscard) return false;
			if (me.pendingReward) return false;
			return true;
		}

		// ─── Location phase: the high-fanout reward-row resolver ────────────
		case 'resolveLocationInteraction': {
			if (!active || state.phase !== 'location') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (me.pendingDraw != null || (me.handDraws?.length ?? 0) > 0) return false;
			if (!me.navigationDestination) return false;
			const rows = buildLocationInteractions(
				(catalog.locations ?? []).find((l) => l.name === me.navigationDestination)?.rewardRows
			);
			const interaction = rows.find((i) => i.rowIndex === command.rowIndex);
			if (!interaction) return false;
			const usedForRow = (me.actionsUsedThisRound ?? []).filter((a) => a === `row:${command.rowIndex}`).length;
			if (usedForRow >= 1 + (me.extraActions?.locationInteraction ?? 0)) return false;
			// Affordability: only consulted when the row has a cost AND neither free-waiver applies.
			if (interaction.cost.length > 0) {
				const counts = awakenedClassCounts(me);
				// Scan gains to know whether this row grants a relic/augment (drives the waivers), walking
				// the INDEPENDENT chooseRune cursor over command.choices exactly as the reducer does.
				let waiverCursor = 0;
				let grantsRelic = false;
				let grantsAugment = false;
				for (const gain of interaction.gains) {
					const g = gain as { kind?: string; rune?: { type?: string }; options?: { type?: string }[] };
					if (g.kind === 'rune') {
						if (g.rune?.type === 'relic') grantsRelic = true;
						if (g.rune?.type === 'augment') grantsAugment = true;
					} else if (g.kind === 'chooseRune') {
						const idx = command.choices?.[waiverCursor] ?? 0;
						waiverCursor += 1;
						const t = g.options?.[idx]?.type ?? g.options?.[0]?.type;
						if (t === 'relic') grantsRelic = true;
						if (t === 'augment') grantsAugment = true;
					}
				}
				const modInjectorFree = (counts['Mod Injector'] ?? 0) >= 1 && grantsAugment;
				const undercoverFree = !!me.freeNextRelicTrade && grantsRelic;
				if (!modInjectorFree && !undercoverFree) {
					if (!matchRewardCost(interaction.cost, me.mats, command.costChoices).ok) return false;
				}
			}
			return true;
		}

		// ─── Awakening phase ────────────────────────────────────────────────
		case 'awakenSpirit': {
			if (!active || state.phase !== 'awakening') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			const spirit = me.spirits.find((e) => e.slotIndex === command.slotIndex);
			if (!spirit) return false;
			if (spirit.isFaceDown === false) return false;
			return undefined; // awaken condition + payment are ctx/impure — defer on pass
		}
		case 'manualAwaken': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			const spirit = me.spirits.find((e) => e.slotIndex === command.slotIndex);
			if (!spirit) return false;
			if (spirit.isFaceDown === false) return false;
			return undefined; // not_manual_awaken needs needsManualAwaken(ctx) — defer on pass
		}
		case 'resolveDecision': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return (me.pendingDecisions ?? []).some((e) => e.id === command.decisionId);
		}
		case 'placeAugmentOnSpirit': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			if (!me.spirits.find((e) => e.slotIndex === command.spiritSlotIndex)) return false;
			return undefined; // augment resolution + capacity are fiddly — defer on pass after cheap rejects
		}
		case 'resolveAwakenReward': {
			if (!active || state.phase !== 'benefits') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return !!me.pendingAwakenReward;
		}
		case 'dismissManualPrompt': {
			return seatPlayer(state, actor) !== null;
		}
		case 'commitBenefits': {
			if (!active || state.phase !== 'benefits') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return !me.pendingAwakenReward;
		}
		case 'commitAwakening': {
			if (!active || state.phase !== 'awakening') return false;
			return seatPlayer(state, actor) !== null;
		}

		// ─── Cleanup phase ──────────────────────────────────────────────────
		case 'discardSpirit': {
			if (!active) return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return me.spirits.some((e) => e.slotIndex === command.slotIndex);
		}
		case 'discardRune': {
			if (!active || state.phase !== 'cleanup') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			return (me.mats ?? []).some((r) => r.slotIndex === command.slotIndex && r.hasRune);
		}
		case 'commitCleanup': {
			if (!active || state.phase !== 'cleanup') return false;
			const me = seatPlayer(state, actor);
			if (!me) return false;
			const heldRunes = (me.mats ?? []).filter((s) => s.hasRune).length;
			if (heldRunes > RUNE_CARRY_LIMIT) return false;
			if (me.pendingCorruptionDiscard) return false;
			return true;
		}

		default:
			return undefined;
	}
}
