#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);

const experiment = 'ml/experiments/v35-weco-recursive-autoresearch';
const protocolPath = `${experiment}/phase1-protocol.json`;
const basePath = 'ml/league/configs/fair-v35-late-credit-base.json';
const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes);
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => hashBytes(readFileSync(file));

const requireCondition = (condition, message) => {
	if (!condition) throw new Error(message);
};
const replaceExtraArg = (args, name, value) => {
	const at = args.lastIndexOf(name);
	requireCondition(at >= 0 && at + 1 < args.length, `missing base argument ${name}`);
	args[at + 1] = String(value);
};

requireCondition(protocol.schemaVersion === 'arc-v35-phase1-protocol-v1', 'wrong protocol schema');
requireCondition(protocol.status === 'smoke-frozen', 'protocol is not smoke-frozen');
requireCondition(protocol.replicates.length === 3, 'V35 requires exactly three replicates');
requireCondition(protocol.arms.length === 3, 'V35 requires exactly three arms');
requireCondition(
	hashFile(protocol.catalog.path) === protocol.catalog.sha256,
	'catalog hash mismatch'
);
requireCondition(
	hashFile(protocol.initialPolicy.path) === protocol.initialPolicy.sha256,
	'initial policy hash mismatch'
);
requireCondition(
	hashFile(protocol.initialPolicy.manifestPath) === protocol.initialPolicy.manifestSha256,
	'initial policy manifest hash mismatch'
);

const schedule = protocol.seedSchedule;
const intervals = [];
for (const replicate of protocol.replicates) {
	intervals.push({
		id: `${replicate.id}:train`,
		start: replicate.trainBase,
		end:
			replicate.trainBase +
			(schedule.maxGeneration - 1) * schedule.trainStride +
			schedule.gamesPerGeneration -
			1
	});
	intervals.push({
		id: `${replicate.id}:eval`,
		start: replicate.evalBase,
		end:
			replicate.evalBase +
			(schedule.maxGeneration - 1) * schedule.evalStride +
			schedule.evalGamesPerGeneration -
			1
	});
}
intervals.push({
	id: 'development',
	start: schedule.developmentBase,
	end: schedule.developmentBase + schedule.developmentGames - 1
});
for (let i = 0; i < intervals.length; i += 1) {
	requireCondition(Number.isSafeInteger(intervals[i].start), `${intervals[i].id} start is unsafe`);
	requireCondition(Number.isSafeInteger(intervals[i].end), `${intervals[i].id} end is unsafe`);
	for (let j = i + 1; j < intervals.length; j += 1) {
		requireCondition(
			intervals[i].end < intervals[j].start || intervals[j].end < intervals[i].start,
			`seed overlap ${intervals[i].id} and ${intervals[j].id}`
		);
	}
}

const materialized = [];
for (const replicate of protocol.replicates) {
	for (const arm of protocol.arms) {
		const root = `${experiment}/league/rep-${replicate.id}/${arm.id}`;
		const config = structuredClone(base);
		config._readme =
			`V35 frozen ${arm.id} replicate ${replicate.id}; status-2 mechanism screen, ` +
			'paired within replicate, not promotion eligible.';
		config.seedBase = replicate.trainBase;
		config.seedSchedule = {
			trainBase: replicate.trainBase,
			trainStride: schedule.trainStride,
			evalBase: replicate.evalBase,
			evalStride: schedule.evalStride,
			maxGeneration: schedule.maxGeneration
		};
		config.initFrom = protocol.initialPolicy.path;
		config.laneInit = { 'main-0': protocol.initialPolicy.path };
		config.paths = { root };
		replaceExtraArg(config.train.extraArgs, '--solo-reach30-coef', arm.soloReach30Coef);
		if (arm.roundPolicyBands) {
			config.train.extraArgs.push(
				'--ppo-round-policy-bands',
				arm.roundPolicyBands.map(([upper, weight]) => `${upper}:${weight}`).join(',')
			);
		}

		mkdirSync(root, { recursive: true });
		if (existsSync(`${root}/state.json`)) {
			throw new Error(`refusing to rewrite initialized root ${root}`);
		}
		const serialized = JSON.stringify(config, null, 2) + '\n';
		const configSha256 = hashBytes(serialized);
		writeFileSync(`${root}/config.json`, serialized);
		const binding = {
			schemaVersion: 'arc-v35-root-binding-v1',
			experiment: protocol.experiment,
			replicate: replicate.id,
			arm: arm.id,
			protocolPath,
			protocolSha256: hashBytes(protocolBytes),
			configSha256,
			catalogSha256: protocol.catalog.sha256,
			initialPolicySha256: protocol.initialPolicy.sha256,
			promotionEligible: false
		};
		writeFileSync(`${root}/v35-binding.json`, JSON.stringify(binding, null, 2) + '\n');
		materialized.push({
			replicate: replicate.id,
			arm: arm.id,
			root,
			configSha256,
			bindingSha256: hashFile(`${root}/v35-binding.json`)
		});
	}
}

mkdirSync(`${experiment}/artifacts`, { recursive: true });
const output = {
	schemaVersion: 'arc-v35-materialized-configs-v1',
	protocolPath,
	protocolSha256: hashBytes(protocolBytes),
	basePath,
	baseSha256: hashFile(basePath),
	seedIntervals: intervals,
	configs: materialized
};
writeFileSync(
	`${experiment}/artifacts/phase1-materialized-configs.json`,
	JSON.stringify(output, null, 2) + '\n'
);
console.log(JSON.stringify(output, null, 2));
