// bench 2 — update propagation: commit on client A → view-ready on client B.
//
// This replicates the real web client's sync path (src/lib/stores/playStore.svelte.ts):
// client B subscribes to the Supabase Realtime broadcast channel `room:<CODE>` and,
// on each `sync` event (emitted by a DB trigger on every revision bump), refetches
// the `/view` projection. We measure from client A's command-ack (commit done, new
// revision R known) to the moment client B has fetched + parsed a `/view` at
// revision ≥ R. That is the true "other player sees my move" latency today:
// broadcast fan-out + a full projection refetch.
//
// Note vs. production client: the store debounces the refetch by 80ms
// (REFRESH_DEBOUNCE_MS) to coalesce bursts; we DON'T debounce here (one command at a
// time), so this is the floor the store adds ~80ms on top of in bursty play.
//
// Usage: node bench/update-propagation.mjs [--base=https://arcspirits.com] [--samples=100]

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	parseArgs,
	createRoom,
	sendCommand,
	getView,
	summarize,
	writeResults,
	printTable,
	sleep
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Read the PUBLIC (anon) Supabase creds the same way SvelteKit does at build:
// PUBLIC_* vars from the repo .env. The anon key is client-side public by design.
function loadPublicEnv() {
	const env = {};
	for (const file of ['.env', '.env.local']) {
		try {
			const text = readFileSync(join(HERE, '..', file), 'utf8');
			for (const line of text.split('\n')) {
				const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
				if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
			}
		} catch {
			/* file optional */
		}
	}
	return env;
}

const args = parseArgs();
const SAMPLES = Number.isFinite(args.samples) && args.samples > 0 ? args.samples : 100;
const isProd = /arcspirits\.com/.test(args.base);

async function main() {
	const env = loadPublicEnv();
	const url = process.env.PUBLIC_SUPABASE_URL || env.PUBLIC_SUPABASE_URL;
	const anon = process.env.PUBLIC_SUPABASE_ANON_KEY || env.PUBLIC_SUPABASE_ANON_KEY;
	if (!url || !anon) throw new Error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY (.env).');

	console.log(`[update-propagation] target=${args.base} samples=${SAMPLES}`);
	const { code, token } = await createRoom(args.base, 'BenchProp');
	console.log(`[update-propagation] room ${code}; subscribing client B to room:${code}...`);

	// Client B: the passive observer. Subscribe exactly as playStore.openChannel does.
	const supabase = createClient(url, anon, { realtime: { params: { eventsPerSecond: 40 } } });
	let target = -1;
	let onReached = null; // resolver for the current in-flight sample
	let bReady = false;

	const channel = supabase.channel(`room:${code}`, {
		config: { broadcast: { self: false }, private: false }
	});
	channel.on('broadcast', { event: 'sync' }, () => {
		// Mirror the store: a sync signal → refetch the projection, then check revision.
		void (async () => {
			const r = await getView(args.base, code, token);
			if (r.ok && onReached && r.json?.projection?.revision >= target) {
				const resolve = onReached;
				onReached = null;
				resolve();
			}
		})();
	});

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Realtime subscribe timed out (10s).')), 10_000);
		channel.subscribe((status) => {
			if (status === 'SUBSCRIBED') {
				clearTimeout(timer);
				bReady = true;
				resolve();
			} else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
				clearTimeout(timer);
				reject(new Error(`Realtime subscribe failed: ${status}`));
			}
		});
	});
	console.log(`[update-propagation] client B subscribed; running ${SAMPLES} commits...`);

	const durations = [30_000, 60_000];
	const ms = [];
	let timeouts = 0;
	for (let i = 0; i < SAMPLES; i += 1) {
		const command = { type: 'setNavigationTimer', durationMs: durations[i % 2] };
		// Fire the command from client A; its ack carries the freshly-committed revision.
		const ack = await sendCommand(args.base, code, token, command);
		if (!ack.ok) {
			timeouts += 1;
			continue;
		}
		const revision = ack.json.projection.revision;
		const t0 = performance.now();
		target = revision;
		const reached = new Promise((resolve) => (onReached = resolve));
		const timed = await Promise.race([
			reached.then(() => true),
			sleep(8_000).then(() => false)
		]);
		if (timed) {
			ms.push(performance.now() - t0);
		} else {
			timeouts += 1;
			onReached = null;
		}
		if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${SAMPLES}`);
	}

	await supabase.removeChannel(channel);

	const stats = summarize(ms);
	const result = {
		metric: 'update-propagation',
		description:
			'client A commit-ack → client B Realtime broadcast + /view refetch parsed (revision ≥ committed)',
		target: isProd ? 'prod-http' : 'http',
		base: args.base,
		transport: 'Supabase Realtime broadcast (room:<CODE>, event sync) + HTTP /view refetch',
		...stats,
		unit: 'ms',
		timeouts,
		notes: [
			isProd ? 'Captured against production.' : 'NON-PROD base — labelled for clarity.',
			`Client B subscribed OK: ${bReady}.`,
			'Excludes the 80ms store refresh-debounce (measured single-commit, not bursty).',
			'8s per-sample timeout; timeouts counted, excluded from percentiles.'
		].join(' '),
		capturedAt: new Date().toISOString()
	};

	const file = writeResults('update-propagation', result);
	printTable('update-propagation (ms)', [
		['p50', stats.p50],
		['p95', stats.p95],
		['min', stats.min],
		['max', stats.max],
		['mean', stats.mean],
		['samples', stats.samples],
		['timeouts', timeouts]
	]);
	console.log(`wrote ${file}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
