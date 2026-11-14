import type { ClassAbility } from './types';

// Druid — "When you gain an Exalted Attack Dice, you may gain 1 more. The extra dice does not
// cause this ability again." (It replaces "If you gained or upgraded attack dice this turn,
// gain 2 max barrier or any 1 Spirit Augment".)
// Engine-handled inside the `gainAttackDice` action (effects/actions.ts), the one dice-gain
// path: each Exalted die gained (from any source, and the Wildling die) gives one more Exalted
// die, within the dice cap, taken automatically. An upgrade to Exalted is not a gain. The extra
// die triggers neither Druid nor Wildling. Nothing fires on a trigger here.
export const ability: ClassAbility[] = [];
