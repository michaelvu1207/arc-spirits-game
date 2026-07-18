/**
 * V34 latency-bounded stochastic planner.
 *
 * It performs one root-policy request, advances every simulation with the
 * engine heuristic (never the neural policy), and scores every unresolved
 * leaf in one reach-30 batch. This is deliberately a fixed-allocation root
 * search: sequential halving would make later simulation allocation depend on
 * serial critic results and recreate V33's serving bottleneck.
 */
import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import { createRng, nextInt } from '../rng';
import { profileFor, type BotRandom } from '../server/botPolicy';
import { legalActionsWithNext, policyPreviewState, type LegalAction } from './actions';
import { combatActionExpectation, encodeAction, encodeObs } from './encode';
import {
	determinizeForSearch,
	rolloutPolicyToRound,
	type SearchObservationEncoder
} from './gumbelPlanner';
import type { NeuralPolicy } from './net';

export interface BatchedHeuristicPlanOptions {
	simulations: number;
	horizonRounds: number;
	valueWeight?: number;
	maxConsidered?: number;
	encodeObservation?: SearchObservationEncoder;
	seed: number;
	/** Registered V34 arms use zero; retained for deterministic replay tests. */
	temperature?: number;
	rand?: () => number;
	cVisit?: number;
	cScale?: number;
}

export interface BatchedHeuristicPlanResult {
	index: number;
	pi: number[];
	q: number[];
	visits: number[];
	logits: number[];
}

interface Leaf {
	candidate: number;
	state: PublicGameState;
	expectedPublicRewardVp: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

function observationFor(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	encoder?: SearchObservationEncoder
): number[] {
	return encoder ? encoder(state, seat, catalog) : encodeObs(state, seat, catalog);
}

function softmax(values: readonly number[]): number[] {
	const max = Math.max(...values);
	const exps = values.map((value) => Math.exp(value - max));
	const total = exps.reduce((sum, value) => sum + value, 0) || 1;
	return exps.map((value) => value / total);
}

function sigmaQ(q: number, visits: readonly number[], cVisit: number, cScale: number): number {
	return (cVisit + Math.max(...visits)) * cScale * q;
}

export function planDecisionBatchedHeuristic(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	withNext: LegalAction[],
	opts: BatchedHeuristicPlanOptions
): BatchedHeuristicPlanResult | null {
	const candidateCount = withNext.length;
	if (candidateCount < 2) return null;
	if (Object.keys(state.players).length !== 1) {
		throw new Error('batched heuristic solo search requires exactly one player');
	}
	if (!Number.isInteger(opts.simulations) || opts.simulations < 2) {
		throw new Error('batched heuristic search simulations must be an integer at least 2');
	}
	if (!Number.isInteger(opts.horizonRounds) || opts.horizonRounds < 1) {
		throw new Error('batched heuristic search horizonRounds must be a positive integer');
	}
	if (policy.reach30Horizon() !== 30) {
		throw new Error(
			`batched heuristic search requires a reach30 critic with horizon 30; got ${String(policy.reach30Horizon())}`
		);
	}
	const valueWeight = clamp01(opts.valueWeight ?? 0.5);
	const cVisit = opts.cVisit ?? 50;
	const cScale = opts.cScale ?? 1;
	const baseSeed = opts.seed >>> 0 || 1;
	const rootObs = observationFor(state, seat, catalog, opts.encodeObservation);
	const actionFeatures = withNext.map((action) =>
		encodeAction(state, seat, action.cmd, policyPreviewState(action), catalog)
	);
	const logits = policy.scoreCandidates(rootObs, actionFeatures);
	if (logits.length !== candidateCount || logits.some((value) => !Number.isFinite(value))) {
		throw new Error('batched heuristic search received invalid root policy logits');
	}

	const noiseRng = createRng((baseSeed ^ 0x9e3779b9) >>> 0 || 1);
	const uniform = (): number => (nextInt(noiseRng, 1_073_741_824) + 0.5) / 1_073_741_824;
	const gumbel = withNext.map(() => -Math.log(-Math.log(uniform())));
	const considered = Math.min(
		candidateCount,
		opts.simulations,
		Math.max(2, opts.maxConsidered ?? 8)
	);
	const order = withNext
		.map((_, index) => index)
		.sort(
			(left, right) => gumbel[right] + logits[right] - (gumbel[left] + logits[left]) || left - right
		)
		.slice(0, considered);

	const leaves: Leaf[] = [];
	const allocationCount = new Array<number>(candidateCount).fill(0);
	for (let simulation = 0; simulation < opts.simulations; simulation += 1) {
		const candidate = order[simulation % order.length];
		const action = withNext[candidate];
		allocationCount[candidate] += 1;
		if (action.hasHiddenOutcome) {
			leaves.push({
				candidate,
				state: policyPreviewState(action),
				expectedPublicRewardVp:
					action.cmd.type === 'startCombat'
						? combatActionExpectation(state, seat, catalog).expectedRewardVp
						: 0
			});
			continue;
		}
		const simulationOrdinal = allocationCount[candidate];
		const simulationSeed =
			(baseSeed + simulationOrdinal * 2654435761 + candidate * 40503) >>> 0 || 1;
		let rolloutState = determinizeForSearch(policyPreviewState(action), seat, simulationSeed);
		const botRng: BotRandom = {
			int: (max: number) => nextInt(rolloutState.rng, max),
			chance: () => nextInt(rolloutState.rng, 2) === 0
		};
		rolloutState = rolloutPolicyToRound(
			rolloutState,
			catalog,
			{ ...profileFor('medium'), ismctsIterations: 0, searchRollouts: 0 },
			botRng,
			state.round + opts.horizonRounds - 1
		);
		leaves.push({ candidate, state: rolloutState, expectedPublicRewardVp: 0 });
	}

	const unresolved: number[] = [];
	const unresolvedObservations: number[][] = [];
	const leafValues = new Array<number>(leaves.length);
	for (let index = 0; index < leaves.length; index += 1) {
		const leaf = leaves[index];
		const player = leaf.state.players[seat];
		if (!player || leaf.state.status !== 'active') {
			leafValues[index] = player && player.victoryPoints >= 30 ? 1 : 0;
		} else if (player.victoryPoints >= 30) {
			leafValues[index] = 1;
		} else {
			unresolved.push(index);
			unresolvedObservations.push(
				observationFor(leaf.state, seat, catalog, opts.encodeObservation)
			);
		}
	}
	if (unresolvedObservations.length > 0) {
		const probabilities = policy.reach30Probabilities(unresolvedObservations);
		if (probabilities.length !== unresolvedObservations.length) {
			throw new Error('batched heuristic search received the wrong number of critic outputs');
		}
		for (let row = 0; row < probabilities.length; row += 1) {
			const probability = probabilities[row];
			if (
				probability === null ||
				!Number.isFinite(probability) ||
				probability < 0 ||
				probability > 1
			) {
				throw new Error('batched heuristic search requires finite reach30 probabilities in [0,1]');
			}
			const leafIndex = unresolved[row];
			const leaf = leaves[leafIndex];
			const vp = leaf.state.players[seat]?.victoryPoints ?? 0;
			const rolloutValue = clamp01((vp + leaf.expectedPublicRewardVp) / 30);
			leafValues[leafIndex] = clamp01(valueWeight * probability + (1 - valueWeight) * rolloutValue);
		}
	}

	const visits = new Array<number>(candidateCount).fill(0);
	const qSum = new Array<number>(candidateCount).fill(0);
	for (let index = 0; index < leaves.length; index += 1) {
		const candidate = leaves[index].candidate;
		visits[candidate] += 1;
		qSum[candidate] += leafValues[index];
	}
	const q = visits.map((count, index) => (count > 0 ? qSum[index] / count : 0));
	const priors = softmax(logits);
	let visitedPrior = 0;
	let visitedValue = 0;
	for (let index = 0; index < candidateCount; index += 1) {
		if (visits[index] > 0) {
			visitedPrior += priors[index];
			visitedValue += priors[index] * q[index];
		}
	}
	const mixedValue = visitedPrior > 0 ? visitedValue / visitedPrior : 0.5;
	const completed = q.map((value, index) => (visits[index] > 0 ? value : mixedValue));
	const improved = logits.map(
		(logit, index) => logit + sigmaQ(completed[index], visits, cVisit, cScale)
	);
	const pi = softmax(improved);
	let index = order[0];
	for (const candidate of order.slice(1)) {
		const candidateScore =
			gumbel[candidate] + logits[candidate] + sigmaQ(q[candidate], visits, cVisit, cScale);
		const currentScore = gumbel[index] + logits[index] + sigmaQ(q[index], visits, cVisit, cScale);
		if (candidateScore > currentScore) index = candidate;
	}
	const temperature = opts.temperature ?? 0;
	if (temperature > 0) {
		const rand = opts.rand ?? uniform;
		const tempered = softmax(improved.map((value) => value / temperature));
		let draw = rand();
		index = candidateCount - 1;
		for (let candidate = 0; candidate < candidateCount; candidate += 1) {
			draw -= tempered[candidate];
			if (draw <= 0) {
				index = candidate;
				break;
			}
		}
	}
	return { index, pi, q, visits, logits };
}
