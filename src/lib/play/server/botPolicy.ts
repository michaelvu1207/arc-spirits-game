/**
 * Pure, unit-testable bot policy for the dev "fill the empty seats" feature.
 *
 * A bot fills a seat in a live game and takes RANDOM LEGAL actions, becoming
 * "ready" each phase so the round loop advances while a human plays. The policy
 * is intentionally dumb: it never tries to win, never forces VP, and never
 * mutates the win target. It only nudges its own seat from "not ready" to
 * "ready/locked" for the CURRENT phase, picking randomly among legal options.
 *
 * Everything here is a pure function of (state, seat, catalog). Each candidate
 * command is trial-applied against a clone via `applyGameCommand`; only commands
 * that come back `ok` are emitted, so we can never produce an illegal command.
 */

import { applyGameCommand, applyDeadlineAdvance } from '../runtime';
import { canApply } from '../legality';
import { createRng, nextInt, type RngState } from '../rng';
import { getLocationConfig } from '../locations';
import { augmentCapacityForSpirit } from '../augments';
import {
	buildLocationInteractions,
	canAfford,
	type LocationInteraction,
	type RewardActionKind,
	type ResolvedRune
} from '../locationInteractions';
import { buildMonsterRewards } from '../monsterRewards';
import { DICE_TIER_FACES, resetCombatFlags } from '../combat';
import { applyTrigger, awakenedClassCounts } from '../effects/apply';
import {
	ALL_DESTINATIONS,
	SPIRIT_WORLD_ONLY,
	RUNE_CARRY_LIMIT,
	MAX_ATTACK_DICE,
	spiritLimitFor,
	type AttackDie,
	type GameActor,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PlayCatalogSpirit,
	type PublicGameState,
	type SeatColor
} from '../types';

/**
 * Minimal RNG surface so callers can pass either the deterministic engine RNG
 * (rng.ts `nextInt`) or any `() => number` style source. Kept tiny on purpose.
 */
export interface BotRandom {
	/** Integer in [0, maxExclusive). */
	int(maxExclusive: number): number;
	/** Coin flip — true with probability ~0.5. */
	chance(): boolean;
}

/** Default RNG backed by Math.random (fine for a dev tool). */
export function defaultBotRandom(): BotRandom {
	return {
		int: (maxExclusive: number) =>
			maxExclusive <= 0 ? 0 : Math.floor(Math.random() * maxExclusive),
		chance: () => Math.random() < 0.5
	};
}

/** Pick a uniformly-random element, or null for an empty list. */
function pick<T>(rng: BotRandom, items: readonly T[]): T | null {
	if (items.length === 0) return null;
	return items[rng.int(items.length)] ?? null;
}

/** Build the synthetic actor a bot uses to issue commands for its seat. */
export function botActorFor(state: PublicGameState, seat: SeatColor): GameActor {
	const memberId = state.seats[seat]?.memberId ?? `bot-${seat}`;
	const displayName = state.seats[seat]?.displayName ?? `Bot ${seat}`;
	return { memberId, displayName, role: 'player', seatColor: seat };
}

/** Trial-apply a command against a clone; true iff the reducer accepts it. */
function isLegal(
	state: PublicGameState,
	seat: SeatColor,
	command: GameCommand,
	catalog: PlayCatalog
): boolean {
	// Fast path: the pure legality oracle decides ~99.7% of probes with NO clone (differential-tested
	// vs the reducer in ml/_canApply.test.ts — it can only DEFER, never disagree). Only `undefined`
	// (the genuinely impure cases: combat / awaken-condition / augment-placement acceptance) falls
	// back to the cloning reducer, which isLegal reads only for `.ok` (the result state is discarded).
	const actor = botActorFor(state, seat);
	const verdict = canApply(state, actor, command, catalog);
	return verdict !== undefined ? verdict : applyGameCommand(state, actor, command, catalog).ok;
}

/**
 * Advance an OWNED working state by `command`, clone-free whenever the pure oracle can decide it.
 * Returns the advanced state (the SAME object when mutated) or `null` if the command is illegal.
 *
 * Safety: we only ever apply IN PLACE (`mutate: true`) when `canApply` PROVES the command legal —
 * a proven-legal command cannot mutate-then-reject, so `working` is never left half-mutated.
 * Provably-illegal commands are skipped without touching `working`; `undefined` (the rare impure
 * cases) defers to the cloning reducer, which leaves `working` pristine on rejection. The result is
 * byte-identical to the all-cloning path (same commands, same evolved state) — gated by the gen
 * determinism hash + sim/_parity.test.ts. `working` MUST be a state the caller owns (e.g. a clone),
 * never the caller's live input.
 */
function advanceWorking(
	working: PublicGameState,
	seat: SeatColor,
	command: GameCommand,
	catalog: PlayCatalog
): PublicGameState | null {
	const actor = botActorFor(working, seat);
	const verdict = canApply(working, actor, command, catalog);
	if (verdict === false) return null;
	if (verdict === true) {
		const r = applyGameCommand(working, actor, command, catalog, { mutate: true });
		return r.ok ? r.state : null; // r.ok always true when canApply===true (differential-tested)
	}
	const r = applyGameCommand(working, actor, command, catalog); // undefined → clone oracle (pristine on reject)
	return r.ok ? r.state : null;
}

/**
 * Does this seat still need to act this phase? A seat is "done" when its
 * phaseReady flag is set (encounter / location / cleanup) or — for navigation —
 * once its destination is locked.
 */
export function botSeatNeedsToAct(state: PublicGameState, seat: SeatColor): boolean {
	if (state.status !== 'active') return false;
	const player = state.players[seat];
	if (!player) return false;

	switch (state.phase) {
		case 'navigation':
			return state.navigation[seat]?.locked !== true;
		case 'encounter':
		case 'location':
		case 'benefits':
		case 'awakening':
		case 'cleanup':
			return player.phaseReady !== true;
		default:
			return false;
	}
}

/** Whether this Evil seat may launch a group attack on the Good players it shares a location with. */
function canInitiatePvp(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): boolean {
	return isLegal(state, seat, { type: 'initiatePvp' }, catalog);
}

/**
 * Choose a Spirit-World destination: the first legal one (default — all heuristic bots cluster
 * here), or a RANDOM legal one when `profile.spreadSpiritWorld` is set (the co-location
 * robustness counterfactual). Returns undefined when no Spirit-World location is legal.
 */
function chooseSpiritWorld(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profile: BotProfile,
	rng: BotRandom
): NavigationDestination | undefined {
	const legal = (SPIRIT_WORLD_ONLY as readonly NavigationDestination[]).filter((d) =>
		isLegal(state, seat, { type: 'lockNavigation', destination: d }, catalog)
	);
	if (legal.length === 0) return undefined;
	if (profile.spreadSpiritWorld) return pick(rng, legal) ?? legal[0];
	return legal[0];
}

/** The resolved reward-row interactions at a location (from its DB reward rows). A location's
 *  available actions ARE these rows — there are no generic always-available actions. */
function locationInteractionsFor(catalog: PlayCatalog, destination: string): LocationInteraction[] {
	const loc = (catalog.locations ?? []).find((l) => l.name === destination);
	return buildLocationInteractions(loc?.rewardRows);
}

/**
 * The Spirit World whose reward rows grant `action` for FREE (a `gain` row). Locations are
 * SPECIALIZED: Cultivate → Lantern Canyon, Rest → Floral Patch, Spirit World Summon → Tidal
 * Cove. Returns null if no location offers it free.
 */
function destinationOfferingAction(
	catalog: PlayCatalog,
	action: RewardActionKind
): NavigationDestination | null {
	for (const d of SPIRIT_WORLD_ONLY as readonly NavigationDestination[]) {
		const rows = locationInteractionsFor(catalog, d);
		if (rows.some((r) => r.kind === 'gain' && r.gains.some((g) => g.type === 'action' && g.action === action)))
			return d;
	}
	return null;
}

/**
 * The Spirit World that SELLS a class augment for one of `classNames` (a chooseRune trade). Class
 * augments live at specific realms — Fighter/Cultivator/Spirit Animal at Tidal Cove, Elementalist
 * /Soul Weaver at Cyber City — and are a DETERMINISTIC way to push a class count PAST what the
 * shared spirit pool yields, up to a steep breakpoint. (Unlike praying for draws, buying an augment
 * is reliable, so committing relics to it is not the luck-based force-stacking we avoid for spirits.)
 */
function destinationOfferingAugment(
	catalog: PlayCatalog,
	classNames: readonly string[]
): NavigationDestination | null {
	const ids = new Set(catalog.classes.filter((c) => classNames.includes(c.name)).map((c) => c.id));
	for (const d of SPIRIT_WORLD_ONLY as readonly NavigationDestination[]) {
		const rows = locationInteractionsFor(catalog, d);
		if (
			rows.some((r) =>
				r.gains.some((g) => g.type === 'chooseRune' && g.options.some((o) => o.classId && ids.has(o.classId)))
			)
		)
			return d;
	}
	return null;
}

/** Is there an awakened spirit with a free augment slot to host another class augment? Mirrors the
 *  placeAugments target search — used to avoid buying an augment we couldn't place (never unplaced). */
function hasAugmentCapacity(player: BotPlayer): boolean {
	return player.spirits.some((s) => {
		if (s.isFaceDown) return false;
		const placed = (player.spiritAugmentAttachments ?? []).filter(
			(a) => a.spiritSlotIndex === s.slotIndex && typeof a.className === 'string'
		).length;
		return placed < augmentCapacityForSpirit(s);
	});
}

/**
 * Should the bot detour to Cyber City to BUY an Elementalist augment? Only when it's worth crossing
 * a steep upgrade breakpoint it can't otherwise reach: dice are still upgradable, the Elementalist
 * count is adjacent to a big jump (3→4 lifts the Rest from 2→5 dice, 4→5 from 5→10), and it holds a
 * relic to pay AND an awakened spirit to host the augment. This is the DETERMINISTIC path past the
 * ~3 Elementalists the spirit pool yields — the only way the super-linear curve actually pays off.
 */
function wantsElementalistAugment(player: BotPlayer, profile: BotProfile): boolean {
	if (profile.pursuePvp || profile.pursueCorruption) return false;
	if (!player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted')) return false;
	const c = awakenedClassCounts(player)['Elementalist'] ?? 0;
	// Augment 1→2→3→4→5 toward the steep breakpoints. Crucially fires at count 1: a lone Elementalist
	// upgrades NOTHING on the super-linear curve (breakpoint starts at 2), so a bot stuck at count 1
	// with a basic-dice pool + a relic must be able to buy its way to count 2 — else it deadlocks,
	// resting forever on 10 un-upgradable basic dice (the exact 100-round jam seen at hp4).
	if (c < 1 || c >= 5) return false;
	if (!player.mats.some((r) => r.hasRune && r.type === 'relic')) return false; // can pay the trade
	return hasAugmentCapacity(player);
}

/**
 * Is the build's ENGINE still missing pieces it should summon before grinding? Assembling the
 * whole engine first — sustain, enough Cultivators for the max barrier rate, Fighters for dice, and
 * (the lever that decides game length) enough ELEMENTALISTS so the basic→exalted upgrade runs at N
 * dice/rest instead of dragging at 1/rest — beats settling into a Rest grind with one Elementalist
 * and never coming back for more. Two summon rounds that triple upgrade throughput pay for
 * themselves many times over. Pure read of awakened class counts vs the profile's targets.
 */
function teamIncomplete(player: BotPlayer, profile: BotProfile, counts: Record<string, number>): boolean {
	// PvP/corruption builds assemble their own core (Cursed/Sharpshooter) via their own logic.
	if (profile.pursuePvp || profile.pursueCorruption) return false;
	// Is there a slot to actually receive a recruit (a free slot, or spent dead weight to cull)?
	// Every clause is gated on this so the rule can NEVER loop summoning toward an unreachable count.
	const room =
		player.spirits.length < spiritLimitFor(player.statusLevel) ||
		player.spirits.some((s) => !s.isFaceDown && keepValue(s, player, profile, null) <= 1);
	if (!room) return false;
	// 1. Sustain: get the one Healer before climbing (it's a hard climb prerequisite). Cheap, and the
	//    recruit scorer ranks it top, so this just spends summon rounds finding it rather than resting
	//    on without it.
	if (!hasSustain(player) && (counts['Healer'] ?? 0) < HEALER_WANTED) return true;
	// 2. Upgrade throughput — the dominant game-length lever. Stack Elementalists toward target
	//    WHILE the dice are still being built or remain upgradable (NOT only after the cap): on the
	//    super-linear curve count 4-5 upgrades 5-10 dice/Rest, so reaching it BEFORE the dice exist
	//    means one Rest converts the whole pool — vs grinding 1-2/Rest if stacked late (the ~16-round
	//    sink the gap-analysis flagged). Cyber-City augments (wantsElementalistAugment) top it to 4-5.
	// Fighters are the dice FOUNDATION — get 2+ before anything else dice-related (you need 2 to Rest
	// productively). Elementalists are useless without a dice pool to upgrade, so DON'T over-summon
	// them first (that slot-starves the Fighters → 0 dice → a Tidal deadlock).
	// Stack Fighters toward the super-linear breakpoint BEFORE the dice grind: at 2 Fighters a Rest
	// adds just 1 die (a ~9-Rest grind to fill the cap); at 4-5 it adds 5-10 (1-2 Rests). Two extra
	// summon rounds to reach the breakpoint save ~7 Rest rounds — the single biggest build-variance win.
	if (!atDiceCap(player, profile) && (counts['Fighter'] ?? 0) < FIGHTER_SOFT_CAP) return true;
	// Elementalists ONLY once there are dice to upgrade (then stack toward target for fast quality).
	const hasUpg = player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
	if (hasUpg && (counts['Elementalist'] ?? 0) < (profile.elementalistTarget ?? ELEMENTALIST_WANTED)) return true;
	return false;
}

/** The Spirit World whose reward rows grant an Arcane-Abyss summon (Cyber City: relic → abyssSummon).
 *  Deterministic access to the Abyss bag, where the arcane sources + action-economy spirits live. */
function destinationOfferingAbyssSummon(catalog: PlayCatalog): NavigationDestination | null {
	for (const d of SPIRIT_WORLD_ONLY as readonly NavigationDestination[]) {
		const rows = locationInteractionsFor(catalog, d);
		if (rows.some((r) => r.gains.some((g) => g.type === 'action' && g.action === 'abyssSummon'))) return d;
	}
	return null;
}

/** Should the bot detour to fish the Arcane Abyss bag for an ARCANE source? Only once the core
 *  build is done (dice exalted, max barrier maxed, sustain) but it still lacks arcane — Dragon Warrior
 *  (+3 arcane on awaken) / Arcane Advisor (exalted→arcane on rest) are the ~16+ damage the hp14 boss
 *  one-shot needs that a 10-exalted pool (mean 10) + scarce Spirit Animals can't reach. ~4 arcane
 *  sources in the 37-card bag → a few Cyber visits find one. Gated on pursueArcane + a relic to pay
 *  + no pending arcane recruit, so it neither over-fishes nor blocks the core build. */
function wantsArcaneFish(player: BotPlayer, profile: BotProfile): boolean {
	if (!profile.pursueArcane) return false;
	if (!atDiceCap(player, profile)) return false;
	if (player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted')) return false;
	if (player.maxBarrier < profile.maxBarrierTarget) return false;
	if (!hasSustain(player) && !canRestoreBarrierViaEconomy(player)) return false;
	if (hasArcaneSource(player)) return false;
	if (player.pendingDraw || player.spirits.some((sp) => sp.isFaceDown)) return false; // pending recruit already
	if (!player.mats.some((r) => r.hasRune && r.type === 'relic')) return false; // can pay the trade
	return true;
}

/**
 * Should the bot fish the Arcane Abyss bag NOW — for a CLIMB-COMPRESSOR (Aquamaiden/Golem/Firekeeper/
 * Guardian damage-mitigation, or Dark Assassin's damage-double) or, for pursueArcane builds, an arcane
 * source? These cost-7-9 spirits are the levers that collapse the ~17-round climb (mitigation lets
 * barrier survive two top-rung hits → far fewer restore-barrier rounds; Dark Assassin one-shots the boss). Unlike
 * wantsArcaneFish (late, post-cap, arcane-only) this fires EARLIER — once a real dice pool has started
 * (≥4 dice) — so the compressor is awakened BEFORE the hard rungs. Gated on: a relic to pay the Cyber
 * City "relic → abyssSummon" trade, no recruit already pending (so it never stacks unawakened fishes),
 * and room (a free slot or cullable dead weight) so the keep can actually be placed.
 */
function wantsAbyssFish(player: BotPlayer, profile: BotProfile): boolean {
	if (profile.pursuePvp || profile.pursueCorruption) return false;
	if (player.pendingDraw || player.spirits.some((sp) => sp.isFaceDown)) return false;
	if (!player.mats.some((r) => r.hasRune && r.type === 'relic')) return false;
	const room =
		player.spirits.length < spiritLimitFor(player.statusLevel) ||
		player.spirits.some((s) => !s.isFaceDown && keepValue(s, player, profile, null) <= 1);
	if (!room) return false;
	// The climb-compressor lever: fish once the dice pool has started, until we own a compressor.
	if (player.attackDice.length >= 4 && !hasClimbCompressor(player)) return true;
	// The arcane lever (pursueArcane only): defer to the stricter, post-core wantsArcaneFish.
	return wantsArcaneFish(player, profile);
}

/**
 * Pick the ONE specialized Spirit World to visit this round (you only get one build action per
 * round now that a location's actions are its reward rows). Priority: SUMMON to finish assembling
 * the engine (sustain + Cultivators + Fighters + Elementalists) before grinding it → Cultivate
 * (the max barrier gate) while short and actionable → Rest (convert/upgrade pieces into dice, restore barrier)
 * → Summon as the default growth engine and the bootstrap when nothing else is actionable yet.
 */
function chooseBuildDestination(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profile: BotProfile,
	rng: BotRandom
): NavigationDestination | null {
	const player = state.players[seat];
	if (!player) return null;
	const legalDest = (d: NavigationDestination | null): NavigationDestination | null =>
		d && isLegal(state, seat, { type: 'lockNavigation', destination: d }, catalog) ? d : null;

	// 1. Finish summoning the engine BEFORE grinding it (esp. enough Elementalists to upgrade fast).
	if (teamIncomplete(player, profile, awakenedClassCounts(player))) {
		const d = legalDest(destinationOfferingAction(catalog, 'spiritWorldSummon'));
		if (d) return d;
	}
	// 1a. Fish the Arcane Abyss for a COMPRESSOR (Cyber City: relic → abyssSummon) — HIGH priority so a
	//     Fairy relic is reserved for it before augments. Damage-mitigation (Aquamaiden/Golem/Firekeeper
	//     /Guardian) lets barrier survive two top-rung hits → far fewer climb restore-barrier rounds; Dark Assassin
	//     doubles the roll on odd barrier → one-shots the boss. These cost-7-9 spirits collapse the
	//     ~17-round climb, worth far more than an augment. wantsAbyssFish gates on ≥4 dice (core started),
	//     a relic, room, and lacking a compressor, so it fires once mid-build and not again until awakened.
	if (wantsAbyssFish(player, profile)) {
		const d = legalDest(destinationOfferingAbyssSummon(catalog));
		if (d) return d;
	}
	// 1b. Detour to buy an Elementalist augment (Cyber City) to cross a steep upgrade breakpoint the
	//     spirit pool can't reach — turns the basic→exalted Rest grind into 1–2 Rests. Deterministic,
	//     so worth a relic + a round, unlike fishing draws for a 4th/5th Elementalist spirit.
	if (wantsElementalistAugment(player, profile)) {
		const d = legalDest(destinationOfferingAugment(catalog, ['Elementalist']));
		if (d) return d;
	}
	// 2. Cultivate while max barrier is short and actionable.
	if (
		profile.cultivateForMaxBarrier &&
		player.maxBarrier < profile.maxBarrierTarget &&
		awakenedCultivators(player) >= 2
	) {
		const d = legalDest(destinationOfferingAction(catalog, 'cultivate'));
		if (d) return d;
	}
	// 3. Rest to build/upgrade dice, or restore barrier — but only up to COMBAT-READY (toughest monster
	//    damage + 1), not to a bloated max barrier: restoring barrier past what survives the next hit
	//    just burns Floral rounds (a max-barrier-10 build otherwise spends ~3 rounds topping 7→10 for nothing).
	if (profile.restForDice && hasRestPayoff(player, profile, maxLadderDamage(catalog) + 1)) {
		const d = legalDest(destinationOfferingAction(catalog, 'rest'));
		if (d) return d;
	}
	// 3c. Late-game DAMAGE CAP: once the core build is done but expected attack can't one-shot the
	//     toughest rung, buy Spirit Animal augments (+1 combat damage each, slot-free). Relics are
	//     action economy: spend a held one on the Tidal "Animal" augment, else Cultivate for origin
	//     runes (which trade up to relics) so the augment spree keeps funding itself.
	{
		const coreBuilt =
			atDiceCap(player, profile) &&
			player.maxBarrier >= profile.maxBarrierTarget &&
			!player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
		const belowOneShot = expectedAttack(state, seat, catalog) < maxLadderHp(catalog) + 1;
		if (coreBuilt && belowOneShot && hasAugmentCapacity(player)) {
			const heldRelics = player.mats.filter((r) => r.hasRune && r.type === 'relic').length;
			if (heldRelics >= 1) {
				const d = legalDest(destinationOfferingAugment(catalog, ['Spirit Animal']));
				if (d) return d;
			}
		}
	}
	// 4. Fallback: summon (more flat-damage spirits, or the bootstrap when nothing else is actionable).
	const summon = legalDest(destinationOfferingAction(catalog, 'spiritWorldSummon'));
	if (summon) return summon;
	return chooseSpiritWorld(state, seat, catalog, profile, rng) ?? null;
}

const RELIC_TARGET = 5; // relics are awaken fuel + pay "any relic" costs — keep a few on hand

/**
 * Should the bot resolve this location interaction? Plays a location like a thorough real player:
 * take every FREE gain (build action, free rune; a free barrier restore only when actually hurt), and any
 * affordable TRADE whose gain advances the build (buy relics up to a target, restore barrier when hurt, take
 * runes/augments/class-runes/summons we can use). There is no artificial one-action cap — the bot
 * may resolve every worthwhile row the location offers (each row once per round).
 */
/** Best chooseRune-option INDEX for an augment trade whose class augment CROSSES a useful
 * breakpoint — Fighter while still building dice, Cultivator while still building max barrier
 * (preferring the count nearest the cap-reaching breakpoint), or a flat-damage augment once
 * built — or -1 if none is worth it. Buying must ADVANCE the build, never just spend a relic. */
function augmentWorth(
	player: BotPlayer,
	profile: BotProfile,
	options: ResolvedRune[],
	catalog: PlayCatalog
): number {
	const counts = awakenedClassCounts(player);
	const needDice = !atDiceCap(player, profile);
	const needMaxBarrier = player.maxBarrier < profile.maxBarrierTarget;
	const hasUpgradable = player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
	let best = -1;
	let bestScore = 0;
	options.forEach((opt, i) => {
		const cls = opt.classId ? catalog.classes.find((c) => c.id === opt.classId)?.name : undefined;
		if (!cls) return;
		const c = counts[cls] ?? 0;
		let score = 0;
		// OPPORTUNISTIC ONLY: cross a steep tier you're ALREADY adjacent to (count 2→3 = +3, 3→4 = +5).
		// Never from a low base (0/1 → +1 isn't worth a relic) and never to FORCE a count we don't
		// nearly have — grinding draws/relics toward a far breakpoint is luck-based, so we don't.
		// Fighter augment raises the dice-ADD rate (super-linear 2/3/4/5 → +1/+2/+5/+10 per Rest). While
		// dice are NOT yet capped this is the BINDING bottleneck — there is no point upgrading dice that
		// don't exist yet — so it OUTRANKS the Elementalist (upgrade) augment and fires from count 2 (the
		// 1-die/Rest floor that caused the ~9-Rest grind in bad-Fighter-draw games). Once dice are capped
		// it drops to 0 and the Elementalist augment takes over for quality.
		if (cls === 'Fighter' && needDice && c >= 2 && c < 5) score = c + 6;
		else if (cls === 'Cultivator' && needMaxBarrier && c >= 3 && c < 5) score = c;
		// Elementalist augment is the dice-QUALITY throughput lever (super-linear): top priority once the
		// dice exist. Spirit Animal augment = the slot-free flat-damage cap once dice are done.
		else if (cls === 'Elementalist' && hasUpgradable && c >= 1 && c < 5) score = c + 5;
		else if ((profile.damageClasses ?? []).includes(cls) && !hasUpgradable && !needDice) score = 3;
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	});
	return best;
}

/** Per-chooseRune-gain choice indexes for resolving an interaction (picks the worth-buying augment). */
function augmentChoices(
	player: BotPlayer,
	profile: BotProfile,
	it: LocationInteraction,
	catalog: PlayCatalog
): number[] {
	const out: number[] = [];
	for (const g of it.gains) {
		if (g.type !== 'chooseRune') continue;
		const idx = augmentWorth(player, profile, g.options, catalog);
		out.push(idx >= 0 ? idx : 0);
	}
	return out;
}

function wantsInteraction(player: BotPlayer, profile: BotProfile, it: LocationInteraction, catalog: PlayCatalog): boolean {
	const hurt = player.barrier < player.maxBarrier;
	const heldRelics = player.mats.filter((s) => s.hasRune && s.type === 'relic').length;
	if (it.kind === 'gain') {
		// Free. Take it — unless it's purely a barrier restore we don't need right now.
		if (it.gains.every((g) => g.type === 'restoreBarrier')) return hurt;
		return true;
	}
	if (!canAfford(it, player.mats)) return false;
	let want = false;
	for (const g of it.gains) {
		if (g.type === 'restoreBarrier') want ||= hurt;
		else if (g.type === 'vp') want = true;
		// A relic → 2nd build action this turn only when it clearly helps (still building dice/max barrier)
		// and we can keep a relic in reserve — never just to spend.
		else if (g.type === 'action')
			// Spend relics on the abyss-summon fish (arcane) only. Do NOT blow them on an extra
			// summon/build action — relics are reserved for the Elementalist augments (count→5, the
			// dice-upgrade speed lever) and the late Spirit-Animal damage cap. Wasting the 2 starting
			// Fairy relics on a 2nd summon was stranding the bot at Elementalist count 3 (the slow grind).
			want ||= g.action === 'abyssSummon' && wantsAbyssFish(player, profile);
		// Buy + place a class augment only when it CROSSES a useful breakpoint (see augmentWorth) — but
		// RESERVE the relic when a compressor fish is wanted: the Abyss compressor (climb collapse) is
		// worth far more than any augment, and the augment row otherwise resolves first (lower rowIndex)
		// and spends the relic before the abyssSummon row can. Skipping it here lets the same Cyber visit
		// fall through to the abyssSummon fish.
		else if (g.type === 'chooseRune') {
			if (wantsAbyssFish(player, profile)) continue;
			want ||= augmentWorth(player, profile, g.options, catalog) >= 0;
		}
		else if (g.type === 'rune') {
			if (g.rune.type === 'relic') want ||= heldRelics < RELIC_TARGET; // buy awaken fuel
			else want ||= true; // origin rune / augment — cheap build fuel
		}
	}
	return want;
}

// ════════════════════════════════════════════════════════════════════════════
// Strategic ("Medium") bot
//
// Strategy: fight the Arcane Abyss monster when the kill odds clear a threshold
// (default 80%), otherwise visit the Spirit World to cultivate max barrier, rest
// for attack dice, and recruit Fighters/Elementalists (dice) until the dice cap,
// then Spirit Animals (flat combat damage). Win = first to 30 VP, farmed off the
// monster's reward track. All choices are still trial-applied for legality.
// ════════════════════════════════════════════════════════════════════════════

export type BotDifficulty = 'random' | 'medium';

/** Tunable knobs for a strategic bot; the offline sweep (src/lib/play/sim) tunes these. */
export interface BotProfile {
	kind: BotDifficulty;
	/**
	 * Minimum P(kill) before the bot commits to an Abyss fight WHILE it can still
	 * improve its build. Kill-probability already returns 0 when the monster's hit
	 * would corrupt (a corrupted player can't strike back), so clearing this bar also
	 * guarantees the fight is survivable.
	 */
	killThreshold: number;
	/**
	 * Lower P(kill) bar used once the build is "topped out" (dice + max barrier at
	 * target, no more rest/recruit progress). At that point waiting no longer helps,
	 * so the bot takes the best shot it has even at modest odds (the hp14/dmg10 boss).
	 */
	builtOutThreshold: number;
	/** Target attack-dice count (also bounded by the flat 10-dice cap). */
	diceCapTarget: number;
	/** Target max barrier the bot builds to, then stops. Must cover the top monster's
	 *  damage to clear the ladder without corrupting (currently 7); over-building past it is wasted
	 *  rounds (see the max-barrier-target sweep in src/lib/play/sim/metaReport.test.ts). */
	maxBarrierTarget: number;
	/** Class names to recruit while building dice, in priority order. */
	preCapClasses: string[];
	/** Class names to recruit once dice are capped. */
	postCapClasses: string[];
	/** Classes that always add combat power (flat damage / arcane dice) — valued in every phase. */
	damageClasses: string[];
	/** Cultivate to raise max barrier while it is below the max barrier target. */
	cultivateForMaxBarrier: boolean;
	/** Rest when it yields dice / tier upgrades / arcane conversion / a needed barrier restore. */
	restForDice: boolean;
	/** Concentrate recruiting on one origin to consolidate Cultivate's rune yield (mild tiebreaker). */
	originFocus: boolean;
	/**
	 * How many Cultivators to stack while max barrier is short. The reworked Cultivator grants
	 * (awakened count − 1) max barrier per Cultivate, so more Cultivators = faster max barrier
	 * (2 → +1, 3 → +2, 4 → +3). Defaults to CULTIVATOR_WANTED. Higher = faster cap, more slot churn.
	 */
	cultivatorTarget?: number;
	/**
	 * How many Elementalists to stack while dice are still upgradable. Each Elementalist upgrades
	 * one more die per Rest, so more = faster basic→exalted (the dice-QUALITY engine). Defaults to
	 * ELEMENTALIST_WANTED. Higher = quality caps faster, more slot pressure during the build.
	 */
	elementalistTarget?: number;
	/**
	 * If >0, the bot does ROLLOUT SEARCH at the key fight-vs-build navigation decision: it
	 * plays out each option to game-end this many times with the base heuristic as rollout
	 * policy and picks the option with the best expected outcome (win, then speed). More
	 * rollouts ⇒ stronger + faster play (the monotone strength dial for the top tiers). 0 =
	 * pure heuristic. Only fires when fighting is actually a live choice, so it stays cheap.
	 */
	searchRollouts?: number;
	/** Round cap inside each rollout (keeps rollouts terminating). Default 60. */
	searchRolloutRounds?: number;
	/**
	 * Fight as soon as the hit is survivable and the kill is likely, instead of topping barrier
	 * off first. Trades a little safety for far fewer wasted restore-barrier rounds → faster wins.
	 */
	fightUrgency?: boolean;
	/**
	 * Rollout search keeps the OPPONENTS in (on the base heuristic) and scores winning the RACE
	 * (reach 30 before rivals), instead of a cheap solo-tempo proxy. Costlier per rollout, but it
	 * optimizes the true multiplayer objective — which is how the top tier breaks the solo-search
	 * saturation ceiling. Requires searchRollouts>0.
	 */
	searchMultiplayer?: boolean;
	/**
	 * Pursue ARCANE BURST: spend a monster-reward token on an Arcane Abyss Summon to fish for an
	 * arcane source (Arcane Advisor / Dragon Warrior), keep + awaken it (the starting Fairy relics
	 * + claimed relics pay the "any relic" awaken cost), then rest to convert exalted dice → arcane
	 * (mean 2.0 vs 1.0). Roughly doubles firepower → one-shots the hp14 boss → collapses the round
	 * count. The "full-scope" lever for the top tiers.
	 */
	pursueArcane?: boolean;
	/**
	 * Pursue the CORRUPTION build: recruit a simultaneous-attack class (Sharpshooter / Soul
	 * Weaver ≥2) + Cursed Spirits, run a LOW max barrier target, and deliberately fight rungs
	 * whose damage exceeds barrier — corrupting THROUGH the hit (you still strike, and can kill)
	 * to punch past the dmg-7/dmg-10 walls without grinding max barrier to 10. Cursed Spirits turn
	 * the Tainted corruption into +1 max barrier each (claimed via taintedMaxBarrier). Gated so the
	 * corruption-aware kill model (computeKillProbability) only fires for this build.
	 */
	pursueCorruption?: boolean;
	/**
	 * Pursue the EVIL-HUNTER / PvP line: build a small Cursed-Spirit + Sharpshooter core, then
	 * deliberately corrupt all the way to Fallen at the Abyss (each crossing pays out the held
	 * Cursed Spirits — max barrier → relic → augment), and from then on co-locate with the Good
	 * players every round to launch the unanimous group attack for +2 VP each, +2 per corruption. The
	 * aggressive line the design wants to dominate. Implies corruption-aware play.
	 */
	pursuePvp?: boolean;
	/**
	 * ISMCTS: if >0, the navigation decision each round is chosen by Information-Set Monte Carlo
	 * Tree Search instead of the heuristic — a UCT tree over the SEQUENCE of destinations, with the
	 * base heuristic as the rollout/execution policy and a fresh determinization (bag + dice seed)
	 * per iteration. Optimizes rounds-to-30 directly. The strongest, structure-free navigation
	 * planner; everything else (location/encounter/cleanup) still runs the heuristic. 0 = off.
	 */
	ismctsIterations?: number;
	/** Round-horizon cap for ISMCTS selection + simulation (keeps each iteration terminating). Default 45. */
	ismctsHorizon?: number;
	/** UCT exploration constant for ISMCTS (higher = more exploration). Default 1.4. */
	ismctsC?: number;
	/** readyToClimb damage gate: start climbing once expected attack ≥ this × toughest-rung HP. Lower
	 *  = climb the easy rungs sooner (interleave building); higher = front-load damage. Default 0.9. */
	climbReadyFactor?: number;
	/** Boss-rung build target: keep building damage until expected attack ≥ this × toughest HP before
	 *  committing to a boss rung (vs coin-flipping it). Default 0.95. */
	bossDamageFactor?: number;
	/**
	 * Spread Spirit-World visits across the four locations (pick a RANDOM legal one) instead of
	 * always taking the first legal location. Pure heuristic bots otherwise all cluster on the
	 * same first-legal Spirit World, which makes co-location (and thus a hunter's PvP) trivially
	 * frequent. This flag is the robustness counterfactual: when targets spread out, how often can
	 * the Evil hunter still find a victim? Used to separate real PvP strength from a clustering
	 * artifact — NOT a strength lever.
	 */
	spreadSpiritWorld?: boolean;
}

/** The legacy random-legal bot (unchanged behavior; the default profile). */
export const RANDOM_PROFILE: BotProfile = {
	kind: 'random',
	killThreshold: 1,
	builtOutThreshold: 1,
	diceCapTarget: 10,
	maxBarrierTarget: 10,
	preCapClasses: [],
	postCapClasses: [],
	damageClasses: [],
	cultivateForMaxBarrier: false,
	restForDice: false,
	originFocus: false
};

/** Classes that always add raw combat power (flat damage and/or arcane dice). */
const DAMAGE_CLASSES = ['Spirit Animal', 'Sharpshooter', 'Arcane Advisor', 'Dragon Warrior', 'The Corruptor'];

/**
 * The default strategic bot — a SAFE SCALER tuned for the escalating 8-rung ladder
 * (HP 1→14, damage 3→10; you win by climbing all rungs once, cum 33 ≥ 30 VP).
 *
 * The ladder cannot be beaten by raw dice alone: a corrupted player (monster damage
 * > barrier) cannot strike back, so the bot must (1) NEVER fight into corruption —
 * kill-probability is 0 unless it survives the first hit; (2) raise MAX BARRIER via
 * Cultivators (≥2 awakened → +max barrier/Cultivate) so its barrier covers the damage curve (4 → 10); (3) build +
 * upgrade dice (Fighter/Elementalist) and add Spirit-Animal flat damage to out-roll
 * the rising HP; (4) keep a Healer for between-fight sustain. Tuned by src/lib/play/sim.
 */
export const MEDIUM_DEFAULTS: BotProfile = {
	kind: 'medium',
	killThreshold: 0.7,
	builtOutThreshold: 0.25,
	diceCapTarget: 10,
	maxBarrierTarget: 10,
	preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
	postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
	damageClasses: DAMAGE_CLASSES,
	cultivateForMaxBarrier: true,
	restForDice: true,
	originFocus: true
};

/**
 * Named strategy variants for self-play comparison — each plays with different
 * levers (class priorities, fight bar, origin focus, sustain). Tune in src/lib/play/sim.
 */
export const BOT_PROFILES: Record<string, BotProfile> = {
	random: RANDOM_PROFILE,
	medium: MEDIUM_DEFAULTS,
	// The OLD literal strategy: Fighters/Elementalists for dice, no max barrier, no
	// origin focus — the baseline the safe scaler must beat (hard-walls at dmg-5 rungs).
	fighter: {
		kind: 'medium',
		killThreshold: 0.8,
		builtOutThreshold: 0.3,
		diceCapTarget: 10,
		maxBarrierTarget: 4,
		preCapClasses: ['Fighter', 'Elementalist'],
		postCapClasses: ['Spirit Animal'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: false,
		restForDice: true,
		originFocus: false
	},
	// Sustain-first: leans on Healers + Cultivators, fights cautiously (high kill bar).
	survivor: {
		kind: 'medium',
		killThreshold: 0.8,
		builtOutThreshold: 0.3,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Cultivator', 'Healer', 'Fighter', 'Elementalist', 'Spirit Animal'],
		postCapClasses: ['Cultivator', 'Healer', 'Spirit Animal'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true
	},
	// Aggressive: lower fight bar, dice + damage focus, lighter on max barrier.
	aggressive: {
		kind: 'medium',
		killThreshold: 0.55,
		builtOutThreshold: 0.2,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Spirit Animal', 'Elementalist'],
		postCapClasses: ['Spirit Animal', 'Cultivator', 'Elementalist'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true
	},
	// Capacity-first: rush max barrier to 10 before leaning on dice/damage.
	cultivator: {
		kind: 'medium',
		killThreshold: 0.75,
		builtOutThreshold: 0.25,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Cultivator', 'Fighter', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true
	},
	// Safe scaler without origin focus — isolates how much origin concentration still matters
	// (now only Cultivate's rune yield; max barrier is origin-independent).
	noorigin: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.25,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: false
	},
	// ── The difficulty LADDER (each tier definitively stronger) ────────────────────
	// HARD: the safe scaler, but urgent — fights the moment a kill is survivable + likely
	// instead of over-restoring barrier, so it wins materially faster than Medium.
	hard: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true
	},
	// EXTRA-HARD: Hard + shallow rollout search at the fight-vs-build choice (optimizes tempo).
	extrahard: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		searchRollouts: 6,
		searchRolloutRounds: 12
	},
	// INSANE: LONGER rollout horizon — rollouts reach further toward a real win, so the value
	// is less biased and the fight-vs-build calls are sharper than Extra-Hard's quick proxy.
	insane: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		searchRollouts: 10,
		searchRolloutRounds: 24
	},
	// GODLY: deepest rollouts — the horizon reaches a real win in most lines, so the value is
	// ~unbiased (true win/rounds) and tempo is near-optimal; targets the fastest possible win.
	godly: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		searchRollouts: 20,
		searchRolloutRounds: 24
	},
	// MYTHIC: rollout search that keeps the OPPONENTS in and scores winning the RACE (reach 30
	// before rivals) rather than a solo-tempo proxy — optimizing the true multiplayer objective
	// to break the solo-search saturation ceiling. Costliest per decision, strongest play.
	mythic: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		searchRollouts: 8,
		searchRolloutRounds: 40,
		searchMultiplayer: true
	},
	// ── New-economy strategy probes ────────────────────────────────────────────────
	// All share the HARD template (fightUrgency, NO search) so head-to-head differences are
	// attributable to the economy lever varied (Cultivator count / origin focus), not to search
	// depth. Used by the meta self-play battery (src/lib/play/sim/metaReport.test.ts).
	// CULRUSH — stack 4 Cultivators (+3 max barrier/Cultivate): caps max barrier fastest.
	culrush: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Cultivator', 'Fighter', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		cultivatorTarget: 4
	},
	// CULLEAN — only 2 Cultivators (+1 max barrier/Cultivate): slowest max barrier, most slots for damage.
	cullean: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		cultivatorTarget: 2
	},
	// FLEXORIGIN — origin focus OFF (max barrier no longer needs an origin trio): spread origins freely.
	flexorigin: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Fighter', 'Cultivator', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: false,
		fightUrgency: true,
		cultivatorTarget: 3
	},
	// RUSHPATIENT — the data-driven hybrid: capacity-first (rush max barrier, patient fights, like
	// `cultivator`) + 4 Cultivators (`culrush`'s reliability lever). Combines the solo-best and
	// MP-best traits surfaced by the meta battery.
	rushpatient: {
		kind: 'medium',
		killThreshold: 0.75,
		builtOutThreshold: 0.25,
		diceCapTarget: 10,
		maxBarrierTarget: 10,
		preCapClasses: ['Cultivator', 'Fighter', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		cultivatorTarget: 4
	},
	// CORRUPTION — the "you don't need 10 max barrier" build. Runs a LOW max barrier target and a
	// simultaneous-attack class (Sharpshooter) so it can fight rungs whose damage exceeds its
	// barrier, corrupting THROUGH the hit (still striking, and killing) to punch past the
	// dmg-7/dmg-10 walls. Cursed Spirits convert the Tainted corruption into +max barrier. Probe
	// profile for the meta battery — measures whether corruption beats the safe scaler.
	corruption: {
		kind: 'medium',
		killThreshold: 0.6,
		builtOutThreshold: 0.3,
		diceCapTarget: 10,
		maxBarrierTarget: 6,
		preCapClasses: ['Sharpshooter', 'Fighter', 'Cursed Spirit', 'Elementalist', 'Spirit Animal', 'Cultivator'],
		postCapClasses: ['Sharpshooter', 'Spirit Animal', 'Cursed Spirit', 'Elementalist'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: false,
		fightUrgency: true,
		pursueCorruption: true
	},
	// PVPHUNTER — the aggressive Evil line the design wants to be dominant. Build a small Cursed +
	// Sharpshooter core, descend to Fallen at the Abyss (each crossing pays the Cursed Spirits out:
	// max barrier → relic → augment), then co-locate with the Good players every round and launch the
	// unanimous group attack for +2 VP each, +2 per corruption (Sharpshooter lets it strike through the
	// corrupting descent hits). Low max barrier — it corrupts on purpose, so over-building is wasted.
	pvphunter: {
		kind: 'medium',
		killThreshold: 0.6,
		builtOutThreshold: 0.3,
		diceCapTarget: 10,
		maxBarrierTarget: 5,
		preCapClasses: ['Cursed Spirit', 'Sharpshooter', 'Fighter', 'Spirit Animal', 'Elementalist'],
		postCapClasses: ['Cursed Spirit', 'Sharpshooter', 'Spirit Animal'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: false,
		fightUrgency: true,
		pursueCorruption: true,
		pursuePvp: true,
		cultivatorTarget: 2
	},
	// CURSED — the Cursed-Spirit value engine WITHOUT PvP: stack Cursed Spirits, descend the
	// corruption ladder through fights for the threshold rewards (max barrier → relic → augment,
	// each ×Cursed held), then convert that surplus into a normal VP win. Isolates the cursed
	// economy from the PvP payoff so the battery can attribute each independently.
	cursed: {
		kind: 'medium',
		killThreshold: 0.6,
		builtOutThreshold: 0.3,
		diceCapTarget: 10,
		maxBarrierTarget: 6,
		preCapClasses: ['Cursed Spirit', 'Sharpshooter', 'Fighter', 'Elementalist', 'Spirit Animal'],
		postCapClasses: ['Cursed Spirit', 'Sharpshooter', 'Spirit Animal', 'Elementalist'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: false,
		fightUrgency: true,
		pursueCorruption: true
	},
	// PARAGON — the optimized GOOD line (never corrupts; wins by squeezing value from every turn).
	// It does NOT force-stack a class (luck-based grinding); it builds opportunistically and crosses a
	// steep breakpoint only when ALREADY adjacent (a bought augment away), converts to ARCANE late to
	// one-shot the boss, and fights urgently. The strongest non-evil line — still meant to lose to evil.
	paragon: {
		kind: 'medium',
		killThreshold: 0.7,
		builtOutThreshold: 0.4,
		diceCapTarget: 10,
		maxBarrierTarget: 9,
		preCapClasses: ['Cultivator', 'Fighter', 'Elementalist', 'Spirit Animal', 'Healer'],
		postCapClasses: ['Cultivator', 'Spirit Animal', 'Elementalist', 'Healer'],
		damageClasses: DAMAGE_CLASSES,
		cultivateForMaxBarrier: true,
		restForDice: true,
		originFocus: true,
		fightUrgency: true,
		pursueArcane: true
	}
};

// Max-barrier-target sweep probes (the HARD template, varying ONLY maxBarrierTarget). Used by the
// meta battery to find the win-rate-optimal max barrier cap for the current monster damage curve
// (max damage = the boss's 7, so 7 is the minimum that survives every rung; 8–10 over-build).
for (const pt of [5, 6, 7, 8, 9, 10]) {
	BOT_PROFILES[`pot${pt}`] = { ...BOT_PROFILES.hard, maxBarrierTarget: pt };
}

// Low-max-barrier + SIMULTANEOUS-ATTACK probes: run a Sharpshooter (attack at the same time) and a
// LOW max barrier cap, restoring barrier through survivable rungs and corrupt-punching only the rungs whose
// damage exceeds max barrier (sim6 → just the boss; sim5 → rung-6 + boss). Tests whether sub-7
// max barrier is viable/better once you can strike through corruption. (No Cursed Spirits — clean.)
for (const pt of [4, 5, 6]) {
	BOT_PROFILES[`sim${pt}`] = {
		...BOT_PROFILES.hard,
		maxBarrierTarget: pt,
		pursueCorruption: true,
		originFocus: false,
		preCapClasses: ['Sharpshooter', 'Fighter', 'Elementalist', 'Spirit Animal', 'Cultivator'],
		postCapClasses: ['Sharpshooter', 'Spirit Animal', 'Elementalist']
	};
}

// Data-driven max barrier cap for the SHIPPED tiers. The boss hits for 7, so max barrier 7 is
// the minimum that survives every rung (corruption is damage > barrier, so barrier 7 survives a 7).
// A self-play sweep (src/lib/play/sim/metaReport.test.ts) shows 7 wins MORE and no slower than
// 8–10 — over-building past the top damage is wasted rounds. The tiers share the safe-scaler
// build and differ only by search depth, so they all use the same cap. (medium === MEDIUM_DEFAULTS,
// so this updates both.) If the monster damage curve changes, re-run the sweep and update this.
// Max barrier target for the shipped difficulty tiers. NB: a self-play sweep on the REBUILT economy
// (src/lib/play/sim/_potSweep) shows the full 10 is materially MORE ROBUST than 7 — the extra
// barrier headroom buffers the boss climb against corruption (which would otherwise eat the
// flat-damage Spirit Animals the build needs), lifting 2p win rate to ~100% with no loss of winning
// speed (~42 rounds either way). So the economy scalers keep their authored maxBarrierTarget: 10;
// only the search-tier ladder is normalized here. (If the monster damage curve changes, re-sweep.)
const TIER_MAX_BARRIER_TARGET = 10;
for (const t of ['medium', 'hard', 'extrahard', 'insane', 'godly']) {
	BOT_PROFILES[t].maxBarrierTarget = TIER_MAX_BARRIER_TARGET;
}

// Co-location robustness counterfactual. Heuristic bots otherwise all cluster on the first legal
// Spirit-World location, which makes a Fallen hunter's PvP trivially frequent. These `_spread`
// variants pick a RANDOM legal Spirit World each visit, so targets scatter across the four
// locations. Used by the meta battery to separate the hunter's REAL PvP strength from the
// clustering artifact (the hunter spreads too, so it can't camp one guaranteed-crowded spot).
for (const base of ['hard', 'rushpatient', 'cullean', 'cultivator', 'pvphunter']) {
	BOT_PROFILES[`${base}_spread`] = { ...BOT_PROFILES[base], spreadSpiritWorld: true };
}

// ISMCTS variants: each archetype, but the navigation decision is chosen by tree search. These are
// the "advanced" bots — the heuristic provides the within-round execution + rollout policy, while
// ISMCTS plans the destination sequence for the fastest legal path to 30 VP. `_mcts` = standard
// budget; `_mctsdeep` = a higher budget for the strongest (slower) play. Tuned via the EA harness.
for (const base of ['hard', 'cullean', 'culrush', 'rushpatient', 'cultivator', 'paragon']) {
	BOT_PROFILES[`${base}_mcts`] = { ...BOT_PROFILES[base], ismctsIterations: 48, ismctsHorizon: 36, ismctsC: 1.4 };
}
BOT_PROFILES['mcts'] = { ...BOT_PROFILES['cullean'], ismctsIterations: 64, ismctsHorizon: 36, ismctsC: 1.4 };
// EA-tuned economy config (src/lib/play/sim/_ea — corruption-fixed base): climb sooner
// (climbReadyFactor 0.6 → less Spirit-Animal over-stacking), pot 9, 2 Cultivators, 3 Elementalists.
// The fastest robust single-action economy line (~46 rounds / ~83% solo). Action-economy spirits
// (Ironmane 2x combat, Child Prodigy 2x location) push it lower once recruited.
BOT_PROFILES['fast'] = {
	...BOT_PROFILES['cullean'],
	killThreshold: 0.55,
	builtOutThreshold: 0.42,
	maxBarrierTarget: 9,
	cultivatorTarget: 2,
	elementalistTarget: 3,
	climbReadyFactor: 0.6,
	bossDamageFactor: 0.95
};
BOT_PROFILES['mctsdeep'] = { ...BOT_PROFILES['cullean'], ismctsIterations: 128, ismctsHorizon: 40, ismctsC: 1.3 };

// CONTINUOUS FARMERS (experiment): fight EVERY round it's survivable (P(kill)>0 ⇒ survivable, see
// killThreshold doc) instead of over-building to barrier 10 first. Lower kill-threshold + lower
// maxBarrierTarget = far more fights → capture the ~8-rung × ~lives kills that the 0.7-threshold
// profiles leave on the table. Tests the owner's "8 monsters × ~3 kills each = more than enough points".
BOT_PROFILES['farmer'] = { ...BOT_PROFILES.hard, killThreshold: 0.2, builtOutThreshold: 0.1, maxBarrierTarget: 8 };
BOT_PROFILES['farmer2'] = { ...BOT_PROFILES.hard, killThreshold: 0.4, builtOutThreshold: 0.2, maxBarrierTarget: 8 };
BOT_PROFILES['farmer3'] = { ...BOT_PROFILES.hard, killThreshold: 0.05, builtOutThreshold: 0.05, maxBarrierTarget: 6 };

/** Map a name (parsed from a bot's display name, or a tuner key) to a profile. */
export function profileFor(name: string | null | undefined): BotProfile {
	if (!name) return RANDOM_PROFILE;
	return BOT_PROFILES[name] ?? (name === 'medium' ? MEDIUM_DEFAULTS : RANDOM_PROFILE);
}

function catalogSpiritById(catalog: PlayCatalog, id: string | undefined): PlayCatalogSpirit | undefined {
	if (!id) return undefined;
	return catalog.spirits.find((s) => s.id === id);
}

/** Exact PMF of the summed face values of a dice pool (convolution; cheap for ≤10 dice). */
function diceSumPMF(dice: readonly AttackDie[]): Map<number, number> {
	let pmf = new Map<number, number>([[0, 1]]);
	for (const die of dice) {
		const faces = DICE_TIER_FACES[die.tier];
		if (!faces || faces.length === 0) continue;
		const next = new Map<number, number>();
		const per = 1 / faces.length;
		for (const [sum, prob] of pmf) {
			for (const face of faces) {
				const key = sum + face;
				next.set(key, (next.get(key) ?? 0) + prob * per);
			}
		}
		pmf = next;
	}
	return pmf;
}

/**
 * Probability that `seat`'s attack roll would kill the current Abyss monster.
 *
 * The monster strikes FIRST, and a corrupted player (its hit exceeds barrier) cannot
 * strike back at all — so a fight the bot can't survive deals zero and can never kill.
 * We model that exactly: if the monster's post-mitigation hit would corrupt the player,
 * the kill probability is 0 (don't fight — you'd just burn a round and a status rung
 * for nothing). Otherwise we clear + fire the `inCombat` trigger on a clone to read the
 * real combat bonus/multiplier, convolve the dice faces, and sum the mass at/above HP.
 * Pure; no RNG.
 */
/**
 * Cheaper clone for combat EVALUATION sims (computeKillProbability / firepower / expectedAttack):
 * deep-clone the PLAYERS — where resetCombatFlags + the `inCombat` trigger write (acting seat and,
 * for board-wide classes, colocated seats) — but SHARE the rest of the state by reference. Combat
 * evaluation only READS bags / monster / market / combats (it never mutates them), and the trigger's
 * log goes to a throwaway array param, not `state.log`. Skipping the bag clone (~44% of the state's
 * bytes) is the win. Faithfulness is gated by the gen determinism hash + the full combat suite — if
 * any `inCombat` path mutated shared state, those would diverge.
 */
/**
 * structuredClone-semantics deep clone without the algorithm overhead: preserves undefined-valued
 * keys and key order for plain-JSON values (the player state has no Maps/Sets/Dates/typed-arrays),
 * but ~5x faster (measured: 12k → 65k player-clones/s). Byte-identical to structuredClone here.
 */
function structClonePlain<T>(v: T): T {
	if (v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) {
		const n = new Array(v.length);
		for (let i = 0; i < v.length; i++) n[i] = structClonePlain(v[i]);
		return n as unknown as T;
	}
	const n: Record<string, unknown> = {};
	for (const k in v) {
		if (Object.prototype.hasOwnProperty.call(v, k)) n[k] = structClonePlain((v as Record<string, unknown>)[k]);
	}
	return n as unknown as T;
}

function cloneForCombatSim(state: PublicGameState): PublicGameState {
	return { ...state, players: structClonePlain(state.players) };
}

export function computeKillProbability(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	opts: { allowCorruptKill?: boolean } = {}
): number {
	const monster = state.monster;
	if (!monster) return 0;
	const sim = cloneForCombatSim(state);
	const player = sim.players[seat];
	if (!player) return 0;

	resetCombatFlags(player);
	applyTrigger(sim, seat, 'inCombat', [], { catalog });

	// The monster hits first. Account for any defensive mitigation the inCombat trigger
	// granted (deflect / damageReduction — e.g. Golem of Wishes). If the surviving hit
	// still exceeds current barrier, the player corrupts and normally cannot counter ⇒ kill
	// is impossible. (skipTakeDamage from a Guardian dodges the hit entirely.)
	const mitigation = (player.damageReduction ?? 0) + (player.deflect ?? 0);
	const incoming = Math.max(0, monster.damage - mitigation);
	// Deflected damage is dealt BACK to the monster (rules 2026-07-03) and counts toward
	// the kill, so the roll only has to cover the remainder. A Guardian dodge
	// (skipTakeDamage) means no hit landed — nothing to deflect.
	const deflected = player.skipTakeDamage
		? 0
		: Math.min(player.deflect ?? 0, Math.max(0, monster.damage - (player.damageReduction ?? 0)));
	const hpTarget = Math.max(0, monster.maxHp - deflected);
	if (!player.skipTakeDamage && hpTarget === 0) return 1; // deflection alone finishes it
	if (!player.skipTakeDamage && incoming >= player.barrier) {
		// Would corrupt at the CURRENT barrier. If a FULL barrier (maxBarrier) WOULD survive this hit,
		// don't corrupt — return 0 so the bot restores barrier first and fights cleanly. Corruption is NOT free:
		// it decays status, which shrinks the spirit-slot cap (Pure 7 → Corrupt 5 → Fallen 4), costing
		// flat-damage spirits (Spirit Animals) — the very firepower the hp-rich rungs need. So only
		// punch through when corruption is UNAVOIDABLE (incoming > maxBarrier, i.e. even a full barrier
		// dies), the caller opts in (pursueCorruption), we have a simultaneous-attack class
		// (Sharpshooter / Soul Weaver ≥2) to still strike, and status ≤ 1 so we don't fall to Fallen.
		if (incoming < player.maxBarrier) return 0;
		const c = awakenedClassCounts(player);
		const simultaneous = (c['Sharpshooter'] ?? 0) >= 1 || (c['Soul Weaver'] ?? 0) >= 2;
		if (opts.allowCorruptKill && simultaneous && (player.statusLevel ?? 0) <= 1) {
			return firepowerFromClone(sim, player, hpTarget);
		}
		return 0;
	}

	return firepowerFromClone(sim, player, hpTarget);
}

/**
 * Raw firepower probability — P(this seat's attack roll ≥ `hp`) IGNORING whether the
 * monster's first hit would corrupt. Used to decide whether a deliberate corruption-reset
 * (sacrifice a status rung / spirit to restore barrier to full) would actually pay off,
 * i.e. would the follow-up fight at full barrier likely kill. Pure; no RNG.
 */
export function firepowerKillProbability(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): number {
	const monster = state.monster;
	if (!monster) return 0;
	const sim = cloneForCombatSim(state);
	const player = sim.players[seat];
	if (!player) return 0;
	resetCombatFlags(player);
	applyTrigger(sim, seat, 'inCombat', [], { catalog });
	return firepowerFromClone(sim, player, monster.maxHp);
}

/** Shared tail of the two kill-prob helpers: convolve the dice faces (post inCombat
 *  bonus/multiplier already applied to `player`) and sum the mass at/above `hp`. */
function firepowerFromClone(
	_sim: PublicGameState,
	player: NonNullable<PublicGameState['players'][SeatColor]>,
	hp: number
): number {
	const bonus = player.combatDamageBonus ?? 0;
	const mult = player.combatDamageMultiplier ?? 1;
	let p = 0;
	for (const [sum, prob] of diceSumPMF(player.attackDice)) {
		if ((sum + bonus) * mult >= hp) p += prob;
	}
	return p;
}

/** A seated player's full private state (what the bot reasons over). */
type BotPlayer = NonNullable<PublicGameState['players'][SeatColor]>;

/** Effective dice cap = min(profile target, the flat 10-dice game cap). */
function diceCapFor(profile: BotProfile): number {
	return Math.min(profile.diceCapTarget, MAX_ATTACK_DICE);
}

function atDiceCap(player: BotPlayer | undefined, profile: BotProfile): boolean {
	if (!player) return true;
	return player.attackDice.length >= diceCapFor(profile);
}

/**
 * Unique spirit names per origin across ALL of a player's spirits (face-up or down) —
 * used to pick the origin to consolidate recruiting on (for Cultivate's rune yield).
 */
function originNameSets(player: BotPlayer): Map<string, Set<string>> {
	const m = new Map<string, Set<string>>();
	for (const s of player.spirits) {
		for (const origin of Object.keys(s.origins ?? {})) {
			let set = m.get(origin);
			if (!set) {
				set = new Set<string>();
				m.set(origin, set);
			}
			set.add(s.name);
		}
	}
	return m;
}

/**
 * The origin to concentrate recruiting on, to consolidate the Cultivate rune yield (one
 * rune per two same-origin spirits → fewer wasted odd remainders): the most-represented
 * origin across the whole tableau (face-up or down). Null when the tableau is empty.
 */
function focusOriginFor(player: BotPlayer): string | null {
	const names = originNameSets(player);
	let best: string | null = null;
	let bestN = -1;
	for (const [origin, set] of names) {
		if (set.size > bestN) {
			bestN = set.size;
			best = origin;
		}
	}
	return best;
}

/**
 * How many AWAKENED Cultivators the player has. The reworked Cultivator grants
 * (count − 1) max barrier per Cultivate at count ≥ 2 (a lone Cultivator grants nothing),
 * so spending the Cultivate action on max barrier only pays off once there are ≥2.
 */
function awakenedCultivators(player: BotPlayer): number {
	return awakenedClassCounts(player)['Cultivator'] ?? 0;
}

/** Soft caps for a balanced tableau. Fighters are stacked HIGH then released (dice persist), because
 *  the onRest dice payoff is SUPER-LINEAR (counts 2/3/4/5 → +1/+2/+5/+10 dice): at 2 Fighters a Rest
 *  adds just 1 die → a ~9-Rest grind to fill the 10-cap (the dominant slow-game waste); at 4 it adds
 *  5 (2 Rests) and at 5 it fills the whole cap in ONE Rest. So recruit toward the breakpoint FIRST,
 *  then cull the spent Fighters for Elementalists/Spirit Animals. */
const FIGHTER_SOFT_CAP = 5; // 5 Fighters fill all 10 dice in a single Rest — never grind at the 2-Fighter floor
const HEALER_WANTED = 1; // one Healer's +3/rest sustain doesn't stack
const SOUL_WEAVER_WANTED = 3; // Soul Weaver heals (+2/rest) only at count 3 — the Healer-less fallback
const ELEMENTALIST_WANTED = 3; // upgrades dice toward exalted (more = faster basic→exalted, N dice/rest)
const CULTIVATOR_WANTED = 3; // 3 awakened Cultivators → +2 max barrier/Cultivate (caps max barrier ~3× faster than 2)
const CURSED_WANTED = 3; // corruption build: each awakened Cursed Spirit → +1 max barrier on the Tainted corruption

/**
 * Renewable barrier income WITHOUT corrupting: a single Healer (+3/rest) or three Soul
 * Weavers (+2/rest). Having this lets the bot climb the whole ladder by restoring barrier between
 * fights instead of spending its scarce ~3-corruption budget (which ends the solo game at
 * Fallen, well short of 30 VP). The decisive ingredient for a real win.
 */
function hasSustain(player: BotPlayer): boolean {
	const c = awakenedClassCounts(player);
	return (c['Healer'] ?? 0) >= HEALER_WANTED || (c['Soul Weaver'] ?? 0) >= SOUL_WEAVER_WANTED;
}

/**
 * Can the bot restore barrier the SAFE way via the location economy instead of corrupting?
 * The restore barrier path is: Cultivate → origin runes → a rune trade that restores barrier
 * (every location's rune→relic row restores barrier), or a held relic → restore barrier at
 * Floral Patch. True if it holds a relic, holds an origin rune, or has ≥2 same-origin spirits
 * to Cultivate runes from.
 */
function canRestoreBarrierViaEconomy(player: BotPlayer): boolean {
	if (player.mats.some((r) => r.hasRune && r.type === 'relic')) return true;
	if (player.mats.some((r) => r.hasRune && r.originId)) return true;
	const byOrigin: Record<string, number> = {};
	for (const sp of player.spirits) {
		if (sp.isFaceDown) continue;
		for (const o of Object.keys(sp.origins ?? {})) byOrigin[o] = (byOrigin[o] ?? 0) + 1;
	}
	return Object.values(byOrigin).some((n) => n >= 2);
}

/**
 * Does the player already have an ARCANE damage source — arcane dice, or an awakened spirit
 * that produces them (Arcane Advisor converts exalted→arcane on rest; Dragon Warrior grants
 * arcane on awaken; The Corruptor on corruption)? Arcane dice average 2.0 vs exalted's 1.0, so
 * an arcane source roughly DOUBLES firepower — the lever that one-shots the hp14 boss. When a
 * `pursueArcane` bot lacks one, it spends a monster-reward token on an Arcane Abyss Summon to
 * fish for it (its starting Fairy relics fuel the "any relic" awaken cost).
 */
function hasArcaneSource(player: BotPlayer): boolean {
	if (player.attackDice.some((d) => d.tier === 'arcane')) return true;
	const c = awakenedClassCounts(player);
	return (
		(c['Arcane Advisor'] ?? 0) > 0 ||
		(c['Dragon Warrior'] ?? 0) > 0 ||
		(c['The Corruptor'] ?? 0) > 0 ||
		(c['Firekeeper'] ?? 0) > 0 // grants a free arcane die on awaken
	);
}

/** Climb-compressors the bot fishes the Abyss for: combat damage MITIGATION (so barrier survives two
 *  top-rung hits → fewer restore-barrier rounds) or Dark Assassin's odd-barrier damage-double (one-shot the boss).
 *  These are the levers that collapse the ~17-round climb; all are Abyss-only (cost 7-9). */
function hasClimbCompressor(player: BotPlayer): boolean {
	const c = awakenedClassCounts(player);
	return (
		(c['Aquamaiden'] ?? 0) > 0 ||
		(c['Golem of Wishes'] ?? 0) > 0 ||
		(c['Firekeeper'] ?? 0) > 0 ||
		(c['Guardian'] ?? 0) > 0 ||
		(c['Dark Assassin'] ?? 0) > 0
	);
}

/**
 * Marginal value of adding/owning a spirit of class `cls`, given current awakened counts.
 * Centralizes the build's economy: gate-resource Cultivators while max barrier is short, one
 * Healer for sustain, Fighters until dice are nearly built, a couple Elementalists, and
 * flat-damage/arcane classes always (they raise the boss-rung kill ceiling). Shared by the
 * recruit scorer and the cull scorer so "what to keep" and "what to add" stay consistent.
 */
function classNeedValue(
	cls: string,
	counts: Record<string, number>,
	player: BotPlayer,
	profile: BotProfile,
	damaging: boolean
): number {
	const c = counts[cls] ?? 0;
	const needDice = !atDiceCap(player, profile);
	const needMaxBarrier = player.maxBarrier < profile.maxBarrierTarget;
	const hasUpgradable = player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
	switch (cls) {
		case 'Fighter':
			// The dice FOUNDATION — top priority until dice are capped (each rest adds dice),
			// then dead weight (the dice persist when the Fighter is released).
			return needDice ? (c < FIGHTER_SOFT_CAP ? 8 : 2) : 0;
		case 'Cultivator': {
			// The max barrier engine — built in parallel with dice; culled once max barrier is maxed.
			// `cultivatorTarget` sets how many to stack (more → faster max barrier, see the knob doc).
			const want = profile.cultivatorTarget ?? CULTIVATOR_WANTED;
			return needMaxBarrier ? (c < want ? 8 : 1) : 0;
		}
		case 'Cursed Spirit':
			// Corruption / PvP build: each awakened Cursed Spirit turns a corruption CROSSING into
			// rewards (Tainted → +1 max barrier, Corrupt → relic, Fallen → augment). It keeps paying
			// out until the player has crossed every threshold (Fallen), so it stays HIGH-value
			// through the descent — never shed it to the forced corruption-sacrifice while we can
			// still bank a crossing. Recruit a few while short; once Fallen it is spent (value 0).
			if (profile.pursueCorruption || profile.pursuePvp) {
				if ((player.statusLevel ?? 0) >= 3) return 0; // Fallen → all crossings collected
				return c < CURSED_WANTED ? 8 : 3;
			}
			return 0;
		case 'Sharpshooter':
			// The corruption build's KEY enabler — "attack at the same time as the enemy" lets it
			// kill through a corrupting hit (and +1 flat damage). Otherwise just a flat-damage class.
			if (profile.pursueCorruption) return c < 1 ? 9 : 2;
			return damaging ? (needDice ? 2 : 6) : 0;
		case 'Elementalist': {
			// Dice QUALITY is the single biggest firepower lever: upgrading a die basic→enchanted
			// →exalted adds ~0.67 expected per tier, so across a full 10-die pool it is worth ~+6.7
			// damage — it dwarfs a Spirit Animal's flat +1. Make it the TOP recruit once a real pool
			// of upgradable dice exists, and stack several (each Elementalist upgrades one more die
			// per Rest, so 3 turns the basic→exalted climb from a ~10-round grind into ~3). Falls to
			// 0 once every die is exalted+ (nothing left to upgrade — Elementalists are spent → cull for
			// damage). But while ANY die is still upgradable, EVERY Elementalist is pulling weight and
			// must be HELD: on the super-linear curve count 4-5 upgrades 5-10 dice/Rest, whereas shedding
			// one back to count 2-3 collapses throughput to 1-2/Rest and triggers a 20+ round grind
			// (the dominant failure we saw). So keep them ALL high-value until the pool is fully exalted —
			// recruit alongside Fighters (each Rest then both adds AND upgrades dice).
			const upgradable = player.attackDice.filter((d) => d.tier === 'basic' || d.tier === 'enchanted').length;
			const buildingDice = !atDiceCap(player, profile) && (counts['Fighter'] ?? 0) >= 2;
			if (upgradable === 0 && !buildingDice) return 0; // useless before a dice pool exists
			// Hold/recruit up to count 5 (= upgrade all 10 dice in ONE Rest); never shed below that
			// while dice remain upgradable. (c is the effective count incl. augments; keepValue's
			// owned-discount means a held set of 5 reads as 4 < 5 → still 8 → never culled mid-upgrade.)
			return c < 5 ? 8 : 1;
		}
		case 'Healer':
			// Sustain is a PREREQUISITE for the climb (restore barrier between fights instead of burning the
			// scarce corruption budget), so the one Healer outranks even the flat-damage stack —
			// never let a Spirit Animal displace it, or the build strands itself unable to restore barrier.
			// Worthless beyond the first (its +3/rest doesn't stack).
			return c < HEALER_WANTED ? 11 : 0;
		case 'Soul Weaver':
			// Healer-less sustain. Hold off while still laying the dice foundation, then assemble
			// the count-3 barrier restore. Worthless once a Healer already covers sustain.
			if ((counts['Healer'] ?? 0) >= HEALER_WANTED || c >= SOUL_WEAVER_WANTED) return 0;
			return needDice ? 2 : 6;
		case 'Ironmane':
			// ACTION ECONOMY: +1 Monster-Combat per round (fight TWICE per Abyss visit) → climbs the
			// 8-rung ladder in roughly half the Abyss visits. One is plenty; barrier can't usually
			// fuel more than two fights between heals anyway. A top recruit (cheap, cost-1 Hero).
			return c < 1 ? 9 : 0;
		case 'Child Prodigy':
			// ACTION ECONOMY: +1 of EVERY location interaction per round → ~doubles build throughput
			// (rest/cultivate/summon twice per visit). The single biggest build-compressor; worth the
			// Arcane-Abyss recruit. One is plenty (the allowance doesn't stack).
			return c < 1 ? 9 : 0;
		case 'Aquamaiden':
		case 'Golem of Wishes':
		case 'Guardian':
			// CLIMB-COMPRESSORS — combat damage MITIGATION (Aquamaiden −3 / Golem deflect 4 / Guardian
			// skip-a-corrupting-hit). Powerful (barrier survives two top-rung hits → far fewer restore-barrier
			// rounds), and the kill model already reads damageReduction/deflect/skipTakeDamage. BUT their
			// host spirits awaken via a rune_cost / "discard 2 Teapots" the solo bot rarely holds, so a
			// fished copy usually strands FACE-DOWN (un-awakable) and blocks re-fishing. Value moderate:
			// kept if drawn alongside nothing better, never fished-for as a primary plan.
			return c < 1 ? 5 : 1;
		case 'Firekeeper':
			// −3 incoming PLUS a free Arcane die on awaken — but rune_cost awaken, same un-awakable risk.
			return c < 1 ? 5 : 1;
		case 'Dark Assassin':
			// OFFENSE climb-compressor: ODD barrier DOUBLES the whole combat roll → one-shots the boss
			// from a 10-exalted pool (avg 10 → 20). RELIABLY AWAKABLE — its host (Lightcatcher) flips by
			// "discard 3 Elementalist Traits", which the bot holds once dice are exalted (spent
			// Elementalists). So this is a real fish target. Gate the high value on having ≥3 Elementalist
			// traits to discard, else it would strand face-down. One is plenty.
			return (awakenedClassCounts(player)['Elementalist'] ?? 0) >= 3 ? (c < 1 ? 9 : 1) : 2;
		case 'Rune Mage':
			// BUILD-COMPRESSOR: trade a Rune → Enchanted die, a Relic → Exalted die — dice straight from
			// the rune/relic economy, bypassing the Fighter(add)→Elementalist(upgrade) two-stage grind.
			// Only while the dice pool is still below cap.
			return !atDiceCap(player, profile) ? (c < 1 ? 8 : 2) : 0;
		default:
			// Flat-damage / arcane classes (Spirit Animal, Sharpshooter, Dragon Warrior, …): the
			// FINAL firepower lever, and the TOP recruit once the dice+max barrier foundation is laid.
			// A 10-exalted pool only averages ~10 damage; one-shotting the hp12/hp14 boss rungs needs
			// ~14-16, and the only way to get there is to STACK flat damage (each Spirit Animal = +1)
			// in every slot the build no longer needs for dice/max barrier/sustain. So value them low
			// while still building the foundation, then high enough to displace spent dead weight.
			if (!damaging) return 0;
			// Flat damage is the LATE lever. Cull it (0) ONLY while slots are still needed for the CORE
			// (2 Fighters for dice, a Healer for sustain, Elementalists for quality while dice remain
			// upgradable). The dominant economy stall was a bot that filled every slot with early
			// flat-damage + Cursed, left NO room for a single Elementalist, and ground out 10 basic dice
			// it could never upgrade (avg ~3.3 → jams at hp4). But ONCE the core is assembled, KEEP flat
			// damage even while finishing dice/max barrier — stacking Spirit Animals in parallel with the
			// late build means the climb STARTS near the boss one-shot (the user's "buy Spirit Animals
			// toward the late game for the final cap"), instead of arriving at the boss with zero flat
			// damage and grinding it one summon/round while the boss sits there.
			const coreShort =
				(counts['Fighter'] ?? 0) < 2 ||
				(!hasSustain(player) && (counts['Healer'] ?? 0) < HEALER_WANTED) ||
				(hasUpgradable &&
					(counts['Elementalist'] ?? 0) < (profile.elementalistTarget ?? ELEMENTALIST_WANTED));
			if (coreShort && needDice) return 0;
			if (needMaxBarrier) return 4;
			return 9;
	}
}

/**
 * Sum the need-value of every class a spirit carries. `owned` distinguishes the two
 * questions that share this scorer: recruiting asks "do I want ONE MORE of this class?"
 * (uses live counts → c < WANTED), while keeping asks "is THIS copy pulling weight?" — for
 * that we discount the spirit's own classes by one, so e.g. a lone Healer reads as still
 * wanted (marginal) rather than "already have one" (and gets wrongly culled).
 */
function spiritNeedValue(
	classes: Record<string, number> | undefined,
	origins: Record<string, number> | undefined,
	player: BotPlayer,
	profile: BotProfile,
	focus: string | null,
	owned: boolean
): number {
	const damaging = (profile.damageClasses ?? []).some((d) => (classes?.[d] ?? 0) > 0);
	const counts = awakenedClassCounts(player);
	const effCounts = owned ? { ...counts } : counts;
	if (owned) {
		for (const cls of Object.keys(classes ?? {})) {
			effCounts[cls] = Math.max(0, (effCounts[cls] ?? 0) - 1);
		}
	}
	let score = 0;
	for (const cls of Object.keys(classes ?? {})) {
		score += classNeedValue(cls, effCounts, player, profile, damaging);
	}
	// Origin focus is now only a MILD economy tiebreaker: concentrating origins squeezes a
	// little more rune yield out of Cultivate (one rune per two same-origin spirits → fewer
	// wasted odd remainders). Max barrier no longer needs an origin trio, so this is a small
	// nudge rather than a build driver.
	// …but only as a tiebreaker between spirits that are ALREADY pulling weight. It must never
	// keep a spent spirit (value 0 — a maxed-out Cultivator, a PvE Cursed Spirit) alive: that
	// clogs the slots the endgame needs for flat-damage Spirit Animals.
	if (profile.originFocus && focus && score > 0 && Object.keys(origins ?? {}).includes(focus)) {
		score += 1;
	}
	return score;
}

/** Score a drawn spirit for recruiting — higher = keep. */
function recruitScore(
	spirit: PlayCatalogSpirit | undefined,
	player: BotPlayer,
	profile: BotProfile,
	focus: string | null
): number {
	if (!spirit) return -1;
	return spiritNeedValue(spirit.classes, spirit.origins, player, profile, focus, false);
}

/** Value of KEEPING an owned spirit (lowest = safest to cull when slots are full). */
function keepValue(
	spirit: { classes?: Record<string, number>; origins?: Record<string, number> },
	player: BotPlayer,
	profile: BotProfile,
	focus: string | null
): number {
	return spiritNeedValue(spirit.classes, spirit.origins, player, profile, focus, true);
}

/**
 * Would Rest pay off now? Fighter adds dice (only under the cap), Elementalist upgrades
 * basic/enchanted dice, Arcane Advisor converts an exalted die to arcane, and Healer
 * restores barrier (sustain between Abyss fights, worth it only below full).
 */
function hasRestPayoff(
	player: BotPlayer | undefined,
	profile: BotProfile,
	barrierCeiling = Infinity
): boolean {
	if (!player) return false;
	const counts = awakenedClassCounts(player);
	const fighter = counts['Fighter'] ?? 0;
	const elementalist = counts['Elementalist'] ?? 0;
	const advisor = counts['Arcane Advisor'] ?? 0;
	const healer = counts['Healer'] ?? 0;
	const soulWeaver = counts['Soul Weaver'] ?? 0;
	const dice = player.attackDice;
	const hasUpgradable = dice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
	const hasExalted = dice.some((d) => d.tier === 'exalted');
	// Restore barrier only up to `barrierCeiling` (the caller passes combat-ready = toughest damage + 1; defaults
	// to "to full" for the built-out check). Restoring past combat-ready just burns Floral rounds.
	const wounded = player.barrier < Math.min(player.maxBarrier, barrierCeiling);
	return (
		(!atDiceCap(player, profile) && fighter >= 2) ||
		(elementalist >= 2 && hasUpgradable) || // count 1 upgrades nothing on the super-linear curve
		(advisor >= 1 && hasExalted) ||
		(wounded && (healer >= HEALER_WANTED || soulWeaver >= SOUL_WEAVER_WANTED))
	);
}

/**
 * "Topped out": dice at the cap, max barrier at target, and Rest no longer helps — so
 * waiting can no longer improve the next fight. At that point the bot should take its
 * best shot (the hp14/dmg10 boss) even at modest odds rather than stall forever.
 */
function isBuiltOut(player: BotPlayer | undefined, profile: BotProfile): boolean {
	if (!player) return false;
	if (!atDiceCap(player, profile)) return false;
	if (player.maxBarrier < profile.maxBarrierTarget) return false;
	if (hasRestPayoff(player, profile)) return false;
	// Capped dice that are still BASIC/ENCHANTED are NOT built out: their TIER can still be
	// upgraded, which is worth far more than another flat point and is the difference between a
	// ~3.3-damage pool (10 basic) and a ~10-damage pool (10 exalted). So a PvE build with
	// upgradable dice must keep building QUALITY (recruit an Elementalist, Rest to upgrade)
	// rather than declaring itself done and climbing the hp-rich rungs with weak dice — that
	// premature "built out" is exactly what stranded the old bot in an 80-round stall. Corruption
	// / PvP builds skip this (they win by descending, not by dice quality).
	if (!profile.pursueCorruption && !profile.pursuePvp) {
		// Sustain (a Healer / 3 Soul Weavers) is a hard climb prerequisite — without renewable
		// barrier the build strands itself unable to restore barrier between fights (the corruption budget
		// runs out at Fallen, well short of 30 VP). A sustain-less PvE build is NEVER "done": keep
		// building (summon for a Healer) rather than climbing into a deadlock. Mirrors readyToClimb.
		if (!hasSustain(player) && !canRestoreBarrierViaEconomy(player)) return false; // a Healer OR the relic/rune→barrier economy
		if (player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted')) return false;
	}
	return true;
}

/** Expected attack damage = Σ per-die face averages + flat combat bonus, × multiplier
 *  (firing the inCombat trigger on a clone so Spirit-Animal/Sharpshooter bonuses count). */
function expectedAttack(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): number {
	const sim = cloneForCombatSim(state);
	const player = sim.players[seat];
	if (!player) return 0;
	resetCombatFlags(player);
	applyTrigger(sim, seat, 'inCombat', [], { catalog });
	let avg = 0;
	for (const die of player.attackDice) {
		const faces = DICE_TIER_FACES[die.tier];
		if (faces && faces.length) avg += faces.reduce((a, b) => a + b, 0) / faces.length;
	}
	return (avg + (player.combatDamageBonus ?? 0)) * (player.combatDamageMultiplier ?? 1);
}

/** The toughest rung's HP — the damage the build must reach to clear the boss. */
function maxLadderHp(catalog: PlayCatalog): number {
	return (catalog.monsters ?? []).reduce((m, x) => Math.max(m, x.barrier ?? 0), 1);
}

/** The toughest rung's DAMAGE — the barrier the build must keep above to fight without corrupting.
 *  The bot needs to restore barrier only to ~this (+1 buffer), NOT to a bloated max barrier; restoring
 *  past combat-ready just burns Floral rounds. */
function maxLadderDamage(catalog: PlayCatalog): number {
	return (catalog.monsters ?? []).reduce((m, x) => Math.max(m, x.damage ?? 0), 1);
}

/**
 * Is the build strong enough to START climbing? Killing advances the ladder to a tougher
 * monster, so we hold at rung 0 (building) until max barrier is maxed, dice are capped, and
 * expected damage nears the toughest rung's HP — THEN blitz the whole ladder while it's at
 * full strength, rather than advancing under-built and bleeding the tableau to corruption.
 */
function readyToClimb(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profile: BotProfile
): boolean {
	const player = state.players[seat];
	if (!player) return false;
	if (player.maxBarrier < profile.maxBarrierTarget) return false;
	// NOTE: deliberately NOT requiring the full 10-dice cap. Holding at rung 0 until every die is built
	// serialized the whole build BEFORE the climb; instead start once expected damage clears the climb
	// threshold below (reachable with a partial-but-upgraded pool + flat damage) and finish the last
	// dice DURING the easy-rung climb. The boss-rung `wantMoreDamage` gate still forces a full build
	// before the hp12 boss, and every individual fight stays corruption-gated, so this only overlaps the
	// safe early rungs with the tail of the build — it never throws an under-built bot at a hard rung.
	// Climbing the whole ladder needs renewable barrier (a Healer / 3 Soul Weavers) so we
	// don't burn the corruption budget; without it the climb stalls and falls out at Fallen.
	if (!hasSustain(player) && !canRestoreBarrierViaEconomy(player)) return false; // a Healer OR the relic/rune→barrier economy
	return expectedAttack(state, seat, catalog) >= maxLadderHp(catalog) * (profile.climbReadyFactor ?? 0.9);
}

/**
 * Can this build still meaningfully RAISE its firepower RIGHT NOW? True when:
 *  • upgradable dice remain (an Elementalist can lift basic/enchanted → exalted), or
 *  • arcane is wanted but not yet sourced (a `pursueArcane` build), or
 *  • there's a FREE slot to summon another flat-damage spirit into.
 * Deliberately does NOT count "cullable dead weight" as improvable: on a full tableau the bot
 * often CAN'T actually convert that slot to damage soon (the replacement Spirit Animal hasn't been
 * drawn), so treating it as improvable made the boss-rung gate STALL for dozens of rounds. When
 * none of the above hold, the build is damage-maxed FOR NOW → take the best shot; the normal cull
 * + recruit loop still raises damage between attempts, so a miss isn't wasted.
 */
function canStillRaiseDamage(player: BotPlayer, profile: BotProfile): boolean {
	// Upgradable (basic/enchanted) dice only RAISE damage if we can ACTUALLY upgrade them: an
	// Elementalist count ≥2 (the curve's first productive breakpoint — count 1 upgrades nothing), or a
	// relic to buy the augment that reaches ≥2. A lone Elementalist with no relic and full slots leaves
	// the dice FROZEN at tier — counting them as "raisable" kept wantMoreDamage's high fight-bar up and
	// the bot summoned forever at the boss instead of taking its shot (the cullean boss-stall deadlock).
	if (player.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted')) {
		const ele = awakenedClassCounts(player)['Elementalist'] ?? 0;
		const hasRelic = player.mats.some((r) => r.hasRune && r.type === 'relic');
		if (ele >= 2 || (ele >= 1 && hasRelic)) return true;
	}
	if (profile.pursueArcane && !hasArcaneSource(player)) return true;
	if (player.spirits.length < spiritLimitFor(player.statusLevel)) return true;
	// Slot-free flat damage: a Spirit Animal augment (+1 combat damage each) placed on any awakened
	// host. The relic that pays for it is pure action economy (Cultivate → origin runes → relic
	// trade, plus monster-reward relics), so this is a near-unlimited damage cap — keep buying until
	// the boss one-shots. Gated on having augment capacity AND a way to fund a relic.
	if (hasAugmentCapacity(player) && player.mats.some((r) => r.hasRune && r.type === 'relic')) return true;
	return false;
}

/**
 * The strategic policy — a SAFE SCALER. Same trial-apply legality threading as the random
 * policy, but goal-driven: only fight when the hit is survivable AND the kill odds clear
 * the bar; otherwise build at the Spirit World — cultivate for max barrier (via
 * ≥2 awakened Cultivators), rest for dice/upgrades/barrier restores, and recruit toward the binding
 * need (max barrier → dice → flat damage).
 */
export function planMediumPhaseActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rng: BotRandom,
	profile: BotProfile
): GameCommand[] {
	if (!botSeatNeedsToAct(state, seat)) return [];

	const commands: GameCommand[] = [];
	let working = structuredClone(state);

	const tryEmit = (command: GameCommand): boolean => {
		const next = advanceWorking(working, seat, command, catalog);
		if (next === null) return false;
		working = next;
		commands.push(command);
		return true;
	};

	// Resolve open summon draws, keeping the highest-scoring spirit each cycle and
	// discarding the rest. When the tableau is full, cull the lowest-value owned spirit
	// (e.g. a now-useless Fighter) to make room for a clearly better one. Returns true iff
	// it spawned/swapped in a new spirit (so the recruit loop knows it made progress).
	const placePreferred = (): boolean => {
		let placed = false;
		let guard = 0;
		while (working.players[seat]?.pendingDraw && guard < 24) {
			guard += 1;
			const player = working.players[seat];
			if (!player) break;
			const hand = player.handDraws ?? [];
			if (hand.length === 0) break;
			const focus = profile.originFocus ? focusOriginFor(player) : null;
			const best = [...hand]
				.map((d) => ({ d, score: recruitScore(catalogSpiritById(catalog, d.id), player, profile, focus) }))
				.sort((a, b) => b.score - a.score)[0];
			if (!best || best.score <= 0) {
				tryEmit({ type: 'discardHandDraws' }); // nothing worth keeping → close the draw
				break;
			}
			if (player.spirits.length >= spiritLimitFor(player.statusLevel)) {
				// Slots full: swap out the lowest-value spirit only if the recruit is clearly better.
				const worst = [...player.spirits]
					.map((s) => ({ s, v: keepValue(s, player, profile, focus) }))
					.sort((a, b) => a.v - b.v)[0];
				if (
					worst &&
					best.score > worst.v + 1 &&
					tryEmit({ type: 'discardSpirit', slotIndex: worst.s.slotIndex }) &&
					tryEmit({ type: 'spawnHandSpirit', guid: best.d.guid })
				) {
					placed = true;
					continue;
				}
				tryEmit({ type: 'discardHandDraws' });
				break;
			}
			if (tryEmit({ type: 'spawnHandSpirit', guid: best.d.guid })) {
				placed = true;
				continue;
			}
			tryEmit({ type: 'discardHandDraws' });
			break;
		}
		return placed;
	};

	// Pay down a forced corruption-discard obligation by shedding the lowest-value spirits.
	// Corruption healed the bot instantly; this owes an escalating spirit sacrifice that blocks
	// ending the turn until paid, so the bot sheds its worst spirits to clear it.
	const resolveCorruptionDiscard = (): void => {
		let guard = 0;
		while (guard < 16) {
			guard += 1;
			const player = working.players[seat];
			const obligation = player?.pendingCorruptionDiscard ?? null;
			if (!player || !obligation || obligation.count <= 0 || player.spirits.length === 0)
				break;
			const focus = profile.originFocus ? focusOriginFor(player) : null;
			const worst = [...player.spirits]
				.map((s) => ({ s, v: keepValue(s, player, profile, focus) }))
				.sort((a, b) => a.v - b.v)[0];
			if (!worst || !tryEmit({ type: 'discardSpirit', slotIndex: worst.s.slotIndex })) break;
		}
	};

	switch (state.phase) {
		case 'navigation': {
			const player = working.players[seat];
			const monster = working.monster;
			// Evil-hunter line. Once Fallen, stop fighting monsters and HUNT: lock the first
			// Spirit-World location (where the Good economy bots cluster) so we share a location
			// and can launch the +3-VP group attack. Before Fallen, once we hold a couple of
			// Cursed Spirits and some fodder to sacrifice, DESCEND by corrupting at the Abyss
			// (each crossing pays the Cursed Spirits out). Otherwise fall through to the normal
			// build to gather that Cursed core + fodder first.
			if (profile.pursuePvp && player) {
				const fallen = (player.statusLevel ?? 0) >= 3;
				if (fallen) {
					const hunt = chooseSpiritWorld(working, seat, catalog, profile, rng);
					if (hunt) {
						tryEmit({ type: 'lockNavigation', destination: hunt });
						break;
					}
				} else {
					const cursedHeld = awakenedClassCounts(player)['Cursed Spirit'] ?? 0;
					const abyssOpen =
						monster != null &&
						isLegal(working, seat, { type: 'lockNavigation', destination: 'Arcane Abyss' }, catalog);
					const readyToDescend = cursedHeld >= 2 && player.spirits.length >= 5;
					if (readyToDescend && abyssOpen) {
						tryEmit({ type: 'lockNavigation', destination: 'Arcane Abyss' });
						break;
					}
					// else: fall through to the normal build (recruit Cursed Spirits + fodder).
				}
			}
			const pKill = monster
				? computeKillProbability(working, seat, catalog, {
						allowCorruptKill: profile.pursueCorruption === true
					})
				: 0;
			const abyssLegal =
				monster != null &&
				isLegal(working, seat, { type: 'lockNavigation', destination: 'Arcane Abyss' }, catalog);
			// Hold at rung 0 only while STILL building (the build is improving and we haven't
			// reached a sane floor). Once climbing (ladderIndex > 0), the build has plateaued,
			// or we're battle-ready, never block — advancing the ladder before a reasonable
			// floor just bleeds the tableau to corruption, but over-gating strands builds whose
			// max barrier plateaus below the full target.
			const climbFloor =
				(monster?.ladderIndex ?? 0) > 0 ||
				readyToClimb(working, seat, catalog, profile) ||
				isBuiltOut(player, profile);
			// Demand a high kill bar only for the FIRST step (deciding to start climbing); once
			// committed (ladderIndex > 0) or topped out, stalling can't improve the build, so take
			// every survivable shot at the low bar. The hp-rich boss rungs are never a hard wall.
			const committed =
				(monster?.ladderIndex ?? 0) > 0 || isBuiltOut(player, profile) || profile.fightUrgency === true;
			// High-HP "boss" rungs (hp ≥ 10) must be (near-)ONE-SHOT, not ground out: grinding one at
			// coin-flip odds wastes the fight AND the restore-barrier round after each miss — the dominant time sink
			// in long games. So while we can still RAISE firepower (upgrade dice, source arcane, or stack
			// another flat-damage spirit) and expected attack can't yet near-one-shot the toughest rung,
			// demand a high kill bar at a boss rung — routing the bot to BUILD more damage instead. Once
			// the build is damage-maxed (`canStillRaiseDamage` false) this clears, the low bar applies,
			// and it takes its best shot — never deadlocking. Easy rungs (hp < 10) stay urgent.
			const bossRung = (monster?.maxHp ?? monster?.hp ?? 0) >= 10;
			const exp = player != null && monster != null ? expectedAttack(working, seat, catalog) : 0;
			const canRaise = player != null && canStillRaiseDamage(player, profile);
			// At a boss rung, only keep BUILDING damage while we're FAR from a kill (expected attack
			// more than ~2 below the rung HP) AND can still raise it. Once we're within striking range —
			// or damage-maxed — stop stalling and take realistic shots at a low bar, grinding the rung
			// through restore-barrier+retry; chasing the last point or a Spirit Animal that never draws is what
			// caused the 35-round boss stall. Easy rungs (hp < 10) stay urgent at the normal bar.
			const wantMoreDamage = bossRung && exp < maxLadderHp(catalog) && canRaise;
			const bar = wantMoreDamage
				? Math.max(profile.builtOutThreshold, 0.6)
				: bossRung
					? Math.min(profile.builtOutThreshold, 0.25) // realistic boss shots, retry through barrier restores
					: committed
						? profile.builtOutThreshold
						: profile.killThreshold;
			const canFight = abyssLegal && climbFloor && pKill >= bar;
			// Deliberate corruption-reset: corrupting instantly restores barrier to full, a legitimate tempo play —
			// it is FINE for the bot to corrupt itself. But it should PREFER the safe barrier restore when one is
			// available (Cultivate → runes → a rune/relic trade that restores barrier, or a held relic →
			// restore barrier); corruption's escalating spirit-sacrifice makes it a poor *default*. So we only
			// fall back to it when there's neither sustain NOR a way to restore barrier via the location economy.
			// ONLY corruption builds take the reset (they BANK the crossing as a Cursed-Spirit reward). A
			// PvE bot must NOT: its own precondition (maxBarrier > monster.damage) means one free Floral Rest
			// restores barrier above the hit, so a safe fight is always one rest away — corrupting instead
			// spirals to Fallen (the no-Healer death seen). PvE rests; corruption resets.
			const corruptReset =
				profile.pursueCorruption === true &&
				!canFight &&
				abyssLegal &&
				climbFloor &&
				player != null &&
				monster != null &&
				player.barrier <= monster.damage &&
				player.maxBarrier > monster.damage &&
				!hasSustain(player) &&
				!canRestoreBarrierViaEconomy(player) &&
				firepowerKillProbability(working, seat, catalog) >= profile.builtOutThreshold;
			if (canFight || corruptReset) {
				tryEmit({ type: 'lockNavigation', destination: 'Arcane Abyss' });
				break;
			}
			// Build at a SPECIALIZED Spirit World — each location offers exactly one build action
			// (Cultivate @ Lantern Canyon, Rest @ Floral Patch, Summon @ Tidal Cove), and you visit
			// only ONE per round. Pick the action the build needs most right now.
			const buildDest = chooseBuildDestination(working, seat, catalog, profile, rng);
			if (buildDest) tryEmit({ type: 'lockNavigation', destination: buildDest });
			else {
				const any = pick(rng, ALL_DESTINATIONS as readonly NavigationDestination[]);
				if (any) tryEmit({ type: 'lockNavigation', destination: any });
			}
			break;
		}

		case 'encounter': {
			// Evil aggressors launch the unanimous group attack (+3 VP each) when Good players
			// share their location; the strike fires once every co-located Evil seat has voted
			// to attack. PvE builds never initiate, so they just become ready.
			if (profile.pursuePvp && canInitiatePvp(working, seat, catalog)) {
				tryEmit({ type: 'initiatePvp' });
				break;
			}
			tryEmit({ type: 'passEncounter' });
			break;
		}

		case 'location': {
			const destination = working.players[seat]?.navigationDestination ?? null;
			const config = destination ? getLocationConfig(destination) : null;

			if (config?.combatOnly) {
				// Arcane Abyss: fight, then claim rewards. Default = VP-first; a `pursueArcane` bot
				// that has no arcane source yet instead banks an Arcane Abyss Summon (to fish for
				// Arcane Advisor / Dragon Warrior) + a relic (awaken fuel), then VP for the rest.
				// Fight UP TO the combat allowance (Ironmane → 2 fights per Abyss visit): the first
				// fight is justified by the navigation gate; each bonus fight proceeds only if the
				// now-advanced rung is survivable AND a likely kill (pk≥0.5), so barrier isn't wasted.
				let combatGuard = 0;
				while (
					combatGuard < 4 &&
					isLegal(working, seat, { type: 'startCombat' }, catalog) &&
					(combatGuard === 0 ||
						computeKillProbability(working, seat, catalog, {
							allowCorruptKill: profile.pursueCorruption === true
						}) >= 0.5)
				) {
					combatGuard += 1;
					tryEmit({ type: 'startCombat' });
					const pending = working.players[seat]?.pendingReward;
					if (pending) {
						const opts = buildMonsterRewards(pending.rewardTrack);
						const picks: number[] = [];
						const choices: number[] = [];
						const rp = working.players[seat];
						// Only chase arcane ONCE THE CORE BUILD IS DONE (dice capped, max barrier maxed,
						// sustain in place). Chasing it early starves VP + clutters slots and tanks the
						// win rate — arcane only matters for the hp12/14 boss, which the core build
						// reaches last anyway.
						const coreBuildDone =
							rp != null &&
							atDiceCap(rp, profile) &&
							rp.maxBarrier >= profile.maxBarrierTarget &&
							hasSustain(rp);
						// Once the core build is done, fish for an arcane source by claiming ONE Abyss
						// Summon (the starting Fairy relics pay its "any relic" awaken cost). Stop the
						// moment we own one — awakened OR face-down OR currently in hand — so we never
						// pile up summons; and we ALWAYS keep a VP token alongside (the vpRanked fill
						// below), so VP never stalls. Arcane then converts in via Arcane Advisor's rest.
						const ownsArcane =
							rp != null &&
							(hasArcaneSource(rp) ||
								rp.spirits.some(
									(s) =>
										(s.classes?.['Arcane Advisor'] ?? 0) > 0 ||
										(s.classes?.['Dragon Warrior'] ?? 0) > 0
								) ||
								rp.spirits.some((s) => s.isFaceDown) ||
								(rp.pendingDraw ?? false));
						if (profile.pursueArcane && rp && coreBuildDone && !ownsArcane && pending.chooseAmount >= 2) {
							const summon = opts.find(
								(o) => o.effect.type === 'action' && o.effect.action === 'abyssSummon'
							);
							if (summon) {
								picks.push(summon.index);
								choices.push(0);
							}
						}
						// Grab ONE relic from the kill while the build still needs to fund Spirit Animal
						// augments to reach the boss one-shot — the climb's reward track is the free relic
						// supply for the late-game damage cap (each relic → a +1-damage Animal augment).
						{
							const rpNow = working.players[seat];
							const needRelicForAug =
								rpNow != null &&
								hasAugmentCapacity(rpNow) &&
								expectedAttack(working, seat, catalog) < maxLadderHp(catalog) + 1 &&
								picks.length < pending.chooseAmount;
							if (needRelicForAug) {
								const relicOpt = opts.find(
									(o) =>
										!picks.includes(o.index) &&
										o.effect.type === 'chooseRune' &&
										o.effect.options.some((opt) => opt.type === 'relic')
								);
								if (relicOpt && relicOpt.effect.type === 'chooseRune') {
									const ci = relicOpt.effect.options.findIndex((opt) => opt.type === 'relic');
									picks.push(relicOpt.index);
									choices.push(ci >= 0 ? ci : 0);
								}
							}
						}
						// Fill the remaining slots with the most valuable VP tokens.
						const vpRanked = opts
							.filter((o) => !picks.includes(o.index))
							.map((o) => ({ o, vp: o.effect.type === 'vp' ? o.effect.amount : 0 }))
							.sort((a, b) => b.vp - a.vp);
						for (const r of vpRanked) {
							if (picks.length >= pending.chooseAmount) break;
							picks.push(r.o.index);
							choices.push(0);
						}
						tryEmit({ type: 'resolveMonsterReward', picks, choices });
						placePreferred();
					} else {
						break; // no kill → stop swinging (don't loop on a still-legal startCombat)
					}
				}
			} else if (destination) {
				// Spirit World: a location's actions ARE its reward rows. Play it like a real player —
				// resolve EVERY worthwhile interaction here (the free build action, free heals/runes,
				// AND any affordable trade we want — relics, heals, class runes), not just one. Re-scan
				// after each resolve because affordability and what's wanted both change; place any
				// summoned spirits between rows (a pending draw blocks the next interaction).
				const cur = () => working.players[seat];
				const placeAugments = () => {
					let guard = 0;
					while (guard < 8) {
						guard += 1;
						const p = cur();
						const aug = p?.unplacedAugments?.[0];
						if (!p || !aug) break;
						// Place on the awakened spirit with free capacity AND the HIGHEST keep-value, so the
						// augment lands on a PERMANENT host (Healer / Elementalist / Spirit Animal) rather than
						// spent dead weight (a Fighter about to be culled). Augments count toward a class
						// breakpoint only while their host is awakened, so an augment on a soon-culled host is
						// thrown away — exactly what was collapsing the held Elementalist count mid-upgrade.
						const focus = profile.originFocus ? focusOriginFor(p) : null;
						const target = [...p.spirits]
							.filter((s) => {
								if (s.isFaceDown) return false;
								const placed = (p.spiritAugmentAttachments ?? []).filter(
									(a) => a.spiritSlotIndex === s.slotIndex && typeof a.className === 'string'
								).length;
								return placed < augmentCapacityForSpirit(s);
							})
							.sort((a, b) => keepValue(b, p, profile, focus) - keepValue(a, p, profile, focus))[0];
						if (!target) {
							// No host spirit can take it (all at augment capacity) — forfeit the rest so
							// the unplaceable augments never stall the round.
							tryEmit({ type: 'discardUnplacedAugments' });
							break;
						}
						if (!tryEmit({ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: aug.runeId, spiritSlotIndex: target.slotIndex })) break;
					}
				};
				let interactGuard = 0;
				while (interactGuard < 16) {
					interactGuard += 1;
					const p = cur();
					if (!p) break;
					// A pending/held draw must be resolved before the engine allows another row.
					if (p.pendingDraw || p.handDraws.length > 0) {
						if (!placePreferred() && !tryEmit({ type: 'discardHandDraws' })) break;
						continue;
					}
					// Each row is repeatable up to its allowance (Child Prodigy's locationInteraction
					// credit lets the build action — rest/cultivate/summon/trade — run twice per visit,
					// ~doubling build throughput per round).
					const rowAllowance = 1 + (p.extraActions?.locationInteraction ?? 0);
					const next = locationInteractionsFor(catalog, destination).find(
						(r) =>
							p.actionsUsedThisRound.filter((a) => a === `row:${r.rowIndex}`).length < rowAllowance &&
							wantsInteraction(p, profile, r, catalog)
					);
					if (!next) break;
					if (!tryEmit({ type: 'resolveLocationInteraction', rowIndex: next.rowIndex, choices: augmentChoices(p, profile, next, catalog) })) break;
					placeAugments(); // place any augment that row just granted — same turn, never unplaced
				}
				// Release dead-weight spirits (value 0). Their banked dice / max barrier persist, so
				// freeing the slot lets the tableau pivot to sustain (Soul Weaver / Healer) + damage.
				let cullGuard = 0;
				while (cullGuard < 8) {
					cullGuard += 1;
					const p = cur();
					if (!p || p.spirits.length <= 1) break;
					const focus = profile.originFocus ? focusOriginFor(p) : null;
					const worst = [...p.spirits]
						.map((s) => ({ s, v: keepValue(s, p, profile, focus) }))
						.sort((a, b) => a.v - b.v)[0];
					if (!worst || worst.v > 0) break; // only release truly valueless spirits
					if (!tryEmit({ type: 'discardSpirit', slotIndex: worst.s.slotIndex })) break;
				}
				// ENDGAME DAMAGE PIVOT: once the core build is done (dice exalted, max barrier maxed),
				// ruthlessly free slots for flat-damage Spirit Animals — the only way to reach the ~16
				// expected the hp14 boss one-shot needs. Cull any spirit that contributes NO combat damage
				// and isn't sustain (Healer) or combat economy (Ironmane): spent Cultivators, PvE
				// Cursed/Soul-Weaver duals, and used-up Elementalists clog the boss-killing slots.
				{
					const dmgClasses = profile.damageClasses ?? [];
					const keepers = new Set(['Healer', 'Ironmane']);
					let g2 = 0;
					while (g2 < 8) {
						g2 += 1;
						const p = cur();
						if (!p || p.spirits.length <= 1) break;
						const built =
							atDiceCap(p, profile) &&
							p.maxBarrier >= profile.maxBarrierTarget &&
							!p.attackDice.some((d) => d.tier === 'basic' || d.tier === 'enchanted');
						if (!built) break;
						const victim = p.spirits.find(
							(s) =>
								!s.isFaceDown &&
								!dmgClasses.some((d) => (s.classes?.[d] ?? 0) > 0) &&
								!Object.keys(s.classes ?? {}).some((c) => keepers.has(c))
						);
						if (!victim || !tryEmit({ type: 'discardSpirit', slotIndex: victim.slotIndex })) break;
					}
				}
			}
			// Corruption taken this turn (e.g. fighting the Abyss monster) may owe a forced
			// discard that blocks ending the turn — pay it down before passing.
			resolveCorruptionDiscard();
			tryEmit({ type: 'endLocationActions' });
			break;
		}

		case 'benefits': {
			// Claim any pending Cursed Spirit Awakening-Phase rewards — the Benefits step
			// can't advance while a claim is pending.
			if (working.players[seat]?.pendingAwakenReward) {
				// Take the Tainted corruption reward as MAX BARRIER while still below the max barrier
				// target (99 → runtime clamps to the grant amount), else as Enchanted dice. This
				// is what makes Cursed Spirits a real max barrier engine. Corrupt→relic / Fallen→
				// augment are auto-granted regardless of this choice.
				const cp = working.players[seat];
				const wantMaxBarrier = cp && cp.maxBarrier < profile.maxBarrierTarget ? 99 : 0;
				tryEmit({ type: 'resolveAwakenReward', taintedMaxBarrier: wantMaxBarrier, relicPicks: [] });
			}
			tryEmit({ type: 'commitBenefits' });
			break;
		}

		case 'awakening': {
			// Awaken everything eligible so newly-recruited classes count immediately.
			for (const slotIndex of [...(working.players[seat]?.awakenEligible ?? [])]) {
				tryEmit({ type: 'awakenSpirit', slotIndex });
			}
			tryEmit({ type: 'commitAwakening' });
			break;
		}

		case 'cleanup': {
			let runeGuard = 0;
			while (runeGuard < 16) {
				const held = (working.players[seat]?.mats ?? []).filter((r) => r.hasRune);
				if (held.length <= RUNE_CARRY_LIMIT) break;
				runeGuard += 1;
				// An arcane-pursuing bot hoards RELICS (they pay the "any relic" awaken cost for the
				// arcane spirits), so it sheds plain runes first and only drops a relic as a last resort.
				const nonRelic = held.filter((r) => r.type !== 'relic');
				const droppable = profile.pursueArcane && nonRelic.length > 0 ? nonRelic : held;
				const drop = droppable[droppable.length - 1];
				if (!drop || !tryEmit({ type: 'discardRune', slotIndex: drop.slotIndex })) break;
			}
			// Shed the owed corruption-sacrifice spirits (lowest keep-value first) until the
			// debt clears — cleanup can't be committed while a corruption obligation lingers.
			{
				let corruptionGuard = 0;
				while (corruptionGuard < 16) {
					corruptionGuard += 1;
					const player = working.players[seat];
					const obligation = player?.pendingCorruptionDiscard ?? null;
					if (!player || !obligation || obligation.count <= 0 || player.spirits.length === 0) break;
					const focus = profile.originFocus ? focusOriginFor(player) : null;
					const worst = [...player.spirits]
						.map((s) => ({ s, v: keepValue(s, player, profile, focus) }))
						.sort((a, b) => a.v - b.v)[0];
					if (!worst || !tryEmit({ type: 'discardSpirit', slotIndex: worst.s.slotIndex })) break;
				}
			}
			tryEmit({ type: 'commitCleanup' });
			break;
		}
	}

	return commands;
}

// ════════════════════════════════════════════════════════════════════════════
// Rollout search (the "definitively stronger" dial for the top tiers)
//
// At the one decision that most shapes tempo + safety — fight the monster NOW vs.
// build a bit more — the search plays each option forward a short horizon `searchRollouts`
// times with the base heuristic as the rollout policy, scores the resulting position, and
// picks the option with the best mean value (win-fast first, then board progress). It only
// fires when fighting is a LIVE choice (survivable, legal, building still helps), so most
// rounds cost nothing. Truncated + valued (not played to game-end) so it stays cheap.
// ════════════════════════════════════════════════════════════════════════════

/** A deterministic BotRandom over a seeded RNG (reproducible rollouts). */
function rngBotRandom(rng: RngState): BotRandom {
	return { int: (m: number) => (m <= 0 ? 0 : nextInt(rng, m)), chance: () => nextInt(rng, 2) === 0 };
}

/**
 * Roll `start` forward up to `horizon` rounds with EVERY seat on the base heuristic (no
 * nested search), then score THIS seat's position. A win inside the horizon scores highest
 * (sooner = more); otherwise we score board progress, so the search values both the
 * immediate VP of fighting AND the setup value of building. The RNG is reseeded so repeated
 * rollouts explore different dice/draws. Truncated (not to game-end) to stay cheap.
 */
function rolloutValue(
	start: PublicGameState,
	ourSeat: SeatColor,
	catalog: PlayCatalog,
	rolloutProfile: BotProfile,
	seed: number,
	horizon: number
): number {
	let s = structuredClone(start);
	const mp = rolloutProfile.searchMultiplayer === true;
	// SOLO mode (default): keep only our seat active. The fight-vs-build decision is about OUR
	// tempo, so simulating just our trajectory is a faithful + ~5× cheaper proxy. MP mode keeps
	// every seat (rivals on the base heuristic) so the value reflects winning the actual RACE —
	// the objective solo rollouts miss, which is why pure-solo search saturated.
	if (!mp) {
		s.activeSeats = [ourSeat];
		for (const k of Object.keys(s.players)) {
			if (k !== ourSeat) delete (s.players as Record<string, unknown>)[k];
		}
	}
	s.rng = createRng(seed);
	const botRng = rngBotRandom(createRng((seed * 2654435761) >>> 0 || 1));
	const stopRound = s.round + horizon;
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (++ticks > 8_000) break;
		let progressed = false;
		for (const seat of s.activeSeats) {
			if (!botSeatNeedsToAct(s, seat)) continue;
			const cmds = planBotPhaseActions(s, seat, catalog, botRng, rolloutProfile);
			for (const c of cmds) {
				const r = applyGameCommand(s, botActorFor(s, seat), c, catalog);
				if (!r.ok) break;
				s = r.state;
				progressed = true;
				if (s.status !== 'active') break;
			}
			if (s.status !== 'active') break;
		}
		if (!progressed && s.status === 'active') {
			const before = `${s.phase}:${s.round}`;
			applyDeadlineAdvance(s, catalog);
			if (`${s.phase}:${s.round}` === before) break;
		}
	}
	const p = s.players[ourSeat];
	if (!p) return 0;
	const elapsed = s.round - start.round;

	if (mp) {
		// RACE value: winning first is everything; an opponent winning is a disaster; otherwise
		// score our VP LEAD over the best rival (so the search prefers lines that get us ahead),
		// plus a little build progress.
		let oppMax = 0;
		for (const seat of s.activeSeats) {
			if (seat === ourSeat) continue;
			oppMax = Math.max(oppMax, s.players[seat]?.victoryPoints ?? 0);
		}
		if (p.victoryPoints >= 30 && p.victoryPoints >= oppMax) return 1000 - elapsed;
		if (oppMax >= 30) return -300 - oppMax; // a rival won the race — worst outcome
		const dmgMp = expectedAttack(s, ourSeat, catalog);
		return (p.victoryPoints - oppMax) * 10 + p.victoryPoints * 3 + dmgMp + (hasSustain(p) ? 4 : 0) - elapsed * 0.3;
	}

	if (p.victoryPoints >= 30) return 1000 - elapsed; // win inside the horizon: sooner = better
	// Otherwise value progress toward a win: VP banked, ladder climbed, and build quality
	// (max barrier, dice, damage, sustain, barrier headroom), minus a small time cost.
	const dmg = expectedAttack(s, ourSeat, catalog);
	return (
		p.victoryPoints * 12 +
		(s.monster?.ladderIndex ?? 0) * 5 +
		Math.min(p.maxBarrier, 10) +
		Math.min(p.attackDice.length, 10) * 0.8 +
		dmg * 1.5 +
		(hasSustain(p) ? 6 : 0) +
		p.barrier * 0.2 -
		elapsed * 0.5
	);
}

/**
 * Decide the navigation destination by rollout search, or return null to defer to the
 * heuristic (when fighting isn't a live tempo choice). Compares "fight the Abyss now" vs
 * "build at the Spirit World" by mean rollout value (win-fast ≫ progress).
 */
function searchNavigation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profile: BotProfile
): GameCommand[] | null {
	const rollouts = profile.searchRollouts ?? 0;
	if (rollouts <= 0 || state.phase !== 'navigation') return null;
	const monster = state.monster;
	const player = state.players[seat];
	if (!monster || !player) return null;

	const abyssLegal = isLegal(state, seat, { type: 'lockNavigation', destination: 'Arcane Abyss' }, catalog);
	const survivable = player.barrier > monster.damage;
	const swDest = (SPIRIT_WORLD_ONLY as readonly NavigationDestination[]).find((d) =>
		isLegal(state, seat, { type: 'lockNavigation', destination: d }, catalog)
	);
	// Only a real choice when we CAN fight survivably AND building could still help.
	if (!abyssLegal || !survivable || !swDest || isBuiltOut(player, profile)) return null;

	const horizon = profile.searchRolloutRounds ?? 12;
	const rolloutProfile: BotProfile = { ...profile, searchRollouts: 0 };
	const candidates: NavigationDestination[] = ['Arcane Abyss', swDest];
	let bestDest: NavigationDestination = candidates[0];
	let bestScore = -Infinity;
	candidates.forEach((dest, ci) => {
		const locked = applyGameCommand(
			structuredClone(state),
			botActorFor(state, seat),
			{ type: 'lockNavigation', destination: dest },
			catalog
		);
		if (!locked.ok) return;
		let total = 0;
		for (let k = 0; k < rollouts; k++) {
			const seed = (state.round * 131 + ci * 977 + k * 31 + 7) >>> 0 || 1;
			total += rolloutValue(locked.state, seat, catalog, rolloutProfile, seed, horizon);
		}
		const score = total / rollouts;
		if (score > bestScore) {
			bestScore = score;
			bestDest = dest;
		}
	});
	return [{ type: 'lockNavigation', destination: bestDest }];
}

// ════════════════════════════════════════════════════════════════════════════
// ISMCTS — Information-Set Monte Carlo Tree Search over the NAVIGATION sequence
//
// The round count is set by the strategic skeleton: which destination you lock each round
// (summon → cultivate → rest/upgrade → buy augments → climb, in the tightest legal order).
// We search that sequence with a real UCT tree: every iteration samples a fresh determinization
// (bag-draw + dice seed), descends the tree picking destinations by UCB1, expands one new node,
// then PLAYS OUT with the base heuristic to game-end and scores by rounds-to-30 (win-fast ≫ all).
// The heuristic resolves everything WITHIN a round (rows, summons, augments, fights, heals,
// cleanup) — ISMCTS only chooses where to go. Every move is trial-applied through the real engine
// (`applyGameCommand`), so the search can only ever take LEGAL actions. Pure given (state, profile).
// ════════════════════════════════════════════════════════════════════════════

interface IsmctsNode {
	children: Map<string, IsmctsNode>;
	visits: number;
	value: number;
}
function newIsmctsNode(): IsmctsNode {
	return { children: new Map(), visits: 0, value: 0 };
}

/** Legal navigation destinations from the current state (trial-applied → legal-only). */
export function legalDestinations(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): NavigationDestination[] {
	return (ALL_DESTINATIONS as readonly NavigationDestination[]).filter((d) =>
		isLegal(state, seat, { type: 'lockNavigation', destination: d }, catalog)
	);
}

/**
 * Lock `dest`, then run the base heuristic for the REST of this round and the following rounds
 * until our seat is again at a navigation decision (next round), or the game ends / horizon hit.
 * Mutates by reassignment; returns the advanced state. The engine RNG (`s.rng`) drives the
 * determinization's bag/dice; `botRng` only breaks heuristic ties.
 */
export function advanceAfterNav(
	s: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	dest: NavigationDestination,
	rolloutProfile: BotProfile,
	botRng: BotRandom,
	stopRound: number
): PublicGameState {
	const locked = applyGameCommand(s, botActorFor(s, seat), { type: 'lockNavigation', destination: dest }, catalog);
	if (!locked.ok) return s;
	s = locked.state;
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (s.phase === 'navigation' && botSeatNeedsToAct(s, seat)) break; // next decision point
		if (++ticks > 4000) break;
		let progressed = false;
		for (const st of s.activeSeats) {
			if (!botSeatNeedsToAct(s, st)) continue;
			const cmds = planBotPhaseActions(s, st, catalog, botRng, rolloutProfile);
			for (const c of cmds) {
				const r = applyGameCommand(s, botActorFor(s, st), c, catalog);
				if (!r.ok) break;
				s = r.state;
				progressed = true;
				if (s.status !== 'active') break;
			}
			if (s.status !== 'active') break;
		}
		if (!progressed && s.status === 'active') {
			const before = `${s.phase}:${s.round}`;
			applyDeadlineAdvance(s, catalog);
			if (`${s.phase}:${s.round}` === before) break;
		}
	}
	return s;
}

/** Play out from `s` with the pure heuristic to game-end / horizon, then score: a win is worth
 *  (1000 − round) so fewer rounds win bigger; a non-win scores board progress, always below any win. */
function ismctsSimValue(
	s: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rolloutProfile: BotProfile,
	botRng: BotRandom,
	stopRound: number
): number {
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (++ticks > 8000) break;
		let progressed = false;
		for (const st of s.activeSeats) {
			if (!botSeatNeedsToAct(s, st)) continue;
			const cmds = planBotPhaseActions(s, st, catalog, botRng, rolloutProfile);
			for (const c of cmds) {
				const r = applyGameCommand(s, botActorFor(s, st), c, catalog);
				if (!r.ok) break;
				s = r.state;
				progressed = true;
				if (s.status !== 'active') break;
			}
			if (s.status !== 'active') break;
		}
		if (!progressed && s.status === 'active') {
			const before = `${s.phase}:${s.round}`;
			applyDeadlineAdvance(s, catalog);
			if (`${s.phase}:${s.round}` === before) break;
		}
	}
	const p = s.players[seat];
	if (!p) return 0;
	if (p.victoryPoints >= 30) return 1000 - s.round; // WIN: fewer rounds → higher (the speed objective)
	const dmg = expectedAttack(s, seat, catalog);
	return (
		p.victoryPoints * 10 +
		(s.monster?.ladderIndex ?? 0) * 5 +
		Math.min(p.maxBarrier, 10) +
		Math.min(p.attackDice.length, 10) * 0.8 +
		dmg * 1.5 +
		(hasSustain(p) ? 6 : 0) +
		p.barrier * 0.2
	);
}

/** UCB1 pick among the node's tried children that are ALSO legal here (determinizations vary). */
function uctSelect(node: IsmctsNode, legal: NavigationDestination[], c: number): NavigationDestination {
	const logN = Math.log(node.visits + 1);
	let best = legal[0];
	let bestScore = -Infinity;
	for (const dest of legal) {
		const child = node.children.get(dest);
		if (!child || child.visits === 0) return dest; // unscored but tried elsewhere → try it
		const score = child.value / child.visits + c * Math.sqrt(logN / child.visits);
		if (score > bestScore) {
			bestScore = score;
			best = dest;
		}
	}
	return best;
}

/**
 * Choose the navigation destination by ISMCTS. Returns the lockNavigation command, or null to
 * defer to the heuristic (not a navigation decision / nothing to search).
 */
function ismctsNavigation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profile: BotProfile
): GameCommand[] | null {
	const iterations = profile.ismctsIterations ?? 0;
	if (iterations <= 0 || state.phase !== 'navigation' || !botSeatNeedsToAct(state, seat)) return null;
	const rootLegal = legalDestinations(state, seat, catalog);
	if (rootLegal.length === 0) return null;
	if (rootLegal.length === 1) return [{ type: 'lockNavigation', destination: rootLegal[0] }];

	const horizon = profile.ismctsHorizon ?? 45;
	const C = profile.ismctsC ?? 1.4;
	// Rollout/execution policy = the heuristic with all search OFF (no nested ISMCTS/rollouts).
	const rolloutProfile: BotProfile = { ...profile, ismctsIterations: 0, searchRollouts: 0 };
	// Heuristic preference, to expand promising destinations FIRST (a cheap prior under a small budget).
	const heurRng = rngBotRandom(createRng((state.round * 7919 + 3) >>> 0 || 1));
	const heurPick = chooseBuildDestination(state, seat, catalog, rolloutProfile, heurRng);
	const order = (dests: NavigationDestination[]): NavigationDestination[] => {
		const pri = (d: NavigationDestination) => (d === heurPick ? 0 : d === 'Arcane Abyss' ? 1 : 2);
		return [...dests].sort((a, b) => pri(a) - pri(b));
	};

	const root = newIsmctsNode();
	for (let iter = 0; iter < iterations; iter++) {
		// Determinization: solo-isolate our seat (the speed objective is our own climb) + fresh seed.
		let s = structuredClone(state);
		s.activeSeats = [seat];
		for (const k of Object.keys(s.players)) if (k !== seat) delete (s.players as Record<string, unknown>)[k];
		const seed = (state.round * 1009 + iter * 2654435761 + 12345) >>> 0 || 1;
		s.rng = createRng(seed);
		const botRng = rngBotRandom(createRng((seed * 40503) >>> 0 || 7));
		const stopRound = state.round + horizon;

		const path: IsmctsNode[] = [root];
		let node = root;
		// SELECTION + EXPANSION
		while (s.status === 'active' && s.round <= stopRound && s.phase === 'navigation' && botSeatNeedsToAct(s, seat)) {
			const legal = legalDestinations(s, seat, catalog);
			if (legal.length === 0) break;
			const untried = order(legal.filter((d) => !node.children.has(d)));
			let dest: NavigationDestination;
			if (untried.length > 0) {
				dest = untried[0];
				const child = newIsmctsNode();
				node.children.set(dest, child);
				node = child;
				path.push(node);
				s = advanceAfterNav(s, seat, catalog, dest, rolloutProfile, botRng, stopRound);
				break; // expanded one node → simulate from here
			}
			dest = uctSelect(node, legal, C);
			node = node.children.get(dest)!;
			path.push(node);
			s = advanceAfterNav(s, seat, catalog, dest, rolloutProfile, botRng, stopRound);
		}
		// SIMULATION + BACKPROP
		const value = ismctsSimValue(s, seat, catalog, rolloutProfile, botRng, stopRound);
		for (const n of path) {
			n.visits += 1;
			n.value += value;
		}
	}

	// Most-visited root child = the robust choice (fall back to heuristic order on ties / empties).
	let best: NavigationDestination | null = null;
	let bestVisits = -1;
	for (const dest of order(rootLegal)) {
		const child = root.children.get(dest);
		const v = child?.visits ?? -1;
		if (v > bestVisits) {
			bestVisits = v;
			best = dest;
		}
	}
	return best ? [{ type: 'lockNavigation', destination: best }] : null;
}

/**
 * Ordered list of commands that take `seat` from "not ready" to "ready/locked"
 * for the CURRENT phase. With the default RANDOM_PROFILE it picks randomly among
 * legal options (the dev "fill empty seats" bot); a `medium` profile delegates to
 * the strategic policy (with optional rollout search at the navigation choice). Each
 * command is validated against the reducer before being included.
 */
export function planBotPhaseActions(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rng: BotRandom = defaultBotRandom(),
	profile: BotProfile = RANDOM_PROFILE
): GameCommand[] {
	if (!botSeatNeedsToAct(state, seat)) return [];
	if (profile.kind === 'medium') {
		if (state.phase === 'navigation') {
			// ISMCTS (tree search) takes priority; then the legacy flat rollout search; else heuristic.
			if ((profile.ismctsIterations ?? 0) > 0) {
				const searched = ismctsNavigation(state, seat, catalog, profile);
				if (searched) return searched;
			}
			if ((profile.searchRollouts ?? 0) > 0) {
				const searched = searchNavigation(state, seat, catalog, profile);
				if (searched) return searched;
			}
		}
		return planMediumPhaseActions(state, seat, catalog, rng, profile);
	}

	const commands: GameCommand[] = [];
	// Thread a working clone so each subsequent legality check sees prior effects.
	let working = structuredClone(state);

	const tryEmit = (command: GameCommand): boolean => {
		const next = advanceWorking(working, seat, command, catalog);
		if (next === null) return false;
		working = next;
		commands.push(command);
		return true;
	};

	// An owed corruption discard blocks ending the location/cleanup phase, so shed the owed
	// spirits (highest slot first) first — otherwise the random driver would stall on the gate.
	{
		let corruptionGuard = 0;
		while (corruptionGuard < 16) {
			corruptionGuard += 1;
			const p = working.players[seat];
			const ob = p?.pendingCorruptionDiscard ?? null;
			if (!p || !ob || ob.count <= 0 || p.spirits.length === 0) break;
			const victim = [...p.spirits].sort((a, b) => b.slotIndex - a.slotIndex)[0];
			if (!victim || !tryEmit({ type: 'discardSpirit', slotIndex: victim.slotIndex })) break;
		}
	}

	switch (state.phase) {
		case 'navigation': {
			const destination = pick(rng, ALL_DESTINATIONS as readonly NavigationDestination[]);
			if (destination) tryEmit({ type: 'lockNavigation', destination });
			break;
		}

		case 'encounter': {
			// Maybe vote to strike the co-located Good players together, else pass (decline).
			if (canInitiatePvp(working, seat, catalog) && rng.chance()) {
				tryEmit({ type: 'initiatePvp' });
			}
			// Whether or not we voted to strike, make sure the seat ends up ready.
			if (botSeatNeedsToAct(working, seat)) tryEmit({ type: 'passEncounter' });
			break;
		}

		case 'location': {
			const destination = working.players[seat]?.navigationDestination ?? null;
			const config = destination ? getLocationConfig(destination) : null;

			if (config?.combatOnly) {
				// Arcane Abyss: maybe fight the invading monster.
				if (rng.chance() && isLegal(working, seat, { type: 'startCombat' }, catalog)) {
					tryEmit({ type: 'startCombat' });
					// A kill opens a reward pick — claim the first `chooseAmount` tokens
					// (it blocks passing otherwise), then drain any summon it opened.
					const pending = working.players[seat]?.pendingReward;
					if (pending) {
						const opts = buildMonsterRewards(pending.rewardTrack).slice(0, pending.chooseAmount);
						tryEmit({
							type: 'resolveMonsterReward',
							picks: opts.map((o) => o.index),
							choices: opts.map(() => 0)
						});
						let guard = 0;
						while (working.players[seat]?.pendingDraw && guard < 16) {
							guard += 1;
							const hand = working.players[seat]?.handDraws ?? [];
							const draw = hand.length > 0 ? pick(rng, hand) : null;
							if (!draw || !tryEmit({ type: 'spawnHandSpirit', guid: draw.guid })) {
								tryEmit({ type: 'discardHandDraws' });
							}
						}
					}
				}
			} else if (destination) {
				// A location's interactions ARE its reward rows. Maybe resolve ONE
				// affordable row (default 'or' choice), then summon/discard any spirits a
				// summon gain drew so the seat can still become ready and pass.
				const locEntry = (catalog.locations ?? []).find((l) => l.name === destination);
				const interactions = buildLocationInteractions(locEntry?.rewardRows);
				if (interactions.length > 0 && rng.chance()) {
					const affordable = interactions.filter(
						(it) =>
							canAfford(it, working.players[seat]?.mats ?? []) &&
							isLegal(
								working,
								seat,
								{ type: 'resolveLocationInteraction', rowIndex: it.rowIndex, choices: [] },
								catalog
							)
					);
					const chosen = pick(rng, affordable);
					if (chosen) {
						tryEmit({ type: 'resolveLocationInteraction', rowIndex: chosen.rowIndex, choices: [] });
						// Drain any summon draws so a pendingDraw never blocks readiness.
						let guard = 0;
						while (working.players[seat]?.pendingDraw && guard < 16) {
							guard += 1;
							const hand = working.players[seat]?.handDraws ?? [];
							const draw = hand.length > 0 ? pick(rng, hand) : null;
							if (!draw || !tryEmit({ type: 'spawnHandSpirit', guid: draw.guid })) {
								tryEmit({ type: 'discardHandDraws' });
							}
						}
					}
				}
			}
			// Corruption is now a CLEANUP-PHASE RITUAL — it no longer blocks ending the
			// Location turn. The bot finishes the round at low barrier and resolves corruption
			// (restore barrier + owed discards) in the cleanup case.
			tryEmit({ type: 'endLocationActions' });
			break;
		}

		case 'benefits': {
			// Claim any pending Cursed Spirit Awakening-Phase rewards — the Benefits step
			// can't advance while a claim is pending.
			if (working.players[seat]?.pendingAwakenReward) {
				// Take the Tainted corruption reward as MAX BARRIER while still below the max barrier
				// target (99 → runtime clamps to the grant amount), else as Enchanted dice. This
				// is what makes Cursed Spirits a real max barrier engine. Corrupt→relic / Fallen→
				// augment are auto-granted regardless of this choice.
				const cp = working.players[seat];
				const wantMaxBarrier = cp && cp.maxBarrier < profile.maxBarrierTarget ? 99 : 0;
				tryEmit({ type: 'resolveAwakenReward', taintedMaxBarrier: wantMaxBarrier, relicPicks: [] });
			}
			tryEmit({ type: 'commitBenefits' });
			break;
		}

		case 'awakening': {
			// Optionally awaken a random subset of awaken-eligible face-down slots.
			const eligible = [...(working.players[seat]?.awakenEligible ?? [])];
			for (const slotIndex of eligible) {
				if (rng.chance()) tryEmit({ type: 'awakenSpirit', slotIndex });
			}
			tryEmit({ type: 'commitAwakening' });
			break;
		}

		case 'cleanup': {
			// Discard overflow runes (newest first) so cleanup can be committed.
			let runeGuard = 0;
			while (runeGuard < 16) {
				const held = (working.players[seat]?.mats ?? []).filter((r) => r.hasRune);
				if (held.length <= RUNE_CARRY_LIMIT) break;
				runeGuard += 1;
				// An arcane-pursuing bot hoards RELICS (they pay the "any relic" awaken cost for the
				// arcane spirits), so it sheds plain runes first and only drops a relic as a last resort.
				const nonRelic = held.filter((r) => r.type !== 'relic');
				const droppable = profile.pursueArcane && nonRelic.length > 0 ? nonRelic : held;
				const drop = droppable[droppable.length - 1];
				if (!drop || !tryEmit({ type: 'discardRune', slotIndex: drop.slotIndex })) break;
			}
			// Shed the owed corruption-sacrifice spirits (lowest keep-value first) until the
			// debt clears — cleanup can't be committed while a corruption obligation lingers.
			{
				let corruptionGuard = 0;
				while (corruptionGuard < 16) {
					corruptionGuard += 1;
					const player = working.players[seat];
					const obligation = player?.pendingCorruptionDiscard ?? null;
					if (!player || !obligation || obligation.count <= 0 || player.spirits.length === 0) break;
					const focus = profile.originFocus ? focusOriginFor(player) : null;
					const worst = [...player.spirits]
						.map((s) => ({ s, v: keepValue(s, player, profile, focus) }))
						.sort((a, b) => a.v - b.v)[0];
					if (!worst || !tryEmit({ type: 'discardSpirit', slotIndex: worst.s.slotIndex })) break;
				}
			}
			tryEmit({ type: 'commitCleanup' });
			break;
		}
	}

	return commands;
}
