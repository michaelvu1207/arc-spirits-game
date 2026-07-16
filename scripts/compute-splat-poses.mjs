/**
 * Bake camera poses for every shipped Gaussian-splat world into
 * src/lib/play/splatPoses.ts — so the runtime NEVER walks a shipped world's
 * splats synchronously on the main thread (the scan that starved Quick Play's
 * matchmaking timers on /play).
 *
 * How: boots a throwaway `vite dev` server (poses must come from the EXACT
 * runtime algorithm — the dev-only `window.__arcSplatPose` hook installed by
 * SplatBackground.svelte), opens /play in headless Chromium, and asks the hook
 * to compute the sharpness-weighted centroid of each world under /static/splats.
 * Prints the POSE_BY_URL entries; hand-tuned poses (cyber-city) are preserved.
 *
 * Run: node scripts/compute-splat-poses.mjs
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5330 + Math.floor(Math.random() * 200);

/** Hand-tuned poses (fly-mode authored) that baking must never clobber. */
const HAND_TUNED = new Set(['/splats/cyber-city.spz']);

async function main() {
	const worlds = readdirSync(join(REPO, 'static', 'splats'))
		.filter((f) => f.endsWith('.spz') || f.endsWith('.ply'))
		.map((f) => `/splats/${f}`);
	console.log(`worlds: ${worlds.join(', ')}`);

	const dev = spawnOwned(
		'node',
		[join(REPO, 'node_modules', '.bin', 'vite'), 'dev', '--port', String(PORT), '--strictPort'],
		{ cwd: REPO, env: { ...process.env }, label: 'pose-bake dev server' }
	);
	const browser = await chromium.launch();
	try {
		for (let i = 0; i < 240; i += 1) {
			try {
				const res = await fetch(`http://localhost:${PORT}/play`, {
					signal: AbortSignal.timeout(2000)
				});
				if (res.ok) break;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 500));
		}

		const page = await browser.newPage();
		await page.goto(`http://localhost:${PORT}/play`, { waitUntil: 'domcontentloaded' });
		// The hook is installed by SplatBackground's onMount (needs the splat mounted).
		await page.waitForFunction(() => typeof window.__arcSplatPose === 'function', null, {
			timeout: 120_000
		});

		const entries = [];
		for (const url of worlds) {
			if (HAND_TUNED.has(url)) {
				console.log(`  ${url}: hand-tuned — kept as-is`);
				continue;
			}
			const pose = await page.evaluate((u) => window.__arcSplatPose(u), url);
			if (!pose) {
				console.error(`  ${url}: FAILED to compute a pose`);
				process.exitCode = 1;
				continue;
			}
			console.log(`  ${url}: look=[${pose.look.join(', ')}]`);
			entries.push({ url, pose });
		}

		console.log('\n── paste into src/lib/play/splatPoses.ts ──');
		for (const { url, pose } of entries) {
			console.log(
				`\t'${url}': {\n\t\tbase: [${pose.base.join(', ')}],\n\t\tlook: [${pose.look.join(', ')}]\n\t},`
			);
		}
	} finally {
		await browser.close().catch(() => {});
		await stopOwned(dev, { termTimeoutMs: 5000 }).catch(() => {});
	}
}

main().catch((err) => {
	console.error('POSE BAKE ERROR:', err);
	process.exitCode = 1;
});
