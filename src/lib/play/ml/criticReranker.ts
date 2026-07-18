/**
 * V34 latency-bounded strategic reranking.
 *
 * The acting policy supplies its normal root logits. Candidate public preview
 * states are then evaluated by the calibrated round-30 critic in ONE batched
 * call. Combining within-root ranks avoids pretending policy logits and critic
 * probabilities share a calibrated numerical scale.
 */
import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import { encodeAction, encodeObs } from './encode';
import { policyPreviewState, type LegalAction } from './actions';
import type { NeuralPolicy } from './net';
import type { SearchObservationEncoder } from './gumbelPlanner';

export interface CriticRerankOptions {
	/** Weight on policy rank; 1 is the registered deterministic argmax control. */
	policyRankWeight: number;
	/** Observation schema used by both root logits and candidate critic states. */
	encodeObservation?: SearchObservationEncoder;
}

export interface CriticRerankResult {
	index: number;
	/** Deterministic one-hot improved policy, in original candidate order. */
	pi: number[];
	policyRanks: number[];
	criticRanks: number[];
	combinedScores: number[];
	/** Null only for the weight-1 argmax control, which skips the critic request. */
	criticProbabilities: Array<number | null>;
}

/** Ascending [0,1] ranks with exact ties assigned their average position. */
export function normalizedRanks(values: readonly number[]): number[] {
	if (values.length === 0) return [];
	if (values.some((value) => !Number.isFinite(value))) {
		throw new Error('critic reranker received a non-finite score');
	}
	if (values.length === 1) return [1];
	const order = values
		.map((value, index) => ({ value, index }))
		.sort((left, right) => {
			const byValue = left.value - right.value;
			return byValue || left.index - right.index;
		});
	const ranks = new Array<number>(values.length);
	for (let start = 0; start < order.length; ) {
		let end = start + 1;
		while (end < order.length && order[end].value === order[start].value) end += 1;
		const averagePosition = (start + end - 1) / 2;
		const rank = averagePosition / (values.length - 1);
		for (let position = start; position < end; position += 1) {
			ranks[order[position].index] = rank;
		}
		start = end;
	}
	return ranks;
}

function observationFor(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	encoder?: SearchObservationEncoder
): number[] {
	return encoder ? encoder(state, seat, catalog) : encodeObs(state, seat, catalog);
}

export function planDecisionCriticRerank(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	withNext: LegalAction[],
	opts: CriticRerankOptions
): CriticRerankResult | null {
	if (withNext.length < 2) return null;
	if (Object.keys(state.players).length !== 1) {
		throw new Error('critic reranker requires exactly one player');
	}
	const policyWeight = opts.policyRankWeight;
	if (!Number.isFinite(policyWeight) || policyWeight < 0 || policyWeight > 1) {
		throw new Error('critic reranker policyRankWeight must be in [0,1]');
	}

	const rootObs = observationFor(state, seat, catalog, opts.encodeObservation);
	const actionFeatures = withNext.map((action) =>
		encodeAction(state, seat, action.cmd, policyPreviewState(action), catalog)
	);
	const policyScores = policy.scoreCandidates(rootObs, actionFeatures);
	if (policyScores.length !== withNext.length) {
		throw new Error(
			`critic reranker received ${policyScores.length} root logits for ${withNext.length} candidates`
		);
	}
	const policyRanks = normalizedRanks(policyScores);

	let criticProbabilities: Array<number | null> = withNext.map(() => null);
	let criticRanks = withNext.map(() => 0);
	if (policyWeight < 1) {
		if (policy.reach30Horizon() !== 30) {
			throw new Error(
				`critic reranker requires a reach30 critic with horizon 30; got ${String(policy.reach30Horizon())}`
			);
		}
		const previews = withNext.map(policyPreviewState);
		const unresolvedIndices: number[] = [];
		const unresolvedObs: number[][] = [];
		for (let index = 0; index < previews.length; index += 1) {
			const preview = previews[index];
			const player = preview.players[seat];
			if (!player) {
				criticProbabilities[index] = 0;
			} else if (player.victoryPoints >= 30) {
				criticProbabilities[index] = 1;
			} else if (preview.status !== 'active') {
				criticProbabilities[index] = 0;
			} else {
				unresolvedIndices.push(index);
				unresolvedObs.push(observationFor(preview, seat, catalog, opts.encodeObservation));
			}
		}
		if (unresolvedObs.length > 0) {
			const probabilities = policy.reach30Probabilities(unresolvedObs);
			if (probabilities.length !== unresolvedObs.length) {
				throw new Error('critic reranker received the wrong number of batched critic outputs');
			}
			for (let row = 0; row < probabilities.length; row += 1) {
				const probability = probabilities[row];
				if (
					probability === null ||
					!Number.isFinite(probability) ||
					probability < 0 ||
					probability > 1
				) {
					throw new Error('critic reranker requires finite reach30 probabilities in [0,1]');
				}
				criticProbabilities[unresolvedIndices[row]] = probability;
			}
		}
		criticRanks = normalizedRanks(
			criticProbabilities.map((probability) => {
				if (probability === null) throw new Error('critic reranker left a candidate unevaluated');
				return probability;
			})
		);
	}

	const combinedScores = policyRanks.map(
		(policyRank, index) => policyWeight * policyRank + (1 - policyWeight) * criticRanks[index]
	);
	let index = 0;
	for (let candidate = 1; candidate < combinedScores.length; candidate += 1) {
		if (combinedScores[candidate] > combinedScores[index]) index = candidate;
	}
	const pi = combinedScores.map((_, candidate) => (candidate === index ? 1 : 0));
	return {
		index,
		pi,
		policyRanks,
		criticRanks,
		combinedScores,
		criticProbabilities
	};
}
