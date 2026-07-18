import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createServerClient } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import { checkPlayApiRequest, securityHeaders } from '$lib/server/httpGuards';

/**
 * Supabase Auth (SSR). Creates a per-request server client bound to the request's
 * cookies, and exposes `locals.safeGetSession()` — which validates the JWT with the
 * Auth server (`getUser`) rather than trusting the unverified cookie session. The
 * existing data/realtime client (`$lib/supabase`) is untouched; this is purely the
 * identity layer.
 */
const supabaseHandle: Handle = async ({ event, resolve }) => {
	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL || 'https://unconfigured.invalid';
	const supabaseAnonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY || 'unconfigured-public-anon-key';
	event.locals.supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
		cookies: {
			getAll: () => event.cookies.getAll(),
			setAll: (cookiesToSet) => {
				for (const { name, value, options } of cookiesToSet) {
					try {
						// httpOnly:false is REQUIRED by the @supabase/ssr browser client, which
						// reads the session from document.cookie. SvelteKit defaults cookies to
						// httpOnly:true, which would hide them from the client (getUser → null on
						// reload). The accepted tradeoff of this pattern (short-lived rotating JWTs)
						// is mitigated by the `script-src 'self'` CSP in svelte.config.js, which
						// stops an injected script from running to read the cookie in the first place.
						event.cookies.set(name, value, { ...options, path: '/', httpOnly: false });
					} catch {
						// Supabase's background token refresh can fire setAll AFTER the response
						// has been generated; `cookies.set` then throws. That rejection is
						// un-awaited (it rides a subscriber promise), so leaving it unhandled
						// crashes the Node process. Swallow it — the rotated cookie is re-applied
						// on the next request's setAll, so nothing is lost.
					}
				}
			}
		}
	});

	event.locals.safeGetSession = async () => {
		// Same-origin web: identity rides the cookie. getSession() reads the (forgeable)
		// cookie; getUser() re-validates the JWT against the Auth server, so it's the only
		// trustworthy source of identity.
		const {
			data: { session }
		} = await event.locals.supabase.auth.getSession();
		if (session) {
			const {
				data: { user },
				error
			} = await event.locals.supabase.auth.getUser();
			if (!error && user) return { session, user };
		}

		// Cross-origin (Capacitor native shell) has no session cookie, so the client sends
		// the access token as a Bearer header instead. Validate it directly against the Auth
		// server (getUser(jwt)) — same trust level as the cookie path. Returns the user so
		// play actions are attributed to a real uid on mobile too.
		const authz = event.request.headers.get('authorization');
		const token = authz && authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
		if (token) {
			const {
				data: { user },
				error
			} = await event.locals.supabase.auth.getUser(token);
			if (!error && user) return { session: null, user };
		}

		return { session: null, user: null };
	};

	return resolve(event, {
		// supabase-js needs these headers to pass through SvelteKit's serialization.
		filterSerializedResponseHeaders: (name) =>
			name === 'content-range' || name === 'x-supabase-api-version'
	});
};

/**
 * CORS for the play API so the Capacitor native shell (which runs on a
 * cross-origin custom scheme and has no same-origin session cookie) can call
 * `/api/play/*` (commands + the `/view` poll). Identity travels EXCLUSIVELY as
 * the validated Supabase access token in the `Authorization: Bearer` header —
 * never a room credential, never a URL query. Live updates ride a Supabase
 * Realtime broadcast channel straight from the client, not this API.
 *
 * Web requests are same-origin, so their Origin is never in this allow-list and
 * NO CORS headers are added — web behavior is unchanged.
 */
const ALLOWED_ORIGINS = new Set([
	'capacitor://localhost',
	'ionic://localhost',
	'http://localhost',
	'https://localhost'
]);

function corsHeaders(origin: string | null): Record<string, string> {
	if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		Vary: 'Origin'
	};
}

const corsHandle: Handle = async ({ event, resolve }) => {
	const isPlayApi = event.url.pathname.startsWith('/api/play/');
	const origin = event.request.headers.get('origin');

	// CORS preflight for cross-origin (Capacitor) API calls.
	if (isPlayApi && event.request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders(origin) });
	}

	// CSRF / content-type / Origin coherence for every state-changing play call.
	// Cookie-authenticated mutations must not be forgeable by a hostile page — even
	// a SAME-SITE sibling origin whose requests still carry SameSite=Lax cookies.
	// CORS alone cannot protect this (it gates reads, not effects).
	if (isPlayApi) {
		const verdict = checkPlayApiRequest({
			method: event.request.method,
			origin,
			contentType: event.request.headers.get('content-type'),
			selfOrigin: event.url.origin,
			trustedOrigins: ALLOWED_ORIGINS
		});
		if (!verdict.ok) {
			return new Response(JSON.stringify({ message: verdict.message }), {
				status: verdict.status,
				headers: { 'content-type': 'application/json' }
			});
		}
	}

	const response = await resolve(event);

	if (isPlayApi) {
		for (const [key, value] of Object.entries(corsHeaders(origin))) {
			response.headers.set(key, value);
		}
	}
	// Baseline security headers on EVERY response. X-Frame-Options mirrors the CSP
	// frame-ancestors directive (svelte.config.js) for older browsers; the CSP header
	// itself is emitted by SvelteKit from the kit.csp config.
	for (const [key, value] of Object.entries(securityHeaders())) {
		if (!response.headers.has(key)) response.headers.set(key, value);
	}
	return response;
};

export const handle: Handle = sequence(supabaseHandle, corsHandle);
