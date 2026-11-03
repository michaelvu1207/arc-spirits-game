import type { PrivatePlayerState, PublicGameState } from './types';
import type { NavigationPowerId } from './navigationPowers';

export type SpiritWorldRewardId = 'earth-rune' | 'fire-rune' | 'water-rune' | 'forest-rune' | 'restore-barriers' | 'gain-power';
export const SPIRIT_WORLD_REWARD_IDS: SpiritWorldRewardId[] = ['earth-rune','fire-rune','water-rune','forest-rune','restore-barriers','gain-power'];
export const SPIRIT_WORLD_REWARDS: Record<SpiritWorldRewardId, { name: string; label: string }> = {
  'earth-rune': { name: 'Earth Rune', label: 'Gain 1 Earth Rune' },
  'fire-rune': { name: 'Fire Rune', label: 'Gain 1 Fire Rune' },
  'water-rune': { name: 'Water Rune', label: 'Gain 1 Water Rune' },
  'forest-rune': { name: 'Forest Rune', label: 'Gain 1 Forest Rune' },
  'restore-barriers': { name: 'Barrier Ward', label: 'Restore 2 Barriers' },
  'gain-power': { name: 'Arcane Power', label: 'Gain 1 Power' }
};

export function rewardEntries(): { guid: string; name: string; rewardId: string; rewardLabel: string }[] {
  return SPIRIT_WORLD_REWARD_IDS.map((rewardId) => ({ guid: `reward-${rewardId}`, name: SPIRIT_WORLD_REWARDS[rewardId].name, rewardId, rewardLabel: SPIRIT_WORLD_REWARDS[rewardId].label }));
}

export function applySpiritWorldReward(
  state: PublicGameState,
  player: PrivatePlayerState,
  rewardId: SpiritWorldRewardId,
  drawPowerChoices: (state: PublicGameState, exclude?: NavigationPowerId[]) => NavigationPowerId[]
) {
  if (rewardId.endsWith('-rune')) {
    const map: Record<string, { name: string; originId: string }> = {
      'earth-rune': { name: 'Mountain Rune', originId: 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e' },
      'fire-rune': { name: 'Fire Rune', originId: '178449e9-cc6b-45ab-8522-5183fe1d9307' },
      'water-rune': { name: 'Water Rune', originId: '294cee31-a7ac-4292-9b61-d4293c05c146' },
      'forest-rune': { name: 'Forest Rune', originId: 'ad555f03-9b89-4a71-a47c-464fd67d2c05' }
    };
    const rune = map[rewardId];
    player.mats.push({ slotIndex: Math.max(0, ...player.mats.map((m) => m.slotIndex)) + 1, hasRune: true, name: rune.name, type: 'rune', originId: rune.originId });
    return;
  }
  if (rewardId === 'restore-barriers') {
    player.barrier = Math.min(player.maxBarrier, player.barrier + 2);
    player.brokenBarrier = Math.max(0, player.maxBarrier - player.barrier);
    return;
  }
  if (rewardId === 'gain-power') {
    player.pendingPowerDrafts ??= [];
    player.pendingPowerDrafts.push(drawPowerChoices(state, player.powerInventory ?? []));
  }
}
