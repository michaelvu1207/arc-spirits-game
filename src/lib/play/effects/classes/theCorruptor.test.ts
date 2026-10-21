/**
 * Abyss Harbinger — one declarative breakpoint ability.
 *
 * DB-intended behavior (source of truth):
 *   - Gain 2 Initiative (inCombat).
 *   - When you get corrupted, gain 1 Arcane Attack Dice — this half is a Cleanup
 *     CLAIM card (phases.ts, corruptedThisRound), OUTSIDE the effect system, and is
 *     intentionally NOT implemented here.
 *
 * UX channel: the initiative gain surfaces as a combat log line
 * ("Gained 2 initiative.") plus the mechanical +2 initiative — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import { ability } from './theCorruptor';

describe('The Corruptor', () => {
	it('grants exactly 2 initiative on inCombat', () => {
		const { player } = fire({ 'The Corruptor': 1 }, 'inCombat');
		expect(player.initiative).toBe(2);
	});

	it('surfaces the initiative gain as a log line (no silent no-op)', () => {
		const { log } = fire({ 'The Corruptor': 1 }, 'inCombat');
		expect(log.some((l) => l.includes('Gained 2 initiative.'))).toBe(true);
	});

	it('adds 2 on top of any pre-existing initiative', () => {
		const { player } = fire({ 'The Corruptor': 1 }, 'inCombat', {
			player: { initiative: 3 }
		});
		expect(player.initiative).toBe(5);
	});

	it('exposes the single inCombat ability with gainInitiative 2', () => {
		const inCombat = ability.find((a) => a.on === 'inCombat');
		expect(inCombat?.breakpoints?.[0].actions).toEqual([{ kind: 'gainInitiative', amount: 2 }]);
		expect(ability).toHaveLength(1);
	});

	it('is inactive when the Corruptor spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'The Corruptor': 1 }, 'inCombat', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'The Corruptor': 1 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.initiative).toBe(0);
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});

	// The "when corrupted, gain 1 Arcane Attack Dice" half is a Cleanup CLAIM
	// (phases.ts, corruptedThisRound), OUTSIDE the effect system — not owned by this
	// class file. Per the delta hint it is already implemented there and left as-is,
	// so no effect-system assertion belongs here.
});
