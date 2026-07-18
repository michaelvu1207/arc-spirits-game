/**
 * HONEST BOT RESERVATION — matchmaking's active-session bot exclusion, proven on
 * the REAL PostgREST wire dialect (server/pgrestEmu.ts over HTTP via supabase-js),
 * not a hand-written fake:
 *
 *   - The old exclusion used a PostgREST EMBEDDED-RELATION filter
 *     (`play_game_sessions!inner(status)`), which the emulator silently matched to
 *     ZERO rows — so back-to-back runs against one store re-seated the exact bots
 *     still active in the previous run's room. The exclusion is now two PLAIN
 *     queries that behave identically on both stores, and the emulator REJECTS
 *     embedded-relation syntax loudly (regression below) instead of lying.
 *   - Active room A owns bots → queueing human B forms room B whose bot ids are
 *     DISJOINT from every active room's, drawn from fresh eligible seeds.
 *   - Bots in CLOSED/finished rooms become reusable again.
 *
 * The bot pool is seeded at exactly 2 × the per-room need, so disjointness is
 * LOAD-BEARING: were the exclusion a no-op (the old emulator behavior), room B
 * would happily reuse room A's seated bots and the assertions would catch it.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PgrestEmu } from '../../../../server/pgrestEmu';

const PLAY_SCHEMA = 'arc_spirits_2d';
const PORT = 18700 + Math.floor(Math.random() * 200);
const URL_BASE = `http://127.0.0.1:${PORT}`;

const holder = vi.hoisted(() => ({
	admin: null as unknown,
	createRankedSession: null as unknown
}));

vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: () => holder.admin
}));
vi.mock('./service', () => ({
	createRankedSession: (...args: unknown[]) =>
		(holder.createRankedSession as (...a: unknown[]) => unknown)(...args)
}));

import { enqueueAndPoll } from './matchmaking';
import type { RankedPlayer } from './service';

let emu: PgrestEmu;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let admin: SupabaseClient<any, any, any, any, any>;
let roomSeq = 0;

/** The formation seam: creates a STARTED session + membership rows in the store —
 *  the exact rows the seated-bot exclusion must reserve against. */
async function fakeCreateRankedSession(players: RankedPlayer[]) {
	roomSeq += 1;
	const roomCode = `ROOM0${roomSeq}`;
	const sessionId = `sess-${roomSeq}`;
	const ins = await admin.from('play_game_sessions').insert({
		id: sessionId,
		room_code: roomCode,
		status: 'active',
		mode: 'casual',
		visibility: 'private',
		revision: 1,
		public_state: { status: 'active', revision: 1 }
	});
	if (ins.error) throw new Error(ins.error.message);
	for (const [i, player] of players.entries()) {
		const mem = await admin.from('play_session_members').insert({
			id: `m-${sessionId}-${i}`,
			session_id: sessionId,
			user_id: player.userId,
			display_name: player.displayName,
			is_bot: player.isBot === true,
			bot_profile: player.botProfile ?? null,
			role: i === 0 ? 'host' : 'player'
		});
		if (mem.error) throw new Error(mem.error.message);
	}
	return { roomCode, sessionId };
}

async function seatedBots(sessionId: string): Promise<string[]> {
	const res = await admin
		.from('play_session_members')
		.select('user_id')
		.eq('session_id', sessionId)
		.eq('is_bot', true);
	if (res.error) throw new Error(res.error.message);
	return ((res.data as { user_id: string }[]) ?? []).map((r) => r.user_id).sort();
}

/** Poll until this human's search resolves a matched room (bots ramp ~1/poll). */
async function pollUntilMatched(userId: string, name: string): Promise<string> {
	for (let i = 0; i < 12; i += 1) {
		const poll = await enqueueAndPoll(userId, name, false);
		if (poll.status === 'matched' && poll.roomCode) return poll.roomCode;
	}
	throw new Error(`${userId} never matched within 12 polls`);
}

async function sessionIdOf(roomCode: string): Promise<string> {
	const res = await admin
		.from('play_game_sessions')
		.select('id')
		.eq('room_code', roomCode)
		.maybeSingle();
	if (res.error || !res.data) throw new Error(`no session for ${roomCode}`);
	return (res.data as { id: string }).id;
}

beforeAll(async () => {
	emu = new PgrestEmu({ rpc: true });
	await emu.listen(PORT);
	admin = createClient(URL_BASE, 'local-emu', {
		db: { schema: PLAY_SCHEMA },
		auth: { persistSession: false, autoRefreshToken: false }
	});
	holder.admin = admin;
	holder.createRankedSession = fakeCreateRankedSession;

	// EXACTLY 6 eligible bots = two disjoint rooms' worth (lobby of 4 = 1 human +
	// 3 bots). If the seated-bot exclusion silently returned nothing (the old
	// embedded-filter behavior on the emulator), room B would reuse room A's bots
	// and the disjointness assertion below would fail.
	for (let i = 1; i <= 6; i += 1) {
		const ins = await admin.from('player_ratings').insert({
			user_id: `bot-${i}`,
			display_name: `Seed Bot ${i}`,
			mu: 25,
			sigma: 8.333,
			games_played: 3,
			bot_profile: 'balanced',
			rating_version: 1
		});
		if (ins.error) throw new Error(ins.error.message);
	}
});

afterAll(() => {
	emu.close();
});

describe('active-session bot reservation (real PostgREST wire dialect)', () => {
	test('room B’s bots are DISJOINT from active room A’s and come from fresh eligible seeds; closed-room bots become reusable', async () => {
		// Human A matches: 3 of the 6 seeds are now SEATED in active room A.
		const roomA = await pollUntilMatched('human-a', 'Human A');
		const sessA = await sessionIdOf(roomA);
		const botsA = await seatedBots(sessA);
		expect(botsA).toHaveLength(3);

		// Human B queues against the SAME store while room A is still active: the
		// exclusion must reserve room A's seated bots — room B gets the OTHER 3.
		const roomB = await pollUntilMatched('human-b', 'Human B');
		const sessB = await sessionIdOf(roomB);
		const botsB = await seatedBots(sessB);
		expect(botsB).toHaveLength(3);
		expect(botsB.filter((id) => botsA.includes(id))).toEqual([]); // disjoint
		// …and every one is a disclosed eligible seed, not an invented identity.
		const seeded = new Set(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6']);
		expect([...botsA, ...botsB].every((id) => seeded.has(id))).toBe(true);
		expect(new Set([...botsA, ...botsB]).size).toBe(6);

		// Close room A: its bots return to the eligible pool. With room B still
		// ACTIVE (its 3 stay reserved), human C can only be filled from room A's
		// freed bots — proving closed-room bots become reusable.
		const close = await admin
			.from('play_game_sessions')
			.update({ status: 'closed', revision: 2, public_state: { status: 'closed', revision: 2 } })
			.eq('id', sessA);
		if (close.error) throw new Error(close.error.message);

		const roomC = await pollUntilMatched('human-c', 'Human C');
		const botsC = await seatedBots(await sessionIdOf(roomC));
		expect(botsC).toEqual(botsA); // exactly the freed set — nothing else was eligible
		expect(botsC.filter((id) => botsB.includes(id))).toEqual([]); // room B stays reserved
	});

	test('the emulator REJECTS embedded-relation syntax loudly — parity by refusal, never a silent zero-row lie', async () => {
		const embeddedSelect = await fetch(
			`${URL_BASE}/rest/v1/play_session_members?select=user_id,play_game_sessions!inner(status)&is_bot=eq.true`,
			{ headers: { 'Accept-Profile': PLAY_SCHEMA, apikey: 'local-emu' } }
		);
		expect(embeddedSelect.status).toBe(400);
		expect(((await embeddedSelect.json()) as { message: string }).message).toMatch(
			/embedded resources .* not supported/
		);

		const embeddedFilter = await fetch(
			`${URL_BASE}/rest/v1/play_session_members?user_id=not.is.null&play_game_sessions.status=in.(lobby,active)`,
			{ headers: { 'Accept-Profile': PLAY_SCHEMA, apikey: 'local-emu' } }
		);
		expect(embeddedFilter.status).toBe(400);
		expect(((await embeddedFilter.json()) as { message: string }).message).toMatch(
			/embedded-relation filter .* not supported/
		);
	});

	test('FAIL-CLOSED: when the seated-bot lookup fails, NOTHING is enqueued that tick (a bot is never double-seated on unverifiable freedom)', async () => {
		// Sever the store mid-flight for the members lookup only: point the admin at
		// a dead port, enqueue, then restore. The backfill must abort (swallowed),
		// leaving the queue with just the human — no bots of unknown status.
		const deadAdmin = createClient(`http://127.0.0.1:1`, 'local-emu', {
			db: { schema: PLAY_SCHEMA },
			auth: { persistSession: false, autoRefreshToken: false }
		});
		const liveAdmin = admin;
		// Queue the human against the live store first so the enqueue itself works.
		await admin.from('match_queue').insert({
			user_id: 'human-failclosed',
			display_name: 'Fail Closed',
			mu: 25,
			sigma: 8.333,
			ordinal: 0,
			party_size: 1,
			status: 'queued',
			is_bot: false,
			search_token: 'mqs_seeded-directly',
			queued_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		});
		try {
			holder.admin = new Proxy(liveAdmin, {
				get(target, prop, receiver) {
					if (prop === 'from') {
						return (table: string) =>
							table === 'play_session_members' ? deadAdmin.from(table) : liveAdmin.from(table);
					}
					return Reflect.get(target, prop, receiver);
				}
			});
			const poll = await enqueueAndPoll('human-failclosed', 'Fail Closed', false);
			expect(poll.status).toBe('searching');
			const queuedBots = await liveAdmin
				.from('match_queue')
				.select('user_id')
				.eq('status', 'queued')
				.eq('is_bot', true);
			expect(queuedBots.data).toEqual([]); // nothing enqueued on an unverifiable pool
		} finally {
			holder.admin = liveAdmin;
			await liveAdmin.from('match_queue').delete().eq('user_id', 'human-failclosed');
		}
	});
});
