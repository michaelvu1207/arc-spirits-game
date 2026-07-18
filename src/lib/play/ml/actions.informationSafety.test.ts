import { describe, expect, it } from 'vitest';
import type { GameLocationRewardRow } from '$lib/types';
import { createRng } from '../rng';
import { applyGameCommand, createLobbyState } from '../runtime';
import { computeKillProbability } from '../server/botPolicy';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState } from '../types';
import {
	commandHasHiddenOutcome,
	isStochasticLegalAction,
	legalActionsWithNext,
	type LegalAction
} from './actions';
import {
	ACT_DIM,
	ACTION_EFFECT_OFFSET,
	ACTION_EFFECT_SLOTS,
	COMMAND_VOCAB,
	encodeAction,
	encodeObs
} from './encode';
import { filterConstrainedActions } from './driver';
import { planDecisionGumbel } from './gumbelPlanner';
import { selectableCandidateIndices } from './neuralBot';
import type { NeuralPolicy } from './net';
import {
	chooseRouteBreakpointOracleAction,
	routeBreakpointActionScore
} from './routeBreakpointOracle';

const VP1 = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e';
const SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';

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
			name: 'Public Maw',
			damage: 1,
			barrier: 3,
			rewardTrack: [VP1, VP3],
			dicePool: [],
			chooseAmount: 2,
			stage: 1,
			order: 0
		}
	],
	locations: []
};

const MIXED_REWARD_ROWS: GameLocationRewardRow[] = [{ type: 'gain', gain_icon_ids: [VP1, SUMMON] }];
const DRAW_CATALOG: PlayCatalog = {
	...CATALOG,
	spirits: Array.from({ length: 36 }, (_, i) => ({
		id: `draw-${i}`,
		name: `Draw Spirit ${i}`,
		cost: (i % 5) + 1,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	locations: [{ name: 'Tidal Cove', originId: null, rewardRows: MIXED_REWARD_ROWS }]
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = {
	memberId: 'm-blue',
	displayName: 'Blue',
	role: 'player',
	seatColor: 'Blue'
};

const neutralSearchPolicy = {
	value: () => 0.5,
	scoreCandidates: (_obs: number[], cands: number[][]) => cands.map(() => 0)
} as unknown as NeuralPolicy;

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	return applyWithCatalog(state, actor, command, CATALOG);
}

function applyWithCatalog(
	state: PublicGameState,
	actor: GameActor,
	command: GameCommand,
	catalog: PlayCatalog
): PublicGameState {
	const result = applyGameCommand(state, actor, command, catalog);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

function combatState(): PublicGameState {
	let state = createLobbyState({ roomCode: 'FAIR', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	state = apply(state, RED, { type: 'startGame', seed: 7 });
	state = apply(state, RED, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	state = apply(state, RED, { type: 'forceAdvancePhase' });
	state.players.Red!.attackDice = [{ instanceId: 'public-arcane-die', tier: 'arcane' }];
	return state;
}

function startCombatForSeed(
	base: PublicGameState,
	seed: number
): { state: PublicGameState; action: LegalAction } {
	const state = structuredClone(base);
	state.rng = createRng(seed);
	const action = legalActionsWithNext(state, 'Red', CATALOG).find(
		(candidate) => candidate.cmd.type === 'startCombat'
	);
	if (!action) throw new Error(`startCombat missing for seed ${seed}`);
	return { state, action };
}

function didKill(action: LegalAction): boolean {
	return action.next.combats.some(
		(combat) => combat.kind === 'monster' && combat.sides[0]?.seat === 'Red' && combat.killed
	);
}

function drawState(seed: number): PublicGameState {
	let state = createLobbyState({ roomCode: 'DRAW', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = applyWithCatalog(state, RED, { type: 'claimSeat', seatColor: 'Red' }, DRAW_CATALOG);
	state = applyWithCatalog(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' }, DRAW_CATALOG);
	state = applyWithCatalog(
		state,
		RED,
		{ type: 'selectGuardian', guardianName: 'Red Guard' },
		DRAW_CATALOG
	);
	state = applyWithCatalog(
		state,
		BLUE,
		{ type: 'selectGuardian', guardianName: 'Blue Guard' },
		DRAW_CATALOG
	);
	state = applyWithCatalog(state, RED, { type: 'startGame', seed }, DRAW_CATALOG);
	state = applyWithCatalog(
		state,
		RED,
		{ type: 'lockNavigation', destination: 'Tidal Cove' },
		DRAW_CATALOG
	);
	state = applyWithCatalog(
		state,
		BLUE,
		{ type: 'lockNavigation', destination: 'Tidal Cove' },
		DRAW_CATALOG
	);
	return applyWithCatalog(state, RED, { type: 'forceAdvancePhase' }, DRAW_CATALOG);
}

function pvpState(seed: number): PublicGameState {
	let state = createLobbyState({ roomCode: 'PVP', guardianNames: ['Red Guard', 'Blue Guard'] });
	state = apply(state, RED, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	state = apply(state, RED, { type: 'startGame', seed });
	state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Cyber City' });
	state.players.Red!.statusLevel = 3;
	state.players.Red!.statusToken = 'Fallen';
	state.players.Red!.attackDice = [{ instanceId: 'red-arcane', tier: 'arcane' }];
	state.players.Red!.maxBarrier = 20;
	state.players.Red!.barrier = 20;
	state.players.Red!.brokenBarrier = 0;
	state.players.Blue!.statusLevel = 0;
	state.players.Blue!.statusToken = 'Pure';
	state.players.Blue!.maxBarrier = 2;
	state.players.Blue!.barrier = 2;
	state.players.Blue!.brokenBarrier = 0;
	state.players.Blue!.attackDice = [];
	return apply(state, RED, { type: 'forceAdvancePhase' });
}

describe('information-safe ML action previews', () => {
	it('does not expose the exact upcoming monster-combat roll to candidate scoring', () => {
		const base = combatState();
		let killed: ReturnType<typeof startCombatForSeed> | undefined;
		let missed: ReturnType<typeof startCombatForSeed> | undefined;
		for (let seed = 1; seed <= 128 && (!killed || !missed); seed += 1) {
			const candidate = startCombatForSeed(base, seed);
			if (didKill(candidate.action)) killed ??= candidate;
			else missed ??= candidate;
		}

		expect(killed, 'expected at least one killing hidden seed').toBeDefined();
		expect(missed, 'expected at least one missing hidden seed').toBeDefined();
		const hit = killed!;
		const miss = missed!;

		// The authoritative execution states still retain the real result.
		expect(didKill(hit.action)).toBe(true);
		expect(didKill(miss.action)).toBe(false);
		expect(hit.action.next.players.Red!.pendingReward).not.toBeNull();
		expect(miss.action.next.players.Red!.pendingReward).toBeNull();

		// Selection gets the pre-resolution state and an explicit stochastic marker.
		for (const { state, action } of [hit, miss]) {
			expect(action.hasHiddenOutcome).toBe(true);
			expect(isStochasticLegalAction(action)).toBe(true);
			expect(commandHasHiddenOutcome(state, action.cmd, action.next)).toBe(true);
			expect(action.policyNext.players.Red!.pendingReward).toBeNull();
			expect(action.policyNext.monster!.livesRemaining).toBe(state.monster!.livesRemaining);
			expect(action.policyNext.combats).toEqual(state.combats);
			expect(action.policyNext.players.Red!.barrier).toBe(action.next.players.Red!.barrier);
			expect(action.policyNext.players.Red!.statusLevel).toBe(action.next.players.Red!.statusLevel);
			expect(action.policyNext.players.Red!.actionsUsedThisRound).toContain('combat');
		}

		// Even a missed integration that passes the realized `.next` into encodeAction
		// cannot leak the roll: startCombat encoding is based only on public expectations.
		const safeHit = encodeAction(hit.state, 'Red', hit.action.cmd, hit.action.policyNext, CATALOG);
		const safeMiss = encodeAction(
			miss.state,
			'Red',
			miss.action.cmd,
			miss.action.policyNext,
			CATALOG
		);
		const realizedHit = encodeAction(hit.state, 'Red', hit.action.cmd, hit.action.next, CATALOG);
		const realizedMiss = encodeAction(
			miss.state,
			'Red',
			miss.action.cmd,
			miss.action.next,
			CATALOG
		);
		expect(safeHit).toEqual(safeMiss);
		expect(realizedHit).toEqual(realizedMiss);
		expect(realizedHit).toEqual(safeHit);
		expect(encodeObs(hit.state, 'Red', CATALOG)).toEqual(encodeObs(miss.state, 'Red', CATALOG));
	});

	it('previews guaranteed monster damage and corruption without revealing the attack roll', () => {
		const base = combatState();
		base.players.Red!.maxBarrier = 1;
		base.players.Red!.barrier = 1;
		base.players.Red!.brokenBarrier = 0;
		base.players.Red!.statusLevel = 0;
		base.players.Red!.statusToken = 'Pure';
		base.players.Red!.spirits = [
			{
				slotIndex: 1,
				id: 'known-spirit',
				name: 'Known Spirit',
				cost: 1,
				classes: {},
				origins: {},
				isFaceDown: false
			}
		];
		const { state, action } = startCombatForSeed(base, 31);

		expect(action.policyNext.players.Red!.statusLevel).toBe(1);
		expect(action.policyNext.players.Red!.statusToken).toBe('Tainted');
		expect(action.policyNext.players.Red!.barrier).toBe(1); // corruption restores the barrier
		expect(action.policyNext.players.Red!.pendingCorruptionDiscard?.count).toBe(1);
		expect(action.policyNext.players.Red!.actionsUsedThisRound).toContain('combat');

		const effects = encodeAction(state, 'Red', action.cmd, action.policyNext, CATALOG).slice(
			ACTION_EFFECT_OFFSET,
			ACTION_EFFECT_OFFSET + ACTION_EFFECT_SLOTS
		);
		expect(effects[3]).toBe(0); // restored barrier; corruption is carried by the next slot
		expect(effects[4]).toBeCloseTo(1 / 3);
	});

	it('previews a guaranteed monster reward without exposing the exact roll total', () => {
		const state = combatState();
		state.players.Red!.attackDice = Array.from({ length: 3 }, (_, index) => ({
			instanceId: `guaranteed-arcane-${index}`,
			tier: 'arcane' as const
		}));
		const action = legalActionsWithNext(state, 'Red', CATALOG).find(
			(candidate) => candidate.cmd.type === 'startCombat'
		)!;

		expect(action.next.combats.find((combat) => combat.kind === 'monster')?.killed).toBe(true);
		expect(action.policyNext.players.Red!.pendingReward).toMatchObject({
			monsterId: 'm-1',
			chooseAmount: 2
		});
		expect(action.policyNext.monster!.livesRemaining).toBe(state.monster!.livesRemaining - 1);
		expect(action.policyNext.combats).toEqual(state.combats);
	});

	it('keeps fixed VP and draw-count effects while redacting a mixed reward draw', () => {
		let first: { state: PublicGameState; action: LegalAction } | undefined;
		let second: { state: PublicGameState; action: LegalAction } | undefined;
		for (let seed = 1; seed <= 32 && !second; seed += 1) {
			const state = drawState(seed);
			const action = legalActionsWithNext(state, 'Red', DRAW_CATALOG).find(
				(candidate) =>
					candidate.cmd.type === 'resolveLocationInteraction' && candidate.cmd.rowIndex === 0
			);
			if (!action) throw new Error('mixed reward row missing');
			const ids = action.next.players.Red!.handDraws.map((draw) => draw.id).join('|');
			if (!first) first = { state, action };
			else {
				const firstIds = first.action.next.players.Red!.handDraws.map((draw) => draw.id).join('|');
				if (ids !== firstIds) second = { state, action };
			}
		}
		expect(first).toBeDefined();
		expect(second, 'expected two seeds with different hidden spirit draws').toBeDefined();

		for (const { state, action } of [first!, second!]) {
			expect(action.hasHiddenOutcome).toBe(true);
			expect(action.next.players.Red!.victoryPoints).toBe(
				(state.players.Red!.victoryPoints ?? 0) + 1
			);
			expect(action.policyNext.players.Red!.victoryPoints).toBe(
				action.next.players.Red!.victoryPoints
			);
			expect(action.policyNext.players.Red!.handDraws).toHaveLength(4);
			expect(
				action.policyNext.players.Red!.handDraws.every(
					(draw) => draw.id === undefined && draw.name === undefined && draw.cost === undefined
				)
			).toBe(true);
			expect(action.policyNext.players.Red!.pendingDraw?.drawCount).toBe(4);
			expect(action.policyNext.players.Red!.actionsUsedThisRound).toContain('row:0');
			const effects = encodeAction(state, 'Red', action.cmd, action.policyNext, DRAW_CATALOG).slice(
				ACTION_EFFECT_OFFSET,
				ACTION_EFFECT_OFFSET + ACTION_EFFECT_SLOTS
			);
			expect(effects[1]).toBeCloseTo(1 / 5);
		}

		expect(first!.action.policyNext.players.Red!.handDraws).toEqual(
			second!.action.policyNext.players.Red!.handDraws
		);
		expect(
			encodeAction(first!.state, 'Red', first!.action.cmd, first!.action.policyNext, DRAW_CATALOG)
		).toEqual(
			encodeAction(
				second!.state,
				'Red',
				second!.action.cmd,
				second!.action.policyNext,
				DRAW_CATALOG
			)
		);
	});

	it('keeps fixed PvP engage VP but hides roll-dependent damage and corruption bounty', () => {
		let low: LegalAction | undefined;
		let high: LegalAction | undefined;
		for (let seed = 1; seed <= 128 && (!low || !high); seed += 1) {
			const state = pvpState(seed);
			const action = legalActionsWithNext(state, 'Red', CATALOG).find(
				(candidate) => candidate.cmd.type === 'initiatePvp'
			);
			if (!action) throw new Error('initiatePvp missing');
			if ((action.next.players.Blue!.statusLevel ?? 0) > 0) high ??= action;
			else low ??= action;
		}
		expect(low).toBeDefined();
		expect(high).toBeDefined();

		for (const action of [low!, high!]) {
			expect(action.hasHiddenOutcome).toBe(true);
			expect(action.policyNext.phase).toBe('location');
			expect(action.policyNext.players.Red!.victoryPoints).toBe(2);
			expect(action.policyNext.players.Blue!.barrier).toBe(2);
			expect(action.policyNext.players.Blue!.statusLevel).toBe(0);
			expect(action.policyNext.combats.some((combat) => combat.kind === 'pvp')).toBe(false);
		}
		expect(low!.next.players.Red!.victoryPoints).toBe(2);
		expect(high!.next.players.Red!.victoryPoints).toBe(4);
	});

	it('keeps public monster/reward facts and expected combat value in the action vector', () => {
		const state = combatState();
		const action = legalActionsWithNext(state, 'Red', CATALOG).find(
			(candidate) => candidate.cmd.type === 'startCombat'
		)!;
		const encoded = encodeAction(state, 'Red', action.cmd, action.policyNext, CATALOG);
		const p = COMMAND_VOCAB.length;
		const cleanKill = computeKillProbability(state, 'Red', CATALOG);

		expect(encoded).toHaveLength(ACT_DIM);
		expect(encoded[p]).toBeCloseTo(cleanKill); // fair kill probability
		expect(encoded[p + 1]).toBeCloseTo(cleanKill); // clean-kill probability
		expect(encoded[p + 2]).toBeCloseTo(1 / 6); // raw one-arcane-die firepower vs 3 HP
		expect(encoded[p + 4]).toBeCloseTo(3 / 20); // public monster HP
		expect(encoded[p + 5]).toBeCloseTo(1 / 20); // public monster damage
		expect(encoded[p + 6]).toBe(1); // public remaining-lives fraction
		expect(encoded[p + 8]).toBeCloseTo(4 / 10); // public claimable reward VP
		expect(encoded[p + 9]).toBeCloseTo((cleanKill * 4) / 10); // expected reward VP
		expect(encoded[p + 10]).toBeCloseTo(2 / 4); // public reward pick count
		expect(encoded[p + 11]).toBeCloseTo(2 / 8); // public resolvable reward count

		const effects = encoded.slice(ACTION_EFFECT_OFFSET, ACTION_EFFECT_OFFSET + ACTION_EFFECT_SLOTS);
		expect(effects[7]).toBeCloseTo((cleanKill * 4) / 10); // expected pending reward VP
		expect(effects[8]).toBeCloseTo(cleanKill); // P(reward choice is created)
		expect(effects[9]).toBe(1); // committing the action is meaningful progress
		expect(effects[10]).toBeCloseTo(cleanKill / 4); // expected monster-life progress
	});

	it('keeps Gumbel search invariant to the already-realized hidden combat roll', () => {
		const base = combatState();
		let killed: ReturnType<typeof startCombatForSeed> | undefined;
		let missed: ReturnType<typeof startCombatForSeed> | undefined;
		for (let seed = 1; seed <= 128 && (!killed || !missed); seed += 1) {
			const candidate = startCombatForSeed(base, seed);
			if (didKill(candidate.action)) killed ??= candidate;
			else missed ??= candidate;
		}
		expect(killed).toBeDefined();
		expect(missed).toBeDefined();

		const plan = ({ state }: ReturnType<typeof startCombatForSeed>) =>
			planDecisionGumbel(
				state,
				'Red',
				CATALOG,
				neutralSearchPolicy,
				legalActionsWithNext(state, 'Red', CATALOG),
				{ simulations: 8, maxConsidered: 2, horizonRounds: 1, valueWeight: 1, seed: 991 }
			)!;
		const hitPlan = plan(killed!);
		const missPlan = plan(missed!);
		expect(hitPlan.logits).toEqual(missPlan.logits);
		expect(hitPlan.q).toEqual(missPlan.q);
		expect(hitPlan.pi).toEqual(missPlan.pi);
		expect(hitPlan.index).toBe(missPlan.index);
	});

	it('keeps route-oracle scoring and selection invariant across hidden combat seeds', () => {
		const base = combatState();
		let killed: ReturnType<typeof startCombatForSeed> | undefined;
		let missed: ReturnType<typeof startCombatForSeed> | undefined;
		for (let seed = 1; seed <= 128 && (!killed || !missed); seed += 1) {
			const candidate = startCombatForSeed(base, seed);
			if (didKill(candidate.action)) killed ??= candidate;
			else missed ??= candidate;
		}
		expect(killed).toBeDefined();
		expect(missed).toBeDefined();

		const score = ({ state, action }: ReturnType<typeof startCombatForSeed>) =>
			routeBreakpointActionScore(state, 'Red', CATALOG, action);
		expect(score(killed!)).toBeCloseTo(score(missed!), 12);

		const choose = ({ state }: ReturnType<typeof startCombatForSeed>) => {
			const actions = legalActionsWithNext(state, 'Red', CATALOG);
			return chooseRouteBreakpointOracleAction(state, 'Red', CATALOG, actions)?.cmd.type;
		};
		expect(choose(killed!)).toBe(choose(missed!));
	});

	it('uses policy previews, not realized hidden states, for driver constraints', () => {
		const state = combatState();
		const safe = structuredClone(state);
		const passNext = structuredClone(state);
		passNext.players.Red!.phaseReady = true;
		const hiddenActualA = structuredClone(state);
		hiddenActualA.players.Red!.statusLevel = 1;
		const hiddenActualB = structuredClone(state);
		hiddenActualB.players.Red!.statusLevel = 2;
		const makeActions = (actual: PublicGameState): LegalAction[] => [
			{
				cmd: { type: 'startCombat' },
				next: actual,
				policyNext: safe,
				hasHiddenOutcome: true
			},
			{
				cmd: { type: 'endLocationActions' },
				next: passNext,
				policyNext: passNext,
				hasHiddenOutcome: false
			}
		];

		const filteredA = filterConstrainedActions(makeActions(hiddenActualA), 'Red', undefined, 0);
		const filteredB = filterConstrainedActions(makeActions(hiddenActualB), 'Red', undefined, 0);
		expect(filteredA.map((action) => action.cmd.type)).toEqual([
			'startCombat',
			'endLocationActions'
		]);
		expect(filteredB.map((action) => action.cmd.type)).toEqual(
			filteredA.map((action) => action.cmd.type)
		);
	});

	it('treats a masked stochastic commitment as progress', () => {
		const { state, action } = startCombatForSeed(combatState(), 17);
		const inert: LegalAction = {
			cmd: action.cmd,
			next: state,
			policyNext: state,
			hasHiddenOutcome: false
		};
		expect(selectableCandidateIndices(state, 'Red', [inert, action])).toEqual([1]);
	});

	it('shares the authoritative next state for deterministic candidates', () => {
		const state = combatState();
		const end = legalActionsWithNext(state, 'Red', CATALOG).find(
			(candidate) => candidate.cmd.type === 'endLocationActions'
		)!;
		expect(end.hasHiddenOutcome).toBe(false);
		expect(end.policyNext).toBe(end.next);
	});
});
