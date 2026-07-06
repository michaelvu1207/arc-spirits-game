import type { BagsData } from '$lib/types';
import type {
	CommandResult,
	DiceType,
	GameActor,
	GameCommand,
	HistorySnapshotRow,
	BagSpiritSummary,
	LobbySeatState,
	PlayCatalog,
	PlayCatalogDie,
	PlayCatalogRune,
	PlayCatalogSpirit,
	PlayerProjection,
	PendingRewardState,
	PrivatePlayerState,
	PublicGameState,
	RuntimeBagEntry,
	RuntimeBagsState,
	SeatColor,
	SpiritSourceBag,
	SpectatorProjection
} from './types';
import {
	SEAT_COLORS,
	SPIRIT_WORLD_LOCATIONS,
	ALL_DESTINATIONS,
	RUNE_CARRY_LIMIT,
	DEFAULT_NAVIGATION_DURATION_MS
} from './types';
import { createRng, hashString, nextId, nextInt, type RngState } from './rng';
import {
	bagForSpiritCost,
	deckCopiesForCost,
	shuffleBag,
	SPIRIT_WORLD_BAG,
	ARCANE_ABYSS_BAG
} from './bags';
import {
	initRoundLoop,
	tryAdvanceFromLocation,
	tryAdvanceFromBenefits,
	tryAdvanceFromAwakening,
	tryAdvanceFromCleanup,
	tryAdvanceFromEncounter,
	recomputeAwakenEligibility,
	autoAdvanceResolution,
	forceAdvancePhase as forceAdvancePhaseMachine
} from './phases';
import { fightMonster, resolveEncounterCombat } from './combat';
import { applyTrigger, applyCultivate, awakenedClassCounts } from './effects/apply';
import { runAction, GENERIC_AUGMENT_RUNE_ID } from './effects/actions';
import { augmentCapacityForSpirit, isSpiritAugmentClass } from './augments';
import {
	buildLocationInteractions,
	matchRewardCost,
	relicOptions,
	type ResolvedRune,
	type GainEffect
} from './locationInteractions';
import { buildMonsterRewards, rewardClaimCount } from './monsterRewards';
import { applyStatusChange } from './effects/status';
import { buildEffectContext } from './effects/context';
import { DECISION_RESOLVERS } from './effects/decisions';
import { checkAwakenCondition, payAwakenCondition, needsManualAwaken } from './effects/awaken';
import {
	AWAKEN_HANDLERS,
	AWAKEN_PROGRESS_KEYS,
	MANUAL_AWAKEN,
	recordRestAwakenProgress
} from './effects/awakenHandlers';
import {
	STATUS_LADDER,
	isEvilAlignment,
	setCorruptionDiscardObligation,
	settleUnpayableCorruptionDebt
} from './types';

const EMPTY_BAG = Object.freeze({
	count: 0,
	contents: []
});
const DICE_GRID_START_X = -0.5;
const DICE_GRID_START_Z = 0;
const DICE_GRID_SPACING = 0.25;
const DICE_GRID_COLS = 5;
const MAT_ITEM_SLOT_POSITIONS = [
	{ x: 0.176, z: -0.034 },
	{ x: 0.013, z: -0.279 },
	{ x: -0.141, z: -0.515 },
	{ x: -0.284, z: -0.764 }
] as const;
const MAT_ITEM_RESERVE_START = { x: -0.42, z: -0.95 };
const MAT_ITEM_RESERVE_SPACING = 0.18;

/**
 * JSON-semantics deep clone WITHOUT the string round-trip. Produces byte-identical output to
 * JSON.parse(JSON.stringify(v)) for plain-JSON values — drops undefined/function/symbol-valued
 * keys, maps undefined/function/symbol array elements and non-finite numbers to null, preserves
 * key order — but ~5x faster on the game state (measured: 5.4k → 30k clones/s on a mid-game
 * state) because it skips serialize+parse entirely. The state is pure JSON (no Maps/Sets/Dates),
 * so the two are equivalent; parity is gated by sim/_parity.test.ts (byte-identical shards).
 */
function jsonClone<T>(v: T): T {
	if (v === null) return v;
	const t = typeof v;
	if (t === 'number') return (Number.isFinite(v as unknown as number) ? v : null) as unknown as T;
	if (t !== 'object') return v;
	if (Array.isArray(v)) {
		const n = new Array(v.length);
		for (let i = 0; i < v.length; i++) {
			const e = v[i];
			const et = typeof e;
			n[i] = e === undefined || et === 'function' || et === 'symbol' ? null : jsonClone(e);
		}
		return n as unknown as T;
	}
	const n: Record<string, unknown> = {};
	for (const k in v) {
		if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
		const val = (v as Record<string, unknown>)[k];
		const vt = typeof val;
		if (val === undefined || vt === 'function' || vt === 'symbol') continue;
		n[k] = jsonClone(val);
	}
	return n as unknown as T;
}

function cloneState(state: PublicGameState): PublicGameState {
	// The game state is fully JSON-serializable (no Maps/Sets/Dates/functions; the RNG is
	// {seed,cursor}), so a JSON round-trip is an exact deep clone. MEASURED faster than
	// structuredClone in the real self-play/bot-search loop (structuredClone regressed random
	// self-play 2.4→1.7 games/s — the structuredClone micro-bench win did not hold in situ).
	// The hot path avoids this entirely via `mutate:true`; this clone remains for dry-runs / search.
	//
	// `bags.history` is a derived snapshot that ALIASES the same bag objects already on
	// `state.bags` (buildHistoryBags copies references, not contents). JSON.stringify can't see
	// the aliasing, so it serializes every bag's contents TWICE — ~30% of clone cost (measured).
	// Since history is a pure function of the current bags (re-snapshotted at every bag mutation,
	// see the 8 `state.bags.history = buildHistoryBags(...)` sites) and is read only at the
	// persistence boundary (buildHistorySnapshotRows), we detach it before serializing and rebuild
	// it by reference on the clone — adding zero serialized bytes. Parity-gated by
	// sim/_parity.test.ts (byte-identical state vs the naive full clone across seeds).
	const history = state.bags?.history as BagsData | undefined;
	if (!history) return jsonClone(state);
	state.bags.history = undefined as unknown as BagsData; // transient detach (restored below; sync, unobservable)
	const cloned = jsonClone(state);
	state.bags.history = history; // restore original ref — contents were never mutated
	cloned.bags.history = buildHistoryBags(cloned.bags); // rebuild by reference: no extra serialized bytes
	return cloned;
}

function toBagEntry(spirit: PlayCatalogSpirit, guidSuffix: string): RuntimeBagEntry {
	return {
		name: spirit.name,
		guid: `play_${guidSuffix}_${spirit.id}`,
		id: spirit.id,
		cost: spirit.cost
	};
}

function buildHistoryBags(state: Omit<RuntimeBagsState, 'history'>): BagsData {
	return {
		hexSpirits: state.hexSpirits,
		monsters: state.monsters,
		abyssFallen: state.abyssFallen,
		stageDeck: state.stageDeck,
		purgeBags: state.purgeBags
	};
}

function createEmptyBags(): RuntimeBagsState {
	const base = {
		hexSpirits: { count: 0, contents: [] },
		monsters: { count: 0, contents: [] },
		abyssFallen: { count: 0, contents: [] },
		stageDeck: { count: 0, contents: [] },
		purgeBags: [] as []
	};

	return {
		...base,
		history: buildHistoryBags(base)
	};
}

function createSeatRecord(guardianPool: string[]): Record<SeatColor, LobbySeatState> {
	const seats = {} as Record<SeatColor, LobbySeatState>;
	for (const seatColor of SEAT_COLORS) {
		seats[seatColor] = {
			seatColor,
			memberId: null,
			displayName: null,
			selectedGuardian: guardianPool.length === 0 ? null : null,
			isBot: false
		};
	}
	return seats;
}

function buildPlayerState(seatColor: SeatColor, seat: LobbySeatState): PrivatePlayerState {
	return {
		playerColor: seatColor,
		displayName: seat.displayName,
		selectedGuardian: seat.selectedGuardian ?? 'Unknown Guardian',
		navigationDestination: null,
		brokenBarrier: 0,
		victoryPoints: 0,
		vpHistory: [],
		barrier: 4,
		maxBarrier: 4,
		statusLevel: 0,
		statusToken: STATUS_LADDER[0],
		corruptionCount: 0,
		spirits: [],
		// Every player begins with two Fairy relics occupying their first mat slots.
		mats: [
			{ slotIndex: 1, hasRune: true, name: 'Fairy Relic', type: 'relic' },
			{ slotIndex: 2, hasRune: true, name: 'Fairy Relic', type: 'relic' }
		],
		handDraws: [],
		pendingDraw: null,
		pendingReward: null,
		pendingAwakenReward: null,
		pendingCorruptionDiscard: null,
		pendingDrawQueue: [],
		spawnedDice: [],
		spawnedItems: [],
		spiritAugmentAttachments: [],
		pendingDestination: null,
		attackDice: [],
		initiative: 0,
		actionsUsedThisRound: [],
		awakenEligible: [],
		awakenOffers: [],
		awakenLocked: [],
		phaseReady: false,
		manualPrompts: [],
		pendingDecisions: [],
		lastAction: null,
		// Effect-framework fields (default 0/false ⇒ no behavior change).
		damageReduction: 0,
		deflect: 0,
		combatDamageBonus: 0,
		stunImmune: false,
		stunned: false,
		encounterVote: null,
		spiritAugments: 0,
		relics: 0,
		extraActions: {},
		// P4 per-combat flags (reset at the start of each combat).
		combatDamageMultiplier: 1,
		attackRollAdvantage: false,
		halveIncoming: false,
		skipTakeDamage: false,
		// P5 per-turn / per-round flags (reset at navigation start each round).
		doubleRunes: false,
		redrawAvailable: false,
		freeNextRelicTrade: false,
		becameTaintedThisRound: false,
		becameCorruptThisRound: false,
		becameFallenThisRound: false,
		corruptedThisRound: false,
		// P6 awakening-progress flags (event-driven text-awaken scripts).
		awakenProgress: {}
	};
}

function createInstanceId(rng: RngState, prefix: string): string {
	return nextId(rng, prefix);
}

function createDieRoll(rng: RngState, diceType: PlayCatalogDie['diceType']) {
	const faceCount = diceType === 'defense' ? 12 : 6;
	return {
		faceIndex: nextInt(rng, faceCount),
		rollRotation: {
			x: nextInt(rng, 360) * (Math.PI / 180),
			y: nextInt(rng, 360) * (Math.PI / 180),
			z: nextInt(rng, 360) * (Math.PI / 180)
		}
	};
}

function findCatalogDie(catalog: PlayCatalog, diceId: string): PlayCatalogDie | null {
	return catalog.dice.find((entry) => entry.id === diceId) ?? null;
}

function findCatalogRune(catalog: PlayCatalog, runeId: string): PlayCatalogRune | null {
	return catalog.mats.find((entry) => entry.id === runeId) ?? null;
}

function nextDicePosition(index: number) {
	const col = index % DICE_GRID_COLS;
	const row = Math.floor(index / DICE_GRID_COLS);
	return {
		x: DICE_GRID_START_X - col * DICE_GRID_SPACING,
		z: DICE_GRID_START_Z + row * DICE_GRID_SPACING
	};
}

function nextMatItemPosition(index: number) {
	if (index < MAT_ITEM_SLOT_POSITIONS.length) {
		const slot = MAT_ITEM_SLOT_POSITIONS[index]!;
		return { x: slot.x, z: slot.z };
	}

	const reserveIndex = index - MAT_ITEM_SLOT_POSITIONS.length;
	const col = reserveIndex % 3;
	const row = Math.floor(reserveIndex / 3);
	return {
		x: MAT_ITEM_RESERVE_START.x - col * MAT_ITEM_RESERVE_SPACING,
		z: MAT_ITEM_RESERVE_START.z - row * MAT_ITEM_RESERVE_SPACING
	};
}

function syncBarrierFromBrokenBarrier(player: PrivatePlayerState) {
	player.brokenBarrier = Math.max(0, Math.min(player.maxBarrier, player.brokenBarrier));
	player.barrier = Math.max(0, player.maxBarrier - player.brokenBarrier);
}

function buildInitialSpiritBag(
	catalog: PlayCatalog,
	sourceBag: SpiritSourceBag
): RuntimeBagEntry[] {
	// Partition by cost exactly like TTS's two filterSpiritsByCost(regular, …) calls:
	// cost 1–5 → Spirit World Bag, 7–9 → Arcane Abyss Bag, anything else (cost-6
	// boundary, cost-15 spirits) → no regular draw bag at all.
	// Seed `deckCopiesForCost` copies of each spirit (rev-2's rarity multiplier),
	// each with a distinct guid — so the Spirit World bag is large enough to last a
	// multiplayer game (cost 1–3 spirits appear twice) rather than one-of-each.
	const entries: RuntimeBagEntry[] = [];
	let seq = 0;
	for (const spirit of catalog.spirits) {
		if (bagForSpiritCost(spirit.cost) !== sourceBag) continue;
		const copies = deckCopiesForCost(spirit.cost, catalog.costDuplicates);
		for (let copy = 0; copy < copies; copy += 1) {
			seq += 1;
			entries.push(toBagEntry(spirit, String(seq).padStart(3, '0')));
		}
	}
	return entries;
}

/** Opening hand: each player begins with four Spirit World spirits, awakened. */
function drawStartingSpirits(
	state: PublicGameState,
	catalog: PlayCatalog,
	player: PrivatePlayerState
): void {
	const bag = state.bags.hexSpirits;
	for (let slotIndex = 1; slotIndex <= 4; slotIndex += 1) {
		const entry = bag.contents.shift();
		if (!entry?.id) break;
		const spirit = catalog.spirits.find((candidate) => candidate.id === entry.id);
		if (!spirit) continue;
		player.spirits.push({
			slotIndex,
			id: spirit.id,
			name: spirit.name,
			cost: spirit.cost,
			classes: spirit.classes,
			origins: spirit.origins,
			isFaceDown: false
		});
	}
	bag.count = bag.contents.length;
}

function refillSingleMarketSlot(state: PublicGameState, slotIndex: number) {
	const next = state.bags.hexSpirits.contents.shift() ?? null;
	state.market[slotIndex].spiritId = next?.id ?? null;
	state.bags.hexSpirits.count = state.bags.hexSpirits.contents.length;
	state.bags.history = buildHistoryBags(state.bags);
}

function runtimeBagForSource(state: PublicGameState, sourceBag: SpiritSourceBag) {
	return sourceBag === ARCANE_ABYSS_BAG ? state.bags.abyssFallen : state.bags.hexSpirits;
}

function returnHandDrawsToBags(state: PublicGameState, player: PrivatePlayerState) {
	let returnedToWorld = false;
	let returnedToAbyss = false;
	for (const draw of player.handDraws) {
		const sourceBag = draw.sourceBag === ARCANE_ABYSS_BAG ? ARCANE_ABYSS_BAG : SPIRIT_WORLD_BAG;
		runtimeBagForSource(state, sourceBag).contents.push({
			guid: draw.guid,
			id: draw.id,
			name: draw.name ?? 'Unknown Spirit',
			cost: draw.cost
		});
		if (sourceBag === ARCANE_ABYSS_BAG) returnedToAbyss = true;
		else returnedToWorld = true;
	}

	// TTS re-shuffles a bag whenever spirits go back into it (MarketLib reshuffles
	// on refill), so returned spirits don't sit predictably at the end of the bag.
	// Only reshuffle the bag(s) that actually received returns.
	if (returnedToWorld) shuffleBag(state.bags.hexSpirits.contents, state.rng);
	if (returnedToAbyss) shuffleBag(state.bags.abyssFallen.contents, state.rng);

	state.bags.hexSpirits.count = state.bags.hexSpirits.contents.length;
	state.bags.abyssFallen.count = state.bags.abyssFallen.contents.length;
	state.bags.history = buildHistoryBags(state.bags);
	player.handDraws = [];
	player.pendingDraw = null;
}

/**
 * Draw `drawCount` spirits from `sourceBag` into the player's hand and open a
 * pendingDraw (the DrawTray summon flow). Returns false (without mutating) when
 * the bag lacks enough spirits. Shared by the draw commands, reward-row summon
 * gains, and the draw queue.
 */
function startDraw(
	state: PublicGameState,
	player: PrivatePlayerState,
	sourceBag: SpiritSourceBag,
	autoAwaken = false
): boolean {
	const requested = sourceBag === ARCANE_ABYSS_BAG ? 3 : 4;
	const baseLimit = sourceBag === ARCANE_ABYSS_BAG ? 1 : 2;
	const runtimeBag = runtimeBagForSource(state, sourceBag);
	// Draw as many as the bag can offer (a near-empty bag still lets you summon
	// fewer rather than the action silently doing nothing). Empty ⇒ no draw.
	const drawCount = Math.min(requested, runtimeBag.contents.length);
	if (drawCount <= 0) return false;
	const summonLimit = Math.min(baseLimit, drawCount);
	const draws = runtimeBag.contents.splice(0, drawCount);
	player.handDraws = draws.map((entry) => ({
		guid: entry.guid,
		id: entry.id,
		name: entry.name,
		cost: entry.cost,
		sourceBag
	}));
	player.pendingDraw = { sourceBag, drawCount, summonLimit, summonedCount: 0, autoAwaken };
	runtimeBag.count = runtimeBag.contents.length;
	state.bags.history = buildHistoryBags(state.bags);
	// Soul Weaver: "On a Spirit World or Abyss Summon, you may put all spirits back
	// and draw again." Arm the redraw the moment the fresh hand opens (when it is most
	// useful — before any pick), so the DrawTray surfaces the ↻ Redraw affordance.
	if ((awakenedClassCounts(player)['Soul Weaver'] ?? 0) >= 1) {
		player.redrawAvailable = true;
	}
	return true;
}

/** Begin a reward-granted draw now, or queue it behind the active one. */
function queueOrBeginDraw(
	state: PublicGameState,
	player: PrivatePlayerState,
	sourceBag: SpiritSourceBag,
	autoAwaken = false
) {
	if (player.pendingDraw || player.handDraws.length > 0) {
		const drawCount = sourceBag === ARCANE_ABYSS_BAG ? 3 : 4;
		const summonLimit = sourceBag === ARCANE_ABYSS_BAG ? 1 : 2;
		player.pendingDrawQueue.push({ sourceBag, drawCount, summonLimit, autoAwaken });
	} else {
		// No spirits left ⇒ silently skip (the reward simply yields no summon).
		startDraw(state, player, sourceBag, autoAwaken);
	}
}

/** Once the active draw resolves, auto-start the next queued draw (if any). */
function advanceDrawQueue(state: PublicGameState, player: PrivatePlayerState) {
	if (player.pendingDraw) return;
	while (player.pendingDrawQueue.length > 0) {
		const next = player.pendingDrawQueue.shift();
		if (next && startDraw(state, player, next.sourceBag, next.autoAwaken)) return;
		// bag shortage for this queued draw ⇒ drop it and try the next.
	}
}

/** Add a reward-gained rune to the player's rune slots, carrying its identity. */
function addGainedRune(player: PrivatePlayerState, rune: ResolvedRune) {
	// Spirit augments (class-linked runes) never occupy rune slots — they wait in the
	// to-place pouch until the owner attaches one to a hex spirit. Relics (special
	// runes with no class) and origin runes still take a rune slot as before.
	if (rune.type === 'augment' && rune.classId) {
		(player.unplacedAugments ??= []).push({
			runeId: rune.runeId,
			name: rune.name,
			classId: rune.classId
		});
		return;
	}
	player.mats.push({
		slotIndex: player.mats.length + 1,
		hasRune: true,
		id: rune.runeId,
		name: rune.name,
		type: rune.type,
		originId: rune.originId ?? undefined,
		classId: rune.classId ?? undefined,
		special: rune.special
	});
}

/** Runes/relics the player is currently carrying (occupied slots). */
function heldRuneCount(player: PrivatePlayerState): number {
	return player.mats.filter((slot) => slot.hasRune).length;
}

/**
 * Apply one resolved reward gain to a player. Shared by the monster-reward
 * handler and the force-advance auto-claim. `choice` selects the option for a
 * `chooseRune` gain (ignored otherwise). Appends human-readable lines to `log`.
 */
function applyRewardGain(
	state: PublicGameState,
	seat: SeatColor,
	player: PrivatePlayerState,
	gain: GainEffect,
	choice: number,
	log: string[],
	catalog: PlayCatalog
): void {
	switch (gain.type) {
		case 'vp':
			player.victoryPoints += gain.amount;
			log.push(`Gained ${gain.amount} Victory Point${gain.amount === 1 ? '' : 's'}.`);
			break;
		case 'restoreBarrier': {
			// Restore barrier: flip broken-barrier tokens back to the intact side. Does NOT
			// raise max barrier — capacity grows only through class effects.
			const before = player.barrier;
			player.barrier = Math.min(player.maxBarrier, player.barrier + gain.amount);
			player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
			log.push(`Restored ${player.barrier - before} barrier.`);
			break;
		}
		case 'rune':
			addGainedRune(player, gain.rune);
			log.push(`Gained ${gain.rune.name}.`);
			break;
		case 'chooseRune': {
			const chosen = gain.options[choice] ?? gain.options[0];
			if (chosen) {
				addGainedRune(player, chosen);
				log.push(`Gained ${chosen.name}.`);
			}
			break;
		}
		case 'action':
			if (gain.action === 'spiritWorldSummon') {
				queueOrBeginDraw(state, player, SPIRIT_WORLD_BAG);
				log.push('Summon from the Spirit World — draw 4, summon up to 2.');
			} else if (gain.action === 'abyssSummon') {
				queueOrBeginDraw(state, player, ARCANE_ABYSS_BAG);
				log.push('Summon from the Arcane Abyss — draw 3, summon up to 1.');
			} else if (gain.action === 'cultivate') {
				applyCultivate(state, seat, log, { catalog });
			} else {
				applyTrigger(state, seat, 'onRest', log, { catalog });
				log.push('Rested.');
			}
			break;
	}
}

/**
 * Auto-claim a player's pending monster reward by taking the first `chooseAmount`
 * resolvable tokens (default `chooseRune` option). Used when the host force-
 * advances the Location phase so a timeout never silently forfeits rewards.
 */
function autoClaimReward(
	state: PublicGameState,
	seat: SeatColor,
	player: PrivatePlayerState,
	catalog: PlayCatalog
): void {
	const pending = player.pendingReward;
	if (!pending) return;
	const picks = buildMonsterRewards(pending.rewardTrack).slice(0, pending.chooseAmount);
	const log: string[] = [];
	for (const opt of picks) {
		applyRewardGain(state, seat, player, opt.effect, 0, log, catalog);
	}
	player.pendingReward = null;
	player.lastAction = {
		key: 'reward',
		label: `${pending.monsterName} rewards`,
		log: log.length ? log : ['Claimed monster rewards.']
	};
}

/**
 * Apply a player's pending Awakening-Phase (Benefits) reward claim and clear it.
 * Shared by the `resolveAwakenReward` command and the deadline/force-advance drain
 * (which calls it with default picks so an idle player still receives their grants
 * rather than forfeiting them). `taintedMaxBarrier` splits the Cursed-Spirit Tainted
 * line; `relicPicks` is a flat list consumed in order across every relicChoice grant.
 */
function applyAwakenRewardClaim(
	state: PublicGameState,
	seat: SeatColor,
	player: PrivatePlayerState,
	taintedMaxBarrier: number,
	relicPicks: number[],
	catalog: PlayCatalog
): void {
	const pending = player.pendingAwakenReward;
	if (!pending) return;
	const log: string[] = [];
	const ctx = buildEffectContext({
		state,
		seat,
		player,
		trigger: 'awakeningPhase',
		log,
		traitCount: 0,
		catalog
	});
	const relics = relicOptions();
	let relicCursor = 0;
	for (const grant of pending.grants) {
		if (grant.kind === 'taintedChoice') {
			// Cursed Spirit, Tainted: split the N units between max barrier and Enchanted.
			const maxBarrier = Math.max(0, Math.min(grant.amount, taintedMaxBarrier));
			const enchanted = grant.amount - maxBarrier;
			if (maxBarrier > 0) runAction(ctx, { kind: 'gainMaxBarrier', amount: maxBarrier });
			if (enchanted > 0)
				runAction(ctx, { kind: 'gainAttackDice', tier: 'enchanted', amount: enchanted });
		} else if (grant.kind === 'relicChoice') {
			// Cursed Spirit, Corrupt: grant the CHOSEN relic for each unit (not a generic
			// one). Default to the first relic when no pick was supplied.
			for (let i = 0; i < grant.amount; i += 1) {
				const pick = relicPicks[relicCursor] ?? 0;
				relicCursor += 1;
				const relic = relics[Math.max(0, Math.min(relics.length - 1, pick))];
				addGainedRune(player, relic);
				player.relics += 1;
				log.push(`Gained ${relic.name}.`);
			}
		} else if (grant.kind === 'augment') {
			if (grant.amount > 0) runAction(ctx, { kind: 'gainAugment', amount: grant.amount });
		} else if (grant.kind === 'attackDice') {
			if (grant.amount > 0)
				runAction(ctx, { kind: 'gainAttackDice', tier: grant.tier, amount: grant.amount });
		} else if (grant.kind === 'vp') {
			if (grant.amount > 0) runAction(ctx, { kind: 'gainVP', amount: grant.amount });
			// Golden Ruler: being Evil costs you one awakened Golden Ruler spirit.
			if (grant.source === 'Golden Ruler' && isEvilAlignment(player.statusLevel)) {
				const idx = player.spirits.findIndex(
					(s) => !s.isFaceDown && (s.classes?.['Golden Ruler'] ?? 0) > 0
				);
				if (idx >= 0) {
					const [discarded] = player.spirits.splice(idx, 1);
					log.push(`Golden Ruler: you are evil — discarded ${discarded.name}.`);
					const vpSettled = settleUnpayableCorruptionDebt(player);
					if (vpSettled > 0)
						log.push(`No spirits left for the corruption sacrifice — lost ${vpSettled} VP instead.`);
				}
			}
		}
	}
	player.pendingAwakenReward = null;
	player.lastAction = {
		key: 'awaken-reward',
		label: 'Benefits',
		log: log.length ? log : ['Claimed Awakening-Phase rewards.']
	};
}

/**
 * Before a forced/timed-out phase advance, drain any in-progress Location-phase
 * reward/draw so it isn't abandoned mid-resolution (which would leak the drawn
 * spirits out of their bag). Shared by the host `forceAdvancePhase` command and
 * the server's deadline enforcement so both behave identically.
 */
function drainPendingBeforeAdvance(state: PublicGameState, catalog: PlayCatalog): void {
	// In the Location phase, return any in-progress reward/draw to its bag so it is not
	// abandoned mid-resolution. (Corruption is no longer resolved here — it's a cleanup
	// ritual now.)
	if (state.phase === 'location') {
		for (const seat of state.activeSeats) {
			const seatPlayer = state.players[seat];
			if (!seatPlayer) continue;
			// Auto-claim any unclaimed monster reward FIRST (so a reward summon's draw is
			// then returned below rather than leaking out of its bag).
			if (seatPlayer.pendingReward) {
				autoClaimReward(state, seat, seatPlayer, catalog);
			}
			if (seatPlayer.handDraws.length > 0 || seatPlayer.pendingDraw) {
				returnHandDrawsToBags(state, seatPlayer);
			}
			seatPlayer.pendingDrawQueue = [];
		}
		return;
	}
	// In the Benefits phase, auto-claim any unclaimed Awakening-Phase rewards with default
	// picks (all-Enchanted Tainted split, first relic) so an idle/disconnected player still
	// receives their grants instead of forfeiting them — and the claim gate can never deadlock.
	if (state.phase === 'benefits') {
		for (const seat of state.activeSeats) {
			const seatPlayer = state.players[seat];
			if (!seatPlayer?.pendingAwakenReward) continue;
			applyAwakenRewardClaim(state, seat, seatPlayer, 0, [], catalog);
		}
		return;
	}
	// In the Cleanup phase, auto-resolve any outstanding corruption ritual so an
	// idle/disconnected player can never deadlock the round: restore barrier to full + auto-discard
	// the highest-slot spirits until the owed count is satisfied + clear the obligation.
	if (state.phase === 'cleanup') {
		for (const seat of state.activeSeats) {
			const seatPlayer = state.players[seat];
			if (!seatPlayer) continue;
			autoResolveCorruptionDiscard(state, seatPlayer);
		}
	}
}

/**
 * Timeout fallback for the forced corruption discard. Auto-resolves it so the round can never
 * deadlock: auto-discards the highest-slot spirits (returning each to its source bag, exactly
 * like the `discardSpirit` command) until `pendingCorruptionDiscard.count` is satisfied, then
 * clears the obligation. Used only by the deadline / host-force-advance drain. (Corruption
 * already restored the player's barrier instantly in takeDamage — there is no restore to apply here.)
 */
function autoResolveCorruptionDiscard(state: PublicGameState, player: PrivatePlayerState): void {
	const obligation = player.pendingCorruptionDiscard;
	if (!obligation) return;
	if (obligation.count <= 0) {
		player.pendingCorruptionDiscard = null;
		return;
	}
	let owed = Math.min(obligation.count, player.spirits.length);
	while (owed > 0 && player.spirits.length > 0) {
		// Pick the highest slot index — the OLD trim behavior.
		const victim = [...player.spirits].sort((a, b) => b.slotIndex - a.slotIndex)[0];
		player.spirits = player.spirits.filter((entry) => entry.slotIndex !== victim.slotIndex);
		player.spiritAugmentAttachments = (player.spiritAugmentAttachments ?? []).filter(
			(attachment) => attachment.spiritSlotIndex !== victim.slotIndex
		);
		const sourceBag =
			bagForSpiritCost(victim.cost) ?? (victim.isFaceDown ? ARCANE_ABYSS_BAG : SPIRIT_WORLD_BAG);
		const runtimeBag = runtimeBagForSource(state, sourceBag);
		runtimeBag.contents.push({
			name: victim.name,
			guid: nextId(state.rng, 'discard'),
			id: victim.id,
			cost: victim.cost
		});
		shuffleBag(runtimeBag.contents, state.rng);
		runtimeBag.count = runtimeBag.contents.length;
		owed -= 1;
	}
	state.bags.history = buildHistoryBags(state.bags);
	player.pendingCorruptionDiscard = null;
}

/**
 * Server-authoritative, host-INDEPENDENT phase advance, used when a phase runs past
 * its {@link PublicGameState.phaseDeadline}. Identical to the host `forceAdvancePhase`
 * command minus the host check — the caller (the server boundary) owns the clock
 * comparison so the reducer stays pure. Mutates `state` in place and bumps the
 * revision so the persistence CAS sees a change. No-op unless the game is active.
 */
export function applyDeadlineAdvance(state: PublicGameState, catalog: PlayCatalog): void {
	if (state.status !== 'active') return;
	drainPendingBeforeAdvance(state, catalog);
	forceAdvancePhaseMachine(state, catalog);
	state.revision += 1;
}

function firstOpenSpiritSlot(player: PrivatePlayerState) {
	return Array.from({ length: 7 }, (_, index) => index + 1).find(
		(index) => !player.spirits.some((candidate) => candidate.slotIndex === index)
	);
}

function refillEmptyMarketSlots(state: PublicGameState) {
	for (const slot of state.market) {
		if (!slot.spiritId) {
			refillSingleMarketSlot(state, slot.index);
		}
	}
}

function ensurePlayerCollections(player: PrivatePlayerState) {
	player.handDraws ??= [];
	player.vpHistory ??= [];
	player.mats ??= [];
	player.spirits ??= [];
	player.spawnedDice ??= [];
	player.spawnedItems ??= [];
	player.spiritAugmentAttachments ??= [];
	player.unplacedAugments ??= [];
	player.pendingDraw ??= null;
	player.pendingReward ??= null;
	player.pendingAwakenReward ??= null;
	player.pendingCorruptionDiscard ??= null;
	player.pendingDrawQueue ??= [];
	// Rules-engine fields (tolerate states persisted before these existed).
	player.attackDice ??= [];
	player.actionsUsedThisRound ??= [];
	player.awakenEligible ??= [];
	player.awakenOffers ??= [];
	player.awakenLocked ??= [];
	player.manualPrompts ??= [];
	player.pendingDecisions ??= [];
	player.initiative ??= 0;
	player.phaseReady ??= false;
	player.pendingDestination ??= null;
	player.lastAction ??= null;
	// Effect-framework fields (tolerate snapshots persisted before these existed).
	player.damageReduction ??= 0;
	player.deflect ??= 0;
	player.combatDamageBonus ??= 0;
	player.stunImmune ??= false;
	player.stunned ??= false;
	player.encounterVote ??= null;
	player.spiritAugments ??= 0;
	player.relics ??= 0;
	// Back-compat: `blood`→`brokenBarrier` and `maxTokens`→`maxBarrier` renamed these JSON
	// keys. Copy the legacy keys forward so in-flight saved games still load.
	{
		const legacy = player as unknown as { blood?: number; maxTokens?: number };
		if (player.brokenBarrier === undefined && legacy.blood !== undefined)
			player.brokenBarrier = legacy.blood;
		if (player.maxBarrier === undefined && legacy.maxTokens !== undefined)
			player.maxBarrier = legacy.maxTokens;
	}
	// Broken barrier is now derived (maxBarrier − barrier); strip any stale standalone
	// field from states persisted before that change.
	delete (player as unknown as { arcaneBlood?: number }).arcaneBlood;
	player.extraActions ??= {};
	// P4 per-combat flags.
	player.combatDamageMultiplier ??= 1;
	player.attackRollAdvantage ??= false;
	player.halveIncoming ??= false;
	player.skipTakeDamage ??= false;
	// P5 per-turn / per-round flags.
	player.doubleRunes ??= false;
	player.redrawAvailable ??= false;
	player.freeNextRelicTrade ??= false;
	player.becameTaintedThisRound ??= false;
	player.becameCorruptThisRound ??= false;
	player.becameFallenThisRound ??= false;
	player.corruptedThisRound ??= false;
	// P6 awakening-progress flags.
	player.awakenProgress ??= {};
}

/**
 * Backfill rules-engine fields on a state that may have been persisted before
 * those fields existed (or created via the legacy lobby path). Keeps the reducer
 * and projection robust against older JSON snapshots.
 */
function ensureStateShape(state: PublicGameState): PublicGameState {
	state.rng ??= createRng(hashString(state.roomCode));
	state.phase ??= 'navigation';
	state.navigation ??= {};
	state.revealedDestinations ??= false;
	// `null` is a valid value (no-limit timer), so default only when the key is absent
	// (old persisted state) — never coalesce an intentional null back to the default.
	if (state.navigationDurationMs === undefined) {
		state.navigationDurationMs = DEFAULT_NAVIGATION_DURATION_MS;
	}
	state.navigationDeadline ??= null;
	state.navigationFullDeadline ??= null;
	state.phaseDeadline ??= null;
	state.locationOccupancy ??= {};
	state.monster ??= null;
	state.combats ??= [];
	state.winnerSeat ??= null;
	for (const seat of state.activeSeats ?? []) {
		const player = state.players[seat];
		if (player) ensurePlayerCollections(player);
	}
	return state;
}

function activePlayerForActor(
	state: PublicGameState,
	actor: GameActor
): { seatColor: SeatColor; player: PrivatePlayerState } | null {
	const seatColor = actor.seatColor;
	if (!seatColor) return null;
	const player = state.players[seatColor];
	if (!player) return null;
	ensurePlayerCollections(player);
	return { seatColor, player };
}

function failure(code: string, message: string): CommandResult {
	return {
		ok: false,
		error: { code, message }
	};
}

function success(state: PublicGameState): CommandResult {
	state.revision += 1;
	return { ok: true, state };
}

function occupiedSeatForMember(state: PublicGameState, memberId: string): SeatColor | null {
	for (const seatColor of SEAT_COLORS) {
		if (state.seats[seatColor].memberId === memberId) return seatColor;
	}
	return null;
}

function selectedGuardianTaken(
	state: PublicGameState,
	guardianName: string,
	excludeSeat: SeatColor | null
) {
	return SEAT_COLORS.some((seatColor) => {
		if (seatColor === excludeSeat) return false;
		return state.seats[seatColor].selectedGuardian === guardianName;
	});
}

function makeGameId(rng: RngState, now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const y = now.getUTCFullYear();
	const m = pad(now.getUTCMonth() + 1);
	const d = pad(now.getUTCDate());
	const hh = pad(now.getUTCHours());
	const mm = pad(now.getUTCMinutes());
	const ss = pad(now.getUTCSeconds());
	const random = nextInt(rng, 10000).toString().padStart(4, '0');
	return `game_${y}${m}${d}_${hh}${mm}${ss}_${random}`;
}

/** Build the opening monster: the weakest rung of the ladder. It takes one kill per
 *  active player to defeat (1p→1, 2p→2, …); only then does the next, stronger monster
 *  come out (at the round boundary). Null when the catalog has no monsters. */
function spawnMonster(catalog: PlayCatalog, playerCount: number): PublicGameState['monster'] {
	const ladder = catalog.monsters ?? [];
	const monster = ladder[0];
	if (!monster) return null;
	const lives = Math.max(1, playerCount);
	return {
		id: monster.id,
		name: monster.name,
		hp: monster.barrier,
		maxHp: monster.barrier,
		damage: monster.damage,
		rewardTrack: [...monster.rewardTrack],
		chooseAmount: monster.chooseAmount,
		livesRemaining: lives,
		livesTotal: lives,
		// Start at the bottom rung; the next rung appears once these lives are spent.
		ladderIndex: 0,
		ladderMax: ladder.length
	};
}

export function createLobbyState(input: {
	roomCode: string;
	guardianNames: string[];
}): PublicGameState {
	return {
		roomCode: input.roomCode.toUpperCase(),
		revision: 0,
		status: 'lobby',
		gameId: null,
		scenario: null,
		round: 0,
		guardianPool: [...input.guardianNames],
		seats: createSeatRecord(input.guardianNames),
		activeSeats: [],
		players: {},
		market: Array.from({ length: 6 }, (_, index) => ({ index, spiritId: null })),
		bags: createEmptyBags(),
		rng: createRng(hashString(input.roomCode)),
		phase: 'navigation',
		navigation: {},
		revealedDestinations: false,
		navigationDurationMs: DEFAULT_NAVIGATION_DURATION_MS,
		navigationDeadline: null,
		navigationFullDeadline: null,
		phaseDeadline: null,
		locationOccupancy: {},
		monster: null,
		combats: [],
		winnerSeat: null
	};
}

export function applyGameCommand(
	currentState: PublicGameState,
	actor: GameActor,
	command: GameCommand,
	catalog: PlayCatalog,
	opts?: { mutate?: boolean }
): CommandResult {
	// `mutate: true` skips the defensive deep-clone and mutates `currentState` IN PLACE — the
	// hot-path fast mode for self-play / training loops, where the prior state is discarded each
	// step (the clone is ~60% of per-command cost; see docs/sim-optimization-plan.md). It is
	// parity-tested against the cloning path across thousands of random rollouts (sim/_parity.test.ts).
	// Callers that must preserve the input state — dry-runs, bot search (`legalActions`,
	// `planBotPhaseActions`), the live server — MUST omit it (default = safe deep clone).
	const state = opts?.mutate
		? ensureStateShape(currentState)
		: ensureStateShape(cloneState(currentState));

	const result = reduceCommand(state, actor, command, catalog);
	// Whenever a command resolves the last piece of a seat's resolution-phase work
	// (claimed the benefits grant, awakened the last eligible spirit, trimmed the last
	// overflow rune, paid off the corruption debt, …), silently ready that seat — and
	// advance the phase if that was everyone. This keeps players from ever facing an
	// empty "Continue" step; phase entry does the same via the enter* helpers.
	if (result.ok) autoAdvanceResolution(result.state, catalog);
	return result;
}

function reduceCommand(
	state: PublicGameState,
	actor: GameActor,
	command: GameCommand,
	catalog: PlayCatalog
): CommandResult {
	switch (command.type) {
		case 'claimSeat': {
			if (state.status !== 'lobby') {
				return failure('seat_locked', 'Seats can only be claimed before the game starts.');
			}

			const seat = state.seats[command.seatColor];
			if (seat.memberId && seat.memberId !== actor.memberId) {
				return failure('seat_taken', `${command.seatColor} is already claimed.`);
			}

			const previousSeat = occupiedSeatForMember(state, actor.memberId);
			if (previousSeat && previousSeat !== command.seatColor) {
				state.seats[previousSeat] = {
					...state.seats[previousSeat],
					memberId: null,
					displayName: null,
					selectedGuardian: null
				};
			}

			state.seats[command.seatColor] = {
				...seat,
				memberId: actor.memberId,
				displayName: actor.displayName
			};

			return success(state);
		}

		case 'releaseSeat': {
			if (state.status !== 'lobby') {
				return failure('seat_locked', 'Seats can only be released before the game starts.');
			}

			const currentSeat = command.seatColor ?? occupiedSeatForMember(state, actor.memberId);
			if (!currentSeat || state.seats[currentSeat].memberId !== actor.memberId) {
				return failure('seat_missing', 'No claimed seat found for this member.');
			}

			state.seats[currentSeat] = {
				...state.seats[currentSeat],
				memberId: null,
				displayName: null,
				selectedGuardian: null
			};
			return success(state);
		}

		case 'selectGuardian': {
			if (state.status !== 'lobby') {
				return failure('guardian_locked', 'Guardians can only be selected before the game starts.');
			}

			if (!state.guardianPool.includes(command.guardianName)) {
				return failure('guardian_unknown', `Guardian ${command.guardianName} is not available.`);
			}

			const seatColor = actor.seatColor ?? occupiedSeatForMember(state, actor.memberId);
			if (!seatColor) {
				return failure('seat_required', 'Claim a seat before selecting a guardian.');
			}

			const seat = state.seats[seatColor];
			if (seat.memberId !== actor.memberId) {
				return failure('seat_required', 'Only the seated player can change this guardian.');
			}

			if (selectedGuardianTaken(state, command.guardianName, seatColor)) {
				return failure('guardian_taken', `${command.guardianName} is already selected.`);
			}

			state.seats[seatColor] = {
				...seat,
				selectedGuardian: command.guardianName
			};
			return success(state);
		}

		case 'setNavigationTimer': {
			if (state.status !== 'lobby') {
				return failure(
					'settings_locked',
					'The navigation timer can only be changed before the game starts.'
				);
			}
			if (actor.role !== 'host') {
				return failure('host_required', 'Only the host can change the navigation timer.');
			}
			const ms = command.durationMs;
			if (ms !== null && (!Number.isFinite(ms) || ms <= 0)) {
				return failure(
					'invalid_timer',
					'Navigation timer must be a positive duration, or null for no limit.'
				);
			}
			state.navigationDurationMs = ms;
			return success(state);
		}

		case 'startGame': {
			if (state.status !== 'lobby') {
				return failure('already_started', 'The game has already started.');
			}

			if (actor.role !== 'host') {
				return failure('host_required', 'Only the host can start the game.');
			}

			const occupiedSeats = SEAT_COLORS.filter((seatColor) => state.seats[seatColor].memberId);
			if (occupiedSeats.length === 0) {
				return failure('no_players', 'At least one player must claim a seat.');
			}

			for (const seatColor of occupiedSeats) {
				if (!state.seats[seatColor].selectedGuardian) {
					return failure('guardian_required', `Seat ${seatColor} must choose a guardian.`);
				}
			}

			// Seed the deterministic RNG once, here, so the whole game replays
			// identically. Tests may inject a fixed seed via the command.
			state.rng = createRng(command.seed ?? hashString(state.roomCode));
			state.status = 'active';
			state.gameId = makeGameId(state.rng);
			state.activeSeats = occupiedSeats;

			for (const seatColor of occupiedSeats) {
				state.players[seatColor] = buildPlayerState(seatColor, state.seats[seatColor]);
			}

			state.bags.hexSpirits = {
				count: 0,
				contents: []
			};
			state.bags.abyssFallen = {
				count: 0,
				contents: []
			};
			// Both TTS bags carry `shuffle = true`, so the opening hands, the market,
			// and every subsequent draw are randomized — not dealt in alphabetical
			// (catalog) order. Shuffle in place via the seeded RNG BEFORE dealing
			// opening hands / stocking the market so the whole game stays replayable.
			const spiritWorldBagContents = shuffleBag(
				buildInitialSpiritBag(catalog, SPIRIT_WORLD_BAG),
				state.rng
			);
			const arcaneAbyssBagContents = shuffleBag(
				buildInitialSpiritBag(catalog, ARCANE_ABYSS_BAG),
				state.rng
			);
			state.bags.hexSpirits = {
				count: spiritWorldBagContents.length,
				contents: spiritWorldBagContents
			};
			state.bags.abyssFallen = {
				count: arcaneAbyssBagContents.length,
				contents: arcaneAbyssBagContents
			};
			state.bags.history = buildHistoryBags(state.bags);

			// Deal each player their opening four Spirit World spirits before the
			// market is stocked from the remaining bag.
			for (const seatColor of occupiedSeats) {
				const player = state.players[seatColor];
				if (player) drawStartingSpirits(state, catalog, player);
			}
			state.bags.history = buildHistoryBags(state.bags);

			refillEmptyMarketSlots(state);
			state.monster = spawnMonster(catalog, state.activeSeats.length);
			// Initialize the simultaneous round loop (round 1, navigation phase).
			initRoundLoop(state);
			return success(state);
		}

		case 'spawnHandSpirit': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can summon drawn spirits.');
			}

			const pendingDraw = activePlayer.player.pendingDraw;
			if (!pendingDraw || activePlayer.player.handDraws.length === 0) {
				return failure('draw_missing', 'No drawn spirits are waiting to be summoned.');
			}

			const draw = activePlayer.player.handDraws.find((entry) => entry.guid === command.guid);
			if (!draw?.id) {
				return failure('draw_missing', 'That drawn spirit is no longer available.');
			}

			const spirit = catalog.spirits.find((entry) => entry.id === draw.id);
			if (!spirit) {
				return failure('spirit_missing', 'That spirit could not be found in the catalog.');
			}

			const slotIndex = command.slotIndex ?? firstOpenSpiritSlot(activePlayer.player);
			if (!slotIndex || slotIndex < 1 || slotIndex > 7) {
				return failure('slot_missing', 'No open spirit slot is available.');
			}

			activePlayer.player.spirits = activePlayer.player.spirits.filter(
				(candidate) => candidate.slotIndex !== slotIndex
			);
			// Overwriting a slot drops any augment bound to the spirit that was there —
			// the augment dies with it rather than migrating to the new spirit.
			activePlayer.player.spiritAugmentAttachments = (
				activePlayer.player.spiritAugmentAttachments ?? []
			).filter((attachment) => attachment.spiritSlotIndex !== slotIndex);
			activePlayer.player.spirits.push({
				slotIndex,
				id: spirit.id,
				name: spirit.name,
				cost: spirit.cost,
				classes: spirit.classes,
				origins: spirit.origins,
				isFaceDown: pendingDraw.sourceBag === ARCANE_ABYSS_BAG
			});
			activePlayer.player.spirits.sort((a, b) => a.slotIndex - b.slotIndex);
			activePlayer.player.handDraws = activePlayer.player.handDraws.filter(
				(entry) => entry.guid !== command.guid
			);
			activePlayer.player.pendingDraw = {
				...pendingDraw,
				summonedCount: pendingDraw.summonedCount + 1
			};
			// Soul Weaver: a redraw is only available BEFORE the first pick — committing to
			// a summon spends it for this draw (you can't redraw after picking a spirit).
			activePlayer.player.redrawAvailable = false;

			// Abyss Summoner / Florality: a draw flagged `autoAwaken` flips the spirit it
			// just summoned face-up immediately and fires its awakening effects (rather
			// than leaving the abyss spirit face-down for the Cleanup awaken flow).
			const summonLog: string[] = [];
			if (pendingDraw.autoAwaken && pendingDraw.sourceBag === ARCANE_ABYSS_BAG) {
				const summoned = activePlayer.player.spirits.find((s) => s.slotIndex === slotIndex);
				if (summoned?.isFaceDown) {
					summoned.isFaceDown = false;
					applyTrigger(state, activePlayer.seatColor, 'awakening', summonLog, {
						catalog,
						command: { type: 'awakenSpirit', slotIndex }
					});
					summonLog.unshift(`Summoned and awakened ${summoned.name} from the Abyss.`);
				}
			}

			if (
				activePlayer.player.pendingDraw.summonedCount >=
					activePlayer.player.pendingDraw.summonLimit ||
				activePlayer.player.handDraws.length === 0
			) {
				returnHandDrawsToBags(state, activePlayer.player);
				// A reward row that granted multiple summons queues the next draw.
				advanceDrawQueue(state, activePlayer.player);
			}

			// onSpiritSummon: fire scoped to the JUST-SUMMONED spirit's own classes, so an
			// on-summon grant (Sharpshooter +Enchanted/stun-immune, Healer restore 2 barrier)
			// fires once when THAT spirit is summoned — not on every summon while the class is
			// merely in play. Effects apply silently — the new die/barrier shows directly.
			applyTrigger(state, activePlayer.seatColor, 'onSpiritSummon', [], {
				catalog,
				command,
				counts: spirit.classes
			});

			// Keep cleanup awaken offers/eligibility consistent if an abyss spirit
			// auto-awakened mid-summon, and surface that awaken result.
			if (summonLog.length > 0) {
				recomputeAwakenEligibility(state, catalog);
				activePlayer.player.lastAction = { key: 'awaken', label: 'Abyss Summon', log: summonLog };
			}

			return success(state);
		}

		case 'discardHandDraws': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can discard drawn spirits.');
			}

			if (activePlayer.player.handDraws.length === 0) {
				return failure('draw_missing', 'No drawn spirits are waiting to be discarded.');
			}

			returnHandDrawsToBags(state, activePlayer.player);
			// Discarding the current draw lets any queued reward draw start.
			advanceDrawQueue(state, activePlayer.player);
			return success(state);
		}

		case 'redrawHandDraws': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can redraw drawn spirits.');
			}

			const player = activePlayer.player;
			if (!player.redrawAvailable) {
				return failure('redraw_unavailable', 'No Soul Weaver redraw is available right now.');
			}

			const pendingDraw = player.pendingDraw;
			if (!pendingDraw || player.handDraws.length === 0) {
				return failure('draw_missing', 'No drawn spirits are waiting to be redrawn.');
			}

			// Preserve the picks already made — the redraw refreshes the cards on offer,
			// it does not refund summons. Cap the kept summon limit at the new draw size.
			const { sourceBag, summonLimit, summonedCount, autoAwaken } = pendingDraw;
			returnHandDrawsToBags(state, player);
			if (!startDraw(state, player, sourceBag, autoAwaken)) {
				// Bag emptied out (the returned spirits should still be there, so this is
				// only reachable if the bag is otherwise empty) — leave the player draw-less.
				player.redrawAvailable = false;
				advanceDrawQueue(state, player);
				return success(state);
			}
			if (player.pendingDraw) {
				player.pendingDraw.summonLimit = Math.min(summonLimit, player.handDraws.length);
				player.pendingDraw.summonedCount = summonedCount;
			}
			// One-shot: consumed until the next summon re-arms it.
			player.redrawAvailable = false;
			player.lastAction = {
				key: 'redraw',
				label: 'Soul Weaver Redraw',
				log: ['Returned the draw and drew again.']
			};
			return success(state);
		}

		// ── Market commands: removed from the player surface (rules v1.1) ──────
		// The specialized-location model has no market action: spirits enter play
		// only through Summon draws (location reward rows / monster-reward tokens)
		// or the opening hands, all inside the one-location-per-round commitment.
		// These three commands had no UI dispatch path, no cost, no phase or
		// destination gate and no per-round limit, so bots could build entire
		// boards from free market takes while locked to the Abyss (replaceSpirit
		// also destroyed the replaced spirit instead of returning it to its bag).
		// The market array stays in state for snapshot compatibility but is inert;
		// startGame still stocks it via refillEmptyMarketSlots (display only).
		case 'takeSpirit':
		case 'replaceSpirit':
		case 'refillMarket':
			return failure('unsupported_command', 'The spirit market is not a player action.');

		case 'selectNavigationDestination': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}
			// Same commitment gate as lockNavigation: a destination may only be set
			// during the pre-reveal Navigation phase. Without this, the (legacy,
			// UI-less) command could rewrite navigationDestination mid-round and
			// break the one-location-per-round rule for any future caller.
			if (state.phase !== 'navigation' || state.revealedDestinations) {
				return failure('wrong_phase', 'Navigation is closed for this round.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can select a destination.');
			}
			if (
				!SPIRIT_WORLD_LOCATIONS.includes(
					command.destination as (typeof SPIRIT_WORLD_LOCATIONS)[number]
				)
			) {
				return failure(
					'destination_invalid',
					`${command.destination} is not a valid Spirit World location.`
				);
			}

			activePlayer.player.navigationDestination = command.destination;
			return success(state);
		}

		case 'spawnDiceBatch': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can spawn dice.');

			const die = findCatalogDie(catalog, command.diceId);
			if (!die) {
				return failure('dice_missing', `Dice ${command.diceId} was not found.`);
			}

			const count = Math.max(0, Math.min(12, Math.floor(command.count)));
			if (count <= 0) {
				return failure('dice_count_invalid', 'Spawn at least one die.');
			}

			for (let index = 0; index < count; index += 1) {
				const position = nextDicePosition(activePlayer.player.spawnedDice.length);
				activePlayer.player.spawnedDice.push({
					instanceId: createInstanceId(state.rng, 'die'),
					diceId: die.id,
					name: die.name,
					diceType: die.diceType,
					localX: position.x,
					localZ: position.z,
					...createDieRoll(state.rng, die.diceType)
				});
			}

			return success(state);
		}

		case 'rollSpawnedDice': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can roll dice.');

			for (const die of activePlayer.player.spawnedDice) {
				Object.assign(die, createDieRoll(state.rng, die.diceType));
			}

			return success(state);
		}

		case 'clearSpawnedDice': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can clear dice.');
			activePlayer.player.spawnedDice = [];
			return success(state);
		}

		case 'spawnMatItem': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can spawn items.');

			const rune = findCatalogRune(catalog, command.runeId);
			if (!rune) {
				return failure('item_missing', `Item ${command.runeId} was not found.`);
			}

			const position = nextMatItemPosition(activePlayer.player.spawnedItems.length);
			activePlayer.player.spawnedItems.push({
				instanceId: createInstanceId(state.rng, 'item'),
				runeId: rune.id,
				name: rune.name,
				kind: rune.kind,
				localX: position.x,
				localZ: position.z
			});
			return success(state);
		}

		case 'clearSpawnedItems': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can clear items.');
			activePlayer.player.spawnedItems = [];
			return success(state);
		}

		case 'moveMatObject': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer)
				return failure('seat_required', 'Only seated players can move mat objects.');

			if (command.objectType === 'die') {
				const target = activePlayer.player.spawnedDice.find(
					(entry) => entry.instanceId === command.instanceId
				);
				if (!target) return failure('object_missing', 'That die no longer exists.');
				target.localX = command.localX;
				target.localZ = command.localZ;
				return success(state);
			}

			const target = activePlayer.player.spawnedItems.find(
				(entry) => entry.instanceId === command.instanceId
			);
			if (!target) return failure('object_missing', 'That item no longer exists.');
			target.localX = command.localX;
			target.localZ = command.localZ;
			return success(state);
		}

		case 'adjustBarrier': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can adjust barrier.');
			activePlayer.player.barrier = Math.max(0, activePlayer.player.barrier + command.amount);
			// Barrier (intact side) is authoritative: grow capacity if it now exceeds, then
			// derive broken barrier so brokenBarrier === maxBarrier − barrier always holds.
			activePlayer.player.maxBarrier = Math.max(
				activePlayer.player.maxBarrier,
				activePlayer.player.barrier
			);
			activePlayer.player.brokenBarrier =
				activePlayer.player.maxBarrier - activePlayer.player.barrier;
			return success(state);
		}

		case 'adjustBrokenBarrier': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer)
				return failure('seat_required', 'Only seated players can adjust broken barrier.');
			// Broken barrier is a side of the existing pool: bump it (clamped to capacity) and
			// re-derive the intact side, keeping brokenBarrier === maxBarrier − barrier.
			activePlayer.player.brokenBarrier = Math.max(
				0,
				activePlayer.player.brokenBarrier + command.amount
			);
			syncBarrierFromBrokenBarrier(activePlayer.player);
			return success(state);
		}

		case 'adjustMaxBarrier': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer)
				return failure('seat_required', 'Only seated players can adjust max barrier.');
			activePlayer.player.maxBarrier = Math.max(
				0,
				Math.min(10, activePlayer.player.maxBarrier + command.amount)
			);
			syncBarrierFromBrokenBarrier(activePlayer.player);
			return success(state);
		}

		case 'adjustStatus': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) return failure('seat_required', 'Only seated players can adjust status.');
			const oldStatus = activePlayer.player.statusLevel;
			activePlayer.player.statusLevel = Math.max(
				0,
				Math.min(STATUS_LADDER.length - 1, activePlayer.player.statusLevel + command.amount)
			);
			activePlayer.player.statusToken = STATUS_LADDER[activePlayer.player.statusLevel];
			// onStatusChange: record crossed thresholds + fire the trigger when the
			// level actually moved (manual adjustments can also corrupt a player).
			if (activePlayer.player.statusLevel !== oldStatus) {
				// An UPWARD status move is a corruption: instant full barrier restore + the escalating
				// spirit sacrifice, exactly like the damage paths. A
				// DOWNWARD move (purification) owes nothing.
				if (activePlayer.player.statusLevel > oldStatus) {
					activePlayer.player.barrier = activePlayer.player.maxBarrier;
					activePlayer.player.brokenBarrier = 0;
					activePlayer.player.corruptionCount = (activePlayer.player.corruptionCount ?? 0) + 1;
					// wasFallen is structurally false here (an upward move FROM Fallen is
					// impossible — the ladder clamps), but pass the real check for parity
					// with the combat site.
					setCorruptionDiscardObligation(activePlayer.player, undefined, {
						wasFallen: oldStatus === STATUS_LADDER.length - 1
					});
				}
				applyStatusChange(
					state,
					activePlayer.seatColor,
					oldStatus,
					activePlayer.player.statusLevel,
					catalog,
					[]
				);
			}
			return success(state);
		}

		case 'adjustVictoryPoints': {
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer)
				return failure('seat_required', 'Only seated players can adjust victory points.');
			activePlayer.player.victoryPoints = Math.max(
				0,
				activePlayer.player.victoryPoints + command.amount
			);
			return success(state);
		}

		case 'flipSpirit': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}

			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can flip spirits.');
			}

			const spirit = activePlayer.player.spirits.find(
				(entry) => entry.slotIndex === command.slotIndex
			);
			if (!spirit) {
				return failure('spirit_missing', 'No spirit exists in that slot.');
			}

			spirit.isFaceDown = !spirit.isFaceDown;
			return success(state);
		}

		case 'discardSpirit': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can discard spirits.');
			}
			const player = activePlayer.player;
			const spirit = player.spirits.find((entry) => entry.slotIndex === command.slotIndex);
			if (!spirit) {
				return failure('spirit_missing', 'No spirit exists in that slot.');
			}

			// Remove it from the tableau (freeing the slot for a new summon) and drop
			// any runes attached to that slot.
			player.spirits = player.spirits.filter((entry) => entry.slotIndex !== command.slotIndex);
			player.spiritAugmentAttachments = (player.spiritAugmentAttachments ?? []).filter(
				(attachment) => attachment.spiritSlotIndex !== command.slotIndex
			);

			// Return the card to the bag it came from (face-down ⇒ Arcane Abyss,
			// otherwise by cost) and reshuffle so it isn't predictably drawn next.
			const sourceBag =
				bagForSpiritCost(spirit.cost) ?? (spirit.isFaceDown ? ARCANE_ABYSS_BAG : SPIRIT_WORLD_BAG);
			const runtimeBag = runtimeBagForSource(state, sourceBag);
			runtimeBag.contents.push({
				name: spirit.name,
				guid: nextId(state.rng, 'discard'),
				id: spirit.id,
				cost: spirit.cost
			});
			shuffleBag(runtimeBag.contents, state.rng);
			runtimeBag.count = runtimeBag.contents.length;
			state.bags.history = buildHistoryBags(state.bags);

			// If the player owes a forced corruption discard, this discard pays it down; once
			// the owed count reaches 0 the obligation clears so the round can advance again.
			// (Voluntary discards with no obligation are a no-op.)
			const obligation = player.pendingCorruptionDiscard;
			if (obligation && obligation.count > 0) {
				obligation.count -= 1;
				if (obligation.count <= 0) player.pendingCorruptionDiscard = null;
				// Out of spirits with debt remaining: the unpayable part converts to VP
				// loss (1 VP each) instead of being forgiven, and the debt clears so the
				// round can advance.
				else settleUnpayableCorruptionDebt(player);
			}
			return success(state);
		}

		case 'placeAugmentOnSpirit': {
			// Deliberately phase-agnostic: a player may attach a gained augment to one of
			// their own spirits at any point during an active game (it only affects their
			// own tableau). The only gates are an active game + a real target spirit.
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}
			const activePlayer = activePlayerForActor(state, actor);
			if (!activePlayer) {
				return failure('seat_required', 'Only seated players can place augments.');
			}
			const player = activePlayer.player;
			player.unplacedAugments ??= [];
			// Resolve by index, but verify it's the rune the client dragged; if the pouch
			// reordered between drag-start and drop (e.g. a new augment arrived), fall back
			// to the first match by runeId so we never attach a different augment.
			let idx = command.augmentIndex;
			if (player.unplacedAugments[idx]?.runeId !== command.augmentRuneId) {
				idx = player.unplacedAugments.findIndex((a) => a.runeId === command.augmentRuneId);
			}
			const augment = idx >= 0 ? player.unplacedAugments[idx] : undefined;
			if (!augment) {
				return failure('augment_missing', 'No augment to place.');
			}
			const spirit = player.spirits.find((entry) => entry.slotIndex === command.spiritSlotIndex);
			if (!spirit) {
				return failure('spirit_missing', 'No spirit exists in that slot.');
			}

			// Designated-target binding: some augments (e.g. Fairy Droid's "gain 2 augments
			// for THIS spirit") may only be placed on a specific spirit, not just anyone.
			if (augment.boundSlotIndex != null && augment.boundSlotIndex !== spirit.slotIndex) {
				return failure(
					'augment_wrong_target',
					`That Spirit Augment must go on ${augment.boundLabel ?? 'its designated spirit'}.`
				);
			}
			// Host-class binding: some augments (e.g. Purifier's) may only be placed on a
			// spirit that HAS a given class — restricting to a category of host, not one slot.
			if (augment.hostClass != null && (spirit.classes?.[augment.hostClass] ?? 0) <= 0) {
				return failure(
					'augment_wrong_target',
					`That Spirit Augment must go on ${augment.boundLabel ?? `a ${augment.hostClass}`}.`
				);
			}

			// A Spirit Augment is one of the six SPIRIT_AUGMENT_CLASSES, chosen by the owner
			// at placement (command.className); fall back to a pre-bound classId for older
			// flows. The placed augment adds that class toward the owner's trait totals.
			let augmentClassName = command.className;
			if (augmentClassName && !isSpiritAugmentClass(augmentClassName)) {
				return failure('augment_class_invalid', `${augmentClassName} is not a Spirit Augment.`);
			}
			if (!augmentClassName && augment.classId) {
				augmentClassName = catalog.classes.find((c) => c.id === augment.classId)?.name;
			}
			if (!augmentClassName) {
				return failure('augment_class_required', 'Choose which Spirit Augment to place.');
			}
			const augmentClassId = catalog.classes.find((c) => c.name === augmentClassName)?.id;

			// Capacity: a spirit holds ONE augment by default; some (e.g. Fairy Droid) raise
			// it, and some augments carry their own host cap (Purifier grants 2 per Cursed
			// Spirit). Count every placed augment (class-linked, or a legacy generic token).
			const capacity = Math.max(augmentCapacityForSpirit(spirit), augment.hostCapacity ?? 0);
			const placedOnSpirit = (player.spiritAugmentAttachments ?? []).filter(
				(a) =>
					a.spiritSlotIndex === spirit.slotIndex &&
					(typeof a.className === 'string' || a.runeId === GENERIC_AUGMENT_RUNE_ID)
			).length;
			if (placedOnSpirit >= capacity) {
				return failure('augment_full', 'That spirit already holds its maximum augments.');
			}

			// Permanently attach: pull it from the to-place pouch and bind it to the spirit.
			// It rides along if the spirit is ever discarded (see discardSpirit).
			player.unplacedAugments = player.unplacedAugments.filter((_, i) => i !== idx);
			(player.spiritAugmentAttachments ??= []).push({
				runeId: augment.runeId,
				spiritId: spirit.id,
				spiritSlotIndex: spirit.slotIndex,
				name: `${augmentClassName} Augment`,
				classId: augmentClassId,
				className: augmentClassName
			});
			return success(state);
		}

		case 'discardUnplacedAugments': {
			// Forfeit any augments the player can't (or doesn't want to) place — the escape
			// hatch that keeps the optional placement step from ever blocking the turn.
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}
			const ap = activePlayerForActor(state, actor);
			if (!ap) {
				return failure('seat_required', 'Only seated players can manage augments.');
			}
			ap.player.unplacedAugments = [];
			return success(state);
		}

		case 'commitRound': {
			if (state.status !== 'active') {
				return failure('inactive', 'The game has not started yet.');
			}
			for (const seatColor of state.activeSeats) {
				if (!state.players[seatColor]?.navigationDestination) {
					return failure(
						'destination_missing',
						`Seat ${seatColor} has not selected a destination.`
					);
				}
			}
			for (const seatColor of state.activeSeats) {
				const player = state.players[seatColor];
				if (player) player.navigationDestination = null;
			}
			state.round += 1;
			return success(state);
		}

		// ── Phase machine (2D play mode) ──────────────────────────────────
		case 'lockNavigation': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'navigation' || state.revealedDestinations) {
				return failure('wrong_phase', 'Navigation is closed for this round.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can choose a destination.');
			if (!(ALL_DESTINATIONS as readonly string[]).includes(command.destination)) {
				return failure('destination_invalid', `${command.destination} is not a valid destination.`);
			}
			active.player.pendingDestination = command.destination;
			state.navigation[active.seatColor] = { locked: true };
			// NOTE: locking no longer reveals immediately, even when all seats are locked.
			// The reveal now happens when the navigation deadline expires (forceAdvance /
			// server enforcement). When all seats lock early the server collapses the
			// deadline to a short grace, leaving a window to back out (unlockNavigation).
			return success(state);
		}

		case 'unlockNavigation': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'navigation' || state.revealedDestinations) {
				return failure('wrong_phase', 'Destinations are already locked in.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can change a destination.');
			active.player.pendingDestination = null;
			state.navigation[active.seatColor] = { locked: false };
			return success(state);
		}

		case 'endLocationActions': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'location') {
				return failure('wrong_phase', 'You can only end actions during the Location phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can end their actions.');
			// A reward summon opens a draw (and may queue a second). Block ending the
			// phase until it's resolved, so the drawn spirits are never abandoned —
			// otherwise they'd leak out of their bag (spliced out, never returned).
			if (
				active.player.pendingDraw ||
				active.player.handDraws.length > 0 ||
				active.player.pendingDrawQueue.length > 0
			) {
				return failure('draw_pending', 'Resolve your drawn spirits before ending your turn.');
			}
			// A corruption this turn forces its escalating spirit sacrifice IMMEDIATELY: you
			// can't end your location actions until you've shed the owed spirit(s). (Corruption
			// already restored your barrier instantly — this is the cost.) With zero spirits
			// left the debt is unpayable — settle it as VP loss (1 VP each) so the seat can
			// never be frozen; while spirits remain the player must keep discarding.
			if (active.player.pendingCorruptionDiscard) {
				settleUnpayableCorruptionDebt(active.player);
				if (active.player.pendingCorruptionDiscard) {
					return failure(
						'corruption_pending',
						'Discard your corrupted spirit(s) before ending your turn.'
					);
				}
			}
			// Defeating the Abyss monster opens a reward pick — claim it before passing.
			if (active.player.pendingReward) {
				return failure('reward_pending', 'Claim your monster rewards before ending your turn.');
			}
			// onLocationInteraction fires once per player as they finish their location
			// interactions (Rune Mage's rune/relic-trade prompt → manual, since the
			// engine has no first-class trade command to hook each individual trade).
			if (!active.player.phaseReady) {
				applyTrigger(state, active.seatColor, 'onLocationInteraction', [], { catalog });
			}
			active.player.phaseReady = true;
			tryAdvanceFromLocation(state, catalog);
			return success(state);
		}

		case 'commitBenefits': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'benefits') {
				return failure('wrong_phase', 'There are no benefits to resolve right now.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can confirm benefits.');
			// Awakening-Phase class grants (Cursed Spirit, Golden Ruler, …) must be claimed
			// before the Benefits step can advance to Awakening.
			if (active.player.pendingAwakenReward) {
				return failure('claim_pending', 'Claim your benefits first.');
			}
			active.player.phaseReady = true;
			tryAdvanceFromBenefits(state, catalog);
			return success(state);
		}

		case 'commitAwakening': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'awakening') {
				return failure('wrong_phase', 'There is nothing to awaken right now.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can confirm awakening.');
			// Awakening is optional — face-down spirits may be left dormant for a later round
			// — so there is no hard gate here. Augment placement / ability decisions are
			// surfaced in-stage but never block (consistent with prior behavior); the Cleanup
			// step still gates rune overflow + corruption.
			active.player.phaseReady = true;
			tryAdvanceFromAwakening(state, catalog);
			return success(state);
		}

		case 'commitCleanup': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'cleanup') {
				return failure('wrong_phase', 'There is nothing to clean up right now.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can confirm cleanup.');
			// You may hold extra runes mid-round, but only RUNE_CARRY_LIMIT carry over —
			// discard the overflow before the round can advance.
			if (heldRuneCount(active.player) > RUNE_CARRY_LIMIT) {
				return failure(
					'runes_overflow',
					`Your runes are overflowing — discard down to ${RUNE_CARRY_LIMIT} before ending cleanup.`
				);
			}
			// Corruption owes a forced spirit sacrifice (it already restored your barrier instantly): shed
			// the owed spirit(s). The round cannot advance past cleanup until the obligation
			// is fully cleared (null). With ZERO spirits left the debt is unpayable — settle
			// it as VP loss (1 VP each) right here so the seat can never be frozen; while
			// spirits remain the player must keep discarding.
			if (active.player.pendingCorruptionDiscard) {
				settleUnpayableCorruptionDebt(active.player);
				if (active.player.pendingCorruptionDiscard) {
					return failure('corruption_pending', 'Resolve corruption before ending the round.');
				}
			}
			active.player.phaseReady = true;
			tryAdvanceFromCleanup(state, catalog);
			return success(state);
		}

		case 'resolveAwakenReward': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'benefits') {
				return failure('wrong_phase', 'Awakening rewards are claimed during the Benefits phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can claim rewards.');
			if (!active.player.pendingAwakenReward)
				return failure('no_reward', 'You have no Awakening rewards to claim.');
			applyAwakenRewardClaim(
				state,
				active.seatColor,
				active.player,
				command.taintedMaxBarrier ?? 0,
				command.relicPicks ?? [],
				catalog
			);
			return success(state);
		}

		case 'discardRune': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'cleanup') {
				return failure('wrong_phase', 'Runes are discarded during the Cleanup phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can discard runes.');
			const slot = active.player.mats.find((r) => r.slotIndex === command.slotIndex && r.hasRune);
			if (!slot) return failure('rune_missing', 'No rune in that slot to discard.');
			slot.hasRune = false;
			// A discarded rune/relic may have been a Faerie's only awaken candidate —
			// rebuild offers so a now-unpayable spirit drops its Cleanup card.
			recomputeAwakenEligibility(state, catalog);
			return success(state);
		}

		case 'infiltratorSwap': {
			// Infiltrator (ENCODER): "swap 1 Attack Die with all players in your Location."
			// A standalone Location-phase action — once per round, while an awakened
			// Infiltrator shares a location with the targets. One swap per co-located
			// player; each exchanges one of your dice for one of theirs.
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'location') {
				return failure('wrong_phase', 'Dice are swapped during the Location phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can swap dice.');
			const me = active.player;
			const hasInfiltrator = me.spirits.some(
				(s) => !s.isFaceDown && (s.classes?.Infiltrator ?? 0) > 0
			);
			if (!hasInfiltrator) return failure('no_infiltrator', 'You have no awakened Infiltrator.');
			if (me.actionsUsedThisRound.includes('infiltratorSwap')) {
				return failure('already_used', 'You have already swapped dice this round.');
			}
			const dest = me.navigationDestination;
			if (!dest) return failure('no_location', 'You are not at a location.');
			const swaps = command.swaps ?? [];
			if (swaps.length === 0) return failure('no_swaps', 'Choose at least one die to swap.');
			// Validate every swap BEFORE mutating, so a bad entry rejects the whole action.
			const seenTargets = new Set<SeatColor>();
			for (const sw of swaps) {
				if (sw.targetSeat === active.seatColor)
					return failure('self_swap', 'Cannot swap with yourself.');
				if (seenTargets.has(sw.targetSeat)) {
					return failure('dup_target', 'At most one die swap per player.');
				}
				seenTargets.add(sw.targetSeat);
				const target = state.players[sw.targetSeat];
				if (!target || !state.activeSeats.includes(sw.targetSeat)) {
					return failure('bad_target', 'That player is not in the game.');
				}
				if (target.navigationDestination !== dest) {
					return failure('not_colocated', 'That player is not in your location.');
				}
				if (!me.attackDice.some((d) => d.instanceId === sw.myInstanceId)) {
					return failure('die_missing', 'One of your chosen dice is unavailable.');
				}
				if (!target.attackDice.some((d) => d.instanceId === sw.theirInstanceId)) {
					return failure('die_missing', 'A chosen opponent die is unavailable.');
				}
			}
			const log: string[] = [];
			for (const sw of swaps) {
				const target = state.players[sw.targetSeat]!;
				const myIdx = me.attackDice.findIndex((d) => d.instanceId === sw.myInstanceId);
				const theirIdx = target.attackDice.findIndex((d) => d.instanceId === sw.theirInstanceId);
				if (myIdx < 0 || theirIdx < 0) continue;
				const myDie = me.attackDice[myIdx];
				const theirDie = target.attackDice[theirIdx];
				me.attackDice[myIdx] = theirDie;
				target.attackDice[theirIdx] = myDie;
				log.push(`Swapped your ${myDie.tier} die for ${sw.targetSeat}'s ${theirDie.tier} die.`);
			}
			me.actionsUsedThisRound.push('infiltratorSwap');
			me.lastAction = { key: 'infiltrate', label: 'Infiltrator — dice swap', log };
			return success(state);
		}

		case 'forceAdvancePhase': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (actor.role !== 'host')
				return failure('host_required', 'Only the host can force the phase forward.');
			// A forced advance bypasses the per-seat pass guard, so any in-progress
			// reward draw would otherwise be abandoned mid-resolution — leaking the
			// drawn spirits out of their bag. drainPendingBeforeAdvance returns them
			// first; the server's deadline enforcement shares the same helper.
			drainPendingBeforeAdvance(state, catalog);
			forceAdvancePhaseMachine(state, catalog);
			return success(state);
		}

		case 'dismissManualPrompt': {
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can dismiss prompts.');
			active.player.manualPrompts = active.player.manualPrompts.filter(
				(entry) => entry.id !== command.id
			);
			return success(state);
		}

		case 'resolveDecision': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can resolve decisions.');
			const decision = active.player.pendingDecisions.find(
				(entry) => entry.id === command.decisionId
			);
			if (!decision) return failure('decision_missing', 'No such decision is pending.');

			const log: string[] = [];
			const resolver = DECISION_RESOLVERS[decision.kind];
			if (resolver) {
				const ctx = buildEffectContext({
					state,
					seat: active.seatColor,
					player: active.player,
					trigger: 'awakeningPhase',
					log,
					traitCount: 0,
					catalog
				});
				resolver(ctx, command.optionId, command.selectedInstanceIds);
			}
			// Abyss Summoner (Florality): Yes starts an Abyss draw (3 → summon 1) flagged
			// autoAwaken, so the summoned spirit flips + awakens in spawnHandSpirit. Driven
			// here (not in DECISION_RESOLVERS) because it needs the runtime draw machinery.
			if (decision.kind === 'abyssSummonFlorality' && command.optionId === 'yes') {
				queueOrBeginDraw(state, active.player, ARCANE_ABYSS_BAG, true);
				log.push('Drawing 3 from the Abyss to summon and awaken 1.');
			}
			// Remove the resolved decision regardless of the option taken.
			active.player.pendingDecisions = active.player.pendingDecisions.filter(
				(entry) => entry.id !== command.decisionId
			);
			active.player.lastAction = { key: 'decision', label: decision.prompt, log };
			return success(state);
		}

		case 'awakenSpirit': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'awakening') {
				return failure('wrong_phase', 'Spirits are awakened during the Awakening phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can awaken spirits.');
			const spirit = active.player.spirits.find((entry) => entry.slotIndex === command.slotIndex);
			if (!spirit) return failure('spirit_missing', 'No spirit exists in that slot.');
			if (!spirit.isFaceDown) return failure('already_awake', 'That spirit is already awakened.');

			const log: string[] = [];
			const ctx = buildEffectContext({
				state,
				seat: active.seatColor,
				player: active.player,
				trigger: 'awakening',
				log,
				traitCount: 0,
				catalog,
				command
			});
			const check = checkAwakenCondition(ctx, { spirit });
			if (!check.ok) {
				// An UNSCRIPTED `text` condition can't be auto-resolved: surface a manual
				// prompt (so the player can resolve it by hand and confirm via
				// manualAwaken) and leave the spirit face-down. The command "succeeds"
				// only in that it records the prompt — the flip is blocked.
				//
				// A SCRIPTED text condition that simply isn't satisfiable right now
				// (wrong location, too few relics, event not fired) is a hard block, like
				// an unpayable rune cost — no manual prompt, since it WILL be auto-payable
				// once the player meets the condition.
				if (check.kind === 'text' && check.scripted !== true && check.text) {
					active.player.manualPrompts.push({
						id: nextId(state.rng, 'mp'),
						source: 'awaken',
						text: `Awaken ${spirit.name}: ${check.text} — resolve by hand, then confirm.`
					});
					active.player.lastAction = {
						key: 'awaken_manual',
						label: `Awaken ${spirit.name}`,
						log: [`${spirit.name} needs a manual awakening: ${check.text}`]
					};
					return success(state);
				}
				return failure('awaken_unmet', `${spirit.name} cannot be awakened yet.`);
			}

			// A rune_cost offer lets the owner pick WHICH held runes to spend; the picker
			// sends them as `discardRefs` (kind 'rune', by slot). Translate those to the
			// runes' instance ids so matchMatCost prefers exactly the chosen copies.
			// (Scripted text handlers read discardRefs directly and ignore this arg.)
			let runeInstanceIds = command.runeInstanceIds;
			if (!runeInstanceIds && command.discardRefs?.length) {
				const ids = command.discardRefs
					.filter((r) => r.kind === 'rune')
					.map((r) => active.player.mats.find((s) => s.slotIndex === r.slotIndex)?.guid)
					.filter((g): g is string => !!g);
				if (ids.length) runeInstanceIds = ids;
			}
			const payment = payAwakenCondition(ctx, { spirit }, runeInstanceIds);
			if (!payment.ok) {
				return failure('awaken_unmet', `${spirit.name} cannot be awakened yet.`);
			}
			if (payment.discarded.length > 0) {
				log.push(`Discarded ${payment.discarded.join(', ')} to awaken ${spirit.name}.`);
			}

			spirit.isFaceDown = false;
			// onAwaken class effects resolve now that the spirit's classes are active.
			applyTrigger(state, active.seatColor, 'awakening', log, { catalog, command });
			// Rebuild eligibility + offers: the flipped spirit drops off and any cost
			// just paid (discarded runes/relics/traits) reshapes the remaining offers.
			recomputeAwakenEligibility(state, catalog);
			active.player.lastAction = { key: 'awaken', label: `Awaken ${spirit.name}`, log };
			return success(state);
		}

		case 'manualAwaken': {
			// Owner (or host) confirms a NON-scripted `text` condition was resolved by
			// hand, flipping the spirit face-up. Mirrors dismissManualPrompt: it clears
			// the matching pending awaken prompt. Scripted text spirits + rune costs
			// must use `awakenSpirit` instead (rejected here).
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can awaken spirits.');
			if (actor.role !== 'host' && actor.seatColor !== active.seatColor) {
				return failure('owner_required', 'Only the spirit owner or the host can confirm this.');
			}
			const spirit = active.player.spirits.find((entry) => entry.slotIndex === command.slotIndex);
			if (!spirit) return failure('spirit_missing', 'No spirit exists in that slot.');
			if (!spirit.isFaceDown) return failure('already_awake', 'That spirit is already awakened.');

			const log: string[] = [];
			const ctx = buildEffectContext({
				state,
				seat: active.seatColor,
				player: active.player,
				trigger: 'awakening',
				log,
				traitCount: 0,
				catalog,
				command
			});
			// Only an UNSCRIPTED text condition is confirmable by hand. Free/rune-cost/
			// scripted-text spirits resolve deterministically via awakenSpirit.
			if (!needsManualAwaken(ctx, { spirit })) {
				return failure(
					'not_manual_awaken',
					`${spirit.name} is resolved automatically — use awakenSpirit.`
				);
			}

			spirit.isFaceDown = false;
			// Clear any pending awaken prompt the auto-path raised for this spirit.
			active.player.manualPrompts = active.player.manualPrompts.filter(
				(entry) => !(entry.source === 'awaken' && entry.text.includes(spirit.name))
			);
			// onAwaken class effects resolve now that the spirit's classes are active.
			applyTrigger(state, active.seatColor, 'awakening', log, { catalog, command });
			recomputeAwakenEligibility(state, catalog);
			active.player.lastAction = {
				key: 'awaken_confirmed',
				label: `Awaken ${spirit.name}`,
				log: [`${spirit.name} awakened by manual confirmation.`, ...log]
			};
			return success(state);
		}

		case 'debugGrant': {
			// DEV-ONLY god-mode grant (the commands endpoint blocks this outside dev).
			// Hands the active player any resource so ability UX can be tested without
			// grinding a whole game. Reuses runAction for quantity grants; resolves
			// spirit/rune ids against the catalog.
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			const sender = activePlayerForActor(state, actor);
			if (!sender) return failure('seat_required', 'Only seated players can use debug grants.');
			// Target another seat when asked (set someone's status from the roster), else self.
			const targetSeat = command.seatColor ?? sender.seatColor;
			if (!state.activeSeats.includes(targetSeat)) {
				return failure('seat_required', 'That seat is not in play.');
			}
			const player = state.players[targetSeat];
			if (!player) return failure('seat_required', 'That seat is not in play.');
			const grant = command.grant;
			const log: string[] = [];
			const ctx = buildEffectContext({
				state,
				seat: targetSeat,
				player,
				trigger: 'awakeningPhase',
				log,
				traitCount: 0,
				catalog
			});

			switch (grant.kind) {
				case 'attackDice':
					runAction(ctx, { kind: 'gainAttackDice', tier: grant.tier, amount: grant.amount });
					break;
				case 'maxBarrier':
					runAction(ctx, { kind: 'gainMaxBarrier', amount: grant.amount });
					break;
				case 'vp':
					runAction(ctx, { kind: 'gainVP', amount: grant.amount });
					break;
				case 'augment': {
					player.unplacedAugments ??= [];
					const cls = grant.classId
						? catalog.classes.find((c) => c.id === grant.classId)
						: undefined;
					for (let i = 0; i < grant.amount; i += 1) {
						player.unplacedAugments.push({
							runeId: nextId(state.rng, 'aug'),
							name: cls ? `${cls.name} Augment` : 'Spirit Augment',
							...(grant.classId ? { classId: grant.classId } : {})
						});
					}
					log.push(`Debug: +${grant.amount} ${cls ? cls.name : 'generic'} augment(s).`);
					break;
				}
				case 'spirit': {
					const sp = catalog.spirits.find((s) => s.id === grant.spiritId);
					if (!sp) return failure('spirit_missing', 'That spirit is not in the catalog.');
					const slot = firstOpenSpiritSlot(player);
					if (!slot) return failure('slot_missing', 'No open spirit slot is available.');
					player.spirits.push({
						slotIndex: slot,
						id: sp.id,
						name: sp.name,
						cost: sp.cost,
						classes: sp.classes,
						origins: sp.origins,
						isFaceDown: grant.faceDown
					});
					player.spirits.sort((a, b) => a.slotIndex - b.slotIndex);
					log.push(`Debug: added ${sp.name}${grant.faceDown ? ' (face-down)' : ''}.`);
					break;
				}
				case 'rune': {
					const r = catalog.mats.find((x) => x.id === grant.runeId);
					if (!r) return failure('rune_missing', 'That rune is not in the catalog.');
					const slot = (player.mats.at(-1)?.slotIndex ?? 0) + 1;
					player.mats.push({
						slotIndex: slot,
						hasRune: true,
						id: r.id,
						name: r.name,
						originId: r.originId ?? undefined
					});
					log.push(`Debug: added ${r.name}.`);
					break;
				}
				case 'status': {
					const level = Math.max(0, Math.min(STATUS_LADDER.length - 1, grant.level));
					player.statusLevel = level;
					player.statusToken = STATUS_LADDER[level];
					log.push(`Debug: set status to ${STATUS_LADDER[level]}.`);
					break;
				}
				case 'fullHeal': {
					player.brokenBarrier = 0;
					syncBarrierFromBrokenBarrier(player);
					log.push('Debug: barrier restored to full.');
					break;
				}
			}

			// A granted rune may make a face-down spirit awakenable; a granted face-down
			// spirit adds an offer. Keep the cleanup offers consistent either way.
			recomputeAwakenEligibility(state, catalog);
			player.lastAction = { key: 'debug', label: 'Debug grant', log };
			return success(state);
		}

		// ── Location actions (P1) ─────────────────────────────────────────
		case 'resolveLocationInteraction': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'location') {
				return failure('wrong_phase', 'Location interactions happen during the Location phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can act at a location.');
			const player = active.player;
			if (player.pendingDraw || player.handDraws.length > 0) {
				return failure('draw_pending', 'Resolve your drawn spirits first.');
			}
			const destination = player.navigationDestination;
			if (!destination) return failure('no_location', 'You are not at a location yet.');
			// The Arcane Abyss now carries one permanent location action — a free Arcane
			// Abyss Summon — alongside the monster fight, so it resolves like any other.

			const locEntry = (catalog.locations ?? []).find((l) => l.name === destination);
			const interactions = buildLocationInteractions(locEntry?.rewardRows);
			const interaction = interactions.find((i) => i.rowIndex === command.rowIndex);
			if (!interaction) {
				return failure('no_interaction', 'That location has no such interaction.');
			}

			// Each reward row is normally once per round. Child Prodigy ("do ALL location interactions
			// up to two times") raises the per-row allowance via extraActions['locationInteraction'],
			// exactly like Ironmane raises the combat allowance — count how many times THIS row has
			// already run and reject only once the allowance is spent.
			const usedKey = `row:${command.rowIndex}`;
			const rowAllowance = 1 + (player.extraActions?.locationInteraction ?? 0);
			const rowUsed = player.actionsUsedThisRound.filter((a) => a === usedKey).length;
			if (rowUsed >= rowAllowance) {
				return failure(
					'action_used',
					'You already resolved that interaction the maximum times this round.'
				);
			}

			const log: string[] = [];
			let tradedRunes = 0;
			let tradedRelics = 0;

			// Pay the cost first (trade rows). Reject if the runes aren't there — UNLESS
			// a cost waiver applies. Two classes make a trade free in the same way (the
			// trade-cost step simply skips consuming the cost):
			//   • Mod Injector — any Spirit-Augment trade is free while awakened.
			//   • Undercover — the player's next rune→relic trade is free (one-shot flag).
			if (interaction.cost.length > 0) {
				const counts = awakenedClassCounts(player);
				// Resolve what this trade actually grants — honoring an "or" (chooseRune)
				// gain's selected option — so the waiver matches the chosen item, not just
				// a direct rune gain. (Cyber City's augment trade is an "or" of two augments.)
				let grantsAugment = false;
				let grantsRelic = false;
				let waiverChoiceCursor = 0;
				for (const g of interaction.gains) {
					if (g.type === 'rune') {
						if (g.rune.type === 'augment') grantsAugment = true;
						if (g.rune.type === 'relic') grantsRelic = true;
					} else if (g.type === 'chooseRune') {
						const idx = command.choices?.[waiverChoiceCursor] ?? 0;
						waiverChoiceCursor += 1;
						const chosen = g.options[idx] ?? g.options[0];
						if (chosen?.type === 'augment') grantsAugment = true;
						if (chosen?.type === 'relic') grantsRelic = true;
					}
				}
				const modInjectorFree = (counts['Mod Injector'] ?? 0) >= 1 && grantsAugment;
				const undercoverFree = player.freeNextRelicTrade && grantsRelic;

				if (modInjectorFree) {
					log.push('Mod Injector — this Spirit Augment trade is free.');
				} else if (undercoverFree) {
					log.push('Undercover — this trade is free.');
					player.freeNextRelicTrade = false; // one-shot
					// "…then discard this spirit." The Undercover spirit(s) stayed on the
					// board until the free trade was spent — discard them now (return to bag,
					// drop attachments), mirroring the discardSpirit command.
					const undercovers = player.spirits.filter(
						(s) => !s.isFaceDown && (s.classes?.Undercover ?? 0) > 0
					);
					for (const u of undercovers) {
						player.spirits = player.spirits.filter((s) => s.slotIndex !== u.slotIndex);
						player.spiritAugmentAttachments = (player.spiritAugmentAttachments ?? []).filter(
							(a) => a.spiritSlotIndex !== u.slotIndex
						);
						const sourceBag =
							bagForSpiritCost(u.cost) ?? (u.isFaceDown ? ARCANE_ABYSS_BAG : SPIRIT_WORLD_BAG);
						const bag = runtimeBagForSource(state, sourceBag);
						bag.contents.push({
							name: u.name,
							guid: nextId(state.rng, 'discard'),
							id: u.id,
							cost: u.cost
						});
						shuffleBag(bag.contents, state.rng);
						bag.count = bag.contents.length;
						log.push(`${u.name} went undercover and was discarded.`);
					}
					if (undercovers.length > 0) {
						state.bags.history = buildHistoryBags(state.bags);
						const vpSettled = settleUnpayableCorruptionDebt(player);
						if (vpSettled > 0)
							log.push(
								`No spirits left for the corruption sacrifice — lost ${vpSettled} VP instead.`
							);
					}
				} else {
					// `costChoices` lets the player pick WHICH held slot to discard for a
					// wildcard cost; specific costs and missing picks fall back to auto-pick.
					const matched = matchRewardCost(interaction.cost, player.mats, command.costChoices);
					if (!matched.ok) {
						return failure('cannot_afford', 'You cannot pay the cost for that interaction.');
					}
					const paid: string[] = [];
					for (const arrayIndex of matched.consumedArrayIndexes) {
						const slot = player.mats[arrayIndex];
						if (slot) {
							slot.hasRune = false;
							paid.push(slot.name ?? 'rune');
							// Classify what was given up so the trade hook can react (Rune Mage).
							if (slot.type === 'relic') tradedRelics += 1;
							else tradedRunes += 1;
						}
					}
					if (paid.length) log.push(`Paid ${paid.join(', ')}.`);
				}
			}

			// Apply the gains in order. "or" gains consume the next `choices` entry.
			// Repeated Cultivate/Rest tokens in one row collapse so their class triggers
			// fire ONCE each (neither action has an inherent per-token effect): Cultivate
			// fires onCultivate once, Rest fires onRest once. Summons stay per-token (each
			// draws separately, possibly queued).
			let choiceCursor = 0;
			let cultivateTokens = 0;
			let restTokens = 0;
			for (const gain of interaction.gains) {
				switch (gain.type) {
					case 'action': {
						if (gain.action === 'spiritWorldSummon') {
							queueOrBeginDraw(state, player, SPIRIT_WORLD_BAG);
							log.push('Summon from the Spirit World — draw 4, summon up to 2.');
						} else if (gain.action === 'abyssSummon') {
							queueOrBeginDraw(state, player, ARCANE_ABYSS_BAG);
							log.push('Summon from the Arcane Abyss — draw 3, summon up to 1.');
						} else if (gain.action === 'cultivate') {
							cultivateTokens += 1;
						} else {
							restTokens += 1;
						}
						break;
					}
					case 'restoreBarrier': {
						// Restore barrier: flip broken-barrier tokens back to the intact side
						// (capacity is unchanged — max barrier grows only via class effects).
						const before = player.barrier;
						player.barrier = Math.min(player.maxBarrier, player.barrier + gain.amount);
						player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
						log.push(`Restored ${player.barrier - before} barrier.`);
						break;
					}
					case 'vp': {
						// Locations have no VP rewards today, but the shared GainEffect can
						// carry one — grant it directly so the union stays exhaustive.
						player.victoryPoints += gain.amount;
						log.push(`Gained ${gain.amount} Victory Point${gain.amount === 1 ? '' : 's'}.`);
						break;
					}
					case 'rune': {
						addGainedRune(player, gain.rune);
						log.push(`Gained ${gain.rune.name}.`);
						break;
					}
					case 'chooseRune': {
						const choiceIndex = command.choices?.[choiceCursor] ?? 0;
						choiceCursor += 1;
						const chosen = gain.options[choiceIndex] ?? gain.options[0];
						if (chosen) {
							addGainedRune(player, chosen);
							log.push(`Gained ${chosen.name}.`);
						}
						break;
					}
				}
			}

			// Collapse repeated Cultivate and Rest into one trigger fire each (neither
			// has an inherent per-token effect; their payoff is class-driven).
			if (cultivateTokens > 0) {
				applyCultivate(state, active.seatColor, log, { catalog });
			}
			if (restTokens > 0) {
				applyTrigger(state, active.seatColor, 'onRest', log, { catalog });
				// Rest-time awaken progress (Meteor Shower: "Rest with 10 Max Barrier").
				recordRestAwakenProgress(player);
				log.push('Rested.');
			}

			// A trade just happened — fire the location-interaction hook carrying what
			// was given up (Rune Mage: +1 Enchanted per rune traded, +1 Exalted per relic).
			if (tradedRunes > 0 || tradedRelics > 0) {
				applyTrigger(state, active.seatColor, 'onLocationInteraction', log, {
					catalog,
					trade: { runes: tradedRunes, relics: tradedRelics }
				});
			}

			player.actionsUsedThisRound.push(usedKey);
			player.lastAction = {
				key: 'reward',
				label: interaction.kind === 'trade' ? 'Trade' : 'Gain',
				log: log.length ? log : ['Resolved a location reward.']
			};
			return success(state);
		}

		case 'startCombat': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'location')
				return failure('wrong_phase', 'Combat happens during the Location phase.');
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can fight.');
			if (active.player.navigationDestination !== 'Arcane Abyss') {
				return failure('not_in_abyss', 'You must be at the Arcane Abyss to fight the monster.');
			}
			if (!state.monster) return failure('no_monster', 'There is no monster to fight.');
			// Combat is once per round, but a class that grants extra combat actions
			// (Ironmane: "initiate Monster Combat two times") raises the allowance via
			// extraActions['combat']. The base allowance is 1; each prior use consumes
			// one, and an extra-action credit lets the player exceed the base limit.
			const combatsUsed = active.player.actionsUsedThisRound.filter((a) => a === 'combat').length;
			const combatAllowance = 1 + (active.player.extraActions?.combat ?? 0);
			if (combatsUsed >= combatAllowance) {
				return failure('action_used', 'You have no monster-combat actions left this round.');
			}
			const result = fightMonster(state, active.seatColor, catalog);
			if (!result) return failure('combat_failed', 'Combat could not be resolved.');
			active.player.actionsUsedThisRound.push('combat');
			// Replace any prior combat entry for this seat with the fresh result.
			state.combats = state.combats.filter((entry) => entry.sides[0]?.seat !== active.seatColor);
			state.combats.push({
				id: nextId(state.rng, 'combat'),
				kind: 'monster',
				step: 'resolved',
				killed: result.killed,
				sides: [
					{ seat: active.seatColor, initiative: 0, rolled: true, damageDealt: result.playerDamage }
				],
				// The monster AS FOUGHT (a kill has already advanced state.monster to the
				// next rung), so the combat card shows what was actually battled.
				monster: result.fought ?? null,
				log: result.log
			});
			// Defeating the monster opens a reward selection: the player claims up to
			// `chooseAmount` tokens from the DEFEATED monster's reward track (capped at the
			// resolvable count). This blocks ending the Location phase until claimed.
			if (result.killed && result.fought) {
				const claim = rewardClaimCount(result.fought.rewardTrack, result.fought.chooseAmount);
				if (claim > 0) {
					active.player.pendingReward = {
						monsterId: result.fought.id,
						monsterName: result.fought.name,
						rewardTrack: [...result.fought.rewardTrack],
						chooseAmount: claim
					};
				}
			}
			return success(state);
		}

		case 'resolveMonsterReward': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'location') {
				return failure('wrong_phase', 'Monster rewards are claimed during the Location phase.');
			}
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can claim rewards.');
			const player = active.player;
			const pending = player.pendingReward;
			if (!pending) return failure('no_reward', 'You have no monster rewards to claim.');

			const options = buildMonsterRewards(pending.rewardTrack);
			const byIndex = new Map(options.map((o) => [o.index, o]));
			// Dedupe + validate the picked token indices against the resolvable pool.
			const picks: number[] = [];
			for (const idx of command.picks ?? []) {
				if (byIndex.has(idx) && !picks.includes(idx)) picks.push(idx);
			}
			if (picks.length === 0) return failure('no_picks', 'Select at least one reward to claim.');
			if (picks.length > pending.chooseAmount) {
				return failure(
					'too_many',
					`You may claim only ${pending.chooseAmount} reward${pending.chooseAmount === 1 ? '' : 's'}.`
				);
			}

			const log: string[] = [];
			// `choices` aligns to the picked options that are rune CHOICES, in pick order.
			let choiceCursor = 0;
			for (const idx of picks) {
				const opt = byIndex.get(idx)!;
				const choice =
					opt.effect.type === 'chooseRune' ? (command.choices?.[choiceCursor++] ?? 0) : 0;
				applyRewardGain(state, active.seatColor, player, opt.effect, choice, log, catalog);
			}

			player.pendingReward = null;
			player.lastAction = {
				key: 'reward',
				label: `${pending.monsterName} rewards`,
				log: log.length ? log : ['Claimed monster rewards.']
			};
			return success(state);
		}

		// ── Encounter / PvP (P2) ──────────────────────────────────────────
		case 'passEncounter': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'encounter')
				return failure('wrong_phase', 'There is no encounter to resolve.');
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can act.');
			active.player.phaseReady = true;
			// An Evil aggressor passing is a DECLINE vote — the group attack needs every
			// co-located Evil player to agree, so one decline cancels it for that location.
			if (
				isEvilAlignment(active.player.statusLevel) &&
				encounterGoodTargets(state, active.seatColor).length > 0
			) {
				active.player.encounterVote = 'decline';
				resolveEncounterLocationIfReady(state, catalog, active.player.navigationDestination);
			}
			tryAdvanceFromEncounter(state);
			return success(state);
		}

		case 'initiatePvp': {
			if (state.status !== 'active') return failure('inactive', 'The game has not started yet.');
			if (state.phase !== 'encounter')
				return failure('wrong_phase', 'PvP only happens in the Encounter phase.');
			const active = activePlayerForActor(state, actor);
			if (!active) return failure('seat_required', 'Only seated players can initiate combat.');
			if (!isEvilAlignment(active.player.statusLevel)) {
				return failure('not_evil', 'Only Evil-aligned players may initiate combat.');
			}
			if (encounterGoodTargets(state, active.seatColor).length === 0) {
				return failure('no_targets', 'There are no Good players at your location to attack.');
			}
			// Cast this aggressor's ATTACK vote. The group strike fires only once EVERY
			// co-located Evil player has voted to attack (unanimous); a single decline
			// (passEncounter) cancels it. resolveEncounterLocationIfReady runs the combat
			// when the location's vote is complete and unanimous.
			active.player.encounterVote = 'attack';
			active.player.phaseReady = true;
			resolveEncounterLocationIfReady(state, catalog, active.player.navigationDestination);
			tryAdvanceFromEncounter(state);
			return success(state);
		}

		default:
			return failure('unsupported_command', `${command.type} is not implemented yet.`);
	}
}

/** Good (non-Evil) seats sharing `seat`'s non-Abyss destination — its PvP targets. */
function encounterGoodTargets(state: PublicGameState, seat: SeatColor): SeatColor[] {
	const dest = state.players[seat]?.navigationDestination ?? null;
	if (!dest || dest === 'Arcane Abyss') return [];
	return state.activeSeats.filter(
		(s) =>
			s !== seat &&
			state.players[s]?.navigationDestination === dest &&
			!isEvilAlignment(state.players[s]?.statusLevel ?? 0)
	);
}

/** Evil aggressors at `dest`: Fallen players sharing the (non-Abyss) location with ≥1 Good. */
function encounterEvilAggressorsAt(state: PublicGameState, dest: string | null): SeatColor[] {
	if (!dest || dest === 'Arcane Abyss') return [];
	const hasGood = state.activeSeats.some(
		(s) =>
			state.players[s]?.navigationDestination === dest &&
			!isEvilAlignment(state.players[s]?.statusLevel ?? 0)
	);
	if (!hasGood) return [];
	return state.activeSeats.filter(
		(s) =>
			state.players[s]?.navigationDestination === dest &&
			isEvilAlignment(state.players[s]?.statusLevel ?? 0)
	);
}

/**
 * Resolve the group Encounter at `dest` once every Evil aggressor there has voted.
 * Unanimous `'attack'` → run the group combat (+3 VP and awaken progress per Evil
 * attacker); any `'decline'` → no combat. Idempotent: a PvP combat already recorded
 * for these seats this round short-circuits, so it never resolves twice.
 */
function resolveEncounterLocationIfReady(
	state: PublicGameState,
	catalog: PlayCatalog | undefined,
	dest: string | null
): void {
	const evilSeats = encounterEvilAggressorsAt(state, dest);
	if (evilSeats.length === 0) return;
	// Wait until every aggressor has cast a vote.
	if (evilSeats.some((s) => (state.players[s]?.encounterVote ?? null) === null)) return;
	// Idempotency: don't re-resolve a group that already fought this round.
	const already = state.combats.some(
		(c) => c.kind === 'pvp' && c.sides.some((side) => evilSeats.includes(side.seat))
	);
	if (already) return;
	// Unanimous attack required; a single decline cancels the strike.
	if (!evilSeats.every((s) => state.players[s]?.encounterVote === 'attack')) return;
	const goodSeats = state.activeSeats.filter(
		(s) =>
			state.players[s]?.navigationDestination === dest &&
			!isEvilAlignment(state.players[s]?.statusLevel ?? 0)
	);
	if (goodSeats.length === 0) return;

	const combat = resolveEncounterCombat(state, catalog, evilSeats, goodSeats);
	state.combats.push(combat);

	// +3 VP per Evil attacker (a flat, unconditional reward for initiating PvP — no roll/kill
	// needed), plus combat-event awaken progress: Hollow Eyes (Evil side dealt > 3 to a
	// player). (Arcane Huntress is now a cultivate condition, armed in applyCultivate.)
	const evilDamage = combat.sides
		.filter((s) => s.side === 'evil')
		.reduce((sum, s) => sum + s.damageDealt, 0);
	for (const s of evilSeats) {
		const p = state.players[s];
		if (!p) continue;
		p.victoryPoints += 3;
		p.awakenProgress ??= {};
		if (evilDamage > 3) p.awakenProgress[AWAKEN_PROGRESS_KEYS.hollowEyes] = true;
	}
}

/** Group a bag's contents by spirit (hiding draw order) for the bag viewer. */
function summarizeBagSpirits(contents: RuntimeBagEntry[]): BagSpiritSummary[] {
	const byId = new Map<string, BagSpiritSummary>();
	for (const entry of contents) {
		if (!entry.id) continue;
		const existing = byId.get(entry.id);
		if (existing) existing.count += 1;
		else byId.set(entry.id, { id: entry.id, name: entry.name, cost: entry.cost ?? 0, count: 1 });
	}
	return [...byId.values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
}

export function buildSessionProjection(
	rawState: PublicGameState,
	viewer: SpectatorProjection['viewer']
): SpectatorProjection {
	const state = ensureStateShape(rawState);
	const players: Partial<Record<SeatColor, PlayerProjection>> = {};

	for (const seatColor of state.activeSeats) {
		const player = state.players[seatColor];
		if (!player) continue;
		ensurePlayerCollections(player);
		const isOwner = viewer.seatColor === seatColor;

		players[seatColor] = {
			...player,
			handDraws: isOwner ? player.handDraws : [],
			pendingDraw: isOwner ? player.pendingDraw : null,
			pendingReward: isOwner ? player.pendingReward : null,
			pendingAwakenReward: isOwner ? player.pendingAwakenReward : null,
			// The corruption-discard obligation is the owner's private business; other
			// seats only see the resulting (already-trimmed) tableau, never the debt.
			pendingCorruptionDiscard: isOwner ? (player.pendingCorruptionDiscard ?? null) : null,
			// A player's secret destination + personal prompts are theirs alone.
			pendingDestination: isOwner ? player.pendingDestination : null,
			manualPrompts: isOwner ? player.manualPrompts : [],
			pendingDecisions: isOwner ? player.pendingDecisions : [],
			lastAction: isOwner ? player.lastAction : null,
			// Augments-to-place are the owner's private staging pouch; placed augments
			// live in spiritAugmentAttachments and stay visible to everyone.
			unplacedAugments: isOwner ? (player.unplacedAugments ?? []) : []
		};
	}

	return {
		roomCode: state.roomCode,
		revision: state.revision,
		status: state.status,
		gameId: state.gameId,
		round: state.round,
		guardianPool: [...state.guardianPool],
		viewer,
		seats: structuredClone(state.seats),
		activeSeats: [...state.activeSeats],
		market: state.market.map((slot) => ({ ...slot })),
		players,
		bagCounts: {
			hexSpirits: state.bags.hexSpirits.count,
			monsters: state.bags.monsters.count,
			abyssFallen: state.bags.abyssFallen.count,
			stageDeck: state.bags.stageDeck.count
		},
		bagSpirits: {
			spiritWorld: summarizeBagSpirits(state.bags.hexSpirits.contents),
			arcaneAbyss: summarizeBagSpirits(state.bags.abyssFallen.contents)
		},
		phase: state.phase,
		navigation: { ...state.navigation },
		revealedDestinations: state.revealedDestinations,
		navigationDurationMs: state.navigationDurationMs,
		navigationDeadline: state.navigationDeadline,
		navigationFullDeadline: state.navigationFullDeadline,
		phaseDeadline: state.phaseDeadline,
		locationOccupancy: structuredClone(state.locationOccupancy),
		monster: state.monster ? { ...state.monster } : null,
		combats: structuredClone(state.combats),
		winnerSeat: state.winnerSeat
	};
}

export function buildHistorySnapshotRows(
	state: PublicGameState,
	timestamp: string
): HistorySnapshotRow[] {
	if (!state.gameId) {
		return [];
	}

	return [...state.activeSeats]
		.sort((a, b) => a.localeCompare(b))
		.map((seatColor) => {
			const player = state.players[seatColor];
			if (!player) {
				throw new Error(`Missing player state for seat ${seatColor}`);
			}

			return {
				game_id: state.gameId!,
				navigation_count: state.round,
				game_timestamp: timestamp,
				player_color: seatColor,
				tts_username: player.displayName,
				navigation_destination: player.navigationDestination,
				selected_character: player.selectedGuardian,
				blood: player.brokenBarrier,
				victory_points: player.victoryPoints,
				barrier: player.barrier,
				max_tokens: player.maxBarrier,
				status_level: player.statusLevel,
				status_token: player.statusToken,
				spirits: player.spirits,
				mats: player.mats,
				spirit_augment_attachments: player.spiritAugmentAttachments,
				hand_draws: player.handDraws,
				bags: state.bags.history,
				scenario: state.scenario
			};
		});
}
