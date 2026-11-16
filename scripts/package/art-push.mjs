#!/usr/bin/env node
/**
 * Art host only: make the web-size art from the current data and the latest local exports,
 * upload it, and point `art/_latest.json` at it (other machines: npm run art:fetch -- --latest).
 * Unchanged art is not uploaded again.
 */
import { loadLocalTables } from '../local-game/localData.mjs';
import { artDir, dataDir, isArtHost, repoRoot } from '../lib/paths.mjs';
import { buildPackageArt, playProjectKeys, uploadPackageArt } from './art.mjs';

if (!isArtHost()) {
	console.error('This machine is not the art host (arc.local.json: "artHost": true and "artDir"). Use: npm run cards:remake');
	process.exit(1);
}
const { tables, extras } = loadLocalTables({ gameDir: dataDir(), repoRoot });
const built = await buildPackageArt({ tables, extras, artDir: artDir() });
const { summary } = built;
console.log(`art ${summary.id}: ${summary.files} images, ${(summary.bytes / 1e6).toFixed(1)} MB${summary.missing.length ? `, ${summary.missing.length} not found` : ''}`);
await uploadPackageArt(built, await playProjectKeys());
console.log(`latest art is ${summary.id}`);
