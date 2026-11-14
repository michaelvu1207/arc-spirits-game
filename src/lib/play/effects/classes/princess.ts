import { isEvilAlignment } from '../../types';
import type { ClassAbility } from './types';

// Princess — "In the Awakening Phase, if you are not Evil and all your spirits are awakened,
// gain 1 VP." Checked when the Awakening Phase effects fire (the Benefits step).
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			const { player, log } = ctx;
			if (isEvilAlignment(player.statusLevel)) return;
			if (player.spirits.length === 0 || player.spirits.some((s) => s.isFaceDown)) return;
			player.victoryPoints += 1;
			log.push('Princess: not Evil and every spirit awakened — gain 1 VP.');
		}
	}
];
