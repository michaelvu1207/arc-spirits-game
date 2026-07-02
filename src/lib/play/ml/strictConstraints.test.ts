import { describe, expect, it } from 'vitest';
import type { LegalAction } from './actions';
import { filterPlannerActions, statusCapTransitionAttribution } from './selfplay';
import type { PlayCatalog, PlaySpirit, PrivatePlayerState, PublicGameState } from '../types';

const catalog = {
	guardians: [],
	spirits: [],
	mats: [],
	classes: [],
	dice: [],
	locations: [],
	monsters: []
} as PlayCatalog;

function spirit(slotIndex: number, name: string, classes: Record<string, number>): PlaySpirit {
	return {
		slotIndex,
		id: `${name}-${slotIndex}`,
		name,
		cost: 1,
		classes,
		origins: {},
		isFaceDown: false
	};
}

function player(statusLevel: number, spirits: PlaySpirit[]): PrivatePlayerState {
	return {
		playerColor: 'Red',
		displayName: 'Red',
		selectedGuardian: 'Test Guardian',
		navigationDestination: 'Arcane Abyss',
		brokenBarrier: 0,
		victoryPoints: 9,
		vpHistory: [],
		barrier: 4,
		maxBarrier: 4,
		statusLevel,
		statusToken: null,
		spirits,
		mats: [],
		handDraws: [],
		pendingDraw: null,
		pendingReward: null,
		pendingAwakenReward: null,
		pendingDrawQueue: [],
		spawnedDice: [],
		spawnedItems: [],
		spiritAugmentAttachments: [],
		pendingDestination: null,
		attackDice: [],
		initiative: 0,
		usedLocationRows: [],
		awakenOffers: [],
		pendingDecisions: [],
		manualPrompts: []
	} as unknown as PrivatePlayerState;
}

function stateWith(statusLevel: number, spirits: PlaySpirit[]): PublicGameState {
	return {
		roomCode: 'TEST',
		revision: 1,
		status: 'active',
		gameId: null,
		scenario: null,
		round: 9,
		guardianPool: [],
		seats: {
			Red: { seatColor: 'Red', memberId: 'red', displayName: 'Red', selectedGuardian: 'Test Guardian' },
			Blue: { seatColor: 'Blue', memberId: null, displayName: null, selectedGuardian: null },
			Orange: { seatColor: 'Orange', memberId: null, displayName: null, selectedGuardian: null },
			Green: { seatColor: 'Green', memberId: null, displayName: null, selectedGuardian: null }
		},
		activeSeats: ['Red'],
		players: { Red: player(statusLevel, spirits) },
		market: [],
		bags: {
			hexSpirits: { count: 0, contents: [] },
			monsters: { count: 0, contents: [] },
			abyssFallen: { count: 0, contents: [] },
			stageDeck: { count: 0, contents: [] },
			purgeBags: [],
			history: {}
		},
		rng: { seed: 1, counter: 0 },
		phase: 'cleanup',
		navigation: {},
		revealedDestinations: true,
		navigationDurationMs: null,
		navigationDeadline: null,
		navigationFullDeadline: null,
		phaseDeadline: null,
		locationOccupancy: { 'Arcane Abyss': ['Red'] },
		monster: {
			id: 'hp4',
			name: 'HP4 Test Monster',
			hp: 4,
			maxHp: 4,
			damage: 4,
			rewardTrack: ['vp_2'],
			chooseAmount: 1,
			livesRemaining: 4,
			livesTotal: 4,
			ladderIndex: 2,
			ladderMax: 8
		},
		combats: [],
		winnerSeat: null
	} as unknown as PublicGameState;
}

function action(cmd: LegalAction['cmd'], next: PublicGameState): LegalAction {
	return { cmd, next };
}

describe('planner hard-constraint attribution', () => {
	it('attributes status-cap crossings to own, external, and deadline sources', () => {
		const own = statusCapTransitionAttribution(
			'Red',
			0,
			1,
			0,
			{ kind: 'command', actorSeat: 'Red', cmdType: 'startCombat' }
		);
		expect(own).toEqual({
			events: 1,
			ownEvents: 1,
			externalEvents: 0,
			deadlineEvents: 0,
			sources: { 'own:Red:startCombat': 1 }
		});

		const external = statusCapTransitionAttribution(
			'Blue',
			0,
			3,
			0,
			{ kind: 'command', actorSeat: 'Green', cmdType: 'initiatePvp' }
		);
		expect(external).toEqual({
			events: 3,
			ownEvents: 0,
			externalEvents: 3,
			deadlineEvents: 0,
			sources: { 'external:Green:initiatePvp': 3 }
		});

		const deadline = statusCapTransitionAttribution(
			'Orange',
			0,
			1,
			0,
			{ kind: 'deadline', cmdType: 'deadline' }
		);
		expect(deadline).toEqual({
			events: 1,
			ownEvents: 0,
			externalEvents: 0,
			deadlineEvents: 1,
			sources: { 'deadline:none:deadline': 1 }
		});
	});

	it('does not emit a new event while already above the cap without a status increase', () => {
		expect(statusCapTransitionAttribution(
			'Red',
			1,
			1,
			0,
			{ kind: 'command', actorSeat: 'Red', cmdType: 'passEncounter' }
		).events).toBe(0);
	});

	it('preserves route-critical Spirit Animal for non-Fallen status-2 Good builders', () => {
		const spiritAnimal = spirit(0, 'Route Animal', { 'Spirit Animal': 1 });
		const filler = spirit(1, 'Filler', {});
		const state = stateWith(2, [spiritAnimal, filler]);
		const discardAnimal = stateWith(2, [filler]);
		const unchanged = stateWith(2, [spiritAnimal, filler]);

		const filtered = filterPlannerActions(
			state,
			catalog,
			[
				action({ type: 'discardSpirit', slotIndex: 0 }, discardAnimal),
				action({ type: 'commitCleanup' }, unchanged)
			],
			'Red',
			undefined,
			2,
			false,
			false,
			true,
			0.5,
			false,
			false
		);

		expect(filtered.map((candidate) => candidate.cmd.type)).toEqual(['commitCleanup']);
	});

	it('does not apply the Good-route preservation guard to Fallen players', () => {
		const spiritAnimal = spirit(0, 'Route Animal', { 'Spirit Animal': 1 });
		const filler = spirit(1, 'Filler', {});
		const state = stateWith(3, [spiritAnimal, filler]);
		const discardAnimal = stateWith(3, [filler]);
		const unchanged = stateWith(3, [spiritAnimal, filler]);

		const filtered = filterPlannerActions(
			state,
			catalog,
			[
				action({ type: 'discardSpirit', slotIndex: 0 }, discardAnimal),
				action({ type: 'commitCleanup' }, unchanged)
			],
			'Red',
			undefined,
			undefined,
			false,
			false,
			true,
			0.5,
			false,
			false
		);

		expect(filtered.map((candidate) => candidate.cmd.type)).toEqual(['discardSpirit', 'commitCleanup']);
	});
});
