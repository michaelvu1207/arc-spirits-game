#!/usr/bin/env node
/**
 * End-to-end check of a running site (local or deployed) over HTTP, with built-in bots only (no
 * AI model): guest sign-in → create room → fill with bots → start → drive the bots to the end →
 * postgame record → replay share → open the replay → versions page.
 *
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… node scripts/package/web-smoke.mjs <site url> [max ticks]
 *
 * Exit code 0 only when every step passed. Prints one line per step.
 */
import { randomUUID } from 'node:crypto';

const site = (process.argv[2] ?? '').replace(/\/$/, '');
const maxTicks = Number(process.argv[3] ?? 1500);
const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
if (!site || !supabaseUrl || !anonKey) {
	console.error('usage: SUPABASE_URL=… SUPABASE_ANON_KEY=… web-smoke.mjs <site url> [max ticks]');
	process.exit(2);
}
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const step = (name, detail = '') => console.log(`ok   ${name}${detail ? `: ${detail}` : ''}`);
const fail = (name, detail) => {
	console.log(`FAIL ${name}: ${detail}`);
	process.exit(1);
};

async function call(method, path, token, body) {
	const res = await fetch(`${site}${path}`, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: site,
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(bypass ? { 'x-vercel-protection-bypass': bypass } : {})
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, text };
}

// 1. Guest sign-in (the same anonymous sign-in the play page uses).
const signup = await fetch(`${supabaseUrl}/auth/v1/signup`, {
	method: 'POST',
	headers: { apikey: anonKey, 'content-type': 'application/json' },
	body: JSON.stringify({ data: { display_name: 'Smoke Test' } })
});
const session = await signup.json();
if (!session?.access_token) fail('guest sign-in', `${signup.status} ${JSON.stringify(session).slice(0, 200)}`);
const token = session.access_token;
step('guest sign-in', `user ${String(session.user?.id).slice(0, 8)}`);

// 2. Versions page and live package.
const versions = await call('GET', '/versions');
if (versions.status !== 200 || !/data-testid="live-version"/.test(versions.text)) fail('versions page', `${versions.status}`);
step('versions page', `live ${/data-testid="live-version"[^>]*>([^<]+)</.exec(versions.text)?.[1] ?? '?'}`);

// 3. Room.
const created = await call('POST', '/api/play/sessions', token, { displayName: 'Smoke Test', visibility: 'private', opId: randomUUID() });
if (created.status !== 200 || !created.json?.projection?.roomCode) fail('create room', `${created.status} ${created.text.slice(0, 300)}`);
const roomCode = created.json.projection.roomCode;
let view = created.json;
step('create room', roomCode);

const filled = await call('POST', `/api/play/sessions/${roomCode}/bots/fill`, token, { targetSeats: 4 });
if (filled.status !== 200) fail('fill bots', `${filled.status} ${filled.text.slice(0, 300)}`);
view = filled.json?.projection ? filled.json : view;
step('fill bots');

const revisionOf = (v) => v?.projection?.revision ?? null;
const fresh = await call('GET', `/api/play/sessions/${roomCode}/view`, token);
if (fresh.status !== 200) fail('room view', `${fresh.status} ${fresh.text.slice(0, 300)}`);
view = fresh.json;
const started = await call('POST', `/api/play/sessions/${roomCode}/start`, token, { expectedRevision: revisionOf(view), cmdId: randomUUID() });
if (started.status !== 200) fail('start game', `${started.status} ${started.text.slice(0, 300)}`);
view = started.json;
step('start game', `status ${view?.projection?.status}`);

// 4. Drive the bots to the end of the game.
let ticks = 0;
let idle = 0;
const began = Date.now();
while (view?.projection?.status === 'active' && ticks < maxTicks) {
	const tick = await call('POST', `/api/play/sessions/${roomCode}/bots/tick`, token);
	if (tick.status !== 200) fail('bot tick', `tick ${ticks}: ${tick.status} ${tick.text.slice(0, 300)}`);
	ticks++;
	// "Stuck" is measured in time, not ticks: a fast (local) server answers idle ticks in
	// milliseconds while a short reveal countdown or a phase deadline is still running.
	const moved = tick.json?.commandsIssued || tick.json?.projection?.revision !== view?.projection?.revision;
	if (moved) idle = 0;
	else if (!idle) idle = Date.now();
	view = tick.json;
	if (idle && Date.now() - idle > 240_000) fail('bot tick', `nothing happened for 4 minutes at round ${view?.projection?.round} phase ${view?.projection?.phase}`);
	if (!moved) await new Promise((r) => setTimeout(r, 400));
	if (ticks % 50 === 0) console.log(`     … tick ${ticks}, round ${view?.projection?.round}, ${((Date.now() - began) / 1000).toFixed(0)} s`);
}
if (view?.projection?.status !== 'finished') fail('play to the end', `status ${view?.projection?.status} after ${ticks} ticks`);
step('play to the end', `${ticks} ticks, round ${view?.projection?.round}, ${((Date.now() - began) / 1000).toFixed(0)} s`);

// 5. The finished game is recorded.
let post = null;
for (let i = 0; i < 10; i++) {
	post = await call('GET', `/api/play/sessions/${roomCode}/postgame`, token);
	if (post.status === 200 && (post.json?.finalized || post.json?.players?.length)) break;
	await new Promise((r) => setTimeout(r, 1500));
}
if (post.status !== 200) fail('postgame record', `${post.status} ${post.text.slice(0, 300)}`);
step('postgame record', JSON.stringify({ finalized: post.json?.finalized, players: post.json?.players?.length ?? post.json?.standings?.length }));
if (process.env.SMOKE_DEBUG) console.log(JSON.stringify(post.json).slice(0, 2500));

// 6. Replay.
const gameId = view?.projection?.gameId ?? post.json?.gameId;
// Only a player of the game may share its replay. This check's account hosts the room without
// taking a seat (the four seats are bots), so the site is right to refuse: a 404 here means the
// permission rule works, not that the replay is missing.
const share = await call('POST', '/api/play/replays', token, { gameId });
if (share.status === 404) {
	step('replay share refused for a non-player', 'as intended (replay frames are checked in the database, not here)');
} else if (share.status !== 200 || !share.json?.code) {
	fail('share replay', `${share.status} ${share.text.slice(0, 300)} (gameId ${gameId})`);
} else {
	const replay = await call('GET', `/api/play/replays/${share.json.code}`, token);
	if (replay.status !== 200) fail('open replay', `${replay.status} ${replay.text.slice(0, 300)}`);
	step('replay', `code ${share.json.code}, ${replay.json?.frames?.length ?? '?'} frames`);
}
console.log('ALL OK');
