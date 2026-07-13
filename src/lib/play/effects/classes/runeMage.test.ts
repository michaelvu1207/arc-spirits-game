import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor } from './testHelpers';
import { decisions } from './runeMage';
import type { MatSlotSnapshot } from '$lib/types';

// Rune Mage — DB intent: "In the Awakening phase, you may discard a rune to gain an
// Enchanted Attack and/or a Relic for an Exalted Attack."
//
// CHANGED entirely from (onLocationInteraction trade handler) to a single Awakening-
// phase opt-in: a bespoke `run` handler on `awakeningPhase` offers a DECISION card
// (kind `runeMageTrade`) ONLY when the player holds a rune and/or a relic, gating each
// option on the matching item. The colocated resolver discards one item of the chosen
// kind, grants the matching attack die, and re-offers (the "and/or").

/** A held plain (non-relic) rune slot. */
function rune(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Rune', type: 'rune' };
}
/** A held relic slot (relics live as `player.mats` entries with type 'relic'). */
function relic(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Relic', type: 'relic' };
}

describe('Rune Mage (awakeningPhase rune/relic trade)', () => {
	it('offers both options when the player holds a rune and a relic', () => {
		const { player } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [rune(1), relic(2)], relics: 1 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade');
		expect(decision).toBeDefined();
		expect(decision?.options.map((o) => o.id)).toEqual(['rune', 'relic', 'no']);
	});

	it('offers explicit slot choices for materially different runes and spends the selected one', () => {
		const forest = { ...rune(1), id: 'forest', name: 'Forest Rune' };
		const tidal = { ...rune(2), id: 'tidal', name: 'Tidal Rune' };
		const { player } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [forest, tidal], relics: 0 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')!;
		expect(decision.options.map((option) => option.id)).toEqual(['rune:1', 'rune:2', 'no']);

		const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
		decisions.runeMageTrade(ctx, 'rune:2');
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.mats[1].hasRune).toBe(false);
	});

	it('only offers the rune option when no relic is held', () => {
		const { player } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [rune(1)], relics: 0 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade');
		expect(decision?.options.map((o) => o.id)).toEqual(['rune', 'no']);
	});

	it('only offers the relic option when no plain rune is held', () => {
		const { player } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [relic(1)], relics: 1 }
		});
		const decision = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade');
		expect(decision?.options.map((o) => o.id)).toEqual(['relic', 'no']);
	});

	it('surfaces the decision via the log (no silent no-op)', () => {
		const { log } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [rune(1)], relics: 0 }
		});
		expect(log.some((line) => line.includes('Decision:'))).toBe(true);
	});

	it('is gated on holding an item — no decision when neither is held', () => {
		const { player, log } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: { mats: [], relics: 0 }
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')).toBeUndefined();
		// No-silent-no-op: the gate is still observable in the log.
		expect(log.some((line) => line.includes('no rune or relic to discard'))).toBe(true);
	});

	it('does not qualify on slots whose rune was already discarded', () => {
		const { player } = fire({ 'Rune Mage': 1 }, 'awakeningPhase', {
			player: {
				mats: [
					{ slotIndex: 1, hasRune: false, name: 'Rune', type: 'rune' },
					{ slotIndex: 2, hasRune: false, name: 'Relic', type: 'relic' }
				],
				relics: 0
			}
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')).toBeUndefined();
	});

	it('does not fire on the old onLocationInteraction trigger anymore', () => {
		const { player } = fire({ 'Rune Mage': 1 }, 'onLocationInteraction', {
			player: { mats: [rune(1), relic(2)], relics: 1, attackDice: [] }
		});
		expect(player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')).toBeUndefined();
		// The old trade auto-gain is gone — nothing arrives from a location interaction.
		expect(player.attackDice).toEqual([]);
	});

	describe('runeMageTrade resolver', () => {
		it('discards one rune and grants 1 Enchanted Attack on "rune"', () => {
			const player = makePlayer({ mats: [rune(1)], relics: 0, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.runeMageTrade(ctx, 'rune');

			expect(player.mats[0].hasRune).toBe(false);
			expect(player.attackDice.map((d) => d.tier)).toEqual(['enchanted']);
			expect(ctx.log.some((line) => line.includes('Discarded rune'))).toBe(true);
		});

		it('discards one relic and grants 1 Exalted Attack on "relic"', () => {
			const player = makePlayer({ mats: [relic(1)], relics: 1, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.runeMageTrade(ctx, 'relic');

			expect(player.mats[0].hasRune).toBe(false);
			expect(player.relics).toBe(0);
			expect(player.attackDice.map((d) => d.tier)).toEqual(['exalted']);
			expect(ctx.log.some((line) => line.includes('Discarded relic'))).toBe(true);
		});

		it('re-offers the choice after a trade (the "and/or") while an item remains', () => {
			const player = makePlayer({ mats: [rune(1), relic(2)], relics: 1, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			// Discard the rune first; a relic is still held, so re-offer with only "relic".
			decisions.runeMageTrade(ctx, 'rune');

			const reoffer = player.pendingDecisions.find((d) => d.kind === 'runeMageTrade');
			expect(reoffer).toBeDefined();
			expect(reoffer?.options.map((o) => o.id)).toEqual(['relic', 'no']);

			// Resolve the relic leg too — both legs done in one Awakening.
			decisions.runeMageTrade(ctx, 'relic');
			expect(player.attackDice.map((d) => d.tier).sort()).toEqual(['enchanted', 'exalted']);
		});

		it('does not re-offer once no tradeable item remains', () => {
			const player = makePlayer({ mats: [rune(1)], relics: 0, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.runeMageTrade(ctx, 'rune');

			// The only rune is spent — no fresh card enqueued.
			expect(player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')).toBeUndefined();
		});

		it('discards exactly ONE rune when several are held', () => {
			const player = makePlayer({ mats: [rune(1), rune(2)], relics: 0, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.runeMageTrade(ctx, 'rune');

			const held = player.mats.filter((r) => r.type === 'rune' && r.hasRune);
			expect(held).toHaveLength(1);
			expect(player.attackDice).toHaveLength(1);
		});

		it('does nothing on "no"', () => {
			const player = makePlayer({ mats: [rune(1), relic(2)], relics: 1, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			decisions.runeMageTrade(ctx, 'no');

			expect(player.mats[0].hasRune).toBe(true);
			expect(player.mats[1].hasRune).toBe(true);
			expect(player.relics).toBe(1);
			expect(player.attackDice).toEqual([]);
			// No re-offer on a decline.
			expect(player.pendingDecisions.find((d) => d.kind === 'runeMageTrade')).toBeUndefined();
		});

		it('does not grant a reward (or pay) when the chosen item is not actually held', () => {
			const player = makePlayer({ mats: [relic(1)], relics: 1, attackDice: [] });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			// Pick "rune" though only a relic is held — stale-card guard: no pay, no reward.
			decisions.runeMageTrade(ctx, 'rune');

			expect(player.mats[0].hasRune).toBe(true);
			expect(player.relics).toBe(1);
			expect(player.attackDice).toEqual([]);
		});
	});
});
