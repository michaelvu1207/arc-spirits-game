/**
 * The league: agents always play games in the background on the current game data, learn after
 * each game, and keep `report.md` up to date.
 *
 * Loop: check the data dir (a new catalog = a new data version: its schedule starts at game 0
 * with the same seeds and seats as every other version, and the old version's running games are
 * abandoned); start the next games of the schedule while there are free slots (per gateway
 * account, or `mockGamesInFlight` for mock-only tables). A game needs a free slot on an account of
 * each provider its seats use (`openai-codex`, `anthropic`); a game whose provider is full waits,
 * and later games that fit start (within a look-ahead past the oldest waiting one), so a small
 * Claude account never stalls the Codex tables. Seeds and seats per game number do not change.
 * After a game: the statements and the
 * notebook updates (learning agents, one at a time per agent), the trace, the reports, the status.
 *
 * The gateway accounts, their gates (adaptive rate and concurrency) and the blocked-account
 * handling are the tournament's (gatewayPool.ts). No quota guard: on a real usage limit an
 * account is blocked until its reset and its games move on.
 */

import { appendFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SeatColor } from '../../types';
import { BudgetGuard } from '../budget';
import { CallGate } from '../callGate';
import { LlmSeatController } from '../llmSeat';
import { notebookPrompt } from '../memory';
import { GatewayProvider, gatewayProviderOf, type GatewayProviderId } from '../providers/gateway';
import { adaptiveAccountGate, GatewayPool, type GatewayAccount } from '../providers/gatewayPool';
import { MockProvider, type MockPolicy } from '../providers/mock';
import { ResumeMismatchError, runAgentGame, type GameSummary } from '../runner';
import { collectStatements, type GameOutcome } from '../strategy';
import { seatStatement, traceGame } from '../strategyReport';
import { seatResults } from '../tournament';
import {
	JsonlStreamSink,
	readTranscript,
	type HeaderRecord,
	type StatementRecord
} from '../transcript';
import { isMockModel, loadAgents, type LeagueAgent } from './agents';
import type { LeagueConfig } from './config';
import { NotebookStore, textHash, writeAtomic } from './notebookStore';
import {
	agentViews,
	benchmarkStandings,
	compareVersions,
	renderLeagueReport,
	versionReport
} from './report';
import { findResumeSource } from './resume';
import { firstFit, LeagueSchedule, type LeagueGame } from './schedule';
import { Seating } from './seating';
import { VersionStore } from './versionStore';
import { changedCards, DataWatcher, loadSavedVersion, versionId, type DataVersion } from './versions';

/**
 * A game's gateway slots: the least loaded open account of each provider its (non-mock) seats
 * use, or null when one of those providers has no free slot.
 */
export function gatewaySlots(pool: GatewayPool, models: string[]): GatewayAccount[] | null {
	const providers = new Set<GatewayProviderId>(
		models.filter((m) => !isMockModel(m)).map(gatewayProviderOf)
	);
	const accounts: GatewayAccount[] = [];
	for (const provider of providers) {
		const best = pool.leastLoaded(provider);
		if (!best || pool.free(best) <= 0) return null;
		accounts.push(best);
	}
	return accounts;
}

export type LeagueState = 'starting' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'done' | 'error';

export interface LeagueStatus {
	state: LeagueState;
	pid: number;
	host: string;
	startedAt: string;
	updatedAt: string;
	dataVersion: string | null;
	/** Set while the data dir cannot be used (the league plays the last good version). */
	dataNote: string | null;
	agents: string[];
	maxGames: number | null;
	gamesInFlight: number;
	/** Most games in flight at once so far. */
	peakInFlight: number;
	versions: Record<string, { done: number; running: number; abandoned: number; failed: number }>;
	callsPerMin: number;
	/** Largest resident memory of this process so far (MB). */
	peakRssMb: number;
	accounts: {
		label: string;
		provider: string;
		url: string;
		running: number;
		target: number;
		liveCap: number;
		ratePerMin: number;
		callsPerMin10: number;
		limitHits10: number;
		quotaWindows: string;
		blockedUntil: string | null;
		blockReason: string | null;
		lastLimitError: string | null;
	}[];
	lastEvent: string;
	lastError: string | null;
	stopReason: string | null;
}

interface RunningGame {
	version: DataVersion;
	index: number;
	gameId: string;
	abort: AbortController;
	/** Pause: the game stops before its next decision (calls under way finish first). */
	pause: AbortController;
	phase: 'playing' | 'after';
	promise: Promise<void>;
}

/** Stop reasons that are not a real game (played again). */
const FAILED_STOPS = new Set(['provider-errors', 'budget', 'reducer-rejection']);

export interface LeagueOptions {
	dir: string;
	config: LeagueConfig;
	/** The lab folder (the frozen catalog part of a design-dir build). Default cwd. */
	repoRoot?: string;
	fetchImpl?: typeof fetch;
	/** Loop tick and status interval (ms). Defaults 5000 / 10000. */
	tickMs?: number;
	statusMs?: number;
	quotaMs?: number;
	log?: (line: string) => void;
}

export class League {
	readonly dir: string;
	readonly config: LeagueConfig;
	readonly agents: LeagueAgent[];
	readonly schedule: LeagueSchedule;
	readonly versions: VersionStore;
	readonly notebooks = new NotebookStore();
	readonly status: LeagueStatus;
	readonly #byId: Map<string, LeagueAgent>;
	readonly #watcher: DataWatcher;
	readonly #pool: GatewayPool | null;
	readonly #providers = new Map<string, GatewayProvider>();
	readonly #mockGate = new CallGate({ maxConcurrent: 256 });
	readonly #budget = new BudgetGuard({ maxSpendUsd: 0.01, maxTokens: Infinity, maxCalls: Infinity });
	readonly #running = new Map<string, RunningGame>();
	readonly #statementsAbort = new AbortController();
	readonly #calls: number[] = [];
	readonly #opts: LeagueOptions;
	readonly #catalogs = new Map<string, DataVersion | null>();
	/** How far past the oldest open game the loop looks for a game that fits the free slots. */
	readonly #lookahead: number;
	readonly #seatings = new Map<string, Seating>();
	#current: DataVersion | null = null;
	#stopping: string | null = null;
	#wake: (() => void) | null = null;

	constructor(opts: LeagueOptions) {
		this.#opts = opts;
		this.dir = opts.dir;
		this.config = opts.config;
		this.agents = loadAgents(opts.config.agentsDir, {
			model: opts.config.defaultModel,
			effort: opts.config.defaultEffort
		});
		this.#byId = new Map(this.agents.map((a) => [a.id, a]));
		if (opts.config.benchmark)
			for (const a of this.agents)
				if (a.learn || a.strategy.text || a.openingSpirits)
					throw new Error(
						`benchmark: agent ${a.id} must have "learn": false, an empty strategy.md and no openingSpirits`
					);
		this.schedule = new LeagueSchedule(
			this.agents.map((a) => a.id),
			{ seed: opts.config.seed, tableSize: opts.config.seatsPerGame }
		);
		this.versions = new VersionStore(opts.dir);
		this.#watcher = new DataWatcher(opts.dir, opts.config.dataDir, opts.repoRoot);
		const needsGateway = this.agents.some((a) => !isMockModel(a.model));
		if (needsGateway && !opts.config.gateways.length)
			throw new Error('league.json: agents with a gateway model need "gateways"');
		this.#pool = needsGateway
			? new GatewayPool(
					opts.config.gateways.map((g) => ({
						label: g.label,
						url: g.url,
						provider: g.provider,
						tokenFile: g.tokenFile
					})),
					{
						target: 1,
						onEvent: (t) => this.#event(t),
						fetchImpl: opts.fetchImpl,
						gate: adaptiveAccountGate({
							maxConcurrent: opts.config.maxConcurrentCalls,
							ratePerMin: opts.config.callsPerMin,
							maxRatePerMin: opts.config.maxCallsPerMin
						})
					}
				)
			: null;
		for (const g of opts.config.gateways) {
			const account = this.#pool?.byLabel(g.label);
			if (account) account.target = g.games;
		}
		for (const a of this.agents) {
			if (isMockModel(a.model)) continue;
			const provider = gatewayProviderOf(a.model);
			if (!this.#pool!.serves(provider))
				throw new Error(
					`league.json: agent ${a.id} uses ${a.model}, but no gateway has "provider": "${provider}"`
				);
		}
		this.#lookahead =
			this.agents.length +
			opts.config.mockGamesInFlight +
			opts.config.gateways.reduce((n, g) => n + g.games, 0);
		const now = new Date().toISOString();
		this.status = {
			state: 'starting',
			pid: process.pid,
			host: hostname(),
			startedAt: now,
			updatedAt: now,
			dataVersion: null,
			dataNote: null,
			agents: this.agents.map((a) => a.id),
			maxGames: opts.config.maxGames,
			gamesInFlight: 0,
			peakInFlight: 0,
			versions: {},
			callsPerMin: 0,
			peakRssMb: 0,
			accounts: [],
			lastEvent: '',
			lastError: null,
			stopReason: null
		};
	}

	get current(): DataVersion | null {
		return this.#current;
	}

	/**
	 * Stop (= pause): no new game starts; each running game stops before its next decision, so
	 * the calls that are under way finish and are recorded. After the grace time, calls that are
	 * still open are cut off. Either way the game's record is kept and the next start continues
	 * it from its last decision. After-game notebook calls may finish within the grace time.
	 */
	stop(reason: string): void {
		if (this.#stopping) return;
		this.#stopping = reason;
		this.status.stopReason = reason;
		this.status.state = 'stopping';
		this.#event(`stop: ${reason}`);
		for (const g of this.#running.values()) if (g.phase === 'playing') g.pause.abort();
		setTimeout(() => {
			for (const g of this.#running.values()) if (g.phase === 'playing') g.abort.abort();
			this.#statementsAbort.abort();
		}, this.config.stopGraceSec * 1000).unref();
		this.#writeStatus();
		this.#wake?.();
	}

	async run(): Promise<LeagueState> {
		writeFileSync(join(this.dir, 'league.pid'), `${process.pid}\n`);
		const statusTimer = setInterval(() => this.#writeStatus(), this.#opts.statusMs ?? 10_000);
		const quotaTimer = setInterval(
			() => void this.#pool?.refreshUsage().catch(() => {}),
			this.#opts.quotaMs ?? 10 * 60_000
		);
		try {
			if (this.#pool) {
				await this.#pool.check();
				await this.#pool.refreshUsage().catch(() => {});
			}
			this.#checkData();
			if (!this.#current) {
				// The data dir cannot be used now: play the last version seen, if there is one.
				const last = this.versions.entries().sort((a, b) => b.lastActive.localeCompare(a.lastActive))[0];
				if (!last) throw new Error(`the data folder cannot be loaded: ${this.#watcher.problem}`);
				this.#activate(loadSavedVersion(this.dir, last.id), false);
			}
			this.status.state = 'running';
			this.#event(
				`league started: ${this.agents.length} agents, data version ${this.#current!.id}, ${this.config.maxGames ?? 'endless'} games per version`
			);
			await this.#loop();
			this.status.state = this.#stopping ? 'stopped' : 'done';
		} catch (err) {
			this.status.state = 'error';
			this.status.lastError = (err as Error).message.slice(0, 300);
			this.#event(`error: ${this.status.lastError}`);
			this.stop(`error: ${this.status.lastError}`);
			await Promise.allSettled([...this.#running.values()].map((g) => g.promise));
			this.status.state = 'error';
		} finally {
			clearInterval(statusTimer);
			clearInterval(quotaTimer);
			this.#event(`exit: ${this.status.state}${this.status.stopReason ? ` (${this.status.stopReason})` : ''}`);
			this.#writeStatus();
			rmSync(join(this.dir, 'league.pid'), { force: true });
		}
		return this.status.state;
	}

	async #loop(): Promise<void> {
		const max = this.config.maxGames ?? Infinity;
		while (!this.#stopping) {
			this.#checkData();
			const v = this.#current!;
			for (;;) {
				if (this.#stopping) break;
				const next = this.#nextStart(v, max);
				if (!next) break;
				this.#start(v, next.game, next.slots);
			}
			if (!this.#running.size && !this.#stopping && this.#nextIndex(v, max) === null) {
				this.#event(`data version ${v.id}: all ${max} games done`);
				return;
			}
			// Every account blocked: wait for the first reset (games resume by themselves).
			if (!this.#stopping) this.status.state = this.#pool?.nextReset() != null ? 'waiting' : 'running';
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, this.#opts.tickMs ?? 5_000);
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = null;
		}
		await Promise.allSettled([...this.#running.values()].map((g) => g.promise));
	}

	/** The lowest game number of the version that is neither done nor running. */
	#nextIndex(v: DataVersion, max: number): number | null {
		for (let i = 0; i < max; i++)
			if (!this.#running.has(`${v.id}/${i}`) && !this.versions.done(v.id, i)) return i;
		return null;
	}

	/** The lowest open game (within the look-ahead) that has its free slots, and those slots. */
	#nextStart(v: DataVersion, max: number): { game: LeagueGame; slots: GatewayAccount[] } | null {
		const first = this.#nextIndex(v, max);
		if (first === null) return null;
		return firstFit(
			this.#seating(v),
			first,
			Math.min(max, first + this.#lookahead),
			(i) => !this.#running.has(`${v.id}/${i}`) && !this.versions.done(v.id, i),
			(game) => this.#slot(game)
		);
	}

	/** The saved seating of a data version (made on first use; see seating.ts). */
	#seating(v: DataVersion): Seating {
		let seating = this.#seatings.get(v.id);
		if (!seating) {
			seating = new Seating(
				join(this.dir, 'versions', v.id, 'seating.json'),
				this.agents,
				{ seed: this.config.seed, tableSize: this.config.seatsPerGame },
				(index) => this.versions.done(v.id, index)
			);
			this.#seatings.set(v.id, seating);
			if (seating.change) this.#event(`data version ${v.id}: ${seating.change}`);
		}
		return seating;
	}

	/** Free slots for a game ([] for an all-mock table); null when none is free. */
	#slot(game: LeagueGame): GatewayAccount[] | null {
		// A finished game of a removed agent can still be listed here: it is never started.
		if (game.seats.some((id) => !this.#byId.has(id))) return null;
		const models = game.seats.map((id) => this.#byId.get(id)!.model);
		if (models.some((m) => !isMockModel(m))) return gatewaySlots(this.#pool!, models);
		const mockRunning = [...this.#running.values()].filter((g) => !this.#pool?.labelOf(g.gameId)).length;
		return mockRunning < this.config.mockGamesInFlight ? [] : null;
	}

	#checkData(): void {
		const r = this.#watcher.check();
		const problem = this.#watcher.problem;
		this.status.dataNote = problem
			? `The data folder cannot be loaded (${problem}). Still playing the last good version ${this.#current?.id ?? '-'}.`
			: null;
		if (r.kind === 'invalid' && problem) this.#event(`data folder cannot be loaded: ${problem}`);
		if (r.kind !== 'version') return;
		const old = this.#current;
		this.#activate(r.version, true);
		if (old) {
			let abandoned = 0;
			for (const g of this.#running.values())
				if (g.version.id !== r.version.id && g.phase === 'playing') {
					g.abort.abort();
					abandoned += 1;
				}
			this.#event(
				`data changed: version ${old.id} → ${r.version.id} (${r.isNew ? 'new' : 'seen before'}); ${abandoned} running game(s) of the old version abandoned`
			);
		}
	}

	#activate(v: DataVersion, fromWatcher: boolean): void {
		if (!fromWatcher) this.#watcher.current = v;
		this.#current = v;
		this.#catalogs.set(v.id, v);
		this.versions.activate(v.id, v.hash);
		const running = new Set(
			[...this.#running.values()].filter((g) => g.version.id === v.id).map((g) => g.index)
		);
		const cut = this.versions.setAsideCutOff(v.id, running);
		if (cut) this.#event(`data version ${v.id}: ${cut} cut-off game(s) set aside; they are played again`);
		this.status.dataVersion = v.id;
		this.#writeReports(v);
		this.#writeStatus();
	}

	#start(v: DataVersion, game: LeagueGame, accounts: GatewayAccount[]): void {
		const runId = `league-${v.id}`;
		const gameId = `${runId}-g${game.index}-s${game.seed}`;
		for (const account of accounts) this.#pool!.assign(gameId, account);
		this.#seating(v).record(game);
		const entry: RunningGame = {
			version: v,
			index: game.index,
			gameId,
			abort: new AbortController(),
			pause: new AbortController(),
			phase: 'playing',
			promise: Promise.resolve()
		};
		const key = `${v.id}/${game.index}`;
		this.#running.set(key, entry);
		this.status.peakInFlight = Math.max(this.status.peakInFlight, this.#running.size);
		entry.promise = this.#play(entry, game, runId)
			.catch((err) => {
				this.status.lastError = `game ${game.index + 1}: ${(err as Error).message}`.slice(0, 300);
				this.#event(this.status.lastError);
				this.versions.setAside(v.id, game.index, 'failed');
			})
			.finally(() => {
				// History seats answer their statement in the game's conversation: drop it only now.
				for (const p of this.#providers.values()) p.forgetGame(gameId);
				this.#running.delete(key);
				this.#pool?.release(gameId);
				this.#writeStatus();
				this.#wake?.();
			});
	}

	async #play(entry: RunningGame, game: LeagueGame, runId: string): Promise<void> {
		const v = entry.version;
		const agents = game.seats.map((id) => this.#byId.get(id)!);
		const books = agents.map((a) => (a.learn ? this.notebooks.read(a.dir) : ''));
		const changes = agents.map((a) => (a.learn ? this.#dataChanges(a, v) : []));
		const controllers = agents.map((a, i) => this.#controller(a, i, game.seed, books[i], changes[i]));
		const path = this.versions.transcriptPath(v.id, game.index);
		// A record of this game from an earlier start (paused, stopped, killed, provider errors):
		// continue from it when it is the same game (same seats, models, efforts and data).
		const sameGame = (h: HeaderRecord): boolean => {
			const was = (
				h.options.league as
					| { agents?: { agent: string; model: string; effort: string; memory: string }[] }
					| undefined
			)?.agents;
			return (
				h.seed === game.seed &&
				h.catalog.hash === v.catalogInfo.hash &&
				!!was &&
				was.length === agents.length &&
				was.every(
					(w, i) =>
						w.agent === agents[i].id &&
						w.model === agents[i].model &&
						w.effort === agents[i].effort &&
						w.memory === agents[i].memory
				)
			);
		};
		let source = findResumeSource(dirname(path), game.index, sameGame);
		let summary: GameSummary;
		for (;;) {
			const sink = new JsonlStreamSink(path);
			try {
				summary = await runAgentGame({
					catalog: v.catalog,
					catalogInfo: v.catalogInfo,
					seed: game.seed,
					controllers,
					rulesBrief: v.rulesBrief,
					budget: this.#budget,
					runId,
					gameIndex: game.index,
					sink,
					maxDecisions: this.config.maxDecisions,
					maxPhaseDecisions: this.config.maxPhaseDecisions,
					eventsPerPrompt: this.config.eventsPerPrompt,
					headerOptions: {
						league: {
							version: v.id,
							game: game.index,
							account: this.#pool?.labelOf(entry.gameId) ?? null,
							...(source
								? {
										resumedFrom: basename(source.file),
										resumedDecisions: source.decisions,
										playedMs: Math.round(source.priorMs)
									}
								: {}),
							agents: agents.map((a, i) => ({
								agent: a.id,
								model: a.model,
								effort: a.effort,
								memory: a.memory,
								learn: a.learn,
								notebook: books[i],
								notebookHash: textHash(books[i]),
								dataChanges: changes[i]
							}))
						}
					},
					signal: entry.abort.signal,
					pause: entry.pause.signal,
					...(source ? { resume: { records: source.records, priorMs: source.priorMs } } : {}),
					onDecision: (r) => this.#countCalls(r.attempts.length)
				});
				await sink.close();
				if (source)
					this.#event(
						`game ${game.index + 1} of ${v.id} continued after decision ${summary.resumedDecisions ?? source.decisions} of its earlier record`
					);
				break;
			} catch (err) {
				await sink.close();
				if (!(err instanceof ResumeMismatchError) || !source) throw err;
				// The record no longer leads to the same game: mark it, drop what the seats were
				// given back, and play the game from its start.
				renameSync(source.file, source.file.replace(/\.jsonl$/, '.noresume.jsonl'));
				this.#event(
					`game ${game.index + 1} of ${v.id}: its earlier record cannot be continued (${(err as Error).message}); it is played from the start`
				);
				for (const p of this.#providers.values()) p.forgetGame(entry.gameId);
				source = null;
			}
		}
		if (
			summary.stopReason === 'aborted' ||
			summary.stopReason === 'paused' ||
			entry.abort.signal.aborted
		) {
			this.versions.setAside(v.id, game.index, 'abandoned');
			return;
		}
		if (FAILED_STOPS.has(summary.stopReason)) {
			this.versions.setAside(v.id, game.index, 'failed');
			this.status.lastError = `game ${game.index + 1}: ${summary.stopReason} ${summary.stopDetail ?? ''}`.slice(0, 300);
			this.#event(`game ${game.index + 1} of ${v.id} failed (${summary.stopReason}); it is played again`);
			return;
		}
		entry.phase = 'after';
		await this.#afterGame(entry, game, agents, controllers, summary, path);
	}

	/** Statements and notebook updates, the trace, the reports. */
	async #afterGame(
		entry: RunningGame,
		game: LeagueGame,
		agents: LeagueAgent[],
		controllers: LlmSeatController[],
		summary: GameSummary,
		path: string
	): Promise<void> {
		const v = entry.version;
		const trace = traceGame(readTranscript(path), v.catalog);
		const seats = summary.seats.map((s) => s.seat);
		const outcome: GameOutcome = {
			finished: summary.finished,
			winner: summary.winner,
			rounds: summary.rounds,
			decisions: summary.decisions,
			stopReason: summary.stopReason,
			seats: summary.seats
		};
		const bySeat = new Map<SeatColor, LlmSeatController>(seats.map((s, i) => [s, controllers[i]]));
		const records = await Promise.all(
			agents.map((agent, i) => {
				const seat = seats[i];
				const ask = async (): Promise<StatementRecord> => {
					const [record] = await collectStatements({
						gameId: entry.gameId,
						outcome,
						controllers: bySeat,
						rulesBrief: v.rulesBrief,
						signal: this.#statementsAbort.signal,
						seats: [seat],
						// Read inside the agent's lock: a later update starts from the earlier result.
						promptFor: agent.learn
							? () => {
									const notebook = this.notebooks.read(agent.dir);
									return {
										notebook,
										prompt: notebookPrompt(seat, outcome, {
											strategyText: agent.strategy.text,
											notebook,
											trace: trace.seats[i],
											lastNote: controllers[i].planNote(entry.gameId, seat),
											dataChanges: this.#dataChanges(agent, v)
										})
									};
								}
							: undefined
					});
					appendFileSync(path, `${JSON.stringify(record)}\n`);
					this.#countCalls(record.attempts.length);
					if (agent.learn && record.notebook !== undefined)
						this.notebooks.save(agent.dir, record.notebook, entry.gameId, v.hash);
					return record;
				};
				return agent.learn ? this.notebooks.withLock(agent.dir, ask) : ask();
			})
		);
		records.forEach((r, i) => Object.assign(trace.seats[i], seatStatement(r)));
		this.versions.saveTrace(v.id, {
			index: game.index,
			gameId: entry.gameId,
			finishedAt: new Date().toISOString(),
			trace,
			result: {
				batch: 0,
				index: game.index,
				seed: game.seed,
				rounds: summary.rounds,
				stopReason: summary.stopReason,
				durationMs: summary.durationMs,
				seats: seatResults(summary, game.seats)
			}
		});
		const top = [...trace.seats].sort((a, b) => a.place - b.place);
		this.#event(
			`game ${game.index + 1} of ${v.id} done: round ${summary.rounds}, ${summary.stopReason}; ${top.map((s) => `${s.strategyId} ${s.finalVp}`).join(' > ')}`
		);
		this.#writeReports(v);
	}

	#controller(
		agent: LeagueAgent,
		seat: number,
		seed: number,
		notebook: string,
		dataChanges: string[]
	): LlmSeatController {
		const mock = isMockModel(agent.model);
		return new LlmSeatController({
			provider: mock
				? new MockProvider({ policy: agent.model.slice(5) as MockPolicy, seed: seed * 31 + seat })
				: this.#gateway(agent.effort, agent.memory),
			model: mock ? agent.model.slice(5) : agent.model,
			budget: this.#budget,
			maxTokens: 400,
			label: agent.id,
			strategy: agent.strategy,
			...(agent.openingSpirits ? { openingSpirits: agent.openingSpirits } : {}),
			memory: agent.memory,
			notebook,
			dataChanges,
			...(mock ? { gate: this.#mockGate } : {})
		});
	}

	/**
	 * One provider per effort and memory. Fresh seats send each request whole (nothing stored);
	 * history seats keep the full conversation, on the responses route with the earlier turns'
	 * encrypted reasoning passed back (as the tournament), the oldest turns dropped when full.
	 */
	#gateway(effort: string, memory: LeagueAgent['memory']): GatewayProvider {
		const key = `${effort}/${memory}`;
		let p = this.#providers.get(key);
		if (!p) {
			const reasoning = memory === 'history' && this.config.gatewayApi === 'responses';
			p = new GatewayProvider({
				api: this.config.gatewayApi,
				history: reasoning ? 'reasoning' : 'messages',
				effort,
				pool: this.#pool!,
				fetchImpl: this.#opts.fetchImpl
			});
			this.#providers.set(key, p);
		}
		return p;
	}

	/** Changed cards since the agent's notebook was last updated (none when on the same data). */
	#dataChanges(agent: LeagueAgent, v: DataVersion): string[] {
		const last = this.notebooks.lastDataHash(agent.dir);
		if (!last || last === v.hash) return [];
		const id = versionId(last);
		if (!this.#catalogs.has(id)) {
			try {
				this.#catalogs.set(id, loadSavedVersion(this.dir, id));
			} catch {
				this.#catalogs.set(id, null);
			}
		}
		const before = this.#catalogs.get(id);
		return before ? changedCards(before.catalog, v.catalog) : [];
	}

	#writeReports(v: DataVersion): void {
		const files = [...this.versions.traces(v.id).values()];
		// Agents that were removed keep their finished games in the reports.
		const agents = [...this.agents, ...this.#seating(v).removed(this.agents)];
		const current = versionReport(v, files, agents);
		const vdir = join(this.dir, 'versions', v.id);
		const prev = this.versions.previous(v.id);
		let compare: Parameters<typeof renderLeagueReport>[0]['compare'] = null;
		if (prev) {
			const before = this.#catalogs.get(prev.id) ?? this.#loadVersion(prev.id);
			if (before) {
				const c = compareVersions(
					{ ...before, files: [...this.versions.traces(prev.id).values()] },
					{ ...v, files },
					agents
				);
				compare = { previous: prev.id, ...c };
			}
		}
		const input = {
			current,
			running: [...this.#running.values()].filter(
				(g) => g.version.id === v.id && g.phase === 'playing'
			).length,
			dataNote: this.status.dataNote,
			agents: agentViews(agents, files, (a) => (a.dir ? this.notebooks.read(a.dir) : '')),
			standings: this.config.benchmark ? benchmarkStandings(files, agents) : null,
			updatedAt: new Date().toISOString()
		};
		writeAtomic(join(vdir, 'report.json'), `${JSON.stringify(current, null, 2)}\n`);
		writeAtomic(join(vdir, 'report.md'), renderLeagueReport({ ...input, compare: null }));
		if (v.id === this.#current?.id)
			writeAtomic(join(this.dir, 'report.md'), renderLeagueReport({ ...input, compare }));
	}

	#loadVersion(id: string): DataVersion | null {
		try {
			const v = loadSavedVersion(this.dir, id);
			this.#catalogs.set(id, v);
			return v;
		} catch {
			return null;
		}
	}

	#countCalls(n: number): void {
		const now = Date.now();
		for (let i = 0; i < n; i++) this.#calls.push(now);
		while (this.#calls.length && this.#calls[0] < now - 60_000) this.#calls.shift();
	}

	#event(text: string): void {
		const line = `${new Date().toISOString()} ${text}`;
		this.status.lastEvent = text;
		(this.#opts.log ?? console.log)(line);
		appendFileSync(join(this.dir, 'events.log'), `${line}\n`);
	}

	#writeStatus(): void {
		const s = this.status;
		s.updatedAt = new Date().toISOString();
		s.gamesInFlight = this.#running.size;
		this.#countCalls(0);
		s.callsPerMin = this.#calls.length;
		s.peakRssMb = Math.max(s.peakRssMb, Math.round(process.memoryUsage().rss / 1e6));
		s.versions = {};
		for (const e of this.versions.entries())
			s.versions[e.id] = {
				done: this.versions.traces(e.id).size,
				running: [...this.#running.values()].filter((g) => g.version.id === e.id).length,
				abandoned: this.versions.count(e.id, 'abandoned'),
				failed: this.versions.count(e.id, 'failed')
			};
		const since = Date.now() - 10 * 60_000;
		s.accounts = (this.#pool?.accounts ?? []).map((a) => {
			const w = a.window(since);
			return {
				label: a.label,
				provider: a.provider,
				url: a.url,
				running: a.games.size,
				target: a.target,
				liveCap: a.gate.liveCap,
				ratePerMin: Math.round(a.gate.ratePerMin),
				callsPerMin10: w.callsPerMin,
				limitHits10: w.limitHits,
				quotaWindows: (a.usage?.windows ?? []).map((u) => `${u.id} ${u.usedPercent ?? '?'}%`).join(', '),
				blockedUntil: a.blockedUntil ? new Date(a.blockedUntil).toISOString() : null,
				blockReason: a.blockReason,
				lastLimitError: a.gate.stats.lastLimitError
			};
		});
		if (existsSync(this.dir)) writeAtomic(join(this.dir, 'status.json'), `${JSON.stringify(s, null, 2)}\n`);
	}
}
