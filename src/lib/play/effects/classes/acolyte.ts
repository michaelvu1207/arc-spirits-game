import type { ClassAbility } from './types';

// Acolyte — "When you deal damage to a player, restore the same quantity of Barrier."
// Engine-handled in the PvP exchange (`combat.ts` resolveEncounterCombat → afterStrike): after
// each strike of this player's side, an awakened Acolyte who rolled damage restores the Barrier
// the hit player lost (the largest loss among the hit players, at most the Acolyte's own rolled
// damage), up to its Max Barrier. Monster combat is not affected.
export const ability: ClassAbility[] = [];
