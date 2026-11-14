import { describe, expect, it } from 'vitest';
import { ctxFor, makePlayer, spirit } from './testHelpers';
import { runAction } from '../actions';
import type { AttackDie } from '../../types';

// Druid — "When you gain an Exalted Attack Dice, you may gain 1 more. The extra dice does not
// cause this ability again." Wildling — "When you gain an attack dice, gain 1 Exalted Attack Dice."
const gain = (classes: Record<string, number>[], tier: AttackDie['tier'], amount: number, dice: AttackDie[] = []) => {
	const player = makePlayer({
		spirits: classes.map((c, i) => spirit(i + 1, c)),
		attackDice: dice
	});
	const ctx = ctxFor(player);
	runAction(ctx, { kind: 'gainAttackDice', tier, amount });
	return { player, log: ctx.log, tiers: player.attackDice.map((d) => d.tier) };
};
const filler = (n: number): AttackDie[] => Array.from({ length: n }, (_, i) => ({ instanceId: `f${i}`, tier: 'basic' }));

describe('Druid', () => {
	it('alone: each gained Exalted die gives one more; other tiers give nothing', () => {
		expect(gain([{ Druid: 1 }], 'exalted', 1).tiers).toEqual(['exalted', 'exalted']);
		expect(gain([{ Druid: 1 }], 'exalted', 2).tiers).toEqual(['exalted', 'exalted', 'exalted', 'exalted']);
		expect(gain([{ Druid: 1 }], 'basic', 1).tiers).toEqual(['basic']);
		expect(gain([{ Druid: 1 }], 'exalted', 1).log).toContain('Druid: gained 1 more exalted attack dice.');
	});

	it('the old rule is gone: no Awakening Phase reward card', () => {
		expect(gain([{ Druid: 1 }], 'basic', 1).player.pendingDecisions).toHaveLength(0);
	});

	it('is inactive while the Druid spirit is face-down', () => {
		const player = makePlayer({ spirits: [spirit(1, { Druid: 1 }, { faceDown: true })] });
		runAction(ctxFor(player), { kind: 'gainAttackDice', tier: 'exalted', amount: 1 });
		expect(player.attackDice).toHaveLength(1);
	});

	it('with Wildling: one gained die → that die + 1 Wildling Exalted + 1 Druid Exalted (no loop)', () => {
		expect(gain([{ Druid: 1 }, { Wildling: 1 }], 'basic', 1).tiers).toEqual(['basic', 'exalted', 'exalted']);
		// A gained Exalted die: + Wildling + one Druid die for each of the two Exalted dice.
		expect(gain([{ Druid: 1 }, { Wildling: 1 }], 'exalted', 1).tiers).toEqual([
			'exalted',
			'exalted',
			'exalted',
			'exalted'
		]);
	});

	it('at the dice cap: the extra dice stop at 10', () => {
		expect(gain([{ Druid: 1 }], 'exalted', 1, filler(9)).player.attackDice).toHaveLength(10);
		const near = gain([{ Druid: 1 }, { Wildling: 1 }], 'exalted', 1, filler(8));
		expect(near.player.attackDice).toHaveLength(10); // 8 + gained + Wildling, no room for Druid
		expect(near.log.some((l) => l.startsWith('Druid'))).toBe(false);
		const full = gain([{ Druid: 1 }], 'exalted', 1, filler(10));
		expect(full.player.attackDice).toHaveLength(10);
	});
});
