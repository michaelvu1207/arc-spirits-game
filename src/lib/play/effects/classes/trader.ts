import type { ClassAbility } from './types';

// Trader (was Wayfinder; same class id) — "You may pay your runes as runes of any type."
// Engine-handled in the awakening payment: `spendableMats` (effects/matMatch.ts) marks every
// held rune as a wild rune for a player with an awakened Trader (see `runesAreWild`), so any
// rune can pay any named rune cost. Relics are not runes. Nothing fires on a trigger.
export const ability: ClassAbility[] = [];
