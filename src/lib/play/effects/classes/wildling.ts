import type { ClassAbility } from './types';

// Wildling — "When you gain an attack dice, gain 1 Exalted Attack Dice."
// Engine-handled inside the `gainAttackDice` action (effects/actions.ts): each gain of one or
// more attack dice gives one extra Exalted die (within the dice cap). The extra die does not
// trigger Wildling again. Nothing fires on a trigger here.
export const ability: ClassAbility[] = [];
