import { BASE_RUNES } from '../../baseRunes';
import { REGION_ORIGIN_NAMES } from '../../regions';
import type { PlaySpirit, PrivatePlayerState } from '../../types';
import { ruleValue } from '../../rules';
import type { ClassAbility, ClassHandler } from './types';

// Herder — "On awaken, for each Beast that you have, gain 1 rune of the origin of that Beast."
//
// When the Herder spirit itself awakens: for each spirit of the owner whose own card has the
// Beast class (face-down too; a Beast ×3 card is one Beast; board position does not matter), the
// owner gains 1 base rune of that Beast's origin (a Beast with 2 origins: 1 of each origin that
// has a rune). An origin with no base rune (Moon, Sun, heroes) gives nothing. The runes go to the
// rune slots like any gained rune (carry limit and overflow at Cleanup as usual).
// The old rules ("adjacent Beasts", "unlimited augments on this spirit", "2 augments on awaken",
// "1 augment on each Beast") are gone.

/** The base rune id for an engine origin name ('Water Region' → Water Rune), if any. */
function baseRuneForOriginName(originName: string): string | undefined {
	const originId = Object.entries(REGION_ORIGIN_NAMES).find(([, name]) => name === originName)?.[0];
	if (!originId) return undefined;
	return Object.entries(BASE_RUNES).find(([, rune]) => rune.originId === originId)?.[0];
}

/** The owner's Beast spirits, one entry per spirit (face-down too). */
export function ownedBeasts(player: PrivatePlayerState): PlaySpirit[] {
	return (player.spirits ?? []).filter((s) => (s.classes?.['Beast'] ?? 0) > 0);
}

const herderAwakening: ClassHandler = (ctx) => {
	// Rule `herderArcaneAugments`: Herder is the augment capacity of Arcane spirits instead
	// (augments.ts `ownerAugmentCapacity`); it gives no runes.
	return;
};

export const ability: ClassAbility[] = [{ on: 'awakening', run: herderAwakening }];
