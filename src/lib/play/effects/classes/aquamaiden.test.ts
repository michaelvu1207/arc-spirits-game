import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';

describe('Warden', () => {
	it('reduces incoming damage by each awakened Water Region spirit', () => {
		const { player } = fire({ 'Warden': 1 }, 'onTakeDamage', {
			player: {
				spirits: [
					spirit(1, { 'Warden': 1 }, { origins: { 'Water Region': 1 } }),
					spirit(2, {}, { origins: { 'Water Region': 1 } })
				]
			}
		});
		expect(player.damageReduction).toBe(2);
	});
});
