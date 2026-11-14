import type { ClassAbility } from './types';

// Smith — "When you gain a Spirit Augment, you may gain 1 more of your choice. The extra augment
// does not cause this ability again." Engine-handled in the common augment-gain path
// (`gainSpiritAugments`, effects/actions.ts): every augment gained from any source adds 1 generic
// augment of the owner's choice; the extra never triggers Smith again. Nothing fires on a trigger.
export const ability: ClassAbility[] = [];
