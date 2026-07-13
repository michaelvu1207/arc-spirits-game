/**
 * Compare a verified live solo trajectory with a frozen bot on the same environment seed,
 * guardian, catalog, and 30-round objective. This is diagnostic-only: the human commands are
 * never emitted as training data, preventing the held-out reference game from leaking into PPO.
 *
 * Usage:
 *   ARC_REPLAY_ROOM=7RPYHU npx tsx ml/diagnose_human_trajectory.ts \
 *     ml/human_reference/7RPYHU/events.json \
 *     ml/human_reference/7RPYHU/snapshot.json \
 *     ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
 *     ml/catalogs/live-20260713-5f4ad348.json \
 *     ml/human_reference/7RPYHU/v23-diagnostic.json
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../src/lib/play/runtime';
import { profileFor } from '../src/lib/play/server/botPolicy';
import type {
	GameActor,
	GameCommand,
	PlayCatalog,
	PublicGameState,
	SeatColor
} from '../src/lib/play/types';
import {
	commandMatches,
	legalActionsWithNext,
	policyPreviewState,
	type LegalAction
} from '../src/lib/play/ml/actions';
import { playRecordingGame } from '../src/lib/play/ml/driver';
import { encodeAction, encodeObs } from '../src/lib/play/ml/encode';
import { hybridIndex, selectableCandidateIndices } from '../src/lib/play/ml/neuralBot';
import type { NeuralPolicy } from '../src/lib/play/ml/net';
import { loadPolicyForEval } from '../src/lib/play/ml/nodeIo';
import { canonicalCommandSignature } from '../src/lib/play/ml/terminalTeacher';

interface EventRow {
	revision: number;
	actor_member_id: string;
	command_type: string;
	command_payload: GameCommand;
	created_at?: string;
}

interface DecisionTrace {
	source: 'human' | 'bot';
	ordinal: number;
	revision?: number;
	round: number;
	phase: PublicGameState['phase'];
	vp: number;
	statusLevel: number;
	barrier: number;
	maxBarrier: number;
	attackDice: Record<string, number>;
	spirits: number;
	monsterHp: number | null;
	monsterRung: number | null;
	legalCount: number;
	supportCount: number;
	chosenIndex: number;
	chosenType: GameCommand['type'];
	chosenSignature: string;
	chosenInSupport: boolean;
	policyRank: number | null;
	policyProbability: number | null;
	policyTopType: GameCommand['type'] | null;
	policyTopSignature: string | null;
	policyTopAgreement: boolean;
	productionType: GameCommand['type'];
	productionSignature: string;
	productionAgreement: boolean;
	value: number;
	reach30Probability: number | null;
	reach30Horizon: number | null;
}

const SETUP_TYPES = new Set(['claimSeat', 'selectGuardian', 'startGame']);
const DEADLINE_TYPES = new Set(['enforceDeadline', 'forceAdvancePhase']);

function sha256File(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function f32(values: number[]): number[] {
	return Array.from(Float32Array.from(values));
}

function f32Policy(policy: NeuralPolicy): NeuralPolicy {
	if (policy.optionDim !== 0) {
		throw new Error('diagnostic requires a stripped option_dim=0 checkpoint');
	}
	const f32Matrix = (values: number[][]): number[][] => values.map(f32);
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number => target.pick(f32(obs), f32Matrix(cands), opts);
			}
			if (prop === 'scoreCandidates') {
				return (obs: number[], cands: number[][]): number[] =>
					target.scoreCandidates(f32(obs), f32Matrix(cands));
			}
			if (prop === 'value') return (obs: number[]): number => target.value(f32(obs));
			if (prop === 'reach30Probability') {
				return (obs: number[]): number | null => target.reach30Probability(f32(obs));
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

function seatMap(events: readonly EventRow[]): Map<string, SeatColor> {
	const seats = new Map<string, SeatColor>();
	for (const row of events) {
		if (row.command_type !== 'claimSeat') continue;
		seats.set(row.actor_member_id, (row.command_payload as { seatColor: SeatColor }).seatColor);
	}
	return seats;
}

function actorFor(memberId: string, seat: SeatColor | null, hostMemberId: string): GameActor {
	return {
		memberId,
		displayName: memberId.slice(0, 8),
		role: memberId === hostMemberId ? 'host' : 'player',
		seatColor: seat
	};
}

/** Live UI commands preserve harmless empty arrays and some descriptive identifiers that the
 * bounded ML enumerator omits. Prefer exact semantic JSON, then the shared salient-field matcher. */
function normalizedCommandSignature(command: GameCommand): string {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			const items = value.map(strip);
			return items.length === 0 ? undefined : items;
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.map(([key, nested]) => [key, strip(nested)] as const)
					.filter(([, nested]) => nested !== undefined)
					.sort(([a], [b]) => a.localeCompare(b))
			);
		}
		return value;
	};
	return JSON.stringify(strip(command));
}

function matchingCandidateIndex(withNext: readonly LegalAction[], command: GameCommand): number {
	const normalized = normalizedCommandSignature(command);
	const exact = withNext.findIndex(
		(action) => normalizedCommandSignature(action.cmd) === normalized
	);
	if (exact >= 0) return exact;
	if (command.type === 'resolveAwakenReward') {
		const sorted = (values: readonly number[] | undefined): string =>
			JSON.stringify([...(values ?? [])].sort((a, b) => a - b));
		return withNext.findIndex((action) => {
			if (action.cmd.type !== 'resolveAwakenReward') return false;
			return (
				sorted(action.cmd.relicPicks) === sorted(command.relicPicks) &&
				(action.cmd.taintedMaxBarrier ?? 0) === (command.taintedMaxBarrier ?? 0)
			);
		});
	}
	// Reward picks carry their entire strategic meaning; never collapse distinct rewards to
	// commandMatches' historical type-only fallback.
	if (command.type === 'resolveMonsterReward') return -1;
	return withNext.findIndex((action) => commandMatches(action.cmd, command));
}

function softmaxOnSupport(logits: readonly number[], support: readonly number[]): Map<number, number> {
	const out = new Map<number, number>();
	if (support.length === 0) return out;
	const max = Math.max(...support.map((index) => logits[index]));
	const exps = support.map((index) => Math.exp(logits[index] - max));
	const sum = exps.reduce((a, b) => a + b, 0);
	for (let i = 0; i < support.length; i += 1) out.set(support[i], exps[i] / sum);
	return out;
}

function diceCounts(state: PublicGameState, seat: SeatColor): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const die of state.players[seat]?.attackDice ?? []) counts[die.tier] = (counts[die.tier] ?? 0) + 1;
	return counts;
}

function traceDecision(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	chosenIndex: number,
	catalog: PlayCatalog,
	source: DecisionTrace['source'],
	ordinal: number,
	revision?: number
): DecisionTrace {
	if (chosenIndex < 0 || chosenIndex >= withNext.length) {
		throw new Error(`invalid chosen index ${chosenIndex}/${withNext.length}`);
	}
	const obs = f32(encodeObs(state, seat, catalog));
	const features = withNext.map((action) =>
		f32(encodeAction(state, seat, action.cmd, policyPreviewState(action), catalog))
	);
	const logits = policy.scoreCandidates(obs, features);
	const support = selectableCandidateIndices(state, seat, withNext);
	const probabilities = softmaxOnSupport(logits, support);
	const ranked = [...support].sort((a, b) => logits[b] - logits[a] || a - b);
	const top = ranked[0] ?? null;
	const productionIndex = hybridIndex(policy, state, seat, withNext, { sample: false }, catalog);
	const chosen = withNext[chosenIndex].cmd;
	const production = withNext[productionIndex].cmd;
	const player = state.players[seat]!;
	return {
		source,
		ordinal,
		...(revision === undefined ? {} : { revision }),
		round: state.round,
		phase: state.phase,
		vp: player.victoryPoints ?? 0,
		statusLevel: player.statusLevel ?? 0,
		barrier: player.barrier ?? 0,
		maxBarrier: player.maxBarrier ?? 0,
		attackDice: diceCounts(state, seat),
		spirits: player.spirits?.length ?? 0,
		monsterHp: state.monster?.hp ?? null,
		monsterRung: state.monster?.ladderIndex ?? null,
		legalCount: withNext.length,
		supportCount: support.length,
		chosenIndex,
		chosenType: chosen.type,
		chosenSignature: canonicalCommandSignature(chosen),
		chosenInSupport: support.includes(chosenIndex),
		policyRank: support.includes(chosenIndex) ? ranked.indexOf(chosenIndex) + 1 : null,
		policyProbability: probabilities.get(chosenIndex) ?? null,
		policyTopType: top === null ? null : withNext[top].cmd.type,
		policyTopSignature: top === null ? null : canonicalCommandSignature(withNext[top].cmd),
		policyTopAgreement: top === chosenIndex,
		productionType: production.type,
		productionSignature: canonicalCommandSignature(production),
		productionAgreement: productionIndex === chosenIndex,
		value: policy.value(obs),
		reach30Probability: policy.reach30Probability(obs),
		reach30Horizon: policy.reach30Horizon()
	};
}

function compactBuild(state: PublicGameState, seat: SeatColor): Record<string, unknown> {
	const player = state.players[seat]!;
	return {
		vp: player.victoryPoints ?? 0,
		round: state.round,
		phase: state.phase,
		reached30: (player.victoryPoints ?? 0) >= 30,
		engineWinner: state.winnerSeat === seat,
		statusLevel: player.statusLevel ?? 0,
		corruptions: player.corruptionCount ?? 0,
		barrier: player.barrier ?? 0,
		maxBarrier: player.maxBarrier ?? 0,
		attackDice: diceCounts(state, seat),
		spirits: (player.spirits ?? []).map((spirit) => ({
			name: spirit.name,
			faceDown: spirit.isFaceDown,
			classes: spirit.classes,
			origins: spirit.origins
		}))
	};
}

function outcomeSummary(traces: readonly DecisionTrace[], target: 0 | 1): Record<string, unknown> {
	const finiteRanks = traces.flatMap((trace) => (trace.policyRank === null ? [] : [trace.policyRank]));
	const p30 = traces.flatMap((trace) =>
		trace.reach30Probability === null ? [] : [trace.reach30Probability]
	);
	const mean = (values: readonly number[]): number | null =>
		values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
	const byRoundBand: Record<string, Record<string, number>> = {};
	for (const trace of traces) {
		const band = trace.round <= 5 ? '01-05' : trace.round <= 10 ? '06-10' : trace.round <= 20 ? '11-20' : '21-30';
		const row = (byRoundBand[band] ??= {
			decisions: 0,
			productionAgreements: 0,
			policyTopAgreements: 0,
			p30Sum: 0,
			p30Count: 0
		});
		row.decisions += 1;
		if (trace.productionAgreement) row.productionAgreements += 1;
		if (trace.policyTopAgreement) row.policyTopAgreements += 1;
		if (trace.reach30Probability !== null) {
			row.p30Sum += trace.reach30Probability;
			row.p30Count += 1;
		}
	}
	return {
		ambiguousDecisions: traces.length,
		productionAgreementRate: mean(traces.map((trace) => (trace.productionAgreement ? 1 : 0))),
		policyTopAgreementRate: mean(traces.map((trace) => (trace.policyTopAgreement ? 1 : 0))),
		meanPolicyRank: mean(finiteRanks),
		meanReach30Probability: mean(p30),
		reach30Brier: mean(p30.map((probability) => (probability - target) ** 2)),
		byRoundBand
	};
}

function replayHuman(
	events: EventRow[],
	snapshot: PublicGameState,
	policy: NeuralPolicy,
	catalog: PlayCatalog,
	roomCode: string
): {
	state: PublicGameState;
	seat: SeatColor;
	guardian: string;
	traces: DecisionTrace[];
	forcedDecisions: number;
	unmatched: { revision: number; type: string; round: number; phase: string; legalCount: number }[];
} {
	const seats = seatMap(events);
	const hostMemberId = events[0]?.actor_member_id;
	if (!hostMemberId) throw new Error('event stream is empty');
	const seat = seats.get(hostMemberId);
	if (!seat) throw new Error('host never claimed a seat');
	let state = createLobbyState({ roomCode, guardianNames: catalog.guardians.map((row) => row.name) });
	const traces: DecisionTrace[] = [];
	const unmatched: {
		revision: number;
		type: string;
		round: number;
		phase: string;
		legalCount: number;
		legalTypes: string[];
		sameTypeExamples: string[];
	}[] = [];
	let forcedDecisions = 0;
	for (const row of events) {
		if (DEADLINE_TYPES.has(row.command_type)) {
			applyDeadlineAdvance(state, catalog);
			continue;
		}
		const rowSeat = seats.get(row.actor_member_id) ?? null;
		if (!SETUP_TYPES.has(row.command_type) && rowSeat === seat) {
			const withNext = legalActionsWithNext(state, seat, catalog);
			const chosenIndex = matchingCandidateIndex(withNext, row.command_payload);
			if (chosenIndex < 0) {
				unmatched.push({
					revision: row.revision,
					type: row.command_type,
					round: state.round,
					phase: state.phase,
					legalCount: withNext.length,
					legalTypes: [...new Set(withNext.map((action) => action.cmd.type))],
					sameTypeExamples: withNext
						.filter((action) => action.cmd.type === row.command_payload.type)
						.slice(0, 8)
						.map((action) => canonicalCommandSignature(action.cmd))
				});
			} else if (withNext.length > 1) {
				traces.push(
					traceDecision(
						policy,
						state,
						seat,
						withNext,
						chosenIndex,
						catalog,
						'human',
						traces.length,
						row.revision
					)
				);
			} else {
				forcedDecisions += 1;
			}
		}
		const actorSeat = row.command_type === 'claimSeat' ? null : rowSeat;
		const result = applyGameCommand(
			state,
			actorFor(row.actor_member_id, actorSeat, hostMemberId),
			row.command_payload,
			catalog
		);
		if (!result.ok) {
			throw new Error(`human replay rejected revision ${row.revision}: ${result.error.code}`);
		}
		state = result.state;
	}
	const exact =
		state.rng.seed === snapshot.rng.seed &&
		state.rng.cursor === snapshot.rng.cursor &&
		state.round === snapshot.round &&
		state.phase === snapshot.phase &&
		state.winnerSeat === snapshot.winnerSeat &&
		state.players[seat]?.victoryPoints === snapshot.players[seat]?.victoryPoints;
	if (!exact) throw new Error('human replay did not reproduce the authoritative snapshot');
	return {
		state,
		seat,
		guardian: state.players[seat]!.selectedGuardian,
		traces,
		forcedDecisions,
		unmatched
	};
}

function main(): void {
	const [eventsArg, snapshotArg, weightsArg, catalogArg, outArg] = process.argv.slice(2);
	if (!eventsArg || !snapshotArg || !weightsArg || !catalogArg || !outArg) {
		throw new Error(
			'usage: npx tsx ml/diagnose_human_trajectory.ts <events> <snapshot> <weights> <catalog> <out>'
		);
	}
	const eventsPath = resolve(eventsArg);
	const snapshotPath = resolve(snapshotArg);
	const weightsPath = resolve(weightsArg);
	const catalogPath = resolve(catalogArg);
	const outPath = resolve(outArg);
	const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as EventRow[];
	const snapshotRaw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
		state?: PublicGameState;
	};
	const snapshot = snapshotRaw.state ?? (snapshotRaw as unknown as PublicGameState);
	const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as PlayCatalog;
	const policy = f32Policy(loadPolicyForEval(weightsPath));
	const roomCode = process.env.ARC_REPLAY_ROOM;
	if (!roomCode) throw new Error('ARC_REPLAY_ROOM is required for exact engine-seed replay');

	const human = replayHuman(events, snapshot, policy, catalog, roomCode);
	const botTraces: DecisionTrace[] = [];
	const botResult = playRecordingGame(catalog, {
		seed: snapshot.rng.seed,
		profiles: [profileFor('medium')],
		maxRounds: 30,
		policy,
		neuralSeats: [human.seat],
		recordSeats: [human.seat],
		selection: 'hybrid',
		sample: false,
		guardianNames: [human.guardian],
		chooser: (_obs, _features, _commands, seat, state, withNext) => {
			const chosenIndex = hybridIndex(policy, state, seat, withNext, { sample: false }, catalog);
			if (withNext.length > 1) {
				botTraces.push(
					traceDecision(
						policy,
						state,
						seat,
						withNext,
						chosenIndex,
						catalog,
						'bot',
						botTraces.length
					)
				);
			}
			return chosenIndex;
		}
	});
	if (botResult.stalled) throw new Error('matched bot trajectory stalled');
	if (!botResult.finalState) throw new Error('matched bot trajectory omitted final state');

	const report = {
		schemaVersion: 'arc-human-bot-trajectory-diagnostic-v1',
		createdAt: new Date().toISOString(),
		diagnosticOnly: true,
		trainingUseProhibited: true,
		provenance: {
			roomCode,
			eventsSha256: sha256File(eventsPath),
			snapshotSha256: sha256File(snapshotPath),
			weightsSha256: sha256File(weightsPath),
			catalogSha256: sha256File(catalogPath),
			engineSeed: snapshot.rng.seed,
			guardian: human.guardian,
			objectiveHorizon: 30
		},
		human: {
			exactReplay: true,
			forcedDecisions: human.forcedDecisions,
			unmatched: human.unmatched,
			final: compactBuild(human.state, human.seat),
			summary: outcomeSummary(human.traces, 1),
			traces: human.traces
		},
		bot: {
			stalled: botResult.stalled,
			finished: botResult.finished,
			cycle: botResult.cycleBySeat[human.seat],
			final: compactBuild(botResult.finalState, human.seat),
			summary: outcomeSummary(botTraces, botResult.finalVP[human.seat] >= 30 ? 1 : 0),
			traces: botTraces
		}
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify({
			out: outPath,
			humanVP: human.state.players[human.seat]?.victoryPoints,
			humanRound: human.state.round,
			humanAmbiguous: human.traces.length,
			humanUnmatched: human.unmatched.length,
			botVP: botResult.finalVP[human.seat],
			botRound: botResult.rounds,
			botAmbiguous: botTraces.length,
			botStalled: botResult.stalled
		})
	);
}

main();
