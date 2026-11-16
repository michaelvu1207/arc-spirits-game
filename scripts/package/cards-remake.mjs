#!/usr/bin/env node
/**
 * Bring the card images in step with the data. Image work is always done on the art host.
 *
 *   npm run cards:remake              compare every spirit card with the data, remake the cards
 *                                     that differ, remake changed monster cards, upload the art
 *   npm run cards:remake -- --all "Name One|Name Two"     remake these spirit cards anyway
 *   npm run cards:remake -- --check   only list the cards that differ
 *
 * On the art host this runs here (the editor must be running: it holds the card generator).
 * On any other machine it asks the art host over ssh (arc.local.json: artHostSsh, artHostRepo):
 * that machine first pulls the repo, so push your data change before you run this. Afterwards
 * the new images are downloaded here (only the changed files, about 60 KB a card).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { artDir, isArtHost, localConfig, repoRoot } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const forced = args.includes('--all') ? (args[args.indexOf('--all') + 1] ?? '').split('|').filter(Boolean) : [];
const EDITOR = process.env.ARC_EDITOR_URL ?? 'http://127.0.0.1:8787';

if (!isArtHost()) {
	const { artHostSsh, artHostRepo } = localConfig();
	if (!artHostSsh || !artHostRepo) {
		console.error('This machine is not the art host and arc.local.json does not name one ("artHostSsh": "user@host", "artHostRepo": "~/path").');
		process.exit(1);
	}
	const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
	const remote = `cd ${artHostRepo} && PATH=/opt/homebrew/bin:/usr/local/bin:$PATH node scripts/package/cards-remake.mjs --pull ${quoted}`;
	const run = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', artHostSsh, remote], { stdio: 'inherit' });
	if (run.status !== 0) process.exit(run.status ?? 1);
	if (!checkOnly) execFileSync('node', ['scripts/package/art-fetch.mjs', '--latest'], { cwd: repoRoot, stdio: 'inherit' });
	process.exit(0);
}

if (args.includes('--pull')) {
	const pull = spawnSync('git', ['pull', '--ff-only', '--quiet'], { cwd: repoRoot, encoding: 'utf8' });
	console.log(pull.status === 0 ? 'art host: repo is up to date with GitHub' : `art host: could not pull (${(pull.stderr || '').trim().split('\n').pop()}); using the data that is here`);
}

const api = async (path, body) => {
	const res = await fetch(`${EDITOR}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { error: `${res.status} ${text.slice(0, 200)}` };
	}
};
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const base = (p) => basename(String(p ?? ''));

/** The spirit cards whose saved recipe (what the image was made from) differs from the data. */
async function audit() {
	const { spirits } = await api('/api/game/hex-spirits');
	const dir = join(artDir(), 'references/hex_bases');
	const differ = new Map();
	for (const m of spirits) {
		if (!m.kit) continue;
		for (const side of m.kit.template === 'arcane' ? ['front', 'back'] : ['front']) {
			const file = join(dir, m.name, `gen-${side}.spec.json`);
			const why = [];
			if (!existsSync(file)) why.push('no card yet');
			else {
				const s = JSON.parse(readFileSync(file, 'utf8'));
				if (s.name !== m.name) why.push('name');
				if (!same((s.classes ?? []).map((c) => c.name), m.classes.map((c) => c.name))) why.push('classes');
				if (base(s.art) !== base(m.art)) why.push('art');
				if (!same(s.transform, m.transform)) why.push('art placement');
				if (side === 'back') {
					const runes = (list) => (list ?? []).map((g) => g.map(base));
					if (!same(runes(s.runes), runes(m.runes))) why.push('rune cost');
					if ((s.awakenText || null) !== (m.awakenText || null)) why.push('awaken text');
					if ((s.className || null) !== (m.className || null)) why.push('class name');
					if ((s.classDesc || null) !== (m.classDesc || null)) why.push('class text');
				}
			}
			if (why.length) differ.set(m.name, [...(differ.get(m.name) ?? []), `${side}: ${why.join(', ')}`]);
		}
	}
	return differ;
}

const differ = await audit();
for (const name of forced) if (!differ.has(name)) differ.set(name, ['asked for']);
for (const [name, why] of differ) console.log(`  ${name}: ${why.join(' | ')}`);
console.log(`${differ.size} spirit card(s) to remake`);
if (checkOnly) process.exit(0);

let failed = 0;
for (const name of differ.keys()) {
	const r = await api('/api/game/hex-generate', { name, force: true });
	if (r.error) {
		failed++;
		console.log(`  ${name}: FAILED ${String(r.error).slice(0, 160)}`);
	} else console.log(`  ${name}: made ${(r.sides ?? []).join(' and ')}`);
}
const monsters = (await api('/api/game/monsters')).filter?.((m) => m.art && m.stale) ?? [];
for (const m of monsters) {
	const r = await api('/api/game/monster-generate', { name: m.name });
	if (r.error) failed++;
	console.log(`  monster ${m.name}: ${r.error ? `FAILED ${String(r.error).slice(0, 120)}` : 'made'}`);
}
if (failed) {
	console.error(`${failed} card(s) failed; the art was not uploaded`);
	process.exit(1);
}
execFileSync('node', ['scripts/package/art-push.mjs'], { cwd: repoRoot, stdio: 'inherit' });
