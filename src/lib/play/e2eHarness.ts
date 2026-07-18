/**
 * E2E harness posture: `?e2e` on the page URL. The journey suite drives the app
 * through a BUILT production-preview bundle (deterministic lane), where
 * `$app/environment.dev` is compile-time false — so the read-only test
 * diagnostics (`window.__arcAuth`, `window.__arcPlayDiag`) gate on `dev || e2e`.
 *
 * SCOPE, deliberately narrow: the flag exposes only READ-ONLY introspection of
 * state the page's own user already sees (their uid, current room code, channel
 * topic, transport count) — never tokens, secrets, or any override that changes
 * where the client CONNECTS or what it TRUSTS. In particular the dev-only `?ws=`
 * redirect stays gated on `dev` alone: a crafted `?e2e&ws=wss://evil` link must
 * never move auth/tickets to an attacker-chosen server on a production build.
 */
export function isE2eHarness(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return new URLSearchParams(window.location.search).has('e2e');
	} catch {
		return false;
	}
}
