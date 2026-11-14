import { verifyAiWorkerKey } from '$lib/play/server/aiPlayers';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Guard for the laptop AI worker's endpoints (/api/ai/*): the `x-arc-ai-key` header must equal
 * ARC_AI_WORKER_KEY (constant-time). No key configured → 404 (the endpoints do not exist).
 * Returns the error Response to send, or null when the caller is the worker. These routes are
 * outside /api/play, so the browser Origin/CSRF guard in hooks.server.ts does not apply, and
 * they carry no per-IP rate limit.
 */
export function aiWorkerGuard(request: Request): Response | null {
	const verdict = verifyAiWorkerKey(request.headers.get('x-arc-ai-key'));
	if (verdict === 'ok') return null;
	if (verdict === 'disabled') return new Response('Not found', { status: 404, headers: NO_STORE });
	return Response.json({ message: 'Unauthorized.' }, { status: 401, headers: NO_STORE });
}

export function aiJson(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: NO_STORE });
}
