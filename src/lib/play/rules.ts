/**
 * The numbers of the Arc Spirits rules that more than one file reads.
 *
 * There is one ruleset and there are no rule switches (Michael, 2026-11-27: "have all experimental
 * changes be the official ruleset in the engine, no more flags"; "the current state of the game is the
 * full and only game"). A rule is changed by changing the code and the game data. How the rules of
 * November 2026 came about, switch by switch, is kept in docs/rules-history-2026-11.md.
 */
import { VP_TO_WIN, type DiceTier } from './types';

/** Victory Points that win the game. */
export { VP_TO_WIN };

/** The tier of the attack dice a Fairy gives when it awakens. */
export const FAIRY_DICE_TIER: DiceTier = 'enchanted';
/** The tier of the attack dice of Cursed Spirit's Tainted reward. */
export const CURSED_SPIRIT_DICE_TIER: DiceTier = 'basic';

/** The Barrier a Rest restores at Pure, Tainted, Corrupt and Fallen (never above the Max Barrier). */
export const REST_BARRIER_BY_STATUS: readonly [number, number, number, number] = [4, 4, 3, 2];
/** The Barrier a Rest restores at status `statusLevel` (0 Pure, 1 Tainted, 2 Corrupt, 3 Fallen). */
export function restBarrier(statusLevel: number): number {
	return REST_BARRIER_BY_STATUS[Math.min(3, Math.max(0, statusLevel))];
}

/** Attack dice upgrades for each Cultivate at 2, 3, 4 and 5 Elementalists (5: with a relic). */
export const ELEMENTALIST_UPGRADES: readonly [number, number, number, number] = [1, 2, 3, 5];
/** The upgrades of 5 Elementalists for a player who holds no relic. */
export const ELEMENTALIST_NO_RELIC_UPGRADES = 4;

/** Sentinel: damage for each attack die discarded before the roll. */
export const SENTINEL_DAMAGE_PER_DIE = 1;
/** Mage: Arcane attack dice gained on its awakening. */
export const MAGE_AWAKEN_ARCANE_DICE = 3;

/** Initiative is one die for each player, with this many sides. */
export const INITIATIVE_DIE_SIDES = 12;
/** Sides of the initiative die that hit at Pure, Tainted, Corrupt and Fallen (a roll of that number or less hits). */
export const INITIATIVE_HITS: readonly [number, number, number, number] = [4, 6, 7, 8];
/** How many sides of the initiative die hit at status `statusLevel` (0 Pure, 1 Tainted, 2 Corrupt, 3 Fallen). */
export function initiativeHits(statusLevel: number): number {
	return INITIATIVE_HITS[Math.min(3, Math.max(0, statusLevel))];
}
/** How the texts word an ability that covers a missed initiative die. */
export const GAIN_INITIATIVE_TEXT = 'gain the initiative if your side does not have it';

/** The most spirits one corruption costs: the 1st costs 1, the 2nd 2, the 3rd 3, and from the 4th on every corruption costs 4. */
export const SACRIFICE_MAX = 4;

/** Barrier a Difficulty 3 monster restores after a fight it survives. */
export const DIFFICULTY_3_RESTORE = 5;
/** Barrier a monster card of `difficulty` restores after a fight it survives (0: none). */
export function difficulty3Restore(difficulty: number | undefined): number {
	return difficulty === 3 ? DIFFICULTY_3_RESTORE : 0;
}

/** Whether an Evil player may attack Good players at this destination: at every location, the Arcane Abyss too. */
export function pvpAllowedAt(dest: string | null | undefined): boolean {
	return !!dest;
}
