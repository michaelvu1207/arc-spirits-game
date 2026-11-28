import { WILDCARD_MAT_IDS } from '../../awakenConditions';
import { isEvilAlignment } from '../../types';
import type { ClassAbility } from './types';

// Princess — "In the Awakening Phase, if you are not Evil and all your spirits are awakened,
// gain 1 Any basic Rune." Checked when the Awakening Phase effects fire (the Benefits step). No
// point (balance test, 2026-11-18; Michael: "the Princess should just do something else
// entirely"). The rune is a placeholder effect chosen for the test, not Michael's wording.
export const ability: ClassAbility[] = [
	{
		on: 'awakeningPhase',
		run(ctx) {
			const { player, log } = ctx;
			if (isEvilAlignment(player.statusLevel)) return;
			if (player.spirits.length === 0 || player.spirits.some((s) => s.isFaceDown)) return;
			player.mats.push({ slotIndex: player.mats.length + 1, hasRune: true, id: WILDCARD_MAT_IDS.anyRune, name: 'Any Rune', type: 'rune' });
			log.push('Princess: not Evil and every spirit awakened — gain 1 Any Rune.');
		}
	}
];
