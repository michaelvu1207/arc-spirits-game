import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor } from './testHelpers';
import { ability } from './worldEnder';

// Void Sovereign — DB intent: "In the Awakening Phase, gain 1 VP." Unconditional.
//
// CHANGED from an all-Evil win-con (+3 VP × players, surfaced as a Cleanup CLAIM)
// to a flat, unconditional +1 VP fired by a bespoke `run` handler on the
// `awakeningPhase` trigger. The handler mutates `player.victoryPoints` and emits a
// log line (the UX surface — no silent no-op).

describe('Void Sovereign (awakeningPhase +1 VP)', () => {
	it('grants exactly +1 VP in the Awakening Phase', () => {
		const { player } = fire({ 'Void Sovereign': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 5 }
		});
		expect(player.victoryPoints).toBe(6);
	});

	it('grants +1 VP unconditionally — regardless of alignment (Good)', () => {
		const { player } = fire({ 'Void Sovereign': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 0, statusLevel: 0 }
		});
		expect(player.victoryPoints).toBe(1);
	});

	it('grants +1 VP unconditionally — even when Evil', () => {
		const { player } = fire({ 'Void Sovereign': 1 }, 'awakeningPhase', {
			// A clearly-Evil status level; the grant must not depend on alignment.
			player: { victoryPoints: 3, statusLevel: 5 }
		});
		expect(player.victoryPoints).toBe(4);
	});

	it('surfaces the gain via the log (no silent no-op)', () => {
		const { log } = fire({ 'Void Sovereign': 1 }, 'awakeningPhase', {
			player: { victoryPoints: 0 }
		});
		expect(log.some((line) => line.includes('Void Sovereign') && line.includes('1 VP'))).toBe(true);
	});

	it('only fires on the awakeningPhase trigger, not on awakening', () => {
		const { player } = fire({ 'Void Sovereign': 1 }, 'awakening', {
			player: { victoryPoints: 5 }
		});
		// The old all-Evil claim is gone and nothing fires on the per-spirit `awakening`.
		expect(player.victoryPoints).toBe(5);
	});

	it('only grants +1 once per fire (no per-player ×N scaling)', () => {
		// Even with multiple Void Sovereign counts on one player, the flat handler grants
		// exactly +1 (it is alignment- and count-independent).
		const { player } = fire({ 'Void Sovereign': 3 }, 'awakeningPhase', {
			player: { victoryPoints: 0 }
		});
		expect(player.victoryPoints).toBe(1);
	});

	describe('handler unit (direct run)', () => {
		it('mutates victoryPoints and logs', () => {
			const player = makePlayer({ victoryPoints: 10 });
			const ctx = ctxFor(player, { trigger: 'awakeningPhase' });
			const handler = ability.find((a) => a.on === 'awakeningPhase');
			expect(handler?.run).toBeDefined();
			handler!.run!(ctx);
			expect(player.victoryPoints).toBe(11);
			expect(ctx.log.length).toBeGreaterThan(0);
		});
	});
});
