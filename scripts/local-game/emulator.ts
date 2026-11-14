// The local game's database: the in-memory emulator (server/pgrestEmu.ts) plus save files, so
// rooms, finished games, replays and anonymous accounts survive a restart.
//
//   node --import tsx scripts/local-game/emulator.ts --port <port> [--state <dir>]
//
// The emulator keeps every table as a plain array of JSON rows (schema -> table -> rows). With
// --state, each table is one file, <dir>/<schema>.<table>.json, loaded before the server starts.
// After a successful write request the tables it can have changed are written again, about a
// second later (temp file + rename, so a crash leaves the old or the new file, never half a one):
//   POST/PATCH/DELETE /rest/v1/<table>   that table (Content-Profile schema)
//   /rest/v1/rpc/<fn>                    every table of that schema (the RPCs stay in it)
//   /auth/v1/*                           the auth and public schemas (users, sessions, profiles)
// So the big append-only replay table is rewritten only when a frame is added, not on every move.
// Without --state it is the plain in-memory store.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PgrestEmu } from '../../server/pgrestEmu';

type Row = Record<string, unknown>;
type Schemas = Map<string, Map<string, Row[]>>;

const { values: args } = parseArgs({
	options: {
		port: { type: 'string' },
		state: { type: 'string' }
	}
});
const port = Number(args.port);
if (!port) throw new Error('emulator.ts: --port is required');
const stateDir = args.state;
const SAVE_DELAY_MS = 1000;

const emu = new PgrestEmu({ rpc: true });
// `schemas` and `handle` are private in TypeScript only: the store and the request handler.
const inner = emu as unknown as {
	schemas: Schemas;
	handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

function load(dir: string): void {
	let rows = 0;
	let tables = 0;
	for (const name of readdirSync(dir)) {
		const m = name.match(/^([^.]+)\.([^.]+)\.json$/);
		if (!m) continue;
		const list = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Row[];
		if (!Array.isArray(list)) continue;
		// Replace the table (also the ones the constructor seeds: they are saved once written).
		const target = emu.table(m[1], m[2]);
		target.splice(0, target.length, ...list);
		rows += list.length;
		tables++;
	}
	console.log(`[local-emu] loaded ${rows} rows in ${tables} tables from ${dir}`);
}

const dirty = new Set<string>(); // "schema\ttable"
let saveTimer: NodeJS.Timeout | null = null;

function saveDirty(dir: string): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = null;
	for (const key of [...dirty]) {
		dirty.delete(key);
		const [schema, table] = key.split('\t');
		const file = join(dir, `${schema}.${table}.json`);
		try {
			writeFileSync(`${file}.tmp`, JSON.stringify(emu.table(schema, table)), { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		} catch (error) {
			dirty.add(key); // try again with the next save
			console.error(`[local-emu] save ${schema}.${table} failed: ${(error as Error).message}`);
		}
	}
}

function markWritten(dir: string, req: IncomingMessage): void {
	const parts = new URL(req.url ?? '/', 'http://local').pathname.split('/').filter(Boolean);
	const schema = String(req.headers['content-profile'] ?? 'public');
	const tablesOf = (s: string) => [...(inner.schemas.get(s)?.keys() ?? [])].map((t) => `${s}\t${t}`);
	let keys: string[] = [];
	if (parts[0] === 'auth') keys = [...tablesOf('auth'), ...tablesOf('public')];
	else if (parts[0] === 'rest' && parts[2] === 'rpc') keys = tablesOf(schema);
	else if (parts[0] === 'rest' && parts[2]) keys = [`${schema}\t${parts[2]}`];
	for (const key of keys) dirty.add(key);
	if (dirty.size > 0 && !saveTimer) saveTimer = setTimeout(() => saveDirty(dir), SAVE_DELAY_MS);
}

if (stateDir) {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	load(stateDir);
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			saveDirty(stateDir);
			process.exit(0);
		});
	}
}

// Own HTTP server instead of emu.listen(), which binds every interface: this one is loopback only.
const handle = inner.handle.bind(emu);
const server = createServer((req, res) => {
	if (stateDir && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
		res.once('finish', () => {
			if (res.statusCode < 400) markWritten(stateDir, req);
		});
	}
	void handle(req, res);
});
server.listen(port, '127.0.0.1', () => {
	console.log(`[local-emu] listening on 127.0.0.1:${port}${stateDir ? `, saving to ${stateDir}` : ' (memory only)'}`);
});
