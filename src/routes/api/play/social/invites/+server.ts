import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSocialInvite, revokeSocialInvite } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

async function uid(event: Parameters<RequestHandler>[0]) {
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to manage invitations.');
	return user.id;
}

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-invite-create', 20, 60_000);
	const body = await event.request.json().catch(() => ({}));
	if (body.action === 'revoke') {
		return json(await revokeSocialInvite(await uid(event), String(body.inviteId ?? '')), {
			headers: { 'cache-control': 'no-store' }
		});
	}
	const result = await createSocialInvite(await uid(event), {
		kind: body.kind === 'friend' || body.kind === 'room' ? body.kind : 'party',
		targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : null,
		roomCode: typeof body.roomCode === 'string' ? body.roomCode : null
	});
	return json(result, { headers: { 'cache-control': 'no-store' } });
};

export const DELETE: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-invite-revoke', 20, 60_000);
	const body = await event.request.json().catch(() => ({}));
	return json(await revokeSocialInvite(await uid(event), String(body.inviteId ?? '')), {
		headers: { 'cache-control': 'no-store' }
	});
};
