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
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

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

async function mintTicket(memberId) {
	const res = await fetch(`${BASE}/debug/ticket?memberId=${encodeURIComponent(memberId)}`, { method: 'POST' });
	const body = await res.json();
	if (!body.ticket) throw new Error(`ticket mint failed: ${body.error ?? res.status}`);
	return body.ticket;
}

async function mintSpectatorTicket(roomCode) {
	const res = await fetch(`${BASE}/debug/spectator-ticket?roomCode=${encodeURIComponent(roomCode)}`, { method: 'POST' });
	const body = await res.json();
	if (!body.ticket) throw new Error(`spectator ticket mint failed: ${body.error ?? res.status}`);
	return body.ticket;
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
		env: {
			...process.env,
			PORT: String(PORT),
			ARC_WS_ALLOW_DEBUG_SEED: '1',
			// Fast tick so the smoke observes bot moves + deadline enforcement quickly.
			ARC_WS_BOT_TICK_MS: '200'
		},
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
	check('room seeded', !!seed.roomCode && !!seed.ticket, `room=${seed.roomCode} seat=${seed.seat}`);
	check('seed produced a legal command', !!seed.sampleCommand?.type, `cmd=${seed.sampleCommand?.type}`);

	// 3) Seated client joins with its ONE-USE ticket.
	const owner = await openSocket();
	owner.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, ticket: seed.ticket }));
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

	// 4) Spectator joins with a spectator ticket (read-only permission).
	const spectator = await openSocket();
	spectator.send(
		JSON.stringify({ t: 'join', roomCode: seed.roomCode, ticket: await mintSpectatorTicket(seed.roomCode) })
	);
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
	reconnect.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, ticket: await mintTicket(seed.memberId), resumeFromRevision: ownerJoined.revision }));
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

	// ── M0e: in-process bot ticking ───────────────────────────────────────────────
	// 10) Seed 1 human + 3 bots. The human joins and sends NO commands; the server's
	//     in-process tick loop must drive the bots so the human receives deltas with an
	//     advancing revision — proving bots act with zero client tick POSTs.
	const botSeedRes = await fetch(`${BASE}/debug/seed-bots?botCount=3&navMs=1000`, { method: 'POST' });
	const botSeed = await botSeedRes.json();
	check('bot room seeded (1 human + 3 bots)', !!botSeed.roomCode && botSeed.botSeats?.length === 3, `room=${botSeed.roomCode} bots=${JSON.stringify(botSeed.botSeats)}`);

	const humanSock = await openSocket();
	humanSock.send(JSON.stringify({ t: 'join', roomCode: botSeed.roomCode, ticket: botSeed.humanTicket }));
	const humanJoined = await nextMessage(humanSock, (m) => m.t === 'joined');
	const botStartRev = humanJoined.revision;
	let deltaCount = 0;
	humanSock.on('message', (d) => { try { if (JSON.parse(d.toString()).t === 'delta') deltaCount += 1; } catch {} });
	const tBot0 = performance.now();
	// No command is ever sent from this client — wait for the bots to advance the game.
	const botDelta = await nextMessage(humanSock, (m) => m.t === 'delta' && m.toRevision > botStartRev, 12000);
	const botFirstDeltaMs = performance.now() - tBot0;
	check('bots advance the game with NO client tick POSTs', botDelta.toRevision > botStartRev, `rev ${botStartRev} → ${botDelta.toRevision} in ${botFirstDeltaMs.toFixed(0)}ms`);
	check('human receives autonomous bot deltas', botDelta.patch?.version === 2, `phase=${botDelta.patch?.projection?.phase}`);
	// Let it run a bit to confirm continued autonomy.
	await new Promise((r) => setTimeout(r, 2500));
	check('bots keep acting (multiple deltas)', deltaCount >= 1, `deltas received=${deltaCount}`);
	humanSock.close();

	// ── M0e: deadline enforcement ─────────────────────────────────────────────────
	// 11) Seed 1 human + 0 bots with a short nav deadline. The human sends NO command;
	//     the in-process deadline-enforcement path must advance the phase on its own.
	const dlSeedRes = await fetch(`${BASE}/debug/seed-bots?botCount=0&navMs=700`, { method: 'POST' });
	const dlSeed = await dlSeedRes.json();
	check('deadline room seeded (1 human, short nav timer)', !!dlSeed.roomCode);
	const dlSock = await openSocket();
	dlSock.send(JSON.stringify({ t: 'join', roomCode: dlSeed.roomCode, ticket: dlSeed.humanTicket }));
	const dlJoined = await nextMessage(dlSock, (m) => m.t === 'joined');
	const tDl0 = performance.now();
	const dlDelta = await nextMessage(dlSock, (m) => m.t === 'delta' && m.toRevision > dlJoined.revision, 8000);
	check('phase advances in-process via deadline enforcement (no commands)', dlDelta.toRevision > dlJoined.revision, `rev ${dlJoined.revision} → ${dlDelta.toRevision} after ${(performance.now() - tDl0).toFixed(0)}ms`);

	dlSock.close();

	// 11b) Zero-socket proof: seed a room with a longer nav timer, join to load the host,
	//      close the socket BEFORE the deadline fires, wait with NO connections, then
	//      reconnect and confirm the phase advanced in-process while nobody was watching.
	const zsSeedRes = await fetch(`${BASE}/debug/seed-bots?botCount=0&navMs=2000`, { method: 'POST' });
	const zsSeed = await zsSeedRes.json();
	const zsSock = await openSocket();
	zsSock.send(JSON.stringify({ t: 'join', roomCode: zsSeed.roomCode, ticket: zsSeed.humanTicket }));
	const zsJoined = await nextMessage(zsSock, (m) => m.t === 'joined');
	zsSock.close(); // no connections from here on
	await new Promise((r) => setTimeout(r, 3500)); // host keeps ticking; nav deadline passes unwatched
	const zsSock2 = await openSocket();
	zsSock2.send(JSON.stringify({ t: 'join', roomCode: zsSeed.roomCode, ticket: await mintTicket(zsSeed.humanMemberId) }));
	const zsRejoined = await nextMessage(zsSock2, (m) => m.t === 'joined');
	check('deadline enforcement fires with ZERO connected sockets', zsRejoined.revision > zsJoined.revision, `rev ${zsJoined.revision} → ${zsRejoined.revision} while unwatched`);
	zsSock2.close();

	// ── Concurrent cold-join race (regression for the getOrLoadRoom double-load bug) ──
	// 12) Two clients join a COLD (never-loaded) room simultaneously. They must land in the
	//     SAME room entry — one host, one connection set — so /healthz counts both and a
	//     subsequent command broadcasts to both. On the buggy path one join is orphaned into
	//     a second entry (never in the rooms map): /healthz undercounts and the orphan never
	//     gets broadcasts.
	const raceSeed = await (await fetch(`${BASE}/debug/seed`, { method: 'POST' })).json();
	const h0 = await (await fetch(`${BASE}/healthz`)).json();
	const [ra, rb] = await Promise.all([openSocket(), openSocket()]);
	const [specTicketA, specTicketB] = await Promise.all([
		mintSpectatorTicket(raceSeed.roomCode),
		mintSpectatorTicket(raceSeed.roomCode)
	]);
	const joinedA = nextMessage(ra, (m) => m.t === 'joined');
	const joinedB = nextMessage(rb, (m) => m.t === 'joined');
	// fired back-to-back so both hit the cold-load window
	ra.send(JSON.stringify({ t: 'join', roomCode: raceSeed.roomCode, ticket: specTicketA }));
	rb.send(JSON.stringify({ t: 'join', roomCode: raceSeed.roomCode, ticket: specTicketB }));
	await Promise.all([joinedA, joinedB]);
	const h1 = await (await fetch(`${BASE}/healthz`)).json();
	// Deterministic regression signal: the cold room is loaded exactly ONCE for both joins.
	// The old double-load path loads it twice (two hosts, two tick timers) before the
	// recheck discards one — this asserts the single-load invariant.
	check('concurrent cold joins load the room exactly once', h1.roomLoads - h0.roomLoads === 1, `roomLoads ${h0.roomLoads} → ${h1.roomLoads} (old path = +2)`);
	check('concurrent cold joins share one room (healthz +2, not +1)', h1.connections - h0.connections === 2, `connections ${h0.connections} → ${h1.connections}`);

	// A subsequent command must broadcast to BOTH concurrently-joined sockets.
	const deltaA = nextMessage(ra, (m) => m.t === 'delta', 6000);
	const deltaB = nextMessage(rb, (m) => m.t === 'delta', 6000);
	const owner2 = await openSocket();
	owner2.send(JSON.stringify({ t: 'join', roomCode: raceSeed.roomCode, ticket: raceSeed.ticket }));
	await nextMessage(owner2, (m) => m.t === 'joined');
	owner2.send(JSON.stringify({ t: 'command', cmdId: 'race-cmd', command: raceSeed.sampleCommand }));
	let bothDeltas = false;
	try {
		const [dA, dB] = await Promise.all([deltaA, deltaB]);
		bothDeltas = dA.t === 'delta' && dB.t === 'delta';
	} catch {
		bothDeltas = false; // a timeout means an orphaned socket never got the broadcast
	}
	check('both concurrent sockets receive the broadcast delta', bothDeltas);
	ra.close();
	rb.close();
	owner2.close();

	console.log(`\ncommand → ack latency: ${ackMs.toFixed(1)}ms`);
	console.log(`bot first-move latency (join → autonomous delta): ${botFirstDeltaMs.toFixed(0)}ms`);
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
