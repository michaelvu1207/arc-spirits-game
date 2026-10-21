import type { ClassAbility } from './types';

// Wired at the summon/discard boundaries in runtime.ts because both halves depend
// on the card's source bag: Spirit World summons may open an Abyss draw, and
// discarded Arcane Abyss spirits grant 4 VP.
export const ability: ClassAbility[] = [];
