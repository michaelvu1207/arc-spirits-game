#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePhase2Report, validateReplayReport } from './record-v34-phase2-condition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const protocol = JSON.parse(
	readFileSync('ml/experiments/v34-latency-first-expert-iteration/protocol.json', 'utf8')
);
const strengthProtocol = JSON.parse(
	readFileSync('ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json', 'utf8')
);
const catalog = JSON.parse(readFileSync(protocol.inputs.catalog.path, 'utf8'));
const guardianNames = catalog.guardians.map((guardian) => guardian.name);
const sourceCommit = 'a'.repeat(40);
const selectedWorkers = 8;
const context = {
	lock: { implementationCommit: sourceCommit },
	protocol,
	strengthProtocol,
	systems: {
		arms: protocol.systems.candidateArms.map((arm) => ({
			id: arm.id,
			operationallyEligible: true,
			selectedWorkers
		}))
	},
	authorization: {
		eligibleCandidateArms: protocol.systems.candidateArms.map((arm) => arm.id)
	}
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function buildRows() {
	return Array.from({ length: protocol.phase2.games }, (_, index) => {
		const seed = protocol.phase2.seed0 + index;
		const trueWin = index % 3 === 0;
		const finalVP = trueWin ? 31 : 20 + (index % 7);
		const first30Round = trueWin ? 20 + (index % 11) : null;
		const cycle = {
			first30Round,
			post15VpPerRound: 0.5 + (index % 5) * 0.25,
			finalAttackDice: 2 + (index % 4),
			finalSpirits: 3 + (index % 6),
			finalMaxBarrier: 1 + (index % 5)
		};
		return {
			seed,
			guardian: guardianNames[seed % guardianNames.length],
			trueWin,
			stalled: false,
			finalVP,
			first30Round: cycle.first30Round,
			post15VpPerRound: cycle.post15VpPerRound,
			finalAttackDice: cycle.finalAttackDice,
			finalSpirits: cycle.finalSpirits,
			finalMaxBarrier: cycle.finalMaxBarrier,
			cycle
		};
	});
}

function guardianBreakdown(rows) {
	return guardianNames.map((guardian) => {
		const group = rows.filter((row) => row.guardian === guardian);
		const trueWins = group.filter((row) => row.trueWin).length;
		return {
			guardian,
			games: group.length,
			trueWins,
			trueWinRate: trueWins / group.length,
			meanVP: mean(group.map((row) => row.finalVP))
		};
	});
}

function rawReport() {
	const perGame = buildRows();
	const trueWins = perGame.filter((row) => row.trueWin).length;
	return {
		schemaVersion: 'solo-heldout-v2',
		sourceCommit,
		weights: protocol.inputs.policy.path,
		weightsSha256: protocol.inputs.policy.sha256,
		catalog: protocol.inputs.catalog.path,
		catalogSha256: protocol.inputs.catalog.sha256,
		inference: {
			weightsSha256: protocol.inputs.policy.sha256,
			format: protocol.inputs.policy.format,
			obsDim: protocol.inputs.policy.obsDim,
			actDim: protocol.inputs.policy.actDim,
			wire: strengthProtocol.commonDecode.inferenceWire
		},
		seed0: protocol.phase2.seed0,
		games: protocol.phase2.games,
		maxRounds: strengthProtocol.commonDecode.maxRounds,
		maxStatusLevel: strengthProtocol.commonDecode.maxStatusLevel,
		decode: {
			policyObsVersion: strengthProtocol.commonDecode.policyObsVersion,
			inferenceSocket: '/tmp/arc-v34-phase2-test.sock',
			learnMonsterRewardChoices: strengthProtocol.commonDecode.learnMonsterRewardChoices,
			sample: strengthProtocol.commonDecode.sample,
			temperature: strengthProtocol.commonDecode.temperature
		},
		trueWins,
		trueWinRate: trueWins / perGame.length,
		stalls: 0,
		stallRate: 0,
		vp: { mean: mean(perGame.map((row) => row.finalVP)) },
		engine: {
			meanPost15VpPerRound: mean(perGame.map((row) => row.post15VpPerRound))
		},
		guardianBreakdown: guardianBreakdown(perGame),
		performance: {
			workers: strengthProtocol.runtime.rawWorkers,
			wallSeconds: 100,
			gamesPerSecond: protocol.phase2.games / 100,
			gameWallMsP50: 10,
			gameWallMsP95: 20
		},
		perGame
	};
}

function rerankReport() {
	const report = rawReport();
	report.decode.rerank = { policyRankWeight: 0.25 };
	report.performance.workers = selectedWorkers;
	report.performance.search = {
		mode: 'critic-rerank',
		decisions: 8192,
		simulations: 0,
		byPhase: { navigation: 4096, encounter: 4096 },
		decisionWallMsP50: 0.5,
		decisionWallMsP95: 1.5
	};
	return report;
}

function expectRejected(temp, label, condition, workers, report, pattern) {
	const file = path.join(temp, `${label}.json`);
	writeFileSync(file, `${JSON.stringify(report)}\n`);
	assert.throws(
		() => validatePhase2Report(context, condition, workers, file),
		pattern,
		`${label} corruption was accepted`
	);
}

const temp = mkdtempSync(path.join(tmpdir(), 'arc-v34-phase2-condition-test-'));
try {
	const raw = rawReport();
	const rawPath = path.join(temp, 'raw.json');
	writeFileSync(rawPath, `${JSON.stringify(raw)}\n`);
	assert.equal(raw.perGame.length, 4096);
	assert.equal(
		validatePhase2Report(context, 'raw', strengthProtocol.runtime.rawWorkers, rawPath).report
			.trueWins,
		raw.trueWins
	);
	const replay = structuredClone(raw);
	replay.games = strengthProtocol.phase2.replayAudit.games;
	replay.perGame = replay.perGame.slice(0, replay.games).reverse();
	replay.trueWins = replay.perGame.filter((row) => row.trueWin).length;
	replay.trueWinRate = replay.trueWins / replay.games;
	replay.performance.workers = strengthProtocol.phase2.replayAudit.workers;
	const replayPath = path.join(temp, 'raw-replay.json');
	writeFileSync(replayPath, `${JSON.stringify(replay)}\n`);
	assert.equal(validateReplayReport(context, 'raw', replayPath, raw).mismatches, 0);
	const corruptReplay = structuredClone(replay);
	corruptReplay.perGame[0].finalVP += 1;
	const corruptReplayPath = path.join(temp, 'corrupt-replay.json');
	writeFileSync(corruptReplayPath, `${JSON.stringify(corruptReplay)}\n`);
	assert.throws(
		() => validateReplayReport(context, 'raw', corruptReplayPath, raw),
		/replay differs from the primary run/
	);

	const rerank = rerankReport();
	const rerankPath = path.join(temp, 'rerank-p025.json');
	writeFileSync(rerankPath, `${JSON.stringify(rerank)}\n`);
	assert.equal(rerank.perGame.length, 4096);
	assert.equal(
		validatePhase2Report(context, 'rerank-p025', selectedWorkers, rerankPath).telemetry
			.strategicDecisions,
		8192
	);

	const duplicate = structuredClone(raw);
	duplicate.perGame[1].seed = duplicate.perGame[0].seed;
	expectRejected(
		temp,
		'duplicate-seed',
		'raw',
		strengthProtocol.runtime.rawWorkers,
		duplicate,
		/duplicate seed/
	);

	const stalled = structuredClone(raw);
	stalled.perGame[0].stalled = true;
	expectRejected(
		temp,
		'stalled-row',
		'raw',
		strengthProtocol.runtime.rawWorkers,
		stalled,
		/invalid outcome\/stall row/
	);

	const provenance = structuredClone(raw);
	provenance.inference.weightsSha256 = 'b'.repeat(64);
	expectRejected(
		temp,
		'provenance',
		'raw',
		strengthProtocol.runtime.rawWorkers,
		provenance,
		/inference provenance mismatch/
	);

	const config = structuredClone(rerank);
	config.decode.rerank.policyRankWeight = 0.5;
	expectRejected(temp, 'config', 'rerank-p025', selectedWorkers, config, /rerank weight mismatch/);

	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-phase2-condition-test-v1',
			passed: true,
			gamesPerValidReport: 4096,
			validCases: ['raw', 'rerank-p025'],
			rejectedCorruptions: ['duplicate-seed', 'stall', 'provenance', 'config', 'replay']
		})
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
