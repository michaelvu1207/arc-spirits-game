import { defineConfig, devices } from '@playwright/test';

// An isolated local auth/store emulator is mandatory: no production writes.
export default defineConfig({
	testDir: 'e2e',
	testMatch: 'navigation-powers.spec.ts',
	timeout: 600_000,
	expect: { timeout: 15_000 },
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4181',
		actionTimeout: 15_000,
		reducedMotion: 'reduce',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: {
					args: [
						'--disable-gpu',
						'--disable-webgl',
						'--disable-webgl2',
						'--disable-accelerated-2d-canvas',
						'--disable-background-timer-throttling',
						'--disable-backgrounding-occluded-windows',
						'--disable-renderer-backgrounding'
					]
				}
			}
		}
	],
	webServer: {
		command:
			'ARC_PLATFORM_STORE_PORT=8941 ARC_PLATFORM_APP_PORT=4181 node scripts/platform-stack.mjs',
		url: 'http://localhost:4181',
		reuseExistingServer: false,
		timeout: 120_000
	}
});
