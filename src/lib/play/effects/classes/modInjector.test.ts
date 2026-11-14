import { describe, expect, it } from 'vitest';
import { ability } from './modInjector';
import { ctxFor, fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { gainSpiritAugments, runAction } from '../actions';
import { decisions as ramDecisions } from './infiltrator';
import { augmentPlacementEligibility } from '../../augments';
import { addGainedRune } from '../../runtime';
import type { PrivatePlayerState } from '../../types';

/** Smith — "When you gain a Spirit Augment, you may gain 1 more of your choice. The extra augment
 *  does not cause this ability again." One rule, in the common gain path (gainSpiritAugments). */
const smithPlayer = (extra: Partial<PrivatePlayerState> = {}) =>
	makePlayer({ spirits: [spirit(1, { Smith: 1 }), spirit(2, { Fighter: 1 })], ...extra });

const FIGHTER_AUGMENT = { runeId: 'augment-fighter', name: 'Fighter', classId: 'cls-fighter', type: 'augment' as const };

describe('Smith', () => {
	it('has no trigger ability (it lives in the common augment-gain path)', () => {
		expect(ability).toEqual([]);
	});

	it('a trade-bought augment (location trade / reward rune path): the augment + 1 of your choice', () => {
		const player = smithPlayer();
		const log: string[] = [];
		addGainedRune(player, { ...FIGHTER_AUGMENT, originId: null, special: false }, log);
		expect(player.unplacedAugments!.map((a) => [a.name, a.classId])).toEqual([
			['Fighter', 'cls-fighter'],
			['Spirit Augment', undefined]
		]);
		expect(log.some((l) => l.startsWith('Smith:'))).toBe(true);
	});

	it('a non-trade gain (Captain-style gainAugment ×2): 1 more for EACH augment', () => {
		const player = smithPlayer();
		runAction(ctxFor(player), { kind: 'gainAugment', amount: 2 });
		expect(player.unplacedAugments).toHaveLength(4);
	});

	it('with Ram: one Mountain Region arrival gives 2 augments', () => {
		const player = makePlayer({
			navigationDestination: 'Mountain Region',
			spirits: [spirit(1, { Smith: 1 }), spirit(2, { Ram: 1 })]
		});
		applyTrigger(makeState(player), 'Red', 'onNavigate', []);
		ramDecisions.ramAugment(ctxFor(player), 'yes');
		expect(player.unplacedAugments).toHaveLength(2);
	});

	it('the extra does not cause Smith again', () => {
		const player = smithPlayer();
		expect(gainSpiritAugments(player, [{ runeId: 'x', name: 'Spirit Augment' }])).toBe(1);
		expect(player.unplacedAugments).toHaveLength(2); // not 3, 4, …
	});

	it('face-down Smith, or no Smith: no extra', () => {
		const faceDown = makePlayer({ spirits: [spirit(1, { Smith: 1 }, { faceDown: true })] });
		runAction(ctxFor(faceDown), { kind: 'gainAugment', amount: 1 });
		expect(faceDown.unplacedAugments).toHaveLength(1);
		const { player } = fire({ Captain: 1 }, 'onSpiritDiscard');
		expect(player.unplacedAugments ?? []).toHaveLength(0);
	});

	it('no room: the extra waits in the pouch with no legal spirit (discard it, or it is forfeited at round end)', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Smith: 1 })],
			spiritAugmentAttachments: [{ runeId: 'a', spiritId: 's1', spiritSlotIndex: 1, className: 'Beast' }]
		});
		runAction(ctxFor(player), { kind: 'gainAugment', amount: 1 });
		expect(player.unplacedAugments).toHaveLength(2);
		for (const augment of player.unplacedAugments!) {
			expect(augmentPlacementEligibility(player, augment).eligibleSpiritSlots).toEqual([]);
		}
	});
});
