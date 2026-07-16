import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { abandonEntryOp } from '$lib/play/server/service';
import { enforceRateLimit } from '$lib/server/rateLimit';

/**
 * Abandon an ENTRY OPERATION (room create / solo / join) whose response the
 * client never received — the ambiguous-commit compensation contract (see
 * 20260712_entry_op_compensation.sql).
 *
 * The client minted the unguessable `opId` BEFORE sending the original request,
 * so it can name the exact server effect to unwind even with no response body:
 * the op id is tombstoned FIRST (an original request still in flight
 * self-compensates on its post-commit re-check, whatever the arrival order),
 * then whatever the op already created — the session stamped with it, or the
 * membership it added — is left/closed. A membership that predates the op never
 * carries its stamp and is untouchable through it.
 *
 * Auth REQUIRED: compensation acts only on the CALLER's own room/membership
 * (the op id names the effect; the validated account authorizes it).
 */
export const POST: RequestHandler = async (event) => {
	const { locals, request } = event;
	enforceRateLimit(event, 'abandon-entry', 30, 60_000);
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in (a guest identity is created automatically) first.');
	}
	const body = (await request.json().catch(() => null)) as { opId?: unknown } | null;
	const opId = typeof body?.opId === 'string' ? body.opId : '';
	const result = await abandonEntryOp(opId, user.id);
	return json({ ok: true, ...result });
};
