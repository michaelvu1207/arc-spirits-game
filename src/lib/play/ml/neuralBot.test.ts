import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import {
	SEAT_COLORS,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState
} from '../types';
import { computeKillProbability } from '../server/botPolicy';
import {
	enumerateCandidates,
	legalActions,
	legalActionsWithNext,
	type LegalAction
} from './actions';
import { rewardPickTarget } from './auxTargets';
import {
	ACT_DIM,
	ACTION_EFFECT_OFFSET,
	ACTION_EFFECT_SLOTS,
	COMMAND_VOCAB,
	MONSTER_REWARD_SEMANTIC_OFFSET,
	MONSTER_REWARD_SEMANTIC_SLOTS,
	OBS_DIM,
	encodeAction,
	encodeObs
} from './encode';
import { claimableMonsterRewardVp, evaluateFarmValue } from './farmValue';
import {
	hybridIndex,
	lookaheadIndex,
	policyIndexWithProgressGuard,
	scoreByValue,
	valueGuidedIndex
} from './neuralBot';
import { neuralPlanNavigation } from './planner';
import type { NeuralPolicy } from './net';

const VP1 = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const TEAPOT = 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6';
const ANY_RUNE = '36aab6c9-b98c-4e84-b097-e743f45dde82';
const ANY_RELIC = '6a85e06a-52cc-483c-aa59-38395a377307';
const SPIRIT_WORLD_SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const CULTIVATE = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const REST = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const BARRIER = '6746f875-a1bc-453c-94b5-718d6ebeb025';
const FOREST_RUNE = '8dd2b283-122b-4965-9184-f1f84e1216f4';
const ANIMAL_AUGMENT = '40934631-35fc-4936-943a-c607a9c607be';

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [
		{ id: 'arcane_attack', name: 'Arcane Attack', diceType: 'attack', sides: [1, 2, 2, 2, 2, 3] }
	],
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
const BLUE: GameActor = {
	memberId: 'm-blue',
	displayName: 'Blue',
	role: 'player',
	seatColor: 'Blue'
};

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
	it('distinguishes exact same-cost hand spirit identities inside one strategic route', () => {
		const state = atQuietLocation();
		const catalog: PlayCatalog = {
			...CATALOG,
			spirits: [
				{
					id: 'world-ender-a',
					name: 'World Ender',
					cost: 9,
					classes: { 'World Ender': 1 },
					origins: {}
				},
				{
					id: 'golden-ruler-b',
					name: 'Golden Ruler',
					cost: 9,
					classes: { 'Golden Ruler': 1 },
					origins: {}
				}
			]
		};
		state.players.Red!.handDraws = [
			{ guid: 'draw-a', id: 'world-ender-a', name: 'World Ender', cost: 9 },
			{ guid: 'draw-b', id: 'golden-ruler-b', name: 'Golden Ruler', cost: 9 }
		];

		const ender = encodeAction(
			state,
			'Red',
			{ type: 'spawnHandSpirit', guid: 'draw-a' },
			undefined,
			catalog
		);
		const ruler = encodeAction(
			state,
			'Red',
			{ type: 'spawnHandSpirit', guid: 'draw-b' },
			undefined,
			catalog
		);
		expect(ender).not.toEqual(ruler);
		expect(ender.slice(COMMAND_VOCAB.length + 10, COMMAND_VOCAB.length + 12)).not.toEqual(
			ruler.slice(COMMAND_VOCAB.length + 10, COMMAND_VOCAB.length + 12)
		);
	});

	it('enumerates distinct four-die payment compositions without fungible duplicates', () => {
		const state = atQuietLocation();
		state.phase = 'awakening';
		state.players.Red!.spirits = [
			{
				slotIndex: 6,
				id: 'dark-fighter',
				name: 'Dark Fighter',
				cost: 4,
				classes: { 'Dark Fighter': 1 },
				origins: {},
				isFaceDown: true
			}
		];
		state.players.Red!.attackDice = [
			{ instanceId: 'basic-a', tier: 'basic' },
			{ instanceId: 'basic-b', tier: 'basic' },
			{ instanceId: 'enchanted', tier: 'enchanted' },
			{ instanceId: 'exalted', tier: 'exalted' },
			{ instanceId: 'arcane', tier: 'arcane' }
		];
		state.players.Red!.awakenOffers = [
			{
				slotIndex: 6,
				spiritName: 'Dark Fighter',
				requirement: 'Discard 4 Attack Dice',
				discardCount: 4,
				requiresSelection: true,
				options: state.players.Red!.attackDice.map((die) => ({
					ref: { kind: 'attackDie' as const, instanceId: die.instanceId },
					label: die.tier
				}))
			}
		];
		const candidates: GameCommand[] = [];
		enumerateCandidates(state, 'Red', CATALOG, (command) => candidates.push(command));
		const payments = candidates.filter(
			(command): command is Extract<GameCommand, { type: 'awakenSpirit' }> =>
				command.type === 'awakenSpirit' && !!command.discardRefs
		);

		// C(5,4)=5 physical subsets, but excluding either Basic die has the same
		// strategic result, so the policy receives four semantic branches.
		expect(payments).toHaveLength(4);
		expect(payments.every((command) => command.discardRefs?.length === 4)).toBe(true);
		const encodings = payments.map((command) =>
			JSON.stringify(encodeAction(state, 'Red', command, undefined, CATALOG))
		);
		expect(new Set(encodings).size).toBe(4);
	});

	it('offers every generic augment class on real slot indexes plus a discard escape', () => {
		const state = atQuietLocation();
		state.phase = 'awakening';
		state.players.Red!.spirits = [
			{
				slotIndex: 2,
				id: 'host-a',
				name: 'Host A',
				cost: 2,
				classes: {},
				origins: {},
				isFaceDown: false
			},
			{
				slotIndex: 6,
				id: 'host-b',
				name: 'Host B',
				cost: 2,
				classes: {},
				origins: {},
				isFaceDown: false
			}
		];
		state.players.Red!.unplacedAugments = [{ runeId: 'generic-augment', name: 'Augment' }];

		const actions = legalActions(state, 'Red', CATALOG);
		const placements = actions.filter(
			(command): command is Extract<GameCommand, { type: 'placeAugmentOnSpirit' }> =>
				command.type === 'placeAugmentOnSpirit'
		);
		expect(placements).toHaveLength(12);
		expect(new Set(placements.map((command) => command.spiritSlotIndex))).toEqual(new Set([2, 6]));
		expect(new Set(placements.map((command) => command.className))).toEqual(
			new Set([
				'Fighter',
				'Elementalist',
				'Cultivator',
				'Soul Weaver',
				'Spirit Animal',
				'Cursed Spirit'
			])
		);
		const discard = actions.find((command) => command.type === 'discardUnplacedAugments');
		expect(discard).toBeDefined();
		expect(
			encodeAction(state, 'Red', discard!, undefined, CATALOG).some((value) => value === 1)
		).toBe(true);
	});

	it('encodes only held mats and enumerates non-contiguous cleanup slots', () => {
		const state = atQuietLocation();
		state.players.Red!.mats = [
			{ slotIndex: 1, hasRune: true, id: 'held-rune', name: 'Held Rune', type: 'rune' },
			{ slotIndex: 4, hasRune: false, id: 'spent-rune', name: 'Spent Rune', type: 'rune' }
		];
		const oneHeld = encodeObs(state, 'Red', CATALOG);
		state.players.Red!.mats[1].hasRune = true;
		const twoHeld = encodeObs(state, 'Red', CATALOG);
		expect(oneHeld).not.toEqual(twoHeld);

		state.phase = 'cleanup';
		state.players.Red!.spirits = [
			{
				slotIndex: 2,
				id: 'spirit-2',
				name: 'Spirit 2',
				cost: 2,
				classes: {},
				origins: {},
				isFaceDown: false
			},
			{
				slotIndex: 7,
				id: 'spirit-7',
				name: 'Spirit 7',
				cost: 2,
				classes: {},
				origins: {},
				isFaceDown: false
			}
		];
		const candidates: GameCommand[] = [];
		enumerateCandidates(state, 'Red', CATALOG, (command) => candidates.push(command));
		expect(
			candidates
				.filter((command) => command.type === 'discardSpirit')
				.map((command) => command.slotIndex)
		).toEqual([2, 7]);
		expect(
			candidates
				.filter((command) => command.type === 'discardRune')
				.map((command) => command.slotIndex)
		).toEqual([1, 4]);
	});

	it('enumerates every two-relic multiset reward choice', () => {
		const state = atQuietLocation();
		state.phase = 'benefits';
		state.players.Red!.pendingAwakenReward = {
			grants: [{ kind: 'relicChoice', amount: 2, source: 'Stellar Songbird' }]
		};
		const rewards = legalActions(state, 'Red', CATALOG).filter(
			(command): command is Extract<GameCommand, { type: 'resolveAwakenReward' }> =>
				command.type === 'resolveAwakenReward'
		);
		expect(rewards).toHaveLength(15); // C(5 + 2 - 1, 2)
		expect(rewards.every((command) => command.relicPicks?.length === 2)).toBe(true);
	});

	it('exposes every small monster reward pick combination to the ML candidate surface', () => {
		let state = atAbyss();
		state = apply(state, RED, { type: 'startCombat' });
		expect(state.players.Red!.pendingReward).not.toBeNull();

		const actions = legalActionsWithNext(state, 'Red', CATALOG)
			.filter((a) => a.cmd.type === 'resolveMonsterReward')
			.map((a) => a.cmd as Extract<GameCommand, { type: 'resolveMonsterReward' }>);
		const pickSets = new Set(actions.map((cmd) => [...cmd.picks].sort((a, b) => a - b).join(',')));
		expect(pickSets).toEqual(
			new Set(['0', '1', '2', '3', '0,1', '0,2', '0,3', '1,2', '1,3', '2,3'])
		);
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

		const encodedA = encodeAction(state, 'Red', {
			type: 'resolveMonsterReward',
			picks: [0],
			choices: [0]
		});
		const encodedB = encodeAction(state, 'Red', {
			type: 'resolveMonsterReward',
			picks: [0],
			choices: [1]
		});
		expect(encodedA).toHaveLength(ACT_DIM);
		expect(encodedB).toHaveLength(ACT_DIM);
		expect(encodedA).not.toEqual(encodedB);
	});

	it('appends only public monster-reward semantics and resolves wildcard identities', () => {
		expect(MONSTER_REWARD_SEMANTIC_OFFSET).toBe(84);
		expect(ACT_DIM).toBe(MONSTER_REWARD_SEMANTIC_OFFSET + MONSTER_REWARD_SEMANTIC_SLOTS);
		const state = atAbyss();
		state.players.Red!.pendingReward = {
			monsterId: 'semantic-maw',
			monsterName: 'Semantic Maw',
			rewardTrack: [
				VP3,
				SPIRIT_WORLD_SUMMON,
				ABYSS_SUMMON,
				CULTIVATE,
				REST,
				BARRIER,
				FOREST_RUNE,
				ANIMAL_AUGMENT,
				TEAPOT,
				ANY_RUNE,
				ANY_RELIC
			],
			chooseAmount: 2
		};
		const semantic = (command: Extract<GameCommand, { type: 'resolveMonsterReward' }>) =>
			encodeAction(state, 'Red', command, undefined, CATALOG).slice(MONSTER_REWARD_SEMANTIC_OFFSET);

		expect(semantic({ type: 'resolveMonsterReward', picks: [0, 2] }).slice(0, 3)).toEqual([
			3 / 10,
			0,
			1 / 2
		]);
		expect(semantic({ type: 'resolveMonsterReward', picks: [1, 3] }).slice(1, 5)).toEqual([
			1 / 2,
			0,
			1 / 2,
			0
		]);
		expect(semantic({ type: 'resolveMonsterReward', picks: [4, 5] }).slice(4, 6)).toEqual([
			1 / 2,
			1 / 2
		]);
		expect(semantic({ type: 'resolveMonsterReward', picks: [6, 7] }).slice(6, 9)).toEqual([
			1 / 2,
			1 / 2,
			0
		]);
		expect(semantic({ type: 'resolveMonsterReward', picks: [6] }).slice(11, 15)).toEqual([
			0,
			1 / 2,
			0,
			0
		]); // fixed Forest rune
		expect(semantic({ type: 'resolveMonsterReward', picks: [8] }).slice(6, 9)).toEqual([
			0,
			0,
			1 / 2
		]);
		expect(semantic({ type: 'resolveMonsterReward', picks: [8] }).slice(15, 20)).toEqual([
			0,
			1 / 2,
			0,
			0,
			0
		]); // fixed Teapot relic
		const wildcard = semantic({
			type: 'resolveMonsterReward',
			picks: [9, 10],
			choices: [1, 3]
		});
		expect(wildcard.slice(9, 11)).toEqual([1 / 2, 1 / 2]);
		expect(wildcard.slice(11, 15)).toEqual([0, 1 / 2, 0, 0]); // Forest
		expect(wildcard.slice(15, 20)).toEqual([0, 0, 0, 1 / 2, 0]); // Flower relic

		const nonReward = encodeAction(state, 'Red', { type: 'endLocationActions' }).slice(
			MONSTER_REWARD_SEMANTIC_OFFSET
		);
		expect(nonReward).toEqual(Array(MONSTER_REWARD_SEMANTIC_SLOTS).fill(0));
		expect(nonReward).toHaveLength(MONSTER_REWARD_SEMANTIC_SLOTS);
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
					id: 'spirit-animal-2',
					name: 'Route Cub Twin',
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
		const animal = encodeAction(
			state,
			'Red',
			{ type: 'takeSpirit', marketIndex: 0 },
			undefined,
			catalog
		);
		const cultivator = encodeAction(
			state,
			'Red',
			{ type: 'takeSpirit', marketIndex: 1 },
			undefined,
			catalog
		);
		state.market[0].spiritId = 'spirit-animal-2';
		const animalTwin = encodeAction(
			state,
			'Red',
			{ type: 'takeSpirit', marketIndex: 0 },
			undefined,
			catalog
		);

		expect(blind[p + 3]).toBe(0);
		expect(animal.slice(0, ACTION_EFFECT_OFFSET + ACTION_EFFECT_SLOTS)).toEqual(
			animalTwin.slice(0, ACTION_EFFECT_OFFSET + ACTION_EFFECT_SLOTS)
		);
		expect(animal).not.toEqual(animalTwin);
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
		// Frozen v1.2 prefix: class composition occupies 55..61; v1.3 appends after index 82.
		expect(obs.slice(55, 62)).toEqual([2 / 7, 1 / 3, 1 / 3, 1 / 3, 0, 0, 0]);
	});

	it('encodes the v1.1 ladder forward-value block (obs 62→77)', () => {
		const state = atAbyss();
		const obs = encodeObs(state, 'Red', CATALOG);
		expect(obs).toHaveLength(OBS_DIM);
		// Frozen v1.2 prefix: ladder block 62..76, before location 77..82.
		const block = obs.slice(62, 77);
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
		expect(abyss.slice(77, 83)).toEqual([0, 0, 0, 0, 1, 1]);
		// At a Spirit World location (Floral Patch, index 0): one-hot slot 0, at-Abyss flag clear.
		const floral = encodeObs(atQuietLocation(), 'Red', CATALOG);
		expect(floral.slice(77, 83)).toEqual([1, 0, 0, 0, 0, 0]);
	});

	it('makes the configured player count explicit for mixed solo/multiplayer training', () => {
		const multiplayer = atAbyss();
		const solo = structuredClone(multiplayer);
		solo.activeSeats = ['Red'];
		const multiObs = encodeObs(multiplayer, 'Red', CATALOG);
		const soloObs = encodeObs(solo, 'Red', CATALOG);

		expect(multiObs[83]).toBe(multiplayer.activeSeats.length / SEAT_COLORS.length);
		expect(soloObs[83]).toBe(1 / SEAT_COLORS.length);
		expect(multiObs[83]).not.toBe(soloObs[83]);
	});

	it('appends public late-game pace, tableau, and overflow features at indices 188..198', () => {
		const early = atQuietLocation();
		early.players.Red!.mats = [];
		early.players.Red!.spirits = [];
		const earlyObs = encodeObs(early, 'Red', CATALOG);
		expect(earlyObs).toHaveLength(199);
		expect(earlyObs.slice(188)).toEqual([
			0, // crossed 15
			0, // post-15 progress
			0, // no completed-round pace yet
			0, // no current-round VP yet
			1 / 5, // 30 VP / 30 inclusive remaining rounds / 5
			1, // seven free spirit slots
			0, // no awakened spirits
			0, // no material overflow
			1, // four slots of carry headroom
			0, // runes
			0 // relics
		]);

		const late = structuredClone(early);
		late.round = 5;
		const me = late.players.Red!;
		me.victoryPoints = 15;
		// The fifth entry is a defensive stale/terminal snapshot and must not leak into round 5.
		me.vpHistory = [2, 5, 9, 12, 99];
		me.spirits = Array.from({ length: 7 }, (_, index) => ({
			slotIndex: index + 1,
			id: `macro-spirit-${index}`,
			name: `Macro Spirit ${index}`,
			cost: 1,
			classes: {},
			origins: {},
			isFaceDown: index >= 4
		}));
		me.mats = [
			...Array.from({ length: 3 }, (_, index) => ({
				slotIndex: index + 1,
				hasRune: true,
				name: `Rune ${index}`,
				type: 'rune' as const
			})),
			...Array.from({ length: 2 }, (_, index) => ({
				slotIndex: index + 4,
				hasRune: true,
				name: `Relic ${index}`,
				type: 'relic' as const
			})),
			{ slotIndex: 6, hasRune: false, name: 'Spent Rune', type: 'rune' as const }
		];

		const tail = encodeObs(late, 'Red', CATALOG).slice(188);
		expect(tail).toHaveLength(11);
		expect(tail[0]).toBe(1);
		expect(tail[1]).toBe(0);
		expect(tail[2]).toBeCloseTo(10 / 3 / 5); // gains 3, 4, 3 across rounds 2..4
		expect(tail[3]).toBeCloseTo(3 / 10);
		expect(tail[4]).toBeCloseTo(15 / 26 / 5);
		expect(tail[5]).toBe(0);
		expect(tail[6]).toBeCloseTo(4 / 7);
		expect(tail[7]).toBeCloseTo(1 / 4);
		expect(tail[8]).toBe(0);
		expect(tail[9]).toBeCloseTo(3 / 8);
		expect(tail[10]).toBeCloseTo(2 / 8);

		me.victoryPoints = 21;
		expect(encodeObs(late, 'Red', CATALOG).slice(188, 193)).toEqual([
			1,
			2 / 5,
			tail[2],
			9 / 10,
			9 / 26 / 5
		]);
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
		expect(encoded[ACTION_EFFECT_OFFSET + 7]).toBeGreaterThan(0);
		expect(encoded[ACTION_EFFECT_OFFSET + 8]).toBe(1);
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
		expect(plan!.priors[abyssIndex]).toBeGreaterThan(
			Math.max(...plan!.priors.filter((_, i) => i !== abyssIndex))
		);
	});

	it('can boost Abyss navigation priors from the learned farm-value head', () => {
		const state = createLobbyState({
			roomCode: 'FARMH',
			guardianNames: ['Red Guard', 'Blue Guard']
		});
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
		expect(plan!.priors[abyssIndex]).toBeGreaterThan(
			Math.max(...plan!.priors.filter((_, i) => i !== abyssIndex))
		);
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

		const endFeatures = encodeAction(
			state,
			'Red',
			actions[endLocation].cmd,
			actions[endLocation].next
		);
		expect(endFeatures).toHaveLength(ACT_DIM);
		expect(endFeatures[ACTION_EFFECT_OFFSET + 9]).toBe(1);
		expect(
			actions[valueGuidedIndex(neutralPolicy, state, 'Red', actions, undefined, CATALOG)].cmd.type
		).toBe('endLocationActions');
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
		expect(
			actions[
				policyIndexWithProgressGuard(
					policyThatWouldPickFirst,
					state,
					'Red',
					actions,
					undefined,
					CATALOG
				)
			].cmd.type
		).toBe('endLocationActions');
	});

	it('lets the learned policy decline delayed PvP instead of forcing every legal attack', () => {
		const state = atQuietLocation();
		state.phase = 'encounter';
		const pvpNext = structuredClone(state);
		const passNext = structuredClone(state);
		passNext.players.Red!.phaseReady = true;
		const actions: LegalAction[] = [
			{
				cmd: { type: 'initiatePvp' },
				next: pvpNext,
				policyNext: state,
				hasHiddenOutcome: true
			},
			{
				cmd: { type: 'passEncounter' },
				next: passNext,
				policyNext: passNext,
				hasHiddenOutcome: false
			}
		];
		const policyThatPasses = {
			value: neutralPolicy.value,
			scoreCandidates: neutralPolicy.scoreCandidates,
			probs: neutralPolicy.probs,
			pick: (_obs: number[], cands: number[][]) => cands.length - 1
		} as unknown as NeuralPolicy;

		const idx = hybridIndex(policyThatPasses, state, 'Red', actions, undefined, CATALOG);
		expect(actions[idx].cmd.type).toBe('passEncounter');
	});

	it('keeps immediate monster VP by default but makes the ambiguity learnable when opted in', () => {
		const state = atAbyss();
		state.players.Red!.pendingReward = {
			monsterId: 'choice-maw',
			monsterName: 'Choice Maw',
			rewardTrack: [VP3, ANY_RUNE],
			chooseAmount: 1
		};
		const actions = legalActionsWithNext(state, 'Red', CATALOG).filter(
			(action) => action.cmd.type === 'resolveMonsterReward'
		);
		let picks = 0;
		const policyThatBuilds = {
			...neutralPolicy,
			pick: (_obs: number[], cands: number[][]) => {
				picks += 1;
				return cands.length - 1;
			}
		} as unknown as NeuralPolicy;

		const historical = hybridIndex(policyThatBuilds, state, 'Red', actions, undefined, CATALOG);
		expect(actions[historical].cmd).toMatchObject({ type: 'resolveMonsterReward', picks: [0] });
		expect(picks).toBe(0);

		const learned = hybridIndex(
			policyThatBuilds,
			state,
			'Red',
			actions,
			{ learnMonsterRewardChoices: true },
			CATALOG
		);
		expect(actions[learned].cmd).toMatchObject({ type: 'resolveMonsterReward', picks: [1] });
		expect(picks).toBe(1);

		state.players.Red!.victoryPoints = 27;
		const winningActions = legalActionsWithNext(state, 'Red', CATALOG).filter(
			(action) => action.cmd.type === 'resolveMonsterReward'
		);
		const win = hybridIndex(
			policyThatBuilds,
			state,
			'Red',
			winningActions,
			{ learnMonsterRewardChoices: true },
			CATALOG
		);
		expect(winningActions[win].cmd).toMatchObject({ type: 'resolveMonsterReward', picks: [0] });
		expect(picks).toBe(1); // immediate win never delegated to policy
	});
});
