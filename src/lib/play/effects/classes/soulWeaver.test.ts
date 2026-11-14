import { describe, it, expect } from 'vitest';
import { ability } from './soulWeaver';

describe('Mystic', () => {
	it('uses engine-owned behavior for all four breakpoints', () => {
		expect(ability).toEqual([]);
	});

	it('is covered by runtime, combat, and augment-capacity tests', () => {
		// Redraw: runtime; corruption potential + simultaneous combat: combat;
		// two-augment capacity: augments. This test prevents stale trigger effects.
		expect(ability).toHaveLength(0);
	});
});
