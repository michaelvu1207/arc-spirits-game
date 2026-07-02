/**
 * encodeV2 — entity-level observation encoder (`arc-obs-v2`) for the set-transformer bot.
 *
 * Replaces the lossy 62-float summary in encode.ts (v1) with per-entity token sets:
 * one global token, one token per seat, one per spirit on ANY board, one per market
 * slot, one per held rune/relic of the acting seat, and one monster token. Token
 * counts are variable in-game, so every token family is emitted PADDED to a fixed
 * cap with an explicit 0/1 mask — dims are constant for a given catalog.
 *
 * v1 (encode.ts) stays untouched: the live distilled net consumes OBS_DIM=62 and the
 * 52-float encodeAction, which v2 deliberately does NOT duplicate — action features
 * remain v1's encodeAction.
 *
 * INFORMATION SAFETY — the contract that matters most here:
 * The encoder emits strictly the ACTING seat's information set. The authority for
 * what an opponent may see is `buildSessionProjection` (runtime.ts): for non-owner
 * viewers it redacts handDraws, pendingDraw(+queue), pendingReward,
 * pendingAwakenReward, pendingCorruptionDiscard, pendingDestination, manualPrompts,
 * pendingDecisions, lastAction and unplacedAugments. Those fields are encoded ONLY
 * on the self seat token (the "own:*" block) and NEVER read from opponents.
 * Destination features are additionally gated on `state.revealedDestinations`
 * (navigationDestination is only written at reveal, phases.ts, but the legacy
 * selectNavigationDestination command can write it early — the gate makes v2 safe
 * either way). Everything else in PrivatePlayerState — including face-down spirit
 * identity, mats, attack dice, status — IS in every viewer's projection today, and
 * is encoded for all seats to match that projection exactly.
 *
 * Design rules (inherited from v1):
 *   - Pure & deterministic: no RNG, no clock, no Object-key iteration order — all
 *     vector layouts are driven by sorted catalog vocabularies.
 *   - Features roughly normalized into [0,1].
 *   - The layout is versioned by `version`/`OBS_V2_VERSION_CODE`; any field change
 *     must bump the version, never silently reorder.
 *
 * Python reconstruction: `flattenObsV2` emits [header, payload, masks] as one flat
 * float array; the header self-describes (versionCode, then per-token-type
 * (typeId, cap, dim) triples). `obsV2Meta` returns the same dims plus the exact
 * vocab lists and per-field names, meant to be written to meta.json next to
 * training data. See docs/encoder-v2.md for the full field-by-field schema.
 */

import type { MatSlotSnapshot } from '$lib/types';
import {
	ALL_DESTINATIONS,
	DICE_TIER_ORDER,
	GAME_PHASES,
	MAX_ATTACK_DICE,
	MAX_ROUNDS,
	MAX_SPIRITS,
	RUNE_CARRY_LIMIT,
	SEAT_COLORS,
	VP_TO_WIN,
	isEvilAlignment,
	type PlayCatalog,
	type PlayCatalogSpirit,
	type PlaySpirit,
	type PrivatePlayerState,
	type PublicGameState,
	type RuntimeBagSnapshot,
	type SeatColor
} from '../types';

export const OBS_V2_VERSION = 'arc-obs-v2' as const;
/** Numeric version stamped into the flat header (v1 summary obs = 1). */
export const OBS_V2_VERSION_CODE = 2;

// ── Caps (token counts are padded/masked to these) ──────────────────────────
export const SEATS_CAP = SEAT_COLORS.length; // 6
export const SPIRITS_CAP = SEATS_CAP * MAX_SPIRITS; // 42 — every slot of every board
export const MARKET_CAP = 6; // engine deals a fixed 6-slot market (runtime.ts createLobbyState)
export const RUNES_CAP = 8; // RUNE_CARRY_LIMIT=4 + mid-round overflow headroom

// ── Normalizers ──────────────────────────────────────────────────────────────
const BARRIER_NORM = 20; // v1 convention
const COST_NORM = 9; // max catalog spirit cost
const CLASS_COUNT_NORM = 3;
const ORIGIN_COUNT_NORM = 3;
const BAG_COPY_NORM = 3; // max per-id duplicates (editions costDuplicates)
const SPIRIT_BAG_NORM = 60;
const MONSTER_BAG_NORM = 8;
const STAGE_BAG_NORM = 20;
const INITIATIVE_NORM = 10;

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ── Catalog-derived vocabularies (sorted ⇒ deterministic layout) ────────────
export interface ObsV2Vocab {
	/** Sorted class names appearing on any catalog spirit (37 in the frozen catalog). */
	classes: string[];
	/** Sorted origin names appearing on any catalog spirit (8). */
	origins: string[];
	/** Sorted catalog mat (rune/relic) ids (12). */
	runeIds: string[];
	/** Sorted catalog spirit ids (53) — indexes the per-id bag-depletion counters. */
	spiritIds: string[];
	classIndex: Map<string, number>;
	originIndex: Map<string, number>;
	runeIndex: Map<string, number>;
	spiritIndex: Map<string, number>;
	spiritById: Map<string, PlayCatalogSpirit>;
}

const vocabCache = new WeakMap<PlayCatalog, ObsV2Vocab>();

export function buildObsV2Vocab(catalog: PlayCatalog): ObsV2Vocab {
	const cached = vocabCache.get(catalog);
	if (cached) return cached;
	const classes = new Set<string>();
	const origins = new Set<string>();
	for (const s of catalog.spirits) {
		for (const c of Object.keys(s.classes ?? {})) classes.add(c);
		for (const o of Object.keys(s.origins ?? {})) origins.add(o);
	}
	// Classes can exist in the class table without sitting on a spirit yet; union
	// them in so the layout survives a spirit-pool rebalance within one catalog.
	for (const c of catalog.classes) classes.add(c.name);
	const toIndex = (xs: string[]): Map<string, number> => new Map(xs.map((x, i) => [x, i]));
	const vocab: ObsV2Vocab = {
		classes: [...classes].sort(),
		origins: [...origins].sort(),
		runeIds: catalog.mats.map((m) => m.id).sort(),
		spiritIds: catalog.spirits.map((s) => s.id).sort(),
		classIndex: new Map(),
		originIndex: new Map(),
		runeIndex: new Map(),
		spiritIndex: new Map(),
		spiritById: new Map(catalog.spirits.map((s) => [s.id, s]))
	};
	vocab.classIndex = toIndex(vocab.classes);
	vocab.originIndex = toIndex(vocab.origins);
	vocab.runeIndex = toIndex(vocab.runeIds);
	vocab.spiritIndex = toIndex(vocab.spiritIds);
	vocabCache.set(catalog, vocab);
	return vocab;
}

// ── Dims ─────────────────────────────────────────────────────────────────────
export interface ObsV2Dims {
	global: number;
	seat: number;
	spirit: number;
	market: number;
	rune: number;
	monster: number;
}

export function obsV2Dims(vocab: ObsV2Vocab): ObsV2Dims {
	const nc = vocab.classes.length;
	const no = vocab.origins.length;
	return {
		global: 16 + 2 * vocab.spiritIds.length,
		seat: 39 + 16,
		spirit: 13 + nc + no,
		market: 4 + nc + no,
		rune: 6 + vocab.runeIds.length,
		monster: 10
	};
}

// ── Field names (self-documenting schema; lengths are asserted in tests) ────
export interface ObsV2FieldNames {
	global: string[];
	seat: string[];
	spirit: string[];
	market: string[];
	rune: string[];
	monster: string[];
}

export function obsV2FieldNames(catalog: PlayCatalog): ObsV2FieldNames {
	const vocab = buildObsV2Vocab(catalog);
	const classFields = vocab.classes.map((c) => `class:${c}`);
	const originFields = vocab.origins.map((o) => `origin:${o}`);
	return {
		global: [
			'round',
			...GAME_PHASES.map((p) => `phase:${p}`),
			'activeSeats',
			'revealedDestinations',
			'monsterPresent',
			'monsterLadderFrac',
			'monsterLivesFrac',
			'bagSpiritWorldCount',
			'bagMonstersCount',
			'bagAbyssCount',
			'bagStageDeckCount',
			...vocab.spiritIds.map((id) => `bagSW:${id}`),
			...vocab.spiritIds.map((id) => `bagAbyss:${id}`)
		],
		seat: [
			'present',
			'isSelf',
			...SEAT_COLORS.map((c) => `seat:${c}`),
			'vp',
			'vpToWin',
			'barrier',
			'maxBarrier',
			'brokenBarrier',
			'statusLevel',
			'corruptionCount',
			'isEvil',
			'diceTotal',
			...DICE_TIER_ORDER.map((t) => `dice:${t}`),
			'spiritCount',
			'faceDownCount',
			'matRunes',
			'matRelics',
			'relicSpecials',
			'augmentSpecials',
			'attachedAugments',
			'navLocked',
			'destKnown',
			...ALL_DESTINATIONS.map((d) => `dest:${d}`),
			'coLocatedWithSelf',
			'phaseReady',
			'initiative',
			'awakenOfferCount',
			// own:* — owner-only information (buildSessionProjection redactions).
			// Populated ONLY on the self row; always 0 on opponent rows.
			'own:handDraws',
			'own:pendingDrawActive',
			'own:summonsLeft',
			'own:drawQueueLen',
			'own:pendingRewardActive',
			'own:rewardChooseAmount',
			'own:corruptionDiscardOwed',
			'own:decisionCount',
			'own:promptCount',
			'own:awakenRewardActive',
			'own:unplacedAugments',
			...ALL_DESTINATIONS.map((d) => `own:pendingDest:${d}`)
		],
		spirit: [
			'present',
			...SEAT_COLORS.map((c) => `owner:${c}`),
			'ownerIsSelf',
			'slot',
			'faceDown',
			'awakened',
			'cost',
			...classFields,
			...originFields,
			'augments'
		],
		market: ['present', 'filled', 'slot', 'cost', ...classFields, ...originFields],
		rune: [
			'present',
			'kind:rune',
			'kind:relic',
			'kind:augment',
			...vocab.runeIds.map((id) => `id:${id}`),
			'special',
			'hasClass'
		],
		monster: [
			'present',
			'hpFrac',
			'hp',
			'damage',
			'livesFrac',
			'lives',
			'ladderFrac',
			'ladder',
			'chooseAmount',
			'rewardCount'
		]
	};
}

// ── Output shape ─────────────────────────────────────────────────────────────
export interface EntityObsV2 {
	version: typeof OBS_V2_VERSION;
	global: number[];
	/** SEATS_CAP rows × seat dim. Row 0 is ALWAYS the acting seat; the rest follow
	 *  in SEAT_COLORS order. Padded rows are all-zero with mask 0. */
	seats: number[][];
	/** SPIRITS_CAP rows × spirit dim, grouped by seat in the same seat order,
	 *  each board's spirits sorted by slotIndex. */
	spirits: number[][];
	/** MARKET_CAP rows × market dim (all 6 slots always present; `filled` is a feature). */
	market: number[][];
	/** RUNES_CAP rows × rune dim — the ACTING seat's held runes/relics only. */
	runes: number[][];
	monster: number[];
	masks: {
		seats: number[];
		spirits: number[];
		market: number[];
		runes: number[];
		monster: number[];
	};
}

// ── Token builders ───────────────────────────────────────────────────────────

function bagPerIdCounts(bag: RuntimeBagSnapshot | undefined, vocab: ObsV2Vocab): number[] {
	const out = new Array<number>(vocab.spiritIds.length).fill(0);
	for (const entry of bag?.contents ?? []) {
		if (!entry.id) continue;
		const i = vocab.spiritIndex.get(entry.id);
		if (i !== undefined) out[i] += 1;
	}
	return out.map((n) => clamp01(n / BAG_COPY_NORM));
}

function globalToken(state: PublicGameState, vocab: ObsV2Vocab): number[] {
	const mon = state.monster;
	const bags = state.bags;
	return [
		clamp01(state.round / MAX_ROUNDS),
		...GAME_PHASES.map((p) => (state.phase === p ? 1 : 0)),
		clamp01(state.activeSeats.length / SEAT_COLORS.length),
		state.revealedDestinations ? 1 : 0,
		mon ? 1 : 0,
		mon ? clamp01(mon.ladderIndex / Math.max(1, mon.ladderMax)) : 0,
		mon ? clamp01(mon.livesRemaining / Math.max(1, mon.livesTotal)) : 0,
		clamp01((bags?.hexSpirits?.count ?? 0) / SPIRIT_BAG_NORM),
		clamp01((bags?.monsters?.count ?? 0) / MONSTER_BAG_NORM),
		clamp01((bags?.abyssFallen?.count ?? 0) / SPIRIT_BAG_NORM),
		clamp01((bags?.stageDeck?.count ?? 0) / STAGE_BAG_NORM),
		...bagPerIdCounts(bags?.hexSpirits, vocab),
		...bagPerIdCounts(bags?.abyssFallen, vocab)
	];
}

function matKind(mat: MatSlotSnapshot, catalog: PlayCatalog): 'rune' | 'relic' | 'augment' {
	if (mat.id) {
		const entry = catalog.mats.find((m) => m.id === mat.id);
		if (entry) return entry.kind;
	}
	const t = mat.type;
	return t === 'relic' || t === 'augment' ? t : 'rune';
}

function seatToken(
	state: PublicGameState,
	seat: SeatColor,
	viewer: SeatColor,
	catalog: PlayCatalog
): number[] {
	const p = state.players[seat];
	const isSelf = seat === viewer;
	if (!p) return [];
	const f: number[] = [];
	f.push(1); // present
	f.push(isSelf ? 1 : 0);
	for (const c of SEAT_COLORS) f.push(seat === c ? 1 : 0);

	f.push(clamp01(p.victoryPoints / VP_TO_WIN));
	f.push(clamp01((VP_TO_WIN - p.victoryPoints) / VP_TO_WIN));
	f.push(clamp01(p.barrier / BARRIER_NORM));
	f.push(clamp01(p.maxBarrier / BARRIER_NORM));
	f.push(clamp01(p.brokenBarrier / BARRIER_NORM));
	f.push(clamp01(p.statusLevel / 3));
	f.push(clamp01((p.corruptionCount ?? 0) / 5));
	f.push(isEvilAlignment(p.statusLevel) ? 1 : 0);

	const dice = p.attackDice ?? [];
	f.push(clamp01(dice.length / MAX_ATTACK_DICE));
	for (const tier of DICE_TIER_ORDER)
		f.push(clamp01(dice.filter((d) => d.tier === tier).length / MAX_ATTACK_DICE));

	const spirits = p.spirits ?? [];
	f.push(clamp01(spirits.length / MAX_SPIRITS));
	f.push(clamp01(spirits.filter((s) => s.isFaceDown).length / MAX_SPIRITS));

	const heldMats = (p.mats ?? []).filter((m) => m.hasRune);
	f.push(clamp01(heldMats.filter((m) => matKind(m, catalog) === 'rune').length / RUNE_CARRY_LIMIT));
	f.push(clamp01(heldMats.filter((m) => matKind(m, catalog) === 'relic').length / RUNE_CARRY_LIMIT));
	f.push(clamp01((p.relics ?? 0) / 10));
	f.push(clamp01((p.spiritAugments ?? 0) / 10));
	f.push(clamp01((p.spiritAugmentAttachments?.length ?? 0) / MAX_SPIRITS));

	f.push(state.navigation[seat]?.locked ? 1 : 0);
	// Destination is public ONLY once every seat has locked (phases.ts reveal).
	const dest = state.revealedDestinations ? (p.navigationDestination ?? null) : null;
	f.push(dest ? 1 : 0);
	for (const d of ALL_DESTINATIONS) f.push(dest === d ? 1 : 0);
	const viewerDest = state.revealedDestinations
		? (state.players[viewer]?.navigationDestination ?? null)
		: null;
	f.push(!isSelf && dest && viewerDest && dest === viewerDest ? 1 : 0);

	f.push(p.phaseReady ? 1 : 0);
	f.push(clamp01((p.initiative ?? 0) / INITIATIVE_NORM));
	// Awaken offers are owner-derived from the PUBLIC tableau (no hidden info) and
	// are not redacted by the projection, so they stay in the public block.
	f.push(clamp01((p.awakenOffers?.length ?? 0) / MAX_SPIRITS));

	// own:* — fields buildSessionProjection redacts for non-owners. Never read
	// from an opponent's PrivatePlayerState; opponent rows carry zeros here.
	if (isSelf) {
		f.push(clamp01((p.handDraws?.length ?? 0) / 5));
		f.push(p.pendingDraw ? 1 : 0);
		f.push(
			p.pendingDraw
				? clamp01((p.pendingDraw.summonLimit - p.pendingDraw.summonedCount) / 5)
				: 0
		);
		f.push(clamp01((p.pendingDrawQueue?.length ?? 0) / 3));
		f.push(p.pendingReward ? 1 : 0);
		f.push(p.pendingReward ? clamp01(p.pendingReward.chooseAmount / 4) : 0);
		f.push(clamp01((p.pendingCorruptionDiscard?.count ?? 0) / 5));
		f.push(clamp01((p.pendingDecisions?.length ?? 0) / 3));
		f.push(clamp01((p.manualPrompts?.length ?? 0) / 3));
		f.push(p.pendingAwakenReward ? 1 : 0);
		f.push(clamp01((p.unplacedAugments?.length ?? 0) / 5));
		for (const d of ALL_DESTINATIONS) f.push(p.pendingDestination === d ? 1 : 0);
	} else {
		for (let i = 0; i < 16; i++) f.push(0);
	}
	return f;
}

function spiritToken(
	spirit: PlaySpirit,
	owner: SeatColor,
	ownerState: PrivatePlayerState,
	viewer: SeatColor,
	vocab: ObsV2Vocab
): number[] {
	const f: number[] = [];
	f.push(1);
	for (const c of SEAT_COLORS) f.push(owner === c ? 1 : 0);
	f.push(owner === viewer ? 1 : 0);
	f.push(clamp01(spirit.slotIndex / MAX_SPIRITS));
	f.push(spirit.isFaceDown ? 1 : 0);
	f.push(spirit.isFaceDown ? 0 : 1);
	f.push(clamp01((spirit.cost ?? 0) / COST_NORM));
	// Class counts include placed augments' chosen classes on this spirit — that is
	// how the engine tallies trait totals (awakenedClassCounts + augmentContributions).
	const cls = new Array<number>(vocab.classes.length).fill(0);
	for (const [name, n] of Object.entries(spirit.classes ?? {})) {
		const i = vocab.classIndex.get(name);
		if (i !== undefined) cls[i] += typeof n === 'number' ? n : 1;
	}
	for (const att of ownerState.spiritAugmentAttachments ?? []) {
		if (att.spiritSlotIndex !== spirit.slotIndex || !att.className) continue;
		const i = vocab.classIndex.get(att.className);
		if (i !== undefined) cls[i] += 1;
	}
	for (const n of cls) f.push(clamp01(n / CLASS_COUNT_NORM));
	const org = new Array<number>(vocab.origins.length).fill(0);
	for (const [name, n] of Object.entries(spirit.origins ?? {})) {
		const i = vocab.originIndex.get(name);
		if (i !== undefined) org[i] += typeof n === 'number' ? n : 1;
	}
	for (const n of org) f.push(clamp01(n / ORIGIN_COUNT_NORM));
	f.push(
		clamp01(
			(ownerState.spiritAugmentAttachments ?? []).filter(
				(a) => a.spiritSlotIndex === spirit.slotIndex
			).length / 2
		)
	);
	return f;
}

function marketToken(
	slotIndex: number,
	spiritId: string | null,
	vocab: ObsV2Vocab
): number[] {
	const f: number[] = [];
	const spirit = spiritId ? vocab.spiritById.get(spiritId) : undefined;
	f.push(1);
	f.push(spiritId ? 1 : 0);
	f.push(clamp01(slotIndex / MARKET_CAP));
	f.push(spirit ? clamp01(spirit.cost / COST_NORM) : 0);
	const cls = new Array<number>(vocab.classes.length).fill(0);
	const org = new Array<number>(vocab.origins.length).fill(0);
	if (spirit) {
		for (const [name, n] of Object.entries(spirit.classes ?? {})) {
			const i = vocab.classIndex.get(name);
			if (i !== undefined) cls[i] += typeof n === 'number' ? n : 1;
		}
		for (const [name, n] of Object.entries(spirit.origins ?? {})) {
			const i = vocab.originIndex.get(name);
			if (i !== undefined) org[i] += typeof n === 'number' ? n : 1;
		}
	}
	for (const n of cls) f.push(clamp01(n / CLASS_COUNT_NORM));
	for (const n of org) f.push(clamp01(n / ORIGIN_COUNT_NORM));
	return f;
}

function runeToken(mat: MatSlotSnapshot, catalog: PlayCatalog, vocab: ObsV2Vocab): number[] {
	const f: number[] = [];
	const kind = matKind(mat, catalog);
	f.push(1);
	f.push(kind === 'rune' ? 1 : 0);
	f.push(kind === 'relic' ? 1 : 0);
	f.push(kind === 'augment' ? 1 : 0);
	const idx = mat.id ? vocab.runeIndex.get(mat.id) : undefined;
	for (let i = 0; i < vocab.runeIds.length; i++) f.push(i === idx ? 1 : 0);
	f.push(mat.special ? 1 : 0);
	f.push(mat.classId ? 1 : 0);
	return f;
}

function monsterToken(state: PublicGameState): number[] {
	const mon = state.monster;
	if (!mon) return new Array<number>(10).fill(0);
	return [
		1,
		clamp01(mon.hp / Math.max(1, mon.maxHp)),
		clamp01(mon.hp / BARRIER_NORM),
		clamp01(mon.damage / BARRIER_NORM),
		clamp01(mon.livesRemaining / Math.max(1, mon.livesTotal)),
		clamp01(mon.livesRemaining / SEAT_COLORS.length),
		clamp01(mon.ladderIndex / Math.max(1, mon.ladderMax)),
		clamp01(mon.ladderIndex / MONSTER_BAG_NORM),
		clamp01(mon.chooseAmount / 4),
		clamp01(mon.rewardTrack.length / 8)
	];
}

// ── Encoder ──────────────────────────────────────────────────────────────────

function padRows(rows: number[][], cap: number, dim: number): { rows: number[][]; mask: number[] } {
	const kept = rows.slice(0, cap);
	const mask = kept.map(() => 1);
	while (kept.length < cap) {
		kept.push(new Array<number>(dim).fill(0));
		mask.push(0);
	}
	return { rows: kept, mask };
}

/**
 * Encode `state` as seen by `seat` (the acting player). Pure and deterministic;
 * `state` is never mutated. Seat row 0 is always the acting seat.
 */
export function encodeEntityObsV2(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): EntityObsV2 {
	const vocab = buildObsV2Vocab(catalog);
	const dims = obsV2Dims(vocab);

	// Self first, then the remaining active seats in stable SEAT_COLORS order.
	const seatOrder: SeatColor[] = [
		seat,
		...SEAT_COLORS.filter((s) => s !== seat && state.activeSeats.includes(s))
	].filter((s) => !!state.players[s]);

	const seatRows = seatOrder.map((s) => seatToken(state, s, seat, catalog));

	const spiritRows: number[][] = [];
	for (const s of seatOrder) {
		const p = state.players[s]!;
		const boardSpirits = [...(p.spirits ?? [])].sort((a, b) => a.slotIndex - b.slotIndex);
		for (const sp of boardSpirits) spiritRows.push(spiritToken(sp, s, p, seat, vocab));
	}

	const marketRows = (state.market ?? []).map((slot) =>
		marketToken(slot.index, slot.spiritId, vocab)
	);

	const me = state.players[seat];
	const heldMats = (me?.mats ?? [])
		.filter((m) => m.hasRune)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const runeRows = heldMats.map((m) => runeToken(m, catalog, vocab));

	const seats = padRows(seatRows, SEATS_CAP, dims.seat);
	const spirits = padRows(spiritRows, SPIRITS_CAP, dims.spirit);
	const market = padRows(marketRows, MARKET_CAP, dims.market);
	const runes = padRows(runeRows, RUNES_CAP, dims.rune);

	return {
		version: OBS_V2_VERSION,
		global: globalToken(state, vocab),
		seats: seats.rows,
		spirits: spirits.rows,
		market: market.rows,
		runes: runes.rows,
		monster: monsterToken(state),
		masks: {
			seats: seats.mask,
			spirits: spirits.mask,
			market: market.mask,
			runes: runes.mask,
			monster: [state.monster ? 1 : 0]
		}
	};
}

// ── Flatten / meta (the Python-side contract) ────────────────────────────────

/** Token-type ids used in the flat header, in payload order. */
export const OBS_V2_TOKEN_TYPES = [
	'global',
	'seat',
	'spirit',
	'market',
	'rune',
	'monster'
] as const;

/**
 * Self-describing flat header: [versionCode, numTokenTypes, then per type
 * (typeId, cap, dim)]. typeId is the index into OBS_V2_TOKEN_TYPES.
 */
export function obsV2FlatHeader(vocab: ObsV2Vocab): number[] {
	const d = obsV2Dims(vocab);
	return [
		OBS_V2_VERSION_CODE,
		OBS_V2_TOKEN_TYPES.length,
		0, 1, d.global,
		1, SEATS_CAP, d.seat,
		2, SPIRITS_CAP, d.spirit,
		3, MARKET_CAP, d.market,
		4, RUNES_CAP, d.rune,
		5, 1, d.monster
	];
}

export function obsV2FlatLength(vocab: ObsV2Vocab): number {
	const d = obsV2Dims(vocab);
	const header = 2 + OBS_V2_TOKEN_TYPES.length * 3;
	const payload =
		d.global +
		SEATS_CAP * d.seat +
		SPIRITS_CAP * d.spirit +
		MARKET_CAP * d.market +
		RUNES_CAP * d.rune +
		d.monster;
	const masks = SEATS_CAP + SPIRITS_CAP + MARKET_CAP + RUNES_CAP + 1;
	return header + payload + masks;
}

/**
 * Flatten to one float array: header, then payload in OBS_V2_TOKEN_TYPES order
 * (rows concatenated), then masks in (seats, spirits, market, runes, monster)
 * order. Length is constant for a given catalog — see obsV2FlatLength.
 */
export function flattenObsV2(obs: EntityObsV2, catalog: PlayCatalog): number[] {
	const vocab = buildObsV2Vocab(catalog);
	const out: number[] = obsV2FlatHeader(vocab);
	out.push(...obs.global);
	for (const row of obs.seats) out.push(...row);
	for (const row of obs.spirits) out.push(...row);
	for (const row of obs.market) out.push(...row);
	for (const row of obs.runes) out.push(...row);
	out.push(...obs.monster);
	out.push(...obs.masks.seats, ...obs.masks.spirits, ...obs.masks.market, ...obs.masks.runes, ...obs.masks.monster);
	return out;
}

/**
 * Everything the Python trainer needs to parse flat v2 observations: dims, caps,
 * field names, vocab lists, and the flat layout. Serialize this to meta.json
 * alongside any v2 training data.
 */
export function obsV2Meta(catalog: PlayCatalog): {
	version: typeof OBS_V2_VERSION;
	versionCode: number;
	tokenTypes: readonly string[];
	caps: { seats: number; spirits: number; market: number; runes: number };
	dims: ObsV2Dims;
	fieldNames: ObsV2FieldNames;
	vocab: { classes: string[]; origins: string[]; runeIds: string[]; spiritIds: string[] };
	flatHeader: number[];
	flatLength: number;
} {
	const vocab = buildObsV2Vocab(catalog);
	return {
		version: OBS_V2_VERSION,
		versionCode: OBS_V2_VERSION_CODE,
		tokenTypes: OBS_V2_TOKEN_TYPES,
		caps: { seats: SEATS_CAP, spirits: SPIRITS_CAP, market: MARKET_CAP, runes: RUNES_CAP },
		dims: obsV2Dims(vocab),
		fieldNames: obsV2FieldNames(catalog),
		vocab: {
			classes: vocab.classes,
			origins: vocab.origins,
			runeIds: vocab.runeIds,
			spiritIds: vocab.spiritIds
		},
		flatHeader: obsV2FlatHeader(vocab),
		flatLength: obsV2FlatLength(vocab)
	};
}
