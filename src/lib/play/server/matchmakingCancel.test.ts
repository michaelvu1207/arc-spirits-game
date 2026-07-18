/**
 * Quick Play server-side search retirement (matchmaking.ts cancelSearch +
 * enqueueAndPoll's search handle) — the initiating-principal-bound cancellation
 * contract behind /api/play/matchmaking/leave { searchId }:
 *
 *   - enqueueAndPoll mints an unguessable per-search handle, keeps it STABLE
 *     across the polls of one still-queued search, and returns it only in the
 *     owner's poll result; a cancelled search gets a FRESH handle next time.
 *   - cancelSearch(handle) on a QUEUED row cancels exactly that row (nobody
 *     else's) — the old generation can never form a match.
 *   - cancelSearch(handle) when FORMATION already won retires the initiating
 *     uid's human membership in the formed room, cancels the queue row (so a
 *     later poll can never resolve the dead room), and CLOSES the room when no
 *     human member remains — no abandoned match survives. With another human
 *     still present the room stays open.
 *   - Unknown / replayed handles are 'not_found' and change nothing.
 *
 * The supabase admin client is faked with an in-memory PostgREST-ish chain, so
 * these are pure unit tests of the contract (the pgrestEmu journey covers the
 * wire path end-to-end).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

/** One-shot injected failures: consumed by the NEXT operation matching (table, mode). */
const failNextOps: { table: string; mode: string; error: { message: string; code?: string } }[] =
	[];
/** One-shot pre-op mutations: run just BEFORE the next matching operation applies —
 *  the concurrent-writer seam (e.g. bump a session revision so a CAS update lands
 *  on zero rows, or hide a member row so an update silently misses). */
const beforeNextOps: { table: string; mode: string; fn: () => void }[] = [];
/** Configurable try_form_ranked_match result (default: no group formed). */
let rpcClaim: Row[] = [];

const { createRankedSessionMock } = vi.hoisted(() => ({ createRankedSessionMock: vi.fn() }));
vi.mock('./service', () => ({ createRankedSession: createRankedSessionMock }));

function reset(seed: Record<string, Row[]>) {
	for (const key of Object.keys(tables)) delete tables[key];
	for (const [key, rows] of Object.entries(seed)) tables[key] = rows.map((r) => ({ ...r }));
	failNextOps.length = 0;
	beforeNextOps.length = 0;
	rpcClaim = [];
	createRankedSessionMock.mockReset();
	createRankedSessionMock.mockRejectedValue(new Error('createRankedSession not stubbed'));
}

function takeBeforeOp(table: string, mode: string): void {
	const idx = beforeNextOps.findIndex((h) => h.table === table && h.mode === mode);
	if (idx >= 0) {
		const [{ fn }] = beforeNextOps.splice(idx, 1);
		fn();
	}
}

function fakeAdmin() {
	function from(table: string) {
		const rowsOf = () => tables[table] ?? (tables[table] = []);
		function makeQuery(mode: 'select' | 'update' | 'delete', payload?: Row) {
			const filters: ((r: Row) => boolean)[] = [];
			let wantCount = false;
			let head = false;
			let single = false;
			let returning = mode !== 'update' && mode !== 'delete';
			const q: Record<string, unknown> = {
				eq(key: string, value: unknown) {
					filters.push((r) => r[key] === value);
					return q;
				},
				is(key: string, value: unknown) {
					filters.push((r) => (value === null ? r[key] == null : r[key] === value));
					return q;
				},
				lt(key: string, value: unknown) {
					filters.push((r) => String(r[key] ?? '') < String(value ?? ''));
					return q;
				},
				in(key: string, values: unknown[]) {
					filters.push((r) => values.includes(r[key]));
					return q;
				},
				not() {
					filters.push((r) => r.bot_profile != null); // only used by ensureBotPresence
					return q;
				},
				order() {
					return q;
				},
				limit() {
					return q;
				},
				select(_cols?: string, opts?: { count?: string; head?: boolean }) {
					if (opts?.count) {
						wantCount = true;
						head = opts.head === true;
					}
					returning = true;
					return q;
				},
				maybeSingle() {
					single = true;
					return q;
				},
				then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
					const failIdx = failNextOps.findIndex((f) => f.table === table && f.mode === mode);
					if (failIdx >= 0) {
						const [{ error }] = failNextOps.splice(failIdx, 1);
						return Promise.resolve({ data: null, error }).then(onOk, onErr);
					}
					takeBeforeOp(table, mode);
					const matched = rowsOf().filter((r) => filters.every((f) => f(r)));
					let out: Record<string, unknown>;
					if (mode === 'update') {
						for (const row of matched) Object.assign(row, payload);
						out = { data: returning ? structuredClone(matched) : null, error: null };
					} else if (mode === 'delete') {
						tables[table] = rowsOf().filter((r) => !filters.every((f) => f(r)));
						out = { data: null, error: null };
					} else if (wantCount) {
						out = {
							count: matched.length,
							data: head ? null : structuredClone(matched),
							error: null
						};
					} else if (single) {
						out = { data: structuredClone(matched[0] ?? null), error: null };
					} else {
						out = { data: structuredClone(matched), error: null };
					}
					return Promise.resolve(out).then(onOk, onErr);
				}
			};
			return q;
		}
		return {
			select(cols?: string, opts?: { count?: string; head?: boolean }) {
				const q = makeQuery('select');
				return (q.select as (c?: string, o?: unknown) => typeof q)(cols, opts);
			},
			update(vals: Row) {
				return makeQuery('update', vals);
			},
			delete() {
				return makeQuery('delete');
			},
			upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
				const failIdx = failNextOps.findIndex((f) => f.table === table && f.mode === 'upsert');
				if (failIdx >= 0) {
					const [{ error }] = failNextOps.splice(failIdx, 1);
					return Promise.resolve({ data: null, error });
				}
				const key = opts?.onConflict ?? 'user_id';
				const list = Array.isArray(rows) ? rows : [rows];
				const target = tables[table] ?? (tables[table] = []);
				for (const row of list) {
					const existing = target.find((r) => r[key] === row[key]);
					if (existing) Object.assign(existing, row);
					else target.push({ ...row });
				}
				return Promise.resolve({ data: null, error: null });
			},
			insert(row: Row) {
				// The queue's primary key is user_id — a conflicting insert reports the
				// PostgREST unique-violation shape instead of silently duplicating.
				const target = tables[table] ?? (tables[table] = []);
				if (table === QUEUE && target.some((r) => r.user_id === row.user_id)) {
					return Promise.resolve({
						data: null,
						error: { code: '23505', message: 'duplicate key value violates unique constraint' }
					});
				}
				target.push({ ...row });
				return Promise.resolve({ data: null, error: null });
			},
			rpc: undefined
		};
	}
	return {
		from,
		// try_form_ranked_match: forms nothing by default; the formation tests set
		// `rpcClaim` to the group the "advisory-locked SQL function" claims (and
		// flip the seeded rows to 'matched' themselves, as the real function does).
		rpc: () => Promise.resolve({ data: rpcClaim, error: null })
	};
}

vi.mock('$lib/server/supabaseAdmin', () => ({
	getSupabaseAdmin: () => fakeAdmin()
}));

import { cancelSearch, enqueueAndPoll, tryFormRankedMatch } from './matchmaking';
import { RankedFormationAbortError } from './formationAbort';

const QUEUE = 'match_queue';
const MEMBERS = 'play_session_members';
const SESSIONS = 'play_game_sessions';
const CANCELS = 'match_search_cancellations';

/** A well-formed client attempt token (43 base64url chars after the prefix). */
const attempt = (seed: string) => `mqa_${seed.padEnd(43, 'x').slice(0, 43)}`;

beforeEach(() => {
	reset({ [QUEUE]: [], [MEMBERS]: [], [SESSIONS]: [], player_ratings: [] });
});

describe('enqueueAndPoll search handle', () => {
	test('mints an unguessable handle, returns it only to the owner, and keeps it STABLE across polls of one search', async () => {
		const first = await enqueueAndPoll('uid-old', 'Old Account', false);
		expect(first.status).toBe('searching');
		expect(first.searchId).toMatch(/^mqs_[A-Za-z0-9_-]{43}$/);

		const second = await enqueueAndPoll('uid-old', 'Old Account', false);
		expect(second.searchId).toBe(first.searchId); // same search, same handle

		// The handle lives on the row, never in another user's poll result.
		const other = await enqueueAndPoll('uid-other', 'Someone Else', false);
		expect(other.searchId).toBeDefined();
		expect(other.searchId).not.toBe(first.searchId);
		expect(other.players.every((p) => !('searchId' in p))).toBe(true);
	});

	test('a cancelled search gets a FRESH handle on the next enqueue — a stale handle cannot cancel the new search', async () => {
		const first = await enqueueAndPoll('uid-1', 'Player', false);
		expect(await cancelSearch(first.searchId as string)).toBe('cancelled');

		const again = await enqueueAndPoll('uid-1', 'Player', false);
		expect(again.searchId).toBeDefined();
		expect(again.searchId).not.toBe(first.searchId);

		// Replaying the RETIRED handle touches nothing: the new search stays queued.
		expect(await cancelSearch(first.searchId as string)).toBe('not_found');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-1')?.status).toBe('queued');
	});
});

describe('cancelSearch on a QUEUED row', () => {
	test('cancels exactly the handle\'s row — a different user\'s search is untouched', async () => {
		const mine = await enqueueAndPoll('uid-old', 'Old Account', false);
		const theirs = await enqueueAndPoll('uid-bystander', 'Bystander', false);

		expect(await cancelSearch(mine.searchId as string)).toBe('cancelled');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-old')?.status).toBe('cancelled');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-bystander')?.status).toBe('queued');
		// Idempotent replay.
		expect(await cancelSearch(mine.searchId as string)).toBe('not_found');
		expect(await cancelSearch(theirs.searchId as string)).toBe('cancelled');
	});

	test('an unknown handle is not_found and changes nothing', async () => {
		await enqueueAndPoll('uid-1', 'Player', false);
		expect(await cancelSearch('mqs_never-minted')).toBe('not_found');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-1')?.status).toBe('queued');
	});
});

describe('cancelSearch when FORMATION won the race', () => {
	function seedFormedMatch(handle: string, opts: { extraHuman?: boolean } = {}) {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-old',
					status: 'matched',
					claimed_session_id: 'sess-1',
					search_token: handle,
					is_bot: false
				}
			],
			[MEMBERS]: [
				{ id: 'm-old', session_id: 'sess-1', user_id: 'uid-old', is_bot: false },
				{ id: 'm-bot1', session_id: 'sess-1', user_id: 'bot-1', is_bot: true },
				{ id: 'm-bot2', session_id: 'sess-1', user_id: 'bot-2', is_bot: true },
				...(opts.extraHuman
					? [{ id: 'm-human2', session_id: 'sess-1', user_id: 'uid-still-here', is_bot: false }]
					: [])
			],
			[SESSIONS]: [
				{
					id: 'sess-1',
					status: 'active',
					revision: 3,
					public_state: { status: 'active', revision: 3, phase: 'navigation' }
				}
			],
			player_ratings: []
		});
	}

	test('retires the initiating uid\'s membership, cancels the row, and CLOSES the human-less room — no abandoned match survives', async () => {
		seedFormedMatch('mqs_formed');
		expect(await cancelSearch('mqs_formed')).toBe('retired_after_match');

		// The queue row can never resolve the dead room for a later poll.
		expect(tables[QUEUE][0].status).toBe('cancelled');
		// The retired human's SEAT is not a ghost: the membership row survives as a
		// DISCLOSED BOT (the game already started — the seat keeps an authorized,
		// server-driven actor), no longer reachable by the retired uid.
		const members = tables[MEMBERS];
		expect(members.some((m) => m.user_id === 'uid-old')).toBe(false);
		const converted = members.find((m) => m.id === 'm-old');
		expect(converted).toBeDefined();
		expect(converted?.is_bot).toBe(true);
		expect(converted?.user_id).toBeNull();
		expect(typeof converted?.bot_profile).toBe('string');
		expect(members.filter((m) => m.is_bot)).toHaveLength(3);
		// The room is CLOSED with a coherent public_state revision bump.
		const session = tables[SESSIONS][0];
		expect(session.status).toBe('closed');
		expect(session.revision).toBe(4);
		expect((session.public_state as Row).status).toBe('closed');
		expect((session.public_state as Row).revision).toBe(4);
		expect(session.ended_at).toBeDefined();
	});

	test('with another HUMAN still in the room, the initiating seat becomes a DISCLOSED BOT (never a ghost) — the room stays open and playable', async () => {
		seedFormedMatch('mqs_formed2', { extraHuman: true });
		expect(await cancelSearch('mqs_formed2')).toBe('retired_after_match');

		const members = tables[MEMBERS];
		expect(members.some((m) => m.user_id === 'uid-old')).toBe(false);
		// The already-started game keeps an AUTHORIZED actor on the retired seat:
		// the membership converts to a disclosed bot rather than vanishing under
		// the still-claimed seat in game state.
		const converted = members.find((m) => m.id === 'm-old');
		expect(converted?.is_bot).toBe(true);
		expect(converted?.user_id).toBeNull();
		expect(members.some((m) => m.user_id === 'uid-still-here')).toBe(true);
		expect(tables[SESSIONS][0].status).toBe('active'); // other human keeps playing
	});

	test('FAIL-CLOSED: a store error while retiring the seat THROWS with the queue row still matched — a retry completes the retirement (never a ghost behind a cancelled row)', async () => {
		seedFormedMatch('mqs_failing', { extraHuman: true });
		failNextOps.push({
			table: MEMBERS,
			mode: 'update',
			error: { message: 'store exploded mid-retirement' }
		});

		await expect(cancelSearch('mqs_failing')).rejects.toThrow(/retire formed membership/);
		// Nothing was reported done, and the row is still 'matched' — the path is
		// re-enterable, not stranded behind a premature cancel.
		expect(tables[QUEUE][0].status).toBe('matched');
		expect(tables[MEMBERS].find((m) => m.id === 'm-old')?.is_bot).toBe(false);

		// The retry completes the whole retirement.
		expect(await cancelSearch('mqs_failing')).toBe('retired_after_match');
		expect(tables[QUEUE][0].status).toBe('cancelled');
		expect(tables[MEMBERS].find((m) => m.id === 'm-old')?.is_bot).toBe(true);
	});
});

describe('cancelSearch MID-FORMATION (matched, session not yet stamped)', () => {
	test('cancels the claimed-but-unstamped row — single winner against the stamp', async () => {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-mid',
					status: 'matched',
					claimed_session_id: null,
					search_token: 'mqs_mid',
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
		// Pre-fix this returned not_found (status not queued, no session to retire),
		// leaving the cancellation impossible while formation was mid-hand-off.
		expect(await cancelSearch('mqs_mid')).toBe('cancelled');
		expect(tables[QUEUE][0].status).toBe('cancelled');
		expect(tables[QUEUE][0].claimed_session_id).toBeNull();
	});
});

describe('enqueueAndPoll vs a formation MID-hand-off (matched + null claimed_session_id)', () => {
	function seedMidFormation(updatedAt: string) {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-mid',
					status: 'matched',
					claimed_session_id: null,
					search_token: 'mqs_mid',
					is_bot: false,
					queued_at: new Date().toISOString(),
					updated_at: updatedAt
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
	}

	test('a FRESH claim is never re-queued: the poll reports searching and leaves the row matched (no second claim for a uid already being seated)', async () => {
		seedMidFormation(new Date().toISOString());
		const result = await enqueueAndPoll('uid-mid', 'Mid Former', false);
		expect(result.status).toBe('searching');
		// The claimed row was NOT clobbered back to 'queued' (pre-fix the blind
		// upsert did exactly that, letting the same uid form a SECOND match while
		// the first still seated them).
		expect(tables[QUEUE][0].status).toBe('matched');
		expect(tables[QUEUE][0].claimed_session_id).toBeNull();
		expect(tables[QUEUE][0].search_token).toBe('mqs_mid'); // untouched
	});

	test('a STALE claim (formation died before stamping) is released back to the pool and the search continues', async () => {
		seedMidFormation(new Date(Date.now() - 60_000).toISOString());
		const result = await enqueueAndPoll('uid-mid', 'Mid Former', false);
		expect(result.status).toBe('searching');
		// Recovered: re-queued (fresh enqueue refresh), not stuck 'matched' forever.
		expect(tables[QUEUE][0].status).toBe('queued');
		expect(tables[QUEUE][0].claimed_session_id).toBeNull();
	});

	test('an already-STAMPED matched row is never clobbered by a poll — the match resolves instead', async () => {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-done',
					status: 'matched',
					claimed_session_id: 'sess-9',
					search_token: 'mqs_done',
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [{ id: 'm-done', session_id: 'sess-9', user_id: 'uid-done', is_bot: false }],
			[SESSIONS]: [
				{
					id: 'sess-9',
					room_code: 'ROOM9',
					mode: 'casual',
					status: 'active',
					revision: 1,
					public_state: {}
				}
			],
			player_ratings: []
		});
		const result = await enqueueAndPoll('uid-done', 'Done Former', false);
		expect(result.status).toBe('matched');
		expect(result.roomCode).toBe('ROOM9');
		expect(result.rated).toBe(false);
		expect(result.mode).toBe('casual');
		expect(tables[QUEUE][0].status).toBe('matched'); // hand-off untouched
		expect(tables[QUEUE][0].claimed_session_id).toBe('sess-9');
	});
});

describe('formation hand-off is single-winner and cancellation-aware', () => {
	test('a cancel racing the formation window loses the seat cleanly: the conditional stamp skips the cancelled row and formation retires the seat it created', async () => {
		// Four claimed players (1 human + 3 bots) mid-formation, exactly as
		// try_form_ranked_match leaves them: status 'matched', nothing stamped.
		const now = new Date().toISOString();
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-h',
					display_name: 'Human',
					status: 'queued',
					claimed_session_id: null,
					search_token: 'mqs_race',
					is_bot: false,
					is_verified: true,
					queued_at: now,
					updated_at: now
				},
				...['b1', 'b2', 'b3'].map((id) => ({
					user_id: id,
					display_name: id,
					status: 'queued',
					claimed_session_id: null,
					search_token: null,
					is_bot: true,
					bot_profile: 'default',
					is_verified: true,
					queued_at: now,
					updated_at: now
				}))
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
		// The "SQL function" claims the group: flip rows to matched and return them.
		for (const row of tables[QUEUE]) {
			row.status = 'matched';
			row.updated_at = now;
		}
		rpcClaim = tables[QUEUE].map((r) => ({
			user_id: r.user_id,
			display_name: r.display_name,
			status: 'matched',
			is_bot: r.is_bot,
			bot_profile: r.bot_profile ?? null
		}));

		// createRankedSession creates the started room + memberships — and DURING
		// that window the human cancels via their handle (the mid-formation race).
		createRankedSessionMock.mockImplementation(async () => {
			tables[SESSIONS].push({
				id: 'sess-race',
				room_code: 'RACE1',
				mode: 'ranked',
				status: 'active',
				revision: 1,
				public_state: { status: 'active', revision: 1 }
			});
			tables[MEMBERS].push(
				{ id: 'm-h', session_id: 'sess-race', user_id: 'uid-h', is_bot: false },
				{ id: 'm-b1', session_id: 'sess-race', user_id: 'b1', is_bot: true },
				{ id: 'm-b2', session_id: 'sess-race', user_id: 'b2', is_bot: true },
				{ id: 'm-b3', session_id: 'sess-race', user_id: 'b3', is_bot: true }
			);
			expect(await cancelSearch('mqs_race')).toBe('cancelled'); // wins the row
			return {
				roomCode: 'RACE1',
				sessionId: 'sess-race',
				memberIdByUserId: { 'uid-h': 'm-h', b1: 'm-b1', b2: 'm-b2', b3: 'm-b3' }
			};
		});

		const formed = await tryFormRankedMatch();
		expect(formed?.roomCode).toBe('RACE1');

		// Single winner: the cancelled human row was NOT stamped…
		const humanRow = tables[QUEUE].find((r) => r.user_id === 'uid-h');
		expect(humanRow?.status).toBe('cancelled');
		expect(humanRow?.claimed_session_id).toBeNull();
		// …the bots were…
		for (const id of ['b1', 'b2', 'b3']) {
			expect(tables[QUEUE].find((r) => r.user_id === id)?.claimed_session_id).toBe('sess-race');
		}
		// …and formation retired the seat it created for the cancelled search: the
		// membership is a disclosed bot, and with no human left the room CLOSED.
		const member = tables[MEMBERS].find((m) => m.id === 'm-h');
		expect(member?.is_bot).toBe(true);
		expect(member?.user_id).toBeNull();
		expect(tables[SESSIONS].find((s) => s.id === 'sess-race')?.status).toBe('closed');
	});

	test('a hard stamp failure aborts the formation whole: the room is closed and the claim released (no unreachable orphan room)', async () => {
		const now = new Date().toISOString();
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-h',
					display_name: 'Human',
					status: 'matched',
					claimed_session_id: null,
					search_token: 'mqs_orphan',
					is_bot: false,
					is_verified: false,
					queued_at: now,
					updated_at: now
				},
				...['b1', 'b2', 'b3'].map((id) => ({
					user_id: id,
					display_name: id,
					status: 'matched',
					claimed_session_id: null,
					search_token: null,
					is_bot: true,
					bot_profile: 'default',
					is_verified: true,
					queued_at: now,
					updated_at: now
				}))
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
		rpcClaim = tables[QUEUE].map((r) => ({
			user_id: r.user_id,
			display_name: r.display_name,
			status: 'matched',
			is_bot: r.is_bot,
			bot_profile: r.bot_profile ?? null
		}));
		createRankedSessionMock.mockImplementation(async () => {
			tables[SESSIONS].push({
				id: 'sess-orphan',
				room_code: 'ORPH1',
				mode: 'casual',
				status: 'active',
				revision: 1,
				public_state: { status: 'active', revision: 1 }
			});
			tables[MEMBERS].push({
				id: 'm-h',
				session_id: 'sess-orphan',
				user_id: 'uid-h',
				is_bot: false
			});
			return {
				roomCode: 'ORPH1',
				sessionId: 'sess-orphan',
				memberIdByUserId: { 'uid-h': 'm-h' }
			};
		});
		failNextOps.push({ table: QUEUE, mode: 'update', error: { message: 'stamp write lost' } });

		expect(await tryFormRankedMatch()).toBeNull();
		// The unreachable room did not survive as an orphan…
		expect(tables[SESSIONS].find((s) => s.id === 'sess-orphan')?.status).toBe('closed');
		// …and the players went back to the pool to match again.
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('queued');
	});
});

describe('ATTEMPT CONTRACT: client-minted attempt tokens', () => {
	test('enqueueAndPoll adopts a well-formed attemptId as the row token and echoes it; re-polls keep it; a NEW attempt overwrites it', async () => {
		const a1 = attempt('one');
		const first = await enqueueAndPoll('uid-a', 'Player', false, a1);
		expect(first.searchId).toBe(a1);
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-a')?.search_token).toBe(a1);

		const again = await enqueueAndPoll('uid-a', 'Player', false, a1);
		expect(again.searchId).toBe(a1); // same attempt, same token

		const a2 = attempt('two');
		const next = await enqueueAndPoll('uid-a', 'Player', false, a2);
		expect(next.searchId).toBe(a2); // a fresh attempt rebinds the row
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-a')?.search_token).toBe(a2);
	});

	test('a malformed attemptId is ignored: the server mints its own mqs_ handle (legacy client posture)', async () => {
		const result = await enqueueAndPoll('uid-b', 'Player', false, 'mqa_short');
		expect(result.searchId).toMatch(/^mqs_[A-Za-z0-9_-]{43}$/);
		const injected = await enqueueAndPoll('uid-c', 'Player', false, "mqs_' or 1=1 --");
		expect(injected.searchId).toMatch(/^mqs_[A-Za-z0-9_-]{43}$/);
	});
});

describe('TOMBSTONES: cancel racing AHEAD of its own attempt’s enqueue', () => {
	test('cancelSearch before the row exists tombstones the token; the LATE enqueue self-cancels instead of leaving an orphaned live search', async () => {
		const a1 = attempt('late-enqueue');
		// The leave lands first: no row yet — but the tombstone is recorded.
		expect(await cancelSearch(a1)).toBe('not_found');
		expect(tables[CANCELS].map((r) => r.search_token)).toEqual([a1]);

		// The attempt's delayed first poll finally lands: the row is written, the
		// tombstone re-check fires, and the row self-cancels — never claimable.
		const result = await enqueueAndPoll('uid-race', 'Racer', false, a1);
		expect(result.status).toBe('searching');
		const row = tables[QUEUE].find((r) => r.user_id === 'uid-race');
		expect(row?.status).toBe('cancelled');
		expect(row?.search_token).toBe(a1);

		// A NEW attempt by the same account is completely unaffected.
		const a2 = attempt('fresh-search');
		const fresh = await enqueueAndPoll('uid-race', 'Racer', false, a2);
		expect(fresh.searchId).toBe(a2);
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-race')?.status).toBe('queued');
	});

	test('the tombstone of attempt 1 can NEVER cancel attempt 2 of the same account (generation safety)', async () => {
		const a1 = attempt('gen1');
		const a2 = attempt('gen2');
		expect(await cancelSearch(a1)).toBe('not_found'); // tombstones a1 only

		const fresh = await enqueueAndPoll('uid-gen', 'Player', false, a2);
		expect(fresh.status).toBe('searching');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-gen')?.status).toBe('queued');

		// Replaying attempt 1's cancel (the exactly-once late re-send) still cannot
		// touch attempt 2's live row.
		expect(await cancelSearch(a1)).toBe('not_found');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-gen')?.status).toBe('queued');
	});

	test('FAIL-CLOSED: a tombstone write failure makes cancelSearch throw (no cancellation reported that a late enqueue could undo)', async () => {
		const a1 = attempt('tombfail');
		await enqueueAndPoll('uid-tf', 'Player', false, a1);
		failNextOps.push({ table: CANCELS, mode: 'upsert', error: { message: 'store down' } });
		await expect(cancelSearch(a1)).rejects.toThrow(/store down/);
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-tf')?.status).toBe('queued');
		// The retry completes both the tombstone and the row cancel.
		expect(await cancelSearch(a1)).toBe('cancelled');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-tf')?.status).toBe('cancelled');
	});
});

describe('FAIL-CLOSED FORMATION: claims are held out of the pool until the partial room is CONFIRMED closed', () => {
	function seedClaimedGroup(token: string) {
		const now = new Date().toISOString();
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-h',
					display_name: 'Human',
					status: 'matched',
					claimed_session_id: null,
					search_token: token,
					is_bot: false,
					is_verified: false,
					queued_at: now,
					updated_at: now
				},
				...['b1', 'b2', 'b3'].map((id) => ({
					user_id: id,
					display_name: id,
					status: 'matched',
					claimed_session_id: null,
					search_token: null,
					is_bot: true,
					bot_profile: 'default',
					is_verified: true,
					queued_at: now,
					updated_at: now
				}))
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: [],
			[CANCELS]: []
		});
		rpcClaim = tables[QUEUE].map((r) => ({
			user_id: r.user_id,
			display_name: r.display_name,
			status: 'matched',
			is_bot: r.is_bot,
			bot_profile: r.bot_profile ?? null
		}));
	}

	function stubCreatedSession(sessionId: string, roomCode: string) {
		createRankedSessionMock.mockImplementation(async () => {
			tables[SESSIONS].push({
				id: sessionId,
				room_code: roomCode,
				mode: 'casual',
				status: 'active',
				revision: 1,
				public_state: { status: 'active', revision: 1 }
			});
			tables[MEMBERS].push({
				id: 'm-h',
				session_id: sessionId,
				user_id: 'uid-h',
				is_bot: false
			});
			return { roomCode, sessionId, memberIdByUserId: { 'uid-h': 'm-h' } };
		});
	}

	test('STAMP failure + UNCONFIRMED close: claims are parked RECOVERING (never re-queued) with the doomed session stamped for recovery', async () => {
		seedClaimedGroup('mqs_recover1');
		stubCreatedSession('sess-r1', 'RCV1');
		failNextOps.push({ table: QUEUE, mode: 'update', error: { message: 'stamp lost' } });
		failNextOps.push({ table: SESSIONS, mode: 'update', error: { message: 'close lost' } });

		expect(await tryFormRankedMatch()).toBeNull();
		// The partial room is still live — so NOBODY went back to the pool.
		expect(tables[SESSIONS].find((s) => s.id === 'sess-r1')?.status).toBe('active');
		const human = tables[QUEUE].find((r) => r.user_id === 'uid-h');
		expect(human?.status).toBe('recovering');
		expect(human?.claimed_session_id).toBe('sess-r1');
		expect(tables[QUEUE].every((r) => r.status !== 'queued')).toBe(true);
	});

	test('the owner’s next poll RECOVERS a held claim: close first, and only a confirmed close releases the row back to queued', async () => {
		seedClaimedGroup('mqs_recover2');
		stubCreatedSession('sess-r2', 'RCV2');
		failNextOps.push({ table: QUEUE, mode: 'update', error: { message: 'stamp lost' } });
		failNextOps.push({ table: SESSIONS, mode: 'update', error: { message: 'close lost' } });
		expect(await tryFormRankedMatch()).toBeNull();
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('recovering');

		// Recovery close FAILS again → the poll reports searching and the row is
		// STILL held out (no duplicate eligibility while the room may be live).
		failNextOps.push({ table: SESSIONS, mode: 'update', error: { message: 'still down' } });
		const heldPoll = await enqueueAndPoll('uid-h', 'Human', false);
		expect(heldPoll.status).toBe('searching');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('recovering');
		expect(tables[SESSIONS].find((s) => s.id === 'sess-r2')?.status).toBe('active');

		// The next poll's close SUCCEEDS → the room is durably closed and only then
		// does the claim re-enter the pool (re-enqueued as a normal fresh search).
		const freed = await enqueueAndPoll('uid-h', 'Human', false);
		expect(freed.status).toBe('searching');
		expect(tables[SESSIONS].find((s) => s.id === 'sess-r2')?.status).toBe('closed');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('queued');
	});

	test('cancelSearch on a RECOVERING row closes the doomed room first (fail-closed), then cancels the row', async () => {
		seedClaimedGroup('mqs_recover3');
		stubCreatedSession('sess-r3', 'RCV3');
		failNextOps.push({ table: QUEUE, mode: 'update', error: { message: 'stamp lost' } });
		failNextOps.push({ table: SESSIONS, mode: 'update', error: { message: 'close lost' } });
		expect(await tryFormRankedMatch()).toBeNull();

		// Close fails during the cancel → the cancel THROWS with the row still held
		// out (re-enterable), never a cancelled row in front of a live room.
		failNextOps.push({ table: SESSIONS, mode: 'update', error: { message: 'close down' } });
		await expect(cancelSearch('mqs_recover3')).rejects.toThrow(/close down/);
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('recovering');

		expect(await cancelSearch('mqs_recover3')).toBe('cancelled');
		expect(tables[SESSIONS].find((s) => s.id === 'sess-r3')?.status).toBe('closed');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('cancelled');
	});

	test('createRankedSession abort with UNCONFIRMED close (RankedFormationAbortError.closed=false) parks the claims instead of releasing them', async () => {
		seedClaimedGroup('mqs_abort1');
		createRankedSessionMock.mockImplementation(async () => {
			tables[SESSIONS].push({
				id: 'sess-a1',
				room_code: 'ABR1',
				mode: 'casual',
				status: 'active',
				revision: 1,
				public_state: { status: 'active', revision: 1 }
			});
			throw new RankedFormationAbortError('sess-a1', false, new Error('seat step failed'));
		});

		expect(await tryFormRankedMatch()).toBeNull();
		const human = tables[QUEUE].find((r) => r.user_id === 'uid-h');
		expect(human?.status).toBe('recovering');
		expect(human?.claimed_session_id).toBe('sess-a1');

		// The owner's poll then completes the recovery once the store cooperates.
		await enqueueAndPoll('uid-h', 'Human', false);
		expect(tables[SESSIONS].find((s) => s.id === 'sess-a1')?.status).toBe('closed');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('queued');
	});

	test('createRankedSession abort with CONFIRMED close releases the claims straight back to the pool', async () => {
		seedClaimedGroup('mqs_abort2');
		createRankedSessionMock.mockImplementation(async () => {
			throw new RankedFormationAbortError('sess-a2', true, new Error('start step failed'));
		});
		expect(await tryFormRankedMatch()).toBeNull();
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h')?.status).toBe('queued');
	});
});

describe('CANCELLED PARTICIPANT: conversion failure aborts the hand-off (no undriven human seat)', () => {
	test('retirement failing twice ABORTS the formation whole: room closed, stamped rows cancelled — nobody is handed a live room with a ghost human', async () => {
		const now = new Date().toISOString();
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-h',
					display_name: 'Human A',
					status: 'queued',
					claimed_session_id: null,
					search_token: 'mqs_ghost',
					is_bot: false,
					is_verified: true,
					queued_at: now,
					updated_at: now
				},
				{
					user_id: 'uid-h2',
					display_name: 'Human B',
					status: 'queued',
					claimed_session_id: null,
					search_token: 'mqs_other',
					is_bot: false,
					is_verified: true,
					queued_at: now,
					updated_at: now
				},
				...['b1', 'b2'].map((id) => ({
					user_id: id,
					display_name: id,
					status: 'queued',
					claimed_session_id: null,
					search_token: null,
					is_bot: true,
					bot_profile: 'default',
					is_verified: true,
					queued_at: now,
					updated_at: now
				}))
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: [],
			[CANCELS]: []
		});
		for (const row of tables[QUEUE]) {
			row.status = 'matched';
			row.updated_at = now;
		}
		rpcClaim = tables[QUEUE].map((r) => ({
			user_id: r.user_id,
			display_name: r.display_name,
			status: 'matched',
			is_bot: r.is_bot,
			bot_profile: r.bot_profile ?? null
		}));
		createRankedSessionMock.mockImplementation(async () => {
			tables[SESSIONS].push({
				id: 'sess-ghost',
				room_code: 'GHST1',
				mode: 'ranked',
				status: 'active',
				revision: 1,
				public_state: { status: 'active', revision: 1 }
			});
			tables[MEMBERS].push(
				{ id: 'm-h', session_id: 'sess-ghost', user_id: 'uid-h', is_bot: false },
				{ id: 'm-h2', session_id: 'sess-ghost', user_id: 'uid-h2', is_bot: false },
				{ id: 'm-b1', session_id: 'sess-ghost', user_id: 'b1', is_bot: true },
				{ id: 'm-b2', session_id: 'sess-ghost', user_id: 'b2', is_bot: true }
			);
			// Human A cancels mid-formation: the conditional stamp will skip them.
			expect(await cancelSearch('mqs_ghost')).toBe('cancelled');
			return {
				roomCode: 'GHST1',
				sessionId: 'sess-ghost',
				memberIdByUserId: { 'uid-h': 'm-h', 'uid-h2': 'm-h2', b1: 'm-b1', b2: 'm-b2' }
			};
		});
		// The retirement of the cancelled member fails BOTH times (first try + retry).
		failNextOps.push({ table: MEMBERS, mode: 'update', error: { message: 'retire lost 1' } });
		failNextOps.push({ table: MEMBERS, mode: 'update', error: { message: 'retire lost 2' } });

		// Pre-fix this returned the room code anyway — handing Human B a live room
		// with Human A's seat as an undriven ghost. Now the formation aborts whole.
		expect(await tryFormRankedMatch()).toBeNull();
		expect(tables[SESSIONS].find((s) => s.id === 'sess-ghost')?.status).toBe('closed');
		// Stamped rows are CANCELLED (their clients may have stopped polling; a
		// still-polling client simply re-enqueues next tick), never left resolvable
		// to the dead room.
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h2')?.status).toBe('cancelled');
		// …and a still-polling Human B seamlessly starts a fresh search.
		const resumed = await enqueueAndPoll('uid-h2', 'Human B', false);
		expect(resumed.status).toBe('searching');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-h2')?.status).toBe('queued');
	});

	test('retirement VERIFIES the write result: a silently-lost conversion (no error, zero rows) still throws and re-enters', async () => {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-old',
					status: 'matched',
					claimed_session_id: 'sess-v',
					search_token: 'mqs_verify',
					is_bot: false
				}
			],
			[MEMBERS]: [
				{ id: 'm-old', session_id: 'sess-v', user_id: 'uid-old', is_bot: false },
				{ id: 'm-keep', session_id: 'sess-v', user_id: 'uid-keep', is_bot: false }
			],
			[SESSIONS]: [
				{
					id: 'sess-v',
					status: 'active',
					revision: 1,
					public_state: { status: 'active', revision: 1 }
				}
			],
			player_ratings: [],
			[CANCELS]: []
		});
		// The conversion UPDATE "succeeds" but silently applies to zero rows (the
		// row is hidden from its filter), then reappears for the verification read.
		const member = tables[MEMBERS].find((m) => m.id === 'm-old')!;
		beforeNextOps.push({
			table: MEMBERS,
			mode: 'update',
			fn: () => {
				member.user_id = 'uid-hidden';
			}
		});
		beforeNextOps.push({
			table: MEMBERS,
			mode: 'select',
			fn: () => {
				member.user_id = 'uid-old';
			}
		});

		await expect(cancelSearch('mqs_verify')).rejects.toThrow(/did not take effect/);
		// Fail-closed: the row is still 'matched', the human row still present —
		// the retry then completes the whole retirement for real.
		expect(tables[QUEUE][0].status).toBe('matched');
		expect(await cancelSearch('mqs_verify')).toBe('retired_after_match');
		expect(tables[MEMBERS].find((m) => m.id === 'm-old')?.is_bot).toBe(true);
	});
});

describe('ZERO-ROW CAS on the formed-room close', () => {
	test('a lost CAS (zero rows changed, no error) is retried against the fresh revision until the room is durably closed', async () => {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-cas',
					status: 'matched',
					claimed_session_id: 'sess-cas',
					search_token: 'mqs_cas',
					is_bot: false
				}
			],
			[MEMBERS]: [{ id: 'm-cas', session_id: 'sess-cas', user_id: 'uid-cas', is_bot: false }],
			[SESSIONS]: [
				{
					id: 'sess-cas',
					status: 'active',
					revision: 5,
					public_state: { status: 'active', revision: 5 }
				}
			],
			player_ratings: [],
			[CANCELS]: []
		});
		// A concurrent command advances the revision between the close's read and
		// its conditional write: the CAS lands on ZERO rows. Pre-fix that silent
		// zero-row outcome was treated as success and the room stayed open.
		const session = tables[SESSIONS][0];
		beforeNextOps.push({
			table: SESSIONS,
			mode: 'update',
			fn: () => {
				session.revision = 6;
				(session.public_state as Row).revision = 6;
			}
		});

		expect(await cancelSearch('mqs_cas')).toBe('retired_after_match');
		expect(session.status).toBe('closed');
		expect(session.revision).toBe(7); // closed against the FRESH revision
		expect((session.public_state as Row).status).toBe('closed');
		expect(tables[QUEUE][0].status).toBe('cancelled');
	});

	test('exhausting the CAS retries THROWS (never reports an unconfirmed close) and the cancel path stays re-enterable', async () => {
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-cas2',
					status: 'matched',
					claimed_session_id: 'sess-cas2',
					search_token: 'mqs_cas2',
					is_bot: false
				}
			],
			[MEMBERS]: [{ id: 'm-cas2', session_id: 'sess-cas2', user_id: 'uid-cas2', is_bot: false }],
			[SESSIONS]: [
				{
					id: 'sess-cas2',
					status: 'active',
					revision: 1,
					public_state: { status: 'active', revision: 1 }
				}
			],
			player_ratings: [],
			[CANCELS]: []
		});
		const session = tables[SESSIONS][0];
		const bump = () => {
			session.revision = (session.revision as number) + 1;
			(session.public_state as Row).revision = session.revision;
		};
		beforeNextOps.push(
			{ table: SESSIONS, mode: 'update', fn: bump },
			{ table: SESSIONS, mode: 'update', fn: bump },
			{ table: SESSIONS, mode: 'update', fn: bump }
		);

		await expect(cancelSearch('mqs_cas2')).rejects.toThrow(/revision CAS lost/);
		expect(session.status).toBe('active'); // truthfully NOT closed
		expect(tables[QUEUE][0].status).toBe('matched'); // re-enterable, not stranded

		expect(await cancelSearch('mqs_cas2')).toBe('retired_after_match');
		expect(session.status).toBe('closed');
	});
});

describe('ATTEMPT ADOPTION: same-uid attempt 2 arrives while attempt 1 is matched but not stamped', () => {
	test('adopts the in-flight formation: the row rebinds to attempt 2’s token, the response echoes IT (never attempt 1’s), and no second enqueue happens', async () => {
		const a1 = attempt('one');
		const a2 = attempt('two');
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-adopt',
					status: 'matched',
					claimed_session_id: null,
					search_token: a1,
					is_bot: false,
					updated_at: new Date().toISOString() // FRESH: the formation is mid-hand-off
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});

		const poll = await enqueueAndPoll('uid-adopt', 'Player', false, a2);
		expect(poll.status).toBe('searching'); // formation still stamping
		expect(poll.searchId).toBe(a2); // attempt 2's OWN capability — never a1 echoed as if it were a2's
		const row = tables[QUEUE].find((r) => r.user_id === 'uid-adopt');
		expect(row?.search_token).toBe(a2);
		expect(row?.status).toBe('matched'); // NOT re-enqueued into a second eligibility
		expect(row?.claimed_session_id).toBeNull();

		// Attempt 1's own late leave can no longer reach the adopted row.
		expect(await cancelSearch(a1)).toBe('not_found');
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-adopt')?.status).toBe('matched');

		// Attempt 2's cancel CAN: mid-formation it races (and here wins) the stamp.
		expect(await cancelSearch(a2)).toBe('cancelled');
	});

	test('adopts an already-STAMPED formation: attempt 2 resolves the matched room under its OWN token', async () => {
		const a1 = attempt('one');
		const a2 = attempt('two');
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-adopt2',
					status: 'matched',
					claimed_session_id: 'sess-9',
					search_token: a1,
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [{ id: 'm-1', session_id: 'sess-9', user_id: 'uid-adopt2', is_bot: false }],
			[SESSIONS]: [
				{
					id: 'sess-9',
					room_code: 'ROOM99',
					mode: 'casual',
					status: 'active',
					revision: 1,
					public_state: { status: 'active', revision: 1 }
				}
			],
			player_ratings: []
		});

		const poll = await enqueueAndPoll('uid-adopt2', 'Player', false, a2);
		expect(poll.status).toBe('matched');
		expect(poll.roomCode).toBe('ROOM99');
		expect(poll.memberId).toBe('m-1');
		expect(poll.searchId).toBe(a2);
		expect(tables[QUEUE][0].search_token).toBe(a2);

		// The adopted formed seat is retirable through attempt 2's token.
		expect(await cancelSearch(a2)).toBe('retired_after_match');
	});

	test('adopts a RECOVERING claim: the doomed room is closed, the released search continues under attempt 2’s token', async () => {
		const a1 = attempt('one');
		const a2 = attempt('two');
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-recover',
					status: 'recovering',
					claimed_session_id: 'sess-doomed',
					search_token: a1,
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [
				{
					id: 'sess-doomed',
					status: 'active',
					revision: 2,
					public_state: { status: 'active', revision: 2 }
				}
			],
			player_ratings: []
		});

		const poll = await enqueueAndPoll('uid-recover', 'Player', false, a2);
		expect(poll.status).toBe('searching');
		expect(poll.searchId).toBe(a2);
		expect(tables[SESSIONS][0].status).toBe('closed'); // recovery drove the close
		const row = tables[QUEUE].find((r) => r.user_id === 'uid-recover');
		expect(row?.status).toBe('queued');
		expect(row?.search_token).toBe(a2);
	});

	test('attempt 2 already TOMBSTONED (cancelled before its first poll landed): the adopted formation is retired, never handed to it', async () => {
		const a1 = attempt('one');
		const a2 = attempt('two');
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-tomb',
					status: 'matched',
					claimed_session_id: null,
					search_token: a1,
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
		expect(await cancelSearch(a2)).toBe('not_found'); // tombstones a2 before its poll

		const poll = await enqueueAndPoll('uid-tomb', 'Player', false, a2);
		expect(poll.status).toBe('searching');
		expect(poll.searchId).toBeUndefined(); // no live capability — the search is over
		expect(tables[QUEUE].find((r) => r.user_id === 'uid-tomb')?.status).toBe('cancelled');
	});

	test('resolveQueueStatus NEVER echoes another attempt’s token as the caller’s: a row still bound to attempt 1 answers attempt 2 with NO searchId', async () => {
		const a1 = attempt('one');
		const a2 = attempt('two');
		reset({
			[QUEUE]: [
				{
					user_id: 'uid-echo',
					status: 'matched',
					claimed_session_id: null,
					search_token: a1,
					is_bot: false,
					updated_at: new Date().toISOString()
				}
			],
			[MEMBERS]: [],
			[SESSIONS]: [],
			player_ratings: []
		});
		const { resolveQueueStatus } = await import('./matchmaking');
		const asAttempt2 = await resolveQueueStatus('uid-echo', a2);
		expect(asAttempt2.searchId).toBeUndefined();
		// A LEGACY caller (no attempt token) still gets the row's handle echo.
		const legacy = await resolveQueueStatus('uid-echo', null);
		expect(legacy.searchId).toBe(a1);
	});
});
