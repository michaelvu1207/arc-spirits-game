#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const experiment = 'ml/experiments/v32-onpolicy-solo';
const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const base = JSON.parse(readFileSync('ml/league/configs/fair-v32-onpolicy-base.json', 'utf8'));
const critic = `${experiment}/shared-critic/checkpoint.pt`;
const out = [];

const replaceExtraArg = (args, name, value) => {
	const at = args.indexOf(name);
	if (at < 0) throw new Error(`missing base argument ${name}`);
	args[at + 1] = String(value);
};

for (const replicate of protocol.screen.replicates) {
	for (const arm of protocol.screen.arms) {
		const root = `${experiment}/league/rep-${replicate.id}/${arm.id}`;
		const config = structuredClone(base);
		config._readme =
			`V32 frozen ${arm.id} replicate ${replicate.id}; paired within replicate and non-promotable.`;
		config.seedBase = replicate.seedBase;
		config.seedSchedule = {
			trainBase: replicate.trainBase,
			trainStride: protocol.screen.seedSchedule.trainStride,
			evalBase: replicate.evalBase,
			evalStride: protocol.screen.seedSchedule.evalStride,
			maxGeneration: protocol.screen.seedSchedule.maxGeneration
		};
		config.initFrom = critic;
		config.laneInit = { 'main-0': critic };
		config.paths = { root };
		replaceExtraArg(config.train.extraArgs, '--solo-reach30-coef', arm.soloReach30Coef);
		if (arm.roundPolicyBands) {
			config.train.extraArgs.push(
				'--ppo-round-policy-bands',
				arm.roundPolicyBands.map(([upper, weight]) => `${upper}:${weight}`).join(',')
			);
		}
		mkdirSync(root, { recursive: true });
		const serialized = JSON.stringify(config, null, 2) + '\n';
		writeFileSync(`${root}/config.json`, serialized);
		out.push({
			replicate: replicate.id,
			arm: arm.id,
			root,
			configSha256: createHash('sha256').update(serialized).digest('hex')
		});
	}
}
mkdirSync(`${experiment}/artifacts`, { recursive: true });
writeFileSync(
	`${experiment}/artifacts/materialized-configs.json`,
	JSON.stringify({ protocol: `${experiment}/protocol.json`, configs: out }, null, 2) + '\n'
);
console.log(JSON.stringify(out, null, 2));
