import { placedAugmentTotal } from '../../augments';
import type { ClassAbility } from './types';

// Ram — "In combat, deal 1 more damage for each Spirit Augment on your spirits." (Michael,
// 2026-11-14.) Every placed augment counts, whatever its class and whether its spirit is awake;
// augments not yet placed do not. It applies in monster fights and player fights and does not
// grow with more Rams. Ram gives no augment at the Mountain Region.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			const augments = placedAugmentTotal(ctx.player);
			if (augments <= 0) return;
			ctx.player.combatDamageBonus += augments;
			ctx.log.push(`Ram: ${augments} Spirit Augment${augments === 1 ? '' : 's'} — deal ${augments} more damage.`);
		}
	}
];
