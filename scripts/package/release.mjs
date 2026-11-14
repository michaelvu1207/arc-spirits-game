#!/usr/bin/env node
/**
 * Make a game-data package from a local data folder.
 *
 *   node scripts/package/release.mjs <version> [--from <data dir>] [--notes "what changed"] [--live]
 *
 * Writes packages/<version>/ (tables.json, manifest.json, CHANGES.md) and adds it to
 * packages/index.json. A package is immutable: an existing version is never overwritten.
 * `--live` also makes it the live package (same as `publish.mjs <version>` without the push).
 * The data folder defaults to ~/ArcSpiritsArt/game (the working data the local game shows).
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
const gameDir = resolve(flag('--from') ?? join(homedir(), 'ArcSpiritsArt/game'));
const notes = flag('--notes') ?? '';
const makeLive = args.includes('--live');
const packagesDir = join(repoRoot, 'packages');
const outDir = join(packagesDir, version);
const indexPath = join(packagesDir, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { live: null, versions: [] };

if (existsSync(outDir) || index.versions.some((v) => v.version === version)) {
	console.error(`package ${version} already exists; packages are immutable. Choose a new version.`);
	process.exit(1);
}

// 1. Tables, exactly as the local game serves them.
const { tables, notes: loadNotes } = loadLocalTables({ gameDir, repoRoot });
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

// 3. Change list against the package it replaces (the live one).
const parent = index.live;
const parentTables = parent ? JSON.parse(readFileSync(join(packagesDir, parent, 'tables.json'), 'utf8')) : null;
const changes = describeChanges(parentTables, tables);

// 4. Write.
const tablesJson = JSON.stringify(tables);
const info = {
	version,
	createdAt: new Date().toISOString(),
	parent,
	notes,
	sha256: createHash('sha256').update(tablesJson).digest('hex'),
	rulesHash: check.rulesHash,
	counts
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tables.json'), tablesJson);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ ...info, source: gameDir.replace(homedir(), '~') }, null, '\t') + '\n');
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
