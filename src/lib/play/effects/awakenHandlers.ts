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
 *   1. discard-N-of-X(-at-location) — {@link discardAtLocation}. Aquamaiden,
 *      Fairy Droid, Firewall, Blood Hound, Beefender, ENCODER, Lightcatcher,
 *      Lantern Fairy, Tidal Fairy, Floral Fairy, Rootguard.
 *   2. alignment + cultivate — Contessa, Cosmic Guardian, Shadowtaker. The
 *      cultivate-time condition is recorded on `player.awakenProgress` by
 *      `applyCultivate` (see {@link AWAKEN_PROGRESS_KEYS}); `check` reads it.
 *   3. combat / pvp event — Arcane Huntress (PvP while fallen), Hollow Eyes
 *      (deal >3 damage), Space Invader (discard 4 attack dice — the only one of
 *      the three with a payable cost rather than an event flag).
 *
 * Every spirit listed here is "scripted"; a text spirit NOT keyed here falls to
 * the manual-confirm path ({@link MANUAL_AWAKEN}). Encoding reads ONLY the English
 * DB description (translation columns are mojibake).
 */

import { isEvilAlignment, STATUS_LADDER } from '../types';
import type {
	AwakenDiscardOption,
	AwakenDiscardRef,
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
	arcaneSynthesizer: 'e75cb10c-fee4-488b-a213-e663c0fecae7',
	astrobiologist: '67c591ab-4227-4656-8697-247243975076',
	bloodHound: 'fc5835e9-156b-44fd-8037-832124df724c',
	contessa: 'e4822f18-98f0-44fd-8711-756f946f6cd5',
	cosmicGuardian: 'e9e12faa-0add-4fab-b251-a9dec5a8bae9',
	floralFairy: 'ae827012-29ff-406e-bcbe-afe3a5258607',
	hollowEyes: '70ed3fcd-a7c2-4443-b5e7-9b6de8491917',
	lanternFairy: 'c0d12557-4615-4c60-a93c-622e5fc70eae',
	meteorShower: '5dc44c85-8224-4c49-89ff-90a37aa10040',
	shadowtaker: 'fc667265-edd6-4c28-b96e-6e505188ce72',
	spaceInvader: 'b3068fcf-d197-4030-ba55-29ac1621f9a9',
	tidalFairy: '36bb656c-49fe-4d50-a037-b29dbd1bfa91'
} as const;

/**
 * Keys written to `player.awakenProgress` by the event sources (cultivate / PvP /
 * take-damage), and read by the matching `AWAKEN_HANDLERS.check`. Centralized so
 * the producer and consumer never drift.
 */
export const AWAKEN_PROGRESS_KEYS = {
	/** Contessa: cultivated while Evil. */
	contessa: 'awaken:contessa',
	/** Cosmic Guardian: cultivated while Good with ≥1 Evil player in the game. */
	cosmicGuardian: 'awaken:cosmicGuardian',
	/** Shadowtaker: cultivated with no other summoned spirit. */
	shadowtaker: 'awaken:shadowtaker',
	/** Arcane Huntress: cultivated while Fallen with ≥10 max barrier. */
	arcaneHuntress: 'awaken:arcaneHuntress',
	/** Meteor Shower: rested while holding ≥10 max barrier. */
	meteorShower: 'awaken:meteorShower',
	/** Hollow Eyes: dealt >3 damage to another player. */
	hollowEyes: 'awaken:hollowEyes'
} as const;

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
	/** For relics: only relics with ≤ this many barriers qualify (Blood Hound). */
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
		// `maxBarrier` (Blood Hound): relic barriers are not tracked on the held-rune
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

/**
 * Space Invader: "Discard 4 of any attack dice." Unlike the other combat-event
 * spirits this is a payable cost (no event flag): `check` needs ≥4 attack dice,
 * `pay` discards exactly 4.
 */
const spaceInvaderHandler: AwakenHandler = {
	check(ctx) {
		if (ctx.player.attackDice.length < 4) return { ok: false, reason: 'need_4_attack_dice' };
		const selected = selectionFrom(ctx);
		if (selected !== undefined) {
			const ids = selected
				.filter(
					(ref): ref is Extract<AwakenDiscardRef, { kind: 'attackDie' }> => ref.kind === 'attackDie'
				)
				.map((ref) => ref.instanceId);
			const owned = new Set(ctx.player.attackDice.map((die) => die.instanceId));
			if (
				ids.length !== 4 ||
				selected.length !== 4 ||
				new Set(ids).size !== 4 ||
				ids.some((id) => !owned.has(id))
			) {
				return { ok: false, reason: 'invalid_attack_dice' };
			}
		}
		return { ok: true };
	},
	pay(ctx) {
		const selected = selectionFrom(ctx);
		const selectedIds = selected?.every((ref) => ref.kind === 'attackDie')
			? new Set(selected.map((ref) => ref.instanceId))
			: null;
		const before = ctx.player.attackDice.length;
		if (selectedIds?.size === 4) {
			ctx.player.attackDice = ctx.player.attackDice.filter(
				(die) => !selectedIds.has(die.instanceId)
			);
		} else {
			// Old clients and bots may omit a selection. Preserve that compatibility,
			// but keep the strongest dice by auto-spending the four weakest tiers.
			const rank = { basic: 0, enchanted: 1, exalted: 2, arcane: 3 } as const;
			const autoIds = new Set(
				[...ctx.player.attackDice]
					.sort((a, b) => rank[a.tier] - rank[b.tier])
					.slice(0, 4)
					.map((die) => die.instanceId)
			);
			ctx.player.attackDice = ctx.player.attackDice.filter((die) => !autoIds.has(die.instanceId));
		}
		const discarded = before - ctx.player.attackDice.length;
		if (discarded > 0) ctx.log.push(`Discarded ${discarded} attack dice to awaken Space Invader.`);
	},
	discardChoice(ctx) {
		const distinctTiers = new Set(ctx.player.attackDice.map((die) => die.tier)).size;
		const requiresSelection = ctx.player.attackDice.length > 4 && distinctTiers > 1;
		return ctx.player.attackDice.length >= 4
			? {
					count: 4,
					options: ctx.player.attackDice.map((die) => ({
						ref: { kind: 'attackDie', instanceId: die.instanceId },
						label: `${die.tier[0].toUpperCase()}${die.tier.slice(1)} Attack die`
					})),
					...(requiresSelection ? { requiresSelection: true as const } : {})
				}
			: null;
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

// ── The registry ──────────────────────────────────────────────────────────────

const IDS = AWAKEN_SPIRIT_IDS;
const KEYS = AWAKEN_PROGRESS_KEYS;

/**
 * Scripted text-awaken handlers, keyed by spirit id. A spirit here is satisfied
 * automatically by `awakenSpirit` (no manual confirm). Anything text-typed but
 * NOT here routes to {@link MANUAL_AWAKEN}.
 */
export const AWAKEN_HANDLERS: Record<string, AwakenHandler> = {
	// ── Category 1: discard-N-of-X ────────────────────────────────────────────
	// "Discard 1 relic with 2 or less barriers." (barrier filter not enforced —
	// relic barriers aren't on the held snapshot; any held relic qualifies.)
	[IDS.bloodHound]: discardAtLocation({ what: 'relic', count: 1, maxBarrier: 2 }),
	// "Discard a Fairy or Flower Relic" — both are RELICS; no location gate.
	[IDS.floralFairy]: discardAtLocation({
		what: 'relic',
		name: 'Fairy',
		count: 1,
		or: { what: 'relic', name: 'Flower', count: 1 }
	}),
	// "Discard a Fairy or Firecracker Relic" — both RELICS.
	[IDS.lanternFairy]: discardAtLocation({
		what: 'relic',
		name: 'Fairy',
		count: 1,
		or: { what: 'relic', name: 'Firecracker', count: 1 }
	}),
	// "Discard a Fairy or Teapot Relic" — both RELICS.
	[IDS.tidalFairy]: discardAtLocation({
		what: 'relic',
		name: 'Fairy',
		count: 1,
		or: { what: 'relic', name: 'Teapot', count: 1 }
	}),
	// "Discard 2 Arcane Abyss Spirits." (cost 7–9 spirits, excluding self)
	[IDS.arcaneSynthesizer]: discardAbyssSpirits(2),
	[IDS.astrobiologist]: discardAbyssSpirits(2),

	// ── Category 2: cultivate / rest event (progress flag set when the action fires) ──
	// "Cultivate while Evil."
	[IDS.contessa]: progressFlagHandler(KEYS.contessa, 'cultivate_while_evil_required'),
	// "If there is at least 1 Evil player, Cultivate while Good."
	[IDS.cosmicGuardian]: progressFlagHandler(KEYS.cosmicGuardian, 'cultivate_while_good_required'),
	// "Cultivate with no summoned spirits other than this spirit."
	[IDS.shadowtaker]: progressFlagHandler(KEYS.shadowtaker, 'cultivate_alone_required'),
	// "Cultivate with 10 max barrier, with status Fallen."
	[IDS.arcaneHuntress]: progressFlagHandler(
		KEYS.arcaneHuntress,
		'cultivate_fallen_10_max_barrier_required'
	),
	// "Rest with 10 Max Barrier."
	[IDS.meteorShower]: progressFlagHandler(KEYS.meteorShower, 'rest_10_max_barrier_required'),

	// ── Category 3: combat / pvp event ────────────────────────────────────────
	// "Deal more than 3 damage to another player."
	[IDS.hollowEyes]: progressFlagHandler(KEYS.hollowEyes, 'deal_4_damage_required'),
	// "Discard 4 of any attack dice." (payable cost, not an event flag)
	[IDS.spaceInvader]: spaceInvaderHandler
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
	allPlayers: PrivatePlayerState[]
): void {
	player.awakenProgress ??= {};
	const evilCount = allPlayers.filter((p) => isEvilAlignment(p.statusLevel)).length;
	const selfEvil = isEvilAlignment(player.statusLevel);
	const selfFallen = player.statusLevel >= STATUS_LADDER.length - 1;

	const holds = (spiritId: string) => player.spirits.some((s) => s.id === spiritId && s.isFaceDown);

	// Contessa: "Cultivate while Evil."
	if (holds(IDS.contessa) && selfEvil) {
		player.awakenProgress[KEYS.contessa] = true;
	}
	// Cosmic Guardian: "at least 1 Evil player, Cultivate while Good".
	if (holds(IDS.cosmicGuardian) && !selfEvil && evilCount >= 1) {
		player.awakenProgress[KEYS.cosmicGuardian] = true;
	}
	// Shadowtaker: "Cultivate with no summoned spirits other than this spirit."
	// i.e. the only spirit in the tableau is Shadowtaker itself.
	if (holds(IDS.shadowtaker) && player.spirits.length === 1) {
		player.awakenProgress[KEYS.shadowtaker] = true;
	}
	// Arcane Huntress: "Cultivate with 10 max barrier, with status Fallen."
	if (holds(IDS.arcaneHuntress) && selfFallen && player.maxBarrier >= 10) {
		player.awakenProgress[KEYS.arcaneHuntress] = true;
	}
}

/**
 * Record rest-time awakening progress. Mirrors {@link recordCultivateAwakenProgress}
 * for the Rest action: Meteor Shower awakens by "Rest with 10 Max Barrier." Called from
 * the runtime when a player resolves a Rest. Only sets the flag when the player holds
 * the relevant face-down spirit, so it never grants progress they can't use.
 */
export function recordRestAwakenProgress(player: PrivatePlayerState): void {
	player.awakenProgress ??= {};
	const holds = (spiritId: string) => player.spirits.some((s) => s.id === spiritId && s.isFaceDown);
	if (holds(IDS.meteorShower) && player.maxBarrier >= 10) {
		player.awakenProgress[KEYS.meteorShower] = true;
	}
}
