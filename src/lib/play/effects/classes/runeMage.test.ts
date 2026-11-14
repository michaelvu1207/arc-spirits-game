import { describe, it, expect } from 'vitest';
import { fire, ctxFor } from './testHelpers';
import { decisions } from './runeMage';
import type { MatSlotSnapshot } from '$lib/types';

// Mage — "In the Awakening Phase, you may discard a rune to gain an Enchanted Attack."
// One opt-in card per Awakening Phase, only while a rune is held; one rune → one die.

function rune(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Rune', type: 'rune' };
}
function relic(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Relic', type: 'relic' };
}

describe('Mage (Awakening Phase: discard a rune → 1 Enchanted Attack)', () => {
	it('offers the rune trade when a rune is held', () => {
		const { player } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [rune(1)] } });
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade');
		expect(decision?.options.map((o) => o.id)).toEqual(['rune', 'no']);
	});

	it('offers explicit slot choices for materially different runes and spends the selected one', () => {
		const forest = { ...rune(1), id: 'forest', name: 'Forest Rune' };
		const tidal = { ...rune(2), id: 'tidal', name: 'Tidal Rune' };
		const { player } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [forest, tidal] } });
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')!;
		expect(decision.options.map((option) => option.id)).toEqual(['rune:1', 'rune:2', 'no']);
		const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
		decisions.runeMageTrade(ctx, 'rune:2');
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.mats[1].hasRune).toBe(false);
		expect(player.attackDice.map((d) => d.tier)).toEqual(['enchanted']);
	});

	it('a relic alone offers nothing (the relic → Exalted trade is not in the text)', () => {
		const { player, log } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [relic(1)], relics: 1 } });
		expect(player.pendingDecisions).toHaveLength(0);
		expect(log.some((l) => l.includes('no rune'))).toBe(true);
	});

	it('resolving "rune" discards exactly one rune, grants 1 Enchanted, and does not re-offer', () => {
		const { player } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [rune(1), rune(2)] } });
		player.pendingDecisions = [];
		const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
		decisions.runeMageTrade(ctx, 'rune');
		expect(player.mats.filter((m) => m.hasRune)).toHaveLength(1);
		expect(player.attackDice.map((d) => d.tier)).toEqual(['enchanted']);
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('"no" changes nothing', () => {
		const { player } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [rune(1)] } });
		decisions.runeMageTrade(ctxFor(player, { trigger: 'awakeningPhase' }), 'no');
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.attackDice).toHaveLength(0);
	});
});
