#!/usr/bin/env node
/**
 * Build the web copies of the printed monster cards (the Abyss card faces).
 *
 * Source: the card exports from the niji-batch monster generator
 *   ~/ArcSpiritsArt/assets/exports/monster-cards/<Display Name>.png   (825 x 1425, print size)
 * plus, per card, the generator's record of what it printed
 *   ~/ArcSpiritsArt/references/monster_cards/<Display Name>/spec.json  (name, health, damage, class, reward icons)
 *
 * Output (both are read by the game, nothing else):
 *   static/monster-cards/cards/<monster id>.webp           600 px wide WebP, keyed by monsters_v2 id
 *   src/lib/components/play2d/monsterCardFaces.json         what each card PRINTS, so the game can refuse a
 *                                                           card whose printed values no longer match the game
 *
 * The database name of a monster can differ from the name on its card (tools/editor/names.json maps
 * database name -> card name). The id comes from the local table snapshot data/monsters_v2.json.
 *
 * Reads only; writes only the two outputs above. Needs `cwebp` (brew install webp).
 *
 *   node scripts/build-monster-card-faces.mjs [--art-root DIR] [--names FILE] [--width 600] [--quality 85] [--dry-run]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { artDir as hostArtDir, dataDir, editorDir } from './lib/paths.mjs';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ART_ROOT = resolve(arg('art-root', hostArtDir() ?? join(homedir(), 'ArcSpiritsArt')));
const NAMES_FILE = resolve(arg('names', join(editorDir, 'names.json')));
const DATA_DIR = resolve(arg('data', dataDir()));
const WIDTH = Number(arg('width', '600'));
const QUALITY = Number(arg('quality', '85'));
const DRY_RUN = process.argv.includes('--dry-run');

const EXPORTS_DIR = join(ART_ROOT, 'assets/exports/monster-cards');
const SPECS_DIR = join(ART_ROOT, 'references/monster_cards');
const OUT_DIR = join(REPO, 'static/monster-cards/cards');
const OUT_MANIFEST = join(REPO, 'src/lib/components/play2d/monsterCardFaces.json');
/** Where the same PNGs go in Supabase storage (bucket game_assets) when they are uploaded; see
 *  game-data-backend/supabase/migrations/20261111130000_monster_card_images*. */
const STORAGE_FOLDER = 'card_images/monsters_v2/niji-2026-11-11';

/** The niji-batch file-name rule (exports.mjs `clean`). */
const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').trim();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function main() {
	const [monsters, iconPool, names] = await Promise.all([
		readJson(join(DATA_DIR, 'monsters_v2.json')),
		readJson(join(DATA_DIR, 'icon_pool.json')),
		existsSync(NAMES_FILE) ? readJson(NAMES_FILE) : { monsters: {} }
	]);
	const iconName = new Map(iconPool.map((icon) => [icon.id, icon.name]));

	const cards = {};
	const problems = [];
	const jobs = [];
	for (const row of [...monsters].sort((a, b) => a.stage - b.stage || a.order_num - b.order_num)) {
		const display = names.monsters?.[row.name]?.name ?? row.name;
		const png = join(EXPORTS_DIR, `${clean(display)}.png`);
		const specFile = join(SPECS_DIR, clean(display), 'spec.json');
		if (!existsSync(png) || !existsSync(specFile)) {
			problems.push(`${display} (${row.name}): no export or spec, skipped`);
			continue;
		}
		const spec = await readJson(specFile);
		const source = await readFile(png);
		const rendered = join(dirname(specFile), 'card.png');
		if (existsSync(rendered) && sha256(await readFile(rendered)) !== sha256(source)) {
			problems.push(`${display}: export differs from the generator's card.png (export is stale), skipped`);
			continue;
		}

		// The printed reward icons, mapped back to their reward-track tokens (in order, each token once).
		const unused = [...(row.reward_track ?? [])];
		const rewards = [];
		let unmapped = null;
		for (const iconPath of spec.rewards ?? []) {
			const stem = basename(iconPath).replace(/\.[^.]+$/, '');
			const at = unused.findIndex((token) => clean(iconName.get(token) ?? '') === stem);
			if (at < 0) {
				unmapped = stem;
				break;
			}
			rewards.push(unused.splice(at, 1)[0]);
		}
		if (unmapped) {
			problems.push(`${display}: printed reward "${unmapped}" is not on the row's reward track, skipped`);
			continue;
		}
		const stage = Number(/(\d+)/.exec(spec.classLabel ?? '')?.[1] ?? row.stage);
		const drift = [
			spec.name !== display && `name ${spec.name} vs ${display}`,
			spec.health !== row.barrier && `health ${spec.health} vs barrier ${row.barrier}`,
			spec.damage !== row.damage && `damage ${spec.damage} vs ${row.damage}`,
			stage !== row.stage && `class ${stage} vs stage ${row.stage}`
		].filter(Boolean);
		if (drift.length) problems.push(`${display}: card differs from the local row (${drift.join(', ')}); kept, the game checks it`);
		const notPrinted = unused.map((token) => iconName.get(token) ?? token);

		cards[row.id] = {
			v: '',
			name: spec.name,
			dbName: row.name,
			barrier: spec.health,
			damage: spec.damage,
			stage,
			rewards,
			...(notPrinted.length ? { notPrinted } : {})
		};
		jobs.push({ id: row.id, png });
	}

	if (!DRY_RUN) {
		await mkdir(OUT_DIR, { recursive: true });
		const queue = [...jobs];
		await Promise.all(
			Array.from({ length: 6 }, async () => {
				for (let job = queue.shift(); job; job = queue.shift()) {
					const out = join(OUT_DIR, `${job.id}.webp`);
					await run('cwebp', ['-quiet', '-q', String(QUALITY), '-m', '6', '-alpha_q', '90', '-metadata', 'none', '-resize', String(WIDTH), '0', job.png, '-o', out]);
					cards[job.id].v = sha256(await readFile(out)).slice(0, 10);
				}
			})
		);
		// Drop web copies of cards that left the set.
		for (const file of await readdir(OUT_DIR)) {
			if (file.endsWith('.webp') && !cards[file.replace(/\.webp$/, '')]) await rm(join(OUT_DIR, file));
		}
		const manifest = {
			$comment: 'Generated by scripts/build-monster-card-faces.mjs. Do not edit by hand.',
			width: 825,
			height: 1425,
			webWidth: WIDTH,
			storageFolder: STORAGE_FOLDER,
			cards
		};
		await writeFile(OUT_MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`);
	}

	console.log(`${Object.keys(cards).length} of ${monsters.length} monsters have a printed card${DRY_RUN ? ' (dry run)' : ''}.`);
	for (const line of problems) console.log(`  - ${line}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
