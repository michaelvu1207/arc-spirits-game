/**
 * Browser-level CSP proof (run by scripts/csp-gate.mjs; see that header).
 *
 * Serves the ALREADY-BUILT static/Capacitor output (build/) from a throwaway
 * local server and loads it in a real Chromium, so the policy being enforced is
 * the `<meta http-equiv>` CSP baked into the shipped artifact — then proves:
 *
 *   1. Configured Supabase Storage ARTWORK actually loads: an `<img>` pointing
 *      at the exact URL shape assetStore builds fires `load` (the request
 *      reaches the network layer, where the test fulfills it) with zero CSP
 *      violations. Before the img-src fix, this exact load fired
 *      `securitypolicyviolation` and the board shipped imageless.
 *   2. A FOREIGN-origin image is genuinely blocked: `error` fires, a violation
 *      for img-src is recorded, and the request NEVER reaches the network layer
 *      (CSP rejects before interception).
 *
 * The gate passes ARC_CSP_GATE_STORAGE_ORIGIN / ARC_CSP_GATE_ARTWORK_URL; the
 * spec fails loudly (never skips) when they or the build output are missing.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import type { AddressInfo } from 'node:net';

const BUILD_DIR = fileURLToPath(new URL('../build', import.meta.url));
const STORAGE_ORIGIN = process.env.ARC_CSP_GATE_STORAGE_ORIGIN ?? '';
const ARTWORK_URL = process.env.ARC_CSP_GATE_ARTWORK_URL ?? '';
const FOREIGN_URL = 'https://blocked-origin.gate.example/steal.png';

// 1×1 transparent PNG — what the "storage" answers with when the CSP lets the
// request through to the interception layer.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2'
};

let server: Server;
let baseUrl = '';

test.beforeAll(async () => {
	if (!STORAGE_ORIGIN || !ARTWORK_URL) {
		throw new Error('csp-artifact proof must be run through scripts/csp-gate.mjs (env missing).');
	}
	if (!existsSync(join(BUILD_DIR, 'index.html'))) {
		throw new Error(`no static build at ${BUILD_DIR} — the gate builds it first; a missing artifact is a FAIL, not a skip.`);
	}
	server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		const file = join(BUILD_DIR, path === '/' ? 'index.html' : path.slice(1));
		try {
			const body = readFileSync(file);
			res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
			res.end(body);
		} catch {
			// SPA fallback — the page whose <meta> CSP we are proving.
			res.writeHead(200, { 'Content-Type': MIME['.html'] });
			res.end(readFileSync(join(BUILD_DIR, 'index.html')));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** Load an image inside the page under its live CSP; resolve with the outcome. */
function probeImage(url: string) {
	return `new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve('loaded');
		img.onerror = () => resolve('errored');
		img.src = ${JSON.stringify(url)};
		setTimeout(() => resolve('timeout'), 10_000);
	})`;
}

test('configured storage artwork LOADS and a foreign origin is BLOCKED under the emitted CSP', async ({ page }) => {
	let storageHit = false;
	let foreignHit = false;
	await page.route(`${STORAGE_ORIGIN}/**`, (route) => {
		storageHit = true;
		void route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
	});
	await page.route(`${new URL(FOREIGN_URL).origin}/**`, (route) => {
		foreignHit = true;
		void route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
	});
	await page.addInitScript(() => {
		(window as unknown as { __cspViolations: unknown[] }).__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (event) => {
			(window as unknown as { __cspViolations: unknown[] }).__cspViolations.push({
				blockedURI: event.blockedURI,
				directive: event.effectiveDirective
			});
		});
	});

	await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

	// The artifact really carries the policy being proven (belt and braces).
	const meta = await page
		.locator('meta[http-equiv="content-security-policy" i]')
		.getAttribute('content');
	expect(meta ?? '').toContain(`img-src 'self' data: blob: ${STORAGE_ORIGIN}`);

	// 1. The exact assetStore-shaped artwork URL loads: request REACHES the
	//    network (fulfilled by interception), no img-src violation fires.
	const artworkOutcome = await page.evaluate(probeImage(ARTWORK_URL));
	expect(artworkOutcome).toBe('loaded');
	expect(storageHit).toBe(true);

	// 2. The foreign origin is blocked BEFORE the network: error surfaces, an
	//    img-src violation is recorded, interception never sees the request.
	const foreignOutcome = await page.evaluate(probeImage(FOREIGN_URL));
	expect(foreignOutcome).toBe('errored');
	expect(foreignHit).toBe(false);

	const violations = (await page.evaluate('window.__cspViolations')) as {
		blockedURI: string;
		directive: string;
	}[];
	expect(violations.some((v) => v.blockedURI.startsWith(new URL(FOREIGN_URL).origin))).toBe(true);
	expect(violations.some((v) => v.blockedURI.startsWith(STORAGE_ORIGIN))).toBe(false);
});
