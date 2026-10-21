import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';

/**
 * Woundreaver — "In Combat, deal 1 damage per Broken Barrier (max 4)."
 *
 * Broken Barrier is the damaged side of the potential pool: `maxTokens - barrier`.
 * The ability is a declarative `inCombat` breakpoint that adds a live-pool combat
 * bonus (`combatDamageBonus`), capped at 4. UX channel: a passive combat number
 * plus a log line, so it is never a silent no-op when broken barrier is present.
 */
describe('Woundreaver (inCombat, declarative — combat bonus from Broken Barrier)', () => {
	it('adds +1 combat damage per Broken Barrier', () => {
		// maxTokens 4, barrier 2 → 2 Broken Barrier → +2 combat damage.
		const { player } = fire({ 'Woundreaver': 1 }, 'inCombat', {
			player: { maxBarrier: 4, barrier: 2 }
		});
		expect(player.combatDamageBonus).toBe(2);
	});

	it('caps the bonus at 4 even with more Broken Barrier', () => {
		// maxTokens 10, barrier 0 → 10 Broken Barrier → capped at +4.
		const { player } = fire({ 'Woundreaver': 1 }, 'inCombat', {
			player: { maxBarrier: 10, barrier: 0 }
		});
		expect(player.combatDamageBonus).toBe(4);
	});

	it('surfaces a combat log line when Broken Barrier is present (no silent no-op)', () => {
		const { log } = fire({ 'Woundreaver': 1 }, 'inCombat', {
			player: { maxBarrier: 4, barrier: 1 }
		});
		expect(log.some((l) => /broken barrier/i.test(l) && /combat damage/i.test(l))).toBe(true);
	});

	it('adds nothing and logs nothing when at full barrier (zero Broken Barrier)', () => {
		// maxTokens 4, barrier 4 → 0 Broken Barrier → no bonus, no log.
		const { player, log } = fire({ 'Woundreaver': 1 }, 'inCombat', {
			player: { maxBarrier: 4, barrier: 4 }
		});
		expect(player.combatDamageBonus).toBe(0);
		expect(log.some((l) => /broken barrier/i.test(l))).toBe(false);
	});
});
