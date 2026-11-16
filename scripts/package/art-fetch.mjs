#!/usr/bin/env node
/**
 * Download the web-size art of the game to this machine (.art-cache/), so the local game runs
 * without the raw art folder.
 *
 *   npm run art:fetch                 the art of the live package
 *   npm run art:fetch -- --latest     the newest art the art host uploaded (after a card remake)
 *   npm run art:fetch -- --id <id>    one art set
 *
 * Files are kept by content hash: after the first run only new or changed images are
 * downloaded (a remade card is one or two files of about 60 KB). No key is needed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artCacheDir, PLAY_ART_BASE, repoRoot } from '../lib/paths.mjs';
import { blobFile } from '../local-game/webArt.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const get = async (url, tries = 4) => {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (res.ok || res.status === 404 || res.status === 400) return res;
			throw new Error(`HTTP ${res.status}`);
		} catch (e) {
			if (attempt >= tries) throw new Error(`${url.replace(PLAY_ART_BASE, 'art')}: ${e.message}`);
			await new Promise((r) => setTimeout(r, 1500 * attempt));
		}
	}
};
const encode = (path) => path.split('/').map(encodeURIComponent).join('/');

let id = flag('--id');
if (!id && args.includes('--latest')) {
	const res = await get(`${PLAY_ART_BASE}/_latest.json?t=${Date.now()}`);
	if (!res.ok) throw new Error('the art host has not uploaded a latest pointer yet');
	id = (await res.json()).id;
}
if (!id) {
	const index = JSON.parse(readFileSync(join(repoRoot, 'packages/index.json'), 'utf8'));
	id = index.versions.find((v) => v.version === index.live)?.art?.id;
	if (!id) throw new Error(`the live package ${index.live} has no art id`);
}

const manifestRes = await get(`${PLAY_ART_BASE}/${id}/_manifest.json?t=${Date.now()}`);
if (!manifestRes.ok) {
	console.error(`art ${id} has no manifest (it was uploaded before 2026-11-16). On the art host run: npm run art:push`);
	process.exit(1);
}
const manifest = await manifestRes.json();
mkdirSync(join(artCacheDir, 'blobs'), { recursive: true });
mkdirSync(join(artCacheDir, 'sets'), { recursive: true });

const todo = manifest.files.filter(([, sha, type]) => !existsSync(blobFile(artCacheDir, sha, type)));
// Several paths can share one image: download each content once.
const byContent = new Map(todo.map((f) => [f[1], f]));
let done = 0;
let bytes = 0;
const failed = [];
const queue = [...byContent.values()];
await Promise.all(
	Array.from({ length: 6 }, async () => {
		for (let f; (f = queue.shift()); ) {
			const [path, sha, type] = f;
			try {
				const res = await get(`${PLAY_ART_BASE}/${id}/${encode(path)}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const body = Buffer.from(await res.arrayBuffer());
				if (createHash('sha256').update(body).digest('hex') !== sha) throw new Error('content does not match the manifest');
				writeFileSync(blobFile(artCacheDir, sha, type), body);
				bytes += body.length;
			} catch (e) {
				failed.push(`${path}: ${e.message}`);
			}
			if (++done % 100 === 0) console.log(`  ${done}/${byContent.size}`);
		}
	})
);
if (failed.length) {
	console.error(`${failed.length} image(s) could not be downloaded; run the command again:\n  ${failed.slice(0, 8).join('\n  ')}`);
	process.exit(1);
}
writeFileSync(join(artCacheDir, 'sets', `${id}.json`), JSON.stringify(manifest));
writeFileSync(join(artCacheDir, 'current.json'), JSON.stringify({ id, at: new Date().toISOString() }));
console.log(`art ${id}: ${manifest.files.length} images, ${byContent.size} downloaded (${(bytes / 1e6).toFixed(1)} MB), the rest were here already`);
