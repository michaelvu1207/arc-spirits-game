import { runAction } from '../actions';
import type { ClassAbility, ClassHandler } from './types';

// Huntress — "Gain 2 initiative. On this spirit's Awakening, gain 3 Arcane Attack Dice."
// The awakening grant fires only when the spirit that just awakened is itself a Huntress
// (`ctx.command.slotIndex`), not on every later awakening while a Huntress is in play.
const huntressAwakening: ClassHandler = (ctx) => {
	const slot = (ctx.command as { slotIndex?: number } | undefined)?.slotIndex;
	if (slot == null) return;
	const spirit = ctx.player.spirits.find((s) => s.slotIndex === slot);
	if (!spirit || (spirit.classes?.['Huntress'] ?? 0) <= 0) return;
	runAction(ctx, { kind: 'gainAttackDice', tier: 'arcane', amount: 3 });
};

export const ability: ClassAbility[] = [
	{
		on: 'inCombat',
		breakpoints: [{ count: 1, actions: [{ kind: 'gainInitiative', amount: 2 }] }]
	},
	{ on: 'awakening', run: huntressAwakening }
];
