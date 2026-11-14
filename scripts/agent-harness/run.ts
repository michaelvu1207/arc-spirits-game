/**
 * Agent harness CLI — run LLM (or mock) agents through full Arc Spirits games, headless.
 *
 *   npx tsx scripts/agent-harness/run.ts --seats mock:random,mock:random
 *   npx tsx scripts/agent-harness/run.ts --seats codex,codex --max-decisions 60   # gpt-6.1-sol via Codex CLI
 *   npx tsx scripts/agent-harness/run.ts --seats or:openai/gpt-4o-mini,mock:random --max-spend 0.5
 *   npx tsx scripts/agent-harness/run.ts --seats mock:random,mock:first,mock:random --games 5 --rotate
 *   npx tsx scripts/agent-harness/run.ts --replay output/agent-harness/<run>/game-0.jsonl
 *   npx tsx scripts/agent-harness/run.ts --brief            # print the rules brief and exit
 *   npx tsx scripts/agent-harness/run.ts --strategies fire,moon-evil,barrier-hunter,free --rotate --games 4
 *                                       # one model (--model, default gw:gpt-6.1-sol), a strategy per seat
 *
 * See scripts/agent-harness/README.md.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BudgetGuard, DEFAULT_BUDGET } from '../../src/lib/play/agents/budget';
import { CallGate } from '../../src/lib/play/agents/callGate';
import { loadCatalogSpec } from '../../src/lib/play/agents/catalog';
import type { SeatController } from '../../src/lib/play/agents/contract';
import { LlmSeatController } from '../../src/lib/play/agents/llmSeat';
import {
	CODEX_DEFAULT_MODEL,
	CodexProvider,
	codexVersion
} from '../../src/lib/play/agents/providers/codex';
import {
	assertGatewayModel,
	GATEWAY_DEFAULT_MODEL,
	GatewayProvider,
	type GatewayHistory
} from '../../src/lib/play/agents/providers/gateway';
import { MockProvider, type MockPolicy } from '../../src/lib/play/agents/providers/mock';
import { OpenRouterProvider } from '../../src/lib/play/agents/providers/openrouter';
import { buildRulesBrief, sha256 } from '../../src/lib/play/agents/rulesBrief';
import { runAgentGame, type GameSummary } from '../../src/lib/play/agents/runner';
import { saveRunCatalog } from '../../src/lib/play/agents/runCatalog';
import { loadStrategies, pickStrategies, type Strategy } from '../../src/lib/play/agents/strategy';
import { writeStrategyReport } from '../../src/lib/play/agents/strategyReport';
import {
	JsonlStreamSink,
	readTranscript,
	replayTranscript
} from '../../src/lib/play/agents/transcript';
import {
	aggregateByModel,
	renderSummaryMarkdown,
	renderTournamentMarkdown,
	tournamentTable
} from '../../src/lib/play/agents/report';

const { values } = parseArgs({
	options: {
		// Default: mock:random,mock:random, or one --model seat per strategy with --strategies.
		seats: { type: 'string' },
		strategies: { type: 'string' },
		'strategies-file': {
			type: 'string',
			default: join(dirname(fileURLToPath(import.meta.url)), 'strategies.json')
		},
		model: { type: 'string', default: 'gw:gpt-6.1-sol' },
		games: { type: 'string', default: '1' },
		seed: { type: 'string', default: '1' },
		rotate: { type: 'boolean', default: false },
		catalog: { type: 'string', default: 'local' },
		out: { type: 'string', default: 'output/agent-harness' },
		'run-id': { type: 'string' },
		'max-spend': { type: 'string', default: '0.25' },
		'max-tokens': { type: 'string' },
		'max-calls': { type: 'string' },
		'max-decisions': { type: 'string', default: '3000' },
		'max-phase-decisions': { type: 'string', default: '30' },
		'max-output-tokens': { type: 'string', default: '400' },
		temperature: { type: 'string' },
		'ask-forced': { type: 'boolean', default: false },
		'no-parallel': { type: 'boolean', default: false },
		'parallel-games': { type: 'string', default: '1' },
		'gw-urls': { type: 'string' },
		'gw-token-file': { type: 'string' },
		'gw-effort': { type: 'string', default: 'high' },
		'gw-api': { type: 'string', default: 'responses' },
		'gw-history': { type: 'string', default: 'messages' },
		tournament: { type: 'string' },
		'pair-games': { type: 'string', default: '2' },
		'usage-check-games': { type: 'string', default: '4' },
		'usage-max-percent': { type: 'string', default: '25' },
		'max-concurrent-calls': { type: 'string', default: '8' },
		'max-limit-failures': { type: 'string', default: '3' },
		'max-calls-per-min': { type: 'string' },
		'codex-effort': { type: 'string', default: 'high' },
		'codex-session': { type: 'string', default: 'resume' },
		'codex-timeout': { type: 'string', default: '300' },
		'codex-concurrency': { type: 'string' },
		replay: { type: 'string' },
		brief: { type: 'boolean', default: false },
		quiet: { type: 'boolean', default: false }
	}
});

/** A numeric option: finite and ≥ min (and an integer when asked), else stop with a message. */
function num(
	name: string,
	raw: string | undefined,
	opts: { min?: number; int?: boolean } = {}
): number {
	const value = Number(raw);
	const min = opts.min ?? 0;
	if (
		raw === undefined ||
		raw.trim() === '' ||
		!Number.isFinite(value) ||
		value < min ||
		(opts.int && !Number.isInteger(value))
	) {
		throw new Error(
			`--${name} must be ${opts.int ? 'an integer' : 'a number'} ≥ ${min} (got "${raw ?? ''}")`
		);
	}
	return value;
}

function git(): { commit: string | null; dirtyFiles: number | null } {
	try {
		const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
		const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
			.split('\n')
			.filter(Boolean).length;
		return { commit, dirtyFiles: dirty };
	} catch {
		return { commit: null, dirtyFiles: null };
	}
}

/** Seat specs: mock:<policy>, codex[:<model>], or:<model>; a bare model id means codex. */
const KNOWN_KINDS = ['mock', 'codex', 'or', 'openrouter', 'gw'];
// A bare id without a colon is a Codex model; an unknown `kind:` is an error, not a model.
const isCodexSpec = (spec: string) =>
	spec === 'codex' || spec.startsWith('codex:') || (!spec.includes(':') && spec !== 'gw');
const isGatewaySpec = (spec: string) => spec === 'gw' || spec.startsWith('gw:');
/**
 * `gw:<model>[@<effort>]`: `gw:gpt-6.1-sol` is short for `gw:openai-codex/gpt-6.1-sol`; the effort
 * after `@` is per seat (default --gw-effort).
 */
const GW_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function gwSeat(arg: string): { model: string; effort: string } {
	const at = arg.lastIndexOf('@');
	const id = at >= 0 ? arg.slice(0, at) : arg;
	const effort = at >= 0 ? arg.slice(at + 1) : (values['gw-effort'] ?? 'high');
	if (!GW_EFFORTS.includes(effort))
		throw new Error(`gw seat "${arg}": unknown effort "${effort}" (${GW_EFFORTS.join(' | ')})`);
	const model = !id ? GATEWAY_DEFAULT_MODEL : id.includes('/') ? id : `openai-codex/${id}`;
	return { model, effort };
}
const gwModel = (arg: string) => gwSeat(arg).model;

/** One gateway provider per effort (the effort is a provider setting); all share the token. */
const gatewayProviders = new Map<string, GatewayProvider>();
function gateway(effort = values['gw-effort'] ?? 'high'): GatewayProvider {
	let provider = gatewayProviders.get(effort);
	if (!provider) {
		provider = new GatewayProvider({
			baseUrls: values['gw-urls']?.split(','),
			tokenFile: values['gw-token-file'],
			api: values['gw-api'] === 'chat' ? 'chat' : 'responses',
			history: values['gw-history'] as GatewayHistory,
			effort
		});
		gatewayProviders.set(effort, provider);
	}
	return provider;
}

/** Run-wide model-call gate: concurrency cap + back-off on rate/usage limits. */
const gate = new CallGate({
	maxConcurrent: num('max-concurrent-calls', values['max-concurrent-calls'], { min: 1, int: true }),
	maxLimitFailures: num('max-limit-failures', values['max-limit-failures'], { min: 1, int: true }),
	// The gateway account allows about 200 turns per minute (turn_rate_limit_exceeded above).
	...(values['max-calls-per-min'] !== undefined
		? { maxPerMinute: num('max-calls-per-min', values['max-calls-per-min'], { min: 1 }) }
		: {}),
	adaptive: true
});

let codexProvider: CodexProvider | null = null;
function codex(): CodexProvider {
	const session = values['codex-session'];
	if (session !== 'resume' && session !== 'fresh')
		throw new Error(`--codex-session must be resume or fresh (got "${session}")`);
	codexProvider ??= new CodexProvider({
		reasoningEffort: values['codex-effort'],
		session,
		timeoutMs: num('codex-timeout', values['codex-timeout'], { min: 5 }) * 1000,
		// codex processes at once: the run-wide call cap unless given.
		maxConcurrent:
			values['codex-concurrency'] !== undefined
				? num('codex-concurrency', values['codex-concurrency'], { min: 1, int: true })
				: gate.maxConcurrent
	});
	if (!codexProvider.toolsStripped)
		console.warn(
			'warning: no model_catalog_json in ~/.codex/config.toml, so Codex tools are off by feature flags only'
		);
	return codexProvider;
}

function controllerFor(
	spec: string,
	index: number,
	seed: number,
	budget: BudgetGuard,
	strategy: Strategy | null = null
): SeatController {
	if (isCodexSpec(spec) && spec !== 'codex' && !spec.startsWith('codex:')) spec = `codex:${spec}`;
	const [kind, ...rest] = spec.split(':');
	const arg = rest.join(':');
	const maxTokens = num('max-output-tokens', values['max-output-tokens'], { min: 16, int: true });
	const temperature =
		values.temperature !== undefined ? num('temperature', values.temperature) : undefined;
	if (kind === 'mock') {
		const policy = (arg || 'random') as MockPolicy;
		if (!['random', 'greedy', 'first'].includes(policy))
			throw new Error(`unknown mock policy "${policy}" (random | greedy | first)`);
		return new LlmSeatController({
			provider: new MockProvider({ policy, seed: seed * 31 + index }),
			model: policy,
			budget,
			maxTokens,
			gate,
			strategy,
			label: `mock:${policy}`
		});
	}
	if (kind === 'codex') {
		const model = arg || CODEX_DEFAULT_MODEL;
		return new LlmSeatController({
			provider: codex(),
			model,
			budget,
			maxTokens,
			gate,
			strategy,
			label: `codex:${model}`
		});
	}
	if (kind === 'gw') {
		const { model, effort } = gwSeat(arg);
		// Only subscription ids: the gateway also holds a per-token OpenRouter key.
		assertGatewayModel(model);
		return new LlmSeatController({
			provider: gateway(effort),
			model,
			budget,
			maxTokens,
			gate,
			strategy,
			label: `gw:${model}@${effort}`
		});
	}
	if (kind === 'or' || kind === 'openrouter') {
		if (!arg) throw new Error(`seat "${spec}": give a model, e.g. or:openai/gpt-4o-mini`);
		return new LlmSeatController({
			provider: new OpenRouterProvider(),
			model: arg,
			budget,
			maxTokens,
			temperature,
			gate,
			strategy,
			label: `openrouter:${arg}`
		});
	}
	throw new Error(
		`unknown seat spec "${spec}" (codex[:<model>] | mock:random | mock:greedy | mock:first | or:<openrouter model id>)`
	);
}

async function main(): Promise<void> {
	const loaded = loadCatalogSpec(values.catalog ?? 'local');
	if (loaded.warning) console.warn(`warning: ${loaded.warning}`);
	const rulesBrief = buildRulesBrief(loaded.catalog);

	if (values.brief) {
		process.stdout.write(rulesBrief);
		console.error(
			`\n[brief: ${rulesBrief.length} chars ≈ ${Math.round(rulesBrief.length / 4)} tokens; sha256 ${sha256(rulesBrief).slice(0, 12)}; catalog ${loaded.source} ${loaded.hash.slice(0, 12)}]`
		);
		return;
	}

	if (values.replay) {
		const records = readTranscript(resolve(values.replay));
		const header = records.find((r) => r.type === 'header');
		if (header?.type === 'header' && header.catalog.hash !== loaded.hash) {
			console.warn(
				`warning: transcript catalog ${header.catalog.hash.slice(0, 12)} ≠ loaded catalog ${loaded.hash.slice(0, 12)} (pass --catalog ${header.catalog.path})`
			);
		}
		const result = replayTranscript(records, loaded.catalog);
		console.log(
			JSON.stringify(
				{
					commands: result.commands,
					finalStateHash: result.finalStateHash,
					recordedHash: result.recordedHash,
					matches: result.matches
				},
				null,
				2
			)
		);
		process.exitCode = result.matches ? 0 : 1;
		return;
	}

	const games0 = num('games', values.games, { min: 1, int: true });
	const baseSeed0 = num('seed', values.seed, { int: true });
	// The games to play: seat specs and seed per game. --tournament: a 2-seat round robin,
	// each pair plays --pair-games games with the seats swapped and the same seed.
	let jobs: { specs: string[]; seed: number; pair?: string; strategies?: Strategy[] }[];
	let specs: string[];
	// --strategies: one strategy per seat (strategy.ts); with --rotate they move with the seats.
	const strategies = values.strategies
		? pickStrategies(values.strategies, loadStrategies(resolve(values['strategies-file']!)))
		: null;
	if (strategies && values.tournament)
		throw new Error('--strategies does not work with --tournament');
	if (values.tournament) {
		const field = values.tournament
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (field.length < 2) throw new Error('--tournament needs 2 or more seat specs');
		const pairGames = num('pair-games', values['pair-games'], { min: 1, int: true });
		jobs = [];
		let pairIndex = 0;
		for (let a = 0; a < field.length; a++)
			for (let b = a + 1; b < field.length; b++, pairIndex++)
				for (let k = 0; k < pairGames; k++)
					jobs.push({
						specs: k % 2 === 0 ? [field[a], field[b]] : [field[b], field[a]],
						seed: baseSeed0 + pairIndex,
						pair: `${field[a]} vs ${field[b]}`
					});
		specs = field;
	} else {
		specs = (
			values.seats ??
			(strategies ? strategies.map(() => values.model).join(',') : 'mock:random,mock:random')
		)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (specs.length < 2 || specs.length > 4) throw new Error('--seats needs 2 to 4 seat specs');
		if (strategies && strategies.length !== specs.length)
			throw new Error(`--strategies has ${strategies.length} entries for ${specs.length} seats`);
		// --rotate: shift seat order every game so no model (or strategy) keeps the first seat.
		const rotated = <T>(list: T[], g: number) =>
			list.map((_, i) => list[(i + (values.rotate ? g : 0)) % list.length]);
		jobs = Array.from({ length: games0 }, (_, g) => ({
			specs: rotated(specs, g),
			seed: baseSeed0 + g,
			...(strategies ? { strategies: rotated(strategies, g) } : {})
		}));
	}
	if (
		specs.some((s) => s.startsWith('or:') || s.startsWith('openrouter:')) &&
		!OpenRouterProvider.available()
	) {
		throw new Error('an OpenRouter seat needs OPENROUTER_API_KEY in the environment');
	}
	let codexInfo = '';
	/** Gateway account quota snapshots (gw seats only). */
	const usageLog: {
		at: string;
		usedPercent: number | null;
		resetsAt: number | null;
		limitReached: boolean;
	}[] = [];
	let usageStop: string | null = null;
	if (specs.some(isGatewaySpec)) {
		for (const spec of specs.filter(isGatewaySpec))
			assertGatewayModel(gwModel(spec.split(':').slice(1).join(':')));
		await gateway().check();
		usageLog.push({ at: 'start', ...(await gateway().usage()) });
		console.log(`gateway account 7-day usage at start: ${usageLog[0].usedPercent ?? '?'}%`);
		codexInfo += `, gateway ${values['gw-urls'] ?? process.env.ARC_GATEWAY_URL ?? 'http://127.0.0.1:4610/v1'}`;
	}
	if (specs.some(isCodexSpec)) {
		const version = codexVersion();
		if (!version) throw new Error('a codex seat needs the Codex CLI (`codex`, logged in) on PATH');
		codexInfo += `, ${version}`;
	}
	// Token and call caps protect real spend: they apply by default only when an OpenRouter seat
	// exists. Mock, Codex and gateway (subscription) runs are bounded by the per-game decision
	// cap, so a full game always runs to its end (30 VP or the round cap).
	const realSeats = specs.some((s) => s.startsWith('or:') || s.startsWith('openrouter:'));
	const budget = new BudgetGuard({
		maxSpendUsd: num('max-spend', values['max-spend']),
		maxTokens:
			values['max-tokens'] !== undefined
				? num('max-tokens', values['max-tokens'], { int: true })
				: realSeats
					? DEFAULT_BUDGET.maxTokens
					: Infinity,
		maxCalls:
			values['max-calls'] !== undefined
				? num('max-calls', values['max-calls'], { int: true })
				: realSeats
					? DEFAULT_BUDGET.maxCalls
					: Infinity
	});
	const games = jobs.length;
	const maxDecisions = num('max-decisions', values['max-decisions'], { min: 1, int: true });
	const maxPhaseDecisions = num('max-phase-decisions', values['max-phase-decisions'], {
		min: 1,
		int: true
	});
	// Seconds plus a random suffix: two runs started in the same second never share a folder.
	const runId =
		values['run-id'] ??
		`run-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
	const outDir = resolve(values.out ?? 'output/agent-harness', runId);
	if (existsSync(outDir)) throw new Error(`${outDir} already exists; choose another --run-id`);
	mkdirSync(outDir, { recursive: true });
	saveRunCatalog(outDir, loaded);
	const gitInfo = git();
	const failures: { game: number; seed: number; error: string }[] = [];
	const summaries: GameSummary[] = [];
	const abort = new AbortController();
	process.once('SIGINT', () => {
		console.error('\nstopping after the current calls…');
		abort.abort();
	});
	const parallelGames = Math.min(
		games,
		num('parallel-games', values['parallel-games'], { min: 1, int: true })
	);

	console.log(
		`run ${runId}: ${games} game(s), ${parallelGames} at a time, seats ${specs.join(' | ')}, catalog ${loaded.source} ${loaded.hash.slice(0, 12)}, call cap ${gate.maxConcurrent}, spend cap $${budget.limits.maxSpendUsd}${codexInfo}`
	);
	const started = Date.now();
	let peakRss = process.memoryUsage().rss;
	let running = 0;
	let decisionsSoFar = 0;
	let stopLaunching = false;
	const progress = setInterval(
		() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
			if (values.quiet) return;
			const b = budget.snapshot();
			process.stdout.write(
				`  ${((Date.now() - started) / 1000).toFixed(0)} s · games done ${summaries.length + failures.length}/${games}, running ${running} · decisions ${decisionsSoFar} · calls in flight ${gate.inFlight} (+${gate.waiting} queued), limit pauses ${gate.stats.rateLimited} · ${b.tokens} tokens · RSS ${(peakRss / 2 ** 20).toFixed(0)} MB\n`
			);
		},
		values.quiet ? 2_000 : 30_000
	);

	const playOne = async (g: number): Promise<void> => {
		const { seed, specs: order, strategies: seatStrategies } = jobs[g];
		const controllers = order.map((spec, i) =>
			controllerFor(spec, i, seed, budget, seatStrategies?.[i] ?? null)
		);
		const path = join(outDir, `game-${g}.jsonl`);
		const sink = new JsonlStreamSink(path);
		let summary: GameSummary;
		try {
			summary = await runAgentGame({
				catalog: loaded.catalog,
				catalogInfo: { source: loaded.source, path: loaded.path, hash: loaded.hash },
				seed,
				controllers,
				rulesBrief,
				budget,
				runId,
				gameIndex: g,
				sink,
				maxDecisions,
				maxPhaseDecisions,
				askOnForced: values['ask-forced'],
				parallel: !values['no-parallel'],
				statements: !!strategies,
				git: gitInfo,
				signal: abort.signal,
				onDecision: () => {
					decisionsSoFar += 1;
				}
			});
		} catch (err) {
			// One broken game must not lose the summaries of the games that finished.
			const message = (err as Error).message;
			failures.push({ game: g, seed, error: message });
			console.error(`game ${g} (seed ${seed}) failed: ${message}`);
			return;
		} finally {
			await sink.close();
			// Free the finished game's seat conversations (gateway seats keep them in memory).
			for (const provider of gatewayProviders.values())
				provider.forgetGame(`${runId}-g${g}-s${seed}`);
		}
		summaries.push(summary);
		// Quota check after the first N games (gw seats): stop when the account is blocked or the
		// first games used too much of the 7-day window.
		const checkAt = num('usage-check-games', values['usage-check-games'], { min: 1, int: true });
		if (gatewayProviders.size && summaries.length === Math.min(checkAt, games) && usageLog.length) {
			const now = await gateway()
				.usage()
				.catch(() => null);
			if (now) {
				usageLog.push({ at: `after ${summaries.length} games`, ...now });
				const used = (now.usedPercent ?? 0) - (usageLog[0].usedPercent ?? 0);
				const max = num('usage-max-percent', values['usage-max-percent'], { min: 0 });
				console.log(
					`gateway account 7-day usage after ${summaries.length} games: ${now.usedPercent ?? '?'}% (+${used}%)`
				);
				if (now.limitReached || used > max) {
					usageStop = now.limitReached
						? 'the gateway account reached a usage limit'
						: `the first ${summaries.length} games used ${used}% of the 7-day window (more than ${max}%)`;
					console.log(`stopping: ${usageStop}`);
					stopLaunching = true;
				}
			}
		}
		if (
			summary.stopReason === 'budget' ||
			summary.stopReason === 'provider-errors' ||
			gate.stoppedReason
		)
			stopLaunching = true;
		if (values.quiet && games > 1) return;
		const vp = summary.seats.map((s) => `${s.seat}=${s.finalVp}`).join(' ');
		const calls = summary.seats.reduce((n, s) => n + s.providerCalls, 0);
		const latency = summary.seats.reduce((n, s) => n + s.latencyMsTotal, 0);
		const agentDecisions = summary.seats.reduce((n, s) => n + s.agentDecisions, 0);
		const speed = calls
			? `, ${(latency / calls / 1000).toFixed(1)} s/call, ${(summary.durationMs / Math.max(1, agentDecisions) / 1000).toFixed(1)} s wall/agent decision`
			: '';
		const providerErrors = summary.seats.reduce((n, s) => n + s.providerErrors, 0);
		console.log(
			`game ${g} (seed ${seed}): ${summary.stopReason}${summary.stopDetail ? ` (${summary.stopDetail})` : ''}, winner ${summary.winner ?? '-'}, round ${summary.rounds}, ${summary.decisions} decisions (${agentDecisions} by agents), VP ${vp}, invalid ${(summary.invalidAnswerRate * 100).toFixed(1)}%, fallback ${(summary.fallbackRate * 100).toFixed(1)}%, provider errors ${providerErrors}, $${summary.totalCostUsd.toFixed(4)}${speed} → ${path}`
		);
	};

	// A pool of `parallelGames` workers takes game indices in order.
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < games && !abort.signal.aborted && !stopLaunching) {
			const g = next++;
			running += 1;
			try {
				await playOne(g);
			} finally {
				running -= 1;
			}
		}
	};
	await Promise.all(Array.from({ length: parallelGames }, worker));
	clearInterval(progress);
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
	summaries.sort((a, b) => a.gameId.localeCompare(b.gameId, undefined, { numeric: true }));
	const runStats = {
		wallMs: Date.now() - started,
		games,
		parallelGames,
		finished: summaries.length,
		failed: failures.length,
		decisions: decisionsSoFar,
		peakRssMb: Math.round(peakRss / 2 ** 20),
		calls: gate.stats,
		...(gate.stoppedReason ? { stoppedReason: gate.stoppedReason } : {}),
		...(usageLog.length ? { gatewayUsage: usageLog } : {}),
		...(usageStop ? { usageStop } : {})
	};
	console.log(
		`run done: ${summaries.length}/${games} games in ${(runStats.wallMs / 1000).toFixed(1)} s, ${decisionsSoFar} decisions, peak RSS ${runStats.peakRssMb} MB, calls ${gate.stats.calls} (max in flight ${gate.stats.maxInFlight}, limit pauses ${gate.stats.rateLimited})`
	);
	const aggregate = aggregateByModel(summaries);
	const tournament = values.tournament ? tournamentTable(summaries) : null;
	if (tournament) {
		writeFileSync(join(outDir, 'tournament.md'), renderTournamentMarkdown(tournament));
		console.log(`tournament → ${join(outDir, 'tournament.md')}`);
	}
	writeFileSync(
		join(outDir, 'summary.json'),
		JSON.stringify(
			{
				runId,
				catalog: { source: loaded.source, hash: loaded.hash },
				rulesBriefSha256: sha256(rulesBrief),
				git: gitInfo,
				budget: budget.snapshot(),
				games: summaries,
				failures,
				runStats,
				byModel: aggregate,
				...(tournament ? { tournament, schedule: jobs } : {}),
				...(codexProvider ? { codexThreads: codexProvider.threads() } : {})
			},
			null,
			2
		)
	);
	writeFileSync(
		join(outDir, 'summary.md'),
		renderSummaryMarkdown(runId, summaries, aggregate, budget.snapshot())
	);
	console.log(`summary → ${join(outDir, 'summary.md')}`);
	if (strategies) {
		writeStrategyReport(outDir, loaded.catalog);
		console.log(`strategy report → ${join(outDir, 'strategy-report.md')}`);
	}
	await codexProvider?.idle();
	codexProvider?.dispose();
	if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
	console.error(`error: ${(err as Error).message}`);
	process.exitCode = 1;
});
