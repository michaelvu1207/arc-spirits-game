/**
 * Minimal local PostgREST emulator — enough of the wire protocol supabase-js speaks
 * for the room server + shared commit protocol to run END-TO-END with no Supabase
 * reachability: schema-scoped tables (Accept-Profile / Content-Profile), eq/in/gt
 * filters incl. the jsonb path form (`command_payload->>cmdId=eq.X`), select /
 * insert / update / upsert / delete, `Prefer: return=representation`,
 * `application/vnd.pgrst.object+json` single-object semantics (PGRST116), and the
 * `commit_room_command` RPC from 20260710_command_ledger.sql (toggleable, so both
 * pre- and post-migration commit modes are provable on the real wire).
 *
 * Since the 2026-07-10 session-journey batch it also carries: `is`/`not.is`/`lt`
 * filters + HEAD/count=exact (matchmaking's bot-backfill queries), the
 * `try_form_ranked_match` pairing RPC (documented semantics — the SQL exists only
 * in the live project), and a minimal GoTrue (`/auth/v1/*`) for the ANONYMOUS
 * identity path — signup / refresh / user — so ranked Quick Play is provable
 * end-to-end (web + Godot) with zero Supabase reachability.
 *
 * TEST INFRASTRUCTURE ONLY (authoritySmoke.ts). Runs in the smoke's own process, so
 * SIGKILLing a room-server instance genuinely loses that instance's memory while
 * the "database" survives — the honest restart-recovery proof.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { commandFingerprint } from '../src/lib/play/server/commit';
import { SHOP_ITEMS, calculateMatchAward } from '../src/lib/cosmetics/progression';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** jsonb semantics: cloned + key-sorted, `undefined` dropped (like Postgres). */
function jsonb<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => jsonb(item)) as unknown as T;
	const out: Record<string, any> = {};
	for (const key of Object.keys(value as Record<string, any>).sort()) {
		const member = (value as Record<string, any>)[key];
		if (member === undefined) continue;
		out[key] = jsonb(member);
	}
	return out as T;
}

function readColumn(row: Row, key: string): any {
	const arrow = key.indexOf('->>');
	if (arrow === -1) return row[key];
	const holder = row[key.slice(0, arrow)];
	if (holder == null || typeof holder !== 'object') return null;
	const value = (holder as Row)[key.slice(arrow + 3)];
	return value == null ? null : String(value);
}

interface Filter {
	key: string;
	op: 'eq' | 'in' | 'gt' | 'lt' | 'is' | 'not.is';
	value: string | string[];
}

/** Thrown for PostgREST features this emulator does NOT implement. Unsupported
 *  syntax must fail LOUDLY: an embedded-relation filter that silently matched
 *  zero rows once turned matchmaking's seated-bot exclusion into a no-op (bots
 *  double-seated across concurrent games) while the same query worked on real
 *  PostgREST. Parity means refusing what we cannot emulate, never guessing. */
class UnsupportedSyntaxError extends Error {}

function parseFilters(params: URLSearchParams): Filter[] {
	const filters: Filter[] = [];
	const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
	const select = params.get('select');
	if (select && /[()]/.test(select)) {
		throw new UnsupportedSyntaxError(
			`pgrestEmu: embedded resources in select ("${select}") are not supported — ` +
				'query the related table with plain filters instead (two-step).'
		);
	}
	for (const [key, raw] of params.entries()) {
		if (reserved.has(key)) continue;
		// A dotted filter key (e.g. `play_game_sessions.status=in.(…)`) targets an
		// EMBEDDED relation; no real column contains '.' (jsonb paths use '->>').
		if (key.includes('.')) {
			throw new UnsupportedSyntaxError(
				`pgrestEmu: embedded-relation filter "${key}" is not supported — ` +
					'query the related table with plain filters instead (two-step).'
			);
		}
		if (raw.startsWith('eq.')) filters.push({ key, op: 'eq', value: raw.slice(3) });
		else if (raw.startsWith('gt.')) filters.push({ key, op: 'gt', value: raw.slice(3) });
		else if (raw.startsWith('lt.')) filters.push({ key, op: 'lt', value: raw.slice(3) });
		else if (raw.startsWith('is.')) filters.push({ key, op: 'is', value: raw.slice(3) });
		else if (raw.startsWith('not.is.')) filters.push({ key, op: 'not.is', value: raw.slice(7) });
		else if (raw.startsWith('in.(') && raw.endsWith(')')) {
			const inner = raw.slice(4, -1);
			const values = inner.length
				? inner.split(',').map((v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v))
				: [];
			filters.push({ key, op: 'in', value: values });
		}
	}
	return filters;
}

/** `is.null` / `is.true` / `is.false` semantics (shared by `is` and `not.is`). */
function isMatch(actual: any, value: string): boolean {
	if (value === 'null') return actual == null;
	if (value === 'true') return actual === true;
	if (value === 'false') return actual === false;
	return false;
}

function matches(row: Row, filters: Filter[]): boolean {
	return filters.every((filter) => {
		const actual = readColumn(row, filter.key);
		const text = actual == null ? null : String(actual);
		if (filter.op === 'in') return (filter.value as string[]).some((v) => v === text);
		if (filter.op === 'gt') return text != null && text > (filter.value as string);
		if (filter.op === 'lt') return text != null && text < (filter.value as string);
		if (filter.op === 'is') return isMatch(actual, filter.value as string);
		if (filter.op === 'not.is') return !isMatch(actual, filter.value as string);
		if (filter.value === 'null') return actual == null;
		return text === filter.value;
	});
}

const TIMESTAMP_DEFAULTS = ['created_at', 'updated_at', 'joined_at', 'last_seen_at'];

/** Column DEFAULTs the real schema applies on insert. Postgres fills these when a
 *  writer omits the column; without them here, boolean `eq.false` filters silently
 *  drop rows (a human `match_queue` row minus `is_bot` is NOT `is_bot=eq.false` to
 *  the emulator — which made reapQueuedBots cancel every backfilled bot). */
const COLUMN_DEFAULTS: Record<string, Row> = {
	match_queue: { is_bot: false, bot_profile: null, party_size: 1 },
	play_session_members: { is_bot: false, bot_profile: null }
};

/** The 20260710 `play_game_sessions_revision_monotonic` trigger, emulated. */
function checkSessionMonotonic(tableName: string, row: Row, payload: Row): Row | null {
	if (tableName !== 'play_game_sessions' || !('revision' in payload)) return null;
	const next = payload.revision;
	if (typeof next !== 'number' || next < row.revision) {
		return {
			code: 'P0001',
			message: `play_game_sessions.revision must not decrease (${row.revision} -> ${String(next)}): revision_not_monotonic`
		};
	}
	if (next === row.revision && 'public_state' in payload) {
		if (JSON.stringify(jsonb(payload.public_state)) !== JSON.stringify(jsonb(row.public_state))) {
			return {
				code: 'P0001',
				message: `play_game_sessions.public_state must not change under an unchanged revision ${next}: revision_not_monotonic`
			};
		}
	}
	return null;
}

export class PgrestEmu {
	/** schema → table → rows */
	private schemas = new Map<string, Map<string, Row[]>>();
	private server: Server | null = null;
	/** When false the commit RPC answers PGRST202 — the pre-migration store. */
	rpcEnabled: boolean;

	constructor(opts: { rpc?: boolean } = {}) {
		this.rpcEnabled = opts.rpc ?? false;
		this.table('arc_spirits_2d', 'ranked_seasons').push({
			id: 'season-zero-2026', name: 'Season Zero · First Light', status: 'active',
			starts_at: '2026-07-01T00:00:00Z', ends_at: '2027-01-01T00:00:00Z',
			placement_games: 5, rules_version: 1
		});
		for (const [division_key, label, tier_order, min_ordinal] of [
			['ember', 'Ember', 0, -1000], ['iron', 'Iron', 1, 0], ['bronze', 'Bronze', 2, 5],
			['silver', 'Silver', 3, 10], ['gold', 'Gold', 4, 15], ['prism', 'Prism', 5, 20]
		] as Array<[string, string, number, number]>) {
			this.table('arc_spirits_2d', 'ranked_division_rules').push({
				season_id: 'season-zero-2026', division_key, label, tier_order, min_ordinal
			});
		}
		for (const [id, name, description, target, reward_item_id] of [
			['first-ranked-match', 'First Step', 'Complete a rated ranked match.', 1, null],
			['first-ranked-win', 'First Ascent', 'Win a rated ranked match.', 1, null],
			['placements-complete', 'Placed in the Aether', 'Complete five placement matches.', 5, 'border-ranked-first-light'],
			['reach-gold', 'Golden Resolve', 'Reach Gold division in a ranked season.', 1, 'nameplate-ranked-gold']
		] as Array<[string, string, string, number, string | null]>) {
			this.table('arc_spirits_2d', 'achievement_definitions').push({
				id, name, description, target, reward_item_id, category: 'ranked', active: true
			});
		}
	}

	table(schema: string, table: string): Row[] {
		let tables = this.schemas.get(schema);
		if (!tables) {
			tables = new Map();
			this.schemas.set(schema, tables);
		}
		let rows = tables.get(table);
		if (!rows) {
			rows = [];
			tables.set(table, rows);
		}
		return rows;
	}

	listen(port: number): Promise<void> {
		this.server = createServer((req, res) => this.handle(req, res));
		return new Promise((resolve) => this.server!.listen(port, () => resolve()));
	}

	close(): void {
		this.server?.close();
	}

	private async body(req: IncomingMessage): Promise<any> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const text = Buffer.concat(chunks).toString('utf8');
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	private send(res: ServerResponse, status: number, body: unknown): void {
		const payload = body === undefined ? '' : JSON.stringify(body);
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(payload);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			// Browser CORS: the web client calls this emulator CROSS-ORIGIN (the dev
			// server is :4173, the store is its own port) for the anonymous-auth path,
			// so preflights must succeed and every response must carry the CORS headers
			// — exactly what the hosted Supabase does. A local emulator has no ambient
			// authority, so the wildcard is honest here.
			res.setHeader('access-control-allow-origin', '*');
			res.setHeader(
				'access-control-allow-headers',
				String(req.headers['access-control-request-headers'] ?? '*') || '*'
			);
			res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
			res.setHeader('access-control-expose-headers', 'content-range, x-supabase-api-version');
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			const url = new URL(req.url ?? '/', 'http://localhost');
			const parts = url.pathname.split('/').filter(Boolean); // ['rest','v1',...] | ['auth','v1',...]
			if (parts[0] === 'auth' && parts[1] === 'v1') {
				return await this.handleAuth(String(parts[2] ?? ''), req, res, url);
			}
			if (parts[0] !== 'rest' || parts[1] !== 'v1')
				return this.send(res, 404, { message: 'not found' });

			const schema =
				(req.method === 'GET' || req.method === 'HEAD'
					? req.headers['accept-profile']
					: req.headers['content-profile']) ?? 'public';

			if (parts[2] === 'rpc') {
				return this.handleRpc(String(parts[3] ?? ''), await this.body(req), res, String(schema));
			}

			const tableName = String(parts[2] ?? '');
			const rows = this.table(String(schema), tableName);
			const filters = parseFilters(url.searchParams);
			const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object+json');
			const wantsRepresentation = String(req.headers.prefer ?? '').includes(
				'return=representation'
			);

			const reply = (found: Row[], createdStatus = 200) => {
				const shaped = found.map((row) => jsonb(row));
				if (wantsObject) {
					if (shaped.length !== 1) {
						// Shape matters: postgrest-js maybeSingle() maps this to data:null only
						// when `details` mentions "0 rows" (or code PGRST116) — mirror PostgREST.
						return this.send(res, 406, {
							code: 'PGRST116',
							details: `Results contain ${shaped.length} rows, application/vnd.pgrst.object+json requires 1 row`,
							hint: null,
							message: 'JSON object requested, multiple (or no) rows returned'
						});
					}
					return this.send(res, createdStatus, shaped[0]);
				}
				return this.send(res, createdStatus, shaped);
			};

			switch (req.method) {
				case 'GET':
				case 'HEAD': {
					let found = rows.filter((row) => matches(row, filters));
					const order = url.searchParams.get('order');
					if (order) {
						const [key, dir] = order.split('.');
						const asc = dir !== 'desc';
						found = [...found].sort((a, b) =>
							a[key] < b[key] ? (asc ? -1 : 1) : a[key] > b[key] ? (asc ? 1 : -1) : 0
						);
					}
					const total = found.length;
					const limit = url.searchParams.get('limit');
					if (limit) found = found.slice(0, Number(limit));
					// `Prefer: count=exact|planned|estimated` (incl. supabase-js head:true
					// count queries, which arrive as HEAD): answer via content-range.
					if (String(req.headers.prefer ?? '').includes('count=') || req.method === 'HEAD') {
						const rangeBody = found.length ? `0-${found.length - 1}` : '*';
						res.setHeader('content-range', `${rangeBody}/${total}`);
					}
					if (req.method === 'HEAD') {
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end();
						return;
					}
					return reply(found);
				}
				case 'PATCH': {
					const payload = jsonb((await this.body(req)) ?? {});
					const hits = rows.filter((row) => matches(row, filters));
					for (const row of hits) {
						// Trigger emulation (play_game_sessions_revision_monotonic): revision
						// never decreases; public_state never changes under an equal revision.
						const monotonicError = checkSessionMonotonic(tableName, row, payload as Row);
						if (monotonicError) return this.send(res, 400, monotonicError);
						Object.assign(row, payload);
						if ('updated_at' in row) row.updated_at = new Date().toISOString();
					}
					if (!wantsRepresentation && !wantsObject) return this.send(res, 204, undefined);
					return reply(hits);
				}
				case 'POST': {
					const payload = await this.body(req);
					const list: Row[] = Array.isArray(payload) ? payload : payload ? [payload] : [];
					const onConflict = url.searchParams.get('on_conflict');
					const inserted: Row[] = [];
					for (const raw of list) {
						const row = jsonb({ ...raw }) as Row;
						row.id ??= randomUUID();
						for (const col of TIMESTAMP_DEFAULTS) row[col] ??= new Date().toISOString();
						for (const [col, def] of Object.entries(COLUMN_DEFAULTS[tableName] ?? {})) {
							row[col] ??= def;
						}
						if (onConflict) {
							const keys = onConflict.split(',').map((s) => s.trim());
							const existing = rows.find((candidate) => keys.every((k) => candidate[k] === row[k]));
							if (existing) {
								Object.assign(existing, row);
								inserted.push(existing);
								continue;
							}
						}
						const uniqueError = this.checkUnique(tableName, rows, row);
						if (uniqueError) return this.send(res, 409, uniqueError);
						rows.push(row);
						inserted.push(row);
					}
					if (!wantsRepresentation && !wantsObject) return this.send(res, 201, undefined);
					return reply(inserted, 201);
				}
				case 'DELETE': {
					const hits = rows.filter((row) => matches(row, filters));
					for (const hit of hits) rows.splice(rows.indexOf(hit), 1);
					return this.send(
						res,
						wantsRepresentation ? 200 : 204,
						wantsRepresentation ? hits : undefined
					);
				}
				default:
					return this.send(res, 405, { message: 'method not allowed' });
			}
		} catch (err) {
			if (err instanceof UnsupportedSyntaxError) {
				// Loud, typed refusal (client sees the exact unsupported syntax) — never
				// a silent zero-row match that diverges from real PostgREST.
				this.send(res, 400, { code: 'PGRST100', message: err.message });
				return;
			}
			this.send(res, 500, { message: (err as Error).message });
		}
	}

	/** The post-migration unique keys: (session_id, cmd_id) on the event ledger
	 *  (20260710_command_ledger) plus the ranked/replay exactly-once keys
	 *  (20260710_ranked_finalize). */
	private checkUnique(tableName: string, rows: Row[], row: Row): Row | null {
		// Canonical human membership (20260710_identity_trust): one membership per
		// (session, user) for non-bot rows. Emulated in BOTH store postures — the
		// identity model does not depend on the commit-RPC migration.
		if (tableName === 'play_session_members' && row.user_id != null && row.is_bot !== true) {
			const dupe = rows.some(
				(existing) =>
					existing.session_id === row.session_id &&
					existing.user_id === row.user_id &&
					existing.is_bot !== true
			);
			if (dupe) {
				return {
					code: '23505',
					message:
						'duplicate key value violates unique constraint "play_session_members_session_user_unique"'
				};
			}
		}
		if (!this.rpcEnabled) return null;
		if (tableName === 'play_game_session_events') {
			const cmdId = row.command_payload?.cmdId;
			if (cmdId == null) return null;
			const dupe = rows.some(
				(existing) =>
					existing.session_id === row.session_id && existing.command_payload?.cmdId === cmdId
			);
			return dupe
				? {
						code: '23505',
						message:
							'duplicate key value violates unique constraint "play_game_session_events_cmd_unique"'
					}
				: null;
		}
		const uniqueKeys: Record<string, { name: string; cols: string[] }[]> = {
			match_results: [{ name: 'match_results_session_unique', cols: ['session_id'] }],
			match_result_players: [
				{ name: 'match_result_players_session_seat_unique', cols: ['session_id', 'seat_color'] }
			],
			player_rating_events: [
				{ name: 'player_rating_events_session_user_unique', cols: ['session_id', 'user_id'] }
			],
			player_ratings: [{ name: 'player_ratings_user_unique', cols: ['user_id'] }],
			replay_codes: [
				{ name: 'replay_codes_game_nav_unique', cols: ['game_id', 'navigation_count'] },
				{ name: 'replay_codes_pkey', cols: ['code'] }
			],
			replay_shares: [
				{ name: 'replay_shares_pkey', cols: ['code'] },
				{ name: 'replay_shares_owner_game_key', cols: ['owner_user_id', 'game_id'] }
			],
			replay_frames: [
				{ name: 'replay_frames_pkey', cols: ['game_id', 'revision'] }
			],
			social_friendships: [{ name: 'social_friendships_pkey', cols: ['user_low', 'user_high'] }],
			social_blocks: [{ name: 'social_blocks_pkey', cols: ['blocker_user_id', 'blocked_user_id'] }],
			social_party_members: [
				{ name: 'social_party_members_pkey', cols: ['party_id', 'user_id'] },
				{ name: 'social_party_members_user_id_key', cols: ['user_id'] }
			],
			social_presence: [{ name: 'social_presence_pkey', cols: ['user_id', 'client_id'] }],
			social_invites: [{ name: 'social_invites_token_digest_key', cols: ['token_digest'] }]
		};
		for (const key of uniqueKeys[tableName] ?? []) {
			const dupe = rows.some((existing) => key.cols.every((col) => existing[col] === row[col]));
			if (dupe) {
				return {
					code: '23505',
					message: `duplicate key value violates unique constraint "${key.name}"`
				};
			}
		}
		return null;
	}

	// ── GoTrue (auth) emulation ────────────────────────────────────────────────────
	// Just enough of the Supabase Auth wire protocol for the ANONYMOUS identity path
	// both clients use: `POST /auth/v1/signup` with no email/phone (supabase-js
	// signInAnonymously + the Godot AuthClient), `POST /auth/v1/token?grant_type=
	// refresh_token`, and `GET /auth/v1/user` (how hooks.server.ts safeGetSession and
	// the room server validate a Bearer token). Users live in table('auth','users');
	// sessions in table('auth','sessions'); a public.profiles row mirrors the
	// 20260620_auth_profiles trigger. Tokens are opaque `emu-…` strings — honest for
	// a local stack (the emulator IS the validator), never JWT-shaped.
	private async handleAuth(
		route: string,
		req: IncomingMessage,
		res: ServerResponse,
		url: URL
	): Promise<void> {
		const users = this.table('auth', 'users');
		const sessions = this.table('auth', 'sessions');

		const mintSession = (user: Row) => {
			const session = {
				access_token: `emu-${randomUUID()}`,
				refresh_token: `emur-${randomUUID()}`,
				user_id: user.id
			};
			sessions.push(session);
			return {
				access_token: session.access_token,
				token_type: 'bearer',
				expires_in: 3600,
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				refresh_token: session.refresh_token,
				user
			};
		};

		if (route === 'signup' && req.method === 'POST') {
			const body = (await this.body(req)) ?? {};
			if (body.email || body.phone) {
				return this.send(res, 422, {
					code: 'email_provider_disabled',
					message: 'pgrestEmu auth supports anonymous sign-ins only'
				});
			}
			const meta = body.data && typeof body.data === 'object' ? body.data : {};
			const now = new Date().toISOString();
			const user: Row = {
				id: randomUUID(),
				aud: 'authenticated',
				role: 'authenticated',
				email: null,
				is_anonymous: true,
				user_metadata: jsonb(meta),
				app_metadata: {},
				created_at: now,
				updated_at: now
			};
			users.push(user);
			// The 20260620_auth_profiles trigger, emulated.
			this.table('public', 'profiles').push({
				id: user.id,
				display_name:
					typeof (meta as Row).display_name === 'string' && (meta as Row).display_name.trim()
						? String((meta as Row).display_name)
								.trim()
								.slice(0, 40)
						: 'Nameless Spirit',
				is_anonymous: true,
				created_at: now,
				updated_at: now
			});
			return this.send(res, 200, mintSession(user));
		}

		if (route === 'token' && req.method === 'POST') {
			if (url.searchParams.get('grant_type') !== 'refresh_token') {
				return this.send(res, 400, {
					code: 'unsupported_grant_type',
					message: 'refresh_token only'
				});
			}
			const body = (await this.body(req)) ?? {};
			const idx = sessions.findIndex((s) => s.refresh_token === body.refresh_token);
			if (idx === -1) {
				return this.send(res, 400, {
					code: 'refresh_token_not_found',
					message: 'Invalid Refresh Token'
				});
			}
			const user = users.find((u) => u.id === sessions[idx].user_id);
			sessions.splice(idx, 1); // single-use rotation, like GoTrue
			if (!user) return this.send(res, 400, { code: 'user_not_found', message: 'User not found' });
			return this.send(res, 200, mintSession(user));
		}

		if (route === 'user' && req.method === 'GET') {
			const authz = String(req.headers.authorization ?? '');
			const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
			const session = sessions.find((s) => s.access_token === token);
			const user = session ? users.find((u) => u.id === session.user_id) : null;
			if (!user)
				return this.send(res, 401, {
					code: 'bad_jwt',
					message: 'invalid claim: missing sub claim'
				});
			return this.send(res, 200, user);
		}

		if (route === 'logout' && req.method === 'POST') {
			return this.send(res, 204, undefined);
		}

		return this.send(res, 404, {
			message: `pgrestEmu auth: no route ${req.method} ${url.pathname}`
		});
	}

	/** The `mint_ws_ticket(session, user, member, role, digest)` mint function
	 *  (20260710_identity_trust.sql), mirrored on the wire: the caller submits ONLY
	 *  the digest and the authoritative bindings; created_at/expires_at are fixed
	 *  from the EMULATOR's clock (the "database" time) with the 30-second lifetime
	 *  baked in — the real function accepts no time or TTL argument, so neither
	 *  does this one. Mirrors NOT NULL bindings, the role CHECK, and the unique
	 *  digest index. */
	private mintWsTicketRpc(args: any, res: ServerResponse, schema: string): void {
		const sessionId = args?.p_session_id;
		const userId = args?.p_user_id;
		const digest = args?.p_digest;
		const role = args?.p_role;
		if (sessionId == null || userId == null || digest == null) {
			return this.send(res, 400, {
				code: '23502',
				message: 'null value in column of relation "play_ws_tickets" violates not-null constraint'
			});
		}
		if (role !== 'member' && role !== 'spectator') {
			return this.send(res, 400, {
				code: '23514',
				message:
					'new row for relation "play_ws_tickets" violates check constraint "play_ws_tickets_role_check"'
			});
		}
		const rows = this.table(schema, 'play_ws_tickets');
		if (rows.some((existing) => existing.digest === digest)) {
			return this.send(res, 400, {
				code: '23505',
				message: 'duplicate key value violates unique constraint "play_ws_tickets_digest_key"'
			});
		}
		const nowMs = Date.now();
		const row = jsonb({
			id: randomUUID(),
			session_id: sessionId,
			user_id: userId,
			member_id: args?.p_member_id ?? null,
			role,
			digest,
			expires_at: new Date(nowMs + 30_000).toISOString(),
			consumed_at: null,
			created_at: new Date(nowMs).toISOString()
		}) as Row;
		rows.push(row);
		return this.send(res, 200, [jsonb(row)]);
	}

	/** The `cleanup_ws_tickets()` hygiene function (20260710_identity_trust.sql),
	 *  mirrored on the wire: deletes only rows the EMULATOR's clock says expired
	 *  over ten minutes ago; returns the count. No caller-supplied cutoff exists. */
	private cleanupWsTicketsRpc(res: ServerResponse, schema: string): void {
		const cutoffMs = Date.now() - 10 * 60_000;
		const rows = this.table(schema, 'play_ws_tickets');
		let removed = 0;
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const expires = rows[i]?.expires_at;
			if (typeof expires === 'string' && Date.parse(expires) < cutoffMs) {
				rows.splice(i, 1);
				removed += 1;
			}
		}
		return this.send(res, 200, removed);
	}

	/** The `consume_ws_ticket(p_digest)` one-use redemption function
	 *  (20260710_identity_trust.sql), mirrored on the wire: one conditional UPDATE
	 *  (`consumed_at IS NULL AND expires_at > now()`) whose clock is the emulator's
	 *  own Date.now() — exactly one winner per digest, expired digests unclaimable. */
	private consumeWsTicketRpc(args: any, res: ServerResponse, schema: string): void {
		const digest = args?.p_digest;
		const rows = this.table(schema, 'play_ws_tickets');
		const nowMs = Date.now();
		const row =
			typeof digest === 'string' && digest.length > 0
				? rows.find(
						(candidate) =>
							candidate.digest === digest &&
							candidate.consumed_at == null &&
							typeof candidate.expires_at === 'string' &&
							Date.parse(candidate.expires_at) > nowMs
					)
				: undefined;
		if (!row) return this.send(res, 200, []);
		row.consumed_at = new Date(nowMs).toISOString();
		return this.send(res, 200, [jsonb(row)]);
	}

	/**
	 * The `arc_spirits_2d.try_form_ranked_match` advisory-locked pairing function,
	 * emulated to its DOCUMENTED semantics (the SQL itself is applied to the live
	 * project only — see matchmaking.ts): atomically claim ONE in-window group of
	 * p_lobby_size queued players containing at least one human, flip the chosen
	 * rows to status='matched' in the same step, and return them. The window is the
	 * ordinal spread p_base_window + p_widen_per_sec × (oldest queued human's wait),
	 * capped at p_max_window. Single JS turn ⇒ the advisory lock is implicit.
	 */
	private tryFormRankedMatchRpc(args: any, res: ServerResponse, schema: string): void {
		const queue = this.table(schema, 'match_queue');
		const lobbySize = Number(args?.p_lobby_size ?? 4);
		const baseWindow = Number(args?.p_base_window ?? 5);
		const widenPerSec = Number(args?.p_widen_per_sec ?? 0.5);
		const maxWindow = Number(args?.p_max_window ?? 100);

		const queued = queue.filter((row) => row.status === 'queued');
		const humans = queued
			.filter((row) => !row.is_bot)
			.sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
		const anchor = humans[0];
		if (!anchor || queued.length < lobbySize) return this.send(res, 200, []);

		const waitSec = Math.max(0, (Date.now() - Date.parse(String(anchor.queued_at))) / 1000);
		const window = Math.min(baseWindow + widenPerSec * waitSec, maxWindow);

		const anchorOrdinal = Number(anchor.ordinal ?? 0);
		const group = [
			anchor,
			...queued
				.filter((row) => row !== anchor)
				.map((row) => ({ row, dist: Math.abs(Number(row.ordinal ?? 0) - anchorOrdinal) }))
				.filter(({ dist }) => dist <= window)
				.sort((a, b) => a.dist - b.dist)
				.slice(0, lobbySize - 1)
				.map(({ row }) => row)
		];
		if (group.length < lobbySize) return this.send(res, 200, []);

		const now = new Date().toISOString();
		for (const row of group) {
			row.status = 'matched';
			row.updated_at = now;
		}
		return this.send(
			res,
			200,
			group.map((row) =>
				jsonb({
					user_id: row.user_id,
					display_name: row.display_name ?? null,
					status: row.status,
					is_bot: row.is_bot ?? false,
					bot_profile: row.bot_profile ?? null
				})
			)
		);
	}

	private handleRpc(fn: string, args: any, res: ServerResponse, schema: string): void {
		if (fn === 'mint_ws_ticket') {
			// The ticket lifecycle functions are available in BOTH store postures: they
			// ship in the SAME migration as the ticket table (20260710_identity_trust),
			// so any store holding tickets holds them. Their clock is the EMULATOR's
			// own Date.now() — the "database" time — never a caller-supplied timestamp
			// or TTL (the real functions accept none).
			return this.mintWsTicketRpc(args, res, schema);
		}
		if (fn === 'cleanup_ws_tickets') {
			return this.cleanupWsTicketsRpc(res, schema);
		}
		if (fn === 'consume_ws_ticket') {
			return this.consumeWsTicketRpc(args, res, schema);
		}
		if (fn === 'try_form_ranked_match') {
			return this.tryFormRankedMatchRpc(args, res, schema);
		}
		if (fn === 'reconcile_player_progression') {
			return this.reconcileProgressionRpc(String(args?.p_user_id ?? ''), res, schema);
		}
		if (fn === 'purchase_cosmetic') {
			return this.purchaseCosmeticRpc(String(args?.p_user_id ?? ''), String(args?.p_item_id ?? ''), res, schema);
		}
		if (fn === 'equip_cosmetic') {
			return this.equipCosmeticRpc(String(args?.p_user_id ?? ''), String(args?.p_item_id ?? ''), args?.p_guardian_name == null ? null : String(args.p_guardian_name), res, schema);
		}
		if (fn === 'apply_ranked_season_result') {
			return this.applyRankedSeasonRpc(args, res, schema);
		}
		if (fn === 'ensure_ranked_season_player') {
			const rows = this.table(schema, 'ranked_player_seasons');
			const exists = rows.some((row) => row.season_id === args.p_season_id && row.user_id === args.p_user_id);
			if (!exists) rows.push({ season_id: args.p_season_id, user_id: args.p_user_id,
				display_name: args.p_display_name, mu: 25, sigma: 25 / 3, games_played: 0, wins: 0,
				placements_completed: 0, peak_ordinal: 0, is_bot: !!args.p_is_bot });
			return this.send(res, 200, { created: !exists, reset: false });
		}
		if (fn === 'apply_ranked_decay') return this.send(res, 200, { decayed: false });
		if (fn === 'takeover_stale_ranked_members') {
			const session = this.table(schema, 'play_game_sessions').find((row) => row.id === args.p_session_id);
			if (!session || session.status !== 'active' || session.mode !== 'ranked' || !session.ranked_season_id)
				return this.send(res, 200, { takenOver: 0, reason: 'not_active_ranked' });
			const cutoff = Date.now() - 120_000;
			const members = this.table(schema, 'play_session_members');
			const humans = members.filter((row) => row.session_id === session.id && !row.is_bot && row.user_id);
			if (!humans.some((row) => Date.parse(String(row.last_seen_at ?? '')) >= cutoff))
				return this.send(res, 200, { takenOver: 0, allHumansGone: true });
			const participation = this.table(schema, 'ranked_participation');
			let takenOver = 0;
			for (const member of humans.filter((row) => Date.parse(String(row.last_seen_at ?? '')) < cutoff)) {
				const prior = participation.find((row) => row.session_id === session.id && row.member_id === member.id);
				if (prior?.abandoned) continue;
				const values = { session_id: session.id, member_id: member.id, season_id: session.ranked_season_id,
					user_id: member.user_id, abandoned: true, abandonment_kind: 'disconnect_deadline',
					abandoned_at: new Date().toISOString(), bot_controlled_at: new Date().toISOString() };
				if (prior) Object.assign(prior, values); else participation.push(values);
				member.is_bot = true; member.bot_profile = member.bot_profile ?? 'neural-v1';
				member.updated_at = new Date().toISOString();
				takenOver += 1;
			}
			if (takenOver > 0) {
				session.revision = Number(session.revision ?? 0) + 1;
				session.public_state = { ...(session.public_state ?? {}), revision: session.revision };
				this.table(schema, 'play_game_session_events').push({ session_id: session.id,
					revision: session.revision, actor_member_id: null, command_type: 'rankedDisconnectTakeover',
					command_payload: { takenOver, graceSeconds: 120 } });
			}
			return this.send(res, 200, { takenOver, revision: session.revision });
		}
		if (fn === 'concede_ranked_member') {
			const member = this.table(schema, 'play_session_members').find((row) =>
				row.session_id === args.p_session_id && row.user_id === args.p_user_id);
			const session = this.table(schema, 'play_game_sessions').find((row) => row.id === args.p_session_id);
			if (!member || session?.status !== 'active' || session?.mode !== 'ranked')
				return this.send(res, 400, { message: 'ranked_match_not_active' });
			member.is_bot = true; member.bot_profile = member.bot_profile ?? 'neural-v1';
			const participation = this.table(schema, 'ranked_participation');
			if (!participation.some((row) => row.session_id === session.id && row.member_id === member.id))
				participation.push({ session_id: session.id, member_id: member.id, season_id: session.ranked_season_id,
					user_id: member.user_id, abandoned: true, abandonment_kind: 'concede', abandoned_at: new Date().toISOString() });
			return this.send(res, 200, { conceded: true });
		}
		if (this.rpcEnabled && fn === 'finalize_match') {
			return this.finalizeMatchRpc(args, res, schema);
		}
		if (fn !== 'commit_room_command' || !this.rpcEnabled) {
			return this.send(res, 404, {
				code: 'PGRST202',
				message: `Could not find the function ${schema}.${fn} in the schema cache`
			});
		}
		const sessions = this.table(schema, 'play_game_sessions');
		const events = this.table(schema, 'play_game_session_events');
		const list: Row[] = Array.isArray(args?.p_events) ? args.p_events : [];

		// Strict monotonicity + coherence — mirrors the RPC's raise-exception guards.
		const expected = args?.p_expected_revision as number;
		const next = args?.p_next_revision as number;
		if (typeof next !== 'number' || next <= expected) {
			return this.send(res, 400, {
				code: 'P0001',
				message: `commit_room_command: p_next_revision (${String(next)}) must exceed p_expected_revision (${String(expected)}) — revision_not_monotonic`
			});
		}
		if (args?.p_public_state?.revision !== next) {
			return this.send(res, 400, {
				code: 'P0001',
				message: `commit_room_command: p_public_state.revision must equal p_next_revision (${next}) — revision_incoherent`
			});
		}
		for (const event of list) {
			if (!(event.revision > expected && event.revision <= next)) {
				return this.send(res, 400, {
					code: 'P0001',
					message: `commit_room_command: event revision ${String(event.revision)} outside (${expected}, ${next}] — event_revision_incoherent`
				});
			}
		}

		for (const event of list) {
			const cmdId = event?.command_payload?.cmdId;
			if (cmdId == null) continue;
			const existing = events.find(
				(row) => row.session_id === args.p_session_id && row.command_payload?.cmdId === cmdId
			);
			if (existing) {
				// Identity-bound dedup: honest retry → duplicate; different actor/type/
				// payload under the same cmdId → idempotency_conflict.
				const stored = commandFingerprint(
					existing.actor_member_id ?? null,
					existing.command_type,
					existing.command_payload ?? {}
				);
				const incoming = commandFingerprint(
					event.actor_member_id ?? null,
					event.command_type,
					event.command_payload ?? {}
				);
				return this.send(res, 200, {
					outcome: stored === incoming ? 'duplicate' : 'idempotency_conflict',
					revision: existing.revision
				});
			}
		}

		const row = sessions.find(
			(candidate) =>
				candidate.id === args.p_session_id && candidate.revision === args.p_expected_revision
		);
		if (!row) return this.send(res, 200, { outcome: 'cas_miss' });

		const now = new Date().toISOString();
		row.status = args.p_status;
		row.revision = args.p_next_revision;
		row.game_id = args.p_game_id;
		row.scenario = jsonb(args.p_scenario);
		row.public_state = jsonb(args.p_public_state);
		if (args.p_stamp_started_at && row.started_at == null) row.started_at = now;
		if (args.p_stamp_ended_at && row.ended_at == null) row.ended_at = now;
		if ('updated_at' in row) row.updated_at = now;

		for (const event of list) {
			events.push(
				jsonb({
					id: randomUUID(),
					created_at: now,
					session_id: args.p_session_id,
					revision: event.revision,
					actor_member_id: event.actor_member_id ?? null,
					command_type: event.command_type,
					command_payload: event.command_payload ?? {}
				})
			);
		}
		this.send(res, 200, { outcome: 'committed', row: jsonb(row) });
	}

	/** Server-trusted progression RPCs from 20260713_progression_cosmetics.sql.
	 *  The emulator is single-threaded; unique-ledger semantics are mirrored by
	 *  explicit key checks while PostgreSQL proves transaction locking. */
	private progressionSnapshot(userId: string, schema: string): Row {
		const progression = this.table(schema, 'player_progression').find((row) => row.user_id === userId)!;
		const loadout = this.table(schema, 'player_loadouts').find((row) => row.user_id === userId)!;
		const owned = this.table(schema, 'player_cosmetic_ownership')
			.filter((row) => row.user_id === userId).map((row) => row.item_id).sort();
		const mastery = this.table(schema, 'guardian_mastery')
			.filter((row) => row.user_id === userId)
			.map((row) => ({ guardianName: row.guardian_name, masteryXp: row.mastery_xp,
				masteryLevel: row.mastery_level, gamesPlayed: row.games_played, wins: row.wins }))
			.sort((a, b) => a.guardianName.localeCompare(b.guardianName));
		return jsonb({
			credits: progression.credits, lifetimeCredits: progression.lifetime_credits,
			rankXp: progression.account_xp, accountXp: progression.account_xp,
			ownedItemIds: owned,
			equippedBorderId: loadout.equipped_border_id ?? null,
			equippedBannerId: loadout.equipped_banner_id ?? null,
			equippedGuardianSkinIds: loadout.equipped_guardian_skins ?? {},
			equippedBoardEnvironmentId: loadout.equipped_board_environment_id ?? null,
			equippedSummonTrailId: loadout.equipped_summon_trail_id ?? null,
			equippedCardFinishId: loadout.equipped_card_finish_id ?? null,
			equippedNameplateId: loadout.equipped_nameplate_id ?? null,
			equippedEmoteId: loadout.equipped_emote_id ?? null,
			equippedVictoryPoseId: loadout.equipped_victory_pose_id ?? null,
			equippedProfileSceneId: loadout.equipped_profile_scene_id ?? null,
			guardianMastery: mastery,
			catalog: SHOP_ITEMS.map((item) => ({ ...item }))
		});
	}

	private reconcileProgression(userId: string, res: ServerResponse, schema: string): void {
		if (!userId) return this.send(res, 400, { message: 'user id required' });
		const progressions = this.table(schema, 'player_progression');
		const loadouts = this.table(schema, 'player_loadouts');
		if (!progressions.some((row) => row.user_id === userId)) {
			progressions.push({ user_id: userId, credits: 80, lifetime_credits: 80, account_xp: 0 });
		}
		if (!loadouts.some((row) => row.user_id === userId)) {
			loadouts.push({ user_id: userId, equipped_guardian_skins: {} });
		}
		const awards = this.table(schema, 'progression_awards');
		const mastery = this.table(schema, 'guardian_mastery');
		const members = this.table(schema, 'play_session_members');
		const results = this.table(schema, 'match_results');
		for (const player of this.table(schema, 'match_result_players')) {
			if (player.user_id !== userId || player.is_bot === true) continue;
			if (awards.some((row) => row.session_id === player.session_id && row.user_id === userId)) continue;
			const result = results.find((row) => row.session_id === player.session_id) ?? {};
			const award = calculateMatchAward({ matchId: String(player.session_id),
				victoryPoints: Number(player.victory_points ?? 0), placement: Number(player.placement ?? 0),
				won: Number(player.placement ?? 0) <= 1, round: Number(result.navigation_count ?? 0) });
			const member = members.find((row) => row.id === player.member_id);
			const guardian = String(member?.selected_guardian ?? '');
			const masteryXp = 10 + Math.max(0, Number(player.victory_points ?? 0)) + (Number(player.placement) <= 1 ? 20 : 0);
			awards.push({ session_id: player.session_id, user_id: userId, guardian_name: guardian || null,
				credits: award.credits, account_xp: award.rankXp, mastery_xp: masteryXp,
				placement: player.placement, victory_points: player.victory_points });
			const progression = progressions.find((row) => row.user_id === userId)!;
			progression.credits += award.credits;
			progression.lifetime_credits += award.credits;
			progression.account_xp += award.rankXp;
			if (guardian) {
				let row = mastery.find((value) => value.user_id === userId && value.guardian_name === guardian);
				if (!row) { row = { user_id: userId, guardian_name: guardian, mastery_xp: 0, games_played: 0, wins: 0 }; mastery.push(row); }
				row.mastery_xp += masteryXp; row.games_played += 1; row.wins += Number(player.placement) <= 1 ? 1 : 0;
				row.mastery_level = 1 + Math.floor(Math.sqrt(row.mastery_xp / 25));
			}
		}
	}

	private reconcileProgressionRpc(userId: string, res: ServerResponse, schema: string): void {
		this.reconcileProgression(userId, res, schema);
		if (!userId) return;
		this.send(res, 200, this.progressionSnapshot(userId, schema));
	}

	private purchaseCosmeticRpc(userId: string, itemId: string, res: ServerResponse, schema: string): void {
		this.reconcileProgression(userId, res, schema);
		if (!userId) return;
		const item = SHOP_ITEMS.find((value) => value.id === itemId);
		if (!item) return this.send(res, 400, { message: 'cosmetic_not_found' });
		const ownership = this.table(schema, 'player_cosmetic_ownership');
		if (!ownership.some((row) => row.user_id === userId && row.item_id === itemId)) {
			const progression = this.table(schema, 'player_progression').find((row) => row.user_id === userId)!;
			if (progression.credits < item.price) return this.send(res, 400, { message: 'insufficient_credits' });
			progression.credits -= item.price;
			ownership.push({ user_id: userId, item_id: itemId, source: 'purchase' });
		}
		this.send(res, 200, this.progressionSnapshot(userId, schema));
	}

	private equipCosmeticRpc(userId: string, itemId: string, guardianName: string | null, res: ServerResponse, schema: string): void {
		this.reconcileProgression(userId, res, schema);
		if (!userId) return;
		const item = SHOP_ITEMS.find((value) => value.id === itemId);
		const owned = this.table(schema, 'player_cosmetic_ownership').some((row) => row.user_id === userId && row.item_id === itemId);
		if (!item || !owned) return this.send(res, 400, { message: 'cosmetic_not_owned' });
		const loadout = this.table(schema, 'player_loadouts').find((row) => row.user_id === userId)!;
		const field: Record<string, string> = { border: 'equipped_border_id', banner: 'equipped_banner_id',
			boardEnvironment: 'equipped_board_environment_id', summonTrail: 'equipped_summon_trail_id',
			cardFinish: 'equipped_card_finish_id', nameplate: 'equipped_nameplate_id', emote: 'equipped_emote_id',
			victoryPose: 'equipped_victory_pose_id', profileScene: 'equipped_profile_scene_id' };
		if (item.kind === 'guardianSkin') {
			loadout.equipped_guardian_skins = { ...(loadout.equipped_guardian_skins ?? {}), [guardianName || item.targetGuardian || 'Any Guardian']: itemId };
		} else loadout[field[item.kind]] = itemId;
		this.send(res, 200, this.progressionSnapshot(userId, schema));
	}

	private applyRankedSeasonRpc(args: any, res: ServerResponse, schema: string): void {
		const sessionId = String(args?.p_session_id ?? '');
		const seasonId = String(args?.p_season_id ?? '');
		const payload: Row[] = Array.isArray(args?.p_ratings) ? args.p_ratings : [];
		const anchor = this.table(schema, 'match_results').find((row) => row.session_id === sessionId);
		if (!anchor?.rated || anchor?.quarantined) return this.send(res, 400, { code: 'P0001', message: 'season_result_unrated' });
		const events = this.table(schema, 'ranked_season_rating_events');
		const eventKey = `match:${sessionId}`;
		if (events.some((row) => row.season_id === seasonId && row.event_key === eventKey))
			return this.send(res, 200, { outcome: 'already_applied' });
		const players = this.table(schema, 'ranked_player_seasons');
		for (const item of payload) {
			const current = players.find((row) => row.season_id === seasonId && row.user_id === item.user_id);
			const stale = item.expected_games == null ? current != null : current == null ||
				current.games_played !== item.expected_games || Math.abs(current.mu - item.expected_mu) > 1e-4 ||
				Math.abs(current.sigma - item.expected_sigma) > 1e-4;
			if (stale) return this.send(res, 400, { code: 'P0001', message: 'stale_season_ratings' });
		}
		const achievements = this.table(schema, 'player_achievements');
		const ownership = this.table(schema, 'player_cosmetic_ownership');
		const bridge = this.table(schema, 'platform_bridge_outbox');
		for (const item of payload) {
			events.push({ id: randomUUID(), season_id: seasonId, session_id: sessionId, user_id: item.user_id,
				event_kind: 'match', event_key: eventKey, placement: item.placement, mu_before: item.mu_before,
				sigma_before: item.sigma_before, mu_after: item.mu_after, sigma_after: item.sigma_after,
				created_at: new Date().toISOString() });
			let current = players.find((row) => row.season_id === seasonId && row.user_id === item.user_id);
			const nextOrdinal = item.mu_after - 3 * item.sigma_after;
			if (!current) {
				current = { season_id: seasonId, user_id: item.user_id, display_name: item.display_name,
					mu: item.mu_after, sigma: item.sigma_after, games_played: 0, wins: 0,
					placements_completed: 0, peak_ordinal: 0, is_bot: !!item.is_bot };
				players.push(current);
			}
			current.mu = item.mu_after; current.sigma = item.sigma_after; current.games_played += 1;
			current.wins += item.placement === 1 ? 1 : 0;
			current.placements_completed = Math.min(5, current.placements_completed + 1);
			current.peak_ordinal = Math.max(current.peak_ordinal, nextOrdinal);
			current.last_session_id = sessionId; current.last_activity_at = new Date().toISOString();
			if (!item.is_bot) {
				const unlocked = ['first-ranked-match', ...(item.placement === 1 ? ['first-ranked-win'] : []),
					...(current.placements_completed >= 5 ? ['placements-complete'] : []), ...(nextOrdinal >= 15 ? ['reach-gold'] : [])];
				for (const id of unlocked) {
					if (!achievements.some((row) => row.user_id === item.user_id && row.achievement_id === id))
						achievements.push({ user_id: item.user_id, achievement_id: id, progress: id === 'placements-complete' ? 5 : 1,
							target: id === 'placements-complete' ? 5 : 1, unlocked_at: new Date().toISOString(), source_event_key: eventKey });
					const reward = id === 'placements-complete' ? 'border-ranked-first-light' : id === 'reach-gold' ? 'nameplate-ranked-gold' : null;
					if (reward && !ownership.some((row) => row.user_id === item.user_id && row.item_id === reward))
						ownership.push({ user_id: item.user_id, item_id: reward, source: 'achievement', unlocked_at: new Date().toISOString() });
					if (!bridge.some((row) => row.user_id === item.user_id && row.event_key === `achievement:${id}`))
						bridge.push({ id: randomUUID(), user_id: item.user_id, event_key: `achievement:${id}`,
							event_kind: 'achievement', payload: { achievementId: id }, created_at: new Date().toISOString() });
				}
			}
		}
		anchor.ranked_season_id = seasonId;
		return this.send(res, 200, { outcome: 'applied' });
	}

	/** The `finalize_match` transaction (20260710_ranked_finalize.sql), mirrored on
	 *  the wire: anchor claim on UNIQUE(session_id), player-row repair on the
	 *  already-finalized path, legacy partial-attempt markers, locked-base
	 *  verification (stale_ratings aborts before any write ⇒ full rollback).
	 *  NOT mirrored: the real function's advisory/row locks — this body runs in one
	 *  JS turn, so interleaved-transaction schedules cannot arise here; PostgreSQL
	 *  locking is proven in src/lib/play/server/matchFinalize.pg.test.ts. */
	private finalizeMatchRpc(args: any, res: ServerResponse, schema: string): void {
		const sid = args?.p_session_id;
		const results = this.table(schema, 'match_results');
		const players = this.table(schema, 'match_result_players');
		const ratings = this.table(schema, 'player_ratings');
		const events = this.table(schema, 'player_rating_events');
		const playerList: Row[] = Array.isArray(args?.p_players) ? args.p_players : [];
		const ratingList: Row[] = Array.isArray(args?.p_ratings) ? args.p_ratings : [];
		const now = new Date().toISOString();

		const insertMissingPlayers = () => {
			for (const p of playerList) {
				if (!players.some((row) => row.session_id === sid && row.seat_color === p.seat_color)) {
					players.push(jsonb({ id: randomUUID(), created_at: now, ...p, session_id: sid }));
				}
			}
		};

		if (results.some((row) => row.session_id === sid)) {
			insertMissingPlayers();
			return this.send(res, 200, { outcome: 'already_finalized' });
		}

		let apply = ratingList.length > 0;
		let rated = false;
		if (apply && events.some((row) => row.session_id === sid)) {
			apply = false;
			rated = true;
		}
		if (apply) {
			for (const r of ratingList) {
				const row = ratings.find((x) => x.user_id === r.user_id);
				if (row && row.last_session_id === sid) {
					apply = false;
					rated = true;
					break;
				}
			}
		}
		if (apply) {
			for (const r of ratingList) {
				const row = ratings.find((x) => x.user_id === r.user_id) ?? null;
				const stale =
					r.expected_games == null
						? row != null
						: row == null ||
							row.games_played !== r.expected_games ||
							Math.abs(row.mu - r.expected_mu) > 1e-4 ||
							Math.abs(row.sigma - r.expected_sigma) > 1e-4;
				if (stale) {
					return this.send(res, 400, {
						code: 'P0001',
						message: `finalize_match: stale_ratings (user ${r.user_id} changed since the caller computed updates)`
					});
				}
			}
			for (const r of ratingList) {
				events.push(
					jsonb({
						id: randomUUID(),
						created_at: now,
						session_id: sid,
						user_id: r.user_id,
						placement: r.placement,
						mu_before: r.mu_before,
						sigma_before: r.sigma_before,
						mu_after: r.mu_after,
						sigma_after: r.sigma_after,
						rating_version: r.rating_version ?? 1
					})
				);
				const next = {
					user_id: r.user_id,
					display_name: r.display_name ?? null,
					mu: r.mu_after,
					sigma: r.sigma_after,
					games_played: (r.expected_games ?? 0) + 1,
					last_session_id: sid,
					last_game_at: r.last_game_at ?? null,
					rating_version: r.rating_version ?? 1,
					updated_at: now
				};
				const existing = ratings.find((x) => x.user_id === r.user_id);
				if (existing) Object.assign(existing, jsonb(next));
				else ratings.push(jsonb(next));
			}
			rated = true;
		}

		results.push(
			jsonb({
				id: randomUUID(),
				created_at: now,
				...(args?.p_result ?? {}),
				session_id: sid,
				rated
			})
		);
		insertMissingPlayers();
		this.send(res, 200, { outcome: 'finalized', rated });
	}
}

// ── standalone entry ─────────────────────────────────────────────────────────────
// `npx tsx server/pgrestEmu.ts --listen 8095 [--rpc]` runs the emulator as its own
// process, so OTHER harnesses (e.g. `node server/smoke.mjs` with
// PUBLIC_SUPABASE_URL=http://127.0.0.1:8095) can exercise the full server stack
// against a local store.
const listenArg = process.argv.indexOf('--listen');
if (listenArg !== -1) {
	const port = Number(process.argv[listenArg + 1] ?? 8095);
	const emu = new PgrestEmu({ rpc: process.argv.includes('--rpc') });
	void emu.listen(port).then(() => {
		console.log(`[pgrest-emu] listening on :${port} (rpc=${emu.rpcEnabled ? 'on' : 'off'})`);
	});
}
