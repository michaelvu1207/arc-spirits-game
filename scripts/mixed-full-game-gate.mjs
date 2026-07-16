#!/usr/bin/env node
/** Self-contained three-game mixed web/Godot release gate. */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwned, stopOwned } from './procOwn.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GODOT_REPO = join(REPO, '..', 'arc-spirits-godot');
const GODOT_BIN = process.env.ARC_GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
const WEB_PORT = 4173;
const EMU_PORT = 9200 + Math.floor(Math.random() * 100);
const ROOM_PORT = 9300 + Math.floor(Math.random() * 100);
const RESULT = join(REPO, 'bench', 'results', `${new Date().toISOString().slice(0, 10)}-mixed-full-games.json`);
const children = [];

function own(label, command, args, env) {
	const child = spawnOwned(command, args, { cwd: REPO, env, label });
	children.push(child);
	return child;
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port });
		const done = (open) => { socket.destroy(); resolve(open); };
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		setTimeout(() => done(false), 750);
	});
}

async function waitFor(label, probe, child, attempts = 180) {
	for (let i = 0; i < attempts; i += 1) {
		if (child.exitCode != null) break;
		try { if (await probe()) return; } catch { /* not ready */ }
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${label} did not become ready\n${(child.ownedLog ?? '').slice(-3000)}`);
}

async function main() {
	for (const port of [WEB_PORT, EMU_PORT, ROOM_PORT]) {
		if (await portOpen(port)) throw new Error(`port ${port} already in use`);
	}
	const self = `http://localhost:${WEB_PORT}`;
	const emulator = `http://127.0.0.1:${EMU_PORT}`;
	const ws = `ws://127.0.0.1:${ROOM_PORT}`;
	const env = {
		...process.env, NODE_ENV: 'development',
		PUBLIC_SUPABASE_URL: self, PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		SUPABASE_SERVICE_ROLE_KEY: 'local-emu', PUBLIC_WS_SERVER_URL: ws,
		ARC_E2E_STORE_PROXY: emulator,
		ARC_PLAY_CATALOG_FILE: join(REPO, 'ml/catalog.json'),
		ARC_WS_CATALOG_FILE: join(REPO, 'ml/catalog.json'),
		ARC_GODOT_REPO: GODOT_REPO, ARC_GODOT_BIN: GODOT_BIN,
		ARC_MIXED_RESULT: RESULT
	};
	const emu = own('pgrestEmu', 'node', [join(REPO, 'node_modules/.bin/tsx'), 'server/pgrestEmu.ts', '--listen', String(EMU_PORT), '--rpc'], env);
	await waitFor('store', async () => (await fetch(`${emulator}/rest/v1/play_game_sessions?limit=1`, { headers: { 'Accept-Profile': 'arc_spirits_2d' } })).status < 500, emu);
	console.log(`PASS  local store ready — :${EMU_PORT}`);

	const build = spawnSync('node', [join(REPO, 'node_modules/.bin/vite'), 'build'], { cwd: REPO, env: { ...env, NODE_ENV: 'production' }, encoding: 'utf8' });
	if (build.status !== 0) throw new Error(`production build failed\n${String(build.stderr).slice(-4000)}`);
	console.log('PASS  production web bundle built');
	const preview = own('vite preview', 'node', [join(REPO, 'node_modules/.bin/vite'), 'preview', '--port', String(WEB_PORT), '--strictPort'], env);
	await waitFor('preview', async () => (await fetch(`${self}/api/play/config`)).ok, preview);
	console.log(`PASS  production preview ready — :${WEB_PORT}`);
	const room = own('room server', 'node', [join(REPO, 'node_modules/.bin/tsx'), 'server/index.ts'], { ...env, PORT: String(ROOM_PORT) });
	await waitFor('room server', async () => (await fetch(`http://127.0.0.1:${ROOM_PORT}/healthz`)).ok, room);
	console.log(`PASS  room server ready — :${ROOM_PORT}`);

	const runner = own('mixed full game', 'node', [join(REPO, 'node_modules/.bin/playwright'), 'test', 'e2e/mixed-full-game.spec.ts'], env);
	runner.stdout.on('data', (data) => process.stdout.write(data));
	runner.stderr.on('data', (data) => process.stderr.write(data));
	const [code] = await once(runner, 'exit');
	if (code !== 0) throw new Error(`mixed full-game Playwright failed (${code})`);
	console.log(`PASS  three mixed complete games — ${RESULT}`);
}

let failed = false;
try { await main(); } catch (error) {
	failed = true;
	console.error(error instanceof Error ? error.stack : String(error));
} finally {
	for (const child of [...children].reverse()) await stopOwned(child, { termTimeoutMs: 5000 });
	for (const [name, port] of [['web', WEB_PORT], ['store', EMU_PORT], ['room', ROOM_PORT]]) {
		if (await portOpen(port)) { failed = true; console.error(`FAIL  ${name} port ${port} still open`); }
	}
}
if (failed) process.exitCode = 1;
