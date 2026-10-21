/**
 * Fatestriker — bespoke `inCombat` handler.
 *
 * DB-intended behavior (source of truth):
 *   - Gain 4 Initiative.
 *   - In the Battle Step, roll your attack twice and take the higher roll
 *     (the `attackRollAdvantage` flag consumed by `rollAttack`).
 *
 * UX channel: both halves surface as a single combat log line
 * ("Gained 4 initiative; will roll attack twice and take the higher."), plus the
 * mechanical +4 initiative and the `attackRollAdvantage` flag — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire, makePlayer, ctxFor } from './testHelpers';
import { ability } from './darkFighter';

describe('Fatestriker', () => {
	it('grants exactly 4 initiative on inCombat (changed from 6)', () => {
		const { player } = fire({ 'Fatestriker': 1 }, 'inCombat');
		expect(player.initiative).toBe(4);
	});

	it('sets attackRollAdvantage so the Battle Step rolls twice and keeps the higher', () => {
		const { player } = fire({ 'Fatestriker': 1 }, 'inCombat');
		expect(player.attackRollAdvantage).toBe(true);
	});

	it('surfaces both halves as an attributed log line (no silent no-op)', () => {
		const { log } = fire({ 'Fatestriker': 1 }, 'inCombat');
		expect(
			log.some((l) => l.includes('Gained 4 initiative; will roll attack twice and take the higher.'))
		).toBe(true);
	});

	it('adds 4 on top of any pre-existing initiative', () => {
		const { player } = fire({ 'Fatestriker': 1 }, 'inCombat', {
			player: { initiative: 3 }
		});
		expect(player.initiative).toBe(7);
	});

	it('handler unit test: mutates ctx.player directly with +4 and the advantage flag', () => {
		const player = makePlayer();
		const ctx = ctxFor(player, { trigger: 'inCombat' });
		ability[0].run!(ctx);
		expect(player.initiative).toBe(4);
		expect(player.attackRollAdvantage).toBe(true);
		expect(
			ctx.log.some((l) => l.includes('Gained 4 initiative; will roll attack twice and take the higher.'))
		).toBe(true);
	});

	it('is inactive when the Fatestriker spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'Fatestriker': 1 }, 'inCombat', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'Fatestriker': 1 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.initiative).toBe(0);
		expect(player.attackRollAdvantage).toBe(false);
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});
});
