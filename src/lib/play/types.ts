import type {
	BagsData,
	ClassBreakpoint,
	GameLocationRewardRow,
	HandDrawSnapshot,
	MatSlotSnapshot,
	SpiritAugmentAttachment
} from '$lib/types';
import type { RngState } from './rng';

export const SEAT_COLORS = ['Red', 'Blue', 'Orange', 'Green', 'Purple', 'Yellow'] as const;
// The four Spirit World locations plus the Arcane Abyss. NOTE: historically this
// list mixed the SW locations and the Abyss together; keep that for backward
// compatibility, but prefer SPIRIT_WORLD_ONLY / ALL_DESTINATIONS below.
export const SPIRIT_WORLD_LOCATIONS = [
	'Floral Patch',
	'Cyber City',
	'Tidal Cove',
	'Lantern Canyon',
	'Arcane Abyss'
] as const;

/** The four navigable Spirit World locations (no Abyss). */
export const SPIRIT_WORLD_ONLY = [
	'Floral Patch',
	'Cyber City',
	'Tidal Cove',
	'Lantern Canyon'
] as const;

/** Every destination a player can navigate to, including the Abyss. */
export const ALL_DESTINATIONS = [...SPIRIT_WORLD_ONLY, 'Arcane Abyss'] as const;

/** First player to reach this Victory Point total wins. */
export const VP_TO_WIN = 30;

/**
 * Hard round cap — round 30 is the last round (≈99% of real games end before then). If cleanup
 * closes on round {@link MAX_ROUNDS} with no VP-target winner, the game ends and the player with
 * the most Victory Points wins (ties → seat order). This bounds episode length for ML training and
 * makes the economy / VP-accumulation line viable: you win by LEADING on VP at the cap, not only by
 * racing to {@link VP_TO_WIN}. (Distinct from the analytics CURVE_POINTS/ROUND_NORM=36 constants.)
 */
export const MAX_ROUNDS = 30;

/**
 * Target player count for a ranked matchmaking lobby. The matchmaker forms a group
 * of exactly this many queued players before creating a ranked game.
 *
 * NOTE: placeholder default — the canonical ranked size is the owner's call; this is
 * 4 until that decision lands. Single source of truth for the matchmaker + queue UI.
 */
export const RANKED_LOBBY_SIZE = 4;

/** Seconds each player has to secretly choose a destination during navigation. Used as
 *  the default-fallback duration only; the live value is the host-configured
 *  {@link PublicGameState.navigationDurationMs} (chosen in the lobby). */
export const NAVIGATION_SECONDS = 60;

/** Default navigation timer (ms) for a fresh lobby. */
export const DEFAULT_NAVIGATION_DURATION_MS = 120_000;

/** Host-selectable navigation-timer presets for the lobby. `ms: null` = no time limit
 *  (navigation only advances once every seat has locked in). */
export const NAVIGATION_TIMER_OPTIONS: { label: string; ms: number | null }[] = [
	{ label: '1:30', ms: 90_000 },
	{ label: '2:00', ms: 120_000 },
	{ label: '3:00', ms: 180_000 },
	{ label: '4:00', ms: 240_000 },
	{ label: '5:00', ms: 300_000 },
	{ label: 'No limit', ms: null }
];

/**
 * Per-phase soft deadlines (seconds). When a phase runs past its deadline the
 * server force-advances it past any silent/disconnected seat — see
 * `enforceRoomDeadlines` in `server/service.ts`. The clock is read ONLY at the
 * server boundary (the pure reducer never reads time); these are just durations.
 * Navigation reuses {@link NAVIGATION_SECONDS} so the existing countdown UI is
 * unchanged. Encounter/Location/Cleanup are longer because a human may be
 * mid-thought (P2 will add activity-based extension on top of these floors).
 */
export const ENCOUNTER_SECONDS = 90;
export const LOCATION_SECONDS = 120;
/** The post-location resolution sequence is split into three short steps. */
export const BENEFITS_SECONDS = 45;
export const AWAKENING_SECONDS = 60;
export const CLEANUP_SECONDS = 45;

/** How long (ms) the given phase may run before the server may force-advance it. */
export function phaseDurationMs(phase: GamePhase): number {
	switch (phase) {
		case 'navigation':
			return NAVIGATION_SECONDS * 1000;
		case 'encounter':
			return ENCOUNTER_SECONDS * 1000;
		case 'location':
			return LOCATION_SECONDS * 1000;
		case 'benefits':
			return BENEFITS_SECONDS * 1000;
		case 'awakening':
			return AWAKENING_SECONDS * 1000;
		case 'cleanup':
			return CLEANUP_SECONDS * 1000;
	}
}

/**
 * Max runes (or relics) a player may CARRY into the next round. A player can hold
 * more than this mid-round (overflow), but must discard down to the limit during
 * the Cleanup phase before the round can advance.
 */
export const RUNE_CARRY_LIMIT = 4;

export type SeatColor = (typeof SEAT_COLORS)[number];
export type SpiritWorldLocation = (typeof SPIRIT_WORLD_LOCATIONS)[number];
export type NavigationDestination = (typeof ALL_DESTINATIONS)[number];
// `closed` is a terminal state for a lobby that was abandoned or aged out before
// the game ever started, or an active game everyone abandoned (see roomLifecycle.ts)
// — distinct from `finished`, which means a real game ran to completion. Closed rooms
// are never listed or joinable.
export type GameSessionStatus = 'lobby' | 'active' | 'finished' | 'closed';

/**
 * A lightweight, public summary of a live room for the server browser. Derived
 * server-side from a {@link PublicGameState} row + the host membership; carries no
 * private/per-seat detail. Only `lobby` and `active` rooms are ever listed.
 */
export interface RoomSummary {
	roomCode: string;
	status: GameSessionStatus;
	/** Display name of the room's host member. */
	hostName: string;
	/** Seats currently claimed (by a human or bot). */
	occupiedSeats: number;
	/** Total seats configured for the room. */
	totalSeats: number;
	/** Round number (0 while still in the lobby). */
	round: number;
	/** Human-readable scenario/world name, when known. */
	scenarioName: string | null;
	createdAt: string;
	startedAt: string | null;
}
export type MemberRole = 'host' | 'player' | 'spectator';
export type RoomChatKind = 'user' | 'system';

export interface RoomChatMessage {
	id: string;
	roomCode: string;
	memberId: string | null;
	authorDisplayName: string;
	authorRole: MemberRole;
	seatColor: SeatColor | null;
	kind: RoomChatKind;
	body: string;
	createdAt: string;
}

export type SpiritSourceBag = 'Spirit World Bag' | 'Arcane Abyss Bag';
export type DiceType = 'attack' | 'special' | 'defense';
export type MatItemKind = 'rune' | 'augment' | 'relic';

// ── Rules-engine additions (2D play mode) ─────────────────────────────────────

// The post-location resolution is split into three sequential steps: `benefits`
// (claim Awakening-Phase class grants — Cursed Spirit, Golden Ruler, …), `awakening`
// (flip & pay for face-down spirits), then `cleanup` (trim runes to the carry limit,
// resolve corruption, pass). Each is a full phase with its own deadline + sync barrier.
export type GamePhase =
	| 'navigation'
	| 'encounter'
	| 'location'
	| 'benefits'
	| 'awakening'
	| 'cleanup';
export const GAME_PHASES: GamePhase[] = [
	'navigation',
	'encounter',
	'location',
	'benefits',
	'awakening',
	'cleanup'
];

/** Corruption ladder, indexed by `statusLevel` (0 = Pure … 3 = Fallen). */
export const STATUS_LADDER = ['Pure', 'Tainted', 'Corrupt', 'Fallen'] as const;
/** Spirit Tableau capacity per corruption stage (Pure most, Fallen fewest). */
export const SPIRIT_LIMIT_BY_STATUS = [7, 6, 5, 4] as const;

/** Only Fallen (3) is Evil-aligned; Pure/Tainted/Corrupt are Good. Drives player-vs-player
 *  combat: an Evil (Fallen) player may attack co-located Good players in the encounter phase. */
export function isEvilAlignment(statusLevel: number): boolean {
	return statusLevel >= 3;
}

/** The spirit-board cap — flat now. Corruption no longer shrinks your slots by status; instead
 *  each corruption forces an escalating sacrifice (see setCorruptionDiscardObligation). */
export const MAX_SPIRITS = 7;
export function spiritLimitFor(_statusLevel?: number): number {
	return MAX_SPIRITS;
}

/**
 * Records the forced corruption discard a player owes — the escalating SACRIFICE cost of
 * corrupting. Corruption itself heals you instantly (in takeDamage); the cost is paid in
 * spirits. Call this AFTER `player.corruptionCount` has been incremented for THIS corruption.
 * The Nth corruption owes N forced discards (1st → 1 spirit, 2nd → 2, 3rd → 3, …); when two
 * corruptions land in one exchange the owed counts ACCUMULATE so none are dropped. The owner
 * chooses which spirits to shed via `discardSpirit`; the deadline drain auto-resolves any
 * remainder. There is no status slot-cap any more.
 *
 * Rules v1.2: corrupting while ALREADY Fallen (`opts.wasFallen` — the caller passes the
 * status BEFORE this corruption, so the 2→3 crossing itself is exempt) converts the
 * unpayable part of the sacrifice into VP loss: 1 VP per owed spirit the player cannot
 * discard, clamped at 0 VP (the adjustVictoryPoints convention). Pre-Fallen corruptions
 * keep the old forgiveness — the descent stays cheap; the Fallen treadmill no longer is.
 * Returns the VP charged (0 when the rule did not fire) so combat callers can log it.
 */
export function setCorruptionDiscardObligation(
	player: PrivatePlayerState,
	reason?: string,
	opts?: { wasFallen?: boolean }
): number {
	const owed = player.corruptionCount ?? 0;
	if (owed <= 0) return 0;
	const existing = player.pendingCorruptionDiscard;
	// You can only ever sacrifice spirits you actually have. Cap the obligation at the
	// current spirit count so corrupting with too few — or zero — spirits never strands an
	// unpayable debt that blocks Cleanup: zero spirits skips the obligation entirely, and
	// fewer spirits than owed just sheds every remaining spirit, then clears.
	const available = player.spirits?.length ?? 0;
	const desired = (existing?.count ?? 0) + owed;
	const count = Math.min(desired, available);
	let vpCharged = 0;
	if (opts?.wasFallen && desired > count) {
		vpCharged = desired - count;
		player.victoryPoints = Math.max(0, (player.victoryPoints ?? 0) - vpCharged);
	}
	if (count <= 0) {
		player.pendingCorruptionDiscard = null;
		return vpCharged;
	}
	if (existing) {
		existing.count = count;
		if (reason) existing.reason = reason;
	} else {
		player.pendingCorruptionDiscard = { count, reason };
	}
	return vpCharged;
}

/** Attack-dice tiers, weakest → strongest. Elementalist upgrades climb this list. */
export type DiceTier = 'basic' | 'enchanted' | 'exalted' | 'arcane';
export const DICE_TIER_ORDER: DiceTier[] = ['basic', 'enchanted', 'exalted', 'arcane'];

/**
 * Flat cap on a player's attack-dice pool. Every player may hold up to this many
 * attack dice by default — it is NO LONGER tied to max barrier (`maxBarrier`).
 */
export const MAX_ATTACK_DICE = 10;

/** A single attack die in a player's combat pool. */
export interface AttackDie {
	instanceId: string;
	tier: DiceTier;
}

/** Per-seat navigation readiness (destination itself lives on the player, hidden
 * from other viewers until everyone has locked). */
export interface NavigationLockState {
	locked: boolean;
}

/** An un-encodable class/trait effect surfaced for the player to resolve by hand. */
export interface ManualPrompt {
	id: string;
	source: string; // class name that produced the prompt
	text: string;
}

/**
 * A player-decision "card" surfaced for an optional ("may") or choice class
 * ability. Unlike a {@link ManualPrompt} (dead text), this is resolvable: the
 * player picks one `option`, and the engine runs the matching DECISION_RESOLVERS
 * entry keyed by `kind`. Owner-only in the projection; blocks phase advance until
 * resolved (mirrors the `manualPrompts` machinery).
 */
export interface PendingDecision {
	id: string;
	source: 'class';
	kind: string;
	prompt: string;
	options: { id: string; label: string }[];
}

/** Outcome of the player's most recent resolved action — drives the result-card view. */
export interface ActionResult {
	key: string;
	label: string;
	log: string[];
}

/**
 * A monster-kill reward selection awaiting the player. Created when a player
 * defeats the Arcane Abyss monster: the player chooses up to `chooseAmount`
 * tokens from the monster's `rewardTrack` (the full reward pool). Mirrors the
 * `pendingDraw` lifecycle — owner-only, blocks ending the Location phase until
 * resolved, and is cleared at navigation each round.
 */
export interface PendingRewardState {
	monsterId: string;
	monsterName: string;
	/** The full reward pool (icon_pool ids) to choose from. */
	rewardTrack: string[];
	/** How many tokens the player may claim (already capped at the resolvable count). */
	chooseAmount: number;
}

/**
 * A forced corruption discard owed by the player — the escalating SACRIFICE cost of
 * corrupting. Created whenever corruption lowers a player's status (combat or PvP damage).
 * Corruption heals the player to full INSTANTLY (in takeDamage); this obligation is the cost,
 * paid in spirits: the owner must shed `count` spirits (the Nth corruption owes N). They
 * choose which via the existing `discardSpirit` command until `count` reaches 0. Owner-only in
 * the projection; blocks ending the round until resolved. The deadline/host-force-advance
 * drain auto-discards the highest slots so the round can never deadlock.
 */
export interface PendingCorruptionDiscard {
	/** How many more spirits the player still owes (decremented on each discard). */
	count: number;
	/** Optional human-readable cause (e.g. the corruption source) for UI copy. */
	reason?: string;
}

/** Which corruption stage a Cursed-Spirit Awakening-Phase grant is keyed to. */
/**
 * One claimable Awakening-Phase grant line, surfaced in the Cleanup phase. `amount`
 * is already scaled (e.g. ×N Cursed Spirits). Most kinds are fixed payouts;
 * `taintedChoice` (Cursed Spirit → Tainted) lets each unit be 1 Max Barrier OR 1
 * Enchanted Attack die, and `relicChoice` (Cursed Spirit → Corrupt) lets each unit
 * pick one of the five relics. `source` is the class name, shown on the claim card.
 */
export type AwakenGrant =
	| { kind: 'vp'; amount: number; source: string; note?: string }
	| { kind: 'attackDice'; tier: DiceTier; amount: number; source: string }
	| { kind: 'augment'; amount: number; source: string }
	| { kind: 'taintedChoice'; amount: number; source: string }
	| { kind: 'relicChoice'; amount: number; source: string };
/**
 * Awakening-Phase rewards awaiting this player in the Cleanup phase (Cursed Spirit,
 * Golden Ruler, The Corruptor, World Ender, World Guardian). Owner-only in the
 * projection; blocks committing cleanup until claimed via `resolveAwakenReward`.
 */
export interface PendingAwakenRewardState {
	grants: AwakenGrant[];
}

/**
 * A specific item the player elects to discard to pay a spirit's awaken cost.
 *   - `rune`    → a held rune/relic slot (`slotIndex` into `player.runes`).
 *   - `spirit`  → a class-trait spirit (`slotIndex` into `player.spirits`).
 *   - `augment` → one spirit-augment token from the player's pool.
 * Sent on `awakenSpirit` so the owner picks WHICH items satisfy a discard cost
 * (e.g. a Fairy Rune vs a Firecracker Relic) instead of the engine auto-choosing.
 */
export type AwakenDiscardRef =
	| { kind: 'rune'; slotIndex: number }
	| { kind: 'spirit'; slotIndex: number }
	| { kind: 'augment' };

/**
 * One candidate the player may pick to satisfy a discard-style awaken cost,
 * surfaced to the Cleanup UI so the owner can choose which item to spend.
 */
export interface AwakenDiscardOption {
	ref: AwakenDiscardRef;
	/** Display label (rune/relic/spirit name, or "Augment"). */
	label: string;
	/** Catalog rune id for icon lookup (rune/relic options only). */
	runeId?: string;
}

/**
 * A face-down spirit the player may awaken THIS Cleanup, with its cost spelled
 * out so the UI can label the card and (when there is a real choice) prompt for
 * which item(s) to discard. Built in `enterCleanup` for every awaken-eligible
 * slot; `options.length > discardCount` means the owner gets to choose which to
 * spend. Owner-derived from public tableau, so it carries no hidden info.
 */
export interface AwakenOffer {
	/** The face-down spirit slot this offer awakens. */
	slotIndex: number;
	/** The spirit's display name (for the card title). */
	spiritName: string;
	/** Human description of the requirement (verbatim DB text, a rune-cost
	 *  summary, or "Free" when there is no cost). */
	requirement: string;
	/** How many items the player must discard (0 for free/no-item flips). */
	discardCount: number;
	/** Candidate items to discard. Empty for free flips, rune-cost flips, and
	 *  event-flag conditions that need no per-item choice; populated for scripted
	 *  discard handlers (Faeries, relic/trait discards). */
	options: AwakenDiscardOption[];
}

/**
 * A face-down spirit the player CANNOT yet awaken — its condition isn't satisfiable
 * right now (e.g. a Faerie that wants a relic the player doesn't hold, or a
 * location-gated discard they didn't travel to). Surfaced in Cleanup as a passive,
 * non-clickable hint so the owner always sees WHAT a face-down spirit needs to
 * awaken, even before they can pay it. Built alongside {@link AwakenOffer}; carries
 * no hidden info (requirement is the verbatim DB text / rune-cost summary).
 */
export interface AwakenLockedOffer {
	/** The face-down spirit slot this hint describes. */
	slotIndex: number;
	/** The spirit's display name. */
	spiritName: string;
	/** Human description of the requirement still to be met. */
	requirement: string;
}

/** The monster currently invading the Arcane Abyss. */
export interface MonsterState {
	id: string;
	name: string;
	hp: number;
	maxHp: number;
	damage: number;
	rewardTrack: string[]; // icon_pool ids
	chooseAmount: number; // rewards picked on kill (default 2)
	/** Kills still needed to defeat THIS monster. Starts at the active player count; each
	 *  kill resets HP to full and decrements this, floored at 0 so excess kills (overkill)
	 *  never carry over to the next monster. */
	livesRemaining: number;
	/** Kills required to defeat this monster = the active player count (1p→1, 2p→2, …). */
	livesTotal: number;
	/** 0-based difficulty rung. Once lives hit 0, the next (stronger) monster comes out
	 *  at the round boundary. */
	ladderIndex: number;
	/** Total monsters in the escalation ladder. */
	ladderMax: number;
}

export type CombatKind = 'monster' | 'pvp';
export type CombatStep = 'prep' | 'roll' | 'damage' | 'aftermath' | 'resolved';

export interface CombatSide {
	seat: SeatColor;
	initiative: number;
	rolled: boolean;
	damageDealt: number;
	/** Which side of a group Encounter (PvP) this combatant fought on. */
	side?: 'evil' | 'good';
	/** Knocked out of the exchange (zero barrier / corrupted, not stun-immune). */
	stunned?: boolean;
}

export interface CombatState {
	id: string;
	kind: CombatKind;
	step: CombatStep;
	sides: CombatSide[];
	monster: MonsterState | null;
	/** Human-readable resolution log shown in the combat overlay. */
	log: string[];
	killed: boolean;
}

export interface GameActor {
	memberId: string;
	displayName: string;
	role: MemberRole;
	seatColor: SeatColor | null;
}

export interface PlayCatalogGuardian {
	id: string;
	name: string;
	originId: string | null;
}

/** One resolved mat line of a spirit's awaken cost (a rune/relic UUID + how many of it). */
export interface AwakenMatRequirement {
	runeId: string;
	name: string;
	kind: MatItemKind;
	/** Number of copies of this rune required (repeated UUIDs collapse into this). */
	count: number;
	/** True for the two wildcard ids (Any Relic / Any Rune) — accepts any item of that kind. */
	wildcard: boolean;
}

/** Normalized awakening requirement: a payable mat cost, or un-encodable text. */
export type NormalizedAwaken =
	| { kind: 'rune_cost'; mats: AwakenMatRequirement[] }
	| { kind: 'text'; text: string };

export interface PlayCatalogSpirit {
	id: string;
	name: string;
	cost: number;
	classes: Record<string, number>;
	origins: Record<string, number>;
	/** Normalized awaken_condition; undefined when the spirit has none. */
	awaken?: NormalizedAwaken;
}

export interface PlayCatalogRune {
	id: string;
	name: string;
	kind: MatItemKind;
	originId: string | null;
}

export interface PlayCatalogDie {
	id: string;
	name: string;
	diceType: DiceType;
	/** Numeric damage per face (non-numeric/special faces count as 0). */
	sides?: number[];
}

export interface PlayCatalogMonster {
	id: string;
	name: string;
	damage: number;
	barrier: number; // hit points to defeat
	rewardTrack: string[]; // icon_pool ids
	dicePool: string[]; // icon_pool ids (monster's own dice — informational for now)
	chooseAmount: number; // rewards picked on kill
	stage: number;
	/** Difficulty rung within a stage (0 = weakest). Drives the escalation ladder. */
	order: number;
}

/** A class trait carried into the engine, with its breakpoint effect schema intact. */
export interface PlayCatalogClass {
	id: string;
	name: string;
	classType: string | null;
	isSpecial: boolean;
	/** Verbatim effect_schema breakpoints from the classes table (null if unset). */
	effectSchema: ClassBreakpoint[] | null;
}

/** A Spirit World location with its DB reward rows (the engine's interaction set). */
export interface PlayCatalogLocation {
	name: string;
	originId: string | null;
	rewardRows: GameLocationRewardRow[];
}

export interface PlayCatalog {
	guardians: PlayCatalogGuardian[];
	spirits: PlayCatalogSpirit[];
	mats: PlayCatalogRune[];
	classes: PlayCatalogClass[];
	dice: PlayCatalogDie[];
	monsters?: PlayCatalogMonster[];
	/** Per-location reward rows, keyed by `name`. Empty for combat-only locations. */
	locations?: PlayCatalogLocation[];
	/** Per-cost bag copy-counts (editions table; Complete edition). Null ⇒ engine default. */
	costDuplicates?: Record<string, number> | null;
}

export interface PlaySpirit {
	slotIndex: number;
	id: string;
	name: string;
	cost: number;
	classes: Record<string, number>;
	origins: Record<string, number>;
	isFaceDown: boolean;
}

export interface PendingDrawState {
	sourceBag: SpiritSourceBag;
	drawCount: number;
	summonLimit: number;
	summonedCount: number;
	/** When true, a spirit summoned from this draw is flipped face-up and its
	 *  awakening fires immediately (Abyss Summoner / Florality "then awaken it"). */
	autoAwaken?: boolean;
}

export interface PlayDie {
	instanceId: string;
	diceId: string;
	name: string;
	diceType: DiceType;
	localX: number;
	localZ: number;
	faceIndex: number;
	rollRotation: {
		x: number;
		y: number;
		z: number;
	};
}

export interface PlayMatItem {
	instanceId: string;
	runeId: string;
	name: string;
	kind: MatItemKind;
	localX: number;
	localZ: number;
}

export interface LobbySeatState {
	seatColor: SeatColor;
	memberId: string | null;
	displayName: string | null;
	selectedGuardian: string | null;
	isBot?: boolean;
}

export interface MarketSlotState {
	index: number;
	spiritId: string | null;
}

export interface RuntimeBagEntry {
	name: string;
	guid: string;
	id?: string;
	cost?: number;
	state?: string;
	barrier?: number;
	damage?: number;
}

export interface RuntimeBagSnapshot {
	count: number;
	contents: RuntimeBagEntry[];
}

export interface RuntimeBagsState {
	hexSpirits: RuntimeBagSnapshot;
	monsters: RuntimeBagSnapshot;
	abyssFallen: RuntimeBagSnapshot;
	stageDeck: RuntimeBagSnapshot;
	purgeBags: [];
	history: BagsData;
}

/**
 * A spirit augment the player has gained but not yet placed. Augments never sit in
 * rune slots; they wait here until the owner drags one onto a hex spirit, at which
 * point they become a permanent SpiritAugmentAttachment on that spirit.
 */
export interface PendingAugment {
	runeId: string;
	name: string;
	classId?: string;
	/** When set, this augment may ONLY be placed on this spirit slot (its designated
	 *  target — e.g. Fairy Droid's "gain 2 augments for THIS spirit"). Unset = the
	 *  owner may place it on any of their spirits (subject to the 1-augment cap). */
	boundSlotIndex?: number;
	/** Human label for the bound target (the spirit's name), for the placement UI. */
	boundLabel?: string;
	/** When set, this augment may ONLY be placed on a spirit that HAS this class (e.g.
	 *  Purifier's "place on each summoned Cursed Spirit" ⇒ hostClass = 'Cursed Spirit').
	 *  Unlike boundSlotIndex (one fixed spirit) this restricts to a CATEGORY of host. */
	hostClass?: string;
	/** Augment capacity to allow on the host for this augment, overriding the host's
	 *  default 1-per-spirit cap (e.g. Purifier grants 2 per Cursed Spirit). */
	hostCapacity?: number;
}

export interface PrivatePlayerState {
	playerColor: SeatColor;
	displayName: string | null;
	selectedGuardian: string;
	navigationDestination: string | null;
	/**
	 * Broken Barrier — max-barrier tokens flipped to the corrupted side. Derived value,
	 * always kept equal to (maxBarrier − barrier): taking damage breaks barrier→broken
	 * barrier, restoring flips broken barrier→barrier. This IS the game's "broken barrier".
	 */
	brokenBarrier: number;
	victoryPoints: number;
	/** Victory Points at the end of each completed round (one entry per round, in
	 *  order) — powers the post-game "points over time" chart. Empty until the first
	 *  round closes; the live total is always {@link victoryPoints}. */
	vpHistory: number[];
	/** Barrier — max-barrier tokens still on the intact side. */
	barrier: number;
	/** Max Barrier — total tokens in the pool (capacity). Only grown by class effects. */
	maxBarrier: number;
	statusLevel: number;
	statusToken: string | null;
	/** How many times this player has corrupted — drives the escalating forced discard
	 *  (1st corruption sheds 1 spirit, 2nd sheds 2, …). Optional/defaults to 0. */
	corruptionCount?: number;
	spirits: PlaySpirit[];
	mats: MatSlotSnapshot[];
	handDraws: HandDrawSnapshot[];
	pendingDraw: PendingDrawState | null;
	/**
	 * A monster-kill reward selection awaiting this player (Arcane Abyss). Owner-only
	 * in the projection; blocks ending the Location phase until claimed.
	 */
	pendingReward: PendingRewardState | null;
	/**
	 * A Cursed-Spirit Awakening-Phase reward selection awaiting this player. Built in
	 * `enterCleanup` when the player crossed a corruption stage this round while
	 * holding ≥1 Cursed Spirit. Owner-only in the projection; blocks committing
	 * cleanup until claimed via `resolveAwakenReward`.
	 */
	pendingAwakenReward: PendingAwakenRewardState | null;
	/**
	 * Draws queued behind the active one — used when a single reward row grants
	 * more than one summon (e.g. Tidal Cove's "Summon + Abyss Summon"). The next
	 * queued draw auto-starts once the current draw is resolved or discarded.
	 */
	pendingDrawQueue: {
		sourceBag: SpiritSourceBag;
		drawCount: number;
		summonLimit: number;
		autoAwaken?: boolean;
	}[];
	spawnedDice: PlayDie[];
	spawnedItems: PlayMatItem[];
	spiritAugmentAttachments: SpiritAugmentAttachment[];
	/**
	 * Spirit augments gained this game but not yet placed on a spirit. Owner-only in
	 * the projection. Optional for backward compatibility with older snapshots.
	 */
	unplacedAugments?: PendingAugment[];
	/**
	 * A forced corruption discard the owner still owes (set when corruption lowered
	 * their status below the Spirit Tableau limit). Owner-only in the projection;
	 * blocks ending the Location phase until the owed spirits are discarded. Optional
	 * for backward compatibility with older snapshots.
	 */
	pendingCorruptionDiscard?: PendingCorruptionDiscard | null;

	// ── Rules-engine fields (2D play mode) ──────────────────────────────────
	/** Secret navigation choice; hidden from other viewers until all seats lock. */
	pendingDestination: NavigationDestination | null;
	/** Combat dice pool, with tiers (separate from the free-form spawnedDice tool). */
	attackDice: AttackDie[];
	/** Combat initiative accumulated this combat. */
	initiative: number;
	/** Location reward-rows / actions already used this round (once-per-round gate). */
	actionsUsedThisRound: string[];
	/** Spirit slot indices that became awaken-eligible this round. */
	awakenEligible: number[];
	/** Cleanup-phase awaken offers: one per awaken-eligible face-down spirit, with
	 *  its requirement spelled out and (for discard handlers) the candidate items
	 *  the owner may choose to spend. Parallel to {@link awakenEligible}; rebuilt by
	 *  `enterCleanup` and after each awaken / cleanup rune discard. */
	awakenOffers: AwakenOffer[];
	/** Cleanup-phase informative hints for face-down spirits that are NOT yet
	 *  awakenable (unmet discard/rune/location condition). Passive, non-clickable —
	 *  so the owner always sees what a Faerie etc. needs to awaken. Rebuilt next to
	 *  {@link awakenOffers}. */
	awakenLocked: AwakenLockedOffer[];
	/** Per-phase "I'm done" flag used to gate simultaneous phase advance. */
	phaseReady: boolean;
	/** Un-encodable class effects the player must resolve by hand. */
	manualPrompts: ManualPrompt[];
	/** Optional ("may")/choice class effects surfaced as resolvable decision cards. */
	pendingDecisions: PendingDecision[];
	/** Outcome of the most recent resolved location action (for the result-card view). */
	lastAction: ActionResult | null;

	// ── Effect-framework fields (P1; all default 0/false ⇒ no behavior change) ──
	/** Flat reduction applied to incoming combat damage before barriers. */
	damageReduction: number;
	/** Extra damage absorbed (deflected) on top of damageReduction. */
	deflect: number;
	/** Flat bonus added to the player's dealt combat damage. */
	combatDamageBonus: number;
	/** When true, the player ignores Stun effects. */
	stunImmune: boolean;
	/** Knocked out of the CURRENT combat exchange (hit zero barrier / corrupted, and
	 *  not stun-immune). Per-combat — reset by `resetCombatFlags`. Stunned players
	 *  cannot strike back in the same exchange. Optional: defaults falsy; the player
	 *  factory and normalizer set it, so older snapshots / fixtures stay valid. */
	stunned?: boolean;
	/** This player's vote during the Encounter phase. An Evil aggressor's group attack
	 *  fires only when every co-located Evil player has voted `'attack'`; any `'decline'`
	 *  cancels it. Reset to null when the Encounter phase begins. Optional for the same
	 *  back-compat reason as `stunned`. */
	encounterVote?: 'attack' | 'decline' | null;
	/** Spirit Augment specials the player holds. */
	spiritAugments: number;
	/** Relic specials the player holds. */
	relics: number;
	/** Extra actions granted this round, keyed by action type. */
	extraActions: Record<string, number>;

	// ── P4 per-combat flags (reset at the START of each combat ⇒ no leakage) ────
	/**
	 * Multiplier applied to dealt combat damage (default 1). Dark Assassin sets it
	 * to 2 when its barrier is odd. Applied inside `rollAttack`.
	 */
	combatDamageMultiplier: number;
	/**
	 * When true, the attack is rolled TWICE and the higher total kept — Dark Fighter
	 * (Space Invader). Applied inside `rollAttack`. Default false ⇒ a single roll.
	 */
	attackRollAdvantage: boolean;
	/**
	 * When true, incoming damage is halved (rounded up) after flat reductions —
	 * Disruptor, when the opponent has higher initiative. Applied in `takeDamage`.
	 */
	halveIncoming: boolean;
	/**
	 * When true, the next take-damage step is skipped entirely — Guardian, when the
	 * hit would corrupt. Applied in `takeDamage` (which then leaves the player
	 * untouched). The Guardian spirit is discarded by its handler.
	 */
	skipTakeDamage: boolean;

	// ── P5 per-turn / per-round flags ──────────────────────────────────────────
	/**
	 * Rune-gain doubling for the current turn (Rune Traveler). Honored by the
	 * rune-gain code (the `gainRune` action and the cultivate origin-rune grant).
	 * Reset at the start of navigation each round.
	 */
	doubleRunes: boolean;
	/**
	 * A summon redraw is available this summon (Soul Weaver). The summon path
	 * surfaces a redraw affordance; cleared when the summon resolves / a new draw
	 * begins. Modeled as a flag honored by the summon UI + bots.
	 */
	redrawAvailable: boolean;
	/**
	 * The player's next rune→relic trade at a Spirit World location is free — the
	 * trade-cost step waives the cost and clears this flag (Undercover, one-shot).
	 * Honored in `resolveLocationInteraction`.
	 */
	freeNextRelicTrade: boolean;
	/**
	 * Status thresholds crossed this round, recorded by the `onStatusChange`
	 * trigger and consumed in the Awakening Phase (cleanup) by the status-driven
	 * grants (Cursed Spirit, The Corruptor). Reset at the start of navigation each
	 * round so a single round's corruption grants exactly once.
	 */
	becameTaintedThisRound: boolean;
	becameCorruptThisRound: boolean;
	becameFallenThisRound: boolean;
	/** True if the player corrupted (status rose) at all this round (The Corruptor). */
	corruptedThisRound: boolean;

	// ── P6 awakening-progress flags ─────────────────────────────────────────────
	/**
	 * Event-driven awakening progress for the scripted `text` spirits whose
	 * condition is satisfied by a one-off in-game event rather than a payable cost
	 * (e.g. Arcane Huntress "engage in PvP while fallen", Hollow Eyes "deal >3
	 * damage", Contessa/Cosmic Guardian/Shadowtaker cultivate-while-aligned). The
	 * event source sets a key here (see `AWAKEN_PROGRESS_KEYS`); the matching
	 * `AWAKEN_HANDLERS` entry's `check` reads it. Persisted on the player so it
	 * survives across phases within a game.
	 */
	awakenProgress: Record<string, boolean>;
}

export interface PublicGameState {
	roomCode: string;
	revision: number;
	status: GameSessionStatus;
	gameId: string | null;
	scenario: string | { id?: string; name?: string; requested?: string | null } | null;
	round: number;
	guardianPool: string[];
	seats: Record<SeatColor, LobbySeatState>;
	activeSeats: SeatColor[];
	players: Partial<Record<SeatColor, PrivatePlayerState>>;
	market: MarketSlotState[];
	bags: RuntimeBagsState;

	// ── Rules-engine fields (2D play mode) ──────────────────────────────────
	/** Deterministic RNG cursor (seeded at startGame); see rng.ts. */
	rng: RngState;
	/** Current round phase. */
	phase: GamePhase;
	/** Per-seat navigation readiness. */
	navigation: Partial<Record<SeatColor, NavigationLockState>>;
	/** True once all active seats have locked navigation (destinations revealed). */
	revealedDestinations: boolean;
	/**
	 * Host-configured navigation timer (ms) chosen in the lobby. `null` = no limit —
	 * navigation only advances once every seat has locked. Read at the server boundary to
	 * stamp the navigation deadline; the pure reducer never reads the clock.
	 */
	navigationDurationMs: number | null;
	/** Epoch ms when the navigation countdown expires (null outside navigation). */
	navigationDeadline: number | null;
	/**
	 * The ORIGINAL (un-shortened) navigation deadline. When every active seat locks
	 * early the server collapses navigationDeadline to a short grace; this remembers
	 * the full deadline so a back-out (unlock) can restore the normal countdown.
	 */
	navigationFullDeadline: number | null;
	/**
	 * Epoch ms when the CURRENT phase may be force-advanced by the server past any
	 * silent/disconnected seat (null outside an active game). Stamped + compared
	 * with the SERVER clock only; the client copy is display-only.
	 */
	phaseDeadline: number | null;
	/** Which seats are at each destination (computed at reveal). */
	locationOccupancy: Partial<Record<NavigationDestination, SeatColor[]>>;
	/** The monster currently invading the Abyss, if any. */
	monster: MonsterState | null;
	/** Active combats this round. */
	combats: CombatState[];
	/** Set when a player reaches the VP target; game then finishes. */
	winnerSeat: SeatColor | null;
}

export interface PlayerProjection extends Omit<PrivatePlayerState, 'displayName'> {
	displayName: string | null;
	handDraws: HandDrawSnapshot[];
}

/** A spirit remaining in a draw bag, grouped by id (count = copies left). */
export interface BagSpiritSummary {
	id: string;
	name: string;
	cost: number;
	count: number;
}

export interface SpectatorProjection {
	roomCode: string;
	revision: number;
	status: GameSessionStatus;
	gameId: string | null;
	round: number;
	guardianPool: string[];
	viewer: {
		role: MemberRole;
		seatColor: SeatColor | null;
		displayName: string | null;
	};
	seats: Record<SeatColor, LobbySeatState>;
	activeSeats: SeatColor[];
	market: MarketSlotState[];
	players: Partial<Record<SeatColor, PlayerProjection>>;
	bagCounts: {
		hexSpirits: number;
		monsters: number;
		abyssFallen: number;
		stageDeck: number;
	};
	/** Spirits remaining in each draw bag, grouped by id (order hidden). */
	bagSpirits: {
		spiritWorld: BagSpiritSummary[];
		arcaneAbyss: BagSpiritSummary[];
	};

	// ── Rules-engine fields (2D play mode) ──────────────────────────────────
	phase: GamePhase;
	navigation: Partial<Record<SeatColor, NavigationLockState>>;
	revealedDestinations: boolean;
	/** Host-configured navigation timer (ms); `null` = no limit. Mirrors the game state. */
	navigationDurationMs: number | null;
	navigationDeadline: number | null;
	navigationFullDeadline: number | null;
	phaseDeadline: number | null;
	locationOccupancy: Partial<Record<NavigationDestination, SeatColor[]>>;
	monster: MonsterState | null;
	combats: CombatState[];
	winnerSeat: SeatColor | null;
}

export interface HistorySnapshotRow {
	game_id: string;
	navigation_count: number;
	game_timestamp: string;
	player_color: SeatColor;
	tts_username: string | null;
	navigation_destination: string | null;
	selected_character: string;
	blood: number;
	victory_points: number;
	barrier: number;
	max_tokens: number;
	status_level: number;
	status_token: string | null;
	spirits: PlaySpirit[];
	mats: MatSlotSnapshot[];
	spirit_augment_attachments: SpiritAugmentAttachment[];
	hand_draws: HandDrawSnapshot[];
	bags: BagsData;
	scenario: PublicGameState['scenario'];
}

/**
 * A single dev-only god-mode grant (payload of the `debugGrant` command). Ids are
 * resolved against the catalog server-side, so the command stays small. See the
 * `debugGrant` reducer case.
 */
export type DebugGrant =
	| { kind: 'attackDice'; tier: DiceTier; amount: number }
	| { kind: 'maxBarrier'; amount: number }
	| { kind: 'vp'; amount: number }
	/** Add `amount` augments to the unplaced pouch; `classId` (optional) classes them. */
	| { kind: 'augment'; classId?: string; amount: number }
	/** Add a catalog spirit to an open slot, face-up or face-down (to test awaken). */
	| { kind: 'spirit'; spiritId: string; faceDown: boolean }
	/** Add a catalog rune/relic/augment-item to the rune mat (e.g. to pay an awaken cost). */
	| { kind: 'rune'; runeId: string }
	/** Set the player's status level (0 Pure … 3 Fallen). */
	| { kind: 'status'; level: number }
	/** Clear all Broken Barrier (restore barrier to full). */
	| { kind: 'fullHeal' };

export type GameCommand =
	| { type: 'claimSeat'; seatColor: SeatColor }
	| { type: 'releaseSeat'; seatColor?: SeatColor }
	| { type: 'selectGuardian'; guardianName: string }
	/** Host sets the navigation timer (ms) in the lobby; `null` = no limit. */
	| { type: 'setNavigationTimer'; durationMs: number | null }
	| { type: 'startGame'; seed?: number }
	| { type: 'selectNavigationDestination'; destination: string }
	// ── Phase machine (2D play mode) ──────────────────────────────────────
	| { type: 'lockNavigation'; destination: NavigationDestination }
	| { type: 'unlockNavigation' }
	| { type: 'endLocationActions' }
	/** Confirm the Benefits step (rewards claimed) → advance to the Awakening step. */
	| { type: 'commitBenefits' }
	/** Confirm the Awakening step (spirits flipped) → advance to the Cleanup step. */
	| { type: 'commitAwakening' }
	| { type: 'commitCleanup' }
	/**
	 * Claim the Cursed-Spirit Awakening-Phase rewards (Cleanup). `taintedMaxBarrier`
	 * = how many of the Tainted line's units to take as max barrier; the rest become
	 * Enchanted Attack dice (defaults to 0 ⇒ all Enchanted). Ignored when there is
	 * no Tainted line.
	 */
	| { type: 'resolveAwakenReward'; taintedMaxBarrier?: number; relicPicks?: number[] }
	| { type: 'forceAdvancePhase' }
	| { type: 'dismissManualPrompt'; id: string }
	| { type: 'resolveDecision'; decisionId: string; optionId: string }
	/**
	 * Flip a face-down spirit face-up, paying its awaken cost. `runeInstanceIds`
	 * disambiguates which rune copies pay a `rune_cost`; `discardRefs` lets the
	 * owner choose which items satisfy a scripted discard cost (a Fairy Rune vs a
	 * Firecracker Relic, which relics/traits to shed). Both default to the engine's
	 * auto-pick when omitted.
	 */
	| {
			type: 'awakenSpirit';
			slotIndex: number;
			runeInstanceIds?: string[];
			discardRefs?: AwakenDiscardRef[];
	  }
	/**
	 * Owner (or host) confirms that a `text` awaken condition with no encodable
	 * script was resolved by hand, flipping the spirit face-up. Only legal for a
	 * face-down spirit whose condition is `text` AND is NOT in `AWAKEN_HANDLERS`
	 * (scripted text spirits must use `awakenSpirit`). Dismisses the matching
	 * pending manual prompt.
	 */
	| { type: 'manualAwaken'; slotIndex: number }
	/**
	 * DEV-ONLY god-mode grant. Mutates a player's state to hand them any resource for
	 * testing ability UX (attack dice, max barrier, VP, a spirit, a rune/relic, an
	 * augment, a status level, full restore). `seatColor` targets another player (e.g. set
	 * someone's corruption level from the roster); omitted ⇒ the sender's own seat.
	 * Server-gated to dev builds in the commands endpoint — never resolvable in production.
	 */
	| { type: 'debugGrant'; grant: DebugGrant; seatColor?: SeatColor }
	// ── Location actions (P1) ─────────────────────────────────────────────
	/**
	 * Resolve a location reward row by index — the ONLY way to act at a Spirit World
	 * location. Each location's available actions ARE its reward rows (Rest, Cultivate,
	 * Summon, heals, trades are all rows); there are no generic always-available actions.
	 * `choices[k]` selects which option to take for the k-th "or" gain in that row
	 * (defaults to the first option). `costChoices` lets the player pick WHICH held
	 * slot to discard for each WILDCARD cost ("any relic" / "any basic rune") — array
	 * indices into `player.mats`. Omitted/invalid entries fall back to auto-pick, so
	 * bots and specific (non-wildcard) costs are unaffected.
	 */
	| {
			type: 'resolveLocationInteraction';
			rowIndex: number;
			choices?: number[];
			costChoices?: number[];
	  }
	// ── Combat (P1: single-step monster fight) ────────────────────────────
	| { type: 'startCombat' }
	/**
	 * Claim monster-kill rewards. `picks` are indices into the pending reward's
	 * `rewardTrack` (≤ `chooseAmount`); `choices[k]` selects which option to take
	 * for the k-th "choose a rune" pick, in pick order (defaults to the first).
	 */
	| { type: 'resolveMonsterReward'; picks: number[]; choices?: number[] }
	// ── Encounter / PvP (P2) ──────────────────────────────────────────────
	| { type: 'initiatePvp' }
	| { type: 'passEncounter' }
	| { type: 'refillMarket' }
	| { type: 'spawnHandSpirit'; guid: string; slotIndex?: number }
	| { type: 'discardHandDraws' }
	/**
	 * Soul Weaver: "On a Spirit World or Abyss Summon, you may put all spirits back
	 * and draw again." Returns the current hand draws to their bag (reshuffled) and
	 * draws a fresh set from the same bag, preserving how many picks are still left.
	 * Legal only while `redrawAvailable` is set (one-shot per summon; re-armed each
	 * time a spirit is summoned).
	 */
	| { type: 'redrawHandDraws' }
	| { type: 'flipSpirit'; slotIndex: number }
	| { type: 'discardSpirit'; slotIndex: number }
	/** Discard a held rune/relic (Cleanup phase) to get under the carry limit. */
	| { type: 'discardRune'; slotIndex: number }
	/**
	 * Infiltrator (ENCODER): swap one attack die with each co-located player. Each
	 * entry exchanges `myInstanceId` (one of your attack dice) for `theirInstanceId`
	 * (one of the target's). Legal once per round (Location phase) when an awakened
	 * Infiltrator shares a location with the targets.
	 */
	| {
			type: 'infiltratorSwap';
			swaps: { targetSeat: SeatColor; myInstanceId: string; theirInstanceId: string }[];
	  }
	| { type: 'spawnDiceBatch'; diceId: string; count: number }
	| { type: 'rollSpawnedDice' }
	| { type: 'clearSpawnedDice' }
	| { type: 'spawnMatItem'; runeId: string }
	| { type: 'clearSpawnedItems' }
	| {
			type: 'moveMatObject';
			objectType: 'die' | 'item';
			instanceId: string;
			localX: number;
			localZ: number;
	  }
	| { type: 'adjustMaxBarrier'; amount: number }
	| { type: 'takeSpirit'; marketIndex: number; slotIndex?: number }
	| { type: 'replaceSpirit'; marketIndex: number; slotIndex: number }
	| { type: 'absorbSpirit'; slotIndex: number }
	| { type: 'moveRuneToSlot'; runeId: string; slotIndex: number }
	| { type: 'attachRuneToSpirit'; runeId: string; spiritSlotIndex: number }
	| { type: 'detachRuneFromSpirit'; runeId: string; spiritSlotIndex: number }
	/**
	 * Permanently attach one of the player's unplaced spirit augments onto the spirit
	 * in `spiritSlotIndex`. `augmentIndex` indexes into `unplacedAugments`; `augmentRuneId`
	 * is the rune the client believed sat there, used to reject a stale index if the
	 * pouch reordered between drag-start and drop. Cannot be undone; if that spirit is
	 * later discarded the augment is lost with it.
	 */
	| {
			type: 'placeAugmentOnSpirit';
			augmentIndex: number;
			augmentRuneId: string;
			spiritSlotIndex: number;
			/** The Spirit Augment class the player chose for this token (one of the six
			 *  SPIRIT_AUGMENT_CLASSES). The placed augment adds this class. */
			className?: string;
	  }
	/**
	 * Forfeit every still-unplaced Spirit Augment in the player's pouch. Augments are an
	 * optional benefit attached at will; when the player has more than they can (or care
	 * to) place — e.g. all host spirits are already at augment capacity — this clears the
	 * pouch so the placement prompt can never soft-lock the turn or carry into later rounds.
	 */
	| { type: 'discardUnplacedAugments' }
	| { type: 'adjustBarrier'; amount: number }
	| { type: 'adjustBrokenBarrier'; amount: number }
	| { type: 'adjustStatus'; amount: number }
	| { type: 'adjustVictoryPoints'; amount: number }
	| { type: 'commitRound' };

export type CommandResult =
	| { ok: true; state: PublicGameState }
	| {
			ok: false;
			error: {
				code: string;
				message: string;
			};
	  };
