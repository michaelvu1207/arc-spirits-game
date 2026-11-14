import { describe, expect, it } from 'vitest';
import { ctxFor, fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { decisions } from './infiltrator';
import type { PrivatePlayerState } from '../../types';

/** Ram — "When you navigate to the Mountain Region, you may gain 1 Spirit Augment of your choice." */
function navigate(player: PrivatePlayerState, destination: string) {
	player.navigationDestination = destination as PrivatePlayerState['navigationDestination'];
	applyTrigger(makeState(player), 'Red', 'onNavigate', []);
	return player.pendingDecisions.filter((d) => d.kind === 'ramAugment');
}

describe('Ram', () => {
	it('Mountain Region: one yes/no card that ends at Benefits; yes gives 1 generic augment', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 })] });
		const [card] = navigate(player, 'Mountain Region');
		expect(card.options.map((o) => o.id)).toEqual(['yes', 'no']);
		expect(card).toMatchObject({ expiresAt: 'benefits' });
		expect(card.expiryOptionId).toBeUndefined(); // unanswered = no augment
		decisions.ramAugment(ctxFor(player), 'yes');
		expect(player.unplacedAugments).toHaveLength(1);
		expect(player.unplacedAugments![0].classId).toBeUndefined(); // type chosen at placement
	});

	it('no → nothing', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 })] });
		decisions.ramAugment(ctxFor(player), 'no');
		expect(player.unplacedAugments ?? []).toHaveLength(0);
	});

	it('other locations, or a face-down Ram: no card', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 })] });
		expect(navigate(player, 'Water Region')).toHaveLength(0);
		const faceDown = makePlayer({ spirits: [spirit(1, { Ram: 1 }, { faceDown: true })] });
		expect(navigate(faceDown, 'Mountain Region')).toHaveLength(0);
	});

	it('"from a different location": staying at the Mountain Region gives no card', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 })] });
		expect(navigate(player, 'Mountain Region')).toHaveLength(1); // round 1: no previous location
		decisions.ramAugment(ctxFor(player), 'yes');
		player.pendingDecisions = [];
		player.previousDestination = 'Mountain Region';
		expect(navigate(player, 'Mountain Region')).toHaveLength(0); // stayed
		player.previousDestination = 'Arcane Abyss';
		expect(navigate(player, 'Mountain Region')).toHaveLength(1); // came from the Arcane Abyss
		decisions.ramAugment(ctxFor(player), 'yes');
		expect(player.unplacedAugments).toHaveLength(2);
	});

	it('Ram and Rider fire on the same arrival', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 }), spirit(2, { Rider: 1 })] });
		navigate(player, 'Mountain Region');
		expect(player.pendingDecisions.map((d) => d.kind).sort()).toEqual(['ramAugment', 'riderMountain']);
	});

	it('the old rule is gone: no combat damage from Cursed Spirit traits', () => {
		const { player } = fire({ Ram: 1 }, 'inCombat', {
			player: { spirits: [spirit(1, { Ram: 1 }), spirit(2, { 'Cursed Spirit': 3 })] }
		});
		expect(player.combatDamageBonus).toBe(0);
	});
});
