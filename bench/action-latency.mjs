// bench 1 — action latency: command → server ack round-trip over today's HTTP path.
//
// Each command travels: fetch → Vercel serverless fn → load full room state from
// Supabase → reduce (pure engine) → compare-and-set write back to Supabase → DB
// trigger broadcasts {revision} → JSON response. That whole chain is what the WS
// server will replace, so this p50/p95 is the number to beat.
//
// We drive a lobby room and repeatedly toggle `setNavigationTimer` between two
// durations. It is host-only + lobby-only + always legal, and every call bumps the
// revision (verified), so it exercises the real CAS-write path without depending on
// game phase or the guardian pool. Caveat: lobby `public_state` is smaller than a
// mid-game state, so the CAS-write payload here is a floor, not a mid-game figure.
//
// Usage: node bench/action-latency.mjs [--base=https://arcspirits.com] [--samples=200]

import {
	parseArgs,
	createRoom,
	sendCommand,
	summarize,
	writeResults,
	printTable,
	todayStamp
} from './lib.mjs';

const args = parseArgs();
const SAMPLES = Number.isFinite(args.samples) && args.samples > 0 ? args.samples : 200;
const isProd = /arcspirits\.com/.test(args.base);

async function main() {
	console.log(`[action-latency] target=${args.base} samples=${SAMPLES}`);
	const { code, memberId } = await createRoom(args.base, 'BenchLatency');
	console.log(`[action-latency] room ${code} created; sending ${SAMPLES} commands sequentially...`);

	const durations = [30_000, 60_000];
	const ms = [];
	let failures = 0;
	for (let i = 0; i < SAMPLES; i += 1) {
		const command = { type: 'setNavigationTimer', durationMs: durations[i % 2] };
		const r = await sendCommand(args.base, code, memberId, command);
		if (!r.ok) {
			failures += 1;
			if (failures <= 3) console.warn(`  sample ${i} failed: ${r.status} ${r.text.slice(0, 120)}`);
			continue;
		}
		ms.push(r.ms);
		if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${SAMPLES}`);
	}

	const stats = summarize(ms);
	const result = {
		metric: 'action-latency',
		description: 'command → server ack round-trip (HTTP + Supabase CAS write + broadcast trigger)',
		target: isProd ? 'prod-http' : 'http',
		base: args.base,
		command: 'setNavigationTimer (lobby, always-legal, revision-bumping)',
		...stats,
		unit: 'ms',
		failures,
		notes: [
			isProd ? 'Captured against production HTTP path.' : 'NON-PROD base — labelled for clarity.',
			'Lobby-state write path; mid-game public_state is larger, so this is a lower bound.',
			'Sequential requests, single client — no concurrency.'
		].join(' '),
		capturedAt: new Date().toISOString()
	};

	const file = writeResults('action-latency', result);
	printTable('action-latency (ms)', [
		['p50', stats.p50],
		['p95', stats.p95],
		['min', stats.min],
		['max', stats.max],
		['mean', stats.mean],
		['samples', stats.samples],
		['failures', failures]
	]);
	console.log(`wrote ${file}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
