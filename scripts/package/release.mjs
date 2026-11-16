#!/usr/bin/env node
/**
 * Make a game-data package from a local data folder.
 *
 *   node scripts/package/release.mjs <version> [--from <data dir>] [--notes "what changed"] [--live] [--no-art]
 *
 * Writes packages/<version>/ (tables.json, manifest.json, CHANGES.md) and adds it to
 * packages/index.json. A package is immutable: an existing version is never overwritten.
 * `--live` also makes it the live package (same as `publish.mjs <version>` without the push).
 * The data folder defaults to data/ in this repo (the working data the local game shows).
 *
 * Art: on the art host (arc.local.json), display copies of the latest local exports are uploaded
 * for the package (scripts/package/art.mjs) and the printed monster card faces are rebuilt.
 * On any other machine, and with `--no-art`, the package shows the art of the package it
 * replaces; `--art-id <id>` uses a set the art host already uploaded (npm run cards:remake).
 *
 * Checks before anything is written: the tables load, the engine catalog builds, and random
 * players (no AI model) finish full games on the data (scripts/package/validate.ts).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadLocalTables } from '../local-game/localData.mjs';
import { describeChanges } from './changes.mjs';
import { buildPackageArt, playProjectKeys, uploadPackageArt } from './art.mjs';
import { artDir as hostArtDir, dataDir, isArtHost } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const version = args[0];
if (!version || version.startsWith('-') || !/^[a-z0-9][a-z0-9._-]*$/i.test(version)) {
	console.error('usage: release.mjs <version> [--from <data dir>] [--notes "..."] [--live]');
	process.exit(1);
}
const repoRoot = resolve(import.meta.dirname, '../..');
const gameDir = resolve(flag('--from') ?? dataDir());
const notes = flag('--notes') ?? '';
const makeLive = args.includes('--live');
// Art is made on the art host only (arc.local.json). Elsewhere the package reuses the art of the
// package it replaces, or the set named with --art-id (for example the one `cards:remake` printed).
const artDir = flag('--art-dir') ? resolve(flag('--art-dir')) : hostArtDir();
const artId = flag('--art-id');
const withArt = !args.includes('--no-art') && !artId && (flag('--art-dir') ? true : isArtHost());
const packagesDir = join(repoRoot, 'packages');
const outDir = join(packagesDir, version);
const indexPath = join(packagesDir, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { live: null, versions: [] };

if (existsSync(outDir) || index.versions.some((v) => v.version === version)) {
	console.error(`package ${version} already exists; packages are immutable. Choose a new version.`);
	process.exit(1);
}

// 1. Tables, exactly as the local game serves them.
const { tables, extras, notes: loadNotes } = loadLocalTables({ gameDir, repoRoot });
for (const note of loadNotes) console.log(`note: ${note}`);
const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
for (const required of ['hex_spirits', 'classes', 'origins', 'monsters_v2', 'guardians', 'game_locations']) {
	if (!counts[required]) {
		console.error(`table ${required} is empty in ${gameDir}: not a usable data folder`);
		process.exit(1);
	}
}

// 2. Engine check: catalog builds and random games finish.
console.log('checking the data with the engine (random players, no AI model)…');
const check = JSON.parse(
	execFileSync('npx', ['tsx', 'scripts/package/validate.ts', gameDir, '12'], { cwd: repoRoot, encoding: 'utf8' })
		.trim()
		.split('\n')
		.pop()
);
if (check.errors || check.stalls || check.finished !== check.games) {
	console.error(`engine check failed: ${JSON.stringify(check)}`);
	process.exit(1);
}
console.log(`engine check passed: ${check.finished}/${check.games} games finished, rules ${check.rulesHash.slice(0, 12)}`);

// 3. Art: the latest local exports, resized and uploaded; monster card faces rebuilt.
const parent = index.live;
let art = null;
if (withArt) {
	console.log(`building the art from ${artDir.replace(homedir(), '~')}…`);
	const built = await buildPackageArt({ tables, extras, artDir });
	const { summary } = built;
	console.log(`art ${summary.id}: ${summary.files} images (${summary.fromExports} from local exports and icons, ${summary.fromOldBucket} from the old bucket), ${(summary.bytes / 1e6).toFixed(1)} MB${summary.missing.length ? `, ${summary.missing.length} not found` : ''}`);
	await uploadPackageArt(built, await playProjectKeys());
	art = { id: summary.id, files: summary.files, fromExports: summary.fromExports, fromOldBucket: summary.fromOldBucket, missing: summary.missing };
	execFileSync('node', ['scripts/build-monster-card-faces.mjs'], { cwd: repoRoot, stdio: 'inherit' });
} else {
	if (artId) {
		const res = await fetch(`https://ydmlhjucgvultqhpctlr.supabase.co/storage/v1/object/public/game_assets/art/${artId}/_manifest.json?t=${Date.now()}`);
		if (!res.ok) {
			console.error(`art ${artId} was not found in the bucket`);
			process.exit(1);
		}
		const manifest = await res.json();
		// Rows without an image path get the path the art host gave them, as in a release made there.
		for (const { table, id, column, path } of manifest.filled ?? []) {
			const row = (tables[table] ?? []).find((r) => r.id === id);
			if (row && !row[column]) row[column] = path;
		}
		art = { id: artId, files: manifest.files.length };
		console.log(`using art ${artId} (${art.files} images) made by the art host`);
	} else {
		art = index.versions.find((v) => v.version === parent)?.art ?? null;
		if (art) console.log(`no art made on this machine: reusing art ${art.id} of ${parent}`);
		// Keep the image paths of the package it replaces for rows that have none in the data.
		if (parent) {
			const before = JSON.parse(readFileSync(join(packagesDir, parent, 'tables.json'), 'utf8'));
			for (const [table, rows] of Object.entries(tables)) {
				const old = new Map((before[table] ?? []).map((r) => [r.id, r]));
				for (const row of rows) {
					const prev = row.id != null ? old.get(row.id) : null;
					if (!prev) continue;
					for (const [column, value] of Object.entries(prev)) {
						if (typeof value === 'string' && /\.(png|jpe?g|webp|gif|svg(\+xml)?)$/i.test(value) && row[column] == null) row[column] = value;
					}
				}
			}
		}
	}
}

// 4. Change list against the package it replaces (the live one).
const parentTables = parent ? JSON.parse(readFileSync(join(packagesDir, parent, 'tables.json'), 'utf8')) : null;
const changes = describeChanges(parentTables, tables);

// 5. Write.
const tablesJson = JSON.stringify(tables);
const info = {
	version,
	createdAt: new Date().toISOString(),
	parent,
	notes,
	sha256: createHash('sha256').update(tablesJson).digest('hex'),
	rulesHash: check.rulesHash,
	art: art ? { id: art.id, files: art.files } : null,
	counts
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tables.json'), tablesJson);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ ...info, art, source: gameDir.replace(homedir(), '~') }, null, '\t') + '\n');
writeFileSync(
	join(outDir, 'CHANGES.md'),
	[
		`# ${version}`,
		'',
		notes || '_No notes._',
		'',
		parent ? `Changes since ${parent}: ${changes.summary}` : 'First package.',
		'',
		...changes.lines,
		''
	].join('\n')
);
index.versions.push(info);
if (makeLive || !index.live) index.live = version;
writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
console.log(`package ${version} written to packages/${version}/ (${(tablesJson.length / 1024).toFixed(0)} KB)`);
console.log(parent ? `changes since ${parent}: ${changes.summary}` : 'first package');
console.log(index.live === version ? `${version} is the live package (after the next deploy)` : `live package is still ${index.live}; run publish.mjs ${version} to make it live`);
