#!/usr/bin/env node
/**
 * Self-contained local stack for cross-browser platform tests. The browser,
 * SvelteKit server and anonymous-auth/PostgREST store all run on this laptop;
 * no test is allowed to fall through to the placeholder or production Supabase.
 * Playwright owns this process and SIGTERMs it after the suite, so every child
 * is placed in an owned process group and its real exit is awaited.
 */
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePort = Number(process.env.ARC_PLATFORM_STORE_PORT || 8937);
const appPort = Number(process.env.ARC_PLATFORM_APP_PORT || 4174);
const storeUrl = `http://127.0.0.1:${storePort}`;
const children = [];
let stopping = false;

function own(label, command, args, env) {
	// Do not detach: Playwright already launches this stack as one owned process
	// group. Keeping descendants in that group means its teardown reaches every
	// process even if the launcher itself is killed before its signal handler can
	// finish. The longer release gates use procOwn because *they* are the owner;
	// here Playwright is.
	const child = spawn(command, args, {
		cwd: root,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: false
	});
	child.ownedLabel = label;
	child.ownedLog = '';
	children.push(child);
	child.stdout?.on('data', (data) => {
		child.ownedLog += data;
		process.stdout.write(`[${label}] ${data}`);
	});
	child.stderr?.on('data', (data) => {
		child.ownedLog += data;
		process.stderr.write(`[${label}] ${data}`);
	});
	return child;
}

async function stopChild(child) {
	if (child.exitCode != null || child.signalCode != null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	const graceful = await Promise.race([
		exited.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 3000))
	]);
	if (!graceful) {
		child.kill('SIGKILL');
		await exited;
	}
}

async function waitForStore(child) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (child.exitCode != null) throw new Error(`local store exited early\n${child.ownedLog.slice(-3000)}`);
		try {
			const response = await fetch(`${storeUrl}/rest/v1/play_game_sessions?limit=1`, {
				headers: { 'Accept-Profile': 'arc_spirits_2d', apikey: 'local-emu' },
				signal: AbortSignal.timeout(1000)
			});
			if (response.status < 500) return;
		} catch {
			// Startup race; bounded below.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`local store did not become ready\n${child.ownedLog.slice(-3000)}`);
}

async function shutdown(code) {
	if (stopping) return;
	stopping = true;
	for (const child of [...children].reverse()) await stopChild(child);
	process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.once(signal, () => void shutdown(0));
}

try {
	const env = {
		...process.env,
		NODE_ENV: 'development',
		PUBLIC_SUPABASE_URL: storeUrl,
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		SUPABASE_SERVICE_ROLE_KEY: 'local-emu',
		ARC_PLAY_CATALOG_FILE: join(root, 'ml/catalog.json'),
		ARC_WS_CATALOG_FILE: join(root, 'ml/catalog.json')
	};
	const store = own('store', process.execPath, [
		'--import', 'tsx',
		'server/pgrestEmu.ts',
		'--listen', String(storePort),
		'--rpc'
	], env);
	await waitForStore(store);
	const app = own('app', process.execPath, [
		join(root, 'node_modules/.bin/vite'),
		'dev', '--port', String(appPort), '--strictPort'
	], env);

	for (const child of [store, app]) {
		void once(child, 'exit').then(([code, signal]) => {
			if (!stopping) {
				console.error(`${child.ownedLabel} exited unexpectedly (code=${code}, signal=${signal})`);
				void shutdown(1);
			}
		});
	}
	await new Promise(() => {});
} catch (error) {
	console.error(error);
	await shutdown(1);
}
