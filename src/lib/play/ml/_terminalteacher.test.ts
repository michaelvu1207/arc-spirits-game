/**
 * Opt-in V24 terminal-reward teacher generator and teacher-in-loop ceiling audit.
 *
 * Generate balanced natural states + JSONL labels:
 *   V24_TERMINAL_TEACHER=1 V24_TERMINAL_MODE=collect \
 *   V24_TERMINAL_SOURCE_COMMIT=17a237a \
 *   V24_TERMINAL_WEIGHTS=ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
 *   V24_TERMINAL_GAMES=2048 V24_TERMINAL_MAX_STATES=4096 \
 *   npx vitest run src/lib/play/ml/_terminalteacher.test.ts --disable-console-intercept
 *
 * Run the disjoint 512-state 16+16 validation audit:
 *   V24_TERMINAL_TEACHER=1 V24_TERMINAL_MODE=validate V24_TERMINAL_MAX_STATES=512 \
 *   npx vitest run src/lib/play/ml/_terminalteacher.test.ts --disable-console-intercept
 *
 * Run the paired full-game ceiling test:
 *   V24_TERMINAL_TEACHER=1 V24_TERMINAL_MODE=loop V24_TERMINAL_GAMES=512 \
 *   npx vitest run src/lib/play/ml/_terminalteacher.test.ts --disable-console-intercept
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import type { GameCommand, PublicGameState, SeatColor } from '../types';
import { hybridIndex } from './neuralBot';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import { playRecordingGame, type RecordGameResult } from './driver';
import type { NeuralPolicy } from './net';
import {
	canonicalCommandSignature,
	evaluateTerminalTeacher,
	isAmbiguousMonsterRewardDecision,
	sanitizeSoloTerminalState,
	terminalTeacherCollectorRow,
	rolloutTerminalCandidate,
	type TerminalTeacherCollectorRow,
	type TerminalTeacherLabel
} from './terminalTeacher';

const RUN = process.env.V24_TERMINAL_TEACHER === '1';
const MODE = process.env.V24_TERMINAL_MODE ?? 'collect';

interface CapturedState {
	stateId: string;
	seed: number;
	guardian: string;
	seat: SeatColor;
	round: number;
	vp: number;
	obs: number[];
	cands: number[][];
	commands: GameCommand[];
	historicalIndex: number;
	state: PublicGameState;
	sourceReached30: boolean;
}

function envInt(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0)
		throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function outputPath(suffix = ''): string {
	const configured = process.env.V24_TERMINAL_OUT;
	const base = configured
		? resolve(process.cwd(), configured)
		: mlPath('data', `terminal-teacher-${MODE}.jsonl`);
	return suffix ? `${base}${suffix}` : base;
}

function writeJsonl(file: string, rows: readonly unknown[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
	);
}

function sha256File(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function float32DecisionPolicy(policy: NeuralPolicy): NeuralPolicy {
	if (policy.optionDim !== 0) {
		throw new Error('terminalTeacher: harness requires a stripped option_dim=0 checkpoint');
	}
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number =>
					target.pick(
						Array.from(Float32Array.from(obs)),
						cands.map((cand) => Array.from(Float32Array.from(cand))),
						opts
					);
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

function roundBand(round: number): string {
	return round <= 10 ? '01-10' : round <= 20 ? '11-20' : '21-30';
}

function vpBand(vp: number): string {
	return vp < 10 ? '00-09' : vp < 20 ? '10-19' : '20-29';
}

/** Deterministic round-robin across the preregistered balance strata. */
function balancedReservoir(states: CapturedState[], maxStates: number): CapturedState[] {
	const buckets = new Map<string, CapturedState[]>();
	for (const state of states) {
		const key = [
			state.guardian,
			state.sourceReached30 ? 'win' : 'failure',
			roundBand(state.round),
			vpBand(state.vp)
		].join('|');
		const bucket = buckets.get(key) ?? [];
		bucket.push(state);
		buckets.set(key, bucket);
	}
	const ordered = [...buckets.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, rows]) => rows.sort((a, b) => a.stateId.localeCompare(b.stateId)));
	const selected: CapturedState[] = [];
	let depth = 0;
	while (selected.length < maxStates) {
		let added = false;
		for (const bucket of ordered) {
			if (bucket[depth] && selected.length < maxStates) {
				selected.push(bucket[depth]);
				added = true;
			}
		}
		if (!added) break;
		depth += 1;
	}
	return selected;
}

function resultSummary(result: RecordGameResult): {
	reached30: boolean;
	finalVP: number;
	post15VpPerRound: number;
	stalled: boolean;
} {
	return {
		reached30: (result.finalVP.Red ?? 0) >= 30,
		finalVP: result.finalVP.Red ?? 0,
		post15VpPerRound: result.cycleBySeat.Red?.post15VpPerRound ?? 0,
		stalled: result.stalled
	};
}

describe('V24 terminal reward teacher harness', () => {
	(RUN ? it : it.skip)(
		'generates labels or runs the teacher-in-loop ceiling audit',
		async () => {
			const startedAt = Date.now();
			const catalog = await loadOrSnapshotCatalog();
			const configuredWeights = process.env.V24_TERMINAL_WEIGHTS;
			const sourceCommit = process.env.V24_TERMINAL_SOURCE_COMMIT?.trim();
			if (!configuredWeights) throw new Error('V24_TERMINAL_WEIGHTS is required');
			if (!sourceCommit) throw new Error('V24_TERMINAL_SOURCE_COMMIT is required');
			const weightPath = resolve(process.cwd(), configuredWeights);
			const catalogPath = mlPath('catalog.json');
			const policy = float32DecisionPolicy(loadPolicyForEval(weightPath));
			const provenance = {
				sourceCommit,
				checkpointPath: weightPath,
				checkpointSha256: sha256File(weightPath),
				catalogPath,
				catalogSha256: sha256File(catalogPath)
			};
			const games = envInt(
				'V24_TERMINAL_GAMES',
				MODE === 'loop' ? 512 : MODE === 'validate' ? 1024 : 2048
			);
			const rollouts = envInt(
				'V24_TERMINAL_ROLLOUTS',
				MODE === 'loop' || MODE === 'validate' ? 16 : 8
			);
			const maxStates = envInt('V24_TERMINAL_MAX_STATES', MODE === 'validate' ? 512 : 4096);
			const maxStatusLevel = envInt('V24_TERMINAL_MAX_STATUS', 2);
			const seedBase = envInt(
				'V24_TERMINAL_SEED_BASE',
				MODE === 'loop' ? 8_000_001 : MODE === 'validate' ? 7_500_001 : 7_000_001
			);

			if (MODE === 'loop') {
				const paired: Array<{
					seed: number;
					guardian: string;
					baseline: ReturnType<typeof resultSummary>;
					teacher: ReturnType<typeof resultSummary>;
					teacherDecisions: number;
				}> = [];
				for (let game = 0; game < games; game += 1) {
					const seed = seedBase + game;
					const guardian = catalog.guardians[game % catalog.guardians.length]?.name;
					if (!guardian) throw new Error('terminalTeacher: catalog has no guardian');
					const common = {
						seed,
						// Driver only uses this profile for a safety fallback; the frozen net acts.
						profiles: [profileFor('medium')],
						policy,
						guardianNames: [guardian],
						maxRounds: 30,
						maxStatusLevel,
						recordSeats: [] as SeatColor[],
						sample: false
					};
					const baselineResult = playRecordingGame(catalog, common);
					let teacherDecisions = 0;
					const teacherResult = playRecordingGame(catalog, {
						...common,
						chooser: (_obs, _features, commands, seat, state, withNext) => {
							if (!isAmbiguousMonsterRewardDecision(commands)) {
								return hybridIndex(policy, state, seat, withNext, { sample: false }, catalog);
							}
							const stateId = `loop:${seed}:${teacherDecisions}`;
							teacherDecisions += 1;
							return evaluateTerminalTeacher(state, seat, commands, policy, catalog, {
								stateId,
								rollouts,
								salt: `loop-eval:${seed}`,
								maxStatusLevel
							}).index;
						}
					});
					paired.push({
						seed,
						guardian,
						baseline: resultSummary(baselineResult),
						teacher: resultSummary(teacherResult),
						teacherDecisions
					});
				}
				const summary = {
					mode: MODE,
					...provenance,
					games,
					rollouts,
					baselineReach30: paired.filter((row) => row.baseline.reached30).length / games,
					teacherReach30: paired.filter((row) => row.teacher.reached30).length / games,
					baselineStalls: paired.filter((row) => row.baseline.stalled).length,
					teacherStalls: paired.filter((row) => row.teacher.stalled).length,
					wallMs: Date.now() - startedAt,
					paired
				};
				mkdirSync(dirname(outputPath('.summary.json')), { recursive: true });
				writeFileSync(outputPath('.summary.json'), JSON.stringify(summary, null, 2));
				return;
			}

			if (MODE !== 'collect' && MODE !== 'validate') {
				throw new Error(`unknown V24_TERMINAL_MODE=${MODE}`);
			}
			const captured: CapturedState[] = [];
			for (let game = 0; game < games; game += 1) {
				const seed = seedBase + game;
				const guardian = catalog.guardians[game % catalog.guardians.length]?.name;
				if (!guardian) throw new Error('terminalTeacher: catalog has no guardian');
				const gameCaptures: Omit<CapturedState, 'sourceReached30'>[] = [];
				let ordinal = 0;
				const result = playRecordingGame(catalog, {
					seed,
					profiles: [profileFor('medium')],
					policy,
					guardianNames: [guardian],
					maxRounds: 30,
					maxStatusLevel,
					recordSeats: [],
					sample: false,
					chooser: (obs, features, commands, seat, state, withNext) => {
						const historicalFullIndex = hybridIndex(
							policy,
							state,
							seat,
							withNext,
							{ sample: false },
							catalog
						);
						if (isAmbiguousMonsterRewardDecision(commands)) {
							const rewardIndices = commands.flatMap((command, index) =>
								command.type === 'resolveMonsterReward' ? [index] : []
							);
							const rewardActions = rewardIndices.map((index) => withNext[index]);
							const historicalIndex = hybridIndex(
								policy,
								state,
								seat,
								rewardActions,
								{ sample: false },
								catalog
							);
							gameCaptures.push({
								stateId: `source:${seed}:${ordinal++}`,
								seed,
								guardian,
								seat,
								round: state.round,
								vp: state.players[seat]?.victoryPoints ?? 0,
								obs: [...obs],
								cands: rewardIndices.map((index) => [...features[index]]),
								commands: rewardActions.map((action) => structuredClone(action.cmd)),
								historicalIndex,
								state: sanitizeSoloTerminalState(state, seat)
							});
						}
						return historicalFullIndex;
					}
				});
				const sourceReached30 = (result.finalVP.Red ?? 0) >= 30;
				captured.push(...gameCaptures.map((capture) => ({ ...capture, sourceReached30 })));
			}

			const selected = balancedReservoir(captured, maxStates);
			const collector: TerminalTeacherCollectorRow[] = [];
			const audit: Array<{
				stateId: string;
				seed: number;
				guardian: string;
				round: number;
				vp: number;
				sourceReached30: boolean;
				commandSignatures: string[];
				historicalIndex: number;
				label: TerminalTeacherLabel;
				agreement8vsFull?: boolean;
				validation?: {
					teacherWins: number;
					historicalWins: number;
					teacherMeanVP: number;
					historicalMeanVP: number;
					teacherMeanPost15: number;
					historicalMeanPost15: number;
				};
				snapshot: PublicGameState;
			}> = [];
			const configuredWeight = process.env.V24_TERMINAL_TEACHER_WEIGHT;
			const teacherWeight = configuredWeight === undefined ? undefined : Number(configuredWeight);
			for (const capture of selected) {
				const discoverySalt = MODE === 'validate' ? 'validation-discovery' : 'discovery';
				const decision = evaluateTerminalTeacher(
					capture.state,
					capture.seat,
					capture.commands,
					policy,
					catalog,
					{
						stateId: capture.stateId,
						rollouts,
						salt: discoverySalt,
						maxStatusLevel
					}
				);
				let agreement8vsFull: boolean | undefined;
				let validation:
					| {
							teacherWins: number;
							historicalWins: number;
							teacherMeanVP: number;
							historicalMeanVP: number;
							teacherMeanPost15: number;
							historicalMeanPost15: number;
					  }
					| undefined;
				if (MODE === 'validate') {
					const estimate8 = evaluateTerminalTeacher(
						capture.state,
						capture.seat,
						capture.commands,
						policy,
						catalog,
						{
							stateId: capture.stateId,
							rollouts: 8,
							salt: discoverySalt,
							maxStatusLevel
						}
					);
					agreement8vsFull =
						canonicalCommandSignature(capture.commands[estimate8.index]) ===
						canonicalCommandSignature(capture.commands[decision.index]);
					const evaluationRollouts = envInt('V24_TERMINAL_EVAL_ROLLOUTS', 16);
					const evaluateCommand = (index: number) =>
						Array.from({ length: evaluationRollouts }, (_, rolloutIndex) =>
							rolloutTerminalCandidate(
								capture.state,
								capture.seat,
								capture.commands[index],
								policy,
								catalog,
								{
									stateId: capture.stateId,
									rollouts: evaluationRollouts,
									salt: 'validation-evaluation',
									maxStatusLevel
								},
								rolloutIndex
							)
						).filter((outcome) => outcome !== null);
					const teacherOutcomes = evaluateCommand(decision.index);
					const historicalOutcomes = evaluateCommand(capture.historicalIndex);
					const average = (values: number[]) =>
						values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
					validation = {
						teacherWins: teacherOutcomes.filter((outcome) => outcome.reached30).length,
						historicalWins: historicalOutcomes.filter((outcome) => outcome.reached30).length,
						teacherMeanVP: average(teacherOutcomes.map((outcome) => outcome.finalVP)),
						historicalMeanVP: average(historicalOutcomes.map((outcome) => outcome.finalVP)),
						teacherMeanPost15: average(teacherOutcomes.map((outcome) => outcome.post15VpPerRound)),
						historicalMeanPost15: average(
							historicalOutcomes.map((outcome) => outcome.post15VpPerRound)
						)
					};
				}
				if (decision.label.decisive) {
					collector.push(
						terminalTeacherCollectorRow(decision.label, capture.obs, capture.cands, teacherWeight)
					);
				}
				audit.push({
					stateId: capture.stateId,
					seed: capture.seed,
					guardian: capture.guardian,
					round: capture.round,
					vp: capture.vp,
					sourceReached30: capture.sourceReached30,
					commandSignatures: capture.commands.map(canonicalCommandSignature),
					historicalIndex: capture.historicalIndex,
					label: decision.label,
					...(agreement8vsFull === undefined ? {} : { agreement8vsFull }),
					...(validation === undefined ? {} : { validation }),
					snapshot: capture.state
				});
			}

			writeJsonl(outputPath(), collector);
			writeJsonl(outputPath('.audit.jsonl'), audit);
			const validations = audit.flatMap((row) => (row.validation ? [row.validation] : []));
			writeFileSync(
				outputPath('.summary.json'),
				JSON.stringify(
					{
						mode: MODE,
						...provenance,
						games,
						captured: captured.length,
						selected: selected.length,
						decisive: collector.length,
						rollouts,
						maxStatusLevel,
						wallMs: Date.now() - startedAt,
						...(MODE === 'validate'
							? {
									topActionAgreement:
										audit.filter((row) => row.agreement8vsFull).length / Math.max(1, audit.length),
									teacherWinRate:
										validations.reduce((sum, row) => sum + row.teacherWins, 0) /
										Math.max(1, validations.length * envInt('V24_TERMINAL_EVAL_ROLLOUTS', 16)),
									historicalWinRate:
										validations.reduce((sum, row) => sum + row.historicalWins, 0) /
										Math.max(1, validations.length * envInt('V24_TERMINAL_EVAL_ROLLOUTS', 16))
								}
							: {}),
						collectorPath: outputPath(),
						auditPath: outputPath('.audit.jsonl')
					},
					null,
					2
				)
			);
		},
		60 * 60 * 1000
	);
});
