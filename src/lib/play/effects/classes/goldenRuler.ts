import type { ClassAbility } from './types';

// Dawn Sovereign — "In the Awakening Phase, gain 1 VP. If you are evil, you must discard
// this spirit." Surfaced as a Cleanup CLAIM card (enterCleanup → resolveAwakenReward),
// not an auto-applied effect, so there is no effect-system entry here.
export const ability: ClassAbility[] = [];
