import { WILDCARD_MAT_IDS } from '../../awakenConditions';
import type { ClassAbility } from './types';

// Nomad — "You may do ALL location interactions up to two times. In the Awakening Phase, gain 1
// Any basic Rune." The first part is a +1 per-row allowance via
// extraActions['locationInteraction'], re-granted onNavigate. The rune is the wild Any Rune (the
// one every player starts with; it pays any basic rune cost). The carry limit is enforced at
// Cleanup as for any rune.
export const ability: ClassAbility[] = [
	{
		on: 'onNavigate',
		breakpoints: [{ count: 1, actions: [{ kind: 'extraAction', actionKey: 'locationInteraction', amount: 1 }] }]
	},
	{
		on: 'awakeningPhase',
		run(ctx) {
			ctx.player.mats.push({
				slotIndex: ctx.player.mats.length + 1,
				hasRune: true,
				id: WILDCARD_MAT_IDS.anyRune,
				name: 'Any Rune',
				type: 'rune'
			});
			ctx.log.push('Gained 1 Any Rune.');
		}
	}
];
