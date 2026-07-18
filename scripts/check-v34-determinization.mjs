#!/usr/bin/env node
/** Outcome-blind engine RNG audit; its registered numbers are never game seeds. */
import { createJiti } from 'jiti';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
	options: {
		samples: { type: 'string', default: '100000' },
		seed0: { type: 'string', default: '956400000' },
		out: { type: 'string' }
	}
});
const samples = Number.parseInt(args.samples, 10);
const seed0 = Number.parseInt(args.seed0, 10);
if (!Number.isSafeInteger(samples) || samples !== 100000 || seed0 !== 956400000) {
	throw new Error('V34 determinization audit requires exactly 100000 RNG samples at 956400000');
}
const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { determinizeForSearch } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'gumbelPlanner.ts')
);
const { DICE_TIER_FACES, rollAttack } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'combat.ts')
);
const { createRng } = await jiti.import(path.join(root, 'src', 'lib', 'play', 'rng.ts'));
const player = {
	attackDice: [{ instanceId: 'v34-public-arcane', tier: 'arcane' }],
	attackRollAdvantage: false,
	combatDamageBonus: 0,
	combatDamageMultiplier: 1
};
const base = {
	status: 'active',
	phase: 'location',
	round: 12,
	revealedDestinations: true,
	players: { Red: player },
	rng: createRng(1)
};
const faces = DICE_TIER_FACES.arcane;
const expectedCounts = new Map();
for (const face of faces) expectedCounts.set(face, (expectedCounts.get(face) ?? 0) + 1);
const observed = new Map([...expectedCounts.keys()].map((face) => [face, 0]));
for (let offset = 0; offset < samples; offset += 1) {
	const state = determinizeForSearch(base, 'Red', seed0 + offset);
	const result = rollAttack(state, state.players.Red);
	if (!observed.has(result)) throw new Error(`engine produced unregistered face ${result}`);
	observed.set(result, observed.get(result) + 1);
}
const confidence = 0.99;
const categories = observed.size;
const epsilon = Math.sqrt(Math.log((2 * categories) / (1 - confidence)) / (2 * samples));
const rows = [...observed.entries()].map(([face, count]) => {
	const expectedProbability = expectedCounts.get(face) / faces.length;
	const observedProbability = count / samples;
	return {
		face,
		count,
		expectedProbability,
		observedProbability,
		absoluteError: Math.abs(observedProbability - expectedProbability),
		insideSimultaneous99Envelope: Math.abs(observedProbability - expectedProbability) <= epsilon
	};
});
const report = {
	schemaVersion: 'arc-v34-determinization-audit-v1',
	strengthUse: false,
	rngOnlyNeverEngineGameSeeds: true,
	seed0,
	samples,
	seedMax: seed0 + samples - 1,
	confidence: {
		family: confidence,
		method: 'two-sided Hoeffding with Bonferroni union bound across categories',
		categories,
		epsilon
	},
	rows,
	passed: rows.every((row) => row.insideSimultaneous99Envelope)
};
if (args.out)
	writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
