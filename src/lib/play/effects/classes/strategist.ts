import { isEvilAlignment, type PlayCatalog, type PrivatePlayerState } from '../../types';
import { ruleValue } from '../../rules';
import { runAction } from '../actions';
import type { ClassAbility } from './types';

/** Monk's Initiative gain and per-hit damage reduction while its condition holds. */
export const MONK_INITIATIVE = 5;
/** Under rule `spiritInitiativeTrim` (Michael, 2026-11-21). */
export const MONK_INITIATIVE_TRIMMED = 3;
export const monkInitiative = (catalog?: Pick<PlayCatalog, 'rules'> | null): number =>
	MONK_INITIATIVE_TRIMMED;
export const MONK_DAMAGE_REDUCTION = 2;

/**
 * "Have a Cursed Spirit": any owned spirit — face-down included — whose OWN card has the
 * Cursed Spirit class. A Cursed Spirit augment does not make its host a Cursed Spirit.
 */
export function hasCursedSpirit(player: PrivatePlayerState): boolean {
	return (player.spirits ?? []).some((s) => (s.classes?.['Cursed Spirit'] ?? 0) > 0);
}

// Monk — "While you are not Evil and have no Cursed Spirits, gain 5 Initiative and take 2
// less damage." Checked each time a combat starts (`inCombat`, monster and PvP), so a change
// of alignment or of the spirit line-up between two combats is picked up. Like Titan: the
// Initiative is for that combat and the reduction comes off each hit taken in it.
export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		run(ctx) {
			if (isEvilAlignment(ctx.player.statusLevel) || hasCursedSpirit(ctx.player)) return;
			runAction(ctx, { kind: 'gainInitiative', amount: monkInitiative(ctx.catalog) });
			runAction(ctx, { kind: 'reduceIncomingDamage', amount: MONK_DAMAGE_REDUCTION });
		}
	}
];
