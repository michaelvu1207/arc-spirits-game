/**
 * Spirit-augment policy — pure helpers shared by the engine (server) and the trait
 * list UI (client).
 *
 * A spirit augment is a class-linked rune permanently attached to one spirit. Rules:
 *  - One augment per spirit by default; it cannot be removed, replaced, or moved.
 *  - Once placed it is permanent — if the host spirit is removed/discarded, the
 *    augment goes with it (the engine cleans the attachment by spirit slot).
 *  - Some spirits raise their own augment capacity. The Fairy Droid class — "You may
 *    place unlimited Spirit Augments on this spirit" — is the current example.
 *  - An augment contributes its class toward the owner's trait totals, but only while
 *    its host spirit is awakened (face-up); face-down, it's dormant — i.e. it follows
 *    the spirit, exactly like the spirit's own classes do.
 */

import type { PendingAugment, PlayCatalog, PlaySpirit, PrivatePlayerState } from './types';
import { GENERIC_AUGMENT_RUNE_ID } from './effects/actions';

/**
 * The canonical Spirit Augment token set. A Spirit Augment is its OWN token type
 * (NOT a rune — augments are derived purely from the 6 augment classes; they have
 * no catalog rows). There are exactly these six, each
 * identified by the class it grants; placing one adds one of that class to the host
 * spirit and renders that class's icon. "Any Spirit Augment" = the player picks one
 * of these six.
 */
export const SPIRIT_AUGMENT_CLASSES = [
	'Fighter',
	'Elementalist',
	'Cultivator',
	'Soul Weaver',
	'Spirit Animal',
	'Cursed Spirit'
] as const;
export type SpiritAugmentClass = (typeof SPIRIT_AUGMENT_CLASSES)[number];
/** Is `name` one of the six real Spirit Augment classes? */
export function isSpiritAugmentClass(name: string): boolean {
	return (SPIRIT_AUGMENT_CLASSES as readonly string[]).includes(name);
}

/**
 * Classes that, when present on a spirit, let it hold MORE than the default one
 * augment. Fairy Droid grants unlimited placement. Add future "augment-capacity"
 * classes here.
 */
export const UNLIMITED_AUGMENT_CLASSES: ReadonlySet<string> = new Set(['Fairy Droid']);

/**
 * A spirit with an {@link UNLIMITED_AUGMENT_CLASSES} class can hold "unlimited"
 * augments. We model that as a large finite cap (99) rather than `Infinity` so the
 * value stays a plain integer everywhere it flows (capacity checks, bot scoring,
 * UI) — 99 is far beyond any reachable augment count in a real game.
 */
export const UNLIMITED_AUGMENT_CAPACITY = 99;

/**
 * Maximum number of augments that may be permanently placed on this spirit. Default
 * 1; a spirit with an {@link UNLIMITED_AUGMENT_CLASSES} class (e.g. Fairy Droid —
 * "You may place unlimited Spirit Augments on this spirit") can hold up to
 * {@link UNLIMITED_AUGMENT_CAPACITY}.
 */
export function augmentCapacityForSpirit(spirit: Pick<PlaySpirit, 'classes'>): number {
	for (const [cls, n] of Object.entries(spirit.classes ?? {})) {
		const count = typeof n === 'number' ? n : 1;
		if (count > 0 && UNLIMITED_AUGMENT_CLASSES.has(cls)) return UNLIMITED_AUGMENT_CAPACITY;
	}
	return 1;
}

/**
 * Count of augments ALREADY placed on the spirit in `slotIndex`, using the exact
 * predicate the reducer's capacity gate uses (`placeAugmentOnSpirit`): a class-linked
 * attachment (`className` string) or a legacy generic token. Shared so the view's
 * eligibility and the reducer's `augment_full` rejection count the same things.
 */
function placedAugmentCount(player: PrivatePlayerState, slotIndex: number): number {
	return (player.spiritAugmentAttachments ?? []).filter(
		(a) =>
			a.spiritSlotIndex === slotIndex &&
			(typeof a.className === 'string' || a.runeId === GENERIC_AUGMENT_RUNE_ID)
	).length;
}

/** Where one unplaced augment may legally be placed, and — for every spirit it may
 *  NOT go on — the reason (so the UI can dim that hex with a lock chip). */
export interface AugmentPlacementEligibility {
	/** Spirit slot indexes this augment may be placed on right now. */
	eligibleSpiritSlots: number[];
	/** slotIndex → why the augment cannot go there (keyed only for ineligible slots). */
	slotReasons: Record<number, string>;
}

/**
 * Resolve WHERE `augment` may be placed among the player's spirits, mirroring the three
 * slot gates the `placeAugmentOnSpirit` reducer enforces (designated-target binding,
 * host-class binding, per-spirit capacity). The className gate is orthogonal (see
 * {@link augmentClassChoices}) and not considered here. Shared by the reducer's
 * eligibility surface (viewV2) so the client never re-derives placement legality (S5).
 */
export function augmentPlacementEligibility(
	player: PrivatePlayerState,
	augment: PendingAugment
): AugmentPlacementEligibility {
	const eligibleSpiritSlots: number[] = [];
	const slotReasons: Record<number, string> = {};
	for (const spirit of player.spirits ?? []) {
		const slot = spirit.slotIndex;
		if (augment.boundSlotIndex != null && augment.boundSlotIndex !== slot) {
			slotReasons[slot] = `Must go on ${augment.boundLabel ?? 'its designated spirit'}`;
			continue;
		}
		if (augment.hostClass != null && (spirit.classes?.[augment.hostClass] ?? 0) <= 0) {
			slotReasons[slot] = `Needs ${augment.hostClass}`;
			continue;
		}
		const capacity = Math.max(augmentCapacityForSpirit(spirit), augment.hostCapacity ?? 0);
		if (placedAugmentCount(player, slot) >= capacity) {
			slotReasons[slot] = 'Augment slots full';
			continue;
		}
		eligibleSpiritSlots.push(slot);
	}
	return { eligibleSpiritSlots, slotReasons };
}

/**
 * The Spirit Augment classes the owner may choose for this token at placement. A
 * pre-bound augment (`classId` set — e.g. a class-scripted grant) offers only its own
 * class; an unbound augment offers all six {@link SPIRIT_AUGMENT_CLASSES} ("Any Spirit
 * Augment"). Mirrors the reducer's `className` resolution (`placeAugmentOnSpirit`).
 */
export function augmentClassChoices(augment: PendingAugment, catalog?: PlayCatalog): string[] {
	if (augment.classId) {
		const name = catalog?.classes.find((c) => c.id === augment.classId)?.name;
		return name ? [name] : [];
	}
	return [...SPIRIT_AUGMENT_CLASSES];
}

/** One placed augment's contribution to its owner's class traits. */
export interface AugmentContribution {
	/** The class the augment adds one of. */
	className: string;
	/** Follows the host spirit: awakened (face-up) ⇒ active; face-down ⇒ dormant. */
	awake: boolean;
}

/** The minimal player shape {@link augmentContributions} reads — satisfied by both
 *  the engine's PrivatePlayerState and the client's PlayerProjection. */
interface AugmentCountablePlayer {
	spirits: { slotIndex: number; isFaceDown: boolean }[];
	spiritAugmentAttachments?: { spiritSlotIndex: number; className?: unknown }[];
}

/**
 * Class contributions from a player's PLACED spirit augments. Each augment adds one
 * of its class; `awake` mirrors the host spirit's awaken state. Attachments without a
 * resolved class (plain rune attachments) and orphaned attachments (host spirit gone)
 * are ignored.
 */
export function augmentContributions(player: AugmentCountablePlayer): AugmentContribution[] {
	const out: AugmentContribution[] = [];
	for (const att of player.spiritAugmentAttachments ?? []) {
		const className = typeof att.className === 'string' ? att.className : null;
		if (!className) continue; // not a class-linked augment
		const host = player.spirits.find((s) => s.slotIndex === att.spiritSlotIndex);
		if (!host) continue; // host removed — its augments are cleaned with it
		out.push({ className, awake: !host.isFaceDown });
	}
	return out;
}
