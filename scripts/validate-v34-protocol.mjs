#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocolPath = path.join(
	root,
	'ml/experiments/v34-latency-first-expert-iteration/protocol.json'
);
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const fail = (message) => {
	throw new Error(`V34 protocol: ${message}`);
};
const sha256 = (relative) =>
	createHash('sha256')
		.update(readFileSync(path.join(root, relative)))
		.digest('hex');
const verifyInput = (input) => {
	if (!input?.path || !existsSync(path.join(root, input.path))) fail(`missing ${input?.path}`);
	if (sha256(input.path) !== input.sha256) fail(`hash mismatch for ${input.path}`);
};
const exactKeys = (object, keys, label) => {
	const actual = Object.keys(object).sort();
	const expected = [...keys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys changed`);
};

if (protocol.schemaVersion !== 'arc-controlled-experiment-v1') fail('schema changed');
if (protocol.experiment !== 'v34-latency-first-expert-iteration') fail('experiment changed');
if (protocol.status !== 'implementation-preflight' || protocol.promotionEligible !== false) {
	fail('implementation must begin closed and promotion-ineligible');
}
for (const input of Object.values(protocol.inputs)) verifyInput(input);
verifyInput(protocol.review.plan);
verifyInput(protocol.review.artifact);
if (protocol.review.model !== 'Claude Fable' || protocol.review.effort !== 'high') {
	fail('Fable review contract changed');
}
const authorizationKeys = [
	'previewCalibrationSeedsOpen',
	'systemsSeedsOpen',
	'phase2SeedsOpen',
	'guardianSeedsOpen',
	'teacherSeedsOpen',
	'finalDevelopmentSeedsOpen',
	'hiddenSeedsOpen',
	'multiplayerSeedsOpen',
	'humanReferenceSeedsOpen',
	'productionPromotionOpen'
];
exactKeys(protocol.authorization, authorizationKeys, 'authorization');
if (Object.values(protocol.authorization).some((value) => value !== false)) {
	fail('every initial authorization must be false');
}
if (
	protocol.commonDecode.seats !== 1 ||
	protocol.commonDecode.maxRounds !== 30 ||
	protocol.commonDecode.maxStatusLevel !== 2 ||
	protocol.commonDecode.guardianSchedule !== 'absolute-balanced' ||
	protocol.commonDecode.selection !== 'hybrid' ||
	protocol.commonDecode.sample !== true ||
	protocol.commonDecode.temperature !== 0.55 ||
	protocol.commonDecode.policyObsVersion !== 2 ||
	protocol.commonDecode.inferenceWire !== 'binary' ||
	JSON.stringify(protocol.commonDecode.planningScope) !==
		JSON.stringify(['navigation', 'encounter'])
) {
	fail('common decode changed');
}
if (
	protocol.previewCalibration.seed0 !== 957800000 ||
	protocol.previewCalibration.games !== 4096 ||
	protocol.previewCalibration.bins !== 15 ||
	protocol.previewCalibration.gates.aucMin !== 0.75 ||
	protocol.previewCalibration.gates.eceMax !== 0.1 ||
	protocol.previewCalibration.gates.brierMax !== 0.2
) {
	fail('preview calibration contract changed');
}
const expectedArms = [
	{ id: 'rerank-p025', kind: 'critic-rerank', policyRankWeight: 0.25 },
	{ id: 'rerank-p050', kind: 'critic-rerank', policyRankWeight: 0.5 },
	{ id: 'rerank-p075', kind: 'critic-rerank', policyRankWeight: 0.75 },
	{ id: 'rerank-p100', kind: 'critic-rerank', policyRankWeight: 1 },
	{ id: 'heuristic-s4-h2', kind: 'heuristic-batched', simulations: 4, horizonRounds: 2 },
	{ id: 'heuristic-s8-h3', kind: 'heuristic-batched', simulations: 8, horizonRounds: 3 }
];
if (JSON.stringify(protocol.systems.candidateArms) !== JSON.stringify(expectedArms)) {
	fail('registered systems arms changed');
}
if (
	protocol.systems.seed0 !== 957900000 ||
	protocol.systems.games !== 256 ||
	protocol.systems.smoke.games !== 4 ||
	protocol.systems.smoke.workers !== 1 ||
	protocol.systems.smoke.decisionP95MsMax !== 10000 ||
	protocol.systems.smoke.optimisticProjected4096SecondsMax !== 21600 ||
	JSON.stringify(protocol.systems.binding) !==
		JSON.stringify([
			{ games: 64, workers: 1, decisionP95MsMax: 1000, minimumStrategicDecisions: 256 },
			{ games: 64, workers: 8, decisionP95MsMax: 2000, minimumStrategicDecisions: 256 }
		]) ||
	JSON.stringify(protocol.systems.throughput.workerCounts) !== JSON.stringify([4, 8, 12, 16, 24]) ||
	protocol.systems.throughput.games !== 128 ||
	protocol.systems.throughput.projected4096SecondsMax !== 21600
) {
	fail('systems schedule or gates changed');
}
if (
	protocol.phase2.family.candidateSlots !== 6 ||
	protocol.phase2.family.coreOutcomesPerSlot !== 4 ||
	protocol.phase2.family.familySize !== 24 ||
	protocol.phase2.family.draws !== 10000 ||
	protocol.phase2.family.familyNeverShrinksAfterSystemsRejection !== true
) {
	fail('phase2 family changed');
}
if (
	protocol.finalSolo.gates.trueWinRateMin !== 0.8 ||
	protocol.finalSolo.gates.oneSided95LowerBoundMin !== 0.75 ||
	protocol.finalSolo.gates.hiddenPointDropPointsMax !== 5 ||
	protocol.finalSolo.hidden.open !== false
) {
	fail('final solo or hidden gate changed');
}
if (
	protocol.multiplayer.eloPointGainMin !== 100 ||
	protocol.human.liveHeadToHeadGamesMin !== 50 ||
	protocol.human.oneSided95WilsonLowerBoundStrictlyAbove !== 0.5
) {
	fail('multiplayer or human gate changed');
}
if (
	protocol.runtime.excludedGpu !== 4 ||
	JSON.stringify(protocol.runtime.eligibleGpuOrder) !== JSON.stringify([0, 5, 6, 7]) ||
	protocol.runtime.maxActorThreads !== 96 ||
	protocol.runtime.nice !== 19
) {
	fail('runtime safety contract changed');
}

const ranges = [];
const addRange = (name, seed0, games, kind = 'engine-game') => {
	if (!Number.isSafeInteger(seed0) || !Number.isSafeInteger(games) || games < 1) {
		fail(`invalid range ${name}`);
	}
	ranges.push({ name, lo: seed0, hi: seed0 + games - 1, kind });
};
addRange(
	'preview-calibration',
	protocol.previewCalibration.seed0,
	protocol.previewCalibration.games
);
addRange('systems', protocol.systems.seed0, protocol.systems.games);
addRange(
	'determinization-rng-only',
	protocol.determinizationAudit.seed0,
	protocol.determinizationAudit.samples,
	'rng-only'
);
addRange('phase2', protocol.phase2.seed0, protocol.phase2.games);
addRange('guardian', protocol.guardianConfirmation.seed0, protocol.guardianConfirmation.games);
addRange(
	'final-development',
	protocol.finalSolo.development.seed0,
	protocol.finalSolo.development.games
);
addRange('final-hidden', protocol.finalSolo.hidden.seed0, protocol.finalSolo.hidden.games);
for (let generation = 0; generation < protocol.expertIteration.generationsMax; generation += 1) {
	addRange(
		`teacher-g${generation + 1}`,
		protocol.expertIteration.teacher.generationSeed0[generation],
		protocol.expertIteration.gamesPerGeneration
	);
	addRange(
		`ppo-g${generation + 1}`,
		protocol.expertIteration.ppoGenerationSeed0[generation],
		protocol.expertIteration.gamesPerGeneration
	);
	addRange(
		`expert-development-g${generation + 1}`,
		protocol.expertIteration.developmentSeed0[generation],
		protocol.expertIteration.gamesPerGeneration
	);
}
addRange(
	'composition-transfer',
	protocol.compositionTransfer.seed0,
	protocol.compositionTransfer.games
);
for (const arm of protocol.modelWidth.arms) addRange(arm.id, arm.seed0, arm.games);
addRange(
	'width-development',
	protocol.modelWidth.development.seed0,
	protocol.modelWidth.development.games
);
addRange(
	'multiplayer-canary',
	protocol.expertIteration.multiplayerCanary.seed0,
	protocol.expertIteration.multiplayerCanary.games
);
addRange(
	'multiplayer-development',
	protocol.multiplayer.development.seed0,
	protocol.multiplayer.development.games
);
addRange(
	'multiplayer-hidden',
	protocol.multiplayer.hidden.seed0,
	protocol.multiplayer.hidden.games
);
addRange('human-reference', protocol.human.referenceSeed0, protocol.human.referenceGames);
for (let left = 0; left < ranges.length; left += 1) {
	for (let right = left + 1; right < ranges.length; right += 1) {
		const a = ranges[left];
		const b = ranges[right];
		if (a.lo <= b.hi && b.lo <= a.hi) fail(`seed ranges overlap: ${a.name} and ${b.name}`);
	}
}
console.log(
	JSON.stringify(
		{
			schemaVersion: 'arc-v34-protocol-validation-v1',
			valid: true,
			protocolSha256: createHash('sha256').update(readFileSync(protocolPath)).digest('hex'),
			ranges
		},
		null,
		2
	)
);
