import { isRelic } from '../../locationInteractions';
import { ELEMENTALIST_NO_RELIC_UPGRADES, ELEMENTALIST_UPGRADES } from '../../rules';
import type { PrivatePlayerState } from '../../types';
import { runAction } from '../actions';
import type { ClassAbility } from './types';

// Elementalist — dice QUALITY. An upgrade raises the player's lowest Basic or Enchanted die one
// step (Basic → Enchanted → Exalted; never to Arcane).
//
// Upgrades come from Cultivate only (Michael, 2026-11-22: "move elementalists to on cultivate
// instead of on rest so it doesn't conflict with fighters"): 1 / 2 / 3 / 5 upgrades at 2 / 3 / 4 / 5
// Elementalists, the lowest die first. The step at 5 counts only while the player holds a relic;
// without one, five Elementalists upgrade as four do. A lone Elementalist does nothing.

/** Whether the player holds a relic (any relic; a used relic tool is gone). */
export function holdsRelic(player: Pick<PrivatePlayerState, 'mats'>): boolean {
	return (player.mats ?? []).some((m) => m.hasRune && isRelic(m));
}

/**
 * The upgrades one Cultivate gives a player with `count` Elementalists: 1 / 2 / 3 / 5 at
 * 2 / 3 / 4 / 5. The top step (5) counts only while the player holds a relic; without one, five
 * Elementalists upgrade as four do.
 */
export function elementalistRestUpgrades(
	catalog: unknown,
	count: number,
	player: Pick<PrivatePlayerState, 'mats'>
): number {
	if (count >= 5 && !holdsRelic(player)) return ELEMENTALIST_NO_RELIC_UPGRADES;
	const capped = Math.min(count, 5);
	return capped >= 2 ? ELEMENTALIST_UPGRADES[capped - 2] : 0;
}

export const ability: ClassAbility[] = [
	{
		on: 'onCultivate',
		run(ctx) {
			const times = elementalistRestUpgrades(ctx.catalog, ctx.traitCount, ctx.player);
			if (times) runAction(ctx, { kind: 'upgradeDice', times });
		}
	}
];
