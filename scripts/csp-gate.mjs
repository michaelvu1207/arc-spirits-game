/**
 * CSP ARTIFACT GATE — proves the Content-Security-Policy the app actually SHIPS,
 * not the one the config claims.
 *
 * It builds BOTH deliverables under a deterministic production posture and
 * inspects the EMITTED policy in each:
 *
 *   1. WEB/SERVER: `vite build` (adapter-vercel) + `vite preview`, then reads the
 *      real `Content-Security-Policy` response HEADER off a served page.
 *   2. STATIC/CAPACITOR: `BUILD_TARGET=capacitor vite build` (adapter-static),
 *      then reads the `<meta http-equiv>` policy baked into build/index.html —
 *      the only CSP a Capacitor shell ever gets.
 *
 * FAILS (exit 1) on any of:
 *   - a required exact origin missing (Supabase REST/Auth + its wss Realtime
 *     twin, the room WSS origin, the API base) from connect-src;
 *   - configured Supabase Storage ARTWORK blocked by img-src (the exact
 *     `<img src>` URLs assetStore builds);
 *   - any wildcard source or any loopback host/port in the production policy;
 *   - DISAGREEMENT between the server-emitted and static-emitted policies
 *     (normalized: nonces/hashes stripped, meta-inapplicable directives such as
 *     frame-ancestors excluded from the comparison);
 *   - the browser-level proof failing: a real Chromium loads the static build
 *     under its emitted meta CSP and the storage artwork must actually load
 *     (and a foreign-origin image must actually be blocked). Run via
 *     scripts/csp-gate.playwright.config.ts → scripts/csp-artifact.spec.ts.
 *
 * TWO MODES:
 *
 *   DEFAULT (deterministic regression): builds with the gate's OWN synthetic
 *   canonical env below — reproducible on any machine, never depends on (or
 *   leaks) a real project's configuration. It proves the DERIVATION machinery;
 *   it deliberately cannot prove your release URLs are right.
 *
 *   --release (fail-closed release-config gate): builds with the ACTUAL
 *   non-secret PUBLIC origins of the release — taken from the shell env first
 *   (explicitly supplied), then Vite's production-mode files
 *   (.env.production.local, .env.production — the canonical release env
 *   source). The base .env/.env.local dev files are deliberately NOT a
 *   fallback: they hold checked-in placeholders and local stacks. Every
 *   required value must be PRESENT, well-formed, https/wss, non-loopback,
 *   wildcard-free and not the checked-in placeholder — a missing or wrong
 *   release URL FAILS the gate instead of being papered over with synthetic
 *   values — and the same emitted-artifact + Chromium proofs then validate
 *   THOSE EXACT values. These URLs are public configuration; no secret is read
 *   or printed (the anon key is passed through only as a build input and never
 *   asserted or logged).
 *
 * The artifacts produced are check-only — rebuild before deploying.
 *
 * Run: npm run gate:csp            (node scripts/csp-gate.mjs)
 *      npm run gate:csp:release    (node scripts/csp-gate.mjs --release)
 */

import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const RELEASE = process.argv.includes('--release');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Local tool bins invoked directly (no npx wrapper layer: a wrapper is one more
 *  process between the gate and the real Vite/Playwright tree, and killing only
 *  the wrapper is exactly how descendants get orphaned). */
const BIN = (name) => join(REPO, 'node_modules', '.bin', name);

// ── verified process ownership ─────────────────────────────────────────────────
// EVERY child this gate starts (builds, preview, the Playwright proof) runs in
// its own process group (procOwn.spawnOwned) and is tracked here; teardown —
// normal, error, or interruption (SIGINT/SIGTERM) — group-TERMs then group-KILLs
// and AWAITS the real exit, so no Vite/Playwright descendant can outlive the
// gate no matter which path exits it.
const owned = new Set();

async function stopAllOwned() {
	for (const child of [...owned]) {
		owned.delete(child);
		await stopOwned(child, { termTimeoutMs: 3000 }).catch(() => {});
	}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		void stopAllOwned().finally(() => process.exit(130));
	});
}

// ── synthetic canonical config (deterministic regression mode) ────────────────────
const SYNTHETIC = {
	supabaseUrl: 'https://gate-project.supabase.co',
	wsServerUrl: 'wss://rooms.gate.example/ws',
	apiBaseUrl: 'https://app.gate.example',
	anonKey: 'gate-anon-key'
};

/** Parse one dotenv file (KEY=value lines, quotes stripped) — read-only. */
function dotenvFile(path) {
	const out = {};
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return out;
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
	return out;
}

/** A release var, from RELEASE-SCOPED sources only: the shell env (explicitly
 *  supplied actual origins) or Vite's production-mode files
 *  (.env.production.local > .env.production — the canonical release env source).
 *  The base .env/.env.local are deliberately NOT consulted here: they carry the
 *  checked-in dev placeholders (`your-project-id.supabase.co`) and local stacks,
 *  and silently blessing one of those is exactly the failure this gate exists
 *  to catch — a missing release value must FAIL, not fall back. */
function releaseVar(name) {
	if (process.env[name]) return process.env[name];
	for (const file of ['.env.production.local', '.env.production']) {
		const value = dotenvFile(join(REPO, file))[name];
		if (value) return value;
	}
	return '';
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$|\.localhost$/i;

/** FAIL-CLOSED release URL validation: present, parseable, expected scheme,
 *  non-loopback, wildcard-free. Returns the URL or exits the gate. */
function requireReleaseUrl(name, raw, schemes) {
	const fail = (why) => {
		console.error(
			`RELEASE CSP GATE: ${name} ${why}. Set the real release value in the shell env ` +
				`or .env.production[.local] — the gate never substitutes a synthetic one.`
		);
		process.exit(1);
	};
	if (!raw) fail('is MISSING');
	let url;
	try {
		url = new URL(raw);
	} catch {
		return fail(`is not a valid URL`);
	}
	if (!schemes.includes(url.protocol)) {
		fail(`must use ${schemes.join(' or ')} (got ${url.protocol})`);
	}
	if (LOOPBACK_HOST.test(url.hostname)) fail(`points at loopback (${url.hostname})`);
	if (raw.includes('*')) fail('contains a wildcard');
	// The repo's checked-in dev placeholder must never be blessed as a release URL.
	if (/your-project-id/i.test(url.hostname)) fail('is the checked-in placeholder value');
	return url;
}

/** The gate's effective configuration for this run. */
function resolveGateConfig() {
	if (!RELEASE) return SYNTHETIC;
	const supabase = requireReleaseUrl('PUBLIC_SUPABASE_URL', releaseVar('PUBLIC_SUPABASE_URL'), [
		'https:'
	]);
	const ws = requireReleaseUrl('PUBLIC_WS_SERVER_URL', releaseVar('PUBLIC_WS_SERVER_URL'), [
		'wss:'
	]);
	const api = requireReleaseUrl('PUBLIC_API_BASE_URL', releaseVar('PUBLIC_API_BASE_URL'), [
		'https:'
	]);
	// The anon key is a required BUILD input (public by design) but never asserted
	// or printed by this gate.
	const anonKey = releaseVar('PUBLIC_SUPABASE_ANON_KEY');
	if (!anonKey) {
		console.error('RELEASE CSP GATE: PUBLIC_SUPABASE_ANON_KEY is MISSING (build input).');
		process.exit(1);
	}
	return {
		supabaseUrl: supabase.toString().replace(/\/$/, ''),
		wsServerUrl: ws.toString(),
		apiBaseUrl: api.toString().replace(/\/$/, ''),
		anonKey
	};
}

const CONFIG = resolveGateConfig();
const SUPABASE_ORIGIN = new URL(CONFIG.supabaseUrl).origin;
const SUPABASE_WSS_TWIN = `wss://${new URL(CONFIG.supabaseUrl).host}`;
const ROOM_WS_ORIGIN = new URL(CONFIG.wsServerUrl).origin;
const API_ORIGIN = new URL(CONFIG.apiBaseUrl).origin;
/** Exactly how assetStore builds artwork URLs (supabase.ts STORAGE_BASE_URL). */
const ARTWORK_URL = `${SUPABASE_ORIGIN}/storage/v1/object/public/game_assets/guardians/example-icon.png`;

const GATE_ENV = {
	...process.env,
	NODE_ENV: 'production',
	// EXPLICITLY pinned (shell env wins over every dotenv file in both Vite and
	// svelte.config.js), so the artifacts are built from EXACTLY the validated
	// values — synthetic in regression mode, the real release URLs in --release.
	PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
	PUBLIC_SUPABASE_ANON_KEY: CONFIG.anonKey,
	PUBLIC_WS_SERVER_URL: CONFIG.wsServerUrl,
	PUBLIC_API_BASE_URL: API_ORIGIN
};

const PREVIEW_PORT = 4680 + Math.floor(Math.random() * 200);

const results = [];
function check(name, cond, detail = '') {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!cond) process.exitCode = 1;
}

async function run(bin, args, { env = GATE_ENV, label = bin } = {}) {
	// Owned + group-scoped: the child (and every descendant it spawns — Vite
	// workers, Playwright browsers/web servers) dies with the gate on any exit
	// path, not just the happy one.
	const child = spawnOwned('node', [BIN(bin), ...args], { cwd: REPO, env, label });
	owned.add(child);
	try {
		const [code] = await once(child, 'exit');
		if (code !== 0) {
			throw new Error(`${label} exited ${code}\n${child.ownedLog.slice(-4000)}`);
		}
		return child.ownedLog;
	} finally {
		owned.delete(child);
		// Sweep the group even after a clean exit: a build must not leave workers.
		await stopOwned(child, { termTimeoutMs: 1000 }).catch(() => {});
	}
}

/** Parse a CSP policy string into directive → source list. */
function parsePolicy(policy) {
	const directives = {};
	for (const part of policy.split(';')) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		directives[tokens[0].toLowerCase()] = tokens.slice(1);
	}
	return directives;
}

const LOOPBACK = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** The shared per-policy assertions (server header AND static meta). */
function assertPolicy(name, directives) {
	const connect = directives['connect-src'] ?? [];
	for (const origin of ['self', SUPABASE_ORIGIN, SUPABASE_WSS_TWIN, ROOM_WS_ORIGIN, API_ORIGIN]) {
		const want = origin === 'self' ? "'self'" : origin;
		check(`[${name}] connect-src carries ${origin}`, connect.includes(want) || connect.includes(origin));
	}
	const img = directives['img-src'] ?? [];
	check(
		`[${name}] img-src admits the configured storage origin (artwork not blocked)`,
		img.includes(SUPABASE_ORIGIN),
		`img-src = ${img.join(' ')}`
	);
	check(
		`[${name}] artwork URL origin is admitted by img-src`,
		img.includes(new URL(ARTWORK_URL).origin)
	);
	let cleanSources = true;
	let offender = '';
	for (const [directive, sources] of Object.entries(directives)) {
		for (const source of sources) {
			if (source.includes('*') || LOOPBACK.test(source)) {
				cleanSources = false;
				offender = `${directive} ${source}`;
			}
		}
	}
	check(`[${name}] no wildcard and no loopback source anywhere in the policy`, cleanSources, offender);
	check(`[${name}] default-src stays 'self'`, (directives['default-src'] ?? []).join(' ') === "'self'");
	const script = directives['script-src'] ?? [];
	check(
		`[${name}] script-src has no unsafe-inline/unsafe-eval`,
		!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'")
	);
}

/** Normalize for server↔static comparison: drop per-response nonces/hashes and
 *  the directives a <meta> policy cannot carry (the browser ignores them there,
 *  so the header legitimately has them and the meta legitimately does not). */
function normalizeForComparison(directives) {
	const out = {};
	for (const [directive, sources] of Object.entries(directives)) {
		if (['frame-ancestors', 'report-uri', 'report-to', 'sandbox'].includes(directive)) continue;
		out[directive] = sources
			.filter((s) => !/^'(nonce|sha256|sha384|sha512)-/.test(s))
			.slice()
			.sort();
	}
	return out;
}

async function fetchHeaderPolicy() {
	// vite preview serves the REAL built server output (.svelte-kit/output) — the
	// header read here is the one the built server code emits, not config source.
	// Owned + group-scoped: the previous shape killed only a wrapper process, and
	// an interrupted/erroring gate could orphan the actual Vite listener.
	const preview = spawnOwned(
		'node',
		[BIN('vite'), 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
		{ cwd: REPO, env: GATE_ENV, label: 'vite preview' }
	);
	owned.add(preview);
	try {
		let policy = null;
		for (let attempt = 0; attempt < 60 && policy == null; attempt += 1) {
			if (preview.exitCode != null) break; // died — fail fast with its log
			try {
				const res = await fetch(`http://localhost:${PREVIEW_PORT}/play`, {
					signal: AbortSignal.timeout(2000)
				});
				policy = res.headers.get('content-security-policy');
				if (res.status >= 500) throw new Error(`preview answered ${res.status}`);
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		if (!policy) {
			throw new Error(
				`no Content-Security-Policy header from preview\n${preview.ownedLog.slice(-2000)}`
			);
		}
		return policy;
	} finally {
		// Verified group teardown: TERM → bounded wait → KILL, ACTUAL exit awaited
		// (procOwn.stopOwned) — descendants included.
		owned.delete(preview);
		await stopOwned(preview, { termTimeoutMs: 3000 }).catch(() => {});
	}
}

function readMetaPolicy() {
	const html = readFileSync(new URL('../build/index.html', import.meta.url), 'utf8');
	const match = html.match(
		/<meta http-equiv="content-security-policy" content="([^"]*)"/i
	);
	if (!match) throw new Error('build/index.html has NO emitted <meta> CSP — the Capacitor shell would ship unprotected.');
	return match[1];
}

async function main() {
	console.log(`══ CSP artifact gate ${RELEASE ? '(RELEASE config — real origins)' : '(deterministic synthetic config)'} ══`);
	if (RELEASE) {
		// Public configuration only — printing these is the point of the gate.
		console.log(`   supabase: ${SUPABASE_ORIGIN}`);
		console.log(`   room ws:  ${ROOM_WS_ORIGIN}`);
		console.log(`   api:      ${API_ORIGIN}`);
	}
	console.log('→ building WEB/SERVER target (adapter-vercel)…');
	await run('vite', ['build'], { label: 'web build' });
	console.log('→ reading the EMITTED header from vite preview…');
	const headerPolicy = await fetchHeaderPolicy();
	const serverDirectives = parsePolicy(headerPolicy);
	assertPolicy('server', serverDirectives);
	check(
		'[server] header (not meta) carries frame-ancestors none',
		(serverDirectives['frame-ancestors'] ?? []).join(' ') === "'none'"
	);

	console.log('→ building STATIC/CAPACITOR target (adapter-static)…');
	await run('vite', ['build'], {
		env: { ...GATE_ENV, BUILD_TARGET: 'capacitor', VITE_BUILD_TARGET: 'capacitor' },
		label: 'static build'
	});
	const metaPolicy = readMetaPolicy();
	const staticDirectives = parsePolicy(metaPolicy);
	assertPolicy('static', staticDirectives);

	const serverNorm = JSON.stringify(normalizeForComparison(serverDirectives), null, 1);
	const staticNorm = JSON.stringify(normalizeForComparison(staticDirectives), null, 1);
	check(
		'[agreement] server-emitted and static-emitted policies agree (normalized)',
		serverNorm === staticNorm,
		serverNorm === staticNorm ? '' : `server=${serverNorm}\nstatic=${staticNorm}`
	);

	console.log('→ browser-level proof: Chromium loads the static build under its emitted CSP…');
	try {
		await run('playwright', ['test', '--config', 'scripts/csp-gate.playwright.config.ts'], {
			env: { ...GATE_ENV, ARC_CSP_GATE_STORAGE_ORIGIN: SUPABASE_ORIGIN, ARC_CSP_GATE_ARTWORK_URL: ARTWORK_URL },
			label: 'browser CSP proof'
		});
		check('[browser] storage artwork loads + foreign origin blocked under the emitted CSP', true);
	} catch (err) {
		check('[browser] storage artwork loads + foreign origin blocked under the emitted CSP', false, String(err.message).slice(0, 2000));
	}

	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${passed}/${results.length} CSP gate checks passed`);
	if (passed !== results.length) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error('CSP GATE ERROR:', err);
		process.exitCode = 1;
	})
	.finally(() => stopAllOwned());
