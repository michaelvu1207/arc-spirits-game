import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueAndPoll } from '$lib/play/server/matchmaking';
import { setLastRoomCookie } from '$lib/play/server/cookies';

/**
 * Join (or refresh) the Quick Play matchmaking queue and poll for a match. Requires
 * a VALIDATED account — the automatically-created anonymous guest identity counts,
 * so casual Quick Play stays one tap. Whether the formed match is actually RANKED
 * is decided server-side: only a party whose humans all hold permanent verified
 * identities plays rated; a party containing an anonymous guest plays a casual,
 * unrated matchmade game (an anonymous identity is never represented as a verified
 * ranked identity). The result truthfully carries `rated`.
 *
 * Clients call this repeatedly: each call enqueues the user (idempotent on
 * user_id), runs one pairing attempt, and returns this user's status.
 */
export const POST: RequestHandler = async (event) => {
	const { request, locals, cookies } = event;
	const { user } = await locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sign in (a guest identity is created automatically) to use Quick Play.');
	}

	const body = await request.json().catch(() => ({}) as Record<string, unknown>);
	const displayName = resolveDisplayName(body, user);

	// Verified = a permanent (non-anonymous) account. Derived from the VALIDATED
	// user object — never from the request body.
	const verified = user.is_anonymous !== true;
	// The client-minted per-search ATTEMPT TOKEN (generation-safe cancellation:
	// the client knows it BEFORE this request is sent, so an explicit cancel can
	// always retire exactly this attempt and never a newer same-account search).
	// Format-validated server-side; it only ever binds/cancels the CALLER's own
	// queue row, so it grants nothing over anyone else. Malformed/absent falls
	// back to the legacy server-minted handle.
	const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : null;
	const result = await enqueueAndPoll(user.id, displayName, verified, attemptId);

	if (result.status === 'matched' && result.roomCode) {
		setLastRoomCookie(cookies, result.roomCode, event.url);
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
