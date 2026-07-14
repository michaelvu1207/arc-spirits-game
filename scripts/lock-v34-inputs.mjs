#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const output = 'ml/experiments/v34-latency-first-expert-iteration/artifacts/source-lock.json';
const declaredFiles = [
	'package.json',
	'package-lock.json',
	'ml/experiments/v34-latency-first-expert-iteration/plan.md',
	'ml/experiments/v34-latency-first-expert-iteration/fable-review.md',
	'ml/experiments/v34-latency-first-expert-iteration/protocol.json',
	'ml/analyze_v34_preview_calibration.py',
	'ml/test_analyze_v34_preview_calibration.py',
	'ml/infer_server.py',
	'scripts/benchmark-actor-workers.mjs',
	'scripts/evaluate-solo-checkpoint.mjs',
	'scripts/collect-v34-preview-calibration.mjs',
	'scripts/check-v34-determinization.mjs',
	'scripts/validate-v34-protocol.mjs',
	'scripts/lock-v34-inputs.mjs',
	'scripts/verify-v34-source-lock.mjs',
	'scripts/record-v34-preflight.mjs',
	'scripts/run-v34-preflight.sh',
	'scripts/run-v34-preview-calibration.sh',
	'scripts/record-v34-systems-authorization.mjs',
	'scripts/record-v34-systems-stage.mjs',
	'scripts/run-v34-systems-screen.sh',
	'scripts/record-v34-systems-eligibility.mjs',
	'src/lib/play/ml/criticReranker.ts',
	'src/lib/play/ml/heuristicRolloutPlanner.ts',
	'src/lib/play/ml/_heuristicRolloutPlanner.test.ts'
];
const closure = execFileSync('git', ['ls-files', 'src/lib/play', 'ml/*.py'], {
	encoding: 'utf8'
})
	.trim()
	.split('\n')
	.filter(Boolean);
const files = [...new Set([...declaredFiles, ...closure])].sort();
const requested = process.argv[2];
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(requested ?? '') || requested !== head) {
	throw new Error('usage: lock-v34-inputs.mjs EXACT_CURRENT_40_CHARACTER_HEAD');
}
if (existsSync(output)) throw new Error(`${output} already exists`);
for (const file of files) if (!existsSync(file)) throw new Error(`missing frozen input ${file}`);
execFileSync('node', ['scripts/validate-v34-protocol.mjs'], { stdio: 'inherit' });
const changed = execFileSync('git', ['status', '--short', '--', ...files], {
	encoding: 'utf8'
}).trim();
if (changed) throw new Error(`V34 frozen inputs are not committed:\n${changed}`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const lock = {
	schemaVersion: 'arc-v34-source-lock-v1',
	implementationCommit: head,
	files: Object.fromEntries(files.map((file) => [file, sha256(file)])),
	authorization: {
		previewCalibrationSeedsOpen: true,
		systemsSeedsOpen: false,
		phase2SeedsOpen: false,
		guardianSeedsOpen: false,
		teacherSeedsOpen: false,
		finalDevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		multiplayerSeedsOpen: false,
		humanReferenceSeedsOpen: false,
		productionPromotionOpen: false
	},
	createdAt: new Date().toISOString()
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
chmodSync(output, 0o444);
console.log(JSON.stringify(lock, null, 2));
