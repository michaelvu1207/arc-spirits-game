/**
 * Production security-policy regressions — the CSP built into every page response
 * (kit.csp in svelte.config.js) and the baseline headers hooks.server.ts stamps.
 *
 * These lock the actual shipped policy, not a comment's claim about it:
 *  - framing the authenticated app is forbidden (frame-ancestors + X-Frame-Options);
 *  - default/img/form destinations are conservative, so an injected element cannot
 *    exfiltrate credentials via an image GET or a form POST to a foreign origin;
 *  - script-src stays free of unsafe-inline/unsafe-eval (wasm-unsafe-eval only);
 *  - the dev-only localhost wildcards never leak into a production connect-src.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { securityHeaders } from './httpGuards';

type Directives = Record<string, string[]>;
let directives: Directives;

/** The exact storage origin these tests pin into the production policy. */
const SUPABASE_ORIGIN = 'https://csp-regression.supabase.co';

/** (Re)derive the CSP directives from svelte.config.js under a controlled env —
 *  the config computes them at IMPORT time, so each posture needs a fresh import. */
async function deriveDirectives(env: Record<string, string>): Promise<Directives> {
	const saved: Record<string, string | undefined> = { NODE_ENV: process.env.NODE_ENV };
	process.env.NODE_ENV = 'production';
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		vi.resetModules();
		const config = (await import('../../../svelte.config.js')).default as {
			kit: { csp: { mode: string; directives: Directives } };
		};
		expect(config.kit.csp.mode).toBe('auto');
		return config.kit.csp.directives;
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

beforeAll(async () => {
	// svelte.config.js derives connect-src/img-src at import time from NODE_ENV and
	// the configured backends — import it under the PRODUCTION posture with a real
	// (non-loopback) Supabase origin, the shape these regressions exist for.
	directives = await deriveDirectives({ PUBLIC_SUPABASE_URL: `${SUPABASE_ORIGIN}/` });
});

describe('production CSP directives', () => {
	test('framing the authenticated app is forbidden, and nothing may be embedded', () => {
		expect(directives['frame-ancestors']).toEqual(['none']);
		expect(directives['frame-src']).toEqual(['none']);
	});

	test('conservative default posture: unlisted fetch surfaces fall back to self', () => {
		expect(directives['default-src']).toEqual(['self']);
		expect(directives['base-uri']).toEqual(['self']);
		expect(directives['object-src']).toEqual(['none']);
	});

	test('image destinations: self/data:/blob: + EXACTLY the configured Supabase Storage origin', () => {
		// Game artwork (guardian icons/mats/chibis, spirit prints) is served as
		// direct <img src> from the Supabase Storage public bucket — the policy must
		// admit that exact origin and NOTHING else external.
		expect(directives['img-src']).toEqual(['self', 'data:', 'blob:', SUPABASE_ORIGIN]);
	});

	test('a LOOPBACK Supabase origin never reaches a production img-src/connect-src (a dev placeholder must not ship)', async () => {
		const local = await deriveDirectives({ PUBLIC_SUPABASE_URL: 'http://127.0.0.1:8095' });
		expect(local['img-src']).toEqual(['self', 'data:', 'blob:']);
		for (const source of local['connect-src']) {
			expect(source.includes('127.0.0.1'), `loopback leaked: ${source}`).toBe(false);
			expect(source.includes('localhost'), `loopback leaked: ${source}`).toBe(false);
		}
	});

	test('a WILDCARD or malformed configured origin contributes nothing to any directive', async () => {
		const wild = await deriveDirectives({
			PUBLIC_SUPABASE_URL: 'https://*.supabase.co',
			PUBLIC_API_BASE_URL: 'not a url'
		});
		for (const values of [wild['img-src'], wild['connect-src']]) {
			for (const source of values) {
				expect(source.includes('*'), `wildcard leaked: ${source}`).toBe(false);
			}
		}
	});

	test('forms can only post to the app itself', () => {
		expect(directives['form-action']).toEqual(['self']);
	});

	test('script execution stays locked: no unsafe-inline / unsafe-eval, wasm compile only', () => {
		expect(directives['script-src']).toContain('self');
		expect(directives['script-src']).toContain('wasm-unsafe-eval');
		expect(directives['script-src']).not.toContain('unsafe-inline');
		expect(directives['script-src']).not.toContain('unsafe-eval');
	});

	test('the deliberate external allowances are EXACTLY Google Fonts (style + font files) and the storage origin (images)', () => {
		expect(directives['style-src']).toEqual([
			'self',
			'unsafe-inline',
			'https://fonts.googleapis.com'
		]);
		expect(directives['font-src']).toEqual(['self', 'https://fonts.gstatic.com']);
		// No OTHER directive may name an external https origin (img-src carries only
		// the storage origin, asserted exactly above; connect-src is asserted below).
		for (const [name, values] of Object.entries(directives)) {
			if (['style-src', 'font-src', 'connect-src', 'img-src'].includes(name)) continue;
			for (const value of values) {
				expect(value.startsWith('http'), `${name} allows external origin ${value}`).toBe(false);
			}
		}
	});

	test('connect-src: no dev localhost WILDCARDS in a production policy, and self is present', () => {
		const connect = directives['connect-src'];
		expect(connect).toContain('self');
		for (const source of connect) {
			expect(
				source.endsWith(':*'),
				`wildcard source ${source} leaked into production connect-src`
			).toBe(false);
		}
	});

	test('required app behavior stays allowed: WS twin derivation, wasm data/blob fetches, blob workers', () => {
		expect(directives['worker-src']).toEqual(['self', 'blob:']);
		expect(directives['connect-src']).toContain('data:');
		expect(directives['connect-src']).toContain('blob:');
	});
});

describe('baseline response headers (hooks.server.ts)', () => {
	test('every response denies framing and content-type sniffing, and pins the referrer policy', () => {
		expect(securityHeaders()).toEqual({
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'strict-origin-when-cross-origin'
		});
	});
});
