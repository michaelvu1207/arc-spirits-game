/**
 * Checks, with no model call, that the unfinished games of a league can be continued: each game's
 * record (in flight, paused, stopped or failed) is played again up to its last decision.
 *
 *   npx tsx scripts/agent-harness/league/resume-check.ts --dir ~/arcspirits-harness/league
 *
 * Safe while the league runs (it only reads). Prints one line per game and exits 1 when a record
 * cannot be continued (such a game would be played from its start).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BudgetGuard } from '../../../src/lib/play/agents/budget';
import { LlmSeatController } from '../../../src/lib/play/agents/llmSeat';
import { readPartialTranscript, resumableRecords } from '../../../src/lib/play/agents/league/resume';
import { loadSavedVersion } from '../../../src/lib/play/agents/league/versions';
import type { ChatProvider } from '../../../src/lib/play/agents/providers/types';
import { runAgentGame } from '../../../src/lib/play/agents/runner';
import type { HeaderRecord } from '../../../src/lib/play/agents/transcript';

const { values } = parseArgs({ options: { dir: { type: 'string' }, version: { type: 'string' } } });
const dir = resolve((values.dir ?? join(homedir(), 'arcspirits-harness/league')).replace(/^~(?=\/)/, homedir()));
const versions = values.version
	? [values.version]
	: readdirSync(join(dir, 'versions'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

let bad = 0;
for (const id of versions) {
	const gamesDir = join(dir, 'versions', id, 'games');
	if (!existsSync(gamesDir)) continue;
	const v = loadSavedVersion(dir, id);
	const done = new Set(
		existsSync(join(dir, 'versions', id, 'traces'))
			? readdirSync(join(dir, 'versions', id, 'traces')).map((f) => Number(/^g(\d+)\.json$/.exec(f)?.[1] ?? -1))
			: []
	);
	for (const name of readdirSync(gamesDir).sort()) {
		const m = /^g(\d+)\.(?:(abandoned|failed)-\d+\.)?jsonl$/.exec(name);
		if (!m || done.has(Number(m[1]))) continue;
		const records = resumableRecords(readPartialTranscript(join(gamesDir, name)));
		if (!records) {
			console.log(`${id} ${name}: nothing to continue from (it would be played from its start)`);
			continue;
		}
		const header = records[0] as HeaderRecord;
		let remembered = 0;
		const provider: ChatProvider = {
			name: 'check',
			estimateCostUsd: async () => 0,
			complete: async () => {
				throw new Error('resume-check makes no model call');
			},
			remember: () => {
				remembered += 1;
			}
		};
		const league = header.options.league as { agents: { agent: string; memory: 'history' | 'fresh' }[] };
		const paused = new AbortController();
		paused.abort();
		try {
			const summary = await runAgentGame({
				catalog: v.catalog,
				catalogInfo: v.catalogInfo,
				seed: header.seed,
				controllers: header.seats.map(
					(s, i) =>
						new LlmSeatController({
							provider,
							model: s.model,
							budget: new BudgetGuard(),
							label: s.controller,
							strategy: s.strategy ?? null,
							...(s.openingSpirits ? { openingSpirits: s.openingSpirits } : {}),
							memory: league.agents[i].memory
						})
				),
				rulesBrief: v.rulesBrief,
				budget: new BudgetGuard(),
				runId: header.runId,
				gameIndex: header.gameIndex,
				maxDecisions: Number(header.options.maxDecisions),
				maxPhaseDecisions: Number(header.options.maxPhaseDecisions),
				eventsPerPrompt: Number(header.options.eventsPerPrompt),
				pause: paused.signal,
				resume: { records }
			});
			const ok = summary.stopReason === 'paused' || summary.stopReason === 'finished';
			if (!ok) bad += 1;
			console.log(
				`${id} ${name}: ${ok ? 'can be continued' : `ENDS AS ${summary.stopReason}`} after ${summary.resumedDecisions} decisions (round ${summary.rounds}); ${remembered} turns go back to the seats`
			);
		} catch (err) {
			bad += 1;
			console.log(`${id} ${name}: CANNOT be continued: ${(err as Error).message}`);
		}
	}
}
process.exit(bad ? 1 : 0);
