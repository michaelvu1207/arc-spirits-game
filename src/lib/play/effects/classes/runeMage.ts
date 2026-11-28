import { runAction } from '../actions';
import { MAGE_AWAKEN_ARCANE_DICE } from '../../rules';
import type { ClassAbility } from './types';

// Mage — "On this spirit's Awakening, gain 3 Arcane Attack Dice." and nothing else (no rune trade
// in the Awakening Phase). The dice come once, when the awakened spirit itself is a Mage.

export const ability: ClassAbility[] = [
	{
		on: 'awakening',
		run(ctx) {
			const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
			const awakened = slot == null ? undefined : ctx.player.spirits.find((s) => s.slotIndex === slot);
			if (!awakened || (awakened.classes?.['Mage'] ?? 0) <= 0) return;
			runAction(ctx, { kind: 'gainAttackDice', tier: 'arcane', amount: MAGE_AWAKEN_ARCANE_DICE });
		}
	}
];
