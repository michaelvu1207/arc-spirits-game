import type { ClassAbility } from './types';

// Relic Sentinel — Awakening-Phase VP win-con ("if you have ≥24 VP and you are Good,
// gain 6 VP"), surfaced as a Cleanup CLAIM card, NOT an auto-applied effect.
//
// ENGINE-handled: `enterCleanup` (phases.ts) gates on `awakenedClassCounts >= 1 && !evil
// && victoryPoints >= 24` and pushes a `{ kind: 'vp', amount: 6, source: 'Relic Sentinel' }`
// line into `player.pendingAwakenReward.grants`; `resolveAwakenReward` (runtime.ts) applies
// the +6 VP when the player claims. The class `ability` array is intentionally empty so the
// effect system never double-grants the VP. See worldGuardian.test.ts.
export const ability: ClassAbility[] = [];
