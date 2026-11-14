/**
 * One simulation job (Step 3 entry point; started detached by run-sim.sh).
 *
 *   npx tsx scripts/agent-harness/sim/sim.ts --run-id <id> --data <design dir> [--baseline <design dir>]
 *        [--games 4] [--model gw:gpt-6.1-sol] [--effort low] [--strategies fire,moon-evil,barrier-hunter,free]
 *        [--seed 1] [--parallel-games 2] [--max-concurrent-calls 8] [--max-decisions 3000]
 *
 * Writes into ~/arcspirits-harness/runs/<id>/ (or --runs-root):
 *   status.json            state queued | running | done | failed, games done / total, times, message
 *   new/                   the run on --data (transcripts, summary, strategy-report.{json,md}, catalog copy)
 *   baseline/              the run on --baseline, same seeds, seats and strategies (unless reused)
 *   compare.{json,md}      before/after, when --baseline is given
 *
 * A finished baseline run with the same catalog hash, seeds, seats, strategies, effort, decision
 * cap and harness version (its job.json) is reused instead of playing again. A gateway usage
 * stop (the harness's call gate or quota check) ends the job as failed with that message, and
 * no further games start.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	closeSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCatalogSpec } from '../../../src/lib/play/agents/catalog';
import { HARNESS_VERSION } from '../../../src/lib/play/agents/contract';
import { writeCompare } from '../../../src/lib/play/agents/strategyCompare';
import { runTranscripts } from '../../../src/lib/play/agents/strategyReport';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TS = join(HERE, '..', 'run.ts');
export const DEFAULT_RUNS_ROOT = join(homedir(), 'arcspirits-harness', 'runs');

const { values } = parseArgs({
	options: {
		'run-id': { type: 'string' },
		'runs-root': { type: 'string', default: DEFAULT_RUNS_ROOT },
		data: { type: 'string' },
		baseline: { type: 'string' },
		games: { type: 'string', default: '4' },
		model: { type: 'string', default: 'gw:gpt-6.1-sol' },
		effort: { type: 'string', default: 'low' },
		strategies: { type: 'string', default: 'fire,moon-evil,barrier-hunter,free' },
		seed: { type: 'string', default: '1' },
		'parallel-games': { type: 'string', default: '2' },
		'max-concurrent-calls': { type: 'string', default: '8' },
		'max-decisions': { type: 'string', default: '3000' }
	}
});

type State = 'queued' | 'running' | 'done' | 'failed';

interface Status {
	runId: string;
	state: State;
	gamesDone: number;
	gamesTotal: number;
	started: string;
	updated: string;
	message: string;
	/** What is playing now: the new data, the baseline, or the reports. */
	step: 'new' | 'baseline' | 'reports' | null;
	pid: number;
	params: Record<string, string | null>;
	dataHash: string | null;
	baselineHash: string | null;
	/** A finished baseline run that was reused instead of playing again. */
	baselineReusedFrom: string | null;
	outputs: {
		newRun: string;
		strategyReport: { json: string; md: string };
		baselineRun: string | null;
		baselineStrategyReport: { json: string; md: string } | null;
		compare: { json: string; md: string } | null;
	};
}

/** What makes two runs the same games (job.json in each sub-run folder). */
interface JobKey {
	catalogHash: string;
	model: string;
	effort: string;
	strategies: string;
	games: number;
	seed: number;
	rotate: true;
	maxDecisions: number;
	harnessVersion: string;
}

const runId =
	values['run-id'] ??
	`sim-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
const runDir = resolve(values['runs-root']!, runId);
const statusPath = join(runDir, 'status.json');
const reportPaths = (dir: string) => ({
	json: join(dir, 'strategy-report.json'),
	md: join(dir, 'strategy-report.md')
});

const status: Status = {
	runId,
	state: 'queued',
	gamesDone: 0,
	gamesTotal: 0,
	started: new Date().toISOString(),
	updated: new Date().toISOString(),
	message: 'queued',
	step: null,
	pid: process.pid,
	params: {
		data: values.data ? resolve(values.data) : null,
		baseline: values.baseline ? resolve(values.baseline) : null,
		games: values.games!,
		model: values.model!,
		effort: values.effort!,
		strategies: values.strategies!,
		seed: values.seed!
	},
	dataHash: null,
	baselineHash: null,
	baselineReusedFrom: null,
	outputs: {
		newRun: join(runDir, 'new'),
		strategyReport: reportPaths(join(runDir, 'new')),
		baselineRun: null,
		baselineStrategyReport: null,
		compare: null
	}
};

function save(patch: Partial<Status> = {}): void {
	Object.assign(status, patch, { updated: new Date().toISOString() });
	// Write then rename: a reader never sees half a file.
	writeFileSync(`${statusPath}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
	renameSync(`${statusPath}.tmp`, statusPath);
}

/** Finished games in a run folder: transcripts that end with a result record. */
function finishedGames(dir: string): number {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const path of runTranscripts(dir)) {
		const size = statSync(path).size;
		const length = Math.min(size, 256 * 1024);
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, 'r');
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		if (buffer.toString('utf8').includes('"type":"result"')) n += 1;
	}
	return n;
}

interface RunOutcome {
	ok: boolean;
	message: string;
	/** True when the gateway account hit a usage limit or the quota guard. */
	usageStop: boolean;
}

function readSummary(dir: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The outcome of a finished run folder, from its summary.json. */
function outcomeOf(dir: string, games: number, exitCode: number | null): RunOutcome {
	const summary = readSummary(dir);
	if (!summary)
		return {
			ok: false,
			message: `run ended (exit ${exitCode}) without a summary`,
			usageStop: false
		};
	const stats = (summary.runStats ?? {}) as { stoppedReason?: string; usageStop?: string };
	const finished = (summary.games as unknown[]).length;
	const failures = (summary.failures as unknown[]).length;
	if (stats.stoppedReason || stats.usageStop)
		return {
			ok: false,
			message: `stopped for the gateway account: ${stats.usageStop ?? stats.stoppedReason}`,
			usageStop: true
		};
	if (finished < games || failures)
		return {
			ok: false,
			message: `${finished} of ${games} games finished, ${failures} failed`,
			usageStop: false
		};
	return { ok: true, message: 'ok', usageStop: false };
}

let child: ReturnType<typeof spawn> | null = null;
let stopping = false;

/** Play one run with run.ts into `dir`; status counts its finished games on top of `doneBefore`. */
async function play(
	dataDir: string,
	sub: 'new' | 'baseline',
	key: JobKey,
	doneBefore: number
): Promise<RunOutcome> {
	const dir = join(runDir, sub);
	const args = [
		'--import',
		'tsx',
		RUN_TS,
		'--catalog',
		dataDir,
		'--out',
		runDir,
		'--run-id',
		sub,
		'--model',
		key.model,
		'--strategies',
		key.strategies,
		'--rotate',
		'--games',
		String(key.games),
		'--seed',
		String(key.seed),
		'--gw-effort',
		key.effort,
		'--codex-effort',
		key.effort,
		'--max-decisions',
		String(key.maxDecisions),
		'--parallel-games',
		values['parallel-games']!,
		'--max-concurrent-calls',
		values['max-concurrent-calls']!,
		'--quiet'
	];
	save({
		step: sub,
		message: `playing ${key.games} game(s) on the ${sub === 'new' ? 'new' : 'baseline'} data`
	});
	const log = openSync(join(runDir, `${sub}.log`), 'a');
	const exitCode = await new Promise<number | null>((done) => {
		child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', log, log] });
		const tick = setInterval(() => save({ gamesDone: doneBefore + finishedGames(dir) }), 5_000);
		child.on('exit', (code) => {
			clearInterval(tick);
			child = null;
			done(code);
		});
	});
	closeSync(log);
	save({ gamesDone: doneBefore + finishedGames(dir) });
	if (stopping) return { ok: false, message: 'stopped by a signal', usageStop: false };
	const outcome = outcomeOf(dir, key.games, exitCode);
	if (outcome.ok || existsSync(join(dir, 'summary.json')))
		writeFileSync(
			join(dir, 'job.json'),
			`${JSON.stringify({ ...key, complete: outcome.ok }, null, 2)}\n`
		);
	return outcome;
}

/** A complete earlier run of the same games on the same catalog (newest first), or null. */
function reusableRun(key: JobKey): string | null {
	const root = resolve(values['runs-root']!);
	const found: { dir: string; mtime: number }[] = [];
	for (const id of existsSync(root) ? readdirSync(root) : []) {
		if (id === runId) continue;
		for (const sub of ['new', 'baseline']) {
			const dir = join(root, id, sub);
			try {
				const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as JobKey & {
					complete: boolean;
				};
				const same = (Object.keys(key) as (keyof JobKey)[]).every((k) => job[k] === key[k]);
				if (same && job.complete && existsSync(join(dir, 'strategy-report.json')))
					found.push({ dir, mtime: statSync(join(dir, 'job.json')).mtimeMs });
			} catch {
				// no job.json: not a sim run
			}
		}
	}
	return found.sort((a, b) => b.mtime - a.mtime)[0]?.dir ?? null;
}

async function main(): Promise<void> {
	mkdirSync(runDir, { recursive: true });
	save();
	if (!values.data) throw new Error('give --data <design data dir>');
	const games = Number(values.games);
	const seed = Number(values.seed);
	const maxDecisions = Number(values['max-decisions']);
	if (!Number.isInteger(games) || games < 1) throw new Error('--games must be an integer ≥ 1');
	if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
	const dataHash = loadCatalogSpec(resolve(values.data)).hash;
	const baselineHash = values.baseline ? loadCatalogSpec(resolve(values.baseline)).hash : null;
	const keyFor = (catalogHash: string): JobKey => ({
		catalogHash,
		model: values.model!,
		effort: values.effort!,
		strategies: values.strategies!,
		games,
		seed,
		rotate: true,
		maxDecisions,
		harnessVersion: HARNESS_VERSION
	});
	const reuse = baselineHash ? reusableRun(keyFor(baselineHash)) : null;
	save({
		state: 'running',
		dataHash,
		baselineHash,
		baselineReusedFrom: reuse,
		gamesTotal: games * (baselineHash && !reuse ? 2 : 1),
		message: 'starting'
	});

	const fresh = await play(resolve(values.data), 'new', keyFor(dataHash), 0);
	if (!fresh.ok) return save({ state: 'failed', step: null, message: fresh.message });

	let baselineDir: string | null = null;
	if (baselineHash) {
		if (reuse) baselineDir = reuse;
		else {
			const base = await play(resolve(values.baseline!), 'baseline', keyFor(baselineHash), games);
			if (!base.ok)
				return save({ state: 'failed', step: null, message: `baseline: ${base.message}` });
			baselineDir = join(runDir, 'baseline');
		}
	}
	save({ step: 'reports', message: 'writing reports' });
	const outputs = { ...status.outputs };
	if (baselineDir) {
		writeCompare(baselineDir, join(runDir, 'new'), runDir);
		outputs.baselineRun = baselineDir;
		outputs.baselineStrategyReport = reportPaths(baselineDir);
		outputs.compare = { json: join(runDir, 'compare.json'), md: join(runDir, 'compare.md') };
	}
	save({
		state: 'done',
		step: null,
		outputs,
		message: baselineDir
			? `done: ${games} game(s) on each data set${reuse ? ' (baseline reused)' : ''}`
			: `done: ${games} game(s)`
	});
}

for (const signal of ['SIGTERM', 'SIGINT'] as const)
	process.on(signal, () => {
		stopping = true;
		// run.ts stops after its current calls on SIGINT and still writes its summary.
		child?.kill('SIGINT');
		if (!child) {
			save({ state: 'failed', step: null, message: 'stopped by a signal' });
			process.exit(1);
		}
	});

main()
	.then(() => {
		if (stopping && status.state === 'running')
			save({ state: 'failed', step: null, message: 'stopped by a signal' });
	})
	.catch((err) => {
		save({ state: 'failed', step: null, message: `error: ${(err as Error).message}` });
		process.exitCode = 1;
	});
