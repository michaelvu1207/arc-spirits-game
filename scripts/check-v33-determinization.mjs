#!/usr/bin/env node
/** Outcome-blind V33 determinization distribution audit.
 *
 * Samples the real engine's exported attack-roll path after replacing the
 * public state's RNG through the exact search determinizer. The simultaneous
 * 99% envelope is a Bonferroni/Hoeffding union bound over all observed faces.
 */
import { createJiti } from 'jiti';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
	options: {
		samples: { type: 'string', default: '100000' },
		seed0: { type: 'string', default: '956000000' },
		out: { type: 'string' }
	}
});
const samples = Number.parseInt(args.samples, 10);
const seed0 = Number.parseInt(args.seed0, 10);
if (!Number.isSafeInteger(samples) || samples < 100000) {
	throw new Error('--samples must be an integer at least 100000');
}
if (!Number.isSafeInteger(seed0) || seed0 <= 0) throw new Error('--seed0 must be positive');

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { determinizeForSearch } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'gumbelPlanner.ts')
);
const { DICE_TIER_FACES, rollAttack } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'combat.ts')
);
const { createRng } = await jiti.import(path.join(root, 'src', 'lib', 'play', 'rng.ts'));

const player = {
	attackDice: [{ instanceId: 'v33-public-arcane', tier: 'arcane' }],
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

const familyAlpha = 0.01;
const categories = observed.size;
const epsilon = Math.sqrt(Math.log((2 * categories) / familyAlpha) / (2 * samples));
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
	schemaVersion: 'arc-v33-determinization-audit-v1',
	strengthUse: false,
	enginePath: 'combat.rollAttack(DICE_TIER_FACES.arcane)',
	determinizerPath: 'gumbelPlanner.determinizeForSearch',
	seed0,
	samples,
	seedMax: seed0 + samples - 1,
	confidence: {
		family: 0.99,
		method: 'two-sided Hoeffding with Bonferroni union bound across categories',
		categories,
		epsilon
	},
	rows,
	passed: rows.every((row) => row.insideSimultaneous99Envelope)
};
if (args.out) writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
