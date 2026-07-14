#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocolPath = path.join(root, 'ml/experiments/v33-strategic-search/protocol.json');
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const fail = (message) => {
	throw new Error(`V33 protocol: ${message}`);
};
const sha256 = (file) =>
	createHash('sha256')
		.update(readFileSync(path.join(root, file)))
		.digest('hex');
const exactKeys = (value, keys, label) => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(`${label} keys ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
	}
};

if (protocol.schemaVersion !== 'arc-controlled-experiment-v1') fail('schema changed');
if (protocol.status !== 'implementation-preflight')
	fail('status must remain implementation-preflight');
if (protocol.promotionEligible !== false) fail('promotion must remain closed');
for (const input of [protocol.catalog, protocol.policy, protocol.v23Comparator]) {
	if (!existsSync(path.join(root, input.path))) fail(`missing ${input.path}`);
	if (sha256(input.path) !== input.sha256) fail(`hash mismatch for ${input.path}`);
}
if (sha256(protocol.policy.manifestPath) !== protocol.policy.manifestSha256) {
	fail('policy manifest hash mismatch');
}
if (sha256(protocol.predecessor.artifact) !== protocol.predecessor.artifactSha256) {
	fail('V32 invalidation hash mismatch');
}
for (const file of [
	protocol.review.plan,
	protocol.review.artifact,
	protocol.review.implementationArtifact
]) {
	if (!existsSync(path.join(root, file))) fail(`missing review input ${file}`);
}
exactKeys(
	protocol.authorization,
	[
		'systemsSeedsOpen',
		'phase2SeedsOpen',
		'phase3DevelopmentSeedsOpen',
		'hiddenSeedsOpen',
		'expertIterationSeedsOpen',
		'productionPromotionOpen'
	],
	'authorization'
);
if (Object.values(protocol.authorization).some((value) => value !== false)) {
	fail('every seed and promotion authorization must start closed');
}

const expectedArms = [
	{ id: 'raw', sims: 0, horizonRounds: 0 },
	{ id: 'search-s16-h4', sims: 16, horizonRounds: 4 },
	{ id: 'search-s16-h6', sims: 16, horizonRounds: 6 },
	{ id: 'search-s32-h6', sims: 32, horizonRounds: 6 }
];
if (JSON.stringify(protocol.systems.arms) !== JSON.stringify(expectedArms))
	fail('systems arms changed');
if (
	JSON.stringify(protocol.systems.workerCounts) !== JSON.stringify([4, 8, 12, 16, 24]) ||
	protocol.systems.seed0 !== 953900000 ||
	protocol.systems.games !== 256 ||
	protocol.systems.repeats !== 1
) {
	fail('systems schedule changed');
}
if (
	protocol.commonDecode.policyObsVersion !== 2 ||
	protocol.commonDecode.inferenceWire !== 'binary' ||
	protocol.commonDecode.searchLeafObjective !== 'solo-reach30' ||
	protocol.commonDecode.searchRollout !== 'policy' ||
	protocol.commonDecode.searchNavigationTemperature !== 0
) {
	fail('decode/search contract changed');
}

const ranges = [];
const addRange = (name, seed0, games) => {
	if (!Number.isSafeInteger(seed0) || !Number.isSafeInteger(games) || games < 1) {
		fail(`invalid range ${name}`);
	}
	ranges.push({ name, lo: seed0, hi: seed0 + games - 1 });
};
addRange('systems', protocol.systems.seed0, protocol.systems.games);
addRange(
	'determinization',
	protocol.determinizationAudit.seed0,
	protocol.determinizationAudit.samples
);
addRange('phase2', protocol.phase2.seed0, protocol.phase2.games);
addRange('guardian', protocol.guardianConfirmation.seed0, protocol.guardianConfirmation.games);
addRange(
	'phase3-development',
	protocol.phase3.development.seed0,
	protocol.phase3.development.games
);
addRange('phase3-hidden', protocol.phase3.hidden.seed0, protocol.phase3.hidden.games);
addRange(
	'expert-development',
	protocol.expertIteration.development.seed0,
	protocol.expertIteration.development.games
);
for (const replicate of protocol.expertIteration.replicates) {
	if (replicate.generationSeed0.length !== protocol.expertIteration.generations) {
		fail(`replicate ${replicate.id} generation count changed`);
	}
	for (let i = 0; i < replicate.generationSeed0.length; i += 1) {
		addRange(
			`expert-${replicate.id}-g${i + 1}`,
			replicate.generationSeed0[i],
			protocol.expertIteration.gamesPerGeneration
		);
	}
}
for (let i = 0; i < ranges.length; i += 1) {
	for (let j = i + 1; j < ranges.length; j += 1) {
		const a = ranges[i];
		const b = ranges[j];
		if (a.lo <= b.hi && b.lo <= a.hi) fail(`seed ranges overlap: ${a.name} and ${b.name}`);
	}
}
if (protocol.phase2.familySize !== 3 || protocol.phase2.bootstrap.draws !== 10000) {
	fail('phase2 inference contract changed');
}
if (
	protocol.phase3.gates.absoluteTrueWinRateMin !== 0.8 ||
	protocol.phase3.gates.finalVpPointDeltaMin !== 0 ||
	protocol.phase3.gates.post15VpPerRoundPointDeltaMin !== 0 ||
	protocol.phase3.gates.censoredFirst30RoundPointDeltaMax !== 0 ||
	protocol.phase3.gates.guardianPointDeltaMin !== -5 ||
	protocol.phase3.hidden.open !== false ||
	protocol.phase3.hiddenOpenOnlyAfterDevelopmentAndLatencyPass !== true
) {
	fail('phase3/hidden gate changed');
}
if (
	protocol.runtime.excludedGpu !== 4 ||
	JSON.stringify(protocol.runtime.eligibleGpuOrder) !== JSON.stringify([5, 6, 7, 0]) ||
	protocol.runtime.maxActorThreads !== 96
) {
	fail('runtime safety contract changed');
}

console.log(
	JSON.stringify(
		{
			schemaVersion: 'arc-v33-protocol-validation-v1',
			valid: true,
			protocolSha256: createHash('sha256').update(readFileSync(protocolPath)).digest('hex'),
			ranges
		},
		null,
		2
	)
);
