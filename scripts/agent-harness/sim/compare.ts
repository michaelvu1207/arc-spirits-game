/**
 * Before/after compare of two finished run folders (same seeds, seats and strategies; old data
 * first).
 *
 *   npx tsx scripts/agent-harness/sim/compare.ts <old run folder> <new run folder> [--out <dir>]
 *
 * Writes compare.json and compare.md into --out (default: the new run folder).
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeCompare } from '../../../src/lib/play/agents/strategyCompare';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { out: { type: 'string' } }
});
if (positionals.length !== 2) {
	console.error('usage: compare.ts <old run folder> <new run folder> [--out <dir>]');
	process.exit(1);
}
const [oldDir, newDir] = positionals.map((p) => resolve(p));
const out = resolve(values.out ?? newDir);
const report = writeCompare(oldDir, newDir, out);
console.log(
	`${report.dataChanges.length} data change(s), same setup: ${report.sameSetup ? 'yes' : `no (${report.setupNote})`} → ${resolve(out, 'compare.md')}`
);
