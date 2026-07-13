#!/usr/bin/env node
/** Export a live 2D room's authoritative command log and final state for exact replay. */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const [roomArg, outArg] = process.argv.slice(2);
const roomCode = (roomArg ?? '').trim().toUpperCase();
if (!/^[A-Z0-9]{6}$/.test(roomCode) || !outArg) {
	throw new Error('usage: node --env-file=.env scripts/export-play-replay.mjs <ROOM> <OUT_DIR>');
}
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const schema = process.env.PLAY_SCHEMA ?? 'arc_spirits_2d';
const client = createClient(url, key, {
	db: { schema },
	auth: { persistSession: false, autoRefreshToken: false }
});

const { data: session, error: sessionError } = await client
	.from('play_game_sessions')
	.select('id, room_code, game_id, status, revision, public_state, created_at, started_at, ended_at')
	.eq('room_code', roomCode)
	.maybeSingle();
if (sessionError) throw new Error(`session query failed: ${sessionError.message}`);
if (!session) throw new Error(`room ${roomCode} not found in schema ${schema}`);

const { data: events, error: eventsError } = await client
	.from('play_game_session_events')
	.select('revision, actor_member_id, command_type, command_payload, created_at')
	.eq('session_id', session.id)
	.order('revision', { ascending: true });
if (eventsError) throw new Error(`event query failed: ${eventsError.message}`);
if (!events?.length) throw new Error(`room ${roomCode} has no events`);

for (let index = 1; index < events.length; index += 1) {
	if (!(events[index].revision > events[index - 1].revision)) {
		throw new Error(`event revisions are not strictly increasing at index ${index}`);
	}
}
if (events.at(-1).revision !== session.revision) {
	throw new Error(
		`event/session revision mismatch: ${events.at(-1).revision} != ${session.revision}`
	);
}

const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const renderedEvents = `${JSON.stringify(events, null, 2)}\n`;
const renderedSnapshot = `${JSON.stringify({ state: session.public_state }, null, 2)}\n`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const manifest = {
	schemaVersion: 'arc-live-replay-export-v1',
	schema,
	roomCode,
	gameId: session.game_id,
	status: session.status,
	revision: session.revision,
	events: events.length,
	firstRevision: events[0].revision,
	lastRevision: events.at(-1).revision,
	eventsSha256: sha256(renderedEvents),
	snapshotSha256: sha256(renderedSnapshot),
	createdAt: session.created_at,
	startedAt: session.started_at,
	endedAt: session.ended_at,
	exportedAt: new Date().toISOString()
};
writeFileSync(resolve(outDir, 'events.json'), renderedEvents);
writeFileSync(resolve(outDir, 'snapshot.json'), renderedSnapshot);
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
	JSON.stringify({ roomCode, gameId: session.game_id, revision: session.revision, events: events.length })
);
