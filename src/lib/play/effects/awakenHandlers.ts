import { baseRuneIdForSlot } from '../baseRunes';
import { runesAreWild } from './matMatch';
/**
 * Scripted `text`-awaken handlers (Phase 6).
 *
 * The generic `rune_cost` awakening path lives in {@link ./awaken}. This module
 * scripts the encodable `text` conditions, keyed by spirit id, each as a
 * `{ check, pay }` pair mirroring the rune-cost gate:
 *
 *   - `check(ctx)`  → `{ ok, reason? }`: can the condition be satisfied RIGHT NOW
 *                     without mutating state? (Read-only.)
 *   - `pay(ctx)`    → perform the satisfying mutation (discard runes/relics/
 *                     spirits/dice, clear progress flags). Only called after a
 *                     successful `check`.
 *
 * Three text categories are scripted with shared helpers:
 *
 *   1. discard costs — Meteor Shower, Twin Pyres, the "or discard Abyss spirits" kings.
 *   2. cultivate progress — Contessa, Arcane Huntress and the three location
 *      Fairies. `applyCultivate` records the matching progress flags.
 *   3. event progress — Shadowtaker (Nhal), Traveling Trader and the Moon rework spirits
 *      (Moonrend, Night Witch, Moon Cultist, Veiled Acolyte); The Argent Loom checks Fallen. Every Moon awaken except Nhal
 *      needs the owner Fallen at the moment of awakening ({@link fallenToAwaken}).
 *
 * Every spirit listed here is "scripted"; a text spirit NOT keyed here falls to
 * the manual-confirm path ({@link MANUAL_AWAKEN}). Encoding reads ONLY the English
 * DB description (translation columns are mojibake).
 */

import { STATUS_LADDER } from '../types';
import type {
	AwakenDiscardOption,
	AwakenDiscardRef,
	AwakenPaymentAlternative,
	PlaySpirit,
	PrivatePlayerState
} from '../types';
import type { EffectContext } from './context';

/** Result of an awaken handler's `check`: satisfiable + an optional reason. */
export interface AwakenHandlerCheck {
	ok: boolean;
	reason?: string;
}

/** The awaken context: the standard effect context + the spirit being flipped. */
export interface AwakenHandlerContext extends EffectContext {
	/** The face-down spirit slot being awakened. */
	spirit: PlaySpirit;
}

/** What a discard handler may let the owner choose: how many to spend, the
 * candidates, and whether those candidates are materially different. */
export interface AwakenDiscardChoice {
	count: number;
	options: AwakenDiscardOption[];
	/** True only when choosing changes which materially different items remain. */
	requiresSelection?: true;
	/** Two or more ways to pay that are possible now (the first equals count/options). */
	alternatives?: AwakenPaymentAlternative[];
}

/** One scripted text-awaken: a read-only check + a state-mutating payment. */
export interface AwakenHandler {
	check(ctx: AwakenHandlerContext): AwakenHandlerCheck;
	pay(ctx: AwakenHandlerContext): void;
	/** Discard-style handlers expose their candidate items so the Cleanup UI can
	 *  let the owner choose which to spend. Returns null when nothing is payable
	 *  or there is nothing to choose (event-flag / fixed-cost handlers). */
	discardChoice?(ctx: AwakenHandlerContext): AwakenDiscardChoice | null;
}

/** Stable identity for an {@link AwakenDiscardRef} (augment tokens are fungible). */
function refKey(ref: AwakenDiscardRef): string {
	if (ref.kind === 'augment') return 'augment';
	if (ref.kind === 'attackDie') return `attackDie:${ref.instanceId}`;
	return `${ref.kind}:${ref.slotIndex}`;
}

/** The owner's chosen discard items off the `awakenSpirit` command, if any. */
function selectionFrom(ctx: AwakenHandlerContext): AwakenDiscardRef[] | undefined {
	const cmd = ctx.command;
	if (cmd && typeof cmd === 'object' && 'discardRefs' in cmd) {
		const refs = (cmd as { discardRefs?: AwakenDiscardRef[] }).discardRefs;
		if (Array.isArray(refs)) return refs;
	}
	return undefined;
}

// ── Spirit ids (from hex_spirits; text awaken_condition rows) ─────────────────

export const AWAKEN_SPIRIT_IDS = {
	arcaneHuntress: 'cafb6cfb-11f8-476c-a275-a5b8179630d2',
	/** The Argent Loom (Sorcerer): "Be Evil in the Awakening Phase." */
	argentLoom: 'e75cb10c-fee4-488b-a213-e663c0fecae7',
	astrobiologist: '67c591ab-4227-4656-8697-247243975076',
	/** Archived; retained only as a stable id for old replays/tests. */
	bloodHound: 'fc5835e9-156b-44fd-8037-832124df724c',
	contessa: 'e4822f18-98f0-44fd-8711-756f946f6cd5',
	cosmicGuardian: 'e9e12faa-0add-4fab-b251-a9dec5a8bae9',
	floralFairy: 'ae827012-29ff-406e-bcbe-afe3a5258607',
	hollowEyes: '70ed3fcd-a7c2-4443-b5e7-9b6de8491917',
	lanternFairy: 'c0d12557-4615-4c60-a93c-622e5fc70eae',
	meteorShower: '5dc44c85-8224-4c49-89ff-90a37aa10040',
	shadowtaker: 'fc667265-edd6-4c28-b96e-6e505188ce72',
	/** Moonrend, the Twice-Striking (Assassin): "Attack another player." */
	moonrend: 'b3068fcf-d197-4030-ba55-29ac1621f9a9',
	tidalFairy: '36bb656c-49fe-4d50-a037-b29dbd1bfa91',
	// "Have 7 <Origin> Spirits, or discard 3 Arcane Abyss Spirits." (November 2026 catalog)
	caldera: '504c77b5-8f46-427d-a339-1ef11160b0d7',
	stormKing: 'be2072ea-ccdb-4941-b1b3-26890a7b64cf',
	hollowbloom: 'e5dff9be-ac58-47bb-bd9d-69efb03dc393',
	// "Discard 2 Fire Runes, or discard 5 of any attack dice." (Sentinel spirit, 2026-11-12)
	twinPyres: 'd89f5d3a-5519-4b96-baf0-1f0a49c0ada1',
	// "Navigate to the Water Region and do no location interactions." (Traveling Trader spirit)
	travelingTrader: 'ac981bdb-c271-46df-be9e-55f698cd3f55',
	// Moon rework (approved 2026-11-12).
	nightWitch: 'f5b691f1-f0e7-411c-adda-8c724d7c1a36', // "Become Corrupted."
	moonCultist: '2f15b8f6-9ef0-4d6b-a495-a44730fcb5a2', // "Sacrifice a spirit."
	veiledAcolyte: '1dbf151e-6c27-470c-b3fe-e32a6f735b93' // "Deal damage to another player."
} as const;

/**
 * Keys written to `player.awakenProgress` by the event sources (cultivate / PvP /
 * take-damage), and read by the matching `AWAKEN_HANDLERS.check`. Centralized so
 * the producer and consumer never drift.
 */
export const AWAKEN_PROGRESS_KEYS = {
	/** Vespera (Contessa id): cultivated while Fallen. */
	contessa: 'awaken:contessa',
	/** Cosmic Guardian: became corrupted during combat. */
	cosmicGuardian: 'awaken:cosmicGuardian',
	/** Nhal (Shadowtaker id): visited the Arcane Abyss without fighting (no Fallen needed). */
	shadowtaker: 'awaken:shadowtaker',
	/** Arcane Huntress: cultivated while Fallen with ≥10 max barrier. */
	arcaneHuntress: 'awaken:arcaneHuntress',
	/** Legacy key retained for replay compatibility; no longer written. */
	meteorShower: 'awaken:meteorShower',
	/** Hollow Eyes: failed combat and became corrupted in that combat. */
	hollowEyes: 'awaken:hollowEyes',
	floralFairy: 'awaken:floralFairy',
	lanternFairy: 'awaken:lanternFairy',
	tidalFairy: 'awaken:tidalFairy',
	/** Traveling Trader: ended a Location step at the Water Region with no location interaction. */
	travelingTrader: 'awaken:travelingTrader',
	/** Moonrend: was on the attacking (Evil) side of a PvP combat while Fallen. */
	moonrend: 'awaken:moonrend',
	/** Night Witch: became Corrupted while already Fallen. */
	nightWitch: 'awaken:nightWitch',
	/** Moon Cultist: sacrificed a spirit while Fallen (a discard that pays a corruption sacrifice). */
	moonCultist: 'awaken:moonCultist',
	/** Veiled Acolyte: while Fallen, dealt damage (the target lost Barrier) to another player in PvP. */
	veiledAcolyte: 'awaken:veiledAcolyte'
} as const;

/** The engine's Fallen status (the top of the corruption ladder, statusLevel 3). In this engine
 *  Evil is the same status (`isEvilAlignment` = statusLevel ≥ 3). */
export function isFallen(player: Pick<PrivatePlayerState, 'statusLevel'>): boolean {
	return (player.statusLevel ?? 0) >= STATUS_LADDER.length - 1;
}

/** Moon spirits (Michael, 2026-11-12): "For all moon spirits you need to be fallen to awaken them." (Nhal excepted.)
 *  The owner must ALSO be Fallen at the moment of awakening, on top of the spirit's own text. */
function fallenToAwaken(inner: AwakenHandler): AwakenHandler {
	return {
		...inner,
		check(ctx) {
			if (!isFallen(ctx.player)) return { ok: false, reason: 'fallen_required' };
			return inner.check(ctx);
		}
	};
}

/** Set an awaken progress flag, but only while the player holds that spirit face-down (the same
 *  rule as the other event flags). The flag stays until the spirit awakens. */
export function recordAwakenProgress(player: PrivatePlayerState, spiritId: string, key: string): void {
	if (!player.spirits.some((s) => s.id === spiritId && s.isFaceDown)) return;
	(player.awakenProgress ??= {})[key] = true;
}

/** Did the player do a location interaction this round? A location row (`row:N`: rest, cultivate,
 *  summon, gain and trade rows). Navigation Powers, class cards and relic tools are not location
 *  interactions. */
export function didLocationInteraction(player: PrivatePlayerState): boolean {
	return (player.actionsUsedThisRound ?? []).some((a) => a.startsWith('row:'));
}

/**
 * Traveling Trader — "Navigate to the Water Region and do no location interactions." Same model
 * as Nhal ("Navigate to the Arcane Abyss, but don't fight the monster."): when the Location step
 * ends (`enterBenefits`), a player who holds the spirit face-down, whose destination was the Water
 * Region and who did no location interaction gets a progress flag. The flag is kept until the
 * spirit awakens (like Nhal), so it can also awaken in a later round.
 */
export function recordTravelingTraderProgress(player: PrivatePlayerState): void {
	if (player.navigationDestination !== 'Water Region') return;
	if (didLocationInteraction(player)) return;
	if (!player.spirits.some((s) => s.id === AWAKEN_SPIRIT_IDS.travelingTrader && s.isFaceDown)) return;
	(player.awakenProgress ??= {})[AWAKEN_PROGRESS_KEYS.travelingTrader] = true;
}

// ── Shared discard helper ─────────────────────────────────────────────────────

export type DiscardWhat = 'relic' | 'rune' | 'classTrait';

export interface DiscardAtLocationSpec {
	/** What to discard: a held relic, a held rune, or a class-trait (spirit/augment). */
	what: DiscardWhat;
	/** Optional display-name filter for relics/runes (substring, case-insensitive). */
	name?: string;
	/** For `classTrait`: the class whose spirits/augments count (e.g. 'Cultivator'). */
	className?: string;
	/** How many to discard. */
	count: number;
	/** When set, the player must be navigating to this location to satisfy. */
	locationName?: string;
	/** Optional relic-barrier filter retained for replay-compatible custom content. */
	maxBarrier?: number;
	/**
	 * "X or Y" conditions (Floral/Lantern/Tidal Fairy): a second alternative spec.
	 * The condition is satisfiable if EITHER `this` or `or` can be paid; `pay`
	 * spends whichever the player can afford (this first, then the alternative).
	 */
	or?: DiscardAtLocationSpec;
}

/** The candidate items that satisfy ONE spec branch (no `or` alternative). For a
 *  classTrait branch these are the matching spirits plus the player's augment
 *  tokens; otherwise the matching held rune/relic slots. */
function optionsForBranch(
	player: PrivatePlayerState,
	spec: DiscardAtLocationSpec
): AwakenDiscardOption[] {
	if (spec.what === 'classTrait' && spec.className) {
		const out: AwakenDiscardOption[] = [];
		// Class traits = spirits of that class + spirit augments (Spirits/Augments).
		for (const s of player.spirits) {
			if ((s.classes?.[spec.className] ?? 0) > 0) {
				out.push({ ref: { kind: 'spirit', slotIndex: s.slotIndex }, label: s.name });
			}
		}
		for (let i = 0; i < (player.spiritAugments ?? 0); i += 1) {
			out.push({ ref: { kind: 'augment' }, label: `${spec.className} Augment` });
		}
		return out;
	}
	// rune / relic candidates, keyed by their held-slot identity.
	const wantRelic = spec.what === 'relic';
	const out: AwakenDiscardOption[] = [];
	for (const slot of player.mats) {
		if (!slot?.hasRune) continue;
		const isRelic = slot.type === 'relic';
		if (wantRelic !== isRelic) continue;
		if (spec.name && !(slot.name ?? '').toLowerCase().includes(spec.name.toLowerCase())) continue;
		// Relic barriers are not tracked on the held-rune
		// snapshot, so every held relic is treated as qualifying. The filter is kept
		// in the spec for documentation + forward-compat if barrier metadata lands.
		out.push({
			ref: { kind: 'rune', slotIndex: slot.slotIndex },
			label: slot.name ?? (isRelic ? 'Relic' : 'Rune'),
			runeId: slot.id
		});
	}
	return out;
}

/** Is the player at the required location (if the spec names one)? */
function atRequiredLocation(player: PrivatePlayerState, spec: DiscardAtLocationSpec): boolean {
	if (!spec.locationName) return true;
	return player.navigationDestination === spec.locationName;
}

/** Every branch of `spec` (itself, then its `or`) the player can pay RIGHT NOW —
 *  i.e. at the required location with enough matching items. */
function payableBranches(
	player: PrivatePlayerState,
	spec: DiscardAtLocationSpec
): DiscardAtLocationSpec[] {
	const out: DiscardAtLocationSpec[] = [];
	for (let branch: DiscardAtLocationSpec | undefined = spec; branch; branch = branch.or) {
		if (
			atRequiredLocation(player, branch) &&
			optionsForBranch(player, branch).length >= branch.count
		) {
			out.push(branch);
		}
	}
	return out;
}

/** Can `spec` (or its `or` alternative) be paid right now? */
function canDiscard(player: PrivatePlayerState, spec: DiscardAtLocationSpec): boolean {
	return payableBranches(player, spec).length > 0;
}

/**
 * The owner's discard choice for `spec`: how many to spend + the union of every
 * payable branch's candidates (so an "X or Y" Faerie offers both kinds). Null
 * when nothing is payable. All shipped `or` branches share the primary count, so
 * one `count` covers the union.
 */
function discardChoiceFor(
	player: PrivatePlayerState,
	spec: DiscardAtLocationSpec
): AwakenDiscardChoice | null {
	const branches = payableBranches(player, spec);
	if (branches.length === 0) return null;
	const count = branches[0].count;
	const seen = new Set<string>();
	const options: AwakenDiscardOption[] = [];
	for (const branch of branches) {
		for (const opt of optionsForBranch(player, branch)) {
			// Augment tokens are fungible — keep them all so the player can pick N.
			const key = opt.ref.kind === 'augment' ? `augment:${options.length}` : refKey(opt.ref);
			if (seen.has(key)) continue;
			seen.add(key);
			options.push(opt);
		}
	}
	const identities = new Set(
		options.map((option) =>
			option.ref.kind === 'rune'
				? (option.runeId ?? option.label)
				: option.ref.kind === 'augment'
					? option.label
					: option.ref.kind === 'spirit'
						? option.label
						: refKey(option.ref)
		)
	);
	const genericOrAlternative =
		branches.length > 1 ||
		branches.some((branch) => branch.what === 'classTrait' || branch.name == null);
	const requiresSelection =
		options.length > count && identities.size > 1 && genericOrAlternative;
	return { count, options, ...(requiresSelection ? { requiresSelection: true as const } : {}) };
}

/** Are `refs` a legal, exact payment for `spec` (right count, all real candidates,
 *  no rune/spirit slot picked twice, augment picks within budget)? */
function validRefs(
	player: PrivatePlayerState,
	spec: DiscardAtLocationSpec,
	refs: AwakenDiscardRef[]
): boolean {
	const choice = discardChoiceFor(player, spec);
	if (!choice || refs.length !== choice.count) return false;
	const slotKeys = new Set(
		choice.options.filter((o) => o.ref.kind !== 'augment').map((o) => refKey(o.ref))
	);
	const augmentBudget = choice.options.filter((o) => o.ref.kind === 'augment').length;
	const usedSlots = new Set<string>();
	let augmentsUsed = 0;
	for (const ref of refs) {
		if (ref.kind === 'attackDie') return false;
		if (ref.kind === 'augment') {
			if (++augmentsUsed > augmentBudget) return false;
			continue;
		}
		const key = refKey(ref);
		if (!slotKeys.has(key) || usedSlots.has(key)) return false;
		usedSlots.add(key);
	}
	return true;
}

/** Discard the exact items named by `refs` (after {@link validRefs}). */
function discardRefs(player: PrivatePlayerState, refs: AwakenDiscardRef[], log: string[]): boolean {
	for (const ref of refs) {
		if (ref.kind === 'rune') {
			const slot = player.mats.find((r) => r.slotIndex === ref.slotIndex && r.hasRune);
			if (!slot) return false;
			slot.hasRune = false;
			log.push(`Discarded ${slot.name ?? (slot.type === 'relic' ? 'relic' : 'rune')}.`);
		} else if (ref.kind === 'spirit') {
			const idx = player.spirits.findIndex((s) => s.slotIndex === ref.slotIndex);
			if (idx < 0) return false;
			const [removed] = player.spirits.splice(idx, 1);
			log.push(`Discarded trait spirit ${removed.name}.`);
		} else if (ref.kind === 'augment') {
			if ((player.spiritAugments ?? 0) <= 0) return false;
			player.spiritAugments -= 1;
			log.push('Discarded an augment.');
		} else {
			return false;
		}
	}
	return true;
}

/**
 * Spend `spec` (after a successful `canDiscard`). When the owner supplied a valid
 * `refs` selection (which items to discard), spend exactly those; otherwise
 * auto-pick the first payable branch's first `count` candidates. Returns whether
 * the cost was fully paid.
 */
function performDiscard(
	player: PrivatePlayerState,
	spec: DiscardAtLocationSpec,
	log: string[],
	refs?: AwakenDiscardRef[]
): boolean {
	if (refs && validRefs(player, spec, refs)) {
		return discardRefs(player, refs, log);
	}
	const branches = payableBranches(player, spec);
	if (branches.length === 0) return false;
	const branch = branches[0];
	const auto = optionsForBranch(player, branch)
		.slice(0, branch.count)
		.map((o) => o.ref);
	return discardRefs(player, auto, log);
}

/**
 * Build a `{ check, pay }` handler for a discard-N-of-X(-at-location) condition.
 * `check` gates on the named location + a payable count; `pay` performs the
 * discard. Shared by all the discard-text spirits.
 */
export function discardAtLocation(spec: DiscardAtLocationSpec): AwakenHandler {
	return {
		check(ctx) {
			if (canDiscard(ctx.player, spec)) return { ok: true };
			if (spec.locationName && !atRequiredLocation(ctx.player, spec) && !spec.or) {
				return { ok: false, reason: 'wrong_location' };
			}
			return { ok: false, reason: 'cannot_discard' };
		},
		pay(ctx) {
			performDiscard(ctx.player, spec, ctx.log, selectionFrom(ctx));
		},
		discardChoice(ctx) {
			return discardChoiceFor(ctx.player, spec);
		}
	};
}

// ── Alignment + cultivate handlers (read a cultivate-time progress flag) ──────

/** A handler satisfied purely by a prior event recorded on `awakenProgress`. */
function progressFlagHandler(key: string, reason: string): AwakenHandler {
	return {
		check(ctx) {
			return ctx.player.awakenProgress?.[key] ? { ok: true } : { ok: false, reason };
		},
		pay(ctx) {
			// The condition was the event itself; awakening consumes the progress flag.
			if (ctx.player.awakenProgress) delete ctx.player.awakenProgress[key];
		}
	};
}

// ── Combat / PvP event handlers ───────────────────────────────────────────────

/** The Argent Loom — "Be Fallen in the Awakening Phase.": checked when it awakens (awakening is
 *  only possible in the Awakening Phase), so no flag is kept. Nothing is paid. */
const argentLoomHandler: AwakenHandler = {
	check(ctx) {
		return isFallen(ctx.player) ? { ok: true } : { ok: false, reason: 'fallen_required' };
	},
	pay() {}
};

const FIRE_RUNE_ID = '480cd5f7-adea-481d-8ea9-aad776599d7b';
const TWIN_PYRES_RUNES = 2;
const TWIN_PYRES_DICE = 5;

/** Held runes that pay a Fire Rune: Fire Runes, plus every rune with an awakened Trader. */
function fireRuneSlots(player: PrivatePlayerState) {
	const wild = runesAreWild(player);
	return player.mats.filter((slot) => {
		if (!slot?.hasRune || slot.type === 'relic' || slot.type === 'augment') return false;
		const id = baseRuneIdForSlot(slot);
		return id === FIRE_RUNE_ID || (wild && id !== null);
	});
}

/**
 * Keeper of the Twin Pyres — "Discard 2 Fire Runes, or discard 5 of any attack dice."
 * Either branch pays. A selection on the command (`discardRefs`) picks the branch: exactly 2
 * Fire-Rune slots, or exactly 5 owned attack dice. Without a selection (bots, old clients)
 * the rune branch pays first (text order), else the 5 weakest dice. When both ways are
 * possible, the awaken offer carries both (`alternatives`) and the owner picks one.
 */
const twinPyresHandler: AwakenHandler = {
	check(ctx) {
		const runes = fireRuneSlots(ctx.player);
		const dice = ctx.player.attackDice;
		const selected = selectionFrom(ctx);
		if (selected !== undefined && selected.length > 0) {
			if (selected.every((ref) => ref.kind === 'rune')) {
				const keys = new Set(selected.map((ref) => (ref as { slotIndex: number }).slotIndex));
				const ok =
					selected.length === TWIN_PYRES_RUNES &&
					keys.size === TWIN_PYRES_RUNES &&
					[...keys].every((k) => runes.some((slot) => slot.slotIndex === k));
				return ok ? { ok: true } : { ok: false, reason: 'invalid_fire_runes' };
			}
			if (selected.every((ref) => ref.kind === 'attackDie')) {
				const ids = new Set(selected.map((ref) => (ref as { instanceId: string }).instanceId));
				const ok =
					selected.length === TWIN_PYRES_DICE &&
					ids.size === TWIN_PYRES_DICE &&
					[...ids].every((id) => dice.some((die) => die.instanceId === id));
				return ok ? { ok: true } : { ok: false, reason: 'invalid_attack_dice' };
			}
			return { ok: false, reason: 'invalid_selection' };
		}
		if (runes.length >= TWIN_PYRES_RUNES || dice.length >= TWIN_PYRES_DICE) return { ok: true };
		return { ok: false, reason: 'need_2_fire_runes_or_5_attack_dice' };
	},
	pay(ctx) {
		const { player, log } = ctx;
		const selected = selectionFrom(ctx) ?? [];
		const runes = fireRuneSlots(player);
		const useDice =
			selected.length > 0
				? selected.every((ref) => ref.kind === 'attackDie')
				: runes.length < TWIN_PYRES_RUNES;
		if (!useDice) {
			const picked =
				selected.length > 0
					? runes.filter((slot) => selected.some((ref) => ref.kind === 'rune' && ref.slotIndex === slot.slotIndex))
					: // Real Fire Runes before wild Water Runes.
						[...runes].sort((a, b) => Number(baseRuneIdForSlot(a) !== FIRE_RUNE_ID) - Number(baseRuneIdForSlot(b) !== FIRE_RUNE_ID));
			for (const slot of picked.slice(0, TWIN_PYRES_RUNES)) {
				slot.hasRune = false;
				log.push(`Discarded ${slot.name ?? 'a rune'}.`);
			}
			return;
		}
		const rank = { basic: 0, enchanted: 1, exalted: 2, arcane: 3 } as const;
		const ids =
			selected.length > 0
				? new Set(selected.map((ref) => (ref as { instanceId: string }).instanceId))
				: new Set(
						[...player.attackDice]
							.sort((a, b) => rank[a.tier] - rank[b.tier])
							.slice(0, TWIN_PYRES_DICE)
							.map((die) => die.instanceId)
					);
		const before = player.attackDice.length;
		player.attackDice = player.attackDice.filter((die) => !ids.has(die.instanceId));
		log.push(`Discarded ${before - player.attackDice.length} attack dice to awaken Twin Flame Keeper.`);
	},
	discardChoice(ctx) {
		const runes = fireRuneSlots(ctx.player);
		const dice = ctx.player.attackDice;
		const runeWay: AwakenPaymentAlternative | null =
			runes.length >= TWIN_PYRES_RUNES
				? {
						label: 'Discard 2 Fire Runes',
						discardCount: TWIN_PYRES_RUNES,
						options: runes.map((slot) => ({
							ref: { kind: 'rune', slotIndex: slot.slotIndex },
							label: slot.name ?? 'Rune',
							runeId: slot.id
						}))
					}
				: null;
		const diceWay: AwakenPaymentAlternative | null =
			dice.length >= TWIN_PYRES_DICE
				? {
						label: 'Discard 5 attack dice',
						discardCount: TWIN_PYRES_DICE,
						options: dice.map((die) => ({
							ref: { kind: 'attackDie', instanceId: die.instanceId },
							label: `${die.tier[0].toUpperCase()}${die.tier.slice(1)} Attack die`
						}))
					}
				: null;
		if (runeWay && diceWay) {
			// Both ways are possible: the owner chooses (the picker opens on the rune way).
			return {
				count: runeWay.discardCount,
				options: runeWay.options,
				requiresSelection: true,
				alternatives: [runeWay, diceWay]
			};
		}
		if (runeWay) {
			const identities = new Set(runes.map((slot) => baseRuneIdForSlot(slot)));
			return {
				count: runeWay.discardCount,
				options: runeWay.options,
				...(runes.length > TWIN_PYRES_RUNES && identities.size > 1 ? { requiresSelection: true as const } : {})
			};
		}
		if (!diceWay) return null;
		const requiresSelection = dice.length > TWIN_PYRES_DICE && new Set(dice.map((d) => d.tier)).size > 1;
		return {
			count: diceWay.discardCount,
			options: diceWay.options,
			...(requiresSelection ? { requiresSelection: true as const } : {})
		};
	}
};

/**
 * "Discard 2 Arcane Abyss Spirits" (Arcane Synthesizer, Astrobiologist). Candidates
 * are the player's OTHER Arcane Abyss spirits — cost 7–9, the abyss-bag range (see
 * bags.ts ARCANE_ABYSS_COST_MIN/MAX) — excluding the spirit being awakened. The
 * owner picks which to discard; an invalid/absent selection auto-picks the first N.
 */
function discardAbyssSpirits(count: number): AwakenHandler {
	const candidates = (ctx: AwakenHandlerContext) =>
		ctx.player.spirits.filter(
			(s) => s.cost >= 7 && s.cost <= 9 && s.slotIndex !== ctx.spirit.slotIndex
		);
	return {
		check(ctx) {
			return candidates(ctx).length >= count
				? { ok: true }
				: { ok: false, reason: 'need_abyss_spirits' };
		},
		discardChoice(ctx) {
			const opts: AwakenDiscardOption[] = candidates(ctx).map((s) => ({
				ref: { kind: 'spirit', slotIndex: s.slotIndex },
				label: s.name
			}));
			return opts.length >= count
				? {
						count,
						options: opts,
						...(opts.length > count ? { requiresSelection: true as const } : {})
					}
				: null;
		},
		pay(ctx) {
			const valid = new Set(candidates(ctx).map((s) => s.slotIndex));
			const sel = selectionFrom(ctx);
			const refs: AwakenDiscardRef[] =
				sel &&
				sel.length === count &&
				sel.every((r) => r.kind === 'spirit' && valid.has(r.slotIndex))
					? sel
					: candidates(ctx)
							.slice(0, count)
							.map((s) => ({ kind: 'spirit', slotIndex: s.slotIndex }));
			discardRefs(ctx.player, refs, ctx.log);
		}
	};
}

/**
 * The two numbers of a "Have N <Origin> Spirits, or discard M Arcane Abyss Spirits." text, or
 * null when the text does not have that shape.
 */
export function parseHaveOriginOrDiscard(text: string | undefined): { need: number; discard: number } | null {
	const match = /\bhave\s+(\d+)\b[^.,]*?spirits?\s*,?\s*or\s+discard\s+(\d+)\s+arcane\s+abyss\s+spirits?/i.exec(text ?? '');
	if (match) return { need: Number(match[1]), discard: Number(match[2]) };
	// "Have N <Origin> Spirits." with no second half: the full origin board is the only way
	// (`discard` 0 = there is no discard branch).
	const only = /^\s*have\s+(\d+)\b[^.,]*?spirits?\s*\.?\s*$/i.exec(text ?? '');
	return only ? { need: Number(only[1]), discard: 0 } : null;
}

/**
 * "Have 7 <Origin> Spirits, or discard 3 Arcane Abyss Spirits." (Caldera, Storm King,
 * Hollowbloom). The first branch is free once the player holds `need` spirits of the origin
 * (awakened or not; the spirit itself counts). Otherwise the cost is the Abyss-spirit discard.
 * The two numbers are read from the catalog's awaken text (game data), so a data edit such as
 * "Have 5 …, or discard 2 …" is the rule; `need` / `discard` are used only when the text has no
 * numbers (the November 2026 text says 7 and 3, so old records replay unchanged).
 */
function haveOriginOrDiscardAbyss(origin: string, need: number, discard: number): AwakenHandler {
	const numbers = (ctx: AwakenHandlerContext) => {
		const awaken = ctx.catalog.spirits.find((s) => s.id === ctx.spirit.id)?.awaken;
		return parseHaveOriginOrDiscard(awaken?.kind === 'text' ? awaken.text : undefined) ?? { need, discard };
	};
	const fallbackFor = (ctx: AwakenHandlerContext) => discardAbyssSpirits(numbers(ctx).discard);
	const haveOrigin = (ctx: AwakenHandlerContext) =>
		ctx.player.spirits.reduce((total, s) => total + ((s.origins?.[origin] ?? 0) > 0 ? 1 : 0), 0) >=
		numbers(ctx).need;
	return {
		check(ctx) {
			if (haveOrigin(ctx)) return { ok: true };
			if (numbers(ctx).discard <= 0) return { ok: false, reason: 'need_origin_spirits' };
			const viaDiscard = fallbackFor(ctx).check(ctx);
			return viaDiscard.ok ? viaDiscard : { ok: false, reason: 'need_origin_spirits_or_abyss_spirits' };
		},
		discardChoice(ctx) {
			if (haveOrigin(ctx) || numbers(ctx).discard <= 0) return null;
			return fallbackFor(ctx).discardChoice?.(ctx) ?? null;
		},
		pay(ctx) {
			if (haveOrigin(ctx) || numbers(ctx).discard <= 0) return;
			fallbackFor(ctx).pay(ctx);
		}
	};
}

// ── The registry ──────────────────────────────────────────────────────────────

const IDS = AWAKEN_SPIRIT_IDS;
const KEYS = AWAKEN_PROGRESS_KEYS;

/**
 * Scripted text-awaken handlers, keyed by spirit id. A spirit here is satisfied
 * automatically by `awakenSpirit` (no manual confirm). Anything text-typed but
 * NOT here routes to {@link MANUAL_AWAKEN}.
 */
export const AWAKEN_HANDLERS: Record<string, AwakenHandler> = {
	// ── Category 1: state checks ──────────────────────────────────────────────
	// "Be Fallen in the Awakening Phase." (The Argent Loom; was "Discard 2 Arcane Abyss Spirits.")
	[IDS.argentLoom]: argentLoomHandler,
	// (Astrobiologist, Cosmic Guardian and the text cost of Arcane Huntress are not in the
	// November 2026 catalog: the first two spirits are gone, Tide Huntress (cafb6cfb) now has
	// a rune cost. Their ids/keys stay above for old replays only.)

	// ── Category 2: event progress flags ──────────────────────────────────────
	// "Cultivate while Evil."
	// Moon (2026-11-12): "Cultivate while Fallen." (Vespera): the action while Fallen, and Fallen to
	// awaken. Nhal is the exception (Michael: "Oh except Nhal"): "Navigate to the Arcane Abyss, but
	// don't fight the monster." needs no Fallen, so the Corruptor's status drop on awaken still works.
	[IDS.contessa]: fallenToAwaken(progressFlagHandler(KEYS.contessa, 'cultivate_while_fallen_required')),
	[IDS.shadowtaker]: progressFlagHandler(KEYS.shadowtaker, 'abyss_without_combat_required'),
	// "Cultivate." (the three Fairies)
	[IDS.floralFairy]: progressFlagHandler(KEYS.floralFairy, 'cultivate_required'),
	[IDS.lanternFairy]: progressFlagHandler(KEYS.lanternFairy, 'cultivate_required'),
	[IDS.tidalFairy]: progressFlagHandler(KEYS.tidalFairy, 'cultivate_required'),

	// ── Category 3: combat / pvp event ────────────────────────────────────────
	// (Hollow Eyes / The Threefold Watcher, 70ed3fcd, is not in the design data since
	// 2026-11-11 22:53. Its id and progress key stay above for old replays only.)
	// Moon rework (2026-11-12): event flags recorded only while Fallen, kept until the spirit
	// awakens, and the owner must be Fallen to awaken.
	// "While Fallen, attack another player." (Moonrend; was "Discard 4 of any attack dice.")
	[IDS.moonrend]: fallenToAwaken(progressFlagHandler(KEYS.moonrend, 'attack_another_player_required')),
	// "Become Corrupted while Fallen."
	[IDS.nightWitch]: fallenToAwaken(progressFlagHandler(KEYS.nightWitch, 'become_corrupted_required')),
	// "While Fallen, sacrifice a spirit."
	[IDS.moonCultist]: fallenToAwaken(progressFlagHandler(KEYS.moonCultist, 'sacrifice_a_spirit_required')),
	// "While Fallen, deal damage to another player."
	[IDS.veiledAcolyte]: fallenToAwaken(progressFlagHandler(KEYS.veiledAcolyte, 'deal_damage_to_a_player_required')),

	// ── Category 4: origin count OR Abyss discard ─────────────────────────────
	[IDS.caldera]: haveOriginOrDiscardAbyss('Fire Region', 7, 3),
	[IDS.stormKing]: haveOriginOrDiscardAbyss('Water Region', 7, 3),
	[IDS.hollowbloom]: haveOriginOrDiscardAbyss('Forest Region', 7, 3),

	// ── Category 5: rune OR attack-dice discard ───────────────────────────────
	[IDS.twinPyres]: twinPyresHandler,

	// ── Category 6: navigate-and-hold-back ────────────────────────────────────
	[IDS.travelingTrader]: progressFlagHandler(KEYS.travelingTrader, 'water_region_without_interactions_required')
};

/**
 * Text spirits intentionally routed to the manual-confirm path because the engine
 * lacks a deterministic way to script them. Owner/host resolves the condition by
 * hand and confirms via the `manualAwaken` command (which emits the verbatim DB
 * text as a prompt first). Empty today — every text spirit is scripted — but kept
 * as an exported Set so the coverage harness and the runtime share one allowlist.
 */
export const MANUAL_AWAKEN = new Set<string>([]);

/** True iff this spirit id has a scripted text-awaken handler. */
export function hasAwakenHandler(spiritId: string): boolean {
	return Object.prototype.hasOwnProperty.call(AWAKEN_HANDLERS, spiritId);
}

/**
 * Record cultivate-time awakening progress for the alignment/cultivate text
 * spirits (Contessa, Cosmic Guardian, Shadowtaker). Called from `applyCultivate`
 * for the acting seat at cultivate resolution time, so the flag reflects the
 * global alignment counts + the player's own alignment + summoned-spirit count at
 * that instant. Only sets a flag when the player actually holds the relevant
 * (face-down) spirit, so it never grants progress a player can't use.
 */
export function recordCultivateAwakenProgress(
	player: PrivatePlayerState,
	_allPlayers: PrivatePlayerState[]
): void {
	player.awakenProgress ??= {};
	const holds = (spiritId: string) => player.spirits.some((s) => s.id === spiritId && s.isFaceDown);

	// Vespera (Contessa id): "Cultivate while Fallen."
	if (holds(IDS.contessa) && isFallen(player)) {
		player.awakenProgress[KEYS.contessa] = true;
	}
	// The three Fairies: "Cultivate." (November 2026 — no origin-count gate; the Fairy's
	// ability scales with the origin count instead.)
	if (holds(IDS.floralFairy)) player.awakenProgress[KEYS.floralFairy] = true;
	if (holds(IDS.lanternFairy)) player.awakenProgress[KEYS.lanternFairy] = true;
	if (holds(IDS.tidalFairy)) player.awakenProgress[KEYS.tidalFairy] = true;
}
