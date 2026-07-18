// Shared helpers for the Arc Spirits transport benchmarks.
//
// Every bench script talks to the SAME public play HTTP API the web/Capacitor
// clients use. Headless Node has no cookie jar, so we authenticate exactly the
// way the Capacitor shell does: a VALIDATED Supabase identity (an anonymous
// account created on the spot) carried as an `Authorization: Bearer` token. The
// public member id never authorizes, there are no room credentials, and nothing
// ever rides a URL.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, 'results');


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
export async function apiCall(base, path, { method = 'GET', token, body } = {}) {
	const headers = {};
	if (token) headers['authorization'] = `Bearer ${token}`;
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

// ── identity + room lifecycle (the same calls e2e/helpers.ts + botSim make) ───

/**
 * Create a fresh VALIDATED anonymous identity against the store the dev server
 * advertises (`/api/play/config`), exactly like the web client's one-tap guest
 * flow. Returns the Bearer access token that authorizes every play call.
 */
export async function createIdentity(base, displayName = 'Bench') {
	const cfg = await apiCallOrThrow(base, '/api/play/config');
	const { supabaseUrl, supabaseAnonKey } = cfg.json;
	const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', apikey: supabaseAnonKey },
		body: JSON.stringify({ data: { display_name: displayName } })
	});
	const body = await res.json();
	if (!res.ok || !body.access_token) {
		throw new Error(`anonymous signup failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
	}
	return body.access_token;
}

/** Create a fresh lobby room under a fresh anonymous identity.
 *  Returns { code, token, view }. */
export async function createRoom(base, displayName = 'Bench') {
	const token = await createIdentity(base, displayName);
	const r = await apiCallOrThrow(base, '/api/play/sessions', {
		method: 'POST',
		token,
		body: { displayName }
	});
	return { code: r.json.projection.roomCode, token, view: r.json };
}

/** Mint a ONE-USE WebSocket join ticket for a room (the authenticated endpoint). */
export async function mintWsTicket(base, code, token) {
	const r = await apiCallOrThrow(base, `/api/play/sessions/${code}/ws-ticket`, {
		method: 'POST',
		token,
		body: {}
	});
	return r.json.ticket;
}

// The player-facing mutation routes require a client idempotency key (cmdId) —
// the durable exactly-once identity every real client (web/Godot) sends.
let benchCmdSeq = 0;
export function nextCmdId() {
	benchCmdSeq += 1;
	return `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${benchCmdSeq}`;
}

export async function claimSeat(base, code, token, seatColor) {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/claim-seat`, {
			method: 'POST',
			token,
			body: { seatColor, cmdId: nextCmdId() }
		})
	).json;
}

export async function sendCommand(base, code, token, command) {
	return apiCall(base, `/api/play/sessions/${code}/commands`, {
		method: 'POST',
		token,
		body: { command, cmdId: nextCmdId() }
	});
}

export async function getView(base, code, token) {
	return apiCall(base, `/api/play/sessions/${code}/view`, { method: 'GET', token });
}

export async function fillBots(base, code, token, targetSeats = 4, difficulty = 'neural') {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/bots/fill`, {
			method: 'POST',
			token,
			body: { targetSeats, difficulty }
		})
	).json;
}

export async function startGame(base, code, token) {
	return (
		await apiCallOrThrow(base, `/api/play/sessions/${code}/start`, {
			method: 'POST',
			token,
			body: { cmdId: nextCmdId() }
		})
	).json;
}

export async function tickBots(base, code, token) {
	return apiCall(base, `/api/play/sessions/${code}/bots/tick`, {
		method: 'POST',
		token,
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
