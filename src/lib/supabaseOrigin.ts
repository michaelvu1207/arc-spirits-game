import { env as publicEnv } from '$env/dynamic/public';

/**
 * Same-origin mode, used by the local game (scripts/local-game/start.mjs sets
 * PUBLIC_SUPABASE_SAME_ORIGIN=1): the "Supabase" paths (/rest/v1, /auth/v1, /storage/v1,
 * /realtime/v1) are served by the app's own origin, whatever host name the browser used
 * (127.0.0.1 on the Mac, the tailnet name from another device). Unset (production, Vercel)
 * nothing here changes behaviour.
 */
export const SUPABASE_SAME_ORIGIN = publicEnv.PUBLIC_SUPABASE_SAME_ORIGIN === '1';

/** The Supabase URL for a client: the page origin in the browser in same-origin mode,
 *  otherwise PUBLIC_SUPABASE_URL (on the server it is the app's internal address). */
export function supabaseUrl(): string {
	if (SUPABASE_SAME_ORIGIN && typeof window !== 'undefined') return window.location.origin;
	return publicEnv.PUBLIC_SUPABASE_URL?.trim() || 'https://unconfigured.invalid';
}

/** Same-origin mode: one auth cookie name for every host name. The default name comes from
 *  the URL's host, so the browser and the server would otherwise look for different cookies. */
export const authCookieOptions = SUPABASE_SAME_ORIGIN ? { name: 'sb-local-auth-token' } : undefined;
