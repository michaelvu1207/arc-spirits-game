// The local stand-in for the Supabase project. The app reaches it through the Vite dev server
// (same origin), so the Content Security Policy needs no change.
//
//   GET  /rest/v1/<table>  (Accept-Profile: arc_spirits_assets)  rows from the local JSON
//   any write to arc_spirits_assets, any storage upload           refused (403)
//   /storage/v1/{object,render/image}/public/game_assets/<path>  local image files (the raw art
//                                                                folder, or without one the
//                                                                web art in .art-cache/)
//   /realtime/v1/websocket, POST /realtime/v1/api/broadcast      realtime.mjs
//   GET  /__local/status                                         counts, missing images
//   everything else (game schema, auth, rpc)                     the in-memory emulator
//                                                                (server/pgrestEmu.ts)
// After a write to the game schema succeeds, the room revisions and members are compared with
// the last known state, and each room that changed gets a `sync` broadcast.
import zlib from 'node:zlib';
import http from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { buildImageIndex, createResizer, CONTENT_TYPES } from './images.mjs';
import { buildWebArtIndex } from './webArt.mjs';
import { loadLocalTables } from './localData.mjs';
import { createRealtime } from './realtime.mjs';

const ASSETS = 'arc_spirits_assets';
const STORAGE = /^\/storage\/v1\/(object|render\/image)\/public\/game_assets\/(.+)$/;

// Art folders whose contents feed the image index (see images.mjs).
const ART_DIRS = [
	'assets/exports/hex-spirits',
	'references/icons/classes',
	'references/icons/origins',
	'references/icons/icon_pool',
	'references/icons/runes'
];

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': '*',
	'access-control-allow-methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
	'access-control-expose-headers': 'content-range'
};

function parseFilters(params, log) {
	const out = [];
	const list = (raw, prefix) =>
		raw
			.slice(prefix.length, -1)
			.split(',')
			.map((v) => v.replace(/^"|"$/g, ''));
	for (const [key, raw] of params.entries()) {
		if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
		if (raw.startsWith('eq.')) out.push((r) => String(r[key]) === raw.slice(3));
		else if (raw.startsWith('neq.')) out.push((r) => String(r[key]) !== raw.slice(4));
		else if (raw.startsWith('in.(')) {
			const vals = list(raw, 'in.(');
			out.push((r) => vals.includes(String(r[key])));
		} else if (raw.startsWith('cs.{')) {
			const vals = list(raw, 'cs.{');
			out.push((r) => Array.isArray(r[key]) && vals.every((v) => r[key].includes(v)));
		} else if (raw === 'is.null') out.push((r) => r[key] == null);
		else if (raw === 'not.is.null') out.push((r) => r[key] != null);
		else {
			log(`unsupported filter ${key}=${raw} (ignored)`);
		}
	}
	return out;
}

function sendJson(res, status, body, extra = {}) {
	res.writeHead(status, { ...CORS, 'content-type': 'application/json', ...extra });
	res.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * Start the backend. Returns `{ server, port, summary, close }`.
 * `upstreamPort` is the emulator (server/pgrestEmu.ts --rpc).
 */
export async function startBackend({ port = 0, upstreamPort, gameDir, artDir, artCacheDir, repoRoot, spiritNamesFile, ttsDir, cacheDir, log }) {
	// The data is re-read when a file in the game dir (the data editor saves there) or one of the
	// art folders changes: at most one check per second, on the next request that needs the data.
	// Signature: the mtime of each game JSON file, plus the mtime of each art folder (changes
	// when a file is added or removed there).
	const mtime = (path) => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return 'missing';
		}
	};
	const signature = () => {
		let files = [];
		try {
			files = readdirSync(gameDir).filter((f) => f.endsWith('.json'));
		} catch {
			// no game dir: the signature stays the same until it appears
		}
		const art = artDir
			? ART_DIRS.map((rel) => `${rel}@${mtime(join(artDir, rel))}`)
			: [`web-art@${mtime(join(artCacheDir, 'current.json'))}`];
		return [...files.sort().map((f) => `${f}@${mtime(join(gameDir, f))}`), ...art].join('|');
	};
	let tables, notes, images;
	let loadedSignature = '';
	let checkedAt = 0;
	function load() {
		const sig = signature();
		const next = loadLocalTables({ gameDir, repoRoot });
		images = artDir
			? buildImageIndex({ tables: next.tables, extras: next.extras, artDir, spiritNamesFile, ttsDir })
			: buildWebArtIndex({ tables: next.tables, cacheDir: artCacheDir });
		({ tables, notes } = next);
		if (loadedSignature) log(`data reloaded from ${gameDir} (hex_spirits ${tables.hex_spirits.length})`);
		loadedSignature = sig;
	}
	function refresh() {
		const now = Date.now();
		if (now - checkedAt < 1000) return;
		checkedAt = now;
		if (signature() === loadedSignature) return;
		try {
			load();
		} catch (e) {
			// A file caught half-written by the editor: keep the old data, try again next time.
			log(`data reload failed, keeping the previous data: ${e?.message ?? e}`);
			checkedAt = now + 1000;
		}
	}
	load();
	const resized = createResizer(cacheDir);
	const realtime = createRealtime({ log });

	// ---- assets schema: local rows -------------------------------------------------------
	function serveAssets(req, res, url, table) {
		const rows = tables[table];
		if (!rows) log(`unknown assets table ${table}: []`);
		const filters = parseFilters(url.searchParams, log);
		let found = (rows ?? []).filter((r) => filters.every((f) => f(r)));
		const select = url.searchParams.get('select');
		if (select && select !== '*' && !/[()]/.test(select)) {
			const cols = select
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean);
			found = found.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
		}
		const limit = Number(url.searchParams.get('limit'));
		if (limit > 0) found = found.slice(0, limit);
		const range = { 'content-range': `0-${Math.max(found.length - 1, 0)}/${found.length}` };
		if (String(req.headers.accept ?? '').includes('vnd.pgrst.object+json')) {
			if (found.length !== 1) {
				return sendJson(
					res,
					406,
					{
						code: 'PGRST116',
						details: `Results contain ${found.length} rows, application/vnd.pgrst.object+json requires 1 row`,
						hint: null,
						message: 'JSON object requested, multiple (or no) rows returned'
					},
					range
				);
			}
			return sendJson(res, 200, found[0], range);
		}
		return sendJson(res, 200, req.method === 'HEAD' ? undefined : found, range);
	}

	// ---- storage: local files ------------------------------------------------------------
	async function serveImage(req, res, kind, path, url) {
		if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 403, { message: 'local storage is read only' });
		const file = images.resolve(path);
		if (!file) {
			res.writeHead(404, CORS);
			return res.end();
		}
		let out = { file, type: CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' };
		if (kind === 'render/image') {
			const edge = Math.max(Number(url.searchParams.get('width')) || 0, Number(url.searchParams.get('height')) || 0);
			out = (await resized(file, edge)) ?? out;
		}
		res.writeHead(200, { ...CORS, 'content-type': out.type, 'cache-control': 'no-cache' });
		if (req.method === 'HEAD') return res.end();
		createReadStream(out.file).pipe(res);
	}

	// ---- forward to the emulator + room change detection --------------------------------
	const lastSeen = new Map(); // room code -> fingerprint
	const writtenSchemas = new Set(); // schemas that had a write (the rooms are in arc_spirits_2d)
	let checkTimer = null;

	function upstreamGet(schema, path) {
		return new Promise((resolve) => {
			const req = http.request(
				{ host: '127.0.0.1', port: upstreamPort, method: 'GET', path, headers: { 'accept-profile': schema, accept: 'application/json' } },
				(r) => {
					const chunks = [];
					r.on('data', (c) => chunks.push(c));
					r.on('end', () => {
						try {
							resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
						} catch {
							resolve(null);
						}
					});
				}
			);
			req.on('error', () => resolve(null));
			req.end();
		});
	}

	// Member fields that only mark activity: a change there is not a room change.
	const ACTIVITY = /(_at|seen|heartbeat|ping)$/;
	async function checkRooms() {
		checkTimer = null;
		for (const schema of writtenSchemas) await checkSchema(schema);
	}
	async function checkSchema(schema) {
		const [sessions, members] = await Promise.all([
			upstreamGet(schema, '/rest/v1/play_game_sessions?select=id,room_code,revision,status'),
			upstreamGet(schema, '/rest/v1/play_session_members?select=*')
		]);
		if (!Array.isArray(sessions)) return;
		const bySession = new Map();
		for (const m of Array.isArray(members) ? members : []) {
			const kept = Object.fromEntries(Object.entries(m).filter(([k]) => !ACTIVITY.test(k)).sort(([a], [b]) => a.localeCompare(b)));
			(bySession.get(m.session_id) ?? bySession.set(m.session_id, []).get(m.session_id)).push(JSON.stringify(kept));
		}
		for (const s of sessions) {
			if (!s?.room_code) continue;
			const fingerprint = `${s.revision}|${s.status}|${(bySession.get(s.id) ?? []).sort().join(';')}`;
			if (lastSeen.get(s.room_code) === fingerprint) continue;
			lastSeen.set(s.room_code, fingerprint);
			const sent = realtime.broadcast(`realtime:room:${s.room_code}`, 'sync', { revision: s.revision });
			log(`sync room ${s.room_code} revision ${s.revision} -> ${sent} socket(s)`);
		}
	}
	const scheduleCheck = (schema) => {
		writtenSchemas.add(schema);
		checkTimer ??= setTimeout(() => void checkRooms(), 30);
	};

	function forward(req, res, body, isGameWrite) {
		const up = http.request(
			{
				host: '127.0.0.1',
				port: upstreamPort,
				method: req.method,
				path: req.url,
				headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` }
			},
			(r) => {
				// Big JSON answers (the explorer's seat history is several MB) go gzipped when the
				// client accepts it: over Tailscale that is the difference between ~15 s and ~2 s.
				const gzip =
					/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) &&
					!r.headers['content-encoding'] &&
					/json/.test(String(r.headers['content-type'] ?? ''));
				if (gzip) {
					const headers = { ...r.headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding' };
					delete headers['content-length'];
					res.writeHead(r.statusCode ?? 502, headers);
					r.pipe(zlib.createGzip({ level: 6 })).pipe(res);
				} else {
					res.writeHead(r.statusCode ?? 502, r.headers);
					r.pipe(res);
				}
				if (req.method !== 'GET' && req.method !== 'HEAD') log(`${req.method} ${req.url} -> ${r.statusCode}`);
				if (isGameWrite && (r.statusCode ?? 500) < 300) scheduleCheck(String(req.headers['content-profile'] ?? 'public'));
			}
		);
		up.on('error', (e) => {
			log(`emulator error ${req.method} ${req.url}: ${e.message}`);
			if (!res.headersSent) sendJson(res, 502, { message: 'local emulator not reachable' });
			else res.end();
		});
		up.end(body);
	}

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://local');
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = Buffer.concat(chunks);
			if (req.method === 'OPTIONS') {
				res.writeHead(204, CORS);
				return res.end();
			}
			refresh();
			if (url.pathname === '/__local/status') {
				return sendJson(res, 200, {
					tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
					images: images.stats,
					missingImages: [...images.missing].sort(),
					imagesFromTtsCache: [...images.fromTts].sort(),
					realtimeConnections: realtime.connections(),
					notes
				});
			}
			const storage = url.pathname.match(STORAGE);
			if (storage) return await serveImage(req, res, storage[1], decodeURIComponent(storage[2]), url);
			if (url.pathname.startsWith('/storage/')) return sendJson(res, 403, { message: 'local storage is read only' });
			if (url.pathname === '/realtime/v1/api/broadcast' && req.method === 'POST') {
				try {
					realtime.handleRestBroadcast(JSON.parse(body.toString('utf8') || '{}'));
				} catch {
					return sendJson(res, 400, { message: 'bad json' });
				}
				res.writeHead(202, CORS);
				return res.end();
			}
			const parts = url.pathname.split('/').filter(Boolean);
			const read = req.method === 'GET' || req.method === 'HEAD';
			const profile = read ? req.headers['accept-profile'] : req.headers['content-profile'];
			if (profile === ASSETS) {
				if (read && parts[0] === 'rest' && parts[2] !== 'rpc') return serveAssets(req, res, url, parts[2]);
				log(`refused ${req.method} ${req.url} (assets are read only)`);
				return sendJson(res, 403, { message: 'local assets are read only' });
			}
			const isGameWrite = !read && parts[0] === 'rest';
			return forward(req, res, body, isGameWrite);
		} catch (e) {
			log(`error ${req.method} ${req.url}: ${e?.stack ?? e}`);
			if (!res.headersSent) sendJson(res, 500, { message: 'local backend error' });
			else res.end();
		}
	});
	server.on('upgrade', (req, socket, head) => {
		if (String(req.url ?? '').startsWith('/realtime/v1/websocket')) return realtime.handleUpgrade(req, socket, head);
		socket.destroy();
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});

	const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
	return {
		server,
		port: server.address().port,
		summary: { counts, images: images.stats, notes },
		close: () => {
			realtime.close();
			server.close();
		}
	};
}
