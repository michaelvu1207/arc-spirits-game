import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor } from './testHelpers';
import { decisions } from './firekeeper';
import type { MatSlotSnapshot } from '$lib/types';

// Firekeeper — DB intent: "In the Awakening phase, you may discard a relic for 3
// potential or 1 Arcane Attack."
//
// CHANGED entirely from (awakening gain 1 Arcane Attack + onTakeDamage reduce 3) to a
// single Awakening-phase opt-in: a bespoke `run` handler on `awakeningPhase` offers a
// DECISION card (kind `firekeeperRelicTrade`) ONLY when the player holds a relic. The
// colocated resolver discards exactly one relic and grants the chosen reward.

/** A held relic slot (relics live as `player.mats` entries with type 'relic'). */
function relic(slotIndex: number, name = 'Relic'): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name, type: 'relic' };
}
/** A plain (non-relic) rune slot. */
function rune(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Rune', type: 'rune' };
}

describe('Firekeeper (awakeningPhase relic trade)', () => {
	it('offers the relic-trade decision when the player holds a relic', () => {
		const { player } = fire({ Firekeeper: 1 }, 'awakeningPhase', {
			player: { mats: [relic(1)], relics: 1 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'firekeeperRelicTrade');
		expect(decision).toBeDefined();
		expect(decision?.options.map((o) => o.id)).toEqual(['potential', 'arcane', 'no']);
	});

	it('offers explicit relic choices only when held relics are materially different', () => {
		const { player } = fire({ Firekeeper: 1 }, 'awakeningPhase', {
			player: { mats: [relic(1, 'Flower'), relic(2, 'Teapot')], relics: 2 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'firekeeperRelicTrade')!;
		expect(decision.options.map((option) => option.id)).toEqual([
			'potential:1',
			'arcane:1',
			'potential:2',
			'arcane:2',
			'no'
		]);

		const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
		decisions.firekeeperRelicTrade(ctx, 'arcane:2');
		expect(player.mats.find((mat) => mat.slotIndex === 1)?.hasRune).toBe(true);
		expect(player.mats.find((mat) => mat.slotIndex === 2)?.hasRune).toBe(false);
	});

	it('surfaces the decision via the log (no silent no-op)', () => {
		const { log } = fire({ Firekeeper: 1 }, 'awakeningPhase', {
			player: { mats: [relic(1)], relics: 1 }
		});
		expect(log.some((line) => line.includes('Decision:'))).toBe(true);
	});

	it('is gated on holding a relic — no decision when none held', () => {
		const { player, log } = fire({ Firekeeper: 1 }, 'awakeningPhase', {
			// Only a plain rune (not a relic) — must not qualify.
			player: { mats: [rune(1)], relics: 0 }
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'firekeeperRelicTrade')).toBeUndefined();
		// No-silent-no-op: the gate is still observable in the log.
		expect(log.some((line) => line.includes('no relic to discard'))).toBe(true);
	});

	it('does not qualify on a relic slot whose rune was already discarded', () => {
		const { player } = fire({ Firekeeper: 1 }, 'awakeningPhase', {
			player: { mats: [{ slotIndex: 1, hasRune: false, name: 'Relic', type: 'relic' }], relics: 0 }
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'firekeeperRelicTrade')).toBeUndefined();
	});

	it('does not fire on unrelated triggers (no longer onTakeDamage / awakening gain)', () => {
		const { player } = fire({ Firekeeper: 1 }, 'onTakeDamage', {
			player: { mats: [relic(1)], relics: 1, damageReduction: 0 }
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'firekeeperRelicTrade')).toBeUndefined();
		// The old onTakeDamage damage reduction is gone.
		expect(player.damageReduction).toBe(0);
	});

	it('no longer grants an Arcane Attack passively on awakening', () => {
		const { player } = fire({ Firekeeper: 1 }, 'awakening', {
			player: { mats: [relic(1)], relics: 1, attackDice: [] }
		});
		// The old awakening auto-gain is gone — nothing arrives without the opt-in card.
		expect(player.attackDice).toEqual([]);
	});

	describe('firekeeperRelicTrade resolver', () => {
		it('discards one relic and grants 3 potential on "potential"', () => {
			const player = makePlayer({
				mats: [relic(1)],
				relics: 1,
				maxBarrier: 4,
				barrier: 4,
				brokenBarrier: 0
			});
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.firekeeperRelicTrade(ctx, 'potential');

			// Relic discarded: slot flipped off, tally decremented.
			expect(player.mats[0].hasRune).toBe(false);
			expect(player.relics).toBe(0);
			// +3 potential (capped at 10).
			expect(player.maxBarrier).toBe(7);
			expect(ctx.log.some((line) => line.includes('Discarded relic'))).toBe(true);
			expect(ctx.log.some((line) => line.includes('max barrier'))).toBe(true);
		});

		it('discards one relic and grants 1 Arcane Attack on "arcane"', () => {
			const player = makePlayer({ mats: [relic(1)], relics: 1, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.firekeeperRelicTrade(ctx, 'arcane');

			expect(player.mats[0].hasRune).toBe(false);
			expect(player.relics).toBe(0);
			expect(player.attackDice.map((d) => d.tier)).toEqual(['arcane']);
			expect(ctx.log.some((line) => line.includes('Discarded relic'))).toBe(true);
		});

		it('discards exactly ONE relic when several are held', () => {
			const player = makePlayer({ mats: [relic(1), relic(2)], relics: 2, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.firekeeperRelicTrade(ctx, 'arcane');

			const held = player.mats.filter((r) => r.type === 'relic' && r.hasRune);
			expect(held).toHaveLength(1);
			expect(player.relics).toBe(1);
			expect(player.attackDice).toHaveLength(1);
		});

		it('does nothing on "no"', () => {
			const player = makePlayer({ mats: [relic(1)], relics: 1, maxBarrier: 4, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.firekeeperRelicTrade(ctx, 'no');

			expect(player.mats[0].hasRune).toBe(true);
			expect(player.relics).toBe(1);
			expect(player.maxBarrier).toBe(4);
			expect(player.attackDice).toEqual([]);
		});

		it('does not grant a reward (or pay) when no relic is actually held', () => {
			const player = makePlayer({ mats: [rune(1)], relics: 0, maxBarrier: 4, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.firekeeperRelicTrade(ctx, 'potential');

			// Stale-card guard: no relic => no payment, no reward.
			expect(player.maxBarrier).toBe(4);
			expect(player.attackDice).toEqual([]);
		});
	});
});
