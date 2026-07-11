/**
 * legalActions — the COMPLETE legal move set for the ML policy at one decision point.
 *
 * Per the design directive, the bot must be able to take ANY real action a competitive
 * player can take in the actual game — we do not prune the strategic space. We enumerate
 * candidate commands for the current phase (with bounded parameter expansion) and DRY-RUN
 * each through `applyGameCommand` (pure — it clones its input, see runtime.ts), keeping
 * only those that return `ok`. The engine is its own legality oracle.
 *
 * EXCLUDED on purpose (not "real game moves" / would let the bot cheat or are 3D-tabletop
 * physical affordances, confirmed with the owner):
 *   - manual counter edits: adjustVictoryPoints/Status/Barrier/BrokenBarrier/MaxBarrier
 *   - free-form tabletop tools: spawnDiceBatch, rollSpawnedDice, clearSpawnedDice,
 *     spawnMatItem, clearSpawnedItems, moveMatObject, flipSpirit (manual face toggle)
 *   - lobby/host/dev: claimSeat, releaseSeat, selectGuardian, setNavigationTimer,
 *     startGame, forceAdvancePhase, debugGrant
 *   - market family (rules v1.1): takeSpirit, replaceSpirit, refillMarket — removed
 *     from the game rules entirely (the reducer rejects them as unsupported_command).
 *     They were never reachable from the UI, had no cost/phase/destination gating,
 *     and let bots build whole boards from free market takes while locked to the
 *     Abyss (see docs/rules-v1.1.md). NOTE: removing them changed the candidate
 *     enumeration ORDER, so BC `chosen` indices recorded before rules v1.1 do not
 *     align with post-v1.1 candidate sets.
 * Everything else — every rules-driven action across all six phases — is enumerated.
 */

import { applyGameCommand } from '../runtime';
import { resetCombatFlags, takeDamage, pvpVpForAttack } from '../combat';
import { applyTrigger } from '../effects/apply';
import { botActorFor, computeKillProbability } from '../server/botPolicy';
import { canApply } from '../legality';
import { buildMonsterRewards, rewardClaimCount, type MonsterRewardOption } from '../monsterRewards';
import {
	ALL_DESTINATIONS,
	type GameActor,
	type GameCommand,
	type PendingRewardState,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';

const MAX_LOCATION_ROWS = 10;
/** How many distinct "or"-option choices to expand per location reward row. */
const MAX_ROW_CHOICES = 3;
const MAX_MONSTER_REWARD_OPTIONS = 8;
const MAX_MONSTER_REWARD_PICK_SIZE = 3;
const MAX_MONSTER_REWARD_CHOICE_VARIANTS = 6;
const MAX_MONSTER_REWARD_COMMANDS = 160;

/**
 * A legal candidate command paired with two deliberately different state views.
 *
 * `next` is the authoritative dry-run result. It may contain dice rolls, shuffled bag
 * order, drawn spirit identities, or a resolved PvP exchange. It is retained so the
 * caller can commit the chosen action without running the reducer a second time, and so
 * post-action training labels can describe what actually happened.
 *
 * `policyNext` is the only next-state a policy/search scorer may inspect before choosing
 * the action. For deterministic commands it is the same object as `next`. For commands
 * that reveal a hidden stochastic outcome it is a redacted post-action preview: guaranteed
 * effects (monster damage, action consumption, fixed VP, phase progress, draw count) remain,
 * while roll faces, draw identities, shuffled order, and stochastic PvP damage are removed.
 * Expected/public combat facts are encoded separately by `encodeAction`.
 */
export interface LegalAction {
	cmd: GameCommand;
	next: PublicGameState;
	policyNext: PublicGameState;
	hasHiddenOutcome: boolean;
}

function rngAdvanced(before: PublicGameState, after: PublicGameState): boolean {
	return before.rng.seed !== after.rng.seed || before.rng.cursor !== after.rng.cursor;
}

function bagContentsChanged(before: PublicGameState, after: PublicGameState): boolean {
	const sig = (contents: PublicGameState['bags']['hexSpirits']['contents']): string =>
		contents.map((entry) => `${entry.guid}:${entry.id ?? ''}:${entry.cost ?? ''}`).join('|');
	return (
		sig(before.bags.hexSpirits.contents) !== sig(after.bags.hexSpirits.contents) ||
		sig(before.bags.abyssFallen.contents) !== sig(after.bags.abyssFallen.contents)
	);
}

function handDrawsChanged(before: PublicGameState, after: PublicGameState): boolean {
	const sig = (state: PublicGameState): string =>
		Object.entries(state.players)
			.map(
				([seat, player]) =>
					`${seat}:${(player?.handDraws ?? []).map((draw) => draw.guid).join(',')}`
			)
			.sort()
			.join('|');
	return sig(before) !== sig(after);
}

function marketChanged(before: PublicGameState, after: PublicGameState): boolean {
	return before.market.some(
		(slot, index) => slot.spiritId !== (after.market[index]?.spiritId ?? null)
	);
}

function revealsNewHandDraw(before: PublicGameState, after: PublicGameState): boolean {
	const known = new Set<string>();
	for (const player of Object.values(before.players)) {
		for (const draw of player?.handDraws ?? []) known.add(draw.guid);
	}
	for (const player of Object.values(after.players)) {
		for (const draw of player?.handDraws ?? []) {
			if (!known.has(draw.guid)) return true;
		}
	}
	return false;
}

function resolvedNewPvpCombat(before: PublicGameState, after: PublicGameState): boolean {
	const priorIds = new Set(
		before.combats.filter((combat) => combat.kind === 'pvp').map((combat) => combat.id)
	);
	return after.combats.some((combat) => combat.kind === 'pvp' && !priorIds.has(combat.id));
}

/**
 * True when a reducer dry-run contains information the acting player did not know at
 * commitment time. This is intentionally outcome-based rather than a coarse command
 * allowlist: location/reward/spawn commands are stochastic only when they actually open
 * a hidden draw or reshuffle a bag, and `initiatePvp` is stochastic only when that vote
 * resolves the exchange.
 *
 * RNG used solely for opaque instance ids is not classified as a hidden outcome. Those
 * ids do not change the public/deterministic value of the command. A changed bag plus an
 * advanced RNG cursor, by contrast, is a real hidden shuffle and must be masked.
 */
export function commandHasHiddenOutcome(
	before: PublicGameState,
	cmd: GameCommand,
	after: PublicGameState
): boolean {
	if (cmd.type === 'startCombat') return true;
	if (resolvedNewPvpCombat(before, after)) return true;
	if (revealsNewHandDraw(before, after)) return true;
	if (marketChanged(before, after) && bagContentsChanged(before, after)) return true;
	return (
		rngAdvanced(before, after) &&
		(bagContentsChanged(before, after) || handDrawsChanged(before, after))
	);
}

/** Selection helpers use this instead of inferring progress from a realized random result. */
export function isStochasticLegalAction(action: LegalAction): boolean {
	return action.hasHiddenOutcome;
}

/** Single policy-facing access point. Selection code must never inspect `action.next`. */
export function policyPreviewState(action: LegalAction): PublicGameState {
	return action.policyNext;
}

/** Compatibility view for archived predicates that still name their state field `next`. */
export function policySafeAction(action: LegalAction): LegalAction {
	return action.next === action.policyNext ? action : { ...action, next: action.policyNext };
}

function buildCombatPolicyPreview(
	before: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): PublicGameState {
	const preview = structuredClone(before) as PublicGameState;
	const player = preview.players[seat];
	const monster = preview.monster;
	if (!player || !monster) return preview;

	// Monster initiative is infinite, so this opening hit is known before commitment.
	// Re-run only the deterministic pre-roll half of fightMonster.
	resetCombatFlags(player);
	applyTrigger(preview, seat, 'inCombat', [], { catalog });
	takeDamage(player, monster.damage, { state: preview, seat, catalog }, []);
	player.actionsUsedThisRound.push('combat');
	const guaranteedKillProbability = Math.max(
		computeKillProbability(before, seat, catalog),
		computeKillProbability(before, seat, catalog, { allowCorruptKill: true })
	);
	if (guaranteedKillProbability >= 1 - 1e-12) {
		monster.livesRemaining = Math.max(0, monster.livesRemaining - 1);
		const claim = rewardClaimCount(monster.rewardTrack, monster.chooseAmount);
		if (claim > 0) {
			player.pendingReward = {
				monsterId: monster.id,
				monsterName: monster.name,
				rewardTrack: [...monster.rewardTrack],
				chooseAmount: claim
			};
		}
	} else if (guaranteedKillProbability <= 1e-12) {
		// Adaptive Fighter's no-kill branch is deterministic when every roll misses.
		applyTrigger(preview, seat, 'onMonsterKill', [], {
			catalog,
			combat: { dealt: 0, overkill: 0, killed: false }
		});
	}
	// Starting a fresh fight replaces the prior overlay for this seat, but the new
	// overlay contains the hidden roll and therefore is not part of the preview.
	preview.combats = preview.combats.filter((entry) => entry.sides[0]?.seat !== seat);
	preview.rng = structuredClone(before.rng);
	return preview;
}

function buildPvpPolicyPreview(before: PublicGameState, after: PublicGameState): PublicGameState {
	const priorIds = new Set(
		before.combats.filter((combat) => combat.kind === 'pvp').map((combat) => combat.id)
	);
	const resolved = after.combats.find(
		(combat) => combat.kind === 'pvp' && !priorIds.has(combat.id)
	);
	if (!resolved) return structuredClone(before) as PublicGameState;

	// Keep deterministic encounter -> location progress, then restore participants to
	// their pre-roll material state. Readiness/votes are public consequences of the vote.
	const preview = structuredClone(after) as PublicGameState;
	for (const seat of before.activeSeats) {
		const prior = before.players[seat];
		const post = after.players[seat];
		if (!prior || !post) continue;
		const phaseReady = post.phaseReady;
		const encounterVote = post.encounterVote;
		preview.players[seat] = structuredClone(prior);
		preview.players[seat]!.phaseReady = phaseReady;
		preview.players[seat]!.encounterVote = encounterVote;
	}
	// The engagement award is fixed and public; corruption bounties depend on rolls.
	for (const side of resolved.sides) {
		if (side.side !== 'evil') continue;
		const player = preview.players[side.seat];
		const priorVp = before.players[side.seat]?.victoryPoints ?? 0;
		if (player) player.victoryPoints = priorVp + pvpVpForAttack(0);
	}
	preview.combats = structuredClone(before.combats);
	preview.bags = structuredClone(before.bags);
	preview.rng = structuredClone(before.rng);
	preview.status = before.status;
	preview.winnerSeat = before.winnerSeat;
	preview.spiritWorldSaved = before.spiritWorldSaved;
	return preview;
}

function hiddenBagContents(label: string, count: number) {
	return Array.from({ length: count }, (_, index) => ({
		name: 'Hidden Spirit',
		guid: `__hidden_${label}_${index}`
	}));
}

function buildRedactedOutcomePreview(
	before: PublicGameState,
	after: PublicGameState
): PublicGameState {
	const preview = structuredClone(after) as PublicGameState;
	preview.rng = structuredClone(before.rng);

	for (const seat of before.activeSeats) {
		const prior = before.players[seat];
		const post = after.players[seat];
		const shown = preview.players[seat];
		if (!prior || !post || !shown) continue;
		const beforeSig = prior.handDraws.map((draw) => draw.guid).join('|');
		const afterSig = post.handDraws.map((draw) => draw.guid).join('|');
		if (beforeSig !== afterSig && post.handDraws.length > 0) {
			shown.handDraws = post.handDraws.map((draw, index) => ({
				guid: `__hidden_draw_${seat}_${index}`,
				sourceBag: draw.sourceBag
			}));
		}
	}

	for (const [label, key] of [
		['world', 'hexSpirits'],
		['abyss', 'abyssFallen']
	] as const) {
		const prior = before.bags[key];
		const post = after.bags[key];
		const priorSig = prior.contents.map((entry) => entry.guid).join('|');
		const postSig = post.contents.map((entry) => entry.guid).join('|');
		if (priorSig !== postSig) {
			preview.bags[key].contents = hiddenBagContents(label, post.count);
		}
	}
	// Per-spirit history deltas would identify which hidden card left the bag.
	preview.bags.history = structuredClone(before.bags.history);
	for (let i = 0; i < preview.market.length; i++) {
		if (before.market[i]?.spiritId !== after.market[i]?.spiritId) {
			preview.market[i].spiritId = `__hidden_market_${i}`;
		}
	}
	return preview;
}

function buildPolicyPreview(
	before: PublicGameState,
	seat: SeatColor,
	cmd: GameCommand,
	after: PublicGameState,
	catalog: PlayCatalog
): PublicGameState {
	if (cmd.type === 'startCombat') return buildCombatPolicyPreview(before, seat, catalog);
	if (resolvedNewPvpCombat(before, after)) return buildPvpPolicyPreview(before, after);
	return buildRedactedOutcomePreview(before, after);
}

function rewardChoiceVariants(option: MonsterRewardOption): number[] {
	if (option.effect.type !== 'chooseRune') return [0];
	return Array.from(
		{ length: Math.min(option.effect.options.length, MAX_MONSTER_REWARD_CHOICE_VARIANTS) },
		(_, i) => i
	);
}

function emitChoiceProducts(
	picks: MonsterRewardOption[],
	emit: (choices: number[]) => void,
	index = 0,
	choices: number[] = []
): void {
	if (index >= picks.length) {
		emit(choices);
		return;
	}
	const opt = picks[index];
	const variants = rewardChoiceVariants(opt);
	if (opt.effect.type !== 'chooseRune') {
		emitChoiceProducts(picks, emit, index + 1, choices);
		return;
	}
	for (const choice of variants) {
		emitChoiceProducts(picks, emit, index + 1, [...choices, choice]);
	}
}

function emitMonsterRewardCommands(
	pending: PendingRewardState,
	emit: (cmd: GameCommand) => void
): void {
	const options = buildMonsterRewards(pending.rewardTrack);
	const maxPick = Math.min(pending.chooseAmount, options.length);
	if (maxPick <= 0) return;
	if (options.length > MAX_MONSTER_REWARD_OPTIONS || maxPick > MAX_MONSTER_REWARD_PICK_SIZE) {
		const first = options.slice(0, maxPick).map((opt) => opt.index);
		emit({ type: 'resolveMonsterReward', picks: first });
		const last = options.slice(-maxPick).map((opt) => opt.index);
		if (last.join(',') !== first.join(',')) emit({ type: 'resolveMonsterReward', picks: last });
		return;
	}

	let emitted = 0;
	const walk = (start: number, picks: MonsterRewardOption[], targetSize: number): void => {
		if (emitted >= MAX_MONSTER_REWARD_COMMANDS) return;
		if (picks.length === targetSize) {
			emitChoiceProducts(picks, (choices) => {
				if (emitted >= MAX_MONSTER_REWARD_COMMANDS) return;
				const cmd: GameCommand = {
					type: 'resolveMonsterReward',
					picks: picks.map((opt) => opt.index)
				};
				if (choices.length > 0) cmd.choices = choices;
				emit(cmd);
				emitted++;
			});
			return;
		}
		for (let i = start; i < options.length; i++) {
			walk(i + 1, [...picks, options[i]], targetSize);
		}
	};

	for (let size = 1; size <= maxPick && emitted < MAX_MONSTER_REWARD_COMMANDS; size++) {
		walk(0, [], size);
	}
}

/**
 * Enumerate every CANDIDATE command for the current phase (with bounded parameter expansion),
 * calling `emit` for each in a fixed, deterministic order. This is the single source of truth for
 * the action surface — `legalActions` and `legalActionsWithNext` both drive it, so the candidate
 * SET and ORDER are guaranteed identical between them (the BC `chosen` index depends on this order).
 * Legality is NOT decided here; the callers filter via `canApply` / the clone oracle.
 */
export function enumerateCandidates(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	emit: (cmd: GameCommand) => void
): void {
	const me = state.players[seat];
	const tryAdd = emit;

	switch (state.phase) {
		case 'navigation': {
			for (const d of ALL_DESTINATIONS) tryAdd({ type: 'lockNavigation', destination: d });
			tryAdd({ type: 'unlockNavigation' }); // allow backing out a lock-in
			break;
		}

		case 'encounter': {
			// The PvP fork — the single most important strategic decision at 4+ players.
			tryAdd({ type: 'initiatePvp' });
			tryAdd({ type: 'passEncounter' });
			break;
		}

		case 'location': {
			const dest = me?.navigationDestination ?? null;
			const rowCount = dest
				? (catalog.locations?.find((l) => l.name === dest)?.rewardRows.length ?? MAX_LOCATION_ROWS)
				: MAX_LOCATION_ROWS;
			// Resolve a reward row — default choices, plus expand the discrete "or"-gain options
			// so the bot can pick WHICH benefit (a real strategic choice, not just which row).
			for (let r = 0; r < rowCount; r++) {
				tryAdd({ type: 'resolveLocationInteraction', rowIndex: r });
				for (let c = 1; c < MAX_ROW_CHOICES; c++) {
					tryAdd({ type: 'resolveLocationInteraction', rowIndex: r, choices: [c] });
				}
			}
			// Summoning: which drawn spirit to keep, redraw, or discard the draw.
			for (const h of me?.handDraws ?? []) tryAdd({ type: 'spawnHandSpirit', guid: h.guid });
			tryAdd({ type: 'redrawHandDraws' });
			tryAdd({ type: 'discardHandDraws' });
			// Monster combat + reward claim.
			tryAdd({ type: 'startCombat' });
			if (me?.pendingReward) emitMonsterRewardCommands(me.pendingReward, tryAdd);
			// Spirit/rune management actions that exist in real play.
			for (let s = 0; s < (me?.spirits?.length ?? 0); s++)
				tryAdd({ type: 'absorbSpirit', slotIndex: s });
			for (const mat of me?.mats ?? []) {
				const runeId = (mat as { runeId?: string }).runeId;
				if (!runeId) continue;
				for (let s = 0; s < (me?.spirits?.length ?? 0); s++)
					tryAdd({ type: 'attachRuneToSpirit', runeId, spiritSlotIndex: s });
			}
			for (let s = 0; s < (me?.spirits?.length ?? 0); s++) {
				for (const att of me?.spiritAugmentAttachments ?? []) {
					const rId = (att as { runeId?: string }).runeId;
					if (rId) tryAdd({ type: 'detachRuneFromSpirit', runeId: rId, spiritSlotIndex: s });
				}
			}
			// Pay down a forced corruption-discard obligation (from fighting the Abyss
			// monster, or a lost PvP strike). It blocks `endLocationActions` until paid, so
			// WITHOUT these candidates a corrupted bot had no progressing move and stalled
			// until the host deadline drain — the "bots freeze when they corrupt" bug. The
			// heuristic botPolicy already sheds spirits here; this gives the neural surface
			// the same escape.
			if (me?.pendingCorruptionDiscard && (me?.spirits?.length ?? 0) > 0) {
				for (let i = 0; i < (me?.spirits?.length ?? 0); i++)
					tryAdd({ type: 'discardSpirit', slotIndex: me!.spirits[i].slotIndex });
			}
			tryAdd({ type: 'endLocationActions' }); // yield
			break;
		}

		case 'benefits': {
			tryAdd({ type: 'commitBenefits' }); // yield
			break;
		}

		case 'awakening': {
			// Flip & pay for face-down spirits — including discard-cost variants per offer.
			for (const off of me?.awakenOffers ?? []) {
				tryAdd({ type: 'awakenSpirit', slotIndex: off.slotIndex });
				for (const opt of off.options ?? [])
					tryAdd({ type: 'awakenSpirit', slotIndex: off.slotIndex, discardRefs: [opt.ref] });
			}
			for (let s = 0; s < (me?.spirits?.length ?? 0); s++)
				tryAdd({ type: 'manualAwaken', slotIndex: s });
			// Resolve class decision cards (every option).
			for (const dec of me?.pendingDecisions ?? [])
				for (const o of dec.options)
					tryAdd({ type: 'resolveDecision', decisionId: dec.id, optionId: o.id });
			// Place unplaced augments onto spirits (every augment × every spirit).
			for (let a = 0; a < (me?.unplacedAugments?.length ?? 0); a++) {
				const aug = me!.unplacedAugments![a];
				for (let s = 0; s < (me?.spirits?.length ?? 0); s++)
					tryAdd({
						type: 'placeAugmentOnSpirit',
						augmentIndex: a,
						augmentRuneId: aug.runeId,
						spiritSlotIndex: s
					});
			}
			if (me?.pendingAwakenReward) {
				tryAdd({ type: 'resolveAwakenReward' });
				const grants = me.pendingAwakenReward.grants ?? [];
				const tainted = grants.find((g) => g.kind === 'taintedChoice') as
					| { amount: number }
					| undefined;
				if (tainted)
					for (let t = 0; t <= tainted.amount; t++)
						tryAdd({ type: 'resolveAwakenReward', taintedMaxBarrier: t });
			}
			for (const mp of me?.manualPrompts ?? []) tryAdd({ type: 'dismissManualPrompt', id: mp.id });
			tryAdd({ type: 'commitAwakening' }); // yield
			break;
		}

		case 'cleanup': {
			for (let i = 0; i < (me?.spirits?.length ?? 0); i++)
				tryAdd({ type: 'discardSpirit', slotIndex: i });
			for (let i = 0; i < (me?.mats?.length ?? 0); i++)
				tryAdd({ type: 'discardRune', slotIndex: i });
			tryAdd({ type: 'commitCleanup' }); // yield — the cleanup-phase yield a real bot/player issues
			// NOTE: `commitRound` is intentionally NOT offered. It is a server/host-level
			// round-advance + history-snapshot command (service.ts), which botSim "never calls"
			// and the heuristic never emits — a real player only ever commits cleanup. Offering it
			// let the bot bypass the proper cleanup→round-advance (winner/Fallen end-checks + the
			// per-round VP snapshot), diverging from live play. Round advance happens via the
			// phase machine, exactly as in the live game.
			break;
		}
	}
}

/**
 * Full legal candidate set WITH the resulting next-state for each. `canApply` skips the clone for
 * candidates it can prove ILLEGAL (no clone, no push); the clone oracle confirms the rest and yields
 * the next-state that value-lookahead consumes. A `canApply === true` candidate still clones here
 * because this function needs its next-state — the win for `legalActionsWithNext` is skipping the
 * illegal majority. (The zero-clone win is in `legalActions`, which needs no next-states.)
 */
export function legalActionsWithNext(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): LegalAction[] {
	const actor: GameActor = botActorFor(state, seat);
	const out: LegalAction[] = [];
	enumerateCandidates(state, seat, catalog, (cmd) => {
		if (canApply(state, actor, cmd, catalog) === false) return; // provably illegal — no clone
		const r = applyGameCommand(state, actor, cmd, catalog);
		if (r.ok) {
			const hasHiddenOutcome = commandHasHiddenOutcome(state, cmd, r.state);
			out.push({
				cmd,
				next: r.state,
				policyNext: hasHiddenOutcome
					? buildPolicyPreview(state, seat, cmd, r.state, catalog)
					: r.state,
				hasHiddenOutcome
			});
		}
	});
	return out;
}

/**
 * Cmd-only legal set — needs no next-states, so `canApply` decides most candidates with ZERO clones
 * (the dominant behavior-cloning / data-gen path). Only `undefined` verdicts fall back to the clone
 * oracle. Candidate order matches `legalActionsWithNext` exactly (shared enumerator) so the recorded
 * BC `chosen` index is stable.
 */
export function legalActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): GameCommand[] {
	const actor: GameActor = botActorFor(state, seat);
	const out: GameCommand[] = [];
	enumerateCandidates(state, seat, catalog, (cmd) => {
		const verdict = canApply(state, actor, cmd, catalog);
		if (verdict === false) return;
		if (verdict === true) {
			out.push(cmd);
			return;
		}
		if (applyGameCommand(state, actor, cmd, catalog).ok) out.push(cmd); // undefined → clone oracle
	});
	return out;
}

/**
 * Does candidate `a` correspond to planned command `b`? Matches on type + the salient
 * identifying parameter(s) only — so a heuristic's command that carries extra sub-params
 * still matches the candidate. Used to label which legal candidate the heuristic picked.
 */
export function commandMatches(a: GameCommand, b: GameCommand): boolean {
	if (a.type !== b.type) return false;
	switch (a.type) {
		case 'lockNavigation':
		case 'selectNavigationDestination':
			return a.destination === (b as typeof a).destination;
		case 'resolveLocationInteraction':
			return (
				a.rowIndex === (b as typeof a).rowIndex &&
				(a.choices?.[0] ?? 0) === ((b as typeof a).choices?.[0] ?? 0)
			);
		case 'spawnHandSpirit':
			return a.guid === (b as typeof a).guid;
		case 'takeSpirit':
			return a.marketIndex === (b as typeof a).marketIndex;
		case 'replaceSpirit':
			return (
				a.marketIndex === (b as typeof a).marketIndex && a.slotIndex === (b as typeof a).slotIndex
			);
		case 'awakenSpirit':
		case 'discardSpirit':
		case 'discardRune':
		case 'manualAwaken':
		case 'absorbSpirit':
			return a.slotIndex === (b as typeof a).slotIndex;
		case 'resolveDecision':
			return a.decisionId === (b as typeof a).decisionId && a.optionId === (b as typeof a).optionId;
		case 'placeAugmentOnSpirit':
			return (
				a.augmentIndex === (b as typeof a).augmentIndex &&
				a.spiritSlotIndex === (b as typeof a).spiritSlotIndex
			);
		default:
			return true; // type-only commands: passEncounter, initiatePvp, commit*, refillMarket, etc.
	}
}
