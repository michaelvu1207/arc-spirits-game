import type { ClassAbility } from './types';

// Mystic — DB intent:
//   (1) "On a Spirit World or Abyss Summon, you may put all spirits back and draw
//       again." → the redraw mechanic. `redrawAvailable` is armed when a summon DRAW
//       OPENS (runtime.startDraw, gated on awakened Mystic count) so the ↻ Redraw
//       button shows BEFORE the first pick, and is cleared once the player picks a
//       spirit (runtime spawnHandSpirit). It is NOT re-armed per-summon — hence no
//       onSpiritSummon breakpoint here.
//   (2) At >=2, after corruption fully restores barrier, gain 2 max barrier.
//       This is handled beside corruption's full-restore step in combat.ts.
//   (3) At >=3, your side may attack simultaneously (combat.ts).
//   (4) At >=4, your spirits can hold a second augment (augments.ts).
export const ability: ClassAbility[] = [];
