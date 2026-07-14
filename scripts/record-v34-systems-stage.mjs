#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
	options: {
		arm: { type: 'string' },
		stage: { type: 'string' },
		benchmark: { type: 'string' },
		progress: { type: 'string' },
		out: { type: 'string' }
	}
});
for (const key of ['arm', 'stage', 'benchmark', 'progress', 'out']) {
	if (!args[key]) throw new Error(`--${key} is required`);
}
process.chdir(root);
const protocolPath = 'ml/experiments/v34-latency-first-expert-iteration/protocol.json';
const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes);
const protocolSha256 = createHash('sha256').update(protocolBytes).digest('hex');
const arm = protocol.systems.candidateArms.find((candidate) => candidate.id === args.arm);
if (!arm) throw new Error(`unknown V34 systems arm ${args.arm}`);
let expectedGames;
let expectedWorkers;
let p95Limit = null;
if (args.stage === 'smoke') {
	expectedGames = protocol.systems.smoke.games;
	expectedWorkers = protocol.systems.smoke.workers;
	p95Limit = protocol.systems.smoke.decisionP95MsMax;
} else if (args.stage === 'binding-w1' || args.stage === 'binding-w8') {
	expectedWorkers = Number.parseInt(args.stage.slice('binding-w'.length), 10);
	const spec = protocol.systems.binding.find((row) => row.workers === expectedWorkers);
	if (!spec) throw new Error(`missing protocol binding spec for ${args.stage}`);
	expectedGames = spec.games;
	p95Limit = spec.decisionP95MsMax;
} else if (/^throughput-w(4|8|12|16|24)$/.test(args.stage)) {
	expectedWorkers = Number.parseInt(args.stage.slice('throughput-w'.length), 10);
	expectedGames = protocol.systems.throughput.games;
} else {
	throw new Error(`invalid V34 systems stage ${args.stage}`);
}
const benchmarkPath = path.resolve(args.benchmark);
const progressPath = path.resolve(args.progress);
const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
if (
	benchmark.gamesPerTrial !== expectedGames ||
	benchmark.repeats !== 1 ||
	benchmark.seed0 !== protocol.systems.seed0 ||
	benchmark.trials?.length !== 1 ||
	benchmark.trials[0].workers !== expectedWorkers ||
	benchmark.trials[0].games !== expectedGames
) {
	throw new Error('V34 systems benchmark schedule mismatch');
}
const trial = benchmark.trials[0];
const expectedMode = arm.kind === 'critic-rerank' ? 'critic-rerank' : 'heuristic-batched';
if (trial.plannerMode !== expectedMode) throw new Error('V34 systems planner mode mismatch');
if (
	!trial.inference ||
	trial.inference.weightsSha256 !== protocol.inputs.policy.sha256 ||
	trial.inference.format !== protocol.inputs.policy.format ||
	trial.inference.obsDim !== protocol.inputs.policy.obsDim ||
	trial.inference.actDim !== protocol.inputs.policy.actDim ||
	trial.inference.wire !== protocol.commonDecode.inferenceWire
) {
	throw new Error('V34 systems inference provenance mismatch');
}
if (
	benchmark.config.seats !== protocol.commonDecode.seats ||
	benchmark.config.maxRounds !== protocol.commonDecode.maxRounds ||
	benchmark.config.maxStatusLevel !== protocol.commonDecode.maxStatusLevel ||
	benchmark.config.guardianSchedule !== protocol.commonDecode.guardianSchedule ||
	benchmark.config.selection !== protocol.commonDecode.selection ||
	benchmark.config.sample !== protocol.commonDecode.sample ||
	benchmark.config.temperature !== protocol.commonDecode.temperature ||
	benchmark.config.policyObsVersion !== protocol.commonDecode.policyObsVersion ||
	JSON.stringify(benchmark.config.recordSeats) !== '[]'
) {
	throw new Error('V34 systems common decode mismatch');
}
if (arm.kind === 'critic-rerank') {
	if (
		benchmark.config.rerank?.policyRankWeight !== arm.policyRankWeight ||
		benchmark.config.search !== undefined ||
		trial.searchSimulations !== 0
	) {
		throw new Error('V34 systems critic reranker config mismatch');
	}
} else if (
	benchmark.config.rerank !== undefined ||
	benchmark.config.search?.sims !== arm.simulations ||
	benchmark.config.search?.horizonRounds !== arm.horizonRounds ||
	benchmark.config.search?.objective !== 'solo-reach30' ||
	benchmark.config.search?.rollout !== 'heuristic' ||
	trial.searchSimulations !== trial.searchDecisions * arm.simulations
) {
	throw new Error('V34 systems batched heuristic config mismatch');
}

const gameKeys = [
	'schemaVersion',
	'event',
	'timestamp',
	'label',
	'configHash',
	'workers',
	'repeat',
	'completionOrdinal',
	'games',
	'seed',
	'wallMs',
	'plannerMode',
	'strategicDecisions',
	'strategicSimulations',
	'decisionWallMs',
	'byPhase',
	'inferenceProvenance'
].sort();
const progressRows = readFileSync(progressPath, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const games = progressRows.filter((row) => row.event === 'game-complete');
if (games.length !== expectedGames) throw new Error('V34 systems progress game coverage mismatch');
const expectedSeeds = Array.from(
	{ length: expectedGames },
	(_, index) => protocol.systems.seed0 + index
).sort((left, right) => left - right);
const observedSeeds = games.map((row) => row.seed).sort((left, right) => left - right);
if (JSON.stringify(observedSeeds) !== JSON.stringify(expectedSeeds)) {
	throw new Error('V34 systems progress seed coverage mismatch');
}
const expectedOrdinals = Array.from({ length: expectedGames }, (_, index) => index + 1);
const observedOrdinals = games
	.map((row) => row.completionOrdinal)
	.sort((left, right) => left - right);
if (JSON.stringify(observedOrdinals) !== JSON.stringify(expectedOrdinals)) {
	throw new Error('V34 systems progress completion ordinal coverage mismatch');
}
const decisionWallMs = [];
let decisions = 0;
let simulations = 0;
for (const row of games) {
	if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(gameKeys)) {
		throw new Error('V34 systems progress game schema changed');
	}
	if (
		row.schemaVersion !== 'arc-actor-benchmark-progress-v1' ||
		row.label !== `${args.arm}/${args.stage}` ||
		row.configHash !== protocolSha256 ||
		row.workers !== expectedWorkers ||
		row.repeat !== 0 ||
		row.games !== expectedGames ||
		row.plannerMode !== expectedMode ||
		JSON.stringify(row.inferenceProvenance) !== JSON.stringify(trial.inference) ||
		!Array.isArray(row.decisionWallMs) ||
		row.decisionWallMs.some((value) => !Number.isFinite(value) || value < 0)
	) {
		throw new Error('V34 systems progress content mismatch');
	}
	decisions += row.strategicDecisions;
	simulations += row.strategicSimulations;
	decisionWallMs.push(...row.decisionWallMs);
}
if (
	decisions !== trial.searchDecisions ||
	simulations !== trial.searchSimulations ||
	decisionWallMs.length !== decisions
) {
	throw new Error('V34 systems progress search-count mismatch');
}
decisionWallMs.sort((left, right) => left - right);
const p95 =
	decisionWallMs.length > 0
		? decisionWallMs[Math.max(0, Math.ceil(0.95 * decisionWallMs.length) - 1)]
		: null;
const optimisticProjected4096Seconds =
	args.stage === 'smoke' ? (4096 * (trial.wallMs / 1000)) / (expectedGames * 24) : null;
const projected4096Seconds = 4096 / trial.gamesPerSecond;
let eligible = true;
let rejectionReason = null;
if (args.stage === 'smoke') {
	if (p95 === null || p95 > p95Limit) rejectionReason = 'smoke decision p95 exceeds 10000ms';
	else if (
		optimisticProjected4096Seconds > protocol.systems.smoke.optimisticProjected4096SecondsMax
	) {
		rejectionReason = 'optimistic perfect-24-worker projection exceeds 21600s';
	}
} else if (args.stage.startsWith('binding-')) {
	const spec = protocol.systems.binding.find((row) => row.workers === expectedWorkers);
	if (decisions < spec.minimumStrategicDecisions)
		rejectionReason = 'binding strategic decision count below 256';
	else if (p95 === null || p95 > p95Limit) rejectionReason = 'binding decision p95 exceeds limit';
} else if (projected4096Seconds > protocol.systems.throughput.projected4096SecondsMax) {
	rejectionReason = 'throughput projection exceeds 21600s';
}
if (rejectionReason) eligible = false;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const report = {
	schemaVersion: 'arc-v34-systems-stage-v1',
	strengthUse: false,
	outcomesLoaded: false,
	arm: args.arm,
	stage: args.stage,
	seed0: protocol.systems.seed0,
	games: expectedGames,
	seedMax: protocol.systems.seed0 + expectedGames - 1,
	workers: expectedWorkers,
	plannerMode: expectedMode,
	strategicDecisions: decisions,
	strategicSimulations: simulations,
	decisionWallMsP95: p95,
	wallSeconds: trial.wallMs / 1000,
	gamesPerSecond: trial.gamesPerSecond,
	optimisticProjected4096Seconds,
	projected4096Seconds,
	inference: trial.inference,
	inputs: {
		protocol: { path: protocolPath, sha256: protocolSha256 },
		benchmark: { path: benchmarkPath, sha256: sha256(benchmarkPath) },
		progress: { path: progressPath, sha256: sha256(progressPath) }
	},
	eligible,
	rejectionReason
};
const out = path.resolve(args.out);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
chmodSync(out, 0o444);
console.log(JSON.stringify(report, null, 2));
