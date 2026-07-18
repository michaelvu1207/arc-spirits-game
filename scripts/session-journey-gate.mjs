/**
 * SESSION-JOURNEY RELEASE GATE — one durable, REQUIRED-STORE command that owns
 * every local process itself and runs the full browser session journey TWICE
 * against the SAME store. It can never quietly skip:
 *
 *   - It boots its own stack: the PostgREST/auth emulator (server/pgrestEmu.ts
 *     --rpc, i.e. the 20260710 migrations applied) and a BUILT PRODUCTION
 *     PREVIEW (`vite build` + `vite preview`) on the Playwright-managed port,
 *     pointed at that emulator. The DETERMINISTIC lane runs pre-bundled
 *     modules on purpose: a dev server cold-transforming the large room route
 *     graph mid-journey once added ~17s+ of nondeterministic latency that got
 *     mislabeled as a matchmaking failure. The bundle is a CLEAN
 *     NODE_ENV=production build carrying the REAL release CSP (no loopback in
 *     connect-src): the store is baked as the app's own origin and `vite
 *     preview` proxies /rest,/auth,/storage to the emulator
 *     (ARC_E2E_STORE_PROXY — vite.config.ts), so the browser reaches the
 *     store SAME-ORIGIN under the production policy. Only the PREVIEW
 *     PROCESS runs NODE_ENV=development, because the journey drives the
 *     dev-posture integrity commands (commandPolicy reads the runtime env).
 *     Real-performance evidence with the full splat lives in the separate
 *     perf lane: scripts/perf-journey.mjs. No pre-existing server is trusted:
 *     if :4173 is already occupied, the gate FAILS rather than blessing
 *     whatever is running there.
 *   - Each journey run executes `playwright test e2e/session-journey.spec.ts`
 *     with ARC_REQUIRE_JOURNEY_STORE=1 — inside the spec a missing store is a
 *     hard error, and here the gate ADDITIONALLY fails if the runner reports
 *     any skipped test or fewer than the expected passes.
 *   - TWO runs against one store prove repeatability: leftovers from run 1
 *     (finished rooms, reserved bots, memberships) must not starve or pollute
 *     run 2 — the exact-membership assertions are scoped per run.
 *   - Teardown is verified, not assumed: EVERY child — the emulator, the dev
 *     server AND the Playwright runner itself — is spawned in its own process
 *     group and tracked (scripts/procOwn.mjs, with a forced-stubborn-child
 *     regression in scripts/procOwn.test.ts), gets a graceful SIGTERM, is
 *     SIGKILLed only if it refuses to exit, and the gate AWAITS each ACTUAL
 *     exit (never `ChildProcess.killed`, which only means "signal sent"). It
 *     then PROVES no orphan listeners remain (both owned ports must refuse
 *     connections) and no room server processes outlive the run (pgrep diff vs
 *     the pre-gate baseline — the spec spawns per-run room servers as
 *     grandchildren). Any orphan it DOES detect is cleaned (TERM → KILL,
 *     verified dead) BEFORE the gate reports the failure.
 *
 * Artifacts: Playwright screenshots/traces land in test-results/ (gitignored) —
 * nothing disposable is committed.
 *
 * Run: npm run gate:journey   (node scripts/session-journey-gate.mjs)
 */

import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidsWithCwdUnder, reapPids, spawnOwned, stopOwned } from './procOwn.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = 4173; // pinned by playwright.config.ts baseURL
const EMU_PORT = 8930 + Math.floor(Math.random() * 60);
/** Tests expected GREEN per journey run (session-journey.spec.ts). */
const EXPECTED_PASSES = 7;

const results = [];
function check(name, cond, detail = '') {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!cond) process.exitCode = 1;
}

/** All children this gate owns (shared procOwn helpers: detached process group,
 *  TERM → bounded wait → KILL, ACTUAL exit awaited — see scripts/procOwn.mjs and
 *  its forced-stubborn-child regression in scripts/procOwn.test.ts). Killed and
 *  awaited no matter how we exit. */
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
		if (child && child.exitCode != null) break; // died — fail fast with its log
		try {
			if (await probe()) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`${label} never became ready\n${(child?.ownedLog ?? '').slice(-3000)}`);
}

/** Room-server processes (spawned as the spec's grandchildren) visible right now —
 *  SCOPED TO THIS REPOSITORY. The broad `pgrep -f server/index.ts` matches any
 *  workspace's concurrently-launched server on the machine; counting (or worse,
 *  REAPING) one that belongs to a different checkout is exactly what this gate
 *  must never do. The spec spawns its room servers with cwd = this repo, so the
 *  cwd filter (procOwn.pidsWithCwdUnder — unreadable cwd ⇒ "not ours") is the
 *  ownership proof. */
function roomServerPids() {
	const res = spawnSync('pgrep', ['-f', 'server/index\\.ts'], { encoding: 'utf8' });
	const candidates = (res.stdout ?? '').split('\n').filter(Boolean);
	return new Set(pidsWithCwdUnder(candidates, REPO));
}

async function runJourney(runLabel, env) {
	// The Playwright runner is an OWNED, tracked child in its own process group —
	// previously it was a bare spawn the gate never tracked, so a gate crash (or a
	// wedged runner) reparented the spec's room-server grandchildren to launchd.
	const child = ownChild(`playwright ${runLabel}`, 'node', [
		join(REPO, 'node_modules', '.bin', 'playwright'),
		'test',
		'e2e/session-journey.spec.ts'
	], env);
	child.stdout.on('data', (d) => process.stdout.write(d));
	const [code] = await once(child, 'exit');
	const log = child.ownedLog;
	const passed = Number(log.match(/(\d+) passed/)?.[1] ?? 0);
	const skipped = Number(log.match(/(\d+) skipped/)?.[1] ?? 0);
	check(`[${runLabel}] playwright exited 0`, code === 0, `code=${code}`);
	check(
		`[${runLabel}] all ${EXPECTED_PASSES} journey tests PASSED (no skips — a skipped journey is not a passed journey)`,
		passed >= EXPECTED_PASSES && skipped === 0,
		`passed=${passed} skipped=${skipped}`
	);
}

async function main() {
	console.log(`══ session-journey release gate (emulator :${EMU_PORT}, dev :${DEV_PORT}) ══`);
	const baselineRoomServers = roomServerPids();

	// The gate must OWN the dev server — a pre-existing :4173 would mean the
	// journey ran against an unknown stack with an unknown store.
	if (await portOpen(DEV_PORT)) {
		throw new Error(`port ${DEV_PORT} is already in use — the gate must own the dev server it tests.`);
	}

	// THREE process postures, one stack:
	//  - BUILD: clean NODE_ENV=production — a REAL release bundle with the REAL
	//    release CSP (no loopback in connect-src). The store is baked as the
	//    app's OWN origin; `vite preview` proxies /rest,/auth,/storage to the
	//    gate-owned emulator (ARC_E2E_STORE_PROXY, see vite.config.ts), so the
	//    browser reaches the store same-origin under the production policy.
	//  - PREVIEW: the built server runs with NODE_ENV=development so the journey
	//    may drive the dev-posture integrity commands (commandPolicy reads the
	//    RUNTIME env; production deploys refuse them unconditionally).
	//  - EMULATOR: plain runtime env.
	const selfOrigin = `http://localhost:${DEV_PORT}`;
	const buildEnv = {
		...process.env,
		NODE_ENV: 'production',
		PUBLIC_SUPABASE_URL: selfOrigin,
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu'
	};
	const stackEnv = {
		...process.env,
		NODE_ENV: 'development', // runtime posture: integrity commands allowed
		PUBLIC_SUPABASE_URL: selfOrigin,
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		SUPABASE_SERVICE_ROLE_KEY: 'local-emu',
		ARC_E2E_STORE_PROXY: `http://127.0.0.1:${EMU_PORT}`,
		ARC_PLAY_CATALOG_FILE: join(REPO, 'ml', 'catalog.json'),
		ARC_WS_CATALOG_FILE: join(REPO, 'ml', 'catalog.json')
	};

	const emu = ownChild(
		'pgrestEmu',
		'node',
		[join(REPO, 'node_modules', '.bin', 'tsx'), 'server/pgrestEmu.ts', '--listen', String(EMU_PORT), '--rpc'],
		stackEnv
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

	// BUILD the production preview bundle with the gate's store BAKED IN
	// (PUBLIC_* env is $env/static — compile-time). Synchronous + fail-fast: a
	// broken build is a gate error before any journey is attempted. The
	// deterministic lane exists precisely so no Vite dev transform can add
	// nondeterministic multi-second latency mid-journey.
	console.log('→ building the production preview bundle (vite build, NODE_ENV=production)…');
	const build = spawnSync(
		'node',
		[join(REPO, 'node_modules', '.bin', 'vite'), 'build'],
		{ cwd: REPO, env: buildEnv, encoding: 'utf8' }
	);
	if (build.status !== 0) {
		throw new Error(
			`vite build failed (exit ${build.status})\n${(build.stdout ?? '').slice(-2000)}\n${(build.stderr ?? '').slice(-3000)}`
		);
	}

	const dev = ownChild(
		'vite preview',
		'node',
		[
			join(REPO, 'node_modules', '.bin', 'vite'),
			'preview',
			'--port',
			String(DEV_PORT),
			'--strictPort'
		],
		stackEnv
	);
	await waitFor(
		'preview server',
		async () => {
			const res = await fetch(`http://localhost:${DEV_PORT}/api/play/config`, {
				signal: AbortSignal.timeout(5000)
			});
			if (!res.ok) return false;
			const cfg = await res.json();
			// The preview must advertise ITSELF as the store origin (the same-origin
			// posture) AND actually answer store traffic through the proxy — i.e.
			// the gate-owned emulator, never a leftover .env stack.
			if (String(cfg.supabaseUrl ?? '') !== selfOrigin) return false;
			const store = await fetch(`${selfOrigin}/rest/v1/play_game_sessions?limit=1`, {
				headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: 'local-emu' },
				signal: AbortSignal.timeout(5000)
			});
			return store.status < 500;
		},
		240,
		dev
	);
	check(
		'[stack] BUILT production preview is up, advertises itself as the store origin, and proxies store traffic to the gate-owned emulator',
		true,
		`:${DEV_PORT} → :${EMU_PORT}`
	);

	const journeyEnv = { ...stackEnv, ARC_REQUIRE_JOURNEY_STORE: '1' };
	console.log('\n→ journey run 1/2 (fresh store)…');
	await runJourney('run 1', journeyEnv);
	console.log('\n→ journey run 2/2 (SAME store — repeatability against run 1 leftovers)…');
	await runJourney('run 2', journeyEnv);

	// ── verified teardown ──────────────────────────────────────────────────────
	let anyForced = false;
	for (const child of [...children].reverse()) {
		const { forced } = await stopOwned(child, { termTimeoutMs: 5000 });
		anyForced = anyForced || forced;
	}
	check(
		'[teardown] all owned process groups exited (ACTUAL exit awaited, TERM before KILL)',
		true,
		anyForced ? 'at least one child ignored TERM and was KILLed' : ''
	);
	check(`[teardown] dev port ${DEV_PORT} refuses connections`, !(await portOpen(DEV_PORT)));
	check(`[teardown] emulator port ${EMU_PORT} refuses connections`, !(await portOpen(EMU_PORT)));
	// Give any straggling room server a beat to die with its parent, then prove it.
	await new Promise((r) => setTimeout(r, 1000));
	const leftover = [...roomServerPids()].filter((pid) => !baselineRoomServers.has(pid));
	if (leftover.length > 0) {
		// CLEAN before failing: an orphan found is a FAIL, but the gate never
		// leaves it running on the machine (TERM → bounded wait → KILL, verified).
		console.error(`[teardown] cleaning detected orphan room servers: ${leftover.join(', ')}`);
		await reapPids(leftover);
	}
	const stillAlive = [...roomServerPids()].filter((pid) => !baselineRoomServers.has(pid));
	check(
		'[teardown] no orphan room-server processes remain',
		leftover.length === 0,
		leftover.length ? `found+cleaned ${leftover.join(',')}${stillAlive.length ? `; STILL ALIVE ${stillAlive.join(',')}` : ''}` : ''
	);

	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${passed}/${results.length} journey gate checks passed`);
	if (passed !== results.length) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error('JOURNEY GATE ERROR:', err);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const child of [...children].reverse()) await stopOwned(child).catch(() => {});
	});
