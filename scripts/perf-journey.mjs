/**
 * QUICK PLAY PERFORMANCE LANE — the REAL-COST twin of the deterministic journey
 * gate. Where gate:journey isolates heavy media to prove the session CONTRACT,
 * this lane runs a COLD production build with the full Gaussian splat enabled
 * and MEASURES what the deterministic lane deliberately excludes:
 *
 *   - queue-poll cadence under real 3D initialization (nominal 2.5s timer —
 *     multi-second gaps mean the main thread starved the matchmaking timers,
 *     the exact regression the synchronous splat scan caused before poses were
 *     baked in src/lib/play/splatPoses.ts);
 *   - browser event-loop delay while the splat loads/renders;
 *   - matched-response → room-URL-commit navigation latency;
 *   - that the splat truthfully streams in the enabled modes and never in Off.
 *
 * Graphics modes swept: Off / 30 FPS (battery-saver tier) / 60 FPS (high) —
 * the app's three player-facing splat-quality settings. Each mode gets a COLD
 * browser (fresh profile, no cache) against the same stack.
 *
 * Stack (all gate-owned, verified teardown): pgrestEmu (--rpc) + a CLEAN
 * NODE_ENV=production `vite build` served by `vite preview`, store baked
 * same-origin and proxied (ARC_E2E_STORE_PROXY) — the REAL release CSP. The
 * preview process runs NODE_ENV=development only for runtime posture parity
 * with the journey gate; nothing here drives integrity commands.
 *
 * Bounds (env-overridable, generous by design — this is a starvation detector,
 * not a micro-benchmark):
 *   ARC_PERF_MAX_POLL_GAP_MS        (default 6000; nominal cadence is 2500)
 *   ARC_PERF_MAX_MATCHED_TO_NAV_MS  (default 15000)
 *   ARC_PERF_MAX_EVENT_LOOP_LAG_MS  (default 3000; a single ≥bound stall fails)
 *
 * Run: npm run perf:journey   (node scripts/perf-journey.mjs)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_PORT = 4317; // pinned: baked into the build as the store origin
const EMU_PORT = 9040 + Math.floor(Math.random() * 60);
const SELF_ORIGIN = `http://localhost:${PREVIEW_PORT}`;

const MAX_POLL_GAP_MS = Number(process.env.ARC_PERF_MAX_POLL_GAP_MS ?? 6000);
const MAX_MATCHED_TO_NAV_MS = Number(process.env.ARC_PERF_MAX_MATCHED_TO_NAV_MS ?? 15_000);
const MAX_EVENT_LOOP_LAG_MS = Number(process.env.ARC_PERF_MAX_EVENT_LOOP_LAG_MS ?? 3000);
const MAX_FRAME_AVERAGE_MS = Number(process.env.ARC_PERF_MAX_FRAME_AVERAGE_MS ?? 40);
const MAX_FRAME_P90_MS = Number(process.env.ARC_PERF_MAX_FRAME_P90_MS ?? 50);
const MAX_FRAME_P99_MS = Number(process.env.ARC_PERF_MAX_FRAME_P99_MS ?? 200);
const MAX_JS_HEAP_MIB = Number(process.env.ARC_PERF_MAX_JS_HEAP_MIB ?? 512);
const MAX_JOURNEY_NETWORK_MIB = Number(process.env.ARC_PERF_MAX_NETWORK_MIB ?? 50);

/** Player-facing splat-quality tiers (see graphicsSettings.svelte.ts). */
const MODES = [
	{ mode: 'off', label: 'Off (no splat)', expectSplat: false },
	{ mode: '30', label: '30 FPS (battery saver)', expectSplat: true },
	{ mode: '60', label: '60 FPS (high)', expectSplat: true }
];

const results = [];
const measurements = [];
function check(name, cond, detail = '') {
	results.push({ name, ok: !!cond, detail });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!cond) process.exitCode = 1;
}

const children = [];
function ownChild(label, cmd, args, env) {
	const child = spawnOwned(cmd, args, { cwd: REPO, env, label });
	children.push(child);
	return child;
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = connect({ port, host: '127.0.0.1' });
		const done = (open) => {
			socket.destroy();
			resolve(open);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		setTimeout(() => done(false), 1500);
	});
}

async function waitFor(label, probe, attempts = 120, child = null) {
	for (let i = 0; i < attempts; i += 1) {
		if (child && child.exitCode != null) break;
		try {
			if (await probe()) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`${label} never became ready\n${(child?.ownedLog ?? '').slice(-3000)}`);
}

async function seedBots(runTag) {
	for (const i of [1, 2, 3, 4]) {
		const res = await fetch(`http://127.0.0.1:${EMU_PORT}/rest/v1/player_ratings`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'Content-Profile': 'arc_spirits_2d',
				apikey: 'local-emu'
			},
			body: JSON.stringify({
				user_id: globalThis.crypto.randomUUID(),
				display_name: `Perf Bot ${runTag}-${i}`,
				mu: 25,
				sigma: 8.333,
				games_played: 3,
				bot_profile: 'balanced',
				rating_version: 1
			}),
			signal: AbortSignal.timeout(5000)
		});
		if (res.status >= 300) throw new Error(`bot seed failed: ${res.status}`);
	}
}

function quantile(sorted, q) {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[idx];
}

/** One COLD Quick Play journey in one graphics mode; returns the measurements. */
async function measureMode({ mode, label, expectSplat }) {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();
	try {
		await page.addInitScript(
			([m]) => {
				// persistedState format: `<json>::v<version>` (persistedState.svelte.ts).
				localStorage.setItem('asp:splat-quality', `${JSON.stringify(m)}::v1`);
				localStorage.setItem('arc-player-name', `Perf ${m}`);
				// Event-loop lag sampler: a 100ms heartbeat whose overshoot IS the
				// main-thread stall the matchmaking timers would have suffered.
				window.__elSamples = [];
				window.__elSampleTimes = [];
				window.__rafSamples = [];
				let previousFrame = 0;
				const sampleFrame = (now) => {
					if (previousFrame > 0) window.__rafSamples.push(now - previousFrame);
					previousFrame = now;
					requestAnimationFrame(sampleFrame);
				};
				requestAnimationFrame(sampleFrame);
				let last = performance.now();
				setInterval(() => {
					const now = performance.now();
					window.__elSamples.push(now - last - 100);
					window.__elSampleTimes.push(now);
					last = now;
				}, 100);
			},
			[mode]
		);

		let splatBytes = 0;
		const queueRequests = [];
		let matchedAt = null;
		page.on('response', (res) => {
			if (/\.(spz|ply)(\?|$)/.test(res.url())) {
				void res
					.body()
					.then((b) => {
						splatBytes += b.length;
					})
					.catch(() => {});
			}
		});
		page.on('request', (req) => {
			if (req.url().includes('/api/play/matchmaking/queue') && req.method() === 'POST') {
				queueRequests.push(Date.now());
			}
		});
		page.on('response', (res) => {
			if (!res.url().includes('/api/play/matchmaking/queue')) return;
			void res
				.json()
				.then((body) => {
					if (body?.status === 'matched' && matchedAt == null) matchedAt = Date.now();
				})
				.catch(() => {});
		});

		const t0 = Date.now();
		await page.goto(`${SELF_ORIGIN}/play`, { waitUntil: 'domcontentloaded' });
		await page
			.getByTestId('play-home')
			.and(page.locator('[data-hydrated="true"]'))
			.waitFor({ timeout: 45_000 });
		const hydratedMs = Date.now() - t0;
		await page.getByTestId('quick-play').click();

		// Wait for a MATCHED queue response, then the room URL commit.
		const matchDeadline = Date.now() + 90_000;
		while (matchedAt == null) {
			if (Date.now() > matchDeadline) throw new Error(`[${label}] queue never matched in 90s`);
			await page.waitForTimeout(150);
		}
		await page.waitForURL(/\/play\/[A-Z0-9]{6}/, { timeout: 60_000 });
		const navMs = Date.now() - matchedAt;

		// The ROOM page's own splat (destination worlds) begins init AFTER the
		// navigation commits (behind the room loading screen — deliberately off
		// the matchmaking window). Give it time to stream in enabled modes, and
		// keep sampling so the post-nav stall is REPORTED (it is scheduled, not
		// judged: the timers it must never block are already gone).
		if (expectSplat) {
			const splatDeadline = Date.now() + 25_000;
			while (splatBytes === 0 && Date.now() < splatDeadline) {
				await page.waitForTimeout(500);
			}
		} else {
			await page.waitForTimeout(3000);
		}
		await page.waitForTimeout(2000);

		// Split the event-loop samples at the MATCHED moment: the pre-match window
		// is what matchmaking timers lived through (JUDGED); post-match covers the
		// room's own heavy init (REPORTED).
		const timeOrigin = await page.evaluate(() => performance.timeOrigin);
		const samples = await page.evaluate(() =>
			(window.__elSamples ?? []).map((lag, i) => ({ i, lag }))
		);
		const sampleTimes = await page.evaluate(() => window.__elSampleTimes ?? []);
		const matchedPerf = matchedAt - timeOrigin;
		const pre = [];
		const post = [];
		for (const { i, lag } of samples) {
			const at = sampleTimes[i] ?? 0;
			(at <= matchedPerf ? pre : post).push(Math.max(0, lag));
		}
		pre.sort((a, b) => a - b);
		post.sort((a, b) => a - b);
		const frameSamples = (await page.evaluate(() => window.__rafSamples ?? []))
			.filter((value) => Number.isFinite(value) && value > 0 && value < 5000)
			.sort((a, b) => a - b);
		const frameAverageMs = frameSamples.length
			? frameSamples.reduce((sum, value) => sum + value, 0) / frameSamples.length
			: 0;
		const runtime = await page.evaluate(() => {
			const entries = performance.getEntriesByType('resource');
			const networkBytes = entries.reduce(
				(sum, entry) => sum + (entry.encodedBodySize || entry.transferSize || 0),
				0
			);
			const memory = performance.memory;
			return { networkBytes, jsHeapBytes: Number(memory?.usedJSHeapSize ?? 0) };
		});
		const gaps = [];
		for (let i = 1; i < queueRequests.length; i += 1) {
			gaps.push(queueRequests[i] - queueRequests[i - 1]);
		}
		return {
			label,
			hydratedMs,
			polls: queueRequests.length,
			maxPollGapMs: gaps.length ? Math.max(...gaps) : 0,
			matchedToNavMs: navMs,
			preMatchLagMaxMs: pre.length ? pre[pre.length - 1] : 0,
			preMatchLagP95Ms: quantile(pre, 0.95),
			postNavLagMaxMs: post.length ? post[post.length - 1] : 0,
			splatBytes,
			frameSamples: frameSamples.length,
			frameAverageMs,
			frameP90Ms: quantile(frameSamples, 0.9),
			frameP99Ms: quantile(frameSamples, 0.99),
			networkBytes: runtime.networkBytes,
			jsHeapBytes: runtime.jsHeapBytes
		};
	} finally {
		await browser.close().catch(() => {});
	}
}

/** Menu-idle scenario: the REAL menu splat init cost, measured where it is now
 *  SCHEDULED to happen — at idle, before any search exists. Reported, and
 *  verified to actually stream (the enabled path is not silently dead). */
async function measureMenuIdle() {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.addInitScript(() => {
			localStorage.setItem('asp:splat-quality', '"60"::v1');
			localStorage.setItem('arc-player-name', 'Perf Idle');
			window.__elSamples = [];
			window.__elSampleTimes = [];
			let last = performance.now();
			setInterval(() => {
				const now = performance.now();
				window.__elSamples.push(now - last - 100);
				window.__elSampleTimes.push(now);
				last = now;
			}, 100);
		});
		let splatBytes = 0;
		page.on('response', (res) => {
			if (/\.(spz|ply)(\?|$)/.test(res.url())) {
				void res
					.body()
					.then((b) => {
						splatBytes += b.length;
					})
					.catch(() => {});
			}
		});
		await page.goto(`${SELF_ORIGIN}/play`, { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(12_000); // idle: the deferred mount + init happen here
		const lags = (await page.evaluate(() => window.__elSamples ?? []))
			.map((v) => Math.max(0, v))
			.sort((a, b) => a - b);
		return { splatBytes, lagMaxMs: lags.length ? lags[lags.length - 1] : 0 };
	} finally {
		await browser.close().catch(() => {});
	}
}

async function main() {
	console.log(`══ Quick Play performance lane (emulator :${EMU_PORT}, preview :${PREVIEW_PORT}) ══`);
	if (await portOpen(PREVIEW_PORT)) {
		throw new Error(`port ${PREVIEW_PORT} is already in use — the lane must own its stack.`);
	}

	const emu = ownChild(
		'pgrestEmu',
		'node',
		[join(REPO, 'node_modules', '.bin', 'tsx'), 'server/pgrestEmu.ts', '--listen', String(EMU_PORT), '--rpc'],
		{ ...process.env }
	);
	await waitFor(
		'pgrest emulator',
		async () => {
			const res = await fetch(`http://127.0.0.1:${EMU_PORT}/rest/v1/play_game_sessions?limit=1`, {
				headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: 'local-emu' },
				signal: AbortSignal.timeout(2000)
			});
			return res.status < 500;
		},
		60,
		emu
	);
	check('[stack] pgrest emulator (rpc store) is up', true, `:${EMU_PORT}`);

	console.log('→ building the production bundle (vite build, NODE_ENV=production)…');
	const build = spawnSync('node', [join(REPO, 'node_modules', '.bin', 'vite'), 'build'], {
		cwd: REPO,
		env: {
			...process.env,
			NODE_ENV: 'production',
			PUBLIC_SUPABASE_URL: SELF_ORIGIN,
			PUBLIC_SUPABASE_ANON_KEY: 'local-emu'
		},
		encoding: 'utf8'
	});
	if (build.status !== 0) {
		throw new Error(
			`vite build failed (exit ${build.status})\n${(build.stdout ?? '').slice(-2000)}\n${(build.stderr ?? '').slice(-3000)}`
		);
	}
	check('[stack] production bundle built (real release CSP, store same-origin)', true);

	const preview = ownChild(
		'vite preview',
		'node',
		[
			join(REPO, 'node_modules', '.bin', 'vite'),
			'preview',
			'--port',
			String(PREVIEW_PORT),
			'--strictPort'
		],
		{
			...process.env,
			NODE_ENV: 'development', // runtime posture parity with gate:journey
			PUBLIC_SUPABASE_URL: SELF_ORIGIN,
			PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
			SUPABASE_SERVICE_ROLE_KEY: 'local-emu',
			ARC_E2E_STORE_PROXY: `http://127.0.0.1:${EMU_PORT}`,
			ARC_PLAY_CATALOG_FILE: join(REPO, 'ml', 'catalog.json')
		}
	);
	await waitFor(
		'preview server',
		async () => {
			const res = await fetch(`${SELF_ORIGIN}/api/play/config`, {
				signal: AbortSignal.timeout(5000)
			});
			if (!res.ok) return false;
			const cfg = await res.json();
			return String(cfg.supabaseUrl ?? '') === SELF_ORIGIN;
		},
		240,
		preview
	);
	check('[stack] production preview is up (store proxied same-origin)', true, `:${PREVIEW_PORT}`);

	for (const spec of MODES) {
		await seedBots(`${spec.mode}-${Math.random().toString(36).slice(2, 6)}`);
		const m = await measureMode(spec);
		measurements.push({ mode: spec.mode, ...m });
		console.log(
			`\n[${m.label}] hydrated ${m.hydratedMs}ms · ${m.polls} queue polls, max gap ${m.maxPollGapMs}ms · ` +
				`matched→nav ${m.matchedToNavMs}ms · pre-match lag max ${Math.round(m.preMatchLagMaxMs)}ms ` +
				`p95 ${Math.round(m.preMatchLagP95Ms)}ms · post-nav lag max ${Math.round(m.postNavLagMaxMs)}ms ` +
				`(room 3D init, behind the loading screen) · splat bytes ${m.splatBytes}`
		);
		check(
			`[${m.label}] splat truthfully ${spec.expectSplat ? 'streamed' : 'ABSENT'}`,
			spec.expectSplat ? m.splatBytes > 1_000_000 : m.splatBytes === 0,
			`${m.splatBytes} bytes`
		);
		check(
			`[${m.label}] queue-poll cadence never starved (max gap ≤ ${MAX_POLL_GAP_MS}ms)`,
			m.polls >= 2 && m.maxPollGapMs <= MAX_POLL_GAP_MS,
			`max gap ${m.maxPollGapMs}ms over ${m.polls} polls`
		);
		check(
			`[${m.label}] matched→room navigation ≤ ${MAX_MATCHED_TO_NAV_MS}ms`,
			m.matchedToNavMs <= MAX_MATCHED_TO_NAV_MS,
			`${m.matchedToNavMs}ms`
		);
		check(
			`[${m.label}] no event-loop stall ≥ ${MAX_EVENT_LOOP_LAG_MS}ms while matchmaking timers were live`,
			m.preMatchLagMaxMs < MAX_EVENT_LOOP_LAG_MS,
			`pre-match max ${Math.round(m.preMatchLagMaxMs)}ms, p95 ${Math.round(m.preMatchLagP95Ms)}ms`
		);
		check(
			`[${m.label}] gameplay frame distribution stays within avg/P90/P99 budgets`,
			m.frameSamples >= 30 && m.frameAverageMs <= MAX_FRAME_AVERAGE_MS &&
				m.frameP90Ms <= MAX_FRAME_P90_MS && m.frameP99Ms <= MAX_FRAME_P99_MS,
			`n=${m.frameSamples}, avg=${m.frameAverageMs.toFixed(1)}ms, ` +
				`p90=${m.frameP90Ms.toFixed(1)}ms, p99=${m.frameP99Ms.toFixed(1)}ms`
		);
		check(
			`[${m.label}] gameplay JS heap stays ≤ ${MAX_JS_HEAP_MIB}MiB`,
			m.jsHeapBytes > 0 && m.jsHeapBytes <= MAX_JS_HEAP_MIB * 1024 * 1024,
			`${(m.jsHeapBytes / 1024 / 1024).toFixed(1)}MiB`
		);
		check(
			`[${m.label}] post-navigation resource transfer stays ≤ ${MAX_JOURNEY_NETWORK_MIB}MiB`,
			m.networkBytes <= MAX_JOURNEY_NETWORK_MIB * 1024 * 1024,
			`${(m.networkBytes / 1024 / 1024).toFixed(1)}MiB`
		);
	}

	// Menu-idle: where the heavy init is now SCHEDULED (deferred to idle, held
	// during searches). Its stall is reported as the real cost of the enabled
	// splat; it must stream here, or the deferral silently killed the feature.
	const idle = await measureMenuIdle();
	console.log(
		`\n[menu idle · 60 FPS] splat bytes ${idle.splatBytes} · init-window event-loop lag max ${Math.round(idle.lagMaxMs)}ms`
	);
	check(
		'[menu idle · 60 FPS] the deferred menu splat still streams (deferral did not kill the feature)',
		idle.splatBytes > 1_000_000,
		`${idle.splatBytes} bytes, init stall max ${Math.round(idle.lagMaxMs)}ms (idle-scheduled)`
	);

	// ── verified teardown ──────────────────────────────────────────────────────
	for (const child of [...children].reverse()) {
		await stopOwned(child, { termTimeoutMs: 5000 });
	}
	check(`[teardown] preview port ${PREVIEW_PORT} refuses connections`, !(await portOpen(PREVIEW_PORT)));
	check(`[teardown] emulator port ${EMU_PORT} refuses connections`, !(await portOpen(EMU_PORT)));

	const runId = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
	const resultDir = join(REPO, 'bench', 'results');
	mkdirSync(resultDir, { recursive: true });
	const resultPath = join(resultDir, `${runId}-web-performance.json`);
	writeFileSync(resultPath, `${JSON.stringify({
		generatedAt: new Date().toISOString(),
		budgets: {
			frameAverageMs: MAX_FRAME_AVERAGE_MS,
			frameP90Ms: MAX_FRAME_P90_MS,
			frameP99Ms: MAX_FRAME_P99_MS,
			jsHeapMiB: MAX_JS_HEAP_MIB,
			networkMiB: MAX_JOURNEY_NETWORK_MIB,
			pollGapMs: MAX_POLL_GAP_MS,
			matchedToNavMs: MAX_MATCHED_TO_NAV_MS,
			eventLoopLagMs: MAX_EVENT_LOOP_LAG_MS
		},
		measurements,
		checks: results,
		passed: results.filter((result) => result.ok).length,
		failed: results.filter((result) => !result.ok).length
	}, null, 2)}\n`);
	console.log(`Performance evidence: ${resultPath}`);

	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${passed}/${results.length} perf lane checks passed`);
	if (passed !== results.length) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error('PERF LANE ERROR:', err);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const child of [...children].reverse()) await stopOwned(child).catch(() => {});
	});
