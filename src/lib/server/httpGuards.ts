/**
 * Cross-site request protection for the cookie-authenticated play API — the PURE
 * decision half, unit-testable without SvelteKit.
 *
 * Threat: the auth session rides cookies for same-origin browsers, and SvelteKit's
 * built-in CSRF check only covers form-encoded content types. A hostile page —
 * including a SAME-SITE sibling origin, whose requests carry SameSite=Lax cookies —
 * can POST `text/plain`-smuggled JSON with credentials and our handlers would parse
 * it. CORS does not protect the server here: it gates response READS, not effects.
 *
 * Rule for every state-changing (non-GET/HEAD/OPTIONS) /api/play request:
 *   1. Content-Type must be application/json — our clients always send it, and a
 *      cross-site form/text/plain smuggle never can (a cross-origin fetch with a
 *      JSON content type is preflighted and dies at CORS).
 *   2. If an Origin header is present it must be EXACTLY the app's own origin or a
 *      configured trusted app shell origin (Capacitor). A browser always attaches
 *      Origin to cross-origin and same-origin POSTs, so a foreign Origin — even a
 *      same-site sibling — is refused regardless of what cookies rode along.
 *      Origin-less requests (curl, server-to-server, native HTTP stacks) carry no
 *      ambient browser credentials, so they authenticate explicitly (Bearer) or not
 *      at all.
 */

export interface PlayApiRequestFacts {
	method: string;
	/** The `Origin` request header, if any. */
	origin: string | null;
	/** The `Content-Type` request header, if any. */
	contentType: string | null;
	/** The origin the app itself is served from (event.url.origin). */
	selfOrigin: string;
	/** Additional trusted app-shell origins (the Capacitor allow-list). */
	trustedOrigins: ReadonlySet<string>;
}

export type PlayApiGuardVerdict = { ok: true } | { ok: false; status: number; message: string };

export function checkPlayApiRequest(facts: PlayApiRequestFacts): PlayApiGuardVerdict {
	const method = facts.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };

	const contentType = (facts.contentType ?? '').split(';')[0].trim().toLowerCase();
	if (contentType !== 'application/json') {
		return {
			ok: false,
			status: 415,
			message: 'Play API mutations require Content-Type: application/json.'
		};
	}

	if (facts.origin != null) {
		const origin = facts.origin;
		if (origin !== facts.selfOrigin && !facts.trustedOrigins.has(origin)) {
			return {
				ok: false,
				status: 403,
				message: 'Cross-origin request refused.'
			};
		}
	}

	return { ok: true };
}

/**
 * Response security headers applied to EVERY response (hooks.server.ts).
 *
 * X-Frame-Options complements the CSP `frame-ancestors 'none'` directive
 * (svelte.config.js): together they forbid framing the authenticated app in every
 * browser generation — a framed session cookie is a clickjacking overlay waiting
 * to happen. nosniff stops content-type confusion on API JSON, and the referrer
 * policy keeps room codes / paths out of cross-origin referrers.
 */
export function securityHeaders(): Record<string, string> {
	return {
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin'
	};
}
