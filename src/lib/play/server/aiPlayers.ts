/**
 * "AI player" seats: bot members with bot_profile 'ai' whose decisions are made by Claude,
 * called by a worker on the owner's laptop (scripts/ai-worker) through /api/ai/pending and
 * /api/ai/act. The server never calls a model. When the worker is off or slow, tickBots plays
 * the seat with the bundled policy after ARC_AI_SEAT_TIMEOUT_MS, so a game never hangs.
 *
 * This module is the switch and the worker key check only (framework-free: process.env, no
 * $env/SvelteKit) so the room service, the bot driver and the routes share it. The decisions
 * themselves are built in aiSeats.ts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Display name of an AI seat (the seat is labelled "AI" in the UI as well). */
export const AI_DISPLAY_NAME = 'Claude';

/** Default wait before the bundled policy plays an AI seat (ms since the room's last commit). */
export const DEFAULT_AI_SEAT_TIMEOUT_MS = 90_000;

/** Most rooms with AI seats looked at by one /api/ai/pending call. */
export const MAX_AI_ROOMS_PER_POLL = 20;

type Env = Record<string, string | undefined>;

function currentEnv(): Env {
	return typeof process !== 'undefined' ? process.env : {};
}

export function aiWorkerKey(env: Env = currentEnv()): string | null {
	const key = env.ARC_AI_WORKER_KEY?.trim();
	return key ? key : null;
}

/** AI seats can be added (and the worker endpoints exist) only when the worker key is set. */
export function aiPlayersEnabled(env: Env = currentEnv()): boolean {
	return aiWorkerKey(env) !== null;
}

export function aiSeatTimeoutMs(env: Env = currentEnv()): number {
	const raw = Number(env.ARC_AI_SEAT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AI_SEAT_TIMEOUT_MS;
}

/**
 * Check the worker's `x-arc-ai-key` header in constant time (both sides are hashed first, so
 * the comparison never depends on the key length). 'disabled' when no key is configured: the
 * endpoints then answer 404, as if they did not exist.
 */
export function verifyAiWorkerKey(
	header: string | null | undefined,
	env: Env = currentEnv()
): 'ok' | 'disabled' | 'unauthorized' {
	const key = aiWorkerKey(env);
	if (!key) return 'disabled';
	if (!header) return 'unauthorized';
	const a = createHash('sha256').update(key).digest();
	const b = createHash('sha256').update(header.trim()).digest();
	return timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}
