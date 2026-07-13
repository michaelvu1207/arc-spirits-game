import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from '../runtime';
import type { AttackDie, GameActor, GameCommand, PlayCatalog, PublicGameState } from '../types';
import { legalActionsWithNext } from './actions';
import {
	applyTerminalRootCandidate,
	canonicalCommandSignature,
	evaluateTerminalTeacher,
	labelTerminalOutcomes,
	redeterminizeSoloTerminalState,
	sanitizeSoloTerminalState,
	terminalRolloutSeed,
	terminalTeacherCollectorRow,
	type TerminalRolloutOutcome
} from './terminalTeacher';
import { randomPolicy } from './nodeIo';

const VP = '24278b1c-c935-4d4e-aed5-408ce9c9a043';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const ANY_RUNE = '36aab6c9-b98c-4e84-b097-e743f45dde82';

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [
		{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }
	],
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: i < 30 ? (i % 5) + 1 : 8,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	monsters: [
		{
			id: 'm-1',
			name: 'Abyss Maw',
			damage: 1,
			barrier: 1,
			rewardTrack: [VP, ABYSS_SUMMON, ANY_RUNE],
			dicePool: [],
			chooseAmount: 1,
			stage: 1,
			order: 0
		},
		{
			id: 'm-2',
			name: 'Abyss Apex',
			damage: 9,
			barrier: 99,
			rewardTrack: [VP],
			dicePool: [],
			chooseAmount: 1,
			stage: 1,
			order: 1
		}
	],
	locations: []
};

const RED: GameActor = {
	memberId: 'm-red',
	displayName: 'Red',
	role: 'host',
	seatColor: 'Red'
};

function apply(state: PublicGameState, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, RED, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}

function rewardState(): PublicGameState {
	let state = createLobbyState({ roomCode: 'V24T', guardianNames: ['Red Guard'] });
	state = apply(state, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, { type: 'selectGuardian', guardianName: 'Red Guard' });
	state = apply(state, { type: 'startGame', seed: 17 });
	state = apply(state, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	state = apply(state, { type: 'forceAdvancePhase' });
	const dice: AttackDie[] = Array.from({ length: 8 }, (_, i) => ({
		instanceId: `arc-${i}`,
		tier: 'arcane'
	}));
	state.players.Red!.attackDice = dice;
	state = apply(state, { type: 'startCombat' });
	if (!state.players.Red?.pendingReward) throw new Error('expected pending reward');
	return state;
}

function outcome(won: boolean, vp: number, round = 30): TerminalRolloutOutcome {
	return {
		reached30: won,
		finalVP: vp,
		post15VpPerRound: Math.max(0, vp - 15) / 15,
		first30Round: won ? round : null,
		stalled: false
	};
}

describe('V24 terminal reward teacher', () => {
	it('removes the source RNG and canonicalizes hidden bag order', () => {
		const original = rewardState();
		const reordered = structuredClone(original);
		reordered.rng.seed = 0xdeadbeef;
		reordered.rng.cursor = 9123;
		reordered.bags.hexSpirits.contents.reverse();
		reordered.bags.abyssFallen.contents.reverse();

		const a = sanitizeSoloTerminalState(original, 'Red');
		const b = sanitizeSoloTerminalState(reordered, 'Red');
		expect(a.rng).toEqual(b.rng);
		expect(a.bags.hexSpirits.contents).toEqual(b.bags.hexSpirits.contents);
		expect(a.bags.abyssFallen.contents).toEqual(b.bags.abyssFallen.contents);
		expect(a.bags.history.hexSpirits).toBe(a.bags.hexSpirits);
	});

	it('fails closed if another private player is present', () => {
		const state = rewardState();
		state.players.Blue = structuredClone(state.players.Red!);
		expect(() => sanitizeSoloTerminalState(state, 'Red')).toThrow(/exactly one/);
	});

	it('derives common rollout seeds without candidate identity', () => {
		expect(terminalRolloutSeed('state-7', 3, 'audit')).toBe(
			terminalRolloutSeed('state-7', 3, 'audit')
		);
		expect(terminalRolloutSeed('state-7', 3, 'audit')).not.toBe(
			terminalRolloutSeed('state-7', 4, 'audit')
		);
	});

	it('re-shuffles first and reapplies the root command through the reducer', () => {
		const source = rewardState();
		const sanitized = sanitizeSoloTerminalState(source, 'Red');
		const rewardActions = legalActionsWithNext(source, 'Red', CATALOG).filter(
			(action) => action.cmd.type === 'resolveMonsterReward'
		);
		const summon = rewardActions.find(
			(action) =>
				action.cmd.type === 'resolveMonsterReward' &&
				action.cmd.picks.length === 1 &&
				action.cmd.picks[0] === 1
		);
		expect(summon).toBeDefined();
		const redetermined = redeterminizeSoloTerminalState(sanitized, 'Red', 'root-state', 0, 'test');
		const applied = applyTerminalRootCandidate(
			sanitized,
			'Red',
			summon!.cmd,
			CATALOG,
			'root-state',
			0,
			'test'
		);
		expect(applied).not.toBeNull();
		expect(applied!.rng.seed).toBe(redetermined.rng.seed);
		expect(applied!.rng.seed).not.toBe(source.rng.seed);
		expect(applied!.players.Red?.pendingReward).toBeNull();
	});

	it('runs every legal reward root to the real terminal horizon', () => {
		const state = rewardState();
		const actions = legalActionsWithNext(state, 'Red', CATALOG).filter(
			(action) => action.cmd.type === 'resolveMonsterReward'
		);
		const commands = actions.map((action) => action.cmd);
		const decision = evaluateTerminalTeacher(
			state,
			'Red',
			commands,
			randomPolicy(23, [8], [4]),
			CATALOG,
			{ stateId: 'full-rollout', rollouts: 1, salt: 'unit', maxStatusLevel: 2 }
		);
		expect(decision.index).toBeGreaterThanOrEqual(0);
		expect(decision.index).toBeLessThan(commands.length);
		expect(decision.label.stats).toHaveLength(commands.length);
		expect(decision.label.evaluatedMask.every((value) => value === 1)).toBe(true);
		expect(decision.label.stats.every((stat) => stat.stalls === 0)).toBe(true);
	}, 20_000);

	it('keeps labels invariant under candidate reordering', () => {
		const commands: GameCommand[] = [
			{ type: 'resolveMonsterReward', picks: [0] },
			{ type: 'resolveMonsterReward', picks: [1] },
			{ type: 'resolveMonsterReward', picks: [2], choices: [1] }
		];
		const outcomes = [
			Array.from({ length: 8 }, (_, i) => outcome(i < 7, i < 7 ? 30 : 27, 25)),
			Array.from({ length: 8 }, (_, i) => outcome(i < 3, i < 3 ? 30 : 25, 27)),
			Array.from({ length: 8 }, (_, i) => outcome(i < 1, i < 1 ? 30 : 24, 29))
		];
		const first = labelTerminalOutcomes(commands, outcomes, {
			stateId: 'reorder-state',
			rollouts: 8
		});
		const order = [2, 0, 1];
		const second = labelTerminalOutcomes(
			order.map((i) => commands[i]),
			order.map((i) => outcomes[i]),
			{ stateId: 'reorder-state', rollouts: 8 }
		);
		const bySignature = (label: typeof first) =>
			new Map(
				label.stats.map((stat, index) => [
					stat.commandSignature,
					{ stat, pi: label.terminalPi[index], mask: label.evaluatedMask[index] }
				])
			);
		expect(bySignature(second)).toEqual(bySignature(first));
		expect(first.stats[first.bestIndex].commandSignature).toBe(
			second.stats[second.bestIndex].commandSignature
		);
		expect(first.decisive).toBe(true);
	});

	it('emits only the exact normalized collector schema', () => {
		const commands: GameCommand[] = [
			{ type: 'resolveMonsterReward', picks: [0] },
			{ type: 'resolveMonsterReward', picks: [1] }
		];
		const label = labelTerminalOutcomes(
			commands,
			[
				Array.from({ length: 8 }, () => outcome(true, 30, 22)),
				Array.from({ length: 8 }, () => outcome(false, 25))
			],
			{ stateId: 'collector-state', rollouts: 8 }
		);
		const row = terminalTeacherCollectorRow(label, [1, 2], [[3], [4]], 0.75);
		expect(Object.keys(row).sort()).toEqual(
			['stateId', 'obs', 'cands', 'evaluatedMask', 'terminalPi', 'teacherWeight'].sort()
		);
		expect(row.terminalPi.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
		expect(row.terminalPi.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
		expect(canonicalCommandSignature(commands[0])).not.toBe(canonicalCommandSignature(commands[1]));
		expect(() => terminalTeacherCollectorRow(label, [1, 2], [[3], [4]], 0)).toThrow(
			/teacherWeight/
		);
		expect(() =>
			terminalTeacherCollectorRow(
				{ ...label, terminalPi: [1, 0], evaluatedMask: [1, 1] },
				[1, 2],
				[[3], [4]]
			)
		).toThrow(/terminalPi/);
	});
});
