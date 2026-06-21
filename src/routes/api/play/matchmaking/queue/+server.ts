import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueAndPoll } from '$lib/play/server/matchmaking';
import { setRoomMemberCookie } from '$lib/play/server/cookies';

/**
 * Join (or refresh) the ranked matchmaking queue and poll for a match. Auth REQUIRED
 * — ranked is account-only. Clients call this repeatedly: each call enqueues the user
 * (idempotent on user_id), runs one pairing attempt, and returns this user's status.
 * Returns { status: 'searching' | 'matched', roomCode?, queued, needed }.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in to play ranked.');
	}

	const body = await request.json().catch(() => ({}) as Record<string, unknown>);
	const displayName = resolveDisplayName(body, user);

	const result = await enqueueAndPoll(user.id, displayName);

	// Belt-and-suspenders (web): once matched, set the room-member cookie so the
	// normal cookie path identifies this player even without the user_id fallback.
	// The memberId is also in the JSON for the cross-origin client to store.
	if (result.status === 'matched' && result.roomCode && result.memberId) {
		setRoomMemberCookie(cookies, result.roomCode, result.memberId);
	}

	return json(result);
};

/** Prefer an explicit body name, then the account's metadata, then email, then a default. */
function resolveDisplayName(
	body: Record<string, unknown>,
	user: { email?: string | null; user_metadata?: Record<string, unknown> | null }
): string {
	const fromBody = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
	if (fromBody) return fromBody.slice(0, 40);

	const meta = user.user_metadata ?? {};
	for (const key of ['display_name', 'name', 'user_name', 'full_name']) {
		const v = meta[key];
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
	}
	if (user.email) return user.email.split('@')[0].slice(0, 40);
	return 'Player';
}
