import type { ClassAbility } from './types';

// Prince — "When you strike first, deal 2 more damage."
// Engine-handled in combat.ts (`strikeFirstDamageBonus`): +2 to this player's damage when their
// side strikes first in a PvP exchange, or when they attack first against a monster (monsters
// otherwise strike first). A tied, simultaneous exchange is not "first".
export const ability: ClassAbility[] = [];
