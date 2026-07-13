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
import { augmentClassChoices } from '../augments';
import { decisionPickerSpec } from '../decisionPicker';
import { botActorFor, computeKillProbability } from '../server/botPolicy';
import { canApply } from '../legality';
import {
	buildLocationInteractions,
	eligibleCostSlots,
	isWildcardCost,
	relicOptions
} from '../locationInteractions';
import { buildMonsterRewards, rewardClaimCount, type MonsterRewardOption } from '../monsterRewards';
import {
	ALL_DESTINATIONS,
	DICE_TIER_ORDER,
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
const MAX_ENGINE_CHOICE_COMMANDS = 512;

/** Deterministic combinations without replacement. The game caps attack dice at ten, mats at
 * four and relic variants at five, so the bounded surfaces below stay small enough to dry-run. */
function combinations<T>(
	items: readonly T[],
	count: number,
	limit = MAX_ENGINE_CHOICE_COMMANDS
): T[][] {
	if (count <= 0) return [[]];
	if (count > items.length) return [];
	const out: T[][] = [];
	const chosen: T[] = [];
	const visit = (start: number): void => {
		if (out.length >= limit) return;
		if (chosen.length === count) {
			out.push([...chosen]);
			return;
		}
		for (let i = start; i <= items.length - (count - chosen.length); i += 1) {
			chosen.push(items[i]);
			visit(i + 1);
			chosen.pop();
			if (out.length >= limit) return;
		}
	};
	visit(0);
	return out;
}

/** Multiset choices (combinations with repetition), used for N independently chosen relic grants.
 * Order is irrelevant to the reducer, so this emits C(N+K-1,K-1), not K^N duplicates. */
function multisetPicks(optionCount: number, count: number): number[][] {
	if (count <= 0) return [[]];
	const out: number[][] = [];
	const chosen: number[] = [];
	const visit = (minimum: number): void => {
		if (out.length >= MAX_ENGINE_CHOICE_COMMANDS) return;
		if (chosen.length === count) {
			out.push([...chosen]);
			return;
		}
		for (let pick = minimum; pick < optionCount; pick += 1) {
			chosen.push(pick);
			visit(pick);
			chosen.pop();
			if (out.length >= MAX_ENGINE_CHOICE_COMMANDS) return;
		}
	};
	visit(0);
	return out;
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyOf(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

/**
 * Enumerate the Infiltrator's real dice-swap surface without multiplying fungible
 * same-tier dice. Larger target sets come first so the rules-text "with all players"
 * branch is retained even if the global engine-choice bound is reached.
 */
function infiltratorSwapCommands(
	state: PublicGameState,
	seat: SeatColor
): Extract<GameCommand, { type: 'infiltratorSwap' }>[] {
	const me = state.players[seat];
	if (!me || state.phase !== 'location') return [];
	if (
		!(me.spirits ?? []).some(
			(spirit) => !spirit.isFaceDown && (spirit.classes?.Infiltrator ?? 0) > 0
		)
	) {
		return [];
	}
	if ((me.actionsUsedThisRound ?? []).includes('infiltratorSwap')) return [];
	const destination = me.navigationDestination;
	if (!destination || (me.attackDice?.length ?? 0) === 0) return [];

	const targets = state.activeSeats
		.filter(
			(targetSeat) =>
				targetSeat !== seat &&
				state.players[targetSeat]?.navigationDestination === destination &&
				(state.players[targetSeat]?.attackDice?.length ?? 0) > 0
		)
		.map((targetSeat) => ({ targetSeat, dice: state.players[targetSeat]!.attackDice }));
	if (targets.length === 0) return [];

	const out: Extract<GameCommand, { type: 'infiltratorSwap' }>[] = [];
	const maxTargets = Math.min(targets.length, me.attackDice.length);
	for (
		let targetCount = maxTargets;
		targetCount >= 1 && out.length < MAX_ENGINE_CHOICE_COMMANDS;
		targetCount -= 1
	) {
		for (const targetSubset of combinations(targets, targetCount)) {
			if (out.length >= MAX_ENGINE_CHOICE_COMMANDS) break;
			const ownAssignments: (typeof me.attackDice)[] = [];
			const ownChosen: typeof me.attackDice = [];
			const usedOwn = new Set<string>();
			const seenOwnTiers = new Set<string>();
			const chooseOwn = (): void => {
				if (ownChosen.length === targetSubset.length) {
					const key = ownChosen.map((die) => die.tier).join('|');
					if (!seenOwnTiers.has(key)) {
						seenOwnTiers.add(key);
						ownAssignments.push([...ownChosen]);
					}
					return;
				}
				for (const die of me.attackDice) {
					if (usedOwn.has(die.instanceId)) continue;
					usedOwn.add(die.instanceId);
					ownChosen.push(die);
					chooseOwn();
					ownChosen.pop();
					usedOwn.delete(die.instanceId);
				}
			};
			chooseOwn();

			for (const own of ownAssignments) {
				if (out.length >= MAX_ENGINE_CHOICE_COMMANDS) break;
				const theirChoices = targetSubset.map((target) => uniqueBy(target.dice, (die) => die.tier));
				const chosenTheirs: (typeof theirChoices)[number] = [];
				const chooseTheirs = (index: number): void => {
					if (out.length >= MAX_ENGINE_CHOICE_COMMANDS) return;
					if (index === targetSubset.length) {
						out.push({
							type: 'infiltratorSwap',
							swaps: targetSubset.map((target, targetIndex) => ({
								targetSeat: target.targetSeat,
								myInstanceId: own[targetIndex].instanceId,
								theirInstanceId: chosenTheirs[targetIndex].instanceId
							}))
						});
						return;
					}
					for (const die of theirChoices[index]) {
						chosenTheirs.push(die);
						chooseTheirs(index + 1);
						chosenTheirs.pop();
					}
				};
				chooseTheirs(0);
			}
		}
	}
	return out;
}

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
			const rewardRows = dest
				? catalog.locations?.find((l) => l.name === dest)?.rewardRows
				: undefined;
			const rowCount = rewardRows?.length ?? MAX_LOCATION_ROWS;
			const interactions = new Map(
				buildLocationInteractions(rewardRows).map((interaction) => [
					interaction.rowIndex,
					interaction
				])
			);
			const emitLocationInteraction = (rowIndex: number, choices?: number[]): void => {
				const interaction = interactions.get(rowIndex);
				const wildcards = interaction?.cost.filter(isWildcardCost) ?? [];
				if (!me || wildcards.length === 0) {
					tryAdd({ type: 'resolveLocationInteraction', rowIndex, ...(choices ? { choices } : {}) });
					return;
				}
				const eligible = [
					...new Set(wildcards.flatMap((requirement) => eligibleCostSlots(requirement, me.mats)))
				];
				const selections = combinations(eligible, wildcards.length);
				if (selections.length === 0) {
					tryAdd({ type: 'resolveLocationInteraction', rowIndex, ...(choices ? { choices } : {}) });
					return;
				}
				for (const costChoices of selections) {
					tryAdd({
						type: 'resolveLocationInteraction',
						rowIndex,
						...(choices ? { choices } : {}),
						costChoices
					});
				}
			};
			// Resolve a reward row — default choices, plus expand the discrete "or"-gain options
			// and wildcard payments so the bot can choose both what it gains and what it preserves.
			for (let r = 0; r < rowCount; r++) {
				emitLocationInteraction(r);
				for (let c = 1; c < MAX_ROW_CHOICES; c++) {
					emitLocationInteraction(r, [c]);
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
			for (const spirit of me?.spirits ?? [])
				tryAdd({ type: 'absorbSpirit', slotIndex: spirit.slotIndex });
			for (const mat of me?.mats ?? []) {
				const runeId = (mat as { runeId?: string }).runeId;
				if (!runeId) continue;
				for (const spirit of me?.spirits ?? [])
					tryAdd({ type: 'attachRuneToSpirit', runeId, spiritSlotIndex: spirit.slotIndex });
			}
			for (const att of me?.spiritAugmentAttachments ?? []) {
				const rId = (att as { runeId?: string }).runeId;
				if (rId)
					tryAdd({
						type: 'detachRuneFromSpirit',
						runeId: rId,
						spiritSlotIndex: att.spiritSlotIndex
					});
			}
			for (const command of infiltratorSwapCommands(state, seat)) tryAdd(command);
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
			// Awakening-Phase class grants are claimed in Benefits. These candidates used to
			// live under the `awakening` case below, where the reducer rejects them as
			// wrong-phase. A Cursed Spirit bot could therefore corrupt, discard and pass its
			// Location turn correctly, then have zero legal moves here until the deadline
			// force-advanced the room.
			if (me?.pendingAwakenReward) {
				const grants = me.pendingAwakenReward.grants ?? [];
				const tainted = grants.find((g) => g.kind === 'taintedChoice') as
					| { amount: number }
					| undefined;
				const relicCount = grants
					.filter(
						(grant): grant is Extract<(typeof grants)[number], { kind: 'relicChoice' }> =>
							grant.kind === 'relicChoice'
					)
					.reduce((sum, grant) => sum + grant.amount, 0);
				const taintedChoices: Array<number | undefined> = tainted
					? Array.from({ length: tainted.amount + 1 }, (_, amount) => amount)
					: [undefined];
				const relicPicks = multisetPicks(relicOptions().length, relicCount);
				for (const taintedMaxBarrier of taintedChoices) {
					for (const picks of relicPicks) {
						tryAdd({
							type: 'resolveAwakenReward',
							...(taintedMaxBarrier === undefined ? {} : { taintedMaxBarrier }),
							...(picks.length === 0 ? {} : { relicPicks: picks })
						});
					}
				}
			}
			tryAdd({ type: 'commitBenefits' }); // yield
			break;
		}

		case 'awakening': {
			// Flip & pay for face-down spirits — including discard-cost variants per offer.
			for (const off of me?.awakenOffers ?? []) {
				const orderedOptions = [...(off.options ?? [])].sort((a, b) => {
					const aRef = a.ref;
					const bRef = b.ref;
					if (aRef.kind !== 'attackDie' || bRef.kind !== 'attackDie') return 0;
					const aDie = me?.attackDice.find((die) => die.instanceId === aRef.instanceId);
					const bDie = me?.attackDice.find((die) => die.instanceId === bRef.instanceId);
					return (
						DICE_TIER_ORDER.indexOf(aDie?.tier ?? 'basic') -
						DICE_TIER_ORDER.indexOf(bDie?.tier ?? 'basic')
					);
				});
				const selections = off.requiresSelection
					? uniqueBy(
							combinations(
								orderedOptions.map((option) => option.ref),
								off.discardCount
							),
							(refs) =>
								refs
									.map((ref) => {
										if (ref.kind !== 'attackDie') return JSON.stringify(ref);
										return `attackDie:${
											me?.attackDice.find((die) => die.instanceId === ref.instanceId)?.tier ??
											'unknown'
										}`;
									})
									.sort()
									.join('|')
						)
					: [];
				if (selections.length > 0) {
					for (const discardRefs of selections)
						tryAdd({ type: 'awakenSpirit', slotIndex: off.slotIndex, discardRefs });
				} else {
					tryAdd({ type: 'awakenSpirit', slotIndex: off.slotIndex });
				}
			}
			for (const spirit of me?.spirits ?? [])
				tryAdd({ type: 'manualAwaken', slotIndex: spirit.slotIndex });
			// Resolve class decision cards (every option).
			for (const dec of me?.pendingDecisions ?? []) {
				const picker = me ? decisionPickerSpec(dec, me) : null;
				for (const o of dec.options) {
					if (picker && o.id === 'yes') {
						const tierById = new Map(
							(me?.attackDice ?? []).map((die) => [die.instanceId, die.tier] as const)
						);
						const eligible = [...picker.eligibleInstanceIds].sort(
							(a, b) =>
								DICE_TIER_ORDER.indexOf(tierById.get(a) ?? 'basic') -
								DICE_TIER_ORDER.indexOf(tierById.get(b) ?? 'basic')
						);
						const selections = uniqueBy(combinations(eligible, picker.count), (ids) =>
							ids
								.map((id) => tierById.get(id) ?? 'unknown')
								.sort()
								.join('|')
						);
						for (const selectedInstanceIds of selections) {
							tryAdd({
								type: 'resolveDecision',
								decisionId: dec.id,
								optionId: o.id,
								selectedInstanceIds
							});
						}
					} else {
						tryAdd({ type: 'resolveDecision', decisionId: dec.id, optionId: o.id });
					}
				}
			}
			// Place unplaced augments onto spirits (every augment × every legal class × spirit).
			for (let a = 0; a < (me?.unplacedAugments?.length ?? 0); a++) {
				const aug = me!.unplacedAugments![a];
				for (const spirit of me?.spirits ?? []) {
					for (const className of augmentClassChoices(aug, catalog)) {
						tryAdd({
							type: 'placeAugmentOnSpirit',
							augmentIndex: a,
							augmentRuneId: aug.runeId,
							spiritSlotIndex: spirit.slotIndex,
							className
						});
					}
				}
			}
			if ((me?.unplacedAugments?.length ?? 0) > 0) tryAdd({ type: 'discardUnplacedAugments' });
			for (const mp of me?.manualPrompts ?? []) tryAdd({ type: 'dismissManualPrompt', id: mp.id });
			tryAdd({ type: 'commitAwakening' }); // yield
			break;
		}

		case 'cleanup': {
			for (const spirit of me?.spirits ?? [])
				tryAdd({ type: 'discardSpirit', slotIndex: spirit.slotIndex });
			for (const mat of me?.mats ?? []) tryAdd({ type: 'discardRune', slotIndex: mat.slotIndex });
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
	const sameStrings = (left: readonly string[] | undefined, right: readonly string[] | undefined) =>
		JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
	const sameNumbers = (left: readonly number[] | undefined, right: readonly number[] | undefined) =>
		JSON.stringify([...(left ?? [])].sort((x, y) => x - y)) ===
		JSON.stringify([...(right ?? [])].sort((x, y) => x - y));
	const sameRefs = (
		left: Extract<GameCommand, { type: 'awakenSpirit' }>['discardRefs'],
		right: Extract<GameCommand, { type: 'awakenSpirit' }>['discardRefs']
	) =>
		JSON.stringify([...(left ?? [])].map((ref) => JSON.stringify(ref)).sort()) ===
		JSON.stringify([...(right ?? [])].map((ref) => JSON.stringify(ref)).sort());
	switch (a.type) {
		case 'lockNavigation':
		case 'selectNavigationDestination':
			return a.destination === (b as typeof a).destination;
		case 'resolveLocationInteraction':
			if (
				!(
					a.rowIndex === (b as typeof a).rowIndex &&
					(a.choices?.[0] ?? 0) === ((b as typeof a).choices?.[0] ?? 0)
				)
			)
				return false;
			return (
				!(b as typeof a).costChoices?.length ||
				sameNumbers(a.costChoices, (b as typeof a).costChoices)
			);
		case 'spawnHandSpirit':
			return a.guid === (b as typeof a).guid;
		case 'takeSpirit':
			return a.marketIndex === (b as typeof a).marketIndex;
		case 'replaceSpirit':
			return (
				a.marketIndex === (b as typeof a).marketIndex && a.slotIndex === (b as typeof a).slotIndex
			);
		case 'awakenSpirit': {
			const other = b as typeof a;
			if (a.slotIndex !== other.slotIndex) return false;
			if (other.runeInstanceIds?.length && !sameStrings(a.runeInstanceIds, other.runeInstanceIds))
				return false;
			if (other.discardRefs?.length && !sameRefs(a.discardRefs, other.discardRefs)) return false;
			return true;
		}
		case 'discardSpirit':
		case 'discardRune':
		case 'manualAwaken':
		case 'absorbSpirit':
			return a.slotIndex === (b as typeof a).slotIndex;
		case 'resolveDecision': {
			const other = b as typeof a;
			return (
				a.decisionId === other.decisionId &&
				a.optionId === other.optionId &&
				(!other.selectedInstanceIds?.length ||
					sameStrings(a.selectedInstanceIds, other.selectedInstanceIds))
			);
		}
		case 'placeAugmentOnSpirit':
			return (
				a.augmentIndex === (b as typeof a).augmentIndex &&
				a.spiritSlotIndex === (b as typeof a).spiritSlotIndex &&
				(!(b as typeof a).className || a.className === (b as typeof a).className)
			);
		case 'resolveAwakenReward': {
			const other = b as typeof a;
			if (other.taintedMaxBarrier !== undefined && a.taintedMaxBarrier !== other.taintedMaxBarrier)
				return false;
			return !other.relicPicks?.length || sameNumbers(a.relicPicks, other.relicPicks);
		}
		default:
			return true; // type-only commands: passEncounter, initiatePvp, commit*, refillMarket, etc.
	}
}
