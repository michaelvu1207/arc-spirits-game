/**
 * End-to-end smoke for the room server. Boots a LOCAL instance on a random port, seeds an
 * active game (dev seed endpoint), then drives two WS clients through the protocol and
 * asserts the contract: joined ack, per-connection view filtering (owner vs spectator),
 * command → ack + broadcast delta, ping/pong, resync, and the heartbeat constants.
 *
 * Run: node server/smoke.mjs   (needs the repo's Supabase env in .env / .env.local)
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const results = [];
function check(name, cond, detail = '') {
	results.push({ name, ok: !!cond, detail });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!cond) process.exitCode = 1;
}

function nextMessage(ws, predicate, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off('message', onMsg);
			reject(new Error('timeout waiting for message'));
		}, timeoutMs);
		function onMsg(data) {
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (predicate(msg)) {
				clearTimeout(timer);
				ws.off('message', onMsg);
				resolve(msg);
			}
		}
		ws.on('message', onMsg);
	});
}

function openSocket() {
	const ws = new WebSocket(WS_URL);
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws));
		ws.once('error', reject);
	});
}

async function waitForHealth(retries = 60) {
	for (let i = 0; i < retries; i += 1) {
		try {
			const res = await fetch(`${BASE}/healthz`);
			if (res.ok) return await res.json();
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('server did not become healthy');
}

let child;
async function main() {
	// 1) Boot the server as a child process on a random port with the dev seed enabled.
	child = spawn('npx', ['tsx', join(HERE, 'index.ts')], {
		cwd: join(HERE, '..'),
		env: { ...process.env, PORT: String(PORT), ARC_WS_ALLOW_DEBUG_SEED: '1' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let serverLog = '';
	child.stdout.on('data', (d) => (serverLog += d));
	child.stderr.on('data', (d) => (serverLog += d));

	const health = await waitForHealth().catch((err) => {
		console.error('--- server log ---\n' + serverLog);
		throw err;
	});
	check('server healthy', health.ok === true, `rooms=${health.rooms} uptime=${health.uptime}s`);

	// 2) Seed an active room (returns a pre-validated legal command for the seat).
	const seedRes = await fetch(`${BASE}/debug/seed`, { method: 'POST' });
	const seed = await seedRes.json();
	if (!seedRes.ok) {
		console.error('--- server log ---\n' + serverLog);
		throw new Error(`seed failed: ${seed.error}`);
	}
	check('room seeded', !!seed.roomCode && !!seed.memberId, `room=${seed.roomCode} seat=${seed.seat}`);
	check('seed produced a legal command', !!seed.sampleCommand?.type, `cmd=${seed.sampleCommand?.type}`);

	// 3) Seated client joins with the member token.
	const owner = await openSocket();
	owner.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, memberToken: seed.memberId }));
	const ownerJoined = await nextMessage(owner, (m) => m.t === 'joined');
	check('owner joined', ownerJoined.t === 'joined', `revision=${ownerJoined.revision}`);
	check('owner seated at correct seat', ownerJoined.seat === seed.seat, `seat=${ownerJoined.seat}`);
	const ownerLastAction = ownerJoined.view?.projection?.players?.[seed.seat]?.lastAction;
	check('owner sees own private field (lastAction)', ownerLastAction != null, JSON.stringify(ownerLastAction));
	const ownerAffordances = ownerJoined.view?.affordances ?? {};
	check(
		'owner view carries its own seat affordances',
		!!ownerAffordances[seed.seat] && ownerAffordances[seed.seat].seat === seed.seat,
		`affordance seats=[${Object.keys(ownerAffordances).join(',')}] phase=${ownerAffordances[seed.seat]?.phase}`
	);

	// 4) Spectator joins with no credential.
	const spectator = await openSocket();
	spectator.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode }));
	const specJoined = await nextMessage(spectator, (m) => m.t === 'joined');
	check('spectator joined', specJoined.t === 'joined');
	check('spectator has no seat', specJoined.seat === null, `seat=${specJoined.seat}`);
	const specLastAction = specJoined.view?.projection?.players?.[seed.seat]?.lastAction;
	check(
		'spectator CANNOT see owner private field (blanked)',
		specLastAction === null,
		`spectator lastAction=${JSON.stringify(specLastAction)} vs owner=${JSON.stringify(ownerLastAction)}`
	);
	const specAffordances = specJoined.view?.affordances ?? null;
	check(
		'spectator gets empty affordances {}',
		specAffordances && Object.keys(specAffordances).length === 0,
		`affordances=${JSON.stringify(specAffordances)}`
	);

	// 5) Owner submits the legal command; assert ack ok + broadcast delta to the spectator.
	const cmdId = 'smoke-cmd-1';
	const deltaPromise = nextMessage(spectator, (m) => m.t === 'delta');
	const t0 = performance.now();
	owner.send(JSON.stringify({ t: 'command', cmdId, command: seed.sampleCommand }));
	const ack = await nextMessage(owner, (m) => m.t === 'ack' && m.cmdId === cmdId);
	const ackMs = performance.now() - t0;
	check('command acked ok', ack.ok === true, `ack in ${ackMs.toFixed(1)}ms, revision=${ack.revision}`);
	check('ack carries a fresh view', ack.view?.version === 2 && !!ack.view?.projection);
	check('revision advanced', ack.revision > ownerJoined.revision, `${ownerJoined.revision} → ${ack.revision}`);

	const delta = await deltaPromise;
	check('spectator received broadcast delta', delta.t === 'delta');
	check('delta.toRevision matches ack revision', delta.toRevision === ack.revision, `delta.to=${delta.toRevision} ack=${ack.revision}`);
	const deltaSpecLastAction = delta.patch?.projection?.players?.[seed.seat]?.lastAction;
	check('delta stays viewer-filtered for spectator', deltaSpecLastAction === null, `lastAction=${JSON.stringify(deltaSpecLastAction)}`);

	// 6) ping → pong (RTT echo).
	const pingTs = Date.now();
	owner.send(JSON.stringify({ t: 'ping', ts: pingTs }));
	const pong = await nextMessage(owner, (m) => m.t === 'pong');
	check('ping → pong echoes ts', pong.ts === pingTs);

	// 7) resync → delta with the full current view.
	spectator.send(JSON.stringify({ t: 'resync', fromRevision: 0 }));
	const resync = await nextMessage(spectator, (m) => m.t === 'delta');
	check('resync returns a full-view delta', resync.t === 'delta' && resync.patch?.version === 2, `to=${resync.toRevision}`);

	// 8) reconnect: a new socket resuming from a revision gets a delta (not a joined).
	const reconnect = await openSocket();
	reconnect.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, memberToken: seed.memberId, resumeFromRevision: ownerJoined.revision }));
	const resumed = await nextMessage(reconnect, (m) => m.t === 'delta' || m.t === 'joined');
	check('reconnect (resumeFromRevision) replies with a delta', resumed.t === 'delta', `from=${resumed.fromRevision} to=${resumed.toRevision}`);

	// 9) Heartbeat constants respected (documented values in protocol.ts).
	const protoText = readFileSync(join(HERE, 'protocol.ts'), 'utf8');
	const interval = Number(protoText.match(/HEARTBEAT_INTERVAL_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ''));
	const timeout = Number(protoText.match(/HEARTBEAT_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ''));
	check('heartbeat interval < timeout', interval > 0 && interval < timeout, `interval=${interval}ms timeout=${timeout}ms`);

	owner.close();
	spectator.close();
	reconnect.close();

	console.log(`\ncommand → ack latency: ${ackMs.toFixed(1)}ms`);
}

main()
	.catch((err) => {
		console.error('SMOKE ERROR:', err);
		process.exitCode = 1;
	})
	.finally(() => {
		if (child) child.kill('SIGTERM');
		const passed = results.filter((r) => r.ok).length;
		console.log(`\n${passed}/${results.length} checks passed`);
		setTimeout(() => process.exit(process.exitCode ?? 0), 500);
	});
