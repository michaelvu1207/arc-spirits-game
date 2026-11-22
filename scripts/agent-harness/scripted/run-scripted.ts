/**
 * Scripted players (`script:fe` Fighter + Elementalist, `script:beast` Beast): play many seeded
 * games offline (no model calls) and write one JSON result.
 *
 *   # four Beast players at one table, seeds 1-100
 *   npx tsx scripts/agent-harness/scripted/run-scripted.ts --data ../balance/scripted/rules-2026-11-22a/game \
 *       --table beast4 --seeds 1-100 --out ../balance/scripted/beast4.json
 *
 *   # two Beast and two Fighter + Elementalist players, seats alternating; every seed is played
 *   # twice, the second time with the two kinds' seats swapped
 *   npx tsx scripts/agent-harness/scripted/run-scripted.ts --table beast-fe --seeds 1-100
 *
 *   # one Beast player against three Fighter + Elementalist players (its seat is seed % 4)
 *   npx tsx scripts/agent-harness/scripted/run-scripted.ts --table beast-vs-fe --seeds 1-100
 *
 *   # any table: seat specs in seat order (script:fe, script:beast, mock:greedy, mock:random, mock:first)
 *   npx tsx scripts/agent-harness/scripted/run-scripted.ts --seats script:beast,mock:random,script:fe,mock:greedy
 *
 * Tables: fe4, beast4, beast-fe, beast-vs-fe, fe-vs-beast, fe-vs-greedy | -random | -first,
 * beast-vs-greedy | -random | -first, ab (two parameter sets of one policy, --policy fe | beast).
 * Options: --jobs N (parallel worker processes, default 8), --params '{"pace":1.3}' (policy
 * overrides for every scripted seat), --variants '{"a":{…},"b":{…}}' (for `ab`, or for seats
 * written `script:beast#a`), --quiet. A game depends only on its seed, seats and parameters.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalogSpec } from '../../../src/lib/play/agents/catalog';
import { buildRulesBrief } from '../../../src/lib/play/agents/rulesBrief';
import { playTable, type TableGameResult } from '../../../src/lib/play/agents/scripted/feGames';
import { summarizeFeRun } from '../../../src/lib/play/agents/scripted/feSummary';

type Params = Record<string, number>;

const TABLES =
	'fe4 | beast4 | beast-fe | beast-vs-fe | fe-vs-beast | fe-vs-greedy | fe-vs-random | fe-vs-first | beast-vs-greedy | beast-vs-random | beast-vs-first | ab';

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

/** One seat of kind `one` at position seed % 4 among three of kind `rest`. */
function oneAmong(one: string, rest: string, seed: number): string[] {
	const seats = [rest, rest, rest];
	seats.splice(seed % 4, 0, one);
	return seats;
}

/**
 * Seat specs of the games of a seed. Tables of two kinds with two seats each (`beast-fe`, `ab`)
 * play every seed twice, the second time with the kinds' seats swapped: the deal and the seat
 * positions cancel out. A "one against three" table puts the single seat at position seed % 4.
 */
export function seatingsFor(
	seed: number,
	opts: { table?: string; seats?: string; policy?: string }
): string[][] {
	if (opts.seats) return [opts.seats.split(',').map((s) => s.trim())];
	const table = opts.table ?? 'fe4';
	const pair = (a: string, b: string) => [
		[a, b, a, b],
		[b, a, b, a]
	];
	if (table === 'ab') {
		const policy = opts.policy ?? 'fe';
		return pair(`script:${policy}#a`, `script:${policy}#b`);
	}
	if (table === 'fe4') return [new Array(4).fill('script:fe')];
	if (table === 'beast4') return [new Array(4).fill('script:beast')];
	if (table === 'beast-fe') return pair('script:beast', 'script:fe');
	const m = /^(fe|beast)-vs-(fe|beast|greedy|random|first)$/.exec(table);
	if (!m || m[1] === m[2]) throw new Error(`unknown --table "${table}" (${TABLES})`);
	const rest = m[2] === 'fe' || m[2] === 'beast' ? `script:${m[2]}` : `mock:${m[2]}`;
	return [oneAmong(`script:${m[1]}`, rest, seed)];
}

const RESULT_MARK = '\n@@scripted-result@@';

export async function main(defaultTable = 'fe4'): Promise<void> {
	const { values } = parseArgs({
		options: {
			data: { type: 'string', default: 'local' },
			table: { type: 'string' },
			seats: { type: 'string' },
			policy: { type: 'string' },
			seeds: { type: 'string', default: '1-10' },
			jobs: { type: 'string', default: '8' },
			params: { type: 'string' },
			variants: { type: 'string' },
			out: { type: 'string' },
			worker: { type: 'boolean', default: false },
			quiet: { type: 'boolean', default: false }
		}
	});
	const table = values.table ?? defaultTable;
	const params = values.params ? (JSON.parse(values.params) as Params) : undefined;
	const variants = values.variants
		? (JSON.parse(values.variants) as Record<string, Params>)
		: undefined;
	const loaded = loadCatalogSpec(values.data ?? 'local');
	const catalogInfo = { source: loaded.source, path: loaded.path, hash: loaded.hash };

	async function playSeeds(seeds: number[]): Promise<TableGameResult[]> {
		const rulesBrief = buildRulesBrief(loaded.catalog);
		const out: TableGameResult[] = [];
		for (const seed of seeds)
			for (const seats of seatingsFor(seed, { table, seats: values.seats, policy: values.policy }))
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
		const own = ['--seeds', '--out', '--jobs', '--table'];
		const passArgs = process.argv.slice(2).filter((a, i, all) => {
			// Drop the options the parent sets itself.
			return !own.includes(a) && !own.includes(all[i - 1]);
		});
		const results = await Promise.all(
			chunks.map(
				(chunk) =>
					new Promise<TableGameResult[]>((res, rej) => {
						const child = spawn(
							process.execPath,
							[
								...process.execArgv,
								self,
								...passArgs,
								'--worker',
								'--table',
								table,
								'--seeds',
								chunk.join(',')
							],
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
		// Seed order; the games of one seed keep their seating order.
		return results
			.flat()
			.map((g, i) => ({ g, i }))
			.sort((a, b) => a.g.seed - b.g.seed || a.i - b.i)
			.map((x) => x.g);
	}

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
			'Scripted players (scripts/agent-harness/scripted/run-scripted.ts): script:fe Fighter + Elementalist, script:beast Beast; no model calls.',
		catalog: catalogInfo,
		table: values.seats ?? table,
		seeds: values.seeds,
		params: params ?? {},
		variants: variants ?? {},
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
