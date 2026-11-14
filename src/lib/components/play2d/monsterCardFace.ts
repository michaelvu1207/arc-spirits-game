/**
 * The printed face of an Arcane Abyss monster card.
 *
 * The cards are finished images (art, Health = Barrier, Damage, class, name and kill-reward icons are
 * baked in). The game shows one only while everything it prints is still what the game does; otherwise
 * MonsterCard draws the card from live data, as before.
 *
 * Image sources, in order:
 *  1. `monsters_v2.card_image_path` when it is NOT the path of these exports — a card someone else made
 *     (the editor's layout tool writes `card_images/monsters_v2/en_generated/<id>.png`). Trusted as is,
 *     served resized like all game art.
 *  2. The web copy bundled with the game (`static/monster-cards/cards/<id>.webp`), when the printed values
 *     (`monsterCardFaces.json`) match the live card. `card_image_path` pointing at the uploaded copy of the
 *     same export changes nothing: the bundle is the same picture without a storage round trip.
 *  3. Nothing: the caller draws the card.
 *
 * Rebuild the bundle and the manifest with `node scripts/build-monster-card-faces.mjs`.
 */
import { buildMonsterRewards } from '$lib/play/monsterRewards';
import { gameImageUrl } from '$lib/storageImages';
import faces from './monsterCardFaces.json';

/** What one exported card prints. */
export interface PrintedMonsterCard {
	/** Content hash of the web copy (cache key). */
	v: string;
	/** The name on the card (can differ from the database name). */
	name: string;
	/** "Health" on the card = the monster's Barrier. */
	barrier: number;
	damage: number;
	/** "CLASS n" on the card = the row's stage. */
	stage: number;
	/** Reward-track tokens drawn as icons on the card. */
	rewards: string[];
}

export interface MonsterCardFaceManifest {
	width: number;
	height: number;
	storageFolder: string;
	cards: Record<string, PrintedMonsterCard>;
}

const MANIFEST = faces as MonsterCardFaceManifest;

/** Print size of the exports: 2.75 x 4.75 in at 300 dpi. */
export const MONSTER_FACE_WIDTH = MANIFEST.width;
export const MONSTER_FACE_HEIGHT = MANIFEST.height;

/** The live card, in catalog terms. */
export interface MonsterFaceSubject {
	id: string;
	/** Printed (full) Barrier. Damage taken does not change it. Null: unknown, not checked
	 *  (a defeated card on the reward screen, when the catalog row is not loaded). */
	barrier: number | null;
	damage: number | null;
	rewardTrack: readonly string[];
}

export interface MonsterCardFace {
	url: string;
	/** What the image prints, when it is one of the bundled exports. */
	printed: PrintedMonsterCard | null;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const x = [...a].sort();
	const y = [...b].sort();
	return x.every((token, i) => token === y[i]);
}

/**
 * True when the card prints exactly what the game uses: the same Barrier and Damage, and an icon for
 * every reward a kill grants and for nothing else (a reward the engine cannot grant must not show).
 */
export function printedCardMatches(printed: PrintedMonsterCard, live: MonsterFaceSubject): boolean {
	if (live.barrier !== null && printed.barrier !== live.barrier) return false;
	if (live.damage !== null && printed.damage !== live.damage) return false;
	const granted = buildMonsterRewards([...live.rewardTrack]).map((option) => option.token);
	return sameTokens(printed.rewards, granted);
}

/** Resolve the image for a monster card face, or null to draw it. */
export function monsterCardFace(
	live: MonsterFaceSubject,
	catalogPath: string | null | undefined,
	manifest: MonsterCardFaceManifest = MANIFEST
): MonsterCardFace | null {
	const printed = manifest.cards[live.id] ?? null;
	if (printed && (!catalogPath || catalogPath === `${manifest.storageFolder}/${live.id}.png`)) {
		return printedCardMatches(printed, live)
			? { url: `/monster-cards/cards/${live.id}.webp?v=${printed.v}`, printed }
			: null;
	}
	const url = gameImageUrl(catalogPath);
	return url ? { url, printed: null } : null;
}
