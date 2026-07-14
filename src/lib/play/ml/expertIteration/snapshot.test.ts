import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../../runtime';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../../types';
import { legalActionsWithNext, type LegalAction } from '../actions';
import {
	assertFeatureShardSafe,
	botSamplingSeed,
	buildOutcomeBlindSnapshot,
	canonicalJson,
	closeDeterministicSingletons,
	commandHash,
	commandTraceEvent,
	deadlineTraceEvent,
	forbiddenFeaturePaths,
	recoveryDiagnostics,
	replaySnapshotTrace,
	semanticCandidateHash,
	sha256Canonical,
	structuralPublicState,
	structuralPublicStateHash,
	type PolicySafeCandidateV1,
	type SnapshotTraceEventV1,
	type WeakEngineThresholdV1
} from './snapshot';

const SOURCE_SEED = 71;

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'guardian-red', name: 'Synthetic Red', originId: 'forest' },
		{ id: 'guardian-blue', name: 'Synthetic Blue', originId: 'abyss' }
	],
	mats: [],
	classes: [],
	dice: [
		{
			id: 'basic-attack',
			name: 'Basic Attack',
			diceType: 'attack',
			sides: [1, 1, 2, 2, 3, 3]
		}
	],
	spirits: Array.from({ length: 40 }, (_, index) => ({
		id: `synthetic-spirit-${index}`,
		name: `Synthetic Spirit ${index}`,
		cost: index < 30 ? (index % 5) + 1 : 8,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	monsters: [],
	locations: []
};

const RED: GameActor = {
	memberId: 'synthetic-member-red',
	displayName: 'Synthetic Red Player',
	role: 'host',
	seatColor: 'Red'
};

const BLUE: GameActor = {
	memberId: 'synthetic-member-blue',
	displayName: 'Synthetic Blue Player',
	role: 'player',
	seatColor: 'Blue'
};

const WEAK_THRESHOLD: WeakEngineThresholdV1 = {
	minRoundInclusive: 16,
	maxExpectedAttack: 99,
	maxAttackDice: 99,
	maxAwakenedSpirits: 99,
	maxBarrier: 99,
	maxInitiative: 99
};

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.code}: ${result.error.message}`);
	return result.state;
}

function startedFixture(seatCount = 1): {
	state: PublicGameState;
	events: SnapshotTraceEventV1[];
	guardianNames: string[];
} {
	const guardianNames = CATALOG.guardians.slice(0, seatCount).map((guardian) => guardian.name);
	let state = createLobbyState({ roomCode: 'SYNTHETIC', guardianNames });
	const events: SnapshotTraceEventV1[] = [];
	const run = (actor: GameActor, command: GameCommand) => {
		events.push(commandTraceEvent(actor, command));
		state = apply(state, actor, command);
	};

	run(RED, { type: 'claimSeat', seatColor: 'Red' });
	run(RED, { type: 'selectGuardian', guardianName: 'Synthetic Red' });
	if (seatCount > 1) {
		run(BLUE, { type: 'claimSeat', seatColor: 'Blue' });
		run(BLUE, { type: 'selectGuardian', guardianName: 'Synthetic Blue' });
	}
	run(RED, { type: 'startGame', seed: SOURCE_SEED });
	return { state, events, guardianNames };
}

describe('canonical JSON and hashes', () => {
	it('sorts keys recursively, normalizes negative zero, and omits undefined object members', () => {
		const a = { z: 2, nested: { y: -0, x: 1 }, omitted: undefined };
		const b = { nested: { x: 1, y: 0 }, z: 2 };
		expect(canonicalJson(a)).toBe('{"nested":{"x":1,"y":0},"z":2}');
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(sha256Canonical(a)).toBe(sha256Canonical(b));
	});

	it('fails closed on invalid JSON values and cycles', () => {
		expect(() => canonicalJson([undefined])).toThrow(/undefined/);
		expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/);
		expect(() => canonicalJson(new Date(0))).toThrow(/plain object/);
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(() => canonicalJson(cycle)).toThrow(/cycle/);
	});

	it('gives commands canonical hashes independent of construction key order', () => {
		const a: GameCommand = {
			type: 'resolveDecision',
			decisionId: 'synthetic-decision',
			optionId: 'yes',
			selectedInstanceIds: ['die-b', 'die-a']
		};
		const b = {
			selectedInstanceIds: ['die-b', 'die-a'],
			optionId: 'yes',
			decisionId: 'synthetic-decision',
			type: 'resolveDecision'
		} as GameCommand;
		expect(commandHash(a)).toBe(commandHash(b));
	});
});

describe('reset trace replay', () => {
	it('replays command and deadline events deterministically from reset', () => {
		const fixture = startedFixture(2);
		fixture.events.push(deadlineTraceEvent(fixture.state));
		applyDeadlineAdvance(fixture.state, CATALOG);

		const input = {
			roomCode: 'SYNTHETIC',
			guardianNames: fixture.guardianNames,
			catalog: CATALOG,
			sourceSeed: SOURCE_SEED,
			events: fixture.events
		};
		const first = replaySnapshotTrace(input);
		const second = replaySnapshotTrace(input);
		expect(canonicalJson(first)).toBe(canonicalJson(second));
		expect(canonicalJson(first)).toBe(canonicalJson(fixture.state));
	});

	it('rejects a mismatched source seed, command tampering, and deadline drift', () => {
		const fixture = startedFixture();
		expect(() =>
			replaySnapshotTrace({
				roomCode: 'SYNTHETIC',
				guardianNames: fixture.guardianNames,
				catalog: CATALOG,
				sourceSeed: SOURCE_SEED + 1,
				events: fixture.events
			})
		).toThrow(/does not match/);

		const tampered = structuredClone(fixture.events);
		const firstCommand = tampered[0];
		if (firstCommand.kind !== 'command') throw new Error('expected command event');
		firstCommand.command = { type: 'claimSeat', seatColor: 'Blue' };
		expect(() =>
			replaySnapshotTrace({
				roomCode: 'SYNTHETIC',
				guardianNames: fixture.guardianNames,
				catalog: CATALOG,
				sourceSeed: SOURCE_SEED,
				events: tampered
			})
		).toThrow(/hash mismatch/);

		const drifted = [...fixture.events, deadlineTraceEvent(fixture.state)];
		const deadline = drifted.at(-1)!;
		if (deadline.kind !== 'deadlineAdvance') throw new Error('expected deadline event');
		deadline.expectedBefore.revision += 1;
		expect(() =>
			replaySnapshotTrace({
				roomCode: 'SYNTHETIC',
				guardianNames: fixture.guardianNames,
				catalog: CATALOG,
				sourceSeed: SOURCE_SEED,
				events: drifted
			})
		).toThrow(/expected/);
	});
});

describe('structural public-state projection', () => {
	it('excludes provenance, clocks, RNG, bag order, transient ids, and opponent secrets', () => {
		const { state } = startedFixture(2);
		const commands = legalActionsWithNext(state, 'Red', CATALOG).map((action) => action.cmd);
		const baseline = structuralPublicStateHash(state, 'Red', commands);
		const changed = structuredClone(state);
		changed.roomCode = 'OTHER';
		changed.revision += 100;
		changed.gameId = 'other-game-id';
		changed.rng.seed += 1;
		changed.rng.cursor += 10;
		changed.navigationDeadline = 123_456;
		changed.navigationFullDeadline = 234_567;
		changed.phaseDeadline = 345_678;
		changed.seats.Red.memberId = 'other-member';
		changed.seats.Red.displayName = 'Other Display';
		changed.bags.hexSpirits.contents.reverse();
		for (const entry of changed.bags.hexSpirits.contents) entry.guid = `other-${entry.guid}`;
		if (changed.players.Blue?.handDraws[0]) {
			changed.players.Blue.handDraws[0].id = 'opponent-secret-other-spirit';
			changed.players.Blue.handDraws[0].guid = 'opponent-secret-guid';
		}
		changed.players.Blue!.pendingDestination = 'Arcane Abyss';
		expect(structuralPublicStateHash(changed, 'Red', commands)).toBe(baseline);
	});

	it('includes owner-visible choices, public engine state, overflow mats, and sorted legal hashes', () => {
		const { state } = startedFixture(2);
		const commands = legalActionsWithNext(state, 'Red', CATALOG).map((action) => action.cmd);
		const baseline = structuralPublicStateHash(state, 'Red', commands);

		const ownerChoice = structuredClone(state);
		ownerChoice.players.Red!.pendingDestination = 'Arcane Abyss';
		expect(structuralPublicStateHash(ownerChoice, 'Red', commands)).not.toBe(baseline);

		const publicVp = structuredClone(state);
		publicVp.players.Blue!.victoryPoints += 1;
		expect(structuralPublicStateHash(publicVp, 'Red', commands)).not.toBe(baseline);

		const overflow = structuredClone(state);
		overflow.players.Red!.mats = Array.from({ length: 5 }, (_, index) => ({
			slotIndex: index,
			hasRune: true,
			id: `synthetic-overflow-rune-${index}`,
			name: `Synthetic Overflow Rune ${index}`,
			type: 'rune'
		}));
		expect(structuralPublicStateHash(overflow, 'Red', commands)).not.toBe(baseline);
		const overflowProjection = structuralPublicState(overflow, 'Red', commands);
		expect(overflowProjection.players.Red.capacity.mats).toEqual({
			used: 5,
			carryLimit: 4,
			overflow: 1
		});

		expect(structuralPublicStateHash(state, 'Red', [...commands].reverse())).toBe(baseline);
		expect(
			structuralPublicStateHash(state, 'Red', [
				...commands,
				{ type: 'lockNavigation', destination: 'Arcane Abyss' }
			])
		).not.toBe(baseline);
	});

	it('contains only the explicit whitelist rather than raw identifiers or deadlines', () => {
		const { state } = startedFixture();
		const commands = legalActionsWithNext(state, 'Red', CATALOG).map((action) => action.cmd);
		const encoded = canonicalJson(structuralPublicState(state, 'Red', commands));
		expect(encoded).not.toContain('roomCode');
		expect(encoded).not.toContain('gameId');
		expect(encoded).not.toContain('memberId');
		expect(encoded).not.toContain('Deadline');
		expect(encoded).not.toContain('"rng"');
		expect(encoded).not.toContain('winnerSeat');
	});
});

describe('recovery diagnostics', () => {
	it('uses an explicit protocol threshold and exact completed-round VP deltas', () => {
		const { state } = startedFixture();
		state.round = 16;
		const player = state.players.Red!;
		player.statusLevel = 2;
		player.initiative = 1;
		player.vpHistory = [5, 5, 5, 5];
		const diagnostics = recoveryDiagnostics(state, 'Red', WEAK_THRESHOLD);
		expect(diagnostics.statusRecovery).toBe(true);
		expect(diagnostics.weakEngine).toBe(true);
		expect(diagnostics.noPositiveVpInPriorThreeCompletedRounds).toBe(true);
		expect(diagnostics.observed.priorThreeCompletedVpDeltas).toEqual([0, 0, 0]);
		expect(diagnostics.recoveryEligible).toBe(true);

		const strict = recoveryDiagnostics(state, 'Red', {
			...WEAK_THRESHOLD,
			maxInitiative: 0
		});
		expect(strict.weakEngine).toBe(false);
	});

	it('rejects an implicit pre-round-16 weak-engine protocol', () => {
		const { state } = startedFixture();
		expect(() =>
			recoveryDiagnostics(state, 'Red', { ...WEAK_THRESHOLD, minRoundInclusive: 15 })
		).toThrow(/at least 16/);
	});
});

describe('policy-safe candidates and deterministic closure', () => {
	it('hashes only policy-safe candidate state, never a realized authoritative next state', () => {
		const { state } = startedFixture();
		const action = legalActionsWithNext(state, 'Red', CATALOG)[0];
		const candidate: PolicySafeCandidateV1 = {
			cmd: action.cmd,
			policyNext: action.policyNext,
			hasHiddenOutcome: action.hasHiddenOutcome
		};
		const baseline = semanticCandidateHash(state, 'Red', candidate, CATALOG);
		const realizedOnly = structuredClone(action.next);
		realizedOnly.players.Red!.victoryPoints += 99;
		const actionWithDifferentRealization: LegalAction = { ...action, next: realizedOnly };
		const stillSafe: PolicySafeCandidateV1 = {
			cmd: actionWithDifferentRealization.cmd,
			policyNext: actionWithDifferentRealization.policyNext,
			hasHiddenOutcome: actionWithDifferentRealization.hasHiddenOutcome
		};
		expect(semanticCandidateHash(state, 'Red', stillSafe, CATALOG)).toBe(baseline);

		const changedPreview = structuredClone(candidate.policyNext);
		changedPreview.players.Red!.victoryPoints += 1;
		expect(
			semanticCandidateHash(state, 'Red', { ...candidate, policyNext: changedPreview }, CATALOG)
		).not.toBe(baseline);
	});

	it('commits deterministic singletons and stops before a stochastic singleton', () => {
		const { state } = startedFixture();
		const firstRevision = state.revision;
		const provider = (working: PublicGameState, _seat: SeatColor): LegalAction[] => {
			if (working.revision === firstRevision) {
				const next = structuredClone(working);
				next.revision += 1;
				return [
					{
						cmd: { type: 'unlockNavigation' },
						next,
						policyNext: next,
						hasHiddenOutcome: false
					}
				];
			}
			const realized = structuredClone(working);
			realized.players.Red!.victoryPoints += 99;
			const preview = structuredClone(working);
			return [
				{
					cmd: { type: 'lockNavigation', destination: 'Arcane Abyss' },
					next: realized,
					policyNext: preview,
					hasHiddenOutcome: true
				}
			];
		};

		const closed = closeDeterministicSingletons(state, 'Red', CATALOG, {
			actionProvider: provider
		});
		expect(closed.stopReason).toBe('stochasticSingleton');
		expect(closed.forcedCommands).toEqual([{ type: 'unlockNavigation' }]);
		expect(closed.state.revision).toBe(firstRevision + 1);
		expect(closed.state.players.Red!.victoryPoints).toBe(state.players.Red!.victoryPoints);
		expect(closed.candidates).toHaveLength(1);
		expect(closed.candidates[0]).not.toHaveProperty('next');
		expect(closed.candidates[0].policyNext.players.Red!.victoryPoints).toBe(
			state.players.Red!.victoryPoints
		);
	});
});

describe('feature-shard safety and sampling seeds', () => {
	it('allows provenance and model diagnostics but rejects target/outcome/future fields', () => {
		const safe = {
			sourceSeed: SOURCE_SEED,
			botSamplingSeed: 123,
			reach30Probability: 0.4,
			command: { targetSeat: 'Blue' },
			nested: [{ currentReward: 2 }]
		};
		expect(forbiddenFeaturePaths(safe)).toEqual([]);
		expect(() => assertFeatureShardSafe(safe)).not.toThrow();
		const unsafe = {
			row: { finalVP: 30 },
			candidates: [{ outcome: 'win' }],
			future: { bagOrder: ['hidden'] }
		};
		expect(forbiddenFeaturePaths(unsafe)).toEqual([
			'$.candidates[0].outcome',
			'$.future.bagOrder',
			'$.row.finalVP'
		]);
		expect(() => assertFeatureShardSafe(unsafe)).toThrow(/forbidden keys/);
		expect(() => assertFeatureShardSafe({ customLeak: 1 }, ['customLeak'])).toThrow(/\.customLeak/);
	});

	it('derives independent, deterministic, domain-separated bot sampling seeds', () => {
		const first = botSamplingSeed(SOURCE_SEED, 3, 'Red');
		expect(botSamplingSeed(SOURCE_SEED, 3, 'Red')).toBe(first);
		expect(botSamplingSeed(SOURCE_SEED, 4, 'Red')).not.toBe(first);
		expect(botSamplingSeed(SOURCE_SEED, 3, 'Blue')).not.toBe(first);
		expect(botSamplingSeed(SOURCE_SEED, 3, 'Red', 1)).not.toBe(first);
		expect(first).not.toBe(SOURCE_SEED);
	});
});

describe('outcome-blind snapshot row', () => {
	it('combines visible state, v1/v2 observations, semantic candidates, and diagnostics', () => {
		const { state, events } = startedFixture(2);
		const actions = legalActionsWithNext(state, 'Red', CATALOG);
		const probabilities = actions.map(() => 1 / actions.length);
		const row = buildOutcomeBlindSnapshot({
			sourceSeed: SOURCE_SEED,
			decisionOrdinal: 0,
			seat: 'Red',
			state,
			catalog: CATALOG,
			trace: events,
			weakEngineThreshold: WEAK_THRESHOLD,
			legalActions: actions,
			modelDiagnostics: {
				rawLogits: actions.map((_, index) => index / 10),
				probabilities,
				reach30Probability: 0.25,
				recoveryProbability: 0.5
			}
		});

		expect(row.round).toBe(1);
		expect(row.traceHash).toBe(sha256Canonical(events));
		expect(row.publicStateHash).toBe(sha256Canonical(row.currentVisibleState));
		expect(row.obsV1.length).toBeGreaterThan(0);
		expect(row.obsV2.length).toBeGreaterThan(row.obsV1.length);
		expect(row.candidates).toHaveLength(actions.length);
		expect(row.eligibleStrategicChoice).toBe(true);
		expect(row.semanticallyDistinctCandidates).toBeGreaterThanOrEqual(2);
		expect(forbiddenFeaturePaths(row)).toEqual([]);
		expect(() => assertFeatureShardSafe(row)).not.toThrow();
		expect(canonicalJson(row)).not.toContain('authoritativeNextState');
	});

	it('is invariant to changes that exist only in LegalAction.next', () => {
		const { state, events } = startedFixture();
		const actions = legalActionsWithNext(state, 'Red', CATALOG);
		const changed = actions.map((action, index) => {
			const next = structuredClone(action.next);
			next.players.Red!.victoryPoints += 50 + index;
			return { ...action, next };
		});
		const baseInput = {
			sourceSeed: SOURCE_SEED,
			decisionOrdinal: 1,
			seat: 'Red' as const,
			state,
			catalog: CATALOG,
			trace: events,
			weakEngineThreshold: WEAK_THRESHOLD
		};
		const baseline = buildOutcomeBlindSnapshot({ ...baseInput, legalActions: actions });
		const altered = buildOutcomeBlindSnapshot({ ...baseInput, legalActions: changed });
		expect(canonicalJson(altered)).toBe(canonicalJson(baseline));
	});

	it('fails when model diagnostics do not align with the legal set', () => {
		const { state, events } = startedFixture();
		const actions = legalActionsWithNext(state, 'Red', CATALOG);
		expect(() =>
			buildOutcomeBlindSnapshot({
				sourceSeed: SOURCE_SEED,
				decisionOrdinal: 0,
				seat: 'Red',
				state,
				catalog: CATALOG,
				trace: events,
				weakEngineThreshold: WEAK_THRESHOLD,
				legalActions: actions,
				modelDiagnostics: {
					rawLogits: [],
					probabilities: [],
					reach30Probability: 0,
					recoveryProbability: 0
				}
			})
		).toThrow(/candidate count/);
	});
});
