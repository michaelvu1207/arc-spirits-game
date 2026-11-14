#!/usr/bin/env node
/**
 * Make a package live on the web: point packages/index.json at it, commit and push. Vercel
 * deploys the push; the site then reads its game data from that package.
 *
 *   node scripts/package/publish.mjs <version> [--no-push]
 *
 * Rolling back is the same command with an older version.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [version, ...rest] = process.argv.slice(2);
const repoRoot = resolve(import.meta.dirname, '../..');
const indexPath = join(repoRoot, 'packages/index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
if (!version || !index.versions.some((v) => v.version === version)) {
	console.error(`usage: publish.mjs <version> [--no-push]\nknown versions: ${index.versions.map((v) => v.version).join(', ')}`);
	process.exit(1);
}
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
const before = index.live;
index.live = version;
writeFileSync(indexPath, JSON.stringify(index, null, '\t') + '\n');
// The monster card faces rebuilt by release.mjs ship with the package.
const SHIPPED = ['packages', 'static/monster-cards', 'src/lib/components/play2d/monsterCardFaces.json'];
git('add', ...SHIPPED);
if (!git('diff', '--cached', '--name-only', '--', ...SHIPPED)) {
	console.log(`${version} is already the live package and committed`);
} else {
	git('commit', '-m', before === version ? `Add game package ${version}` : `Publish game package ${version} (was ${before ?? 'none'})`);
	console.log(`committed: live package ${before ?? 'none'} → ${version}`);
}
if (rest.includes('--no-push')) process.exit(0);
// Production deploys from `main` (Vercel's GitHub integration). Publishing from another branch
// would only make a preview, so refuse instead of surprising anyone.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
	console.error(`on branch ${branch}: the commit is made, but only a push of main goes live. Merge to main and push.`);
	process.exit(1);
}
execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot, stdio: 'inherit' });
console.log('pushed main; Vercel builds and deploys it (about 2 minutes). Check https://arcspirits.com/versions');
