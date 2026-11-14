import type { RequestHandler } from './$types';
import { listPendingAiDecisions } from '$lib/play/server/aiSeats';
import { aiJson, aiWorkerGuard } from '$lib/server/aiWorkerGuard';

/** AI-seat decisions due now (laptop AI worker only; see scripts/ai-worker). */
export const GET: RequestHandler = async ({ request }) => {
	const denied = aiWorkerGuard(request);
	if (denied) return denied;
	return aiJson({ items: await listPendingAiDecisions() });
};
