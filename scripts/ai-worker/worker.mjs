#!/usr/bin/env node
/**
 * Arc Spirits AI worker: plays the "AI player" seats of the live site with Claude, through
 * this laptop's claude-cli gateway (~/arcspirits-harness/gateway/claude-cli, an OpenAI-
 * compatible shim over `claude -p`), so the calls use the laptop's Claude subscription.
 *
 *   ARC_AI_WORKER_KEY=... node scripts/ai-worker/worker.mjs
 *
 * Loop: GET <site>/api/ai/pending (every 2 s; every 10 s after a minute with nothing due), ask
 * the model for each new (room, seat, revision), POST <site>/api/ai/act. A bad answer is asked
 * again once (the harness's repair turn); then the revision is given up and the site's own
 * timeout lets the built-in bot play the seat. A seat with one legal action is answered without
 * a model call. Never logs keys, tokens or prompts. Plain Node ESM, no dependencies.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_IN_FLIGHT = 4;
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;
const IDLE_BEFORE_SLOW_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 240_000;
const SITE_TIMEOUT_MS = 30_000;
/** Answer attempts per revision: the first answer plus one repair. */
const MAX_ATTEMPTS = 2;

export function loadConfig(env = process.env, readFile = readFileSync) {
	const key = env.ARC_AI_WORKER_KEY?.trim();
	if (!key) throw new Error('ARC_AI_WORKER_KEY is required.');
	const model = env.ARC_AI_MODEL?.trim() || 'anthropic/claude-opus-5-5';
	// The owner forbids this model for Arc Spirits.
	if (model.toLowerCase().includes('fable')) throw new Error(`Refusing to run: model "${model}" is not allowed.`);
	const tokenFile =
		env.ARC_AI_GATEWAY_TOKEN_FILE?.trim() ||
		join(homedir(), '.local/share/arcspirits-claude-cli/laptop/token');
	let token;
	try {
		token = String(readFile(tokenFile, 'utf8')).trim();
	} catch {
		throw new Error(`Cannot read the gateway token file ${tokenFile} (is the claude-cli gateway set up?).`);
	}
	if (!token) throw new Error(`The gateway token file ${tokenFile} is empty.`);
	return {
		site: (env.ARC_SITE_URL?.trim() || 'https://arcspirits.com').replace(/\/+$/, ''),
		key,
		gatewayUrl: (env.ARC_AI_GATEWAY_URL?.trim() || 'http://127.0.0.1:4620/v1').replace(/\/+$/, ''),
		token,
		model,
		effort: env.ARC_AI_EFFORT?.trim() || 'medium'
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

/** One chat-completions call to the gateway, in the harness `gw` provider's request shape. */
export async function callGateway(cfg, messages, fetchImpl = fetch) {
	const res = await fetchImpl(`${cfg.gatewayUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
		body: JSON.stringify({ model: cfg.model, messages, reasoning_effort: cfg.effort }),
		signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || body?.error) {
		throw new Error(`gateway ${res.status}: ${String(body?.error?.message ?? 'error').slice(0, 160)}`);
	}
	const text = body?.choices?.[0]?.message?.content;
	if (typeof text !== 'string') throw new Error('gateway answer has no message content');
	return text;
}

export function createWorker(cfg, deps = {}) {
	const fetchImpl = deps.fetch ?? fetch;
	const log = deps.log ?? ((line) => console.log(line));
	const now = deps.now ?? (() => Date.now());
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
				text = await callGateway(cfg, messages, fetchImpl);
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
	console.log(`[ai] worker for ${cfg.site}, model ${cfg.model} (${cfg.effort}), gateway ${cfg.gatewayUrl}`);
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
