#!/usr/bin/env node
/**
 * Self-contained release gate for the human-operated representative game loop.
 * Owns a local auth/store emulator, a production Vite preview, and the room
 * server; runs e2e/play-full.spec.ts; then proves every owned process exited.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT = 4173; // playwright.config.ts
const EMU_PORT = 9000 + Math.floor(Math.random() * 80);
const ROOM_PORT = 9100 + Math.floor(Math.random() * 80);
const children = [];
const checks = [];

function check(name, value, detail = '') {
	const ok = Boolean(value);
	checks.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) process.exitCode = 1;
}

function safeTail(raw, max = 5000) {
	return String(raw ?? '')
		.replace(/(access_token|refresh_token|authorization|cookie)(["'=:\s]+)[^\s,"'}]+/gi, '$1$2[redacted]')
		.slice(-max);
}

function own(label, command, args, env) {
	const child = spawnOwned(command, args, { cwd: REPO, env, label });
	children.push(child);
	return child;
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port });
		const done = (open) => {
			socket.destroy();
			resolve(open);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		setTimeout(() => done(false), 1000);
	});
}

async function waitFor(label, probe, child, attempts = 120) {
	for (let i = 0; i < attempts; i += 1) {
		if (child?.exitCode != null) break;
		try {
			if (await probe()) return;
		} catch {
			// not ready
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${label} did not become ready\n${(child?.ownedLog ?? '').slice(-3000)}`);
}

async function cleanup() {
	for (const child of [...children].reverse()) await stopOwned(child, { termTimeoutMs: 5000 });
	check(`web port ${WEB_PORT} closed`, !(await portOpen(WEB_PORT)));
	check(`store port ${EMU_PORT} closed`, !(await portOpen(EMU_PORT)));
	check(`room port ${ROOM_PORT} closed`, !(await portOpen(ROOM_PORT)));
}

async function main() {
	for (const port of [WEB_PORT, EMU_PORT, ROOM_PORT]) {
		if (await portOpen(port)) throw new Error(`port ${port} is already in use; gate must own its stack`);
	}
	const selfOrigin = `http://localhost:${WEB_PORT}`;
	const roomOrigin = `ws://127.0.0.1:${ROOM_PORT}`;
	const emulatorOrigin = `http://127.0.0.1:${EMU_PORT}`;
	const buildEnv = {
		...process.env,
		NODE_ENV: 'production',
		PUBLIC_SUPABASE_URL: selfOrigin,
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		PUBLIC_WS_SERVER_URL: roomOrigin
	};
	const stackEnv = {
		...process.env,
		NODE_ENV: 'development',
		PUBLIC_SUPABASE_URL: selfOrigin,
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		PUBLIC_WS_SERVER_URL: roomOrigin,
		SUPABASE_SERVICE_ROLE_KEY: 'local-emu',
		ARC_E2E_STORE_PROXY: emulatorOrigin,
		ARC_PLAY_CATALOG_FILE: join(REPO, 'ml/catalog.json'),
		ARC_WS_CATALOG_FILE: join(REPO, 'ml/catalog.json')
	};

	const emulator = own('pgrestEmu', 'node', [
		join(REPO, 'node_modules/.bin/tsx'),
		'server/pgrestEmu.ts', '--listen', String(EMU_PORT), '--rpc'
	], stackEnv);
	await waitFor('store emulator', async () => {
		const response = await fetch(`${emulatorOrigin}/rest/v1/play_game_sessions?limit=1`, {
			headers: { 'Accept-Profile': 'arc_spirits_2d' },
			signal: AbortSignal.timeout(1500)
		});
		return response.status < 500;
	}, emulator, 60);
	check('local auth/store emulator ready', true, emulatorOrigin);

	const build = spawnSync('node', [join(REPO, 'node_modules/.bin/vite'), 'build'], {
		cwd: REPO,
		env: buildEnv,
		encoding: 'utf8'
	});
	if (build.status !== 0) {
		throw new Error(`production build failed\n${(build.stderr ?? '').slice(-4000)}`);
	}
	check('production web bundle built', true);

	const preview = own('vite preview', 'node', [
		join(REPO, 'node_modules/.bin/vite'), 'preview', '--port', String(WEB_PORT), '--strictPort'
	], stackEnv);
	await waitFor('preview', async () => {
		const response = await fetch(`${selfOrigin}/api/play/config`, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	}, preview, 180);
	check('production preview ready', true, selfOrigin);

	const room = own('room server', 'node', [
		join(REPO, 'node_modules/.bin/tsx'), 'server/index.ts'
	], { ...stackEnv, PORT: String(ROOM_PORT) });
	await waitFor('room server', async () => {
		const response = await fetch(`http://127.0.0.1:${ROOM_PORT}/healthz`, {
			signal: AbortSignal.timeout(1500)
		});
		return response.ok;
	}, room, 60);
	check('authoritative room server ready', true, roomOrigin);

	const runner = own('playwright human loop', 'node', [
		join(REPO, 'node_modules/.bin/playwright'), 'test', 'e2e/play-full.spec.ts'
	], stackEnv);
	runner.stdout.on('data', (data) => process.stdout.write(data));
	const [code] = await once(runner, 'exit');
	if (code !== 0) {
		for (const child of [preview, room, emulator]) {
			const tail = safeTail(child.ownedLog);
			if (tail.trim()) console.error(`\n--- ${child.ownedLabel} (safe tail) ---\n${tail}`);
		}
	}
	const passed = Number(runner.ownedLog.match(/(\d+) passed/)?.[1] ?? 0);
	const skipped = Number(runner.ownedLog.match(/(\d+) skipped/)?.[1] ?? 0);
	check('human-loop Playwright exited 0', code === 0, `code=${code}`);
	check('human-loop passed with no skips', passed === 1 && skipped === 0,
		`passed=${passed}; skipped=${skipped}`);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
} finally {
	await cleanup();
}

if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
