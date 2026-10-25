import { describe, expect, it } from 'vitest';
import { getPowerAutoCommand, navigationPowerAutoCommands } from './navigationPowerProgress';
import { makePlayer, makeState } from './effects/classes/testHelpers';
import type { PublicGameState } from './types';

function fixture() {
	const player = makePlayer();
	const state = makeState(player);
	state.status = 'active';
	state.phase = 'navigation';
	return { player, state };
}
describe('automatic power resolution', () => {
	it('does nothing without outstanding work and never spends currency', () => {
		const { state, player } = fixture();
		player.powerInventory = ['battle-fury'];
		player.mats = [{ slotIndex: 1, hasRune: true, type: 'rune' }];
		expect(getPowerAutoCommand(state, 'Red')).toBeNull();
		expect(navigationPowerAutoCommands(state, 'Red')).toEqual([]);
	});
	it('declines optional benefits before drafting a new power', () => {
		const { state, player } = fixture();
		player.pendingPowerDrafts = [['battle-fury', 'ember-charge', 'stone-shelter']];
		player.navigationPowerOffers = [
			{
				id: 'offer',
				powerId: 'ember-charge',
				kind: 'restore',
				prompt: 'Restore 4 Barrier',
				options: [
					{ id: 'accept', label: 'Restore' },
					{ id: 'decline', label: 'Decline' }
				]
			}
		];
		expect(getPowerAutoCommand(state, 'Red')).toEqual({
			type: 'resolveNavigationPower',
			offerId: 'offer',
			optionId: 'decline'
		});
	});
	it('answers owner-mandatory offers, even after readying', () => {
		const { state, player } = fixture();
		player.phaseReady = true;
		player.navigationPowerOffers = [
			{
				id: 'optional',
				powerId: 'ember-charge',
				kind: 'restore',
				prompt: 'Restore',
				options: [{ id: 'decline', label: 'Decline' }]
			},
			{
				id: 'theft',
				powerId: 'stone-shelter',
				kind: 'give-rune',
				prompt: 'Choose a Rune',
				mandatory: true,
				options: [
					{ id: '3', label: 'Forest' },
					{ id: '1', label: 'Water' }
				]
			}
		];
		expect(getPowerAutoCommand(state, 'Red')).toEqual({
			type: 'resolveNavigationPower',
			offerId: 'theft',
			optionId: '3'
		});
	});
	it('does not invent a selection for an empty mandatory offer', () => {
		const { state, player } = fixture();
		player.navigationPowerOffers = [
			{
				id: 'empty',
				powerId: 'stone-shelter',
				kind: 'give-rune',
				prompt: 'Choose',
				mandatory: true,
				options: []
			}
		];
		expect(getPowerAutoCommand(state, 'Red')).toBeNull();
	});
	it('declines recipient trade proposals and leaves proposing seats alone', () => {
		const { state, player } = fixture();
		player.pendingNavigationTrade = {
			id: 'trade',
			fromSeat: 'Blue',
			toSeat: 'Red',
			giveRuneSlots: [],
			receiveRuneSlots: [],
			giveSpiritSlots: [],
			receiveSpiritSlots: []
		};
		player.phaseReady = true;
		expect(getPowerAutoCommand(state, 'Red')).toEqual({
			type: 'respondNavigationPowerTrade',
			tradeId: 'trade',
			accept: false
		});
		player.pendingNavigationTrade = {
			...player.pendingNavigationTrade,
			fromSeat: 'Red',
			toSeat: 'Blue'
		};
		expect(getPowerAutoCommand(state, 'Red')).toBeNull();
	});
	it('chooses only the first currently offered draft card with a single finite command', () => {
		const { state, player } = fixture();
		player.pendingPowerDrafts = [['battle-fury', 'thorn-ward', 'ember-charge'], ['stone-shelter']];
		expect(navigationPowerAutoCommands(state, 'Red')).toEqual([
			{ type: 'chooseNavigationPower', powerId: 'battle-fury' }
		]);
		expect(player.pendingPowerDrafts).toHaveLength(2);
	});
	it('does not draft for an already-ready player', () => {
		const { state, player } = fixture();
		player.phaseReady = true;
		player.pendingPowerDrafts = [['battle-fury']];
		expect(getPowerAutoCommand(state, 'Red')).toBeNull();
	});
	it('ignores inactive games and absent seats', () => {
		const { state, player } = fixture();
		player.pendingPowerDrafts = [['battle-fury']];
		expect(getPowerAutoCommand(state, 'Blue')).toBeNull();
		state.status = 'finished';
		expect(getPowerAutoCommand(state, 'Red')).toBeNull();
	});
	it('does not read hidden RNG or opposing player state and survives serialization', () => {
		const { state, player } = fixture();
		player.pendingPowerDrafts = [['thorn-ward', 'ember-charge']];
		const cloned = JSON.parse(JSON.stringify(state)) as PublicGameState;
		const expected = getPowerAutoCommand(cloned, 'Red');
		Object.defineProperty(state, 'rng', {
			get: () => {
				throw Error('RNG is hidden');
			}
		});
		Object.defineProperty(state.players, 'Blue', {
			get: () => {
				throw Error('Opponent state is hidden');
			}
		});
		expect(getPowerAutoCommand(state, 'Red')).toEqual(expected);
	});
});
