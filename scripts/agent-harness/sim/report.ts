/**
 * Build the strategy report of a finished run folder (again, or for an older run).
 *
 *   npx tsx scripts/agent-harness/sim/report.ts <run folder>
 *
 * Writes <run folder>/strategy-report.json and strategy-report.md (strategyReport.ts).
 */

import { resolve } from 'node:path';
import { writeStrategyReport } from '../../../src/lib/play/agents/strategyReport';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: report.ts <run folder>');
	process.exit(1);
}
const report = writeStrategyReport(resolve(dir));
console.log(
	`${report.games} game(s), ${report.strategies.length} strategies → ${resolve(dir, 'strategy-report.md')}`
);
