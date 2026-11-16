/**
 * The art of a game package: display-size copies of every image the package's tables point at,
 * made from the LATEST LOCAL EXPORTS and uploaded to the play project's public storage bucket.
 *
 * - Sources, in order: the local exports and icons in ~/ArcSpiritsArt, found exactly as the local
 *   game finds them (scripts/local-game/images.mjs, so the web shows what the local game shows);
 *   then, for art that has no local export (guardian mats, location backgrounds, dice), the
 *   original in the old project's bucket.
 * - Each image is resized to the size the site displays it at and stored as WebP under
 *   `game_assets/art/<art id>/<the path in the tables>`. The art id is a hash of all the files, so
 *   a package's art never changes after release and unchanged art is not uploaded twice.
 * - Rows whose image had no path (new spirits, new icons) get one, as in the local game.
 *
 * Needs `cwebp` (brew install webp) and macOS `sips`.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildImageIndex } from '../local-game/images.mjs';
import { editorDir, PLAY_PROJECT_REF } from '../lib/paths.mjs';

const run = promisify(execFile);
const OLD_BUCKET = 'https://gvxfokbptelmvvlxbigh.supabase.co/storage/v1/object/public/game_assets';
const IMAGE = /\.(png|jpe?g|webp|gif|svg(\+xml)?)$/i;
const CACHE = join(homedir(), '.cache', 'arc-package-art');

/** Longest edge of the display copy. Keep in step with maxEdgeFor in src/lib/storageImages.ts. */
export function maxEdgeFor(path) {
	if (/^(game_locations|misc_assets\/(map|spirit_world_map))\//.test(path)) return 1600;
	if (path.startsWith('hex_spirits/')) return 1024;
	if (path.startsWith('card_images/')) return 1024;
	return 512;
}

export function imagePaths(tables) {
	const paths = new Set();
	const walk = (value) => {
		if (typeof value === 'string') {
			if (IMAGE.test(value) && !/^https?:/.test(value) && !value.startsWith('/')) paths.add(value);
		} else if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === 'object') Object.values(value).forEach(walk);
	};
	for (const rows of Object.values(tables)) walk(rows);
	return [...paths].sort();
}

async function pool(items, size, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: size }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		})
	);
	return out;
}

async function fetchOld(path) {
	const key = createHash('sha1').update(path).digest('hex');
	const file = join(CACHE, 'old-bucket', `${key}${extname(path).toLowerCase() || '.bin'}`);
	if (existsSync(file)) return file;
	const res = await fetch(`${OLD_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`);
	if (!res.ok) return null;
	mkdirSync(join(CACHE, 'old-bucket'), { recursive: true });
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	return file;
}

/** What the bytes are, whatever the file is called (the old bucket has PNGs named .svg+xml). */
function sniff(bytes) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
	if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
	if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
	if (/^\s*(<\?xml|<svg|<!--)/i.test(bytes.subarray(0, 300).toString('utf8'))) return 'svg';
	return null;
}

/** Display copy of `file` (WebP, longest edge ≤ edge, never enlarged). SVG and GIF pass through. */
async function displayCopy(file, edge) {
	const bytes = readFileSync(file);
	const kind = sniff(bytes);
	if (kind === 'svg') return { bytes, type: 'image/svg+xml' };
	if (kind === 'gif') return { bytes, type: 'image/gif' };
	if (!kind) throw new Error('not an image this tool knows');
	const key = createHash('sha1').update(bytes).update(`|${edge}`).digest('hex');
	const out = join(CACHE, 'webp', `${key}.webp`);
	// Several image paths can resolve to one file (front.png, front-base.png and combined.png of a
	// spirit are the same export). Convert it once: two conversions of the same key at the same
	// time removed each other's temporary files, and the loser was reported as missing.
	if (!existsSync(out) && converting.has(key)) await converting.get(key);
	if (!existsSync(out)) {
		let done;
		converting.set(key, new Promise((resolve) => (done = resolve)));
		try {
			await convertToWebp(bytes, kind, key, edge, out);
		} finally {
			converting.delete(key);
			done();
		}
	}
	return { bytes: readFileSync(out), type: 'image/webp' };
}

const converting = new Map();

async function convertToWebp(bytes, kind, key, edge, out) {
	{
		mkdirSync(join(CACHE, 'webp'), { recursive: true });
		// Work on a copy named for what the bytes are, so the tools are not misled by the name.
		const input = join(tmpdir(), `arc-art-${key}.${kind}`);
		writeFileSync(input, bytes);
		const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', input]);
		const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
		const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
		const scale = width && height ? Math.min(1, edge / Math.max(width, height)) : 1;
		const resize = scale < 1 ? ['-resize', String(Math.round(width * scale)), String(Math.round(height * scale))] : [];
		const tmp = join(tmpdir(), `arc-art-${key}.out.webp`);
		await run('cwebp', ['-quiet', '-q', '80', '-alpha_q', '90', ...resize, input, '-o', tmp]);
		writeFileSync(out, readFileSync(tmp));
		rmSync(input, { force: true });
		rmSync(tmp, { force: true });
	}
}

/**
 * Build the art of a package. Fills missing image paths in `tables` (in place) and returns the
 * files to upload. Nothing is uploaded here.
 */
export async function buildPackageArt({ tables, extras, artDir, log = console.log }) {
	try {
		await run('cwebp', ['-version']);
	} catch {
		throw new Error('cwebp is not installed (brew install webp): cannot make the art of the package');
	}
	const index = buildImageIndex({
		tables,
		extras,
		artDir,
		spiritNamesFile: join(editorDir, 'spirit-names.json'),
		ttsDir: null // art without a local export comes from the bucket original, not from a game cache
	});
	const paths = imagePaths(tables);
	const missing = [];
	let fromExports = 0;
	let fromOldBucket = 0;
	const files = (
		await pool(paths, 8, async (path) => {
			let source = index.resolve(path);
			if (source) fromExports++;
			else if ((source = await fetchOld(path))) fromOldBucket++;
			else {
				missing.push(path);
				return null;
			}
			try {
				const copy = await displayCopy(source, maxEdgeFor(path));
				return { path, ...copy, sha: createHash('sha256').update(copy.bytes).digest('hex') };
			} catch (e) {
				missing.push(path);
				log(`  could not convert ${path}: ${String(e?.message ?? e).slice(0, 120)}`);
				return null;
			}
		})
	).filter(Boolean);
	const id = createHash('sha256')
		.update(JSON.stringify(files.map((f) => [f.path, f.sha])))
		.digest('hex')
		.slice(0, 16);
	const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
	// The manifest lets another machine download the set (scripts/package/art-fetch.mjs): every
	// file with its content hash (only new content is downloaded), and the image paths this
	// machine gave to rows that had none.
	const manifest = { id, files: files.map((f) => [f.path, f.sha, f.type]), filled: index.filled };
	return { id, files, manifest, summary: { id, files: files.length, bytes, fromExports, fromOldBucket, missing } };
}

/** Upload the art to `<supabaseUrl>` bucket game_assets under art/<id>/. Skips art already there. */
export async function uploadPackageArt({ id, files, manifest, summary }, { supabaseUrl, serviceKey, latest = true, log = console.log }) {
	const api = `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
	const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
	const bucket = await fetch(`${api}/bucket`, {
		method: 'POST',
		headers: { ...auth, 'content-type': 'application/json' },
		body: JSON.stringify({ id: 'game_assets', name: 'game_assets', public: true })
	});
	if (!bucket.ok && bucket.status !== 409 && !/exist/i.test(await bucket.text()))
		throw new Error(`could not create the storage bucket: ${bucket.status}`);
	const put = async (key, body, type, cache = 'max-age=31536000') => {
		for (let attempt = 1; ; attempt++) {
			const res = await fetch(`${api}/object/game_assets/${key.split('/').map(encodeURIComponent).join('/')}`, {
				method: 'POST',
				headers: { ...auth, 'content-type': type, 'cache-control': cache, 'x-upsert': 'true' },
				body
			});
			if (res.ok) return;
			if (attempt >= 3) throw new Error(`upload of ${key} failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
		}
	};
	const marker = `art/${id}/_complete.json`;
	const publicUrl = (key) => `${api}/object/public/game_assets/${key}?t=${Date.now()}`;
	// The pointer other machines follow with `art:fetch --latest`.
	const pointLatest = async () => latest && put('art/_latest.json', JSON.stringify({ id, at: new Date().toISOString() }), 'application/json', 'no-cache');
	if ((await fetch(publicUrl(marker))).ok) {
		if (manifest && !(await fetch(publicUrl(`art/${id}/_manifest.json`))).ok) {
			await put(`art/${id}/_manifest.json`, JSON.stringify(manifest), 'application/json');
			log(`art ${id} is already uploaded; added its manifest`);
		} else log(`art ${id} is already uploaded`);
		await pointLatest();
		return;
	}
	let done = 0;
	await pool(files, 8, async (f) => {
		await put(`art/${id}/${f.path}`, f.bytes, f.type);
		if (++done % 100 === 0) log(`  uploaded ${done}/${files.length}`);
	});
	if (manifest) await put(`art/${id}/_manifest.json`, JSON.stringify(manifest), 'application/json');
	await put(marker, JSON.stringify({ ...summary, missing: summary.missing.length }), 'application/json');
	await pointLatest();
	log(`uploaded ${files.length} images (${(summary.bytes / 1e6).toFixed(1)} MB) as art ${id}`);
}

/** The play project's URL and service key: from the environment, else from the Supabase CLI (this machine, then the key host). */
export async function playProjectKeys() {
	const ref = PLAY_PROJECT_REF;
	const supabaseUrl = process.env.PUBLIC_SUPABASE_URL?.includes(ref) ? process.env.PUBLIC_SUPABASE_URL : `https://${ref}.supabase.co`;
	if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.PUBLIC_SUPABASE_URL?.includes(ref))
		return { supabaseUrl, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
	const pick = (stdout) => JSON.parse(stdout).find((k) => k.name === 'service_role' && k.type === 'legacy')?.api_key;
	// The Supabase CLI of this machine when it is signed in, else the one on the key host.
	try {
		const key = pick((await run('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'])).stdout);
		if (key) return { supabaseUrl, serviceKey: key };
	} catch {
		/* fall through */
	}
	try {
		const host = process.env.ARC_KEY_HOST ?? 'seablue';
		const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, `zsh -lc 'supabase projects api-keys --project-ref ${ref} -o json 2>/dev/null'`]);
		const key = pick(stdout);
		if (key) return { supabaseUrl, serviceKey: key };
	} catch {
		/* fall through */
	}
	throw new Error('no storage key: set PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY of the play project, or sign in the Supabase CLI on this machine (supabase login)');
}
