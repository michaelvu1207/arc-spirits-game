#!/usr/bin/env node
// Play Arc Spirits on this Mac with the local design data. No Supabase project is used.
//
//   npm run local                 # http://127.0.0.1:5317/play
//   npm run local -- --port 5400 --open
//
// It starts three parts and stops them all on Ctrl+C:
//   1. the database + sign-in emulator (emulator.ts: server/pgrestEmu.ts, saved to
//      <state-dir>/emulator/ so games survive a restart)
//   2. the local backend (backend.mjs): catalog from ~/ArcSpiritsArt/game/*.json, images from
//      ~/ArcSpiritsArt, realtime room updates
//   3. the Vite dev server (vite.config.local.mjs), which sends the Supabase paths to (2)
// See scripts/local-game/README.md.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startBackend } from './backend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const home = os.homedir();

const { values: args } = parseArgs({
	options: {
		port: { type: 'string', default: process.env.ARC_LOCAL_PORT ?? '5317' },
		'game-dir': { type: 'string', default: process.env.ARC_LOCAL_GAME_DIR ?? join(home, 'ArcSpiritsArt/game') },
		'art-dir': { type: 'string', default: process.env.ARC_LOCAL_ART_DIR ?? join(home, 'ArcSpiritsArt') },
		'state-dir': { type: 'string', default: process.env.ARC_LOCAL_STATE_DIR ?? join(home, '.arc-local-game') },
		'log-dir': { type: 'string', default: process.env.ARC_LOCAL_LOG_DIR ?? join(os.tmpdir(), 'arc-local-game') },
		'strict-port': { type: 'boolean', default: false },
		open: { type: 'boolean', default: false },
		'no-tts-cache': { type: 'boolean', default: false },
		// The folder with the AI game runs (league, benchmark, tournament) shown in the explorer.
		'agent-games': { type: 'string', default: process.env.ARC_LOCAL_AGENT_GAMES ?? join(home, 'arcspirits-harness') },
		'no-explorer-import': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false }
	}
});
if (args.help) {
	console.log(readFileSync(join(here, 'README.md'), 'utf8'));
	process.exit(0);
}

const gameDir = resolve(args['game-dir']);
const artDir = resolve(args['art-dir']);
const stateDir = resolve(args['state-dir']);
const logDir = resolve(args['log-dir']);
mkdirSync(logDir, { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const backendLog = createWriteStream(join(logDir, 'backend.log'), { flags: 'w' });
const log = (line) => backendLog.write(`${new Date().toISOString()} ${line}\n`);

if (!existsSync(join(gameDir, 'hex_spirits.json'))) {
	console.error(`No game data at ${gameDir} (hex_spirits.json not found). Use --game-dir <dir>.`);
	process.exit(1);
}

const children = [];
let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
	backend?.close();
	// Wait for the children (the emulator writes its save file on SIGTERM), at most 5 s.
	const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
	let left = running.length;
	const exit = () => process.exit(code);
	if (left === 0) setTimeout(exit, 300).unref();
	for (const child of running) child.once('exit', () => --left === 0 && exit());
	setTimeout(exit, 5000).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('exit', () => {
	for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
});

/** Admin and host secrets for this machine: made once, kept in <state-dir>/secrets.json (0600).
 *  Values from the environment win. They are never printed. */
function localSecrets() {
	const file = join(stateDir, 'secrets.json');
	let saved = {};
	if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8'));
	else {
		saved = { ADMIN_SECRET_KEY: randomBytes(24).toString('base64url'), HOST_SECRET_KEY: randomBytes(24).toString('base64url') };
		writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
	}
	return {
		ADMIN_SECRET_KEY: process.env.ADMIN_SECRET_KEY || saved.ADMIN_SECRET_KEY,
		HOST_SECRET_KEY: process.env.HOST_SECRET_KEY || saved.HOST_SECRET_KEY
	};
}

function portFree(port) {
	return new Promise((done) => {
		const probe = net.createServer();
		probe.once('error', () => done(false));
		probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
	});
}
async function freePort() {
	return new Promise((done) => {
		const probe = net.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
}
async function waitFor(check, timeoutMs, what) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (stopping) throw new Error('stopped');
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${what} did not start in ${Math.round(timeoutMs / 1000)} s`);
}
const tcpOpen = (port) =>
	new Promise((done) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => (socket.destroy(), done(true)));
		socket.once('error', () => done(false));
	});

function launch(name, command, argv, env) {
	const out = createWriteStream(join(logDir, `${name}.log`), { flags: 'w' });
	const child = spawn(command, argv, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(out);
	child.stderr.pipe(out);
	child.on('exit', (code, signal) => {
		// Ctrl+C reaches the children too; give our own SIGINT handler a moment to run first.
		setTimeout(() => {
			if (stopping) return;
			console.error(`\n${name} stopped (${signal ?? `exit ${code}`}). Log: ${join(logDir, `${name}.log`)}`);
			stop(1);
		}, 300);
	});
	children.push(child);
	return child;
}

let backend;
try {
	// App port: the one asked for, else the next free one.
	let appPort = Number(args.port);
	if (args['strict-port'] && !(await portFree(appPort))) throw new Error(`port ${appPort} is in use`);
	for (let i = 0; i < 20 && !(await portFree(appPort)); i++) appPort++;
	if (!(await portFree(appPort))) throw new Error(`no free port near ${args.port}`);
	const appOrigin = `http://127.0.0.1:${appPort}`;
	const emulatorPort = await freePort();

	// The app must only ever talk to this machine.
	const env = { ...process.env };
	for (const key of ['ARC_PLAY_CATALOG_FILE', 'ARC_WS_CATALOG_FILE', 'ARC_E2E_STORE_PROXY']) delete env[key];
	Object.assign(env, {
		NODE_ENV: 'development',
		// The server reaches "Supabase" here; the browser uses its own page origin
		// (src/lib/supabaseOrigin.ts), so 127.0.0.1 and the tailnet name both work.
		PUBLIC_SUPABASE_URL: appOrigin,
		PUBLIC_SUPABASE_SAME_ORIGIN: '1',
		PUBLIC_SUPABASE_ANON_KEY: 'local-emu',
		SUPABASE_SERVICE_ROLE_KEY: 'local-emu',
		PUBLIC_WS_SERVER_URL: '',
		PUBLIC_API_BASE_URL: '',
		// A data edit reaches the next game within a second (src/lib/play/server/catalog.ts).
		ARC_PLAY_CATALOG_TTL_MS: '1000',
		// Own SvelteKit and Vite folders: other dev servers in this checkout rewrite .svelte-kit.
		ARC_SVELTEKIT_OUT_DIR: `.svelte-kit-local-${appPort}`,
		// Bots on (src/lib/play/botAvailability.ts), with the bundled policy weights.
		VITE_ARC_LOCAL_BOTS: '1',
		// The game explorer under /explorer, and the data editor may frame it (src/lib/explorer.ts).
		PUBLIC_ARC_LOCAL_EXPLORER: '1',
		...localSecrets()
	});

	launch(
		'emulator',
		process.execPath,
		['--import', 'tsx', 'scripts/local-game/emulator.ts', '--port', String(emulatorPort), '--state', join(stateDir, 'emulator')],
		env
	);
	await waitFor(() => tcpOpen(emulatorPort), 30_000, 'The database emulator');

	backend = await startBackend({
		upstreamPort: emulatorPort,
		gameDir,
		artDir,
		repoRoot,
		spiritNamesFile: join(home, 'niji-batch/spirit-names.json'),
		ttsDir: args['no-tts-cache'] ? null : join(home, 'Library/Tabletop Simulator/Mods/Images'),
		// Resized images, keyed by source file + size: shared by every local game on this Mac.
		cacheDir: join(os.tmpdir(), 'arc-local-game', 'image-cache'),
		log
	});
	env.ARC_LOCAL_BACKEND_PORT = String(backend.port);

	launch(
		'app',
		process.execPath,
		[
			// As in `npm run build`: a Vite transform overflows the default stack on the 5 MB
			// @sparkjsdev/spark bundle (the play page's splat background).
			'--stack-size=4096',
			'node_modules/vite/bin/vite.js',
			'dev',
			'--config',
			'scripts/local-game/vite.config.local.mjs',
			'--host',
			'127.0.0.1',
			'--port',
			String(appPort),
			'--strictPort'
		],
		env
	);
	process.stdout.write('Starting the app (the first page build takes some seconds) ');
	const dots = setInterval(() => process.stdout.write('.'), 1000);
	await waitFor(
		async () => {
			try {
				const res = await fetch(`${appOrigin}/play`, { signal: AbortSignal.timeout(60_000) });
				return res.status < 500;
			} catch {
				return false;
			}
		},
		180_000,
		'The app'
	);
	clearInterval(dots);

	// The explorer's games: AI game records and the games played here, imported now and then
	// every 30 s (import-agent-games.ts). It is a helper: when it stops, the game goes on.
	if (!args['no-explorer-import']) {
		const out = createWriteStream(join(logDir, 'explorer-import.log'), { flags: 'w' });
		const importer = spawn(
			process.execPath,
			['--import', 'tsx', 'scripts/local-game/import-agent-games.ts', '--base', appOrigin, '--root', resolve(args['agent-games']), '--watch', '30'],
			{ cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		importer.stdout.pipe(out);
		importer.stderr.pipe(out);
		children.push(importer);
	}

	const { counts, images, notes } = backend.summary;
	console.log('\n');
	console.log('Arc Spirits: local game (no Supabase project is used)');
	console.log(`  data    ${gameDir}`);
	console.log(`          ${['hex_spirits', 'monsters_v2', 'classes', 'origins', 'mat_items', 'icon_pool'].map((t) => `${t} ${counts[t]}`).join(', ')}`);
	console.log(`  images  ${artDir} (${images.paths} paths; status: ${appOrigin}/__local/status)`);
	for (const note of notes) console.log(`  note    ${note}`);
	console.log(`  saved   ${join(stateDir, 'emulator')} (rooms, games, replays, accounts)`);
	console.log(`  logs    ${logDir}`);
	console.log('  stop    Ctrl+C. Data edits show in the next game, no restart needed.');
	console.log('  player 2: open the URL in a private window (Cmd+Shift+N) or another browser.');
	console.log(`  explorer ${appOrigin}/explorer (records, game viewer, leaderboard, players)`);
	console.log('');
	console.log(`Open ${appOrigin}/play`);
	if (args.open) spawn('open', [`${appOrigin}/play`], { stdio: 'ignore', detached: true }).unref();
} catch (error) {
	console.error(`\nThe local game did not start: ${error?.message ?? error}`);
	console.error(`Logs: ${logDir}`);
	stop(1);
}
