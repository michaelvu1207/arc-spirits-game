/**
 * Corruptor — "Drop your status to Fallen, and replace all Spirit World spirits with a random
 * Arcane Abyss Spirit. Gain 2 Initiative."
 *   - Gain 2 Initiative (inCombat).
 *   - On the Corruptor's own awakening: status → Fallen; each Spirit World spirit (not a Hero)
 *     goes back to the Spirit World bag and its slot takes the top Arcane Abyss card, face-down.
 */

import { describe, it, expect } from 'vitest';
import { fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import type { PublicGameState } from '../../types';
import { ability } from './theCorruptor';

describe('Corruptor', () => {
	it('grants exactly 2 initiative on inCombat', () => {
		const { player } = fire({ 'Corruptor': 1 }, 'inCombat');
		expect(player.initiative).toBe(2);
	});

	it('surfaces the initiative gain as a log line (no silent no-op)', () => {
		const { log } = fire({ 'Corruptor': 1 }, 'inCombat');
		expect(log.some((l) => l.includes('Gained 2 initiative.'))).toBe(true);
	});

	it('adds 2 on top of any pre-existing initiative', () => {
		const { player } = fire({ 'Corruptor': 1 }, 'inCombat', {
			player: { initiative: 3 }
		});
		expect(player.initiative).toBe(5);
	});

	it('exposes the inCombat +2 initiative and the awakening handler', () => {
		const inCombat = ability.find((a) => a.on === 'inCombat');
		expect(inCombat?.breakpoints?.[0].actions).toEqual([{ kind: 'gainInitiative', amount: 2 }]);
		expect(typeof ability.find((a) => a.on === 'awakening')?.run).toBe('function');
		expect(ability).toHaveLength(2);
	});

	function corruptorState() {
		const player = makePlayer({
			statusLevel: 0,
			spirits: [
				{ ...spirit(1, { Corruptor: 1 }, { id: 'nhal', name: 'Nhal' }), cost: 7 },
				{ ...spirit(2, { Fighter: 1 }, { id: 'w1', name: 'World One', origins: { 'Fire Region': 1 } }), cost: 3 },
				{ ...spirit(3, { Healer: 1 }, { id: 'hero', name: 'Hero Mintyheart' }), cost: 1 },
				{ ...spirit(4, { Beast: 1 }, { id: 'w2', name: 'World Two' }), cost: 3 },
				{ ...spirit(5, { Titan: 1 }, { id: 'abyss', name: 'Abyss Old' }), cost: 9 }
			],
			spiritAugmentAttachments: [
				{ runeId: 'aug', spiritId: 'w1', spiritSlotIndex: 2, className: 'Fighter' }
			]
		});
		const state = makeState(player) as PublicGameState;
		state.round = 3;
		state.bags = {
			hexSpirits: { count: 0, contents: [] },
			abyssFallen: {
				count: 1,
				contents: [{ guid: 'g1', id: 'a1', name: 'Abyss One', cost: 7 }]
			}
		} as unknown as PublicGameState['bags'];
		return { player, state };
	}

	it('on its own awakening: drops to Fallen and replaces Spirit World spirits, not Heroes or Abyss spirits', () => {
		const { player, state } = corruptorState();
		const log: string[] = [];
		applyTrigger(state, 'Red', 'awakening', log, { command: { slotIndex: 1 } });
		expect(player.statusLevel).toBe(3);
		expect(player.statusToken).toBe('Fallen');
		expect(player.becameFallenThisRound).toBe(true);
		const bySlot = Object.fromEntries(player.spirits.map((s) => [s.slotIndex, s]));
		expect(bySlot[2]).toMatchObject({ id: 'a1', isFaceDown: true }); // top Abyss card, face-down
		expect(bySlot[4]).toBeUndefined(); // Abyss bag ran out → slot empty
		expect(bySlot[3].id).toBe('hero'); // Heroes stay
		expect(bySlot[5].id).toBe('abyss'); // Abyss spirits stay
		expect(state.bags.hexSpirits.contents.map((e) => e.id).sort()).toEqual(['w1', 'w2']);
		expect(state.bags.abyssFallen.contents).toHaveLength(0);
		expect(player.spiritAugmentAttachments).toHaveLength(0); // augment left with its spirit
		// A status drop is not a corruption: no barrier restore debt / sacrifice.
		expect(player.pendingCorruptionDiscard ?? null).toBeNull();
	});

	it('does nothing when another spirit awakens', () => {
		const { player, state } = corruptorState();
		applyTrigger(state, 'Red', 'awakening', [], { command: { slotIndex: 2 } });
		expect(player.statusLevel).toBe(0);
		expect(player.spirits).toHaveLength(5);
	});

	it('is inactive when the Corruptor spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'Corruptor': 1 }, 'inCombat', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'Corruptor': 1 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.initiative).toBe(0);
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});

});
