import { describe, expect, it } from 'vitest';
import type { PlayCatalog, PublicGameState, SeatColor } from './types';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import {
	navigationPowerPlayer,
	resolveNavigationPowerReveal,
	resolveNavigationPowerChoice,
	beforeNavigationPowerCombat,
	afterNavigationPowerCombat,
	grantRandomNavigationPowers
} from './navigationPowerEffects';
import type { NavigationPowerId } from './navigationPowers';
import { SPIRIT_AUGMENT_CLASSES } from './augments';

const catalog: PlayCatalog = {
	guardians: [],
	spirits: [],
	mats: [],
	dice: [],
	classes: SPIRIT_AUGMENT_CLASSES.map((name, i) => ({
		id: `class-${i}`,
		name,
		classType: 'normal',
		isSpecial: false,
		effectSchema: []
	}))
};
function setup(id: NavigationPowerId, destination = 'Cyber City') {
	const p = makePlayer({
		navigationPower: id,
		navigationDestination: destination,
		barrier: 1,
		maxBarrier: 8,
		brokenBarrier: 7
	});
	const b = makePlayer({ playerColor: 'Blue', navigationDestination: destination, statusLevel: 3 });
	const state = makeState(p, { Blue: b });
	state.round = 2;
	return { state, p: navigationPowerPlayer(p), b: navigationPowerPlayer(b) };
}
function choose(state: PublicGameState, seat: SeatColor, optionId: string) {
	const offer = navigationPowerPlayer(state.players[seat]!).navigationPowerOffers?.[0];
	if (!offer) throw Error('missing offer');
	return resolveNavigationPowerChoice(state, seat, { offerId: offer.id, optionId }, catalog);
}

describe('Navigation Power offers', () => {
	it('optional restoration can be declined without changing barriers', () => {
		const { state, p } = setup('ember-charge');
		resolveNavigationPowerReveal(state, catalog);
		expect(p.barrier).toBe(1);
		expect(choose(state, 'Red', 'decline').ok).toBe(true);
		expect(p.barrier).toBe(1);
		expect(p.navigationPowerOffers).toEqual([]);
	});
	it('does not offer a co-location effect when alone or double-offer on reveal retry', () => {
		const { state, p, b } = setup('ember-charge');
		b.navigationDestination = 'Tidal Cove';
		resolveNavigationPowerReveal(state, catalog);
		expect(p.navigationPowerOffers).toBeUndefined();
		const c = setup('ember-charge');
		resolveNavigationPowerReveal(c.state, catalog);
		resolveNavigationPowerReveal(c.state, catalog);
		expect(c.p.navigationPowerOffers).toHaveLength(1);
	});
	it('stale/forged choices do not consume the offer or mutate state', () => {
		const { state, p } = setup('ember-charge');
		resolveNavigationPowerReveal(state, catalog);
		const prior = JSON.stringify(state);
		expect(choose(state, 'Red', 'steal-all').ok).toBe(false);
		expect(JSON.stringify(state)).toBe(prior);
		expect(p.navigationPowerOffers).toHaveLength(1);
	});
	it('gains all three individually selected augments without reusing an offer id', () => {
		const { state, p } = setup('forest-bounty', 'Floral Patch');
		resolveNavigationPowerReveal(state, catalog);
		const ids: string[] = [];
		for (const name of ['Fighter', 'Elementalist', 'Soul Weaver']) {
			ids.push(p.navigationPowerOffers![0].id);
			expect(choose(state, 'Red', name).ok).toBe(true);
		}
		expect(new Set(ids).size).toBe(3);
		expect(p.unplacedAugments).toHaveLength(3);
		expect(p.navigationPowerOffers).toEqual([]);
	});
	it('lets the owner choose which rune is stolen and forbids declining that choice', () => {
		const { state, p, b } = setup('stone-shelter');
		b.mats = [
			{ slotIndex: 1, hasRune: true, type: 'rune', name: 'Forest', originId: 'forest' },
			{ slotIndex: 2, hasRune: true, type: 'rune', name: 'Water', originId: 'water' }
		];
		resolveNavigationPowerReveal(state, catalog);
		expect(choose(state, 'Red', 'accept').ok).toBe(true);
		expect(b.navigationPowerOffers![0].mandatory).toBe(true);
		expect(choose(state, 'Blue', 'decline').ok).toBe(false);
		expect(choose(state, 'Blue', '2').ok).toBe(true);
		expect(p.mats[0].name).toBe('Water');
		expect(b.mats[0].hasRune).toBe(true);
	});
	it('rejects stealing a different augment after another thief removes the chosen one', () => {
		const { state, p, b } = setup('augment-relay');
		b.spiritAugmentAttachments = [
			{ runeId: 'rune-a', classId: 'a', className: 'Fighter', spiritId: 's1', spiritSlotIndex: 1 },
			{
				runeId: 'rune-b',
				classId: 'b',
				className: 'Elementalist',
				spiritId: 's2',
				spiritSlotIndex: 2
			}
		];
		resolveNavigationPowerReveal(state, catalog);
		const option = p.navigationPowerOffers![0].options[0].id;
		b.spiritAugmentAttachments.shift();
		expect(choose(state, 'Red', option).ok).toBe(false);
		expect(b.spiritAugmentAttachments).toHaveLength(1);
		expect(p.unplacedAugments ?? []).toHaveLength(0);
	});
	it('concurrent rune theft removes exhausted obligations instead of deadlocking', () => {
		const { state, p, b } = setup('stone-shelter');
		const green = makePlayer({
			playerColor: 'Green',
			navigationPower: 'stone-shelter',
			navigationDestination: 'Cyber City'
		});
		state.players.Green = green;
		state.activeSeats.push('Green');
		b.mats = [{ slotIndex: 1, hasRune: true, type: 'rune', name: 'Forest', originId: 'forest' }];
		resolveNavigationPowerReveal(state, catalog);
		expect(choose(state, 'Red', 'accept').ok).toBe(true);
		expect(choose(state, 'Green', 'accept').ok).toBe(true);
		expect(b.navigationPowerOffers).toHaveLength(2);
		expect(choose(state, 'Blue', '1').ok).toBe(true);
		expect(b.navigationPowerOffers).toEqual([]);
		expect(p.mats.filter((m) => m.hasRune)).toHaveLength(1);
	});
	it('Arcane Spirit count excludes expensive spirits of other origins', () => {
		const { state, p } = setup('abyssal-reckoning');
		p.spirits = [
			spirit(1, {}, { origins: { 'Arcane Spirits': 1 } }),
			spirit(2, {}, { origins: { Forest: 1 } })
		];
		p.spirits[1].cost = 9;
		resolveNavigationPowerReveal(state, catalog);
		expect(p.navigationPowerOffers![0].data?.amount).toBe(1);
	});
	it('battle-fury dice apply beyond the normal pool cap and never persist after combat', () => {
		const { state, p } = setup('battle-fury');
		p.attackDice = Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' }));
		resolveNavigationPowerReveal(state, catalog);
		choose(state, 'Red', 'accept');
		for (let fight = 0; fight < 2; fight++) {
			beforeNavigationPowerCombat(state, 'Red');
			expect(p.attackDice).toHaveLength(12);
			afterNavigationPowerCombat(state, 'Red', true);
			expect(p.attackDice).toHaveLength(10);
		}
	});
	it('failure payout can be declined and only triggers once', () => {
		const { state, p } = setup('unbroken-assault');
		resolveNavigationPowerReveal(state, catalog);
		choose(state, 'Red', 'accept');
		beforeNavigationPowerCombat(state, 'Red');
		afterNavigationPowerCombat(state, 'Red', false);
		expect(p.navigationPowerOffers![0].kind).toBe('failed-potential');
		choose(state, 'Red', 'decline');
		afterNavigationPowerCombat(state, 'Red', false);
		expect(p.navigationPowerOffers).toEqual([]);
		expect(p.maxBarrier).toBe(8);
	});
	it('random powers reproduce after JSON reload', () => {
		const { state, p } = setup('tidal-arsenal', 'Tidal Cove');
		const reloaded = JSON.parse(JSON.stringify(state));
		grantRandomNavigationPowers(state, 'Red', 3);
		grantRandomNavigationPowers(reloaded, 'Red', 3);
		expect(p.powerInventory).toHaveLength(3);
		expect(p.powerInventory).toEqual(reloaded.players.Red.powerInventory);
	});
});
