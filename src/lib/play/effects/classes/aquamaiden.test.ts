import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';

describe('Tide Warden', () => {
	it('reduces incoming damage by each awakened Moon Tide spirit', () => {
		const { player } = fire({ 'Tide Warden': 1 }, 'onTakeDamage', {
			player: {
				spirits: [
					spirit(1, { 'Tide Warden': 1 }, { origins: { 'Moon Tide': 1 } }),
					spirit(2, {}, { origins: { 'Moon Tide': 1 } })
				]
			}
		});
		expect(player.damageReduction).toBe(2);
	});
});
