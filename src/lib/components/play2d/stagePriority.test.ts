import { describe, expect, it } from 'vitest';
import { showsAugmentPlacement } from './stagePriority';

describe('showsAugmentPlacement', () => {
	const base = { phase: 'awakening', activeAction: null, unplacedAugments: 2, pendingDecisions: 0 };
	it('Awakening: a pending decision card (a relic tool) comes before the augment screen', () => {
		expect(showsAugmentPlacement({ ...base, pendingDecisions: 1 })).toBe(false);
		expect(showsAugmentPlacement(base)).toBe(true); // the card is answered: place the augments
	});
	it('other steps keep the old order (augments first)', () => {
		for (const phase of ['location', 'encounter', 'benefits', 'cleanup']) {
			expect(showsAugmentPlacement({ ...base, phase, pendingDecisions: 1 })).toBe(true);
		}
	});
	it('no augments, or in combat: no augment screen', () => {
		expect(showsAugmentPlacement({ ...base, unplacedAugments: 0 })).toBe(false);
		expect(showsAugmentPlacement({ ...base, activeAction: 'combat' })).toBe(false);
	});
});
