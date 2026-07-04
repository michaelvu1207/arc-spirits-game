import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor, spirit } from './testHelpers';
import { decisions } from './arcMage';
import type { AttackDie, DiceTier } from '../../types';

// Arc Mage — DB intent (CHANGED): "When you cultivate, you may discard 4 attack
// dice to gain 1 Arcane Attack Dice." Gate: ≥4 dice on cultivate → opt-in card
// (`arcMageTrade`). The owner PICKS which 4 to spend (client sends instance ids);
// bots / omitted picks auto-spend the 4 LOWEST-value dice (never an Arcane).
// Done ONCE per cultivate — no re-offer loop.

function dice(tiers: DiceTier[]): AttackDie[] {
	return tiers.map((tier, i) => ({ instanceId: `d${i}`, tier }));
}
function basicDice(n: number): AttackDie[] {
	return dice(Array.from({ length: n }, () => 'basic' as const));
}

describe('Arc Mage', () => {
	it('offers the opt-in trade card on cultivate when holding ≥4 attack dice', () => {
		const { player, log } = fire({ 'Arc Mage': 1 }, 'onCultivate', {
			player: { attackDice: basicDice(4) }
		});
		expect(player.pendingDecisions).toHaveLength(1);
		const dec = player.pendingDecisions[0];
		expect(dec.kind).toBe('arcMageTrade');
		expect(dec.options.map((o) => o.id)).toEqual(['yes', 'no']);
		expect(log.some((l) => l.includes('discard 4 attack dice'))).toBe(true);
	});

	it('does NOT offer the trade with only 3 dice (gate raised 3 → 4)', () => {
		const { player } = fire({ 'Arc Mage': 1 }, 'onCultivate', {
			player: { attackDice: basicDice(3) }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('does not offer the trade on a non-cultivate trigger', () => {
		const { player } = fire({ 'Arc Mage': 1 }, 'awakening', {
			player: { attackDice: basicDice(8) }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('Yes converts the PLAYER-CHOSEN 4 dice → 1 arcane (never touches unpicked dice)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { 'Arc Mage': 1 })],
			// 5 dice; the player picks 4 basics and keeps the exalted.
			attackDice: dice(['basic', 'basic', 'basic', 'basic', 'exalted'])
		});
		const ctx = ctxFor(player);
		decisions.arcMageTrade(ctx, 'yes', ['d0', 'd1', 'd2', 'd3']);
		// Kept the exalted, gained one arcane.
		expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['arcane', 'exalted']);
		expect(ctx.log).toContain('Discarded 4 attack dice.');
		expect(ctx.log).toContain('Gained 1 arcane attack dice.');
	});

	it('auto-spends the 4 LOWEST-value dice when no pick is supplied (bots keep the Arcane)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { 'Arc Mage': 1 })],
			attackDice: dice(['basic', 'basic', 'enchanted', 'exalted', 'arcane'])
		});
		const ctx = ctxFor(player);
		decisions.arcMageTrade(ctx, 'yes');
		// The two basics + enchanted + exalted are the 4 cheapest → spent.
		// The original arcane survives, plus the newly gained arcane.
		expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['arcane', 'arcane']);
	});

	it('falls back to auto-pick when the supplied selection is the wrong size', () => {
		const player = makePlayer({
			spirits: [spirit(1, { 'Arc Mage': 1 })],
			attackDice: dice(['basic', 'basic', 'basic', 'exalted', 'arcane'])
		});
		const ctx = ctxFor(player);
		// Only 3 ids supplied → invalid → auto-pick 4 lowest (3 basics + exalted).
		decisions.arcMageTrade(ctx, 'yes', ['d0', 'd1', 'd2']);
		expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['arcane', 'arcane']);
	});

	it('No does nothing (opt-out)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { 'Arc Mage': 1 })],
			attackDice: basicDice(4)
		});
		const before = player.attackDice.length;
		const ctx = ctxFor(player);
		decisions.arcMageTrade(ctx, 'no', ['d0', 'd1', 'd2', 'd3']);
		expect(player.attackDice).toHaveLength(before);
		expect(player.attackDice.every((d) => d.tier === 'basic')).toBe(true);
	});

	it('is ONCE per cultivate: does NOT re-offer even when ≥4 dice remain', () => {
		// 9 dice → after one convert (discard 4, +1 arcane) → 6 dice remain, but no re-offer.
		const player = makePlayer({
			spirits: [spirit(1, { 'Arc Mage': 1 })],
			attackDice: basicDice(9)
		});
		const ctx = ctxFor(player);
		decisions.arcMageTrade(ctx, 'yes', ['d0', 'd1', 'd2', 'd3']);
		expect(player.attackDice).toHaveLength(6); // 9 - 4 + 1
		expect(player.pendingDecisions).toHaveLength(0);
	});
});
