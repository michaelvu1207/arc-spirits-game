/**
 * Strategist — DB intent: "On rest, you may discard 3 attack dice to gain 1
 * Spirit Augment."
 *
 * Gate: holding ≥3 attack dice on rest → an opt-in Yes/No decision card
 * (`strategistTrade`). On Yes the colocated resolver discards 3 dice and grants
 * 1 Spirit Augment; on No nothing changes. It is a single "may" choice (NOT
 * repeatable) — one card per rest.
 *
 * UX channel: a decision card (pendingDecisions) surfaced on rest plus a
 * "Decision: …" log line; the resolver mutates dice/augments and logs each grant
 * — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { ability, decisions } from './strategist';
import { fire, makePlayer, ctxFor, spirit } from './testHelpers';
import type { AttackDie } from '../../types';

function basicDice(n: number): AttackDie[] {
	return Array.from({ length: n }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }));
}

describe('Strategist (onRest → discard 3 dice for 1 Spirit Augment)', () => {
	it('offers the opt-in trade card on rest when holding ≥3 attack dice', () => {
		const { player, log } = fire({ Strategist: 1 }, 'onRest', {
			player: { attackDice: basicDice(3) }
		});
		expect(player.pendingDecisions).toHaveLength(1);
		const dec = player.pendingDecisions[0];
		expect(dec.kind).toBe('strategistTrade');
		expect(dec.options.map((o) => o.id)).toEqual(['yes', 'no']);
		// No silent no-op: the decision is also surfaced in the log.
		expect(log.some((l) => /Decision:/i.test(l))).toBe(true);
	});

	it('still offers the card when holding more than 3 dice', () => {
		const { player } = fire({ Strategist: 1 }, 'onRest', {
			player: { attackDice: basicDice(7) }
		});
		expect(player.pendingDecisions).toHaveLength(1);
		expect(player.pendingDecisions[0].kind).toBe('strategistTrade');
	});

	it('does NOT offer the trade with fewer than 3 dice', () => {
		const { player } = fire({ Strategist: 1 }, 'onRest', {
			player: { attackDice: basicDice(2) }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('does NOT offer the trade on a non-rest trigger', () => {
		const { player } = fire({ Strategist: 1 }, 'onCultivate', {
			player: { attackDice: basicDice(5) }
		});
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('Yes discards exactly 3 dice and gains exactly 1 Spirit Augment', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Strategist: 1 })],
			attackDice: basicDice(5)
		});
		const ctx = ctxFor(player);
		decisions.strategistTrade(ctx, 'yes');
		expect(player.attackDice).toHaveLength(2); // 5 - 3
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
		expect(ctx.log).toContain('Discarded 3 attack dice.');
		expect(ctx.log.some((l) => /spirit augment/i.test(l))).toBe(true);
	});

	it('discards the exact three mixed-tier dice selected by the owner', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Strategist: 1 })],
			attackDice: [
				{ instanceId: 'basic', tier: 'basic' },
				{ instanceId: 'enchanted', tier: 'enchanted' },
				{ instanceId: 'exalted', tier: 'exalted' },
				{ instanceId: 'arcane', tier: 'arcane' }
			]
		});
		const ctx = ctxFor(player);
		decisions.strategistTrade(ctx, 'yes', ['basic', 'enchanted', 'arcane']);
		expect(player.attackDice).toEqual([{ instanceId: 'exalted', tier: 'exalted' }]);
	});

	it('No does nothing (opt-out): dice and augments unchanged', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Strategist: 1 })],
			attackDice: basicDice(4),
			spiritAugments: 0
		});
		const ctx = ctxFor(player);
		decisions.strategistTrade(ctx, 'no');
		expect(player.attackDice).toHaveLength(4);
		expect(player.unplacedAugments?.length ?? 0).toBe(0);
		expect(ctx.log).toHaveLength(0);
	});

	it('is a single (non-repeatable) choice: Yes does not re-offer another card', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Strategist: 1 })],
			attackDice: basicDice(7) // 4 remain after a trade, but no re-offer
		});
		const ctx = ctxFor(player);
		decisions.strategistTrade(ctx, 'yes');
		expect(player.attackDice).toHaveLength(4);
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('exposes a single onRest gated-choose ability', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('onRest');
	});
});
