import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the 2D play mode. Drives the real SvelteKit app (which talks to
 * the live Supabase project) on a dedicated port so it never clashes with a
 * manual `npm run dev`. Single worker — the multiplayer specs open two browser
 * contexts inside one test and must not race other specs against shared rooms.
 */
export default defineConfig({
	testDir: 'e2e',
	// Generous: each fresh game client caches ~240 board-art images behind a loading
	// screen on first paint (the real player pays this too) before the board renders.
	timeout: 240_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// Multiplayer specs model separate foreground devices. Chromium otherwise
				// treats all but one page as a background tab and stretches the app's 3 s
				// safety poll to 20–60 s, producing delivery failures no real two-device
				// session has. Keep renderer/timers live for every player context.
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
		command: 'npm run dev -- --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: true,
		timeout: 120_000
	}
});
