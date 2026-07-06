// bench 1b — action latency over the WS room server (the AFTER to action-latency.mjs).
//
// Same room-creation path and same always-legal lobby command as the HTTP bench, but
// commands travel: WS frame → room server (in-memory state, engine in-process) → ack
// frame. No per-command Supabase write (snapshots batch on an interval), no serverless
// cold path, no broadcast wait. Compare bench/results/<date>-action-latency{,-ws}.json.
//
// The room is created via the production HTTP API (rooms live in Supabase, which the
// deployed room server reads on first join), then driven entirely over the socket.
//
// Usage: node bench/action-latency-ws.mjs \
//   [--base=https://arcspirits.com] [--ws=wss://gpu.simforge.ai/arcrooms] [--samples=200]

import WebSocket from 'ws';
import { parseArgs, createRoom, summarize, writeResults, printTable, todayStamp } from './lib.mjs';

const args = parseArgs();
const SAMPLES = Number.isFinite(args.samples) && args.samples > 0 ? args.samples : 200;
const WS_URL = typeof args.ws === 'string' && args.ws ? args.ws : 'wss://gpu.simforge.ai/arcrooms';

function connectAndJoin(url, roomCode, memberToken) {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(url);
		const pending = new Map(); // cmdId -> {sentAt, resolve}
		sock.on('error', reject);
		sock.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.t === 'joined') resolve({ sock, pending, joined: msg });
			if (msg.t === 'ack' && pending.has(msg.cmdId)) {
				const p = pending.get(msg.cmdId);
				pending.delete(msg.cmdId);
				p.resolve({ ok: msg.ok, ms: performance.now() - p.sentAt, error: msg.error });
			}
			if (msg.t === 'error') reject(new Error(`ws error: ${msg.code} ${msg.message}`));
		});
		sock.on('open', () => sock.send(JSON.stringify({ t: 'join', roomCode, memberToken })));
	});
}

async function main() {
	console.log(`[action-latency-ws] ws=${WS_URL} samples=${SAMPLES}`);
	const { code, memberId } = await createRoom(args.base, 'BenchLatencyWs');
	console.log(`[action-latency-ws] room ${code} created via ${args.base}; joining over WS...`);
	const { sock, pending, joined } = await connectAndJoin(WS_URL, code, memberId);
	console.log(`[action-latency-ws] joined as seat=${joined.seat} revision=${joined.revision}`);

	const durations = [30_000, 60_000];
	const ms = [];
	let failures = 0;
	for (let i = 0; i < SAMPLES; i += 1) {
		const cmdId = `bench-${i}`;
		const sentAt = performance.now();
		const done = new Promise((resolve) => pending.set(cmdId, { sentAt, resolve }));
		sock.send(
			JSON.stringify({
				t: 'command',
				cmdId,
				command: { type: 'setNavigationTimer', durationMs: durations[i % 2] }
			})
		);
		const r = await done;
		if (!r.ok) {
			failures += 1;
			if (failures <= 3) console.warn(`  sample ${i} rejected: ${JSON.stringify(r.error)}`);
			continue;
		}
		ms.push(r.ms);
		if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${SAMPLES}`);
	}
	sock.close();

	const stats = summarize(ms);
	const result = {
		metric: 'action-latency-ws',
		description: 'command → server ack round-trip over the deployed WS room server',
		target: 'ws-room-server',
		base: WS_URL,
		command: 'setNavigationTimer (lobby, always-legal, revision-bumping)',
		...stats,
		unit: 'ms',
		failures,
		notes: [
			'same command + room-creation path as action-latency.mjs; only the transport differs',
			'includes real network RTT client → gpu.simforge.ai; in-process compute is ~0.1ms'
		],
		capturedAt: new Date().toISOString()
	};
	writeResults('action-latency-ws', result);
	printTable('action-latency-ws (ms)', [
		...Object.entries(stats),
		['failures', failures]
	]);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
