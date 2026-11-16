// The image index of a machine without the raw art folder: the web-size art that
// `npm run art:fetch` downloaded into .art-cache/ (blobs by content hash, one manifest per set).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const EXT = { 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/gif': '.gif', 'image/png': '.png', 'image/jpeg': '.jpg' };
export const blobFile = (cacheDir, sha, type) => join(cacheDir, 'blobs', `${sha}${EXT[type] ?? '.bin'}`);

/** The current art set of this machine, or null when nothing was fetched. */
export function currentArtSet(cacheDir) {
	const pointer = join(cacheDir, 'current.json');
	if (!existsSync(pointer)) return null;
	const file = join(cacheDir, 'sets', `${readJson(pointer).id}.json`);
	return existsSync(file) ? readJson(file) : null;
}

/**
 * Same shape as buildImageIndex (images.mjs). Rows that have no image path in the working data
 * (the art host gave them one when it made the set) get that path here too.
 */
export function buildWebArtIndex({ tables, cacheDir }) {
	const set = currentArtSet(cacheDir);
	const files = new Map((set?.files ?? []).map(([path, sha, type]) => [path, blobFile(cacheDir, sha, type)]));
	let filled = 0;
	for (const { table, id, column, path } of set?.filled ?? []) {
		const row = (tables[table] ?? []).find((r) => r.id === id);
		if (row && !row[column] && files.has(path)) {
			row[column] = path;
			filled++;
		}
	}
	const missing = new Set();
	return {
		resolve(path) {
			const file = files.get(path);
			if (file && existsSync(file)) return file;
			missing.add(path);
			return null;
		},
		missing,
		fromTts: new Set(),
		filled: [],
		stats: { paths: files.size, ids: 0, filled, ttsCache: 0, artSet: set?.id ?? null }
	};
}
