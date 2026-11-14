/**
 * Adaptive multi-seat tournament (resumable) over one or more gateway accounts. Plays batches of
 * balanced, seeded 4-seat games until the ranking is stable (see
 * src/lib/play/agents/tournament.ts for the schedule, ratings and stop rule).
 *
 *   npx tsx scripts/agent-harness/tournament.ts --dir ../tournament/run-1 \
 *     --catalog ../design-data/game --source-file ../SOURCE.json \
 *     --gw-urls http://127.0.0.1:4610/v1,http://127.0.0.1:4611/v1,http://127.0.0.1:4612/v1 \
 *     --gw-labels berkeley,gmail,simforge --gw-token-files <f1>,<f2>,<f3>
 *
 * - Accounts: each game is pinned to one account (all 4 seats), new games go to the account with
 *   the most free slots. Each account has its own call gate: a token bucket for call starts
 *   (adaptive rate), adaptive concurrency, and a short back-off on the per-minute turn limit.
 *   A real usage limit blocks the account until its reset; its games move to another account;
 *   when every account is blocked the run waits for the first reset (see gatewayPool.ts).
 * - Games in flight per account: found by steps (`--step-games 3,5,7,10`, each held
 *   `--step-min` minutes once filled); the first step with `--step-hits` or more limit hits
 *   settles the account one step lower. The step table is in STATUS.md and knee.json.
 * - Batches: games of the next batch may start when the current batch has no game left to start;
 *   the stop rule runs when a batch is complete, on the games of that batch and earlier.
 * - Quota: read every `--quota-every-min` minutes for the status only; `--quota-max-percent N`
 *   (default off) blocks an account at N% until its window resets.
 *
 * Start it again with the same --dir to resume: finished games (results/) are kept and skipped;
 * a game that was cut off is played again from its start (same seed). config.json keeps the
 * settings of the first start; later starts may change only the run settings (accounts, speed).
 *
 * Files in --dir: config.json, batches/b<NNN>.json, games/*.jsonl, results/*.json,
 * standings.md / standings.json, decisions.json, STATUS.md / status.json, knee.json, events.log.
 */

import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BudgetGuard } from '../../src/lib/play/agents/budget';
import { CallGate } from '../../src/lib/play/agents/callGate';
import { loadCatalogSpec } from '../../src/lib/play/agents/catalog';
import {
	HARNESS_VERSION,
	PROMPT_VERSION,
	type SeatController
} from '../../src/lib/play/agents/contract';
import { LlmSeatController } from '../../src/lib/play/agents/llmSeat';
import {
	assertGatewayModel,
	GATEWAY_HISTORIES,
	GatewayProvider,
	type GatewayHistory
} from '../../src/lib/play/agents/providers/gateway';
import {
	adaptiveAccountGate,
	GatewayPool,
	type GatewayAccount
} from '../../src/lib/play/agents/providers/gatewayPool';
import { MockProvider, type MockPolicy } from '../../src/lib/play/agents/providers/mock';
import { buildRulesBrief, sha256 } from '../../src/lib/play/agents/rulesBrief';
import { runAgentGame, type GameSummary } from '../../src/lib/play/agents/runner';
import {
	addToHistory,
	batchSchedule,
	computeStandings,
	emptyHistory,
	parseEntrant,
	renderStandingsMarkdown,
	scheduleStats,
	seatResults,
	stopDecision,
	type GameResult,
	type ScheduledGame,
	type ScheduleHistory,
	type StopDecision
} from '../../src/lib/play/agents/tournament';
import { JsonlStreamSink } from '../../src/lib/play/agents/transcript';

const DEFAULT_FIELD = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna']
	.flatMap((m) => ['low', 'medium', 'high'].map((e) => `gw:${m}@${e}`))
	.join(',');

const { values } = parseArgs({
	options: {
		dir: { type: 'string' },
		entrants: { type: 'string', default: DEFAULT_FIELD },
		seed: { type: 'string', default: '2026' },
		rounds: { type: 'string', default: '6' },
		'table-size': { type: 'string', default: '4' },
		'max-batches': { type: 'string', default: '10' },
		'tie-after': { type: 'string', default: '6' },
		'quota-max-percent': { type: 'string', default: 'off' },
		'quota-every-min': { type: 'string', default: '10' },
		catalog: { type: 'string', default: 'local' },
		'gw-urls': { type: 'string' },
		'gw-labels': { type: 'string' },
		'gw-token-files': { type: 'string' },
		'gw-token-file': { type: 'string' },
		'gw-api': { type: 'string', default: 'responses' },
		'gw-history': { type: 'string', default: 'messages' },
		/** Games in flight per account, by steps; the last value is the ceiling. */
		'step-games': { type: 'string', default: '3,5,7,10' },
		'step-min': { type: 'string', default: '5' },
		'step-hits': { type: 'string', default: '3' },
		/** A fixed number of games in flight per account (no steps). */
		'games-per-account': { type: 'string' },
		/** Mock-only runs: games at once. */
		'parallel-games': { type: 'string', default: '4' },
		/** Per account: calls in flight (ceiling), start rate and its ceiling (turns/min). */
		'max-concurrent-calls': { type: 'string', default: '40' },
		'calls-per-min': { type: 'string', default: '120' },
		'max-calls-per-min': { type: 'string', default: '300' },
		'max-decisions': { type: 'string', default: '3000' },
		'max-phase-decisions': { type: 'string', default: '30' },
		'max-output-tokens': { type: 'string', default: '400' },
		bootstrap: { type: 'string', default: '1000' },
		'source-file': { type: 'string' },
		/** Tests: stop after this many games of the run. */
		'limit-games': { type: 'string' },
		// Old options (accepted, not used).
		'ramp-parallel-games': { type: 'string' },
		'ramp-calls': { type: 'string' },
		'ramp-after-min': { type: 'string' },
		'max-limit-failures': { type: 'string' }
	}
});

const num = (name: string, min = 0): number => {
	const raw = values[name as keyof typeof values] as string | undefined;
	const v = Number(raw);
	if (raw === undefined || !Number.isFinite(v) || v < min)
		throw new Error(`--${name} must be a number ≥ ${min} (got "${raw ?? ''}")`);
	return v;
};
const list = (raw: string | undefined) =>
	(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

interface Config {
	name: string;
	createdAt: string;
	entrants: string[];
	seed: number;
	rounds: number;
	tableSize: number;
	maxBatches: number;
	tieAfter: number;
	/** The guard of the first start (the run setting `--quota-max-percent` replaces it). */
	quotaMaxPercent: number | null;
	gateway: { api: 'chat' | 'responses'; history: GatewayHistory };
	maxDecisions: number;
	maxPhaseDecisions: number;
	maxOutputTokens: number;
	catalog: { source: string; path: string; hash: string };
	rulesBriefSha256: string;
	promptVersion: string;
	harnessVersion: string;
	source: unknown;
	node: string;
}

interface KneeRow {
	account: string;
	games: number;
	minutes: number;
	calls: number;
	callsPerMin: number;
	tokensPerMin: number;
	p50Ms: number;
	p90Ms: number;
	limitHits: number;
	at: string;
}

interface AccountStatus {
	label: string;
	url: string;
	running: number;
	target: number;
	step: string;
	liveCap: number;
	ratePerMin: number;
	last10: ReturnType<GatewayAccount['window']>;
	quotaPercent: number | null;
	quotaWindows: string;
	percentPerMTokens: number | null;
	blockedUntil: string | null;
	blockReason: string | null;
	lastLimitError: string | null;
}

interface CostRow {
	game: string;
	account: string | null;
	rounds: number;
	minutes: number;
	inputM: number;
	cachedPct: number;
	outputK: number;
	reasoningK: number;
	estQuotaPercent: number | null;
}

interface Status {
	state: 'starting' | 'running' | 'waiting' | 'stopped' | 'done' | 'error';
	pid: number;
	host: string;
	startedAt: string;
	updatedAt: string;
	batch: number;
	batchGames: number;
	batchDone: number;
	totalDone: number;
	running: number;
	quotaGuard: string;
	accounts: AccountStatus[];
	knee: KneeRow[];
	costs: CostRow[];
	stopReason: string | null;
	lastEvent: string;
	leader: string | null;
}

interface ResultFile {
	result: GameResult;
	summary: GameSummary;
	account?: string | null;
	endAccount?: string | null;
}

async function main(): Promise<void> {
	if (!values.dir) throw new Error('give --dir <tournament folder>');
	const dir = resolve(values.dir);
	for (const sub of ['batches', 'games', 'games/cut-off', 'results', 'failed'])
		mkdirSync(join(dir, sub), { recursive: true });
	const eventsPath = join(dir, 'events.log');
	const status: Status = {
		state: 'starting',
		pid: process.pid,
		host: hostname(),
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		batch: 0,
		batchGames: 0,
		batchDone: 0,
		totalDone: 0,
		running: 0,
		quotaGuard: values['quota-max-percent'] ?? 'off',
		accounts: [],
		knee: [],
		costs: [],
		stopReason: null,
		lastEvent: '',
		leader: null
	};
	const event = (text: string) => {
		const line = `${new Date().toISOString()} ${text}`;
		console.log(line);
		appendFileSync(eventsPath, `${line}\n`);
		status.lastEvent = text;
	};

	// ---- config (first start) or resume
	const configPath = join(dir, 'config.json');
	const loaded = loadCatalogSpec(values.catalog ?? 'local');
	if (loaded.warning) console.warn(`warning: ${loaded.warning}`);
	const rulesBrief = buildRulesBrief(loaded.catalog);
	let config: Config;
	if (existsSync(configPath)) {
		config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
		if (config.catalog.hash !== loaded.hash)
			throw new Error(
				`catalog changed since the tournament started (${config.catalog.hash.slice(0, 12)} → ${loaded.hash.slice(0, 12)}); use the same data or a new --dir`
			);
		if (config.rulesBriefSha256 !== sha256(rulesBrief))
			throw new Error('the rules brief changed since the tournament started; use a new --dir');
		if (config.promptVersion !== PROMPT_VERSION)
			throw new Error(
				`prompt version changed (${config.promptVersion} → ${PROMPT_VERSION}); use a new --dir`
			);
	} else {
		const history = values['gw-history'] as GatewayHistory;
		if (!GATEWAY_HISTORIES.includes(history)) throw new Error(`unknown --gw-history "${history}"`);
		let source: unknown = null;
		if (values['source-file'])
			source = JSON.parse(readFileSync(resolve(values['source-file']), 'utf8'));
		else
			try {
				source = {
					commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
					dirtyFiles: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
						.split('\n')
						.filter(Boolean).length
				};
			} catch {
				source = { commit: null, note: 'no git here; pass --source-file' };
			}
		config = {
			name: dir.split('/').pop() ?? 'tournament',
			createdAt: new Date().toISOString(),
			entrants: list(values.entrants),
			seed: num('seed'),
			rounds: num('rounds', 1),
			tableSize: num('table-size', 2),
			maxBatches: num('max-batches', 1),
			tieAfter: num('tie-after', 1),
			quotaMaxPercent: values['quota-max-percent'] === 'off' ? null : num('quota-max-percent'),
			gateway: { api: values['gw-api'] === 'chat' ? 'chat' : 'responses', history },
			maxDecisions: num('max-decisions', 1),
			maxPhaseDecisions: num('max-phase-decisions', 1),
			maxOutputTokens: num('max-output-tokens', 16),
			catalog: { source: loaded.source, path: loaded.path, hash: loaded.hash },
			rulesBriefSha256: sha256(rulesBrief),
			promptVersion: PROMPT_VERSION,
			harnessVersion: HARNESS_VERSION,
			source,
			node: process.version
		};
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	}
	const { entrants } = config;
	for (const e of entrants) if (e.startsWith('gw:')) assertGatewayModel(gwModel(e));
	const hasGw = entrants.some((e) => e.startsWith('gw:'));
	const quotaGuard = values['quota-max-percent'] === 'off' ? null : num('quota-max-percent');

	// ---- accounts (one gateway each), providers, seats
	const steps = values['games-per-account']
		? [num('games-per-account', 1)]
		: list(values['step-games'])
				.map(Number)
				.filter((n) => n > 0);
	if (!steps.length) throw new Error('--step-games needs at least one number');
	// All numeric run settings are read here, so a bad value stops the start, not a running game.
	const stepMinMs = num('step-min', 0.01) * 60_000;
	const stepHits = num('step-hits', 1);
	const parallelGames = num('parallel-games', 1);
	const quotaEveryMs = num('quota-every-min', 0.1) * 60_000;
	let pool: GatewayPool | null = null;
	if (hasGw) {
		const urls = list(
			values['gw-urls'] ?? process.env.ARC_GATEWAY_URL ?? 'http://127.0.0.1:4610/v1'
		);
		const files = list(
			values['gw-token-files'] ?? process.env.ARC_GATEWAY_TOKEN_FILES ?? values['gw-token-file']
		);
		const labels = list(values['gw-labels']);
		pool = new GatewayPool(GatewayPool.specs(urls, files, labels), {
			target: steps[0],
			onEvent: (t) => event(t),
			gate: adaptiveAccountGate({
				maxConcurrent: num('max-concurrent-calls', 1),
				ratePerMin: num('calls-per-min', 1),
				maxRatePerMin: num('max-calls-per-min', 1)
			})
		});
	}
	const gwProviders = new Map<string, GatewayProvider>();
	const gw = (effort: string) => {
		let p = gwProviders.get(effort);
		if (!p) {
			p = new GatewayProvider({
				api: config.gateway.api,
				history: config.gateway.history,
				effort,
				pool: pool!
			});
			gwProviders.set(effort, p);
		}
		return p;
	};
	const mockGate = new CallGate({ maxConcurrent: 64 });
	const budget = new BudgetGuard({ maxSpendUsd: 0.01, maxTokens: Infinity, maxCalls: Infinity });
	const controllerFor = (entrant: string, seat: number, seed: number): SeatController => {
		if (entrant.startsWith('mock:')) {
			const policy = entrant.slice(5).split('#')[0] as MockPolicy;
			return new LlmSeatController({
				provider: new MockProvider({ policy, seed: seed * 31 + seat }),
				model: policy,
				budget,
				maxTokens: config.maxOutputTokens,
				gate: mockGate,
				label: entrant
			});
		}
		if (entrant.startsWith('gw:')) {
			const { effort } = parseEntrant(entrant);
			// No run-wide gate: each account's gate is applied inside the provider.
			return new LlmSeatController({
				provider: gw(effort),
				model: gwModel(entrant),
				budget,
				maxTokens: config.maxOutputTokens,
				label: entrant
			});
		}
		throw new Error(`entrant "${entrant}": use gw:<model>@<effort> or mock:<policy>[#n]`);
	};

	// ---- results, schedules, decisions
	const resultPath = (g: ScheduledGame) => join(dir, 'results', `${tag(g)}.json`);
	const readResultFiles = (): ResultFile[] =>
		readdirSync(join(dir, 'results'))
			.filter((f) => f.endsWith('.json'))
			.map((f) => JSON.parse(readFileSync(join(dir, 'results', f), 'utf8')) as ResultFile)
			.sort((a, b) => a.result.batch - b.result.batch || a.result.index - b.result.index);
	const readResults = () => readResultFiles().map((f) => f.result);
	const failedCount = (g: ScheduledGame) =>
		readdirSync(join(dir, 'failed')).filter((f) => f.startsWith(`${tag(g)}.`)).length;
	const decisionsPath = join(dir, 'decisions.json');
	const decisions: { batch: number; order: string[]; decision: StopDecision; at: string }[] =
		existsSync(decisionsPath) ? JSON.parse(readFileSync(decisionsPath, 'utf8')) : [];
	const samples = num('bootstrap', 10);
	const batches = new Map<number, ScheduledGame[]>();
	let scheduleHistory: ScheduleHistory = emptyHistory();
	const batchOf = (b: number): ScheduledGame[] => {
		for (let k = 1; k <= b; k++) {
			if (batches.has(k)) continue;
			const path = join(dir, 'batches', `b${pad(k)}.json`);
			let games: ScheduledGame[];
			if (existsSync(path)) games = JSON.parse(readFileSync(path, 'utf8')).games;
			else {
				games = batchSchedule(entrants, {
					batch: k,
					baseSeed: config.seed,
					rounds: config.rounds,
					tableSize: config.tableSize,
					history: scheduleHistory
				});
				writeFileSync(
					path,
					JSON.stringify(
						{ batch: k, games, stats: scheduleStats(entrants, games, config.tableSize) },
						null,
						2
					)
				);
			}
			scheduleHistory = addToHistory(scheduleHistory, games);
			batches.set(k, games);
		}
		return batches.get(b)!;
	};
	const writeStandings = (full: boolean, decision: StopDecision | null, upTo = Infinity) => {
		const results = readResults().filter((r) => r.batch <= upTo);
		if (!results.length) return;
		const standings = computeStandings(results, entrants, {
			samples: full ? samples : Math.min(samples, 200),
			seed: config.seed
		});
		writeFileSync(
			join(dir, 'standings.json'),
			JSON.stringify({ updatedAt: new Date().toISOString(), standings, decisions }, null, 2)
		);
		writeFileSync(
			join(dir, 'standings.md'),
			renderStandingsMarkdown(
				`Tournament ${config.name} — ${results.length} games`,
				standings,
				decision ?? decisions.at(-1)?.decision ?? null,
				decisions.map((d) => ({ batch: d.batch, order: d.order }))
			)
		);
		status.leader = standings.entrants[0]?.key ?? null;
	};

	// ---- status
	const statusPath = join(dir, 'status.json');
	const kneePath = join(dir, 'knee.json');
	if (existsSync(kneePath)) status.knee = JSON.parse(readFileSync(kneePath, 'utf8'));
	const stepState = new Map<
		string,
		{ index: number; holdStart: number | null; settled: boolean }
	>();
	for (const a of pool?.accounts ?? [])
		stepState.set(a.label, { index: 0, holdStart: null, settled: steps.length === 1 });
	const costRows = (): CostRow[] =>
		readResultFiles().map((f) => {
			const seats = f.result.seats;
			const input = seats.reduce((n, s) => n + s.promptTokens, 0);
			const cached = seats.reduce((n, s) => n + s.cachedPromptTokens, 0);
			const account = f.account ?? null;
			const rate = account ? (pool?.byLabel(account)?.percentPerMillionTokens() ?? null) : null;
			return {
				game: `b${pad(f.result.batch)}-g${String(f.result.index).padStart(2, '0')}`,
				account,
				rounds: f.result.rounds,
				minutes: Math.round(f.result.durationMs / 6000) / 10,
				inputM: Math.round(input / 1e5) / 10,
				cachedPct: input ? Math.round((100 * cached) / input) : 0,
				outputK: Math.round(seats.reduce((n, s) => n + s.completionTokens, 0) / 100) / 10,
				reasoningK: Math.round(seats.reduce((n, s) => n + s.reasoningTokens, 0) / 100) / 10,
				estQuotaPercent: rate === null ? null : Math.round(rate * (input / 1e6) * 10) / 10
			};
		});
	const writeStatus = () => {
		status.updatedAt = new Date().toISOString();
		status.running = running.size;
		status.accounts = (pool?.accounts ?? []).map((a) => {
			const st = stepState.get(a.label)!;
			return {
				label: a.label,
				url: a.url,
				running: a.games.size,
				target: a.target,
				step: st.settled
					? 'settled'
					: `${st.index + 1}/${steps.length}${st.holdStart ? ' holding' : ' filling'}`,
				liveCap: a.gate.liveCap,
				ratePerMin: Math.round(a.gate.ratePerMin),
				last10: a.window(Date.now() - 10 * 60_000),
				quotaPercent: a.usage?.usedPercent ?? null,
				quotaWindows: (a.usage?.windows ?? [])
					.map((w) => `${w.id} ${w.usedPercent ?? '?'}%`)
					.join(', '),
				percentPerMTokens: a.percentPerMillionTokens(),
				blockedUntil: a.blockedUntil ? new Date(a.blockedUntil).toISOString() : null,
				blockReason: a.blockReason,
				lastLimitError: a.gate.stats.lastLimitError
			};
		});
		status.costs = costRows();
		writeFileSync(statusPath, JSON.stringify(status, null, 2));
		writeFileSync(join(dir, 'STATUS.md'), renderStatus(status, config));
	};

	// ---- stop handling
	const abort = new AbortController();
	let stopReason: string | null = null;
	const stop = (reason: string) => {
		if (stopReason) return;
		stopReason = reason;
		status.stopReason = reason;
		// Written at once: the state must say "stopped" even if the process ends abruptly.
		status.state = 'stopped';
		event(`STOP: ${reason}`);
		writeStatus();
		abort.abort();
	};
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
		process.once(signal, () => stop(`stopped by a signal (${signal})`));

	// ---- quota (status only; an optional guard blocks an account until its reset)
	const checkQuota = async () => {
		if (!pool) return;
		await pool.refreshUsage();
		if (quotaGuard !== null)
			for (const a of pool.accounts)
				if ((a.usage?.usedPercent ?? 0) >= quotaGuard && !a.blocked()) {
					a.blockedUntil = a.usage?.resetsAt ?? Date.now() + 3600_000;
					a.blockReason = `quota guard: ${a.usage?.usedPercent}% ≥ ${quotaGuard}%`;
					event(`account ${a.label}: ${a.blockReason}`);
				}
	};
	const running = new Map<string, { promise: Promise<void>; account: string | null }>();
	if (pool) {
		await pool.check();
		await checkQuota();
		event(
			`accounts: ${pool.accounts.map((a) => `${a.label} ${a.url} (7-day ${a.usage?.usedPercent ?? '?'}%)`).join('; ')}; quota guard ${quotaGuard === null ? 'off' : `${quotaGuard}%`}`
		);
	}
	const quotaTimer = setInterval(() => void checkQuota().catch(() => {}), quotaEveryMs);
	const statusTimer = setInterval(() => writeStatus(), 30_000);

	if (decisions.at(-1)?.decision.stop) {
		status.state = 'done';
		status.stopReason = decisions.at(-1)!.decision.reason;
		writeStatus();
		event(`already finished: ${status.stopReason}`);
		clearInterval(quotaTimer);
		clearInterval(statusTimer);
		return;
	}

	// ---- one game
	const limitGames = values['limit-games'] !== undefined ? num('limit-games', 1) : Infinity;
	let started = 0;
	const gameIdOf = (g: ScheduledGame) => `${config.name}-g${g.batch * 1000 + g.index}-s${g.seed}`;
	const playOne = async (g: ScheduledGame, account: GatewayAccount | null) => {
		const transcript = join(dir, 'games', `${tag(g)}.jsonl`);
		if (existsSync(transcript))
			renameSync(transcript, join(dir, 'games', 'cut-off', `${tag(g)}.${Date.now()}.jsonl`));
		const sink = new JsonlStreamSink(transcript);
		const gameId = gameIdOf(g);
		let summary: GameSummary | null = null;
		try {
			summary = await runAgentGame({
				catalog: loaded.catalog,
				catalogInfo: config.catalog,
				seed: g.seed,
				controllers: g.seats.map((e, i) => controllerFor(e, i, g.seed)),
				rulesBrief,
				budget,
				runId: config.name,
				gameIndex: g.batch * 1000 + g.index,
				sink,
				maxDecisions: config.maxDecisions,
				maxPhaseDecisions: config.maxPhaseDecisions,
				git: {
					commit: (config.source as { commit?: string } | null)?.commit ?? null,
					dirtyFiles: null
				},
				headerOptions: { account: account?.label ?? null },
				signal: abort.signal
			});
		} catch (err) {
			event(`game ${tag(g)} error: ${(err as Error).message.slice(0, 200)}`);
		} finally {
			await sink.close();
			for (const p of gwProviders.values()) p.forgetGame(gameId);
		}
		const endAccount = pool?.labelOf(gameId) ?? null;
		pool?.release(gameId);
		if (!summary || summary.stopReason === 'aborted') return; // played again on resume
		if (summary.stopReason !== 'finished') {
			writeFileSync(
				join(dir, 'failed', `${tag(g)}.${failedCount(g) + 1}.json`),
				JSON.stringify(
					{
						game: g,
						account: account?.label ?? null,
						stopReason: summary.stopReason,
						stopDetail: summary.stopDetail,
						summary
					},
					null,
					2
				)
			);
			event(
				`game ${tag(g)} did not finish (${summary.stopReason}${summary.stopDetail ? `: ${summary.stopDetail}` : ''})`
			);
			return;
		}
		const result = toResult(g, summary);
		const file: ResultFile = { result, summary, account: account?.label ?? null, endAccount };
		writeFileSync(resultPath(g), JSON.stringify(file, null, 2));
		const top = [...result.seats].sort((a, b) => a.place - b.place);
		const input = result.seats.reduce((n, s) => n + s.promptTokens, 0);
		event(
			`game ${tag(g)} done on ${account?.label ?? 'local'} in ${(summary.durationMs / 60_000).toFixed(1)} min, round ${summary.rounds}, ${(input / 1e6).toFixed(1)}M input tokens: ${top.map((s) => `${short(s.entrant)} ${s.finalVp}`).join(' > ')}`
		);
		writeStandings(false, null);
		writeStatus();
	};

	// ---- the scheduler: batches in order, one batch of look-ahead, slots per account
	let current = (decisions.at(-1)?.batch ?? 0) + 1;
	let stopLaunching = false;
	const done = (g: ScheduledGame) => existsSync(resultPath(g)) || failedCount(g) >= 2;
	const startable = (b: number) =>
		b <= config.maxBatches ? batchOf(b).filter((g) => !done(g) && !running.has(tag(g))) : [];
	const decideBatch = (b: number) => {
		const results = readResults().filter((r) => r.batch <= b);
		const standings = computeStandings(results, entrants, { samples, seed: config.seed });
		const decision = stopDecision(b, standings.entrants, decisions.at(-1)?.order ?? null, {
			tieAfter: config.tieAfter,
			maxBatches: config.maxBatches
		});
		decisions.push({
			batch: b,
			order: standings.entrants.map((r) => r.key),
			decision,
			at: new Date().toISOString()
		});
		writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));
		writeStandings(true, decision, b);
		event(
			`batch ${b} complete (${results.filter((r) => r.batch === b).length} games): ${decision.stop ? 'STOP' : 'continue'} — ${decision.reason}`
		);
		return decision;
	};
	const kneeTick = () => {
		if (!pool) return;
		const now = Date.now();
		for (const a of pool.accounts) {
			const st = stepState.get(a.label)!;
			if (st.settled || a.blocked()) continue;
			if (st.holdStart === null) {
				if (a.games.size >= a.target) st.holdStart = now;
				continue;
			}
			if (now - st.holdStart < stepMinMs) continue;
			const w = a.window(st.holdStart, now);
			const row: KneeRow = {
				account: a.label,
				games: a.target,
				...w,
				at: new Date().toISOString()
			};
			status.knee.push(row);
			writeFileSync(kneePath, JSON.stringify(status.knee, null, 2));
			const hits = w.limitHits >= stepHits;
			if (hits || st.index >= steps.length - 1) {
				st.settled = true;
				if (hits && st.index > 0) a.target = steps[st.index - 1];
				event(
					`account ${a.label}: ${a.target} games in flight (step ${row.games}: ${w.callsPerMin} calls/min, ${Math.round(w.tokensPerMin / 1000)}k tokens/min, p50 ${(w.p50Ms / 1000).toFixed(1)} s, p90 ${(w.p90Ms / 1000).toFixed(1)} s, ${w.limitHits} limit hits)`
				);
			} else {
				st.index += 1;
				st.holdStart = null;
				a.target = steps[st.index];
				event(
					`account ${a.label}: step to ${a.target} games (${row.games} games: ${w.callsPerMin} calls/min, ${w.limitHits} limit hits)`
				);
			}
		}
	};
	status.state = 'running';
	status.batch = current;
	writeStatus();
	event(`resume at batch ${current}; steps ${steps.join('→')} games per account`);
	while (!stopReason) {
		// Decide every complete batch in order.
		while (!stopLaunching && current <= config.maxBatches) {
			const games = batchOf(current);
			if (!games.every(done)) break;
			const decision = decideBatch(current);
			current += 1;
			if (decision.stop) {
				stopLaunching = true;
				status.state = 'done';
				status.stopReason = decision.reason;
			}
		}
		if (current > config.maxBatches) stopLaunching = true;
		status.batch = Math.min(current, config.maxBatches);
		const batchGames = current <= config.maxBatches ? batchOf(current) : [];
		status.batchGames = batchGames.length;
		status.batchDone = batchGames.filter((g) => existsSync(resultPath(g))).length;
		status.totalDone = readdirSync(join(dir, 'results')).filter((f) => f.endsWith('.json')).length;
		// Start games while slots are free: the current batch first, then one batch ahead.
		if (!stopLaunching && started < limitGames) {
			let queue = startable(current);
			if (!queue.length) queue = startable(current + 1);
			for (const g of queue) {
				if (started >= limitGames) break;
				let account: GatewayAccount | null = null;
				if (pool) {
					const best = pool.leastLoaded();
					if (!best || pool.free(best) <= 0) break;
					account = best;
					pool.assign(gameIdOf(g), account);
				} else if (running.size >= parallelGames) break;
				started += 1;
				const promise = playOne(g, account).finally(() => running.delete(tag(g)));
				running.set(tag(g), { promise, account: account?.label ?? null });
				event(
					`game ${tag(g)} started${account ? ` on ${account.label}` : ''} (${running.size} running)`
				);
			}
		}
		if (!running.size) {
			if (stopLaunching || started >= limitGames) break;
			if (pool && pool.nextReset() !== null) {
				status.state = 'waiting';
				writeStatus();
				await pool.waitForOpen(abort.signal).catch(() => {});
				status.state = 'running';
				continue;
			}
			if (!startable(current).length && !startable(current + 1).length) break;
		}
		await Promise.race([
			...[...running.values()].map((r) => r.promise),
			new Promise((r) => setTimeout(r, 5_000))
		]);
		kneeTick();
	}
	if (stopReason) await Promise.allSettled([...running.values()].map((r) => r.promise));
	clearInterval(quotaTimer);
	clearInterval(statusTimer);
	if (stopReason) status.state = 'stopped';
	else if (status.state !== 'done') {
		status.state = started >= limitGames ? 'stopped' : 'done';
		if (started >= limitGames) status.stopReason = `test limit: ${limitGames} games`;
	}
	writeStandings(false, null);
	writeStatus();
	event(`exit: ${status.state}${status.stopReason ? ` — ${status.stopReason}` : ''}`);
}

function gwModel(entrant: string): string {
	const body = entrant.slice(3);
	const id = body.includes('@') ? body.slice(0, body.lastIndexOf('@')) : body;
	return id.includes('/') ? id : `openai-codex/${id}`;
}

function toResult(g: ScheduledGame, s: GameSummary): GameResult {
	const seats = g.seats.map((entrant, i) => {
		const seat = s.seats[i];
		if (seat.controller !== entrant)
			throw new Error(`seat ${i} is ${seat.controller}, expected ${entrant}`);
		return seat;
	});
	return {
		batch: g.batch,
		index: g.index,
		seed: g.seed,
		rounds: s.rounds,
		stopReason: s.stopReason,
		durationMs: s.durationMs,
		seats: seatResults(s, seats.map((seat) => seat.controller))
	};
}

const pad = (n: number) => String(n).padStart(3, '0');
const tag = (g: ScheduledGame) => `b${pad(g.batch)}-g${String(g.index).padStart(2, '0')}`;
const short = (e: string) => e.replace(/^gw:/, '');

function hostname(): string {
	try {
		return execFileSync('hostname', { encoding: 'utf8' }).trim();
	} catch {
		return '?';
	}
}

function renderStatus(s: Status, c: Config): string {
	const alive = s.state === 'running' || s.state === 'starting' || s.state === 'waiting';
	const lines = [
		`# Tournament ${c.name}: ${s.state.toUpperCase()}`,
		'',
		`- Updated: ${s.updatedAt} (pid ${s.pid} on ${s.host}${alive ? '' : ', exited'})`,
		`- Batch ${s.batch}: ${s.batchDone}/${s.batchGames} games done; ${s.totalDone} finished games in all; ${s.running} running`,
		`- Quota guard: ${s.quotaGuard === 'off' ? 'off (quota read for this page only)' : `${s.quotaGuard}% per account`}`,
		`- Leader: ${s.leader ? short(s.leader) : '-'} (see standings.md)`,
		`- Stop reason: ${s.stopReason ?? '-'}`,
		`- Last event: ${s.lastEvent}`,
		''
	];
	if (s.accounts.length)
		lines.push(
			'## Accounts',
			'',
			'| account | games running / target | step | live call cap | rate/min | calls/min (10 min) | k tokens/min | p50 / p90 s | limit hits (10 min) | 7-day quota | % per 1M tokens | blocked until |',
			'|---|---|---|---:|---:|---:|---:|---|---:|---|---:|---|',
			...s.accounts.map(
				(a) =>
					`| ${a.label} | ${a.running} / ${a.target} | ${a.step} | ${a.liveCap} | ${a.ratePerMin} | ${a.last10.callsPerMin} | ${Math.round(a.last10.tokensPerMin / 1000)} | ${(a.last10.p50Ms / 1000).toFixed(1)} / ${(a.last10.p90Ms / 1000).toFixed(1)} | ${a.last10.limitHits} | ${a.quotaWindows || '?'} | ${a.percentPerMTokens === null ? '-' : a.percentPerMTokens.toFixed(3)} | ${a.blockedUntil ? `${a.blockedUntil} (${a.blockReason})` : '-'} |`
			),
			'',
			...s.accounts
				.filter((a) => a.lastLimitError)
				.map((a) => `- ${a.label} last limit message: ${a.lastLimitError!.slice(0, 160)}`),
			''
		);
	if (s.knee.length)
		lines.push(
			'## Games in flight by steps (per account)',
			'',
			'| account | games | minutes | calls/min | k tokens/min | p50 s | p90 s | limit hits |',
			'|---|---:|---:|---:|---:|---:|---:|---:|',
			...s.knee.map(
				(k) =>
					`| ${k.account} | ${k.games} | ${k.minutes} | ${k.callsPerMin} | ${Math.round(k.tokensPerMin / 1000)} | ${(k.p50Ms / 1000).toFixed(1)} | ${(k.p90Ms / 1000).toFixed(1)} | ${k.limitHits} |`
			),
			''
		);
	if (s.costs.length)
		lines.push(
			'## Cost per finished game (measured)',
			'',
			'Input tokens include cached ones. Est. quota % = input tokens × the account’s measured % per 1M tokens (when known).',
			'',
			'| game | account | rounds | minutes | input M | cached % | output k | reasoning k | est. quota % |',
			'|---|---|---:|---:|---:|---:|---:|---:|---:|',
			...s.costs.map(
				(r) =>
					`| ${r.game} | ${r.account ?? '-'} | ${r.rounds} | ${r.minutes} | ${r.inputM} | ${r.cachedPct} | ${r.outputK} | ${r.reasoningK} | ${r.estQuotaPercent ?? '-'} |`
			),
			''
		);
	lines.push(
		`Entrants: ${c.entrants.map(short).join(', ')}. Seed ${c.seed}; ${c.rounds} rounds per batch; gateway ${c.gateway.api}/${c.gateway.history}; catalog ${c.catalog.hash.slice(0, 12)}; prompt ${c.promptVersion}.`,
		''
	);
	return lines.join('\n');
}

main().catch((err) => {
	console.error(`error: ${(err as Error).message}`);
	try {
		if (values.dir) {
			const dir = resolve(values.dir);
			appendFileSync(
				join(dir, 'events.log'),
				`${new Date().toISOString()} ERROR: ${(err as Error).message}\n`
			);
			const statusPath = join(dir, 'status.json');
			if (existsSync(statusPath)) {
				const s = JSON.parse(readFileSync(statusPath, 'utf8')) as Status;
				s.state = 'error';
				s.stopReason = (err as Error).message;
				s.updatedAt = new Date().toISOString();
				writeFileSync(statusPath, JSON.stringify(s, null, 2));
				const cfgPath = join(dir, 'config.json');
				if (existsSync(cfgPath))
					writeFileSync(
						join(dir, 'STATUS.md'),
						renderStatus(
							{ ...s, accounts: s.accounts ?? [], knee: s.knee ?? [], costs: s.costs ?? [] },
							JSON.parse(readFileSync(cfgPath, 'utf8')) as Config
						)
					);
			}
		}
	} catch {
		// keep the first error
	}
	// Exit at once: games must not go on without the scheduler (run-loop.sh starts it again).
	process.exit(1);
});
