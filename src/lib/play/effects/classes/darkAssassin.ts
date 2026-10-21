import type { ClassAbility } from './types';
import type { PrivatePlayerState } from '../../types';

export const ability: ClassAbility[] = [{
 on: 'inCombat',
 breakpoints: [{ count: 1, actions: [{ kind: 'gainInitiative', amount: 4 }] }]
}];

/** Restore only the capacity actually gained, including gains clipped by the cap. */
export function restoreAegisBarrier(player: PrivatePlayerState, gained: number, log: string[]): void {
 if (gained <= 0 || !player.spirits.some(s => !s.isFaceDown && (s.classes?.['Aegis Weaver'] ?? 0) > 0)) return;
 const restored = Math.min(gained, player.maxBarrier - player.barrier);
 player.barrier += restored;
 player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
 log.push(`Aegis Weaver: restored ${restored} barrier after gaining ${gained} max barrier.`);
}
