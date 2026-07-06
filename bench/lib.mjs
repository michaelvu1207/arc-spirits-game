// Shared helpers for the Arc Spirits transport benchmarks.
//
// Every bench script talks to the SAME public play HTTP API the web/Capacitor
// clients use. Headless Node has no cookie jar, so we authenticate exactly the
// way the Capacitor shell does: by echoing the member id the create/join call
// returns back in the `x-play-member` header (see src/lib/play/server/cookies.ts,
// getRoomMemberId → getRoomMemberHeader). The `/view` endpoint also accepts the
// id as a `?member=` query param.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, 'results');

export const MEMBER_HEADER = 'x-play-member';

export function parseArgs(argv = process.argv.slice(2)) {
	const args = { base: 'https://arcspirits.com' };
	for (const raw of argv) {
		const m = /^--([^=]+)=(.*)$/.exec(raw);
		if (m) args[m[1]] = m[2];
		else if (raw.startsWith('--')) args[raw.slice(2)] = true;
	}
	// Strip a trailing slash so `${base}/api/...` never doubles up.
	args.base = String(args.base).replace(/\/+$/, '');
	if (args.samples != null) args.samples = Number(args.samples);
	return args;
}

export function todayStamp() {
	return new Date().toISOString().slice(0, 10);
}

// ── stats ────────────────────────────────────────────────────────────────────

export function percentile(sortedAsc, p) {
	if (sortedAsc.length === 0) return null;
	if (sortedAsc.length === 1) return sortedAsc[0];
	const rank = (p / 100) * (sortedAsc.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sortedAsc[lo];
	return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

export function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
	return {
		samples: n,
		p50: round1(percentile(sorted, 50)),
		p95: round1(percentile(sorted, 95)),
		min: round1(sorted[0] ?? null),
		max: round1(sorted[n - 1] ?? null),
		mean: round1(n ? sorted.reduce((a, b) => a + b, 0) / n : null)
	};
}

// ── http ───────────────────────────────────────────────────────────────────

async function readBody(res) {
	const text = await res.text();
	try {
		return { text, json: JSON.parse(text) };
	} catch {
		return { text, json: null };
	}
}

/** POST/GET a play endpoint. Returns { ok, status, json, text, ms }. */
export async function apiCall(base, path, { method = 'GET', memberId, body } = {}) {
	const headers = {};
	if (memberId) headers[MEMBER_HEADER] = memberId;
	if (body !== undefined) headers['content-type'] = 'application/json';
	const t0 = performance.now();
	const res = await fetch(`${base}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const ms = performance.now() - t0;
	const { text, json } = await readBody(res);
	return { ok: res.ok, status: res.status, json, text, ms };
}

/** Like apiCall but throws with a legible message on a non-2xx. */
export async function apiCallOrThrow(base, path, opts = {}) {
	const r = await apiCall(base, path, opts);
	if (!r.ok) {
		throw new Error(`${opts.method ?? 'GET'} ${path} -> ${r.status}: ${r.text.slice(0, 300)}`);
	}
	return r;
}

// ── room lifecycle (the same calls e2e/helpers.ts + botSim make) ─────────────

/** Create a fresh lobby room. Returns { code, memberId, view }. */
export async function createRoom(base, displayName = 'Bench') {
	const r = await apiCallOrThrow(base, '/api/play/sessions', {
		method: 'POST',
		body: { displayName }
	});
	return { code: r.json.projection.roomCode, memberId: r.json.member.id, view: r.json };
}

export async function claimSeat(base, code, memberId, seatColor) {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/claim-seat`, {
			method: 'POST',
			memberId,
			body: { seatColor }
		})
	).json;
}

export async function sendCommand(base, code, memberId, command) {
	return apiCall(base, `/api/play/sessions/${code}/commands`, {
		method: 'POST',
		memberId,
		body: { command }
	});
}

export async function getView(base, code, memberId) {
	return apiCall(base, `/api/play/sessions/${code}/view`, { method: 'GET', memberId });
}

export async function fillBots(base, code, memberId, targetSeats = 4, difficulty = 'neural') {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/bots/fill`, {
			method: 'POST',
			memberId,
			body: { targetSeats, difficulty }
		})
	).json;
}

export async function startGame(base, code, memberId) {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/start`, {
			method: 'POST',
			memberId,
			body: {}
		})
	).json;
}

export async function tickBots(base, code, memberId) {
	return apiCall(base, `/api/play/sessions/${code}/bots/tick`, {
		method: 'POST',
		memberId,
		body: {}
	});
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── results ──────────────────────────────────────────────────────────────────

export function writeResults(name, payload) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const file = join(RESULTS_DIR, `${todayStamp()}-${name}.json`);
	writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
	return file;
}

/** Print a small aligned key/value table to stdout. */
export function printTable(title, rows) {
	const width = Math.max(...rows.map(([k]) => String(k).length), 6);
	console.log(`\n${title}`);
	console.log('─'.repeat(title.length));
	for (const [k, v] of rows) {
		console.log(`${String(k).padEnd(width)}  ${v}`);
	}
	console.log('');
}
