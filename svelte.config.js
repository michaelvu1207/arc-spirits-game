import adapterVercel from '@sveltejs/adapter-vercel';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';

// `npm run build:app` sets BUILD_TARGET=capacitor and produces a static SPA
// bundle for the Capacitor native shell. The default (web) build is unchanged
// and continues to use adapter-vercel (SSR on Vercel).
// NOTE: the static build requires the play route's server load to be moved
// client-side first — see CAPACITOR.md ("Static SPA build" section).
const capacitor = process.env.BUILD_TARGET === 'capacitor';

// ── connect-src derivation ──────────────────────────────────────────────────────
// This config file loads BEFORE Vite reads the dotenv files, so the PUBLIC_* vars
// the app connects to are parsed here directly, mirroring Vite's OWN env
// behavior: the MODE-SPECIFIC set `.env < .env.local < .env.[mode] <
// .env.[mode].local` (later files override earlier), with the shell env winning
// over all files. Mode follows Vite's default resolution — Vite sets
// process.env.NODE_ENV before this config loads ('production' for `vite build`,
// 'development' for `vite dev`) — so a production build reads `.env.production`
// / `.env.production.local` exactly like Vite's import.meta.env does, and the
// CSP allowlist can no longer diverge from the URLs the built app actually uses.
// Values are used ONLY to build the CSP allowlist below — never logged.
/** @returns {Record<string, string>} */
function dotenvValues() {
	const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
	const out = /** @type {Record<string, string>} */ ({});
	for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
		let text;
		try {
			text = readFileSync(new URL(file, import.meta.url), 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (key) out[key] = value;
		}
	}
	return out;
}

/** Shell env wins over dotenv, mirroring Vite's own precedence. */
function makeReadVar() {
	const dotenv = dotenvValues();
	return (/** @type {string} */ name) => process.env[name] ?? dotenv[name] ?? '';
}

/** localhost in every spelling — the loopback hosts a PRODUCTION policy must never
 *  admit (a production page allowed to talk to loopback is an SSRF/dev-leak smell,
 *  and it means a placeholder/dev env var silently shipped). */
function isLoopbackHostname(/** @type {string} */ hostname) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '0.0.0.0' ||
		hostname === '::1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	);
}

/**
 * Parse a configured backend URL into its NORMALIZED EXACT origin, refusing
 * anything a production allowlist must not contain: malformed values contribute
 * nothing, wildcards contribute nothing ever, and loopback origins contribute
 * nothing in production (dev/e2e/bench harnesses legitimately run everything on
 * loopback with per-run ports, so non-production keeps them).
 * @returns {URL | null}
 */
function admissibleOrigin(/** @type {string} */ raw) {
	if (!raw) return null;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null; // malformed/placeholder — contributes nothing to the allowlist
	}
	if (url.origin === 'null' || url.origin.includes('*')) return null;
	if (process.env.NODE_ENV === 'production' && isLoopbackHostname(url.hostname)) return null;
	return url;
}

/**
 * The restrictive connect-src: 'self' plus EXACTLY the configured backends —
 * the Supabase HTTP/Auth origin (and its ws(s) twin for Realtime), the room
 * server's WebSocket origin, and the Capacitor shell's API base. Dev stacks
 * additionally allow localhost origins (the e2e/bench harnesses run everything
 * on loopback with per-run ports); production builds get only the configured
 * non-loopback origins, so an injected script cannot exfiltrate to an attacker
 * host even if script-src were ever bypassed.
 */
function connectSrcDirectives() {
	const readVar = makeReadVar();
	const sources = new Set(['self']);
	const addOrigin = (/** @type {string} */ raw, { withWsTwin = false } = {}) => {
		const url = admissibleOrigin(raw);
		if (!url) return;
		sources.add(url.origin);
		if (withWsTwin) {
			const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
			sources.add(`${wsScheme}//${url.host}`);
		}
	};
	addOrigin(readVar('PUBLIC_SUPABASE_URL'), { withWsTwin: true }); // REST + Auth + Realtime
	addOrigin(readVar('PUBLIC_WS_SERVER_URL')); // room server WS
	addOrigin(readVar('PUBLIC_API_BASE_URL')); // Capacitor → deployed API
	// The WebGL/splat engine initializes its WebAssembly by FETCHING inline data:
	// (and same-document blob:) URLs — no network, no exfiltration surface; without
	// these the engine dies under the restrictive connect-src.
	sources.add('data:');
	sources.add('blob:');
	if (process.env.NODE_ENV !== 'production') {
		for (const local of [
			'http://localhost:*',
			'http://127.0.0.1:*',
			'ws://localhost:*',
			'ws://127.0.0.1:*'
		]) {
			sources.add(local);
		}
	}
	// Computed origins can't be expressed in kit's literal `Csp.Source` union type
	// (and the Csp namespace isn't importable from JS); the values are exactly the
	// CSP source strings the runtime expects.
	return /** @type {any} */ ([...sources]);
}

/**
 * img-src: self/data:/blob: plus ONE derived external origin — the normalized
 * exact configured Supabase origin, because ALL game artwork (guardian icons,
 * mats, chibis, spirit prints) is served as direct `<img src>` loads from the
 * Supabase Storage public bucket on that origin (src/lib/supabase.ts
 * STORAGE_BASE_URL → assetStore). Without it the production policy blocks every
 * board/menu image. Image URLs are otherwise a classic credential-exfiltration
 * channel (GET with the secret in the query), so NOTHING else is admitted: no
 * wildcards ever, and no loopback in production (dev keeps its local store).
 */
function imgSrcDirectives() {
	const readVar = makeReadVar();
	const sources = new Set(['self', 'data:', 'blob:']);
	const supabase = admissibleOrigin(readVar('PUBLIC_SUPABASE_URL'));
	if (supabase) sources.add(supabase.origin);
	return /** @type {any} */ ([...sources]);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: capacitor
			? adapterStatic({ fallback: 'index.html', precompress: false, strict: false })
			: adapterVercel({
					runtime: 'nodejs22.x'
				}),
		// Content-Security-Policy. The auth session cookie is JS-readable (the required
		// @supabase/ssr browser-client tradeoff), so the primary mitigation is locking
		// down script execution: `script-src 'self'` (SvelteKit auto-adds nonces/hashes
		// to its own inline bootstrap) blocks any injected/inline attacker script from
		// running — no XSS payload, no token theft. Behind it, EVERY exfiltration and
		// embedding channel is pinned, not just connect-src:
		//   - default-src 'self' is the conservative fallback for anything unlisted;
		//   - img-src is restricted to self/data:/blob: + EXACTLY the configured
		//     Supabase Storage origin (game artwork loads from there as <img src>) —
		//     an image URL is a classic credential-exfiltration channel (GET with
		//     the secret in the query), so no other external origin is admitted;
		//   - form-action 'self' stops a smuggled <form> from posting anywhere else;
		//   - frame-ancestors 'none' (+ the X-Frame-Options header in hooks.server.ts)
		//     forbids framing the authenticated app entirely — no clickjacking overlay;
		//   - frame-src 'none': the app embeds nothing, so nothing may be embedded;
		//   - connect-src is the fetch/WS allow-list: only 'self' + the configured
		//     Supabase (HTTP/Auth/Realtime) and room-server WS origins are reachable.
		// Google Fonts is the ONE deliberate external pair (stylesheet + font files);
		// style-src additionally keeps 'unsafe-inline' because Svelte injects <style>
		// at runtime (transitions) and app.html paints the launch background inline —
		// style injection without script execution is not a credential channel.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// 'wasm-unsafe-eval' allows the WebGL/splat engine's WebAssembly to compile
				// WITHOUT permitting general eval() — injected JS still can't run. worker-src
				// allows the engine's blob-URL workers (safe: an attacker can't create one
				// without first running a script, which 'self' already blocks).
				'script-src': ['self', 'wasm-unsafe-eval'],
				'worker-src': ['self', 'blob:'],
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				'img-src': imgSrcDirectives(),
				'media-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'frame-src': ['none'],
				'manifest-src': ['self'],
				'connect-src': connectSrcDirectives()
			}
		}
	}
};

export default config;
