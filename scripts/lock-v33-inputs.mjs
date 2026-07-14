#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const output = 'ml/experiments/v33-strategic-search/artifacts/source-lock.json';
const declaredFiles = [
	'package.json',
	'package-lock.json',
	'ml/experiments/v33-strategic-search/plan.md',
	'ml/experiments/v33-strategic-search/fable-review.md',
	'ml/experiments/v33-strategic-search/implementation-fable-review.md',
	'ml/experiments/v33-strategic-search/protocol.json',
	'src/lib/play/ml/gumbelPlanner.ts',
	'src/lib/play/ml/actorWorker.ts',
	'src/lib/play/ml/poolTypes.ts',
	'src/lib/play/ml/_gumbelPlanner.test.ts',
	'src/lib/play/ml/_actorpool.test.ts',
	'src/lib/play/ml/actions.informationSafety.test.ts',
	'scripts/evaluate-solo-checkpoint.mjs',
	'scripts/benchmark-actor-workers.mjs',
	'scripts/check-v33-determinization.mjs',
	'scripts/validate-v33-protocol.mjs',
	'scripts/lock-v33-inputs.mjs',
	'scripts/verify-v33-source-lock.mjs',
	'scripts/run-v33-preflight.sh',
	'scripts/record-v33-preflight.mjs',
	'scripts/run-v33-systems-screen.sh',
	'scripts/record-v33-systems.mjs',
	'scripts/run-v33-phase2-screen.sh',
	'scripts/run-v33-guardian-confirmation.sh',
	'scripts/run-v33-qualification.sh',
	'ml/analyze_v33_search.py',
	'ml/test_analyze_v33_search.py',
	'ml/analyze_v33_qualification.py',
	'ml/test_analyze_v33_qualification.py'
];
const dependencyClosure = execFileSync('git', ['ls-files', 'src/lib/play', 'ml/*.py'], {
	encoding: 'utf8'
})
	.trim()
	.split('\n')
	.filter(Boolean);
const files = [...new Set([...declaredFiles, ...dependencyClosure])].sort();
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (existsSync(output)) throw new Error(`${output} already exists`);
const requested = process.argv[2];
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(requested ?? '') || requested !== head) {
	throw new Error('usage: lock-v33-inputs.mjs EXACT_CURRENT_40_CHARACTER_HEAD');
}
for (const file of files) if (!existsSync(file)) throw new Error(`missing frozen input ${file}`);
execFileSync('node', ['scripts/validate-v33-protocol.mjs'], { stdio: 'inherit' });
const changed = execFileSync('git', ['status', '--short', '--', ...files], {
	encoding: 'utf8'
}).trim();
if (changed) throw new Error(`frozen inputs are not committed:\n${changed}`);
const lock = {
	schemaVersion: 'arc-v33-source-lock-v1',
	implementationCommit: head,
	files: Object.fromEntries(files.map((file) => [file, sha256(file)])),
	authorization: {
		systemsSeedsOpen: true,
		phase2SeedsOpen: false,
		phase3DevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		expertIterationSeedsOpen: false,
		productionPromotionOpen: false
	},
	createdAt: new Date().toISOString()
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
chmodSync(output, 0o444);
console.log(JSON.stringify(lock, null, 2));
