/**
 * Codex CLI provider: a seat answers through the local `codex exec` (ChatGPT/Codex subscription
 * login, no API key, no per-token bill).
 *
 * One Codex SESSION per seat per game: the first decision starts a thread (`codex exec`), every
 * later decision continues it (`codex exec resume <thread>`), so the seat remembers the game —
 * its earlier views, choices and reasons — like a player at the table, for the WHOLE game: there
 * is no restart by turn count. The context window and auto-compaction limit of the user's config
 * are passed on (Codex compacts inside the same session). The only restart: a thread whose
 * context is full, or that failed twice in a row, is replaced by a new thread that gets the rules
 * brief and the full current view; the answer records it (`session.event: 'restarted'`).
 * `session: 'fresh'` makes every decision a new, stateless process instead (`--ephemeral`).
 *
 * Isolation (nothing of the user's Codex setup is changed; only the login is used):
 *   - NO TOOLS. Codex gives tools from the model's catalog entry (`tool_mode`, `shell_type`,
 *     multi-agent, …), and feature flags alone do not remove them (verified: with every tool
 *     feature disabled, gpt-6.1-sol still had `exec`, `wait` and sub-agent tools). So the
 *     provider writes a private COPY of the user's model catalog (temp dir) with every tool
 *     field off, and passes that copy. Verified: the model then reports no tools and a request
 *     to run `ls /` makes no tool call. Feature flags are disabled too, as a second layer;
 *   - `--ignore-user-config` (no MCP servers, notify hooks, full-access sandbox or project
 *     trust from ~/.codex/config.toml); `-s read-only`, an empty temp working directory, web
 *     search off, approvals never; skills, permission, environment and collaboration-mode
 *     instructions off;
 *   - `model_instructions_file` = a short seat preface + the rules brief; it replaces Codex's
 *     coding-agent prompt. (The user's global ~/.codex/AGENTS.md is still added by Codex; only
 *     another CODEX_HOME would drop it, and that would need a copy of the login. The preface
 *     tells the seat to ignore it; with no tools it cannot act on it.);
 *   - `--output-schema` forces the final message to be {"action", "reason"};
 *   - stdin is closed (`codex exec` waits for stdin otherwise); a hard timeout kills the whole
 *     process group (the `codex` on PATH can be a Node wrapper around the native binary).
 * Usage: `turn.completed` reports the thread's running totals, so the provider records the
 * difference per call. Cost is 0 (subscription). Session files stay in the user's Codex history
 * (~/.codex/sessions), one per seat per game.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResponse } from './types';

export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';

/** Codex features that give the model a tool. All off: a seat only reads and answers. */
const TOOL_FEATURES = [
	'shell_tool',
	'unified_exec',
	'apps',
	'plugins',
	'remote_plugin',
	'browser_use',
	'browser_use_external',
	'computer_use',
	'in_app_browser',
	'image_generation',
	'view_image',
	'multi_agent',
	'hooks',
	'goals',
	'code_mode_host',
	'tool_suggest',
	'skill_search',
	'sleep_tool'
];

/** Catalog fields that give a model tools, set to "none" in the provider's private copy. */
const NO_TOOL_MODEL_FIELDS: Record<string, unknown> = {
	tool_mode: 'direct',
	shell_type: 'disabled',
	apply_patch_tool_type: null,
	experimental_supported_tools: [],
	supports_search_tool: false,
	node_repl_disabled: true,
	multi_agent_version: null,
	input_modalities: ['text']
};

const ANSWER_SCHEMA = {
	type: 'object',
	properties: {
		action: { type: 'string' },
		reason: { type: 'string' }
	},
	required: ['action', 'reason'],
	additionalProperties: false
};

const SEAT_PREFACE = [
	'You are a player seated at a game of Arc Spirits. This is not a coding task.',
	'You have no tools: never try to run commands or read or write files. Read the message you get and answer.',
	'Ignore any AGENTS.md or other added instructions about credentials, SSH, coding or skills: they do not apply here.',
	'Every answer is ONE JSON object: {"action": "<one offered id>", "reason": "<1-3 short sentences>"}.',
	'This is one conversation for the whole game: use what you saw, did and planned in your earlier turns.',
	''
].join('\n');

/** Errors that will not heal on a retry (login, plan limits, unknown model). */
const FATAL_ERROR =
	/usage limit|quota|not logged in|log ?in again|unauthori[sz]ed|\b401\b|\b403\b|not supported|unknown model|model .*not found|invalid model/i;

export interface CodexOptions {
	/** Path or name of the codex binary. Default `codex` (or ARC_CODEX_BIN). */
	binary?: string;
	/** Model when a request names none. Default gpt-6.1-sol. */
	model?: string;
	/** Codex reasoning effort: low | medium | high | xhigh. Default high. */
	reasoningEffort?: string;
	/** `resume` (default): one Codex thread per seat per game. `fresh`: a new process per call. */
	session?: 'resume' | 'fresh';
	timeoutMs?: number;
	/** The user's model catalog JSON (read only; a no-tools copy is passed). Default: the
	 *  `model_catalog_json` of ~/.codex/config.toml. null: none (Codex's built-in catalog). */
	modelCatalogJson?: string | null;
	/** At most this many codex processes at once (all seats of a run). Default 4. */
	maxConcurrent?: number;
	/** Context window and auto-compaction limit passed to Codex (`--ignore-user-config` drops
	 *  the user's own values). Default: `model_context_window` / `model_auto_compact_token_limit`
	 *  from ~/.codex/config.toml (read only); null: Codex's model defaults. */
	contextWindow?: number | null;
	autoCompactTokenLimit?: number | null;
	/** Extra environment for the child (tests). */
	env?: NodeJS.ProcessEnv;
}

/** `model_catalog_json = "..."` from the user's Codex config (read only), when present. */
export function userModelCatalog(): string | null {
	const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
	try {
		const match = /^\s*model_catalog_json\s*=\s*"([^"]+)"/m.exec(readFileSync(configPath, 'utf8'));
		return match && existsSync(match[1]) ? match[1] : null;
	} catch {
		return null;
	}
}

/** A numeric top-level key of the user's Codex config (read only), when present. */
export function userCodexNumber(key: string): number | null {
	const configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
	try {
		const match = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(
			readFileSync(configPath, 'utf8')
		);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

/** Errors that mean the thread's context is full (the thread cannot continue). */
const CONTEXT_FULL =
	/context window|context_length|maximum context|too many tokens|prompt is too long/i;

/** `codex --version` output, or null when the binary cannot run. */
export function codexVersion(binary = process.env.ARC_CODEX_BIN ?? 'codex'): string | null {
	try {
		return execFileSync(binary, ['--version'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 15_000
		}).trim();
	} catch {
		return null;
	}
}

/** A copy of a Codex model catalog with every tool field of every model turned off. */
export function noToolsCatalog(source: string): string {
	const catalog = JSON.parse(readFileSync(source, 'utf8')) as {
		models?: Record<string, unknown>[];
	};
	if (!Array.isArray(catalog.models)) throw new Error(`${source}: no "models" list`);
	for (const model of catalog.models) Object.assign(model, NO_TOOL_MODEL_FIELDS);
	return JSON.stringify(catalog);
}

interface Usage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	/** Part of outputTokens that was reasoning. */
	reasoningTokens: number;
}

interface Thread {
	id: string;
	turns: number;
	/** Failures in a row on this thread. */
	failures: number;
	/** Running totals Codex reported after the last turn of this thread. */
	usage: Usage;
}

interface RunResult extends Usage {
	threadId: string | null;
	text: string;
	/** Process start → `turn.started`, and `turn.started` → `turn.completed` (ms). */
	timing?: { startupMs: number; turnMs: number };
}

/** Child process groups still running (killed when this process exits). */
const LIVE = new Set<number>();
let exitHookInstalled = false;
function killGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
	LIVE.delete(child.pid);
}

export class CodexProvider implements ChatProvider {
	readonly name = 'codex';
	/** True when tools are removed through a no-tools catalog copy (not only feature flags). */
	readonly toolsStripped: boolean;
	readonly #opts: Required<
		Omit<CodexOptions, 'env' | 'modelCatalogJson' | 'contextWindow' | 'autoCompactTokenLimit'>
	> & {
		env?: NodeJS.ProcessEnv;
		contextWindow: number | null;
		autoCompactTokenLimit: number | null;
	};
	readonly #tempRoot: string;
	readonly #workDir: string;
	readonly #schemaPath: string;
	readonly #catalogPath: string | null;
	readonly #threads = new Map<string, Thread>();
	/** Why a seat's thread was dropped (its next thread is a restart, recorded as such). */
	readonly #restartReason = new Map<string, 'context-full' | 'thread-failed'>();
	/** Exit of each seat's last codex process (a resume waits for it). */
	readonly #exits = new Map<string, Promise<void>>();
	readonly #instructionFiles = new Map<string, string>();
	#running = 0;
	#queue: (() => void)[] = [];

	constructor(opts: CodexOptions = {}) {
		this.#opts = {
			binary: opts.binary ?? process.env.ARC_CODEX_BIN ?? 'codex',
			model: opts.model ?? CODEX_DEFAULT_MODEL,
			reasoningEffort: opts.reasoningEffort ?? 'high',
			session: opts.session ?? 'resume',
			timeoutMs: opts.timeoutMs ?? 300_000,
			maxConcurrent: Math.max(1, opts.maxConcurrent ?? 4),
			contextWindow:
				opts.contextWindow === undefined
					? userCodexNumber('model_context_window')
					: opts.contextWindow,
			autoCompactTokenLimit:
				opts.autoCompactTokenLimit === undefined
					? userCodexNumber('model_auto_compact_token_limit')
					: opts.autoCompactTokenLimit,
			env: opts.env
		};
		this.#tempRoot = mkdtempSync(join(tmpdir(), 'arc-agent-codex-'));
		// An empty directory as the session's working directory.
		this.#workDir = mkdtempSync(join(this.#tempRoot, 'cwd-'));
		this.#schemaPath = join(this.#tempRoot, 'answer.schema.json');
		writeFileSync(this.#schemaPath, JSON.stringify(ANSWER_SCHEMA));
		const source = opts.modelCatalogJson === undefined ? userModelCatalog() : opts.modelCatalogJson;
		this.#catalogPath = source ? join(this.#tempRoot, 'models-no-tools.json') : null;
		if (source && this.#catalogPath) writeFileSync(this.#catalogPath, noToolsCatalog(source));
		this.toolsStripped = !!this.#catalogPath;
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.once('exit', () => {
				for (const pid of LIVE) {
					try {
						process.kill(-pid, 'SIGKILL');
					} catch {
						/* already gone */
					}
				}
			});
		}
	}

	/** Subscription: no per-token bill. */
	async estimateCostUsd(): Promise<number> {
		return 0;
	}

	/** Thread ids by session key (for records). */
	threads(): Record<string, string> {
		return Object.fromEntries([...this.#threads].map(([key, t]) => [key, t.id]));
	}

	/** Resolves when every codex process this provider started has exited. */
	async idle(): Promise<void> {
		await Promise.all(this.#exits.values());
	}

	/** Remove the temp files (schema, instructions, catalog copy, working directory). */
	dispose(): void {
		rmSync(this.#tempRoot, { recursive: true, force: true });
	}

	async complete(request: ChatRequest): Promise<ChatResponse> {
		if (request.signal?.aborted) throw new ProviderError('codex call aborted', null, false);
		await this.#acquire();
		try {
			if (request.signal?.aborted) throw new ProviderError('codex call aborted', null, false);
			return await this.#complete(request);
		} finally {
			this.#release();
		}
	}

	async #complete(request: ChatRequest): Promise<ChatResponse> {
		// The rules brief, then the seat's strategy message when it has one (strategy.ts).
		const system = request.messages
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n\n');
		const instructions = this.#instructionsFile(system);
		const model = request.model || this.#opts.model;
		const key = request.meta?.sessionKey;
		const resumeMode = this.#opts.session === 'resume' && !!key;
		const thread = resumeMode ? this.#threads.get(key!) : undefined;
		const restartReason = key && !thread ? this.#restartReason.get(key) : undefined;
		const userTurns = request.messages.filter((m) => m.role !== 'system');
		// A continued thread already holds the earlier turns (and its own answers): send only the
		// newest user message. A new thread gets the whole conversation of this decision (the
		// rules brief is the system prompt; the decision message carries the full current view).
		const restartNote = restartReason
			? `(A new conversation starts here because the previous one ${restartReason === 'context-full' ? 'ran out of context' : 'failed'}: your earlier turns of this game are not available. The rules are the same, and the view below is complete.)\n\n`
			: '';
		const prompt = thread
			? (userTurns.filter((m) => m.role === 'user').at(-1)?.content ?? '')
			: restartNote +
				userTurns
					.map((m) => (m.role === 'assistant' ? `(Your previous answer: ${m.content})` : m.content))
					.join('\n\n');

		let result: RunResult;
		try {
			// The previous process of this seat must have saved its session before a resume.
			if (key) await this.#exits.get(key);
			result = await this.#run(
				model,
				prompt,
				instructions,
				thread?.id ?? null,
				request.signal,
				(exited) => {
					if (key) this.#exits.set(key, exited);
				}
			);
		} catch (err) {
			// The one restart path: a thread whose context is full, or that failed twice in a row,
			// is dropped; the next call starts a new thread (recorded as `restarted`). One failure
			// keeps the thread, so a network drop does not cost the seat its memory.
			if (key && thread) {
				const message = (err as Error).message ?? '';
				thread.failures += 1;
				if (CONTEXT_FULL.test(message) || thread.failures >= 2) {
					this.#threads.delete(key);
					this.#restartReason.set(
						key,
						CONTEXT_FULL.test(message) ? 'context-full' : 'thread-failed'
					);
				}
			}
			throw err;
		}
		const threadId = thread?.id ?? result.threadId;
		// Codex reports the thread's running totals: this call used the difference.
		const before = thread?.usage ?? {
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0
		};
		const used = (field: keyof Usage) =>
			result[field] >= before[field] ? result[field] - before[field] : result[field];
		if (resumeMode && threadId) {
			this.#threads.set(key!, {
				id: threadId,
				turns: (thread?.turns ?? 0) + 1,
				failures: 0,
				usage: {
					inputTokens: result.inputTokens,
					cachedInputTokens: result.cachedInputTokens,
					outputTokens: result.outputTokens,
					reasoningTokens: result.reasoningTokens
				}
			});
			this.#restartReason.delete(key!);
		}
		return {
			text: result.text,
			// Input includes the cached part: what the model read this turn (the context size).
			promptTokens: used('inputTokens'),
			completionTokens: used('outputTokens'),
			cachedPromptTokens: used('cachedInputTokens'),
			reasoningTokens: used('reasoningTokens'),
			costUsd: 0,
			costEstimated: false,
			servedModel: `codex:${model}`,
			providerRequestId: threadId ?? undefined,
			httpAttempts: 1,
			...(result.timing ? { timing: result.timing } : {}),
			session: {
				threadId: threadId ?? null,
				event: thread ? 'resumed' : restartReason ? 'restarted' : 'started',
				...(restartReason ? { reason: restartReason } : {})
			}
		};
	}

	#instructionsFile(system: string): string {
		const text = `${SEAT_PREFACE}\n${system}`;
		const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
		let path = this.#instructionFiles.get(hash);
		if (!path) {
			path = join(this.#tempRoot, `instructions-${hash}.md`);
			writeFileSync(path, text);
			this.#instructionFiles.set(hash, path);
		}
		return path;
	}

	#args(model: string, prompt: string, instructions: string, resumeId: string | null): string[] {
		const set = (key: string, value: unknown) => ['-c', `${key}=${JSON.stringify(value)}`];
		const common = [
			'--ignore-user-config',
			...set('model_reasoning_effort', this.#opts.reasoningEffort),
			...set('web_search', 'disabled'),
			...set('approval_policy', 'never'),
			...set('model_instructions_file', instructions),
			...set('include_permissions_instructions', false),
			...set('include_environment_context', false),
			...set('include_apps_instructions', false),
			...set('include_collaboration_mode_instructions', false),
			...set('skills.include_instructions', false),
			...(this.#opts.contextWindow ? set('model_context_window', this.#opts.contextWindow) : []),
			...(this.#opts.autoCompactTokenLimit
				? set('model_auto_compact_token_limit', this.#opts.autoCompactTokenLimit)
				: []),
			...(this.#catalogPath ? set('model_catalog_json', this.#catalogPath) : []),
			...TOOL_FEATURES.flatMap((feature) => ['--disable', feature]),
			'-m',
			model,
			'--skip-git-repo-check',
			'--json',
			'--output-schema',
			this.#schemaPath
		];
		// `exec resume` takes no -s / -C: the thread keeps its read-only sandbox and directory.
		if (resumeId) return ['exec', 'resume', ...common, resumeId, prompt];
		return [
			'exec',
			...common,
			'-s',
			'read-only',
			'-C',
			this.#workDir,
			...(this.#opts.session === 'fresh' ? ['--ephemeral'] : []),
			prompt
		];
	}

	#run(
		model: string,
		prompt: string,
		instructions: string,
		resumeId: string | null,
		signal?: AbortSignal,
		onExit?: (exited: Promise<void>) => void
	): Promise<RunResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.#opts.binary, this.#args(model, prompt, instructions, resumeId), {
				cwd: this.#workDir,
				// stdin closed: `codex exec` otherwise waits for more input.
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...this.#opts.env },
				// Own process group, so a kill reaches the native binary under a Node wrapper.
				detached: true
			});
			if (child.pid !== undefined) LIVE.add(child.pid);
			// The answer is returned as soon as the turn completes; the process then writes its
			// session file and exits (~0.4 s). The next resume of this thread waits for that exit.
			let exitTimer: ReturnType<typeof setTimeout> | undefined;
			onExit?.(
				new Promise<void>((done) =>
					child.once('close', () => {
						clearTimeout(exitTimer);
						if (child.pid !== undefined) LIVE.delete(child.pid);
						done();
					})
				)
			);
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				fn();
			};
			const timer = setTimeout(() => {
				killGroup(child);
				finish(() =>
					reject(new ProviderError(`codex timeout after ${this.#opts.timeoutMs} ms`, null, false))
				);
			}, this.#opts.timeoutMs);
			const onAbort = () => {
				killGroup(child);
				finish(() => reject(new ProviderError('codex call aborted', null, false)));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) onAbort();
			child.stdout!.setEncoding('utf8');
			child.stderr!.setEncoding('utf8');
			const spawned = Date.now();
			let turnStarted = 0;
			let turnEnded = 0;
			child.stdout!.on('data', (chunk: string) => {
				stdout += chunk;
				if (!turnStarted && chunk.includes('"turn.started"')) turnStarted = Date.now();
				if (!turnEnded && chunk.includes('"turn.completed"')) turnEnded = Date.now();
				// Early answer: a complete `turn.completed` line with a message and no failure.
				if (turnEnded && !settled && /"turn\.completed"[^\n]*\n/.test(stdout)) {
					const parsed = parseCodexEvents(stdout);
					if (parsed.text && parsed.turnFailed === null) {
						parsed.timing = { startupMs: turnStarted - spawned, turnMs: turnEnded - turnStarted };
						// A process that does not exit after its turn is killed after 30 s.
						exitTimer = setTimeout(() => killGroup(child), 30_000);
						finish(() => resolve(parsed));
					}
				}
			});
			child.stderr!.on('data', (chunk: string) => (stderr += chunk));
			child.on('error', (err) =>
				finish(() =>
					reject(new ProviderError(`codex could not start: ${err.message}`, null, false))
				)
			);
			child.on('close', (code) =>
				finish(() => {
					const parsed = parseCodexEvents(stdout);
					const failed = parsed.turnFailed ?? (code !== 0 ? (parsed.lastError ?? '') : null);
					if (failed !== null) {
						const detail = failed || stderr.trim().split('\n').slice(-3).join(' | ');
						const message = `codex exit ${code}: ${detail}`.slice(0, 300);
						// Network drops heal on a retry; login, plan limits and bad model ids do not.
						reject(new ProviderError(message, code, !FATAL_ERROR.test(detail)));
						return;
					}
					if (turnStarted && turnEnded)
						parsed.timing = { startupMs: turnStarted - spawned, turnMs: turnEnded - turnStarted };
					resolve(parsed);
				})
			);
		});
	}

	async #acquire(): Promise<void> {
		if (this.#running < this.#opts.maxConcurrent) {
			this.#running += 1;
			return;
		}
		// The slot is handed over by #release (the count stays the same).
		await new Promise<void>((resolve) => this.#queue.push(resolve));
	}

	#release(): void {
		const next = this.#queue.shift();
		if (next) next();
		else this.#running -= 1;
	}
}

/** Parse `codex exec --json` JSONL events: thread id, last agent message, usage, errors. */
export function parseCodexEvents(
	stdout: string
): RunResult & { turnFailed: string | null; lastError: string | null } {
	const out: RunResult & { turnFailed: string | null; lastError: string | null } = {
		threadId: null,
		text: '',
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		turnFailed: null,
		lastError: null
	};
	for (const line of stdout.split('\n')) {
		if (!line.trim().startsWith('{')) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = event.type;
		const message = () =>
			String(
				(event.error as { message?: string } | undefined)?.message ??
					(event.message as string | undefined) ??
					type
			);
		if (type === 'thread.started' && typeof event.thread_id === 'string')
			out.threadId = event.thread_id;
		else if (type === 'item.completed') {
			const item = event.item as { type?: string; text?: string } | undefined;
			if (item?.type === 'agent_message' && typeof item.text === 'string') out.text = item.text;
		} else if (type === 'turn.completed') {
			// Running totals of the thread; output_tokens already includes reasoning tokens.
			const usage = (event.usage ?? {}) as Record<string, number>;
			out.inputTokens = usage.input_tokens ?? 0;
			out.cachedInputTokens = usage.cached_input_tokens ?? 0;
			out.outputTokens = usage.output_tokens ?? 0;
			out.reasoningTokens = usage.reasoning_output_tokens ?? 0;
		} else if (type === 'turn.failed') out.turnFailed = message();
		// A top-level error can be a retried reconnect; it fails the call only with a bad exit.
		else if (type === 'error') out.lastError = message();
	}
	return out;
}
