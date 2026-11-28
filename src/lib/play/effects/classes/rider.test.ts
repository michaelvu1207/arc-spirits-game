import { describe, expect, it } from 'vitest';
import { ctxFor, fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { decisions, riderDefaultOption } from './rider';
import { setCorruptionDiscardObligation } from '../../types';
import type { PrivatePlayerState } from '../../types';

/** Rider — "When you navigate to the Mountain Region from a different location, choose one:
 *  restore 3 Barrier, gain 3 Max Barrier, gain 3 Basic Attack Dice, or gain 1 Spirit Augment of
 *  your choice." */
function navigate(player: PrivatePlayerState, destination: string) {
	player.navigationDestination = destination as PrivatePlayerState['navigationDestination'];
	applyTrigger(makeState(player), 'Red', 'onNavigate', []);
	return player.pendingDecisions.filter((d) => d.kind === 'riderMountain');
}

function choose(player: PrivatePlayerState, optionId: string) {
	decisions.riderMountain(ctxFor(player), optionId);
}

describe('Rider', () => {
	it('Mountain Region: one card with the four options, ending at Benefits', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 })] });
		const cards = navigate(player, 'Mountain Region');
		expect(cards).toHaveLength(1);
		expect(cards[0].options.map((o) => o.id)).toEqual(['restore', 'maxBarrier', 'dice', 'augment']);
		expect(cards[0]).toMatchObject({ expiresAt: 'benefits', expiryOptionId: 'auto' });
	});

	it('gain 1 Spirit Augment of your choice (the type is chosen at placement)', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 })] });
		choose(player, 'augment');
		expect(player.unplacedAugments).toHaveLength(1);
	});

	it('restore 3 Barrier', () => {
		const player = makePlayer({ barrier: 2, maxBarrier: 8, spirits: [spirit(1, { Rider: 1 })] });
		choose(player, 'restore');
		expect([player.barrier, player.maxBarrier]).toEqual([5, 8]);
	});

	it('gain 3 Max Barrier (the new points arrive intact)', () => {
		const player = makePlayer({ barrier: 2, maxBarrier: 8, spirits: [spirit(1, { Rider: 1 })] });
		choose(player, 'maxBarrier');
		expect([player.barrier, player.maxBarrier]).toEqual([4, 10]); // max capped at 10
	});

	it('gain 3 Basic Attack Dice, within the cap of 10', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 })] });
		choose(player, 'dice');
		expect(player.attackDice.map((d) => d.tier)).toEqual(['basic', 'basic', 'basic']);
		const nearCap = makePlayer({
			spirits: [spirit(1, { Rider: 1 })],
			attackDice: Array.from({ length: 9 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }))
		});
		choose(nearCap, 'dice');
		expect(nearCap.attackDice).toHaveLength(10);
	});

	it('the dice go through the normal gain path (Wildling adds 1 Exalted)', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 }), spirit(2, { Wildling: 1 })] });
		choose(player, 'dice');
		expect(player.attackDice.map((d) => d.tier)).toEqual(['basic', 'basic', 'basic', 'exalted']);
	});

	it('other locations: no card', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 })] });
		expect(navigate(player, 'Forest Region')).toHaveLength(0);
		expect(navigate(player, 'Arcane Abyss')).toHaveLength(0);
	});

	it('face-down Rider: no card', () => {
		const player = makePlayer({ spirits: [spirit(1, { Rider: 1 }, { faceDown: true })] });
		expect(navigate(player, 'Mountain Region')).toHaveLength(0);
	});

	it('"from a different location": staying at the Mountain Region gives no card', () => {
		const player = makePlayer({ barrier: 1, maxBarrier: 4, spirits: [spirit(1, { Rider: 1 })] });
		expect(navigate(player, 'Mountain Region')).toHaveLength(1); // round 1: no previous location
		choose(player, 'restore');
		player.pendingDecisions = [];
		player.previousDestination = 'Mountain Region';
		expect(navigate(player, 'Mountain Region')).toHaveLength(0); // stayed
		player.previousDestination = 'Forest Region';
		expect(navigate(player, 'Mountain Region')).toHaveLength(1); // came from the Forest Region
		choose(player, 'restore');
		expect(player.barrier).toBe(4);
	});

	it('unanswered (bots): the engine picks Max Barrier, else restore, else dice', () => {
		expect(riderDefaultOption(makePlayer({ barrier: 4, maxBarrier: 6 }))).toBe('maxBarrier');
		expect(riderDefaultOption(makePlayer({ barrier: 3, maxBarrier: 9 }))).toBe('restore');
		expect(riderDefaultOption(makePlayer({ barrier: 10, maxBarrier: 10 }))).toBe('dice');
		const player = makePlayer({ barrier: 4, maxBarrier: 6, spirits: [spirit(1, { Rider: 1 })] });
		choose(player, 'auto');
		expect([player.barrier, player.maxBarrier]).toEqual([7, 9]);
	});

	it('the old rule is gone: a Rider does not lower the corruption sacrifice', () => {
		const { player } = fire({ Rider: 1 }, 'onNavigate', {
			player: { corruptionCount: 1, spirits: [spirit(1, { Rider: 1 }), spirit(2, {})] }
		});
		setCorruptionDiscardObligation(player);
		expect(player.pendingCorruptionDiscard?.count).toBe(1);
	});
});
