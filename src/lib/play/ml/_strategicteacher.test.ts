/**
 * Opt-in V25 strategic-decision occurrence audit and teacher-in-loop ceiling pilot.
 *
 * Occurrence audit:
 *   V25_STRATEGIC_TEACHER=1 V25_STRATEGIC_MODE=audit V25_STRATEGIC_GAMES=512 \
 *   V25_STRATEGIC_SOURCE_COMMIT=<commit> \
 *   V25_STRATEGIC_WEIGHTS=ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
 *   V25_STRATEGIC_CATALOG=ml/catalogs/live-20260713-5f4ad348.json \
 *   npx vitest run src/lib/play/ml/_strategicteacher.test.ts --disable-console-intercept
 *
 * Paired family pilot:
 *   V25_STRATEGIC_TEACHER=1 V25_STRATEGIC_MODE=loop V25_STRATEGIC_FAMILY=navigation \
 *   V25_STRATEGIC_GAMES=64 V25_STRATEGIC_ROLLOUTS=8 \
 *   npx vitest run src/lib/play/ml/_strategicteacher.test.ts --disable-console-intercept
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';
import { playRecordingGame, type RecordGameResult } from './driver';
import { hybridIndex } from './neuralBot';
import type { NeuralPolicy } from './net';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import {
	canonicalCommandSignature,
	evaluateTerminalDecision,
	meaningfulLocationYieldSupport,
	navigationDecisionSupport
} from './terminalTeacher';
import type { LegalAction } from './actions';
import { guardianIndexForSeed } from './evalSchedule';

const RUN = process.env.V25_STRATEGIC_TEACHER === '1';
const MODE = process.env.V25_STRATEGIC_MODE ?? 'audit';
type Family = 'navigation' | 'yield' | 'combined';

interface DecisionAudit {
	seed: number;
	guardian: string;
	family: Exclude<Family, 'combined'>;
	round: number;
	vp: number;
	candidates: number;
	historicalType: GameCommand['type'];
	historicalSignature: string;
	yieldChosen: boolean;
	navigationLogitGap?: number;
}

interface OutcomeSummary {
	reached15: boolean;
	reached30: boolean;
	converted15To30: boolean;
	finalVP: number;
	post15VpPerRound: number;
	first30Round: number | null;
	rounds: number;
	stalled: boolean;
}

interface TeacherCounters {
	evaluations: number;
	decisive: number;
	changed: number;
	nonDecisiveAbstentions: number;
	invalidAbstentions: number;
	candidateRollouts: number;
	candidateRolloutStalls: number;
	byRoundBand: Record<string, { evaluations: number; decisive: number; changed: number }>;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
	return value;
}

// Long pilots are deliberately SIGSTOP/SIGCONT-throttled around shared SimForge load.
// Vitest measures stopped wall-clock time rather than active compute, so the wrapper
// timeout is independent and configurable instead of invalidating complete artifacts.
const TEST_TIMEOUT_MS = envInt('V25_STRATEGIC_TEST_TIMEOUT_MS', 24 * 60 * 60 * 1000);

function outputPath(suffix = ''): string {
	const configured = process.env.V25_STRATEGIC_OUT;
	const base = configured
		? resolve(process.cwd(), configured)
		: mlPath('heldout', `v25-strategic-${MODE}.jsonl`);
	return suffix ? `${base}${suffix}` : base;
}

function sha256File(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeJsonl(file: string, rows: readonly unknown[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
	);
}

function writeSummary(summary: unknown): void {
	const file = outputPath('.summary.json');
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(summary, null, 2));
}

function float32DecisionPolicy(policy: NeuralPolicy): NeuralPolicy {
	if (policy.optionDim !== 0) {
		throw new Error('strategicTeacher: harness requires a stripped option_dim=0 checkpoint');
	}
	const f32Obs = (obs: number[]) => Array.from(Float32Array.from(obs));
	const f32Cands = (cands: number[][]) => cands.map((cand) => Array.from(Float32Array.from(cand)));
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number => target.pick(f32Obs(obs), f32Cands(cands), opts);
			}
			if (prop === 'scoreCandidates') {
				return (obs: number[], cands: number[][]): number[] =>
					target.scoreCandidates(f32Obs(obs), f32Cands(cands));
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

function resultSummary(result: RecordGameResult): OutcomeSummary {
	const cycle = result.cycleBySeat.Red;
	const finalVP = result.finalVP.Red ?? 0;
	const reached15 = (cycle?.first15Round ?? null) !== null || finalVP >= 15;
	const reached30 = finalVP >= 30;
	return {
		reached15,
		reached30,
		converted15To30: reached15 && reached30,
		finalVP,
		post15VpPerRound: cycle?.post15VpPerRound ?? 0,
		first30Round: cycle?.first30Round ?? null,
		rounds: result.rounds,
		stalled: result.stalled
	};
}

function roundBand(round: number): string {
	return round <= 5 ? '01-05' : round <= 10 ? '06-10' : round <= 20 ? '11-20' : '21-30';
}

function vpBand(vp: number): string {
	return vp < 10 ? '00-09' : vp < 20 ? '10-19' : '20-29';
}

function topTwoGap(scores: readonly number[]): number {
	if (scores.length < 2) return Number.POSITIVE_INFINITY;
	const sorted = [...scores].sort((a, b) => b - a);
	return sorted[0] - sorted[1];
}

function supportFor(
	family: Exclude<Family, 'combined'>,
	state: PublicGameState,
	seat: SeatColor,
	commands: readonly GameCommand[],
	withNext: readonly LegalAction[]
): number[] {
	return family === 'navigation'
		? navigationDecisionSupport(commands)
		: meaningfulLocationYieldSupport(state, seat, withNext);
}

function summarizeAudit(rows: readonly DecisionAudit[], games: number): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const family of ['navigation', 'yield'] as const) {
		const selected = rows.filter((row) => row.family === family);
		const histogram = <T extends string | number>(values: readonly T[]): Record<string, number> =>
			values.reduce<Record<string, number>>((out, value) => {
				out[String(value)] = (out[String(value)] ?? 0) + 1;
				return out;
			}, {});
		result[family] = {
			decisions: selected.length,
			gamesCovered: new Set(selected.map((row) => row.seed)).size,
			gameCoverage: new Set(selected.map((row) => row.seed)).size / Math.max(1, games),
			meanCandidates:
				selected.reduce((sum, row) => sum + row.candidates, 0) / Math.max(1, selected.length),
			candidateHistogram: histogram(selected.map((row) => row.candidates)),
			roundBands: histogram(selected.map((row) => roundBand(row.round))),
			vpBands: histogram(selected.map((row) => vpBand(row.vp))),
			historicalTypes: histogram(selected.map((row) => row.historicalType)),
			historicalYieldRate:
				selected.filter((row) => row.yieldChosen).length / Math.max(1, selected.length),
			estimatedCandidateRolloutsAt64x8:
				(selected.reduce((sum, row) => sum + row.candidates, 0) / Math.max(1, games)) * 64 * 8,
			navigationLogitGap:
				family === 'navigation'
					? {
							mean:
								selected.reduce((sum, row) => sum + (row.navigationLogitGap ?? 0), 0) /
								Math.max(1, selected.length),
							within1_5: selected.filter((row) => (row.navigationLogitGap ?? Infinity) <= 1.5)
								.length
						}
					: undefined
		};
	}
	return result;
}

function freshCounters(): TeacherCounters {
	return {
		evaluations: 0,
		decisive: 0,
		changed: 0,
		nonDecisiveAbstentions: 0,
		invalidAbstentions: 0,
		candidateRollouts: 0,
		candidateRolloutStalls: 0,
		byRoundBand: {}
	};
}

function bumpBand(
	counters: TeacherCounters,
	round: number,
	field: 'evaluations' | 'decisive' | 'changed'
): void {
	const band = roundBand(round);
	const row = counters.byRoundBand[band] ?? { evaluations: 0, decisive: 0, changed: 0 };
	row[field] += 1;
	counters.byRoundBand[band] = row;
}

describe('V25 strategic terminal teacher harness', () => {
	(RUN ? it : it.skip)(
		'audits natural support or runs a paired family ceiling pilot',
		async () => {
			const startedAt = Date.now();
			if (MODE !== 'audit' && MODE !== 'loop') {
				throw new Error(`unknown V25_STRATEGIC_MODE=${MODE}`);
			}
			const configuredWeights = process.env.V25_STRATEGIC_WEIGHTS;
			const sourceCommit = process.env.V25_STRATEGIC_SOURCE_COMMIT?.trim();
			if (!configuredWeights) throw new Error('V25_STRATEGIC_WEIGHTS is required');
			if (!sourceCommit) throw new Error('V25_STRATEGIC_SOURCE_COMMIT is required');
			const family = (process.env.V25_STRATEGIC_FAMILY ?? 'navigation') as Family;
			if (!['navigation', 'yield', 'combined'].includes(family)) {
				throw new Error(`unknown V25_STRATEGIC_FAMILY=${family}`);
			}
			const configuredCatalog = process.env.V25_STRATEGIC_CATALOG?.trim();
			const catalogPath = configuredCatalog
				? resolve(process.cwd(), configuredCatalog)
				: mlPath('catalog.json');
			const catalog = configuredCatalog
				? (JSON.parse(readFileSync(catalogPath, 'utf8')) as PlayCatalog)
				: await loadOrSnapshotCatalog();
			const weightPath = resolve(process.cwd(), configuredWeights);
			const policy = float32DecisionPolicy(loadPolicyForEval(weightPath));
			const provenance = {
				sourceCommit,
				checkpointPath: weightPath,
				checkpointSha256: sha256File(weightPath),
				catalogPath,
				catalogSha256: sha256File(catalogPath)
			};
			const games = envInt('V25_STRATEGIC_GAMES', MODE === 'audit' ? 512 : 64);
			const rollouts = envInt('V25_STRATEGIC_ROLLOUTS', 8);
			const seedBase = envInt(
				'V25_STRATEGIC_SEED_BASE',
				MODE === 'audit' ? 9_000_001 : family === 'navigation' ? 9_100_001 : 9_200_001
			);
			const maxStatusLevel = envInt('V25_STRATEGIC_MAX_STATUS', 2);
			const navigationMinRound = envInt('V25_STRATEGIC_NAV_MIN_ROUND', 1);
			const navigationMaxLogitGap = envNumber('V25_STRATEGIC_NAV_MAX_LOGIT_GAP', Number.MAX_VALUE);
			const commonFor = (seed: number, guardian: string) => ({
				seed,
				profiles: [profileFor('medium')],
				policy,
				guardianNames: [guardian],
				maxRounds: 30,
				maxStatusLevel,
				recordSeats: [] as SeatColor[],
				sample: false
			});

			if (MODE === 'audit') {
				const decisions: DecisionAudit[] = [];
				const outcomes: Array<{ seed: number; guardian: string; result: OutcomeSummary }> = [];
				for (let game = 0; game < games; game += 1) {
					const seed = seedBase + game;
					const guardian =
						catalog.guardians[guardianIndexForSeed(seed, catalog.guardians.length)]?.name;
					if (!guardian) throw new Error('strategicTeacher: catalog has no guardian');
					const result = playRecordingGame(catalog, {
						...commonFor(seed, guardian),
						chooser: (obs, features, commands, seat, state, withNext) => {
							const historical = hybridIndex(
								policy,
								state,
								seat,
								withNext,
								{ sample: false },
								catalog
							);
							for (const decisionFamily of ['navigation', 'yield'] as const) {
								const support = supportFor(decisionFamily, state, seat, commands, withNext);
								if (support.length < 2) continue;
								const supportScores =
									decisionFamily === 'navigation'
										? policy.scoreCandidates(
												obs,
												support.map((index) => features[index])
											)
										: [];
								decisions.push({
									seed,
									guardian,
									family: decisionFamily,
									round: state.round,
									vp: state.players[seat]?.victoryPoints ?? 0,
									candidates: support.length,
									historicalType: commands[historical].type,
									historicalSignature: canonicalCommandSignature(commands[historical]),
									yieldChosen: commands[historical].type === 'endLocationActions',
									...(decisionFamily === 'navigation'
										? { navigationLogitGap: topTwoGap(supportScores) }
										: {})
								});
							}
							return historical;
						}
					});
					outcomes.push({ seed, guardian, result: resultSummary(result) });
				}
				writeJsonl(outputPath(), decisions);
				writeSummary({
					mode: MODE,
					...provenance,
					games,
					seedBase,
					stalls: outcomes.filter((row) => row.result.stalled).length,
					wins: outcomes.filter((row) => row.result.reached30).length,
					meanVP: outcomes.reduce((sum, row) => sum + row.result.finalVP, 0) / Math.max(1, games),
					families: summarizeAudit(decisions, games),
					decisionPath: outputPath(),
					wallMs: Date.now() - startedAt
				});
				return;
			}

			const paired: Array<{
				seed: number;
				guardian: string;
				baseline: OutcomeSummary;
				teacher: OutcomeSummary;
				counters: TeacherCounters;
			}> = [];
			for (let game = 0; game < games; game += 1) {
				const seed = seedBase + game;
				const guardian =
					catalog.guardians[guardianIndexForSeed(seed, catalog.guardians.length)]?.name;
				if (!guardian) throw new Error('strategicTeacher: catalog has no guardian');
				const common = commonFor(seed, guardian);
				const baseline = playRecordingGame(catalog, common);
				const counters = freshCounters();
				let ordinal = 0;
				const teacher = playRecordingGame(catalog, {
					...common,
					chooser: (obs, features, commands, seat, state, withNext) => {
						const historical = hybridIndex(
							policy,
							state,
							seat,
							withNext,
							{ sample: false },
							catalog
						);
						const families =
							family === 'combined' ? (['navigation', 'yield'] as const) : ([family] as const);
						for (const decisionFamily of families) {
							const support = supportFor(decisionFamily, state, seat, commands, withNext);
							if (support.length < 2) continue;
							if (decisionFamily === 'navigation') {
								if (state.round < navigationMinRound) continue;
								const gap = topTwoGap(
									policy.scoreCandidates(
										obs,
										support.map((index) => features[index])
									)
								);
								if (gap > navigationMaxLogitGap) continue;
							}
							if (!support.includes(historical)) {
								throw new Error('strategicTeacher: historical action fell outside frozen support');
							}
							counters.evaluations += 1;
							bumpBand(counters, state.round, 'evaluations');
							counters.candidateRollouts += support.length * rollouts;
							const stateId = `v25:${decisionFamily}:${seed}:${ordinal++}`;
							let decision;
							try {
								decision = evaluateTerminalDecision(
									state,
									seat,
									commands,
									support,
									policy,
									catalog,
									{
										stateId,
										rollouts,
										salt: `v25-loop:${decisionFamily}:${seed}`,
										maxStatusLevel
									}
								);
							} catch (error) {
								if (
									error instanceof Error &&
									/fewer than two evaluated candidates/.test(error.message)
								) {
									counters.invalidAbstentions += 1;
									return historical;
								}
								throw error;
							}
							counters.candidateRolloutStalls += decision.label.stats.reduce(
								(sum, stat) => sum + stat.stalls,
								0
							);
							if (!decision.label.decisive) {
								counters.nonDecisiveAbstentions += 1;
								return historical;
							}
							if (!support.includes(decision.index)) {
								throw new Error('strategicTeacher: selected action escaped frozen support');
							}
							counters.decisive += 1;
							bumpBand(counters, state.round, 'decisive');
							if (decision.index !== historical) {
								counters.changed += 1;
								bumpBand(counters, state.round, 'changed');
							}
							return decision.index;
						}
						return historical;
					}
				});
				paired.push({
					seed,
					guardian,
					baseline: resultSummary(baseline),
					teacher: resultSummary(teacher),
					counters
				});
			}
			const totalCounters = paired.reduce<TeacherCounters>((total, row) => {
				for (const field of [
					'evaluations',
					'decisive',
					'changed',
					'nonDecisiveAbstentions',
					'invalidAbstentions',
					'candidateRollouts',
					'candidateRolloutStalls'
				] as const) {
					total[field] += row.counters[field];
				}
				for (const [band, counts] of Object.entries(row.counters.byRoundBand)) {
					const target = total.byRoundBand[band] ?? { evaluations: 0, decisive: 0, changed: 0 };
					target.evaluations += counts.evaluations;
					target.decisive += counts.decisive;
					target.changed += counts.changed;
					total.byRoundBand[band] = target;
				}
				return total;
			}, freshCounters());
			const mean = (arm: 'baseline' | 'teacher', key: 'finalVP' | 'post15VpPerRound') =>
				paired.reduce((sum, row) => sum + row[arm][key], 0) / Math.max(1, games);
			writeSummary({
				mode: MODE,
				family,
				...provenance,
				games,
				rollouts,
				seedBase,
				maxStatusLevel,
				navigationMinRound,
				navigationMaxLogitGap,
				baselineWins: paired.filter((row) => row.baseline.reached30).length,
				teacherWins: paired.filter((row) => row.teacher.reached30).length,
				baselineOnly: paired.filter((row) => row.baseline.reached30 && !row.teacher.reached30)
					.length,
				teacherOnly: paired.filter((row) => !row.baseline.reached30 && row.teacher.reached30)
					.length,
				baselineReach15: paired.filter((row) => row.baseline.reached15).length,
				teacherReach15: paired.filter((row) => row.teacher.reached15).length,
				baselineConvert15To30: paired.filter((row) => row.baseline.converted15To30).length,
				teacherConvert15To30: paired.filter((row) => row.teacher.converted15To30).length,
				baselineMeanVP: mean('baseline', 'finalVP'),
				teacherMeanVP: mean('teacher', 'finalVP'),
				baselinePost15: mean('baseline', 'post15VpPerRound'),
				teacherPost15: mean('teacher', 'post15VpPerRound'),
				baselineMeanFirst30Round: paired
					.flatMap((row) => (row.baseline.first30Round === null ? [] : [row.baseline.first30Round]))
					.reduce((sum, value, _index, values) => sum + value / values.length, 0),
				teacherMeanFirst30Round: paired
					.flatMap((row) => (row.teacher.first30Round === null ? [] : [row.teacher.first30Round]))
					.reduce((sum, value, _index, values) => sum + value / values.length, 0),
				baselineStalls: paired.filter((row) => row.baseline.stalled).length,
				teacherStalls: paired.filter((row) => row.teacher.stalled).length,
				counters: totalCounters,
				wallMs: Date.now() - startedAt,
				paired
			});
		},
		TEST_TIMEOUT_MS
	);
});
