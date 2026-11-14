// Storage paths (`game_assets` bucket) -> local image files in ~/ArcSpiritsArt (read only).
//
// The game asks for images by the storage path in a table row. This index maps each path to a
// local file where one exists:
//   hex_spirits      assets/exports/hex-spirits/<name>_front.png, _back.png
//   classes          references/icons/classes/<name> (icon).png, (augment token).png
//   origins          references/icons/origins/<name> (icon).png, (icon token).png
//   icon_pool        references/icons/icon_pool/<name>.png (class and origin icons by source id)
//   mat_items        references/icons/runes/<name>.png, else the rune's icon_pool icon
// When a row has no path but a local file exists, the row gets a local path, so new spirits and
// icons show too. monsters_v2.card_image_path is left alone: the game draws monster cards from
// the bundled static/monster-cards web copies, behind its own checks.
// A path that is not in the index is tried by the id in it, then by its file name against the
// icon_pool names, then in the Tabletop Simulator image cache (a local copy of most bucket files,
// often JPEG; spirit and monster card faces are not taken from it because old copies can show
// old card text). What is still not found is a 404, and the path is listed as missing.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function listDir(dir) {
	try {
		return readdirSync(dir).filter((f) => !f.startsWith('.'));
	} catch {
		return [];
	}
}

/** File name without extension (".svg+xml" counts as one) and without a trailing upload stamp. */
function stemOf(path) {
	const base = String(path).split('/').pop() ?? '';
	return base.replace(/\.svg\+xml$/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_\d{10,}$/, '');
}

export const CONTENT_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.gif': 'image/gif'
};

/** Bucket key: the path without separators and without its extension. */
const bucketKey = (path) => norm(String(path).replace(/\.svg\+xml$/i, '').replace(/\.[a-z0-9]+$/i, ''));

/**
 * Index the Tabletop Simulator cache. Its file names are the flattened bucket URLs, e.g.
 * "https...supabasecostoragev1objectpublicgameassetscompressedgamelocations1771900277756jpgv1779731554878.jpg".
 * Returns bucket key -> newest file.
 */
function indexTtsCache(ttsDir) {
	const index = new Map();
	for (const file of listDir(ttsDir)) {
		const m = file.match(/storagev1objectpublicgameassets(?:compressed)?(.+?)(jpe?g|png|webp|svgxml)?v(\d{10,})\.(jpe?g|png|webp)$/i);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const version = Number(m[3]);
		const prev = index.get(key);
		if (!prev || prev.version < version) index.set(key, { version, file: join(ttsDir, file) });
	}
	return new Map([...index].map(([key, v]) => [key, v.file]));
}
/** Card faces print game text; an old cached copy would show old text. */
const NOT_FROM_TTS = /^(hex_spirits|card_images)\//;

export function buildImageIndex({ tables, extras, artDir, spiritNamesFile, ttsDir }) {
	const byPath = new Map(); // storage path -> absolute file
	const byId = new Map(); // row id / source id -> { main, back? }
	const filled = []; // rows that got a local path

	const dir = (rel) => join(artDir, rel);
	const iconPoolDir = dir('references/icons/icon_pool');
	const iconPoolByStem = new Map(listDir(iconPoolDir).map((f) => [norm(stemOf(f)), join(iconPoolDir, f)]));
	const classDir = dir('references/icons/classes');
	const originDir = dir('references/icons/origins');
	const runeDir = dir('references/icons/runes');
	const spiritDir = dir('assets/exports/hex-spirits');
	const fileIf = (path) => (existsSync(path) ? path : null);

	const register = (path, file) => {
		if (path && file && !byPath.has(path)) byPath.set(path, file);
	};
	// Give a row with no path a local one when a local file exists.
	const ensurePath = (table, row, column, file, synthetic) => {
		if (!file) return;
		if (!row[column]) {
			row[column] = synthetic;
			filled.push(`${table}.${column}`);
		}
		register(row[column], file);
	};

	// classes
	const classById = new Map();
	for (const row of tables.classes ?? []) {
		const icon = fileIf(join(classDir, `${row.name} (icon).png`));
		const token = fileIf(join(classDir, `${row.name} (augment token).png`));
		classById.set(row.id, icon);
		if (icon) byId.set(row.id, { main: icon });
		ensurePath('classes', row, 'icon_png', icon, `class_icons/${row.id}/local_icon.png`);
		ensurePath('classes', row, 'augment_token_path', token, `class_icons/${row.id}/local_augment_token.png`);
	}

	// origins
	const originById = new Map();
	for (const row of tables.origins ?? []) {
		const icon = fileIf(join(originDir, `${row.name} (icon).png`));
		const token = fileIf(join(originDir, `${row.name} (icon token).png`)) ?? icon;
		originById.set(row.id, icon);
		if (icon) byId.set(row.id, { main: icon });
		ensurePath('origins', row, 'icon_png', icon, `origin_icons/${row.id}/local_icon.png`);
		ensurePath('origins', row, 'icon_token_png', token, `origin_icons/${row.id}/local_icon_token.png`);
	}

	// icon_pool
	const iconById = new Map();
	for (const row of tables.icon_pool ?? []) {
		let file = null;
		if (row.source_type === 'class') file = classById.get(row.source_id) ?? null;
		else if (row.source_type === 'origin') file = originById.get(row.source_id) ?? null;
		file ??= iconPoolByStem.get(norm(row.name)) ?? iconPoolByStem.get(norm(stemOf(row.file_path ?? ''))) ?? null;
		if (!file) continue;
		iconById.set(row.id, file);
		byId.set(row.id, { main: file });
		if (row.source_id && !byId.has(row.source_id)) byId.set(row.source_id, { main: file });
		ensurePath('icon_pool', row, 'file_path', file, `icons/${row.id}/local.png`);
	}

	// mat_items (runes and relics): base runes have their own icons, the rest use icon_pool.
	const localMat = new Map((extras?.runesAndRelics ?? []).map((row) => [row.id, row]));
	for (const row of tables.mat_items ?? []) {
		const local = localMat.get(row.id);
		const file =
			fileIf(join(runeDir, `${local?.name ?? row.name}.png`)) ??
			(local?.icon ? iconById.get(local.icon) : null) ??
			byId.get(row.id)?.main ??
			null;
		if (file) byId.set(row.id, { main: file });
		ensurePath('mat_items', row, 'icon_path', file, `runes/${row.id}/icon.png`);
	}

	// hex_spirits: the exported card faces, by name (or the display name in spirit-names.json).
	const displayNames = new Map();
	if (spiritNamesFile && existsSync(spiritNamesFile)) {
		try {
			for (const [key, value] of Object.entries(JSON.parse(readFileSync(spiritNamesFile, 'utf8')))) {
				const dbName = key.split('/').slice(1).join('/');
				if (dbName && !displayNames.has(dbName)) displayNames.set(dbName, value);
			}
		} catch {
			/* optional file */
		}
	}
	for (const row of tables.hex_spirits ?? []) {
		const names = [row.name, displayNames.get(row.name)].filter(Boolean);
		const front = names.map((n) => fileIf(join(spiritDir, `${n}_front.png`))).find(Boolean) ?? null;
		const back = names.map((n) => fileIf(join(spiritDir, `${n}_back.png`))).find(Boolean) ?? null;
		if (front) byId.set(row.id, { main: front, back });
		ensurePath('hex_spirits', row, 'game_print_image_path', front, `hex_spirits/${row.id}/local/front.png`);
		ensurePath('hex_spirits', row, 'back_side_export', back, `hex_spirits/${row.id}/local/back.png`);
	}

	const tts = ttsDir ? indexTtsCache(ttsDir) : new Map();
	const fromTts = new Set();
	const missing = new Set();
	function resolve(path) {
		const direct = byPath.get(path);
		if (direct) return direct;
		const id = path.match(UUID)?.[0]?.toLowerCase();
		const entry = id ? byId.get(id) : null;
		// A spirit's raw art is not a card face: do not stand in for it.
		if (entry && !(path.startsWith('hex_spirits/') && /raw|art/i.test(path))) {
			return /back/i.test(path) && entry.back ? entry.back : entry.main;
		}
		const byStem = iconPoolByStem.get(norm(stemOf(path)));
		if (byStem) return byStem;
		const cached = NOT_FROM_TTS.test(path) ? null : tts.get(bucketKey(path));
		if (cached) {
			fromTts.add(path);
			return cached;
		}
		missing.add(path);
		return null;
	}

	return {
		resolve,
		missing,
		fromTts,
		stats: { paths: byPath.size, ids: byId.size, filled: filled.length, ttsCache: tts.size }
	};
}

/**
 * A display-size copy for the render endpoint (`?width=`), cached on disk. Uses sharp when it
 * can be imported, else macOS `sips`, else returns null (the caller sends the original).
 */
export function createResizer(cacheDir) {
	mkdirSync(cacheDir, { recursive: true });
	let sharp;
	const sharpReady = import('sharp').then(
		(m) => (sharp = m.default),
		() => (sharp = null)
	);
	const pending = new Map();
	return async function resized(file, edge) {
		const ext = extname(file).toLowerCase();
		if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext) || !(edge > 0)) return null;
		await sharpReady;
		const { mtimeMs, size } = statSync(file);
		const key = createHash('sha1').update(`${file}|${mtimeMs}|${size}|${edge}`).digest('hex');
		const outExt = sharp ? '.webp' : '.png';
		const out = join(cacheDir, `${key}${outExt}`);
		if (existsSync(out)) return { file: out, type: CONTENT_TYPES[outExt] };
		if (!pending.has(out)) {
			pending.set(
				out,
				(async () => {
					try {
						if (sharp) {
							await sharp(file)
								.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
								.webp({ quality: 80 })
								.toFile(out);
						} else {
							await execFileP('sips', ['-s', 'format', 'png', '-Z', String(edge), file, '--out', out]);
						}
						return true;
					} catch {
						return false;
					} finally {
						pending.delete(out);
					}
				})()
			);
		}
		const ok = await pending.get(out);
		return ok && existsSync(out) ? { file: out, type: CONTENT_TYPES[outExt] } : null;
	};
}
