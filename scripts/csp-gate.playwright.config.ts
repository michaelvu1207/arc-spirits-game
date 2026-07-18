/**
 * Dedicated Playwright config for the CSP artifact gate's browser-level proof
 * (scripts/csp-artifact.spec.ts). Deliberately separate from the root
 * playwright.config.ts: no dev webServer — the spec serves the ALREADY-BUILT
 * static/Capacitor output itself, so what runs in the browser is the shipped
 * artifact under its own emitted <meta> CSP, nothing else.
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	testDir: fileURLToPath(new URL('.', import.meta.url)),
	testMatch: /csp-artifact\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [['list']],
	use: { headless: true }
});
