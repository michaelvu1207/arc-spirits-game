/**
 * Live authority & recovery smoke — the real-wire companion to
 * server/roomHostAuthority.test.ts. Boots REAL room-server instances (child
 * processes, real WebSocket wire, real supabase-js REST) and proves:
 *
 *   1. MEASURED command→durable-ack and command→spectator-delta latency
 *      (p50/p95 over N commands) — an ack now means "committed under the revision
 *      CAS", so this measures the true durability cost, not an in-memory echo;
 *   2. the ack is durable: the store row is at/past the acked revision, and a
 *      SIGKILL + fresh instance recovers to ≥ every acked revision;
 *   3. duplicate cmdId (same socket, and across a restart) answers the ORIGINAL
 *      revision without re-applying — including pre-migration (jsonb-path dedup);
 *   4. TWO live instances serving the same room interleave commands on one
 *      monotone history (no fork) and serve the same (revision, stateHash);
 *   5. projections carry stateHash and it matches the durable row.
 *
 * STORE: by default this runs against a LOCAL PostgREST emulator
 * (server/pgrestEmu.ts) in BOTH commit modes — pre-migration CAS fallback and the
 * 20260710 atomic RPC — so the whole proof needs no network. The emulator lives in
 * THIS process, so a SIGKILLed server instance genuinely loses its memory while
 * the store survives. Pass `--live` to run one pass against the real Supabase in
 * .env instead (the main tester's configuration).
 *
 * Run: npx tsx server/authoritySmoke.ts [--live]
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { loadEnv } from './env';
import { PgrestEmu } from './pgrestEmu';
import { hashGameState } from '../src/lib/play/stateHash';
import type { PublicGameState } from '../src/lib/play/types';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const USE_LIVE = process.argv.includes('--live');
const EMU_PORT = 8090 + Math.floor(Math.random() * 200);

const results: { name: string; ok: boolean }[] = [];
const children: ChildProcess[] = [];

function check(name: string, cond: boolean, detail = ''): void {
	results.push({ name, ok: cond });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!cond) process.exitCode = 1;
}

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function nextMessage(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 8000): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off('message', onMsg);
			reject(new Error('timeout waiting for message'));
		}, timeoutMs);
		function onMsg(data: unknown) {
			let msg: any;
			try {
				msg = JSON.parse(String(data));
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

function openSocket(wsUrl: string): Promise<WebSocket> {
	const ws = new WebSocket(wsUrl);
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws));
		ws.once('error', reject);
	});
}

async function bootServer(port: number): Promise<{ child: ChildProcess; log: () => string }> {
	const child = spawn('npx', ['tsx', join(HERE, 'index.ts')], {
		cwd: join(HERE, '..'),
		env: {
			...process.env,
			PORT: String(port),
			ARC_WS_ALLOW_DEBUG_SEED: '1',
			ARC_WS_BOT_TICK_MS: '400'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	children.push(child);
	let log = '';
	child.stdout?.on('data', (d) => (log += d));
	child.stderr?.on('data', (d) => (log += d));
	for (let i = 0; i < 80; i += 1) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (res.ok) return { child, log: () => log };
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	console.error(log);
	throw new Error(`server on :${port} did not become healthy`);
}

/** Read the durable head straight off the store (same REST the servers use). */
async function dbHead(roomCode: string): Promise<{ revision: number; hash: string }> {
	const base = process.env.PUBLIC_SUPABASE_URL!;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
	const res = await fetch(
		`${base}/rest/v1/play_game_sessions?room_code=eq.${encodeURIComponent(roomCode)}&select=*`,
		{ headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'arc_spirits_2d' } }
	);
	const rows = (await res.json()) as { revision: number; public_state: PublicGameState | string }[];
	if (!rows.length) throw new Error('room row vanished');
	const state = (typeof rows[0].public_state === 'string'
		? JSON.parse(rows[0].public_state)
		: rows[0].public_state) as PublicGameState;
	return { revision: rows[0].revision, hash: hashGameState(state) };
}

const VP_CMD = { type: 'adjustVictoryPoints', amount: 1 };

/** Mint a fresh ONE-USE member ticket via the dev-only debug endpoint (the smoke's
 *  stand-in for the authenticated SvelteKit mint). */
async function mintTicket(basePort: number, memberId: string): Promise<string> {
	const res = await fetch(
		`http://127.0.0.1:${basePort}/debug/ticket?memberId=${encodeURIComponent(memberId)}`,
		{ method: 'POST' }
	);
	const body = (await res.json()) as { ticket?: string; error?: string };
	if (!body.ticket) throw new Error(`ticket mint failed: ${body.error ?? res.status}`);
	return body.ticket;
}

async function mintSpectatorTicket(basePort: number, roomCode: string): Promise<string> {
	const res = await fetch(
		`http://127.0.0.1:${basePort}/debug/spectator-ticket?roomCode=${encodeURIComponent(roomCode)}`,
		{ method: 'POST' }
	);
	const body = (await res.json()) as { ticket?: string; error?: string };
	if (!body.ticket) throw new Error(`spectator ticket mint failed: ${body.error ?? res.status}`);
	return body.ticket;
}

async function joinAsOwner(wsUrl: string, roomCode: string, ticket: string) {
	const ws = await openSocket(`${wsUrl}/ws`);
	ws.send(JSON.stringify({ t: 'join', roomCode, ticket }));
	const joined = await nextMessage(ws, (m) => m.t === 'joined');
	return { ws, joined };
}

async function sendCmd(ws: WebSocket, cmdId: string, command: unknown) {
	const startedAt = performance.now();
	ws.send(JSON.stringify({ t: 'command', cmdId, command }));
	const ack = await nextMessage(ws, (m) => m.t === 'ack' && m.cmdId === cmdId, 20000);
	return { ack, ms: performance.now() - startedAt };
}

async function runSuite(label: string, basePort: number): Promise<void> {
	console.log(`\n══ ${label} ══`);
	const t = (name: string) => `[${label}] ${name}`;

	const serverA = await bootServer(basePort);
	const seed = (await (
		await fetch(`http://127.0.0.1:${basePort}/debug/seed`, { method: 'POST' })
	).json()) as { roomCode: string; memberId: string; ticket: string; seat: string; error?: string };
	if (!seed.roomCode) {
		console.error(serverA.log());
		throw new Error(`seed failed: ${JSON.stringify(seed)}`);
	}
	check(t('room seeded on instance A'), true, `room=${seed.roomCode} seat=${seed.seat}`);

	const wsA = `ws://127.0.0.1:${basePort}`;
	const { ws: owner, joined } = await joinAsOwner(wsA, seed.roomCode, seed.ticket);
	check(
		t('joined view carries stateHash'),
		typeof joined.view?.projection?.stateHash === 'string',
		`hash=${joined.view?.projection?.stateHash}`
	);
	check(
		t('joined view carries truthful room metadata (mode/visibility/rated)'),
		joined.view?.projection?.mode === 'casual' &&
			joined.view?.projection?.visibility === 'public' &&
			joined.view?.projection?.rated === false,
		`mode=${joined.view?.projection?.mode} visibility=${joined.view?.projection?.visibility}`
	);

	// ── ticket boundary adversarial checks ───────────────────────────────────────
	{
		// Replaying the CONSUMED seed ticket must fail fatally (one-use).
		const replay = await openSocket(`${wsA}/ws`);
		replay.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, ticket: seed.ticket }));
		const replayErr = await nextMessage(replay, (m) => m.t === 'error');
		check(
			t('replaying a consumed ticket fails fatally (never a spectator downgrade)'),
			replayErr.fatal === true && replayErr.code === 'bad_ticket',
			`code=${replayErr.code}`
		);
		replay.terminate();

		// A public member UUID (the old vulnerability) is not a ticket and must fail.
		const forged = await openSocket(`${wsA}/ws`);
		forged.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode, ticket: seed.memberId }));
		const forgedErr = await nextMessage(forged, (m) => m.t === 'error');
		check(
			t('a public member UUID never authorizes a join'),
			forgedErr.fatal === true && forgedErr.code === 'bad_ticket',
			`code=${forgedErr.code}`
		);
		forged.terminate();

		// A ticketless join must fail (origin-less clients still need tickets).
		const bare = await openSocket(`${wsA}/ws`);
		bare.send(JSON.stringify({ t: 'join', roomCode: seed.roomCode }));
		const bareErr = await nextMessage(bare, (m) => m.t === 'error');
		check(
			t('a join without a ticket is refused'),
			bareErr.fatal === true,
			`code=${bareErr.code}`
		);
		bare.terminate();
	}

	const spectator = await openSocket(`${wsA}/ws`);
	spectator.send(
		JSON.stringify({
			t: 'join',
			roomCode: seed.roomCode,
			ticket: await mintSpectatorTicket(basePort, seed.roomCode)
		})
	);
	await nextMessage(spectator, (m) => m.t === 'joined');

	// Spectator tickets can never command.
	{
		spectator.send(JSON.stringify({ t: 'command', cmdId: 'spec-1', command: VP_CMD }));
		const specAck = await nextMessage(spectator, (m) => m.t === 'ack' && m.cmdId === 'spec-1');
		check(
			t('spectator ticket cannot command'),
			specAck.ok === false && specAck.error?.code === 'not_a_member',
			`code=${specAck.error?.code}`
		);
	}

	// ── measured latency: command→ack (durable) and command→spectator delta ─────
	const ackSamples: number[] = [];
	const deltaSamples: number[] = [];
	const ackByCmd = new Map<string, number>();
	const N = 15;
	for (let i = 0; i < N; i += 1) {
		const cmdId = `lat-${i}`;
		const deltaPromise = nextMessage(spectator, (m) => m.t === 'delta', 20000);
		const startedAt = performance.now();
		const { ack, ms } = await sendCmd(owner, cmdId, VP_CMD);
		if (!ack.ok) throw new Error(`command ${cmdId} rejected: ${JSON.stringify(ack.error)}`);
		ackSamples.push(ms);
		ackByCmd.set(cmdId, ack.revision);
		await deltaPromise;
		deltaSamples.push(performance.now() - startedAt);
	}
	ackSamples.sort((a, b) => a - b);
	deltaSamples.sort((a, b) => a - b);
	const ackP50 = percentile(ackSamples, 50);
	const ackP95 = percentile(ackSamples, 95);
	const deltaP50 = percentile(deltaSamples, 50);
	const deltaP95 = percentile(deltaSamples, 95);
	check(t('command→durable-ack measured'), ackSamples.length === N, `p50=${ackP50.toFixed(1)}ms p95=${ackP95.toFixed(1)}ms (n=${N})`);
	check(t('command→spectator-delta measured'), deltaSamples.length === N, `p50=${deltaP50.toFixed(1)}ms p95=${deltaP95.toFixed(1)}ms (n=${N})`);

	// ── the ack means durable: the row is at/past the last acked revision ───────
	const lastAcked = ackByCmd.get(`lat-${N - 1}`)!;
	let head = await dbHead(seed.roomCode);
	check(t('store row is at/past every acked revision (ack ⇒ durable)'), head.revision >= lastAcked, `db=${head.revision} acked=${lastAcked}`);

	// ── duplicate cmdId on the live wire: coherent CURRENT view + duplicate-of ──
	const headBeforeDup = await dbHead(seed.roomCode);
	const dup = await sendCmd(owner, 'lat-5', VP_CMD);
	check(
		t('duplicate ack pairs the CURRENT revision with its view (never a mismatched pair)'),
		dup.ack.ok === true &&
			dup.ack.revision === headBeforeDup.revision &&
			dup.ack.view.projection.revision === dup.ack.revision,
		`ack.rev=${dup.ack.revision} view.rev=${dup.ack.view?.projection?.revision} head=${headBeforeDup.revision}`
	);
	check(
		t('duplicate ack carries duplicateOfRevision = the ORIGINAL commit'),
		dup.ack.duplicateOfRevision === ackByCmd.get('lat-5'),
		`duplicateOf=${dup.ack.duplicateOfRevision} original=${ackByCmd.get('lat-5')}`
	);
	head = await dbHead(seed.roomCode);
	check(t('duplicate cmdId applied nothing'), head.revision === headBeforeDup.revision, `db stayed at ${head.revision}`);

	// ── identity-bound idempotency: same cmdId, DIFFERENT command → conflict ────
	const conflict = await sendCmd(owner, 'lat-5', { type: 'adjustVictoryPoints', amount: 99 });
	check(
		t('same cmdId with a different payload rejects as idempotency_conflict'),
		conflict.ack.ok === false && conflict.ack.error?.code === 'idempotency_conflict',
		`code=${conflict.ack.error?.code}`
	);
	head = await dbHead(seed.roomCode);
	check(t('the conflicting re-use applied nothing'), head.revision === headBeforeDup.revision, `db stayed at ${head.revision}`);

	// ── two live instances, one history ─────────────────────────────────────────
	await bootServer(basePort + 1);
	const { ws: ownerB } = await joinAsOwner(
		`ws://127.0.0.1:${basePort + 1}`,
		seed.roomCode,
		await mintTicket(basePort + 1, seed.memberId)
	);

	const interleaved: number[] = [];
	for (let i = 0; i < 4; i += 1) {
		const viaA = await sendCmd(owner, `ab-a-${i}`, VP_CMD);
		const viaB = await sendCmd(ownerB, `ab-b-${i}`, VP_CMD);
		if (!viaA.ack.ok || !viaB.ack.ok) {
			throw new Error(
				`interleaved command rejected: A=${JSON.stringify(viaA.ack)} B=${JSON.stringify(viaB.ack)}`
			);
		}
		interleaved.push(viaA.ack.revision, viaB.ack.revision);
	}
	const monotone = interleaved.every((rev, i) => i === 0 || rev > interleaved[i - 1]);
	check(t('two instances interleave on ONE monotone history (no fork)'), monotone && new Set(interleaved).size === 8, `revisions=${interleaved.join(',')}`);
	head = await dbHead(seed.roomCode);
	check(t('durable head equals the last interleaved ack'), head.revision === interleaved[interleaved.length - 1], `db=${head.revision}`);

	// Both instances serve the same (revision, stateHash) after convergence.
	owner.send(JSON.stringify({ t: 'resync' }));
	const viewA = await nextMessage(owner, (m) => m.t === 'delta');
	ownerB.send(JSON.stringify({ t: 'resync' }));
	const viewB = await nextMessage(ownerB, (m) => m.t === 'delta', 20000);
	check(
		t('mixed clients on different instances see same revision + stateHash'),
		viewA.toRevision === viewB.toRevision &&
			viewA.patch.projection.stateHash === viewB.patch.projection.stateHash &&
			viewA.patch.projection.stateHash === head.hash,
		`rev=${viewA.toRevision}/${viewB.toRevision} hash=${viewA.patch.projection.stateHash}`
	);

	// ── SIGKILL after ack: nothing acked is ever rolled back ────────────────────
	const preKill = await sendCmd(owner, 'pre-kill', VP_CMD);
	if (!preKill.ack.ok) throw new Error('pre-kill command rejected');
	serverA.child.kill('SIGKILL'); // no flush, no graceful path
	owner.terminate();
	spectator.terminate();

	await bootServer(basePort + 2);
	const { ws: ownerA2, joined: rejoined } = await joinAsOwner(
		`ws://127.0.0.1:${basePort + 2}`,
		seed.roomCode,
		await mintTicket(basePort + 2, seed.memberId)
	);
	check(t('restart after SIGKILL recovers ≥ the acked revision (no rollback)'), rejoined.revision >= preKill.ack.revision, `rejoined=${rejoined.revision} acked=${preKill.ack.revision}`);
	head = await dbHead(seed.roomCode);
	check(t('recovered view matches the durable truth (revision + stateHash)'), rejoined.revision === head.revision && rejoined.view.projection.stateHash === head.hash, `rev=${rejoined.revision} hash=${rejoined.view.projection.stateHash}`);

	// ── duplicate across the restart: the ledger survives the process ───────────
	const dupAfterRestart = await sendCmd(ownerA2, 'pre-kill', VP_CMD);
	check(
		t('duplicate across restart answers the CURRENT head + duplicateOfRevision (coherent view)'),
		dupAfterRestart.ack.ok === true &&
			dupAfterRestart.ack.revision === head.revision &&
			dupAfterRestart.ack.view.projection.revision === dupAfterRestart.ack.revision &&
			dupAfterRestart.ack.duplicateOfRevision === preKill.ack.revision,
		`ack.rev=${dupAfterRestart.ack.revision} duplicateOf=${dupAfterRestart.ack.duplicateOfRevision} original=${preKill.ack.revision}`
	);
	const headAfter = await dbHead(seed.roomCode);
	check(t('duplicate across restart applied nothing'), headAfter.revision === head.revision, `db stayed at ${headAfter.revision}`);

	ownerA2.close();
	ownerB.close();

	console.log(`\n── measured latency [${label}] ──`);
	console.log(`command → durable ack:      p50=${ackP50.toFixed(1)}ms  p95=${ackP95.toFixed(1)}ms  (n=${N})`);
	console.log(`command → spectator delta:  p50=${deltaP50.toFixed(1)}ms  p95=${deltaP95.toFixed(1)}ms  (n=${N})`);

	// Stop this pass's servers before the next pass reuses the store port.
	for (const child of children.splice(0)) {
		try {
			child.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	}
	await new Promise((r) => setTimeout(r, 400));
}

/** Fail-closed readiness: a server on a PRE-migration store with NO opt-in must
 *  reject commands with `store_not_ready` and write nothing — never degrade to the
 *  non-atomic fallback silently. */
async function runFailClosedCheck(basePort: number): Promise<void> {
	console.log(`\n══ fail-closed readiness (pre-migration store, no opt-in) ══`);
	delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;
	const server = await bootServer(basePort);
	const seed = (await (
		await fetch(`http://127.0.0.1:${basePort}/debug/seed`, { method: 'POST' })
	).json()) as { roomCode: string; memberId: string; ticket: string };
	const { ws: owner } = await joinAsOwner(`ws://127.0.0.1:${basePort}`, seed.roomCode, seed.ticket);
	const headBefore = await dbHead(seed.roomCode);
	const { ack } = await sendCmd(owner, 'nr-1', VP_CMD);
	check(
		'[fail-closed] command rejected with store_not_ready (no silent fallback)',
		ack.ok === false && ack.error?.code === 'store_not_ready',
		`code=${ack.error?.code}`
	);
	const headNow = await dbHead(seed.roomCode);
	check('[fail-closed] nothing was written or acknowledged', headNow.revision === headBefore.revision, `db stayed at ${headNow.revision}`);
	owner.terminate();
	server.child.kill('SIGTERM');
	children.splice(children.indexOf(server.child), 1);
	await new Promise((r) => setTimeout(r, 300));
}

/** Store-layer strict monotonicity, on the real wire (emulator RPC + PATCH trigger):
 *  an equal-revision rewrite with changed state must be refused by the store itself. */
async function runMonotonicStoreCheck(): Promise<void> {
	console.log(`\n══ store-layer strict monotonicity (equal-revision rewrite) ══`);
	const base = process.env.PUBLIC_SUPABASE_URL!;
	const headers = {
		apikey: 'k',
		authorization: 'Bearer k',
		'content-type': 'application/json',
		'content-profile': 'arc_spirits_2d',
		'accept-profile': 'arc_spirits_2d'
	};
	// Seed a bare session row directly.
	await fetch(`${base}/rest/v1/play_game_sessions`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ id: 'mono-1', room_code: 'MONO01', status: 'active', revision: 5, public_state: { revision: 5, roomCode: 'MONO01' } })
	});
	// RPC: current=expected=next with changed state → refused by the RPC guard.
	const rpcRes = await fetch(`${base}/rest/v1/rpc/commit_room_command`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			p_session_id: 'mono-1',
			p_expected_revision: 5,
			p_next_revision: 5,
			p_status: 'active',
			p_game_id: null,
			p_scenario: null,
			p_public_state: { revision: 5, roomCode: 'EVIL01' },
			p_stamp_started_at: false,
			p_stamp_ended_at: false,
			p_events: []
		})
	});
	const rpcBody = (await rpcRes.json()) as { message?: string };
	check(
		'[monotonic] RPC refuses current=expected=next with changed state',
		rpcRes.status === 400 && /revision_not_monotonic/.test(rpcBody.message ?? ''),
		`status=${rpcRes.status}`
	);
	// Raw PATCH (bypassing the RPC): the trigger emulation refuses too.
	const patchRes = await fetch(`${base}/rest/v1/play_game_sessions?id=eq.mono-1`, {
		method: 'PATCH',
		headers,
		body: JSON.stringify({ revision: 5, public_state: { revision: 5, roomCode: 'EVIL01' } })
	});
	const patchBody = (await patchRes.json().catch(() => ({}))) as { message?: string };
	check(
		'[monotonic] raw same-revision state rewrite refused by the store trigger',
		patchRes.status === 400 && /revision_not_monotonic/.test(patchBody.message ?? ''),
		`status=${patchRes.status}`
	);
	const readBack = await fetch(`${base}/rest/v1/play_game_sessions?id=eq.mono-1&select=*`, { headers });
	const rows = (await readBack.json()) as { revision: number; public_state: { roomCode: string } }[];
	check(
		'[monotonic] state unchanged after both refused writes',
		rows[0]?.revision === 5 && rows[0]?.public_state?.roomCode === 'MONO01',
		`rev=${rows[0]?.revision} room=${rows[0]?.public_state?.roomCode}`
	);
}

async function main() {
	if (USE_LIVE) {
		process.env.ARC_ALLOW_NONATOMIC_COMMIT ??= '1'; // pre-migration live stores are a deliberate test
		await runSuite('live Supabase (.env)', 8300 + Math.floor(Math.random() * 200));
		return;
	}

	// Local store: point every child (and our dbHead reads) at the emulator.
	process.env.PUBLIC_SUPABASE_URL = `http://127.0.0.1:${EMU_PORT}`;
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-emulator-service-role';
	process.env.PUBLIC_SUPABASE_ANON_KEY = 'local-emulator-anon';
	process.env.ARC_WS_CATALOG_FILE = join(HERE, '..', 'ml', 'catalog.json');

	const fallbackEmu = new PgrestEmu({ rpc: false });
	await fallbackEmu.listen(EMU_PORT);
	// Readiness first: with NO opt-in the pre-migration store must fail closed.
	await runFailClosedCheck(8380 + Math.floor(Math.random() * 20));
	// Then the pre-migration suite under the EXPLICIT opt-in (migration testing mode).
	process.env.ARC_ALLOW_NONATOMIC_COMMIT = '1';
	await runSuite('local store, pre-migration CAS fallback (opted in)', 8400 + Math.floor(Math.random() * 100));
	fallbackEmu.close();
	delete process.env.ARC_ALLOW_NONATOMIC_COMMIT;

	const rpcEmu = new PgrestEmu({ rpc: true });
	await rpcEmu.listen(EMU_PORT);
	await runSuite('local store, 20260710 atomic RPC', 8600 + Math.floor(Math.random() * 100));
	await runMonotonicStoreCheck();
	rpcEmu.close();
}

main()
	.catch((err) => {
		console.error('AUTHORITY SMOKE ERROR:', err);
		process.exitCode = 1;
	})
	.finally(() => {
		for (const child of children) {
			try {
				child.kill('SIGTERM');
			} catch {
				/* already gone */
			}
		}
		const passed = results.filter((r) => r.ok).length;
		console.log(`\n${passed}/${results.length} checks passed`);
		setTimeout(() => process.exit(process.exitCode ?? 0), 500);
	});
