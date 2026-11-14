import type { RequestHandler } from './$types';
import { actForAiSeat } from '$lib/play/server/aiSeats';
import { aiJson, aiWorkerGuard } from '$lib/server/aiWorkerGuard';

/** Apply one AI-seat answer (laptop AI worker only; see scripts/ai-worker). */
export const POST: RequestHandler = async ({ request }) => {
	const denied = aiWorkerGuard(request);
	if (denied) return denied;
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') return aiJson({ message: 'A JSON body is required.' }, 400);
	const result = await actForAiSeat(body);
	return aiJson(result.body, result.status);
};
