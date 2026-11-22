/**
 * Scripted Fighter + Elementalist player: play many seeded games offline (no model calls) and
 * write one JSON result.
 *
 *   # four scripted players at one table, seeds 1-100, on Test 33's data
 *   npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
 *       --table fe4 --seeds 1-100 --out ../balance/scripted/fe4.json
 *
 *   # one scripted player against three mock:greedy seats (its seat rotates with the seed)
 *   npx tsx scripts/agent-harness/scripted/run-fe.ts --data ../balance/z22a/game \
 *       --table fe-vs-greedy --seeds 1-100 --out ../balance/scripted/fe-vs-greedy.json
 *
 *   # any table: seat specs in seat order (script:fe, mock:greedy, mock:random, mock:first)
 *   npx tsx scripts/agent-harness/scripted/run-fe.ts --seats script:fe,mock:random,script:fe,mock:greedy
 *
 * Options: --jobs N (parallel worker processes, default 8), --params '{"die":0.4}' (policy
 * overrides, for tuning), --quiet. A game depends only on its seed, seats and params.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalogSpec } from '../../../src/lib/play/agents/catalog';
import { buildRulesBrief } from '../../../src/lib/play/agents/rulesBrief';
import { playTable, type TableGameResult } from '../../../src/lib/play/agents/scripted/feGames';
import { summarizeFeRun } from '../../../src/lib/play/agents/scripted/feSummary';

const { values } = parseArgs({
	options: {
		data: { type: 'string', default: 'local' },
		table: { type: 'string' },
		seats: { type: 'string' },
		seeds: { type: 'string', default: '1-10' },
		jobs: { type: 'string', default: '8' },
		params: { type: 'string' },
		variants: { type: 'string' },
		out: { type: 'string' },
		worker: { type: 'boolean', default: false },
		quiet: { type: 'boolean', default: false }
	}
});

function parseSeeds(spec: string): number[] {
	const out: number[] = [];
	for (const part of spec.split(',')) {
		const m = /^(\d+)-(\d+)$/.exec(part.trim());
		if (m) for (let s = Number(m[1]); s <= Number(m[2]); s++) out.push(s);
		else if (part.trim()) out.push(Number(part.trim()));
	}
	if (out.some((s) => !Number.isInteger(s) || s < 0)) throw new Error(`bad --seeds "${spec}"`);
	return out;
}

/** Seat specs of the games of a seed. `fe-vs-*` tables put the scripted seat at position
 *  seed % 4. `ab` plays every seed twice, with the two variants' seats swapped (paired games:
 *  the deal and the seat positions cancel out). */
function seatingsFor(seed: number): string[][] {
	if ((values.table ?? 'fe4') === 'ab' && !values.seats)
		return [
			['script:fe#a', 'script:fe#b', 'script:fe#a', 'script:fe#b'],
			['script:fe#b', 'script:fe#a', 'script:fe#b', 'script:fe#a']
		];
	return [seatsFor(seed)];
}

function seatsFor(seed: number): string[] {
	if (values.seats) return values.seats.split(',').map((s) => s.trim());
	const table = values.table ?? 'fe4';
	if (table === 'fe4') return ['script:fe', 'script:fe', 'script:fe', 'script:fe'];
	// A/B test of two parameter sets (--variants '{"a":{…},"b":{…}}'): two seats each, swapped on odd seeds.
	const m = /^fe-vs-(greedy|random|first)$/.exec(table);
	if (!m)
		throw new Error(
			`unknown --table "${table}" (fe4 | ab | fe-vs-greedy | fe-vs-random | fe-vs-first)`
		);
	const seats = [`mock:${m[1]}`, `mock:${m[1]}`, `mock:${m[1]}`];
	seats.splice(seed % 4, 0, 'script:fe');
	return seats;
}

const RESULT_MARK = '\n@@fe-result@@';
const params = values.params ? (JSON.parse(values.params) as Record<string, number>) : undefined;
const variants = values.variants
	? (JSON.parse(values.variants) as Record<string, Record<string, number>>)
	: undefined;
const loaded = loadCatalogSpec(values.data ?? 'local');
const catalogInfo = { source: loaded.source, path: loaded.path, hash: loaded.hash };

async function playSeeds(seeds: number[]): Promise<TableGameResult[]> {
	const rulesBrief = buildRulesBrief(loaded.catalog);
	const out: TableGameResult[] = [];
	for (const seed of seeds)
		for (const seats of seatingsFor(seed))
			out.push(
				await playTable({
					catalog: loaded.catalog,
					catalogInfo,
					seed,
					seats,
					params,
					variants,
					rulesBrief
				})
			);
	return out;
}

async function runWorkers(seeds: number[], jobs: number): Promise<TableGameResult[]> {
	const chunks: number[][] = Array.from({ length: Math.min(jobs, seeds.length) }, () => []);
	seeds.forEach((s, i) => chunks[i % chunks.length].push(s));
	const self = fileURLToPath(import.meta.url);
	const passArgs = process.argv.slice(2).filter((a, i, all) => {
		// Drop the options the parent sets itself.
		const prev = all[i - 1];
		return (
			!['--seeds', '--out', '--jobs'].includes(a) && !['--seeds', '--out', '--jobs'].includes(prev)
		);
	});
	const results = await Promise.all(
		chunks.map(
			(chunk) =>
				new Promise<TableGameResult[]>((res, rej) => {
					const child = spawn(
						process.execPath,
						[...process.execArgv, self, ...passArgs, '--worker', '--seeds', chunk.join(',')],
						{ stdio: ['ignore', 'pipe', 'inherit'] }
					);
					let buf = '';
					child.stdout.on('data', (d) => (buf += d));
					child.on('exit', (code) => {
						if (code !== 0)
							return rej(new Error(`worker for seeds ${chunk.join(',')} exited ${code}`));
						try {
							res(
								JSON.parse(
									buf.slice(buf.lastIndexOf(RESULT_MARK) + RESULT_MARK.length)
								) as TableGameResult[]
							);
						} catch (err) {
							rej(err);
						}
					});
				})
		)
	);
	return results.flat().sort((a, b) => a.seed - b.seed);
}

async function main() {
	const seeds = parseSeeds(values.seeds ?? '1-10');
	if (values.worker) {
		process.stdout.write(`${RESULT_MARK}${JSON.stringify(await playSeeds(seeds))}`);
		return;
	}
	const started = Date.now();
	const jobs = Math.max(1, Number(values.jobs));
	const games =
		jobs > 1 && seeds.length > 1 ? await runWorkers(seeds, jobs) : await playSeeds(seeds);
	const summary = summarizeFeRun(games);
	const result = {
		about:
			'Scripted Fighter + Elementalist player (scripts/agent-harness/scripted/run-fe.ts); no model calls.',
		catalog: catalogInfo,
		table: values.seats ?? values.table ?? 'fe4',
		seeds: values.seeds,
		params: params ?? {},
		seconds: Math.round((Date.now() - started) / 100) / 10,
		summary,
		games
	};
	if (values.out) {
		mkdirSync(dirname(resolve(values.out)), { recursive: true });
		writeFileSync(resolve(values.out), `${JSON.stringify(result, null, 1)}\n`);
	}
	if (!values.quiet) console.log(JSON.stringify({ ...result, games: undefined }, null, 2));
	else console.log(JSON.stringify(summary));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
