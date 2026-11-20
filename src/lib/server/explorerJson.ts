import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

/**
 * Serves one JSON file of the balance tools to the explorer and the data editor (local game only).
 * The files are 0.4 to 2 MB of JSON and are read over a tailnet, so the answer is
 * - compressed (Brotli, or gzip), about a twentieth of the size;
 * - tagged: the browser keeps its copy and asks "changed?" each time; an unchanged file costs one
 *   small 304 answer instead of the whole download;
 * - made once per version of the file (its size and time of change), so a new file still shows
 *   without a restart.
 */
type Entry = { version: string; etag: string; raw: Buffer; br?: Buffer; gz?: Buffer };
const made = new Map<string, Entry>();

/** The data editor (port 8787 of this machine, or of its tailnet name) reads these files from its own pages. */
const EDITOR_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net):8787$/;

/** `shape` may rewrite the file's text before it is served. Returns null when the file cannot be read. */
export async function explorerJson(request: Request, file: string, shape?: (text: string) => string): Promise<Response | null> {
	let entry: Entry;
	try {
		const s = await stat(file);
		const version = `${s.mtimeMs}:${s.size}`;
		const have = made.get(file);
		if (have?.version === version) entry = have;
		else {
			const text = await readFile(file, 'utf8');
			const raw = Buffer.from(shape ? shape(text) : text);
			entry = { version, raw, etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"` };
			made.set(file, entry);
		}
	} catch {
		return null;
	}
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'cache-control': 'private, no-cache',
		etag: entry.etag,
		vary: 'Origin, Accept-Encoding'
	};
	const origin = request.headers.get('origin');
	if (origin && EDITOR_ORIGIN.test(origin)) headers['access-control-allow-origin'] = origin;
	const known = request.headers.get('if-none-match') ?? '';
	if (known.split(',').some((t) => t.trim().replace(/^W\//, '') === entry.etag)) return new Response(null, { status: 304, headers });
	const accept = request.headers.get('accept-encoding') ?? '';
	let body: Buffer = entry.raw;
	if (/\bbr\b/.test(accept)) {
		body = entry.br ??= brotliCompressSync(entry.raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 7, [zlib.BROTLI_PARAM_SIZE_HINT]: entry.raw.length } });
		headers['content-encoding'] = 'br';
	} else if (/\bgzip\b/.test(accept)) {
		body = entry.gz ??= gzipSync(entry.raw, { level: 6 });
		headers['content-encoding'] = 'gzip';
	}
	return new Response(new Uint8Array(body), { headers });
}
