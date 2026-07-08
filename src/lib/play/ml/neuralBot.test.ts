import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState } from '../types';
import { computeKillProbability } from '../server/botPolicy';
import { legalActionsWithNext } from './actions';
import { rewardPickTarget } from './auxTargets';
import { ACT_DIM, COMMAND_VOCAB, OBS_DIM, encodeAction, encodeObs } from './encode';
import { claimableMonsterRewardVp, evaluateFarmValue } from './farmValue';
import { hybridIndex, lookaheadIndex, policyIndexWithProgressGuard, scoreByValue, valueGuidedIndex } from './neuralBot';
import { neuralPlanNavigation } from './planner';
import type { NeuralPolicy } from './net';

const VP1 = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const TEAPOT = 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6';
const ANY_RUNE = '36aab6c9-b98c-4e84-b097-e743f45dde82';

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'arcane_attack', name: 'Arcane Attack', diceType: 'attack', sides: [1, 2, 2, 2, 2, 3] }],
	spirits: [],
	monsters: [
		{
			id: 'm-1',
			name: 'Abyss Maw',
			damage: 1,
			barrier: 1,
			rewardTrack: [VP1, VP3, ABYSS_SUMMON, TEAPOT],
			dicePool: [],
			chooseAmount: 2,
			stage: 1,
			order: 0
		}
	],
	locations: []
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };

const neutralPolicy = {
	value: () => 0,
	scoreCandidates: (_obs: number[], cands: number[][]) => cands.map(() => 0),
	probs: (_obs: number[], cands: number[][]) => cands.map(() => 1 / Math.max(1, cands.length)),
	pick: () => 0
} as unknown as NeuralPolicy;

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

function atAbyss(): PublicGameState {
	let state = createLobbyState({ roomCode: 'NBOT', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	state = apply(state, RED, { type: 'startGame', seed: 7 });
	state = apply(state, RED, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	state = apply(state, RED, { type: 'forceAdvancePhase' });
	state.players.Red!.attackDice = [{ instanceId: 'd-arcane', tier: 'arcane' }];
	return state;
}

function atQuietLocation(): PublicGameState {
	let state = createLobbyState({ roomCode: 'NLOC', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	state = apply(state, RED, { type: 'startGame', seed: 9 });
	state = apply(state, RED, { type: 'lockNavigation', destination: 'Floral Patch' });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Floral Patch' });
	return apply(state, RED, { type: 'forceAdvancePhase' });
}

describe('neural value action scoring', () => {
	it('exposes every small monster reward pick combination to the ML candidate surface', () => {
		let state = atAbyss();
		state = apply(state, RED, { type: 'startCombat' });
		expect(state.players.Red!.pendingReward).not.toBeNull();

		const actions = legalActionsWithNext(state, 'Red', CATALOG)
			.filter((a) => a.cmd.type === 'resolveMonsterReward')
			.map((a) => a.cmd as Extract<GameCommand, { type: 'resolveMonsterReward' }>);
		const pickSets = new Set(actions.map((cmd) => [...cmd.picks].sort((a, b) => a - b).join(',')));
		expect(pickSets).toEqual(new Set(['0', '1', '2', '3', '0,1', '0,2', '0,3', '1,2', '1,3', '2,3']));
		for (const cmd of actions) {
			const result = applyGameCommand(state, RED, cmd, CATALOG);
			expect(result.ok, JSON.stringify(cmd)).toBe(true);
		}
	});

	it('builds a reward-pick auxiliary target from immediate VP choices', () => {
		let state = atAbyss();
		state = apply(state, RED, { type: 'startCombat' });
		const actions = legalActionsWithNext(state, 'Red', CATALOG).filter(
			(a) => a.cmd.type === 'resolveMonsterReward'
		);
		const target = rewardPickTarget(state, 'Red', actions);
		expect(target).toBeDefined();
		expect(target).toHaveLength(actions.length);
		expect(target!.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1);

		const byPick = new Map(
			actions.map((a, i) => [
				(a.cmd as Extract<GameCommand, { type: 'resolveMonsterReward' }>).picks
					.slice()
					.sort((a, b) => a - b)
					.join(','),
				target![i]
			])
		);
		expect(byPick.get('0,1')).toBeCloseTo(4 / 16);
		expect(byPick.get('1')).toBeCloseTo(3 / 16);
		expect(byPick.get('0')).toBeCloseTo(1 / 16);
		expect(byPick.get('2,3')).toBe(0);
	});

	it('exposes monster reward wildcard rune choices as distinct legal ML candidates', () => {
		const state = atAbyss();
		state.players.Red!.pendingReward = {
			monsterId: 'm-choice',
			monsterName: 'Choice Maw',
			rewardTrack: [ANY_RUNE, VP3],
			chooseAmount: 1
		};

		const actions = legalActionsWithNext(state, 'Red', CATALOG)
			.filter((a) => a.cmd.type === 'resolveMonsterReward')
			.map((a) => a.cmd as Extract<GameCommand, { type: 'resolveMonsterReward' }>);
		const runeChoices = actions
			.filter((cmd) => cmd.picks.length === 1 && cmd.picks[0] === 0)
			.map((cmd) => cmd.choices?.[0] ?? 0)
			.sort((a, b) => a - b);
		expect(runeChoices).toEqual([0, 1, 2, 3]);
		expect(actions.some((cmd) => cmd.picks.length === 1 && cmd.picks[0] === 1)).toBe(true);

		const encodedA = encodeAction(state, 'Red', { type: 'resolveMonsterReward', picks: [0], choices: [0] });
		const encodedB = encodeAction(state, 'Red', { type: 'resolveMonsterReward', picks: [0], choices: [1] });
		expect(encodedA).toHaveLength(ACT_DIM);
		expect(encodedB).toHaveLength(ACT_DIM);
		expect(encodedA).not.toEqual(encodedB);
	});

	it('encodes market spirit class identity when the catalog is supplied', () => {
		const state = atQuietLocation();
		const catalog: PlayCatalog = {
			...CATALOG,
			spirits: [
				{
					id: 'spirit-animal-1',
					name: 'Route Cub',
					cost: 2,
					classes: { 'Spirit Animal': 1 },
					origins: {}
				},
				{
					id: 'cultivator-1',
					name: 'Route Cultivator',
					cost: 3,
					classes: { Cultivator: 1 },
					origins: {}
				}
			]
		};
		state.market = [
			{ index: 0, spiritId: 'spirit-animal-1' },
			{ index: 1, spiritId: 'cultivator-1' }
		];

		const p = COMMAND_VOCAB.length;
		const blind = encodeAction(state, 'Red', { type: 'takeSpirit', marketIndex: 0 });
		const animal = encodeAction(state, 'Red', { type: 'takeSpirit', marketIndex: 0 }, undefined, catalog);
		const cultivator = encodeAction(state, 'Red', { type: 'takeSpirit', marketIndex: 1 }, undefined, catalog);

		expect(blind[p + 3]).toBe(0);
		expect(animal[p + 2]).toBeCloseTo(2 / 8);
		expect(animal[p + 3]).toBeGreaterThan(0);
		expect(animal[p + 9]).toBe(0);
		expect(cultivator[p + 3]).toBe(0);
		expect(cultivator[p + 9]).toBeGreaterThan(0);
		expect(animal).toHaveLength(ACT_DIM);
		expect(cultivator).toHaveLength(ACT_DIM);
	});

	it('encodes current damage-class composition in the observation', () => {
		const state = atQuietLocation();
		state.players.Red!.spirits = [
			{
				slotIndex: 0,
				id: 'animal-a',
				name: 'Animal A',
				cost: 1,
				classes: { 'Spirit Animal': 1 },
				origins: {},
				isFaceDown: false
			},
			{
				slotIndex: 1,
				id: 'animal-b',
				name: 'Animal B',
				cost: 1,
				classes: { 'Spirit Animal': 1, Elementalist: 1 },
				origins: {},
				isFaceDown: false
			},
			{
				slotIndex: 2,
				id: 'arc-fighter',
				name: 'Arc Fighter',
				cost: 2,
				classes: { 'Arc Mage': 1, Fighter: 1 },
				origins: {},
				isFaceDown: false
			}
		];

		const obs = encodeObs(state, 'Red', CATALOG);
		expect(obs).toHaveLength(OBS_DIM);
		// Class-composition block sits ahead of the 15 v1.1 ladder features + 6 v1.2 own-location features.
		expect(obs.slice(-28, -21)).toEqual([2 / 7, 1 / 3, 1 / 3, 1 / 3, 0, 0, 0]);
	});

	it('encodes the v1.1 ladder forward-value block (obs 62→77)', () => {
		const state = atAbyss();
		const obs = encodeObs(state, 'Red', CATALOG);
		expect(obs).toHaveLength(OBS_DIM);
		// The ladder block now sits ahead of the 6 v1.2 own-location features appended after it.
		const block = obs.slice(-21, -6);
		const mon = state.monster!;
		// killProb feature must MATCH the bot helper (no train/serve skew).
		expect(block[0]).toBeCloseTo(
			Math.min(1, Math.max(0, computeKillProbability(state, 'Red', CATALOG)))
		);
		// Current-rung claimable VP.
		expect(block[4]).toBeCloseTo(
			Math.min(1, claimableMonsterRewardVp(mon.rewardTrack, mon.chooseAmount) / 10)
		);
		// Corruption margin: (barrier − monster damage + 8) / 16.
		const me = state.players.Red!;
		expect(block[3]).toBeCloseTo(Math.min(1, Math.max(0, (me.barrier - mon.damage + 8) / 16)));
		// Combat allowance: 1 base swing, none used yet → 1/2.
		expect(block[14]).toBeCloseTo(1 / 2);
	});

	it('encodes the v1.2 own-location block (destination one-hot + at-Abyss flag)', () => {
		// At the Arcane Abyss (ALL_DESTINATIONS index 4): one-hot slot 4 set + at-Abyss flag.
		const abyss = encodeObs(atAbyss(), 'Red', CATALOG);
		expect(abyss).toHaveLength(OBS_DIM);
		expect(abyss.slice(-6)).toEqual([0, 0, 0, 0, 1, 1]);
		// At a Spirit World location (Floral Patch, index 0): one-hot slot 0, at-Abyss flag clear.
		const floral = encodeObs(atQuietLocation(), 'Red', CATALOG);
		expect(floral.slice(-6)).toEqual([1, 0, 0, 0, 0, 0]);
	});

	it('credits a monster kill for the VP pending in its reward claim', () => {
		const state = atAbyss();
		const actions = legalActionsWithNext(state, 'Red', CATALOG);
		const startCombat = actions.findIndex((a) => a.cmd.type === 'startCombat');
		const endLocation = actions.findIndex((a) => a.cmd.type === 'endLocationActions');

		expect(startCombat).toBeGreaterThanOrEqual(0);
		expect(endLocation).toBeGreaterThanOrEqual(0);
		expect(actions[startCombat].next.players.Red!.victoryPoints).toBe(0);
		expect(actions[startCombat].next.players.Red!.pendingReward).not.toBeNull();

		const scores = scoreByValue(neutralPolicy, state, 'Red', actions, CATALOG);
		expect(scores[startCombat]).toBeGreaterThan(scores[endLocation]);

		const encoded = encodeAction(state, 'Red', actions[startCombat].cmd, actions[startCombat].next);
		expect(encoded).toHaveLength(ACT_DIM);
		expect(encoded.slice(-5)[0]).toBeGreaterThan(0);
		expect(encoded.slice(-5)[1]).toBe(1);
	});

	it('scores low-rung multi-life farm value and can boost Abyss navigation priors', () => {
		let state = createLobbyState({ roomCode: 'FARMV', guardianNames: ['Red Guard', 'Blue Guard'] });
		state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
		state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
		state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
		state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
		state = apply(state, RED, { type: 'startGame', seed: 11 });
		state.players.Red!.attackDice = [{ instanceId: 'd-arcane', tier: 'arcane' }];
		// Force a multi-life monster (2 players now spawn a single-life one) — this test
		// exercises farm-value scoring across remaining lives, not the spawn rule.
		state.monster!.livesRemaining = 2;
		state.monster!.livesTotal = 2;

		expect(claimableMonsterRewardVp(CATALOG.monsters![0].rewardTrack, 2)).toBe(4);
		const farm = evaluateFarmValue(state, 'Red', CATALOG, { threshold: 0.5 });
		expect(farm.farmable).toBe(true);
		expect(farm.rewardVp).toBe(4);
		expect(farm.livesRemaining).toBe(2);
		expect(farm.opportunityVp).toBeCloseTo(4);
		expect(farm.score).toBeGreaterThan(0);

		const plan = neuralPlanNavigation(state, 'Red', CATALOG, neutralPolicy, {
			iterations: 1,
			farmValueBonus: 20
		});
		expect(plan).not.toBeNull();
		const abyssIndex = plan!.destinations.indexOf('Arcane Abyss');
		expect(abyssIndex).toBeGreaterThanOrEqual(0);
		expect(plan!.priors[abyssIndex]).toBeGreaterThan(Math.max(...plan!.priors.filter((_, i) => i !== abyssIndex)));
	});

	it('can boost Abyss navigation priors from the learned farm-value head', () => {
		const state = createLobbyState({ roomCode: 'FARMH', guardianNames: ['Red Guard', 'Blue Guard'] });
		let s = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
		s = apply(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
		s = apply(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
		s = apply(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
		s = apply(s, RED, { type: 'startGame', seed: 12 });

		const headFarmPolicy = {
			...neutralPolicy,
			farmValue: () => 1
		} as unknown as NeuralPolicy;
		const plan = neuralPlanNavigation(s, 'Red', CATALOG, headFarmPolicy, {
			iterations: 1,
			farmValueBonus: 20,
			farmValueSource: 'head',
			farmValueThreshold: 0.5,
			farmValueMinMonsterHp: 0,
			farmValueMaxMonsterHp: 99,
			farmValueMaxStatusLevel: 2
		});
		expect(plan).not.toBeNull();
		const abyssIndex = plan!.destinations.indexOf('Arcane Abyss');
		expect(abyssIndex).toBeGreaterThanOrEqual(0);
		expect(plan!.priors[abyssIndex]).toBeGreaterThan(Math.max(...plan!.priors.filter((_, i) => i !== abyssIndex)));
	});

	it('offers no market commands (rules v1.1) and treats ending location actions as progress', () => {
		const state = atQuietLocation();
		const actions = legalActionsWithNext(state, 'Red', CATALOG);
		// Rules v1.1: the market family is not a player action, so the free
		// refillMarket/takeSpirit churn that used to dominate quiet locations must
		// never reach the candidate surface.
		expect(actions.some((a) => a.cmd.type === 'refillMarket')).toBe(false);
		expect(actions.some((a) => a.cmd.type === 'takeSpirit')).toBe(false);
		expect(actions.some((a) => a.cmd.type === 'replaceSpirit')).toBe(false);

		const endLocation = actions.findIndex((a) => a.cmd.type === 'endLocationActions');
		expect(endLocation).toBeGreaterThanOrEqual(0);
		expect(actions[endLocation].next.players.Red!.phaseReady).toBe(true);

		const endFeatures = encodeAction(state, 'Red', actions[endLocation].cmd, actions[endLocation].next);
		expect(endFeatures).toHaveLength(ACT_DIM);
		expect(endFeatures.slice(-5)[2]).toBe(1);
		expect(actions[valueGuidedIndex(neutralPolicy, state, 'Red', actions, undefined, CATALOG)].cmd.type).toBe(
			'endLocationActions'
		);
		expect(actions[lookaheadIndex(neutralPolicy, state, 'Red', actions, CATALOG)].cmd.type).toBe(
			'endLocationActions'
		);

		const policyThatWouldPickFirst = {
			value: neutralPolicy.value,
			scoreCandidates: neutralPolicy.scoreCandidates,
			probs: neutralPolicy.probs,
			pick: () => 0
		} as unknown as NeuralPolicy;
		const idx = hybridIndex(policyThatWouldPickFirst, state, 'Red', actions, undefined, CATALOG);
		expect(actions[idx].cmd.type).toBe('endLocationActions');
		expect(actions[policyIndexWithProgressGuard(policyThatWouldPickFirst, state, 'Red', actions, undefined, CATALOG)].cmd.type).toBe(
			'endLocationActions'
		);
	});
});
