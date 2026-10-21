import { describe, expect, it } from 'vitest';
import { ability } from './modInjector';

// Runic Duplicator duplicates the exact augment selected in a normal paid trade. The
// runtime owns that interaction because it needs the selected reward option.
describe('Runic Duplicator (engine-handled augment duplication)', () => {
	it('has no effect-system ability (handled by the paid-trade runtime path)', () => {
		expect(ability).toEqual([]);
	});
});
