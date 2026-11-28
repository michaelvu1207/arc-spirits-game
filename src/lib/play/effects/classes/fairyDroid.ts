import type { ClassAbility } from './types';

// Herder — "Each of your Arcane spirits may hold up to 2 Spirit Augments." Capacity only (Arcane =
// cost 7 or more), read by augments.ts `ownerAugmentCapacity`; Herder has no triggered ability.
// The old rules ("adjacent Beasts", "unlimited augments on this spirit", "2 augments on awaken",
// "1 augment on each Beast", runes for Beasts on awaken) are gone.

export const ability: ClassAbility[] = [];
