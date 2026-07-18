import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { acceptSocialInvite, previewSocialInvite } from '$lib/play/server/social';
import { enforceRateLimit } from '$lib/server/rateLimit';

export const GET: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-invite-preview', 90, 60_000);
	return json(await previewSocialInvite(event.params.token), { headers: { 'cache-control': 'no-store' } });
};

export const POST: RequestHandler = async (event) => {
	enforceRateLimit(event, 'social-invite-accept', 20, 60_000);
	const { user } = await event.locals.safeGetSession();
	if (!user) throw error(401, 'Sign in to accept this invitation.');
	return json(await acceptSocialInvite(user.id, event.params.token), {
		headers: { 'cache-control': 'no-store' }
	});
};
