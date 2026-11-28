import { describe, it, expect } from 'vitest';
import { ability, decisions } from './healer';
import { fire, ctxFor, makePlayer } from './testHelpers';

/**
 * Healer — "On rest, if you have 10 max barrier, you may restore 3 barrier. When
 * discarded, restore 2 barrier." (No VP.)
 *
 * Encoding: a bespoke `onRest` run handler gated on `maxTokens >= 10`. Only then is
 * an opt-in decision card offered (`healerRestore`). The colocated `healerRestore`
 * resolver performs the restore-3 barrier (self only) when "yes" is picked.
 *
 * UX channels: a decision card (the "may" choice) + log lines. Below 10 potential a
 * log breadcrumb keeps the gate observable (no silent no-op).
 */
describe('Healer (onRest → 10-potential gated restore-3 decision)', () => {
	it('offers the opt-in decision card when at 10 potential', () => {
		const { player } = fire({ Healer: 1 }, 'onRest', { player: { maxBarrier: 10, barrier: 5 } });
		const decision = player.pendingDecisions.find((d) => d.kind === 'healerRestore');
		expect(decision).toBeDefined();
		expect(decision?.options.map((o) => o.id)).toEqual(['yes', 'no']);
	});

	it('surfaces the offered decision via the log (no silent no-op)', () => {
		const { log } = fire({ Healer: 1 }, 'onRest', { player: { maxBarrier: 10, barrier: 5 } });
		expect(log.some((l) => l.includes('Decision:'))).toBe(true);
	});

	it('does NOT offer the decision below 10 potential', () => {
		const { player } = fire({ Healer: 1 }, 'onRest', { player: { maxBarrier: 4, barrier: 1 } });
		expect(player.pendingDecisions.find((d) => d.kind === 'healerRestore')).toBeUndefined();
	});

	it('logs the gate breadcrumb when below 10 potential (no silent no-op)', () => {
		const { log } = fire({ Healer: 1 }, 'onRest', { player: { maxBarrier: 4, barrier: 1 } });
		expect(log.some((l) => /need 10 max barrier/i.test(l))).toBe(true);
	});

	it('does not fire on an unrelated trigger', () => {
		const { player } = fire({ Healer: 1 }, 'onTakeDamage', { player: { maxBarrier: 10, barrier: 5 } });
		expect(player.pendingDecisions).toHaveLength(0);
	});

	it('exposes an onSpiritDiscard breakpoint plus the bespoke onRest run handler', () => {
		expect(ability).toHaveLength(2);
		const discard = ability.find((a) => a.on === 'onSpiritDiscard');
		const rest = ability.find((a) => a.on === 'onRest');
		expect(discard?.breakpoints?.[0]).toMatchObject({
			count: 1,
			actions: [{ kind: 'restoreBarrier', amount: 2 }]
		});
		expect(typeof rest?.run).toBe('function');
		expect(rest?.breakpoints).toBeUndefined();
	});

	it('on discard restores 2 barrier (flips 2 broken-barrier tokens back)', () => {
		const { player } = fire({ Healer: 1 }, 'onSpiritDiscard', {
			player: { maxBarrier: 4, barrier: 0, brokenBarrier: 4 }
		});
		expect(player.barrier).toBe(2);
		expect(player.brokenBarrier).toBe(2);
	});
});

describe('Healer — healerRestore resolver (the "may restore")', () => {
	it('on "yes" restores 3 barrier (self only) and gives no VP', () => {
		// maxTokens 10, barrier 5 → restore 3 brings barrier to 8 (not capped).
		const player = makePlayer({ maxBarrier: 10, barrier: 5, victoryPoints: 0 });
		const ctx = ctxFor(player);
		decisions.healerRestore(ctx, 'yes');
		expect(player.barrier).toBe(8);
		expect(player.victoryPoints).toBe(0);
	});

	it('does NOT restore colocated allies (self only)', () => {
		const self = makePlayer({ maxBarrier: 10, barrier: 5 });
		const ally = makePlayer({
			playerColor: 'Blue',
			maxBarrier: 10,
			barrier: 5,
			navigationDestination: 'Forest Region'
		});
		self.navigationDestination = 'Forest Region';
		const ctx = ctxFor(self, { extra: { Blue: ally } });
		decisions.healerRestore(ctx, 'yes');
		expect(self.barrier).toBe(8);
		expect(ally.barrier).toBe(5);
	});

	it('surfaces the restore via a log line (no silent no-op)', () => {
		const player = makePlayer({ maxBarrier: 10, barrier: 5 });
		const ctx = ctxFor(player);
		decisions.healerRestore(ctx, 'yes');
		expect(ctx.log.some((l) => /restored 3 barrier/i.test(l))).toBe(true);
		expect(ctx.log.some((l) => /vp/i.test(l))).toBe(false);
	});

	it('on "no" changes nothing', () => {
		const player = makePlayer({ maxBarrier: 10, barrier: 5, victoryPoints: 0 });
		const ctx = ctxFor(player);
		decisions.healerRestore(ctx, 'no');
		expect(player.barrier).toBe(5);
		expect(player.victoryPoints).toBe(0);
		expect(ctx.log).toHaveLength(0);
	});
});
