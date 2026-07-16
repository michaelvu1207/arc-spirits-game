import { defineConfig, devices } from '@playwright/test';

/**
 * Cross-browser release surface. Unlike the multiplayer stress config, this
 * keeps GPU/WebGL enabled and runs the portable journey/accessibility checks in
 * Chromium, Firefox and WebKit. Backend-owning multiplayer gates remain single-
 * worker orchestrators so they cannot race shared rooms.
 */
export default defineConfig({
	testDir: 'e2e',
	testMatch: ['accessibility-platform.spec.ts', 'mobile-perf-smoke.spec.ts', 'low-poly-platform.spec.ts'],
	timeout: 120_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4174',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{ name: 'chromium-platform', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox-platform', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit-platform', use: { ...devices['Desktop Safari'] } }
	],
	webServer: {
		command: 'node scripts/platform-stack.mjs',
		url: 'http://localhost:4174',
		reuseExistingServer: false,
		timeout: 120_000
	}
});
