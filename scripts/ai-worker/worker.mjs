#!/usr/bin/env node
/**
 * Arc Spirits AI worker: plays the "AI player" seats of the live site with Claude, through the
 * model proxy on this laptop (CLIProxyAPI, port 8317), which owns the Claude subscription logins.
 *
 *   ARC_AI_WORKER_KEY=... node scripts/ai-worker/worker.mjs
 *
 * Settings (all optional):
 *   ARC_AI_MODEL    anthropic/claude-opus-5-5 (default) or anthropic/claude-fable-5-2. A proxy
 *                   account group is named by its prefix: anthropic/<prefix>/claude-opus-5-5.
 *   ARC_AI_EFFORT   reasoning effort (default medium).
 *   ARC_AI_GATEWAY_URL        default http://127.0.0.1:8317/v1.
 *   ARC_AI_PROXY_KEY_COMMAND  the command that prints the proxy key (default `~/.local/bin/ccc proxy key`;
 *                   JSON with a `key` field, or the bare key). The key is never stored here or logged.
 *   ARC_AI_PROXY=0  the old way: an OpenAI-compatible gateway with a token file
 *                   (ARC_AI_GATEWAY_TOKEN_FILE, ARC_AI_GATEWAY_URL; the claude-cli gateway on 4620).
 *
 * At the proxy every call of one room carries the same `X-Session-ID`, so the room's AI seats stay
 * on one real account and the long rules brief is read from that account's prompt cache. A call
 * the proxy answers with 429 / 502 / 503 is sent again after a short pause.
 *
 * Loop: GET <site>/api/ai/pending (every 2 s; every 10 s after a minute with nothing due), ask
 * the model for each new (room, seat, revision), POST <site>/api/ai/act. A bad answer is asked
 * again once (the harness's repair turn); then the revision is given up and the site's own
 * timeout lets the built-in bot play the seat. A seat with one legal action is answered without
 * a model call. Never logs keys, tokens or prompts. Plain Node ESM, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_IN_FLIGHT = 4;
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;
const IDLE_BEFORE_SLOW_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 240_000;
/** The proxy: one call may take this long. The site hands a seat to its built-in bot after 90 s. */
const PROXY_TIMEOUT_MS = 80_000;
/** The proxy: a call answered 429 / 502 / 503 is sent again this many times, after this pause. */
const PROXY_RETRIES = 2;
const PROXY_RETRY_MS = 15_000;
export const PROXY_URL = 'http://127.0.0.1:8317/v1';
const SITE_TIMEOUT_MS = 30_000;
/** Answer attempts per revision: the first answer plus one repair. */
const MAX_ATTEMPTS = 2;

/** Run the key command and return what it prints. Its output is never logged. */
function runKeyCommand(command) {
	return execFileSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The key in a key command's output: JSON `{ "key": … }`, or the bare text. */
function keyFromOutput(out) {
	const text = String(out ?? '').trim();
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed.key === 'string') return parsed.key.trim();
	} catch {
		/* the bare key */
	}
	return text;
}

export function loadConfig(env = process.env, readFile = readFileSync, runCommand = runKeyCommand) {
	const key = env.ARC_AI_WORKER_KEY?.trim();
	if (!key) throw new Error('ARC_AI_WORKER_KEY is required.');
	const model = env.ARC_AI_MODEL?.trim() || 'anthropic/claude-opus-5-5';
	const proxy = env.ARC_AI_PROXY?.trim() !== '0';
	let token;
	if (proxy) {
		const command = (env.ARC_AI_PROXY_KEY_COMMAND?.trim() || `${join(homedir(), '.local/bin/ccc')} proxy key`).split(/\s+/);
		try {
			token = keyFromOutput(runCommand(command));
		} catch {
			throw new Error(`The proxy key command failed (${command[0].split('/').pop()} …): is the model proxy set up on this machine?`);
		}
		if (!token) throw new Error('The proxy key command printed no key.');
	} else {
		const tokenFile =
			env.ARC_AI_GATEWAY_TOKEN_FILE?.trim() ||
			join(homedir(), '.local/share/arcspirits-claude-cli/laptop/token');
		try {
			token = String(readFile(tokenFile, 'utf8')).trim();
		} catch {
			throw new Error(`Cannot read the gateway token file ${tokenFile} (is the claude-cli gateway set up?).`);
		}
		if (!token) throw new Error(`The gateway token file ${tokenFile} is empty.`);
	}
	return {
		site: (env.ARC_SITE_URL?.trim() || 'https://arcspirits.com').replace(/\/+$/, ''),
		key,
		gatewayUrl: (env.ARC_AI_GATEWAY_URL?.trim() || (proxy ? PROXY_URL : 'http://127.0.0.1:4620/v1')).replace(/\/+$/, ''),
		token,
		model,
		effort: env.ARC_AI_EFFORT?.trim() || 'medium',
		proxy
	};
}

/** The first balanced {...} object in the text that parses as JSON (fenced blocks first). */
export function firstJsonObject(text) {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
	for (const candidate of [fenced, text].filter(Boolean)) {
		for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
			let depth = 0;
			let inString = false;
			for (let i = start; i < candidate.length; i++) {
				const ch = candidate[i];
				if (inString) {
					if (ch === '\\') i++;
					else if (ch === '"') inString = false;
					continue;
				}
				if (ch === '"') inString = true;
				else if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (depth === 0) {
						try {
							const parsed = JSON.parse(candidate.slice(start, i + 1));
							if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
						} catch {
							/* next '{' */
						}
						break;
					}
				}
			}
		}
	}
	return null;
}

/** Map a model answer to an offered action id ("a3"), tolerant like the harness: the JSON
 *  `action` field (or a bare number / id). Null when nothing offered matches. */
export function pickAction(text, actions) {
	const ids = new Map(actions.map((a) => [String(a.id).toLowerCase(), a.id]));
	const resolve = (raw) => {
		if (typeof raw !== 'string' && typeof raw !== 'number') return null;
		const value = String(raw).trim().toLowerCase();
		return ids.get(value) ?? ids.get(`a${value}`) ?? null;
	};
	const json = firstJsonObject(String(text ?? ''));
	if (json) {
		const id = resolve(json.action ?? json.actionId ?? json.action_id ?? json.id ?? json.choice);
		return id ? { id, reason: typeof json.reason === 'string' ? json.reason.slice(0, 600) : '' } : null;
	}
	const bare = resolve(String(text ?? ''));
	return bare ? { id: bare, reason: '' } : null;
}

/** The harness's repair turn (agents/prompt.ts repairMessage). */
function repairMessage(error, actions) {
	const ids = actions.map((a) => a.id);
	const range = ids.length > 6 ? `${ids[0]} … ${ids[ids.length - 1]}` : ids.join(', ');
	return `Your answer could not be used: ${error}. Answer again with ONE JSON object only, for example {"action": "${ids[0]}", "reason": "…"}. The action must be one of: ${range}.`;
}

/** The model id the proxy knows: without the provider ("anthropic/claude-opus-5-5" → "claude-opus-5-5"). */
export const proxyModel = (model) => model.replace(/^anthropic\//, '');
/** The `X-Session-ID` of a room at the proxy: one id = one real account, so the room's seats share its prompt cache. */
export const proxySession = (roomCode) => `arc-ai-${String(roomCode ?? 'room').replace(/[^A-Za-z0-9_-]/g, '')}`;

/**
 * One chat-completions call, in the harness `gw` provider's request shape. `session` (the proxy
 * only): the room's session id. A proxy answer of 429 / 502 / 503 (limit reached, provider
 * overloaded, the last live account cooling down) is sent again after a pause.
 */
export async function callGateway(cfg, messages, fetchImpl = fetch, session = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
	const proxy = cfg.proxy === true;
	const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` };
	if (proxy && session) headers['X-Session-ID'] = session;
	const payload = {
		model: proxy ? proxyModel(cfg.model) : cfg.model,
		messages,
		reasoning_effort: cfg.effort,
		...(proxy && session ? { prompt_cache_key: session } : {})
	};
	for (let attempt = 0; ; attempt++) {
		const res = await fetchImpl(`${cfg.gatewayUrl}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(proxy ? PROXY_TIMEOUT_MS : GATEWAY_TIMEOUT_MS)
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok || body?.error) {
			if (proxy && [429, 502, 503].includes(res.status) && attempt < PROXY_RETRIES) {
				await sleep(PROXY_RETRY_MS);
				continue;
			}
			throw new Error(`gateway ${res.status}: ${String(body?.error?.message ?? 'error').slice(0, 160)}`);
		}
		const text = body?.choices?.[0]?.message?.content;
		if (typeof text !== 'string') throw new Error('gateway answer has no message content');
		return text;
	}
}

export function createWorker(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? fetch;
	const log = deps.log ?? ((line) => console.log(line));
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep;
	/** "room:seat" being answered now: one model call at a time per seat. */
	const inFlight = new Set();
	/** decision → time given up (a decision with no usable answer is not asked again; the
	 *  site's timeout plays it; pruned after 3 minutes). */
	const done = new Map();
	/** "room:seat" → time its last answer settled: items of a poll sent before that are stale. */
	const settledAt = new Map();
	let lastBusyAt = now();

	const site = (path, init = {}) =>
		fetchImpl(`${cfg.site}${path}`, {
			...init,
			headers: { 'x-arc-ai-key': cfg.key, 'content-type': 'application/json', ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(SITE_TIMEOUT_MS)
		});

	async function act(item, id, reason) {
		const res = await site('/api/ai/act', {
			method: 'POST',
			body: JSON.stringify({
				roomCode: item.roomCode,
				seat: item.seat,
				revision: item.revision,
				decisionKey: item.decisionKey,
				actionId: id,
				reason
			})
		});
		const body = await res.json().catch(() => ({}));
		return { status: res.status, body };
	}

	/** @returns {Promise<boolean>} false ⇒ gave up on this decision (do not ask it again). */
	async function handle(item) {
		const started = now();
		const label = (id) => item.actions.find((a) => a.id === id)?.label ?? id;
		const tag = `${item.roomCode} ${item.seat}`;
		if (item.actions.length === 1) {
			const r = await act(item, item.actions[0].id, 'only legal action');
			if (r.status === 200) log(`[ai] ${tag} → ${label(item.actions[0].id)} (forced)`);
			else log(`[ai] ${tag}: act ${r.status} ${String(r.body?.message ?? '').slice(0, 120)}`);
			return r.status === 200 || r.status === 409;
		}
		const messages = [
			{ role: 'system', content: item.system },
			{ role: 'user', content: item.prompt }
		];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			let text;
			try {
				text = await callGateway(cfg, messages, fetchImpl, proxySession(item.roomCode), sleep);
			} catch (err) {
				log(`[ai] ${tag}: ${err instanceof Error ? err.message : String(err)}`);
				return false; // gateway down/busy: the site's timeout covers this decision
			}
			const pick = pickAction(text, item.actions);
			if (!pick) {
				messages.push({ role: 'assistant', content: text });
				messages.push({ role: 'user', content: repairMessage('the answer is not a JSON object with an offered "action" id', item.actions) });
				continue;
			}
			const r = await act(item, pick.id, pick.reason);
			const secs = ((now() - started) / 1000).toFixed(1);
			if (r.status === 200) {
				log(`[ai] ${tag} → ${label(pick.id)} (${secs}s)`);
				return true;
			}
			if (r.status === 409) {
				log(`[ai] ${tag}: the decision changed before the answer (${secs}s)`);
				return true;
			}
			log(`[ai] ${tag}: act ${r.status} ${String(r.body?.message ?? '').slice(0, 120)}`);
			if (r.status !== 400) return false;
			messages.push({ role: 'assistant', content: text });
			messages.push({ role: 'user', content: repairMessage(String(r.body?.message ?? 'the action was rejected'), item.actions) });
		}
		log(`[ai] ${tag}: no usable answer; giving up on this decision`);
		return false;
	}

	/** One poll: start a decision for every new due item (at most MAX_IN_FLIGHT at once). */
	async function poll() {
		const asked = now();
		const res = await site('/api/ai/pending');
		if (!res.ok) throw new Error(`pending ${res.status}`);
		const { items = [] } = await res.json();
		if (items.length > 0) lastBusyAt = now();
		for (const [key, at] of done) if (now() - at > 180_000) done.delete(key);
		const started = [];
		for (const item of items) {
			const key = `${item.roomCode}:${item.seat}`;
			const decision = `${key}:${item.decisionKey ?? item.revision}`;
			// A poll sent before this seat's last answer settled may still list the old decision.
			// Same revision as an answer already given ⇒ the very same state: never ask it twice.
			const exact = `${decision}@${item.revision}`;
			if (inFlight.has(key) || done.has(decision) || done.has(exact) || (settledAt.get(key) ?? -1) >= asked) continue;
			if (inFlight.size >= MAX_IN_FLIGHT) break;
			inFlight.add(key);
			lastBusyAt = now();
			started.push(
				handle(item)
					.catch((err) => {
						log(`[ai] ${item.roomCode} ${item.seat}: ${err instanceof Error ? err.message : String(err)}`);
						return false;
					})
					.then((answered) => {
						done.set(answered ? exact : decision, now());
						inFlight.delete(key);
						settledAt.set(key, now());
						lastBusyAt = now();
					})
			);
		}
		return { items: items.length, started };
	}

	function nextDelay() {
		return inFlight.size > 0 || now() - lastBusyAt < IDLE_BEFORE_SLOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
	}

	return { poll, nextDelay, inFlight };
}

async function main() {
	let cfg;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(`[ai] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	console.log(`[ai] worker for ${cfg.site}, model ${cfg.model} (${cfg.effort}), ${cfg.proxy ? 'model proxy' : 'gateway'} ${cfg.gatewayUrl}`);
	const worker = createWorker(cfg);
	let stopping = false;
	for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopping = true));
	let lastError = '';
	while (!stopping) {
		try {
			await worker.poll();
			lastError = '';
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message !== lastError) console.error(`[ai] poll failed: ${message}`);
			lastError = message;
		}
		await new Promise((resolve) => setTimeout(resolve, worker.nextDelay()));
	}
	console.log('[ai] stopped');
	process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
