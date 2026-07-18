import type { Cookies } from '@sveltejs/kit';

/**
 * NON-AUTHORIZING room convenience cookies.
 *
 * Identity/authorization no longer rides ANY room cookie: the validated Supabase
 * session (or Bearer token) is the sole durable principal, resolved per request by
 * `locals.safeGetSession()`. What remains here is pure convenience state:
 *
 *  - `arc_spirits_play_last_room` — the last room the browser touched, used only to
 *    offer "return to your game". Reading it grants nothing.
 *  - `clearLegacyRoomCredentialCookies` — actively deletes the RETIRED per-room
 *    credential cookies (`arc_spirits_play_member_<CODE>`, which historically held a
 *    public member UUID and later a room secret). They stopped authorizing when the
 *    account trust model shipped; purging them keeps stale credentials out of
 *    request headers, logs and traces for good.
 */
const LEGACY_ROOM_COOKIE_PREFIX = 'arc_spirits_play_member_';
const LAST_ROOM_COOKIE = 'arc_spirits_play_last_room';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

/**
 * `Secure` follows the request transport: HTTPS (all production traffic — Vercel
 * terminates TLS and forwards proto) sets Secure; plain-HTTP localhost (dev server,
 * e2e webServer, emulator smokes) stays non-Secure so the browser still stores it.
 */
function cookieOptions(requestUrl: URL) {
	return {
		httpOnly: true,
		path: '/',
		sameSite: 'lax' as const,
		secure: requestUrl.protocol === 'https:',
		maxAge: MAX_AGE_SECONDS
	};
}

export function getLastRoomCookie(cookies: Cookies): string | null {
	return cookies.get(LAST_ROOM_COOKIE) ?? null;
}

export function setLastRoomCookie(cookies: Cookies, roomCode: string, requestUrl: URL) {
	cookies.set(LAST_ROOM_COOKIE, normalizeRoomCode(roomCode), cookieOptions(requestUrl));
}

/** Delete every retired per-room credential cookie the browser still carries. */
export function clearLegacyRoomCredentialCookies(cookies: Cookies) {
	for (const { name } of cookies.getAll()) {
		if (name.startsWith(LEGACY_ROOM_COOKIE_PREFIX)) {
			cookies.delete(name, { path: '/' });
		}
	}
}
