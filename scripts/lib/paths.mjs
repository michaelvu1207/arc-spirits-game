// Where things are. Everything a clone needs is inside the repo; what is machine-specific
// (the raw art folder, the art host) comes from arc.local.json (not in git) or the environment.
//
//   data/            the working game tables (the local game and the editor read and write them)
//   tools/editor/    the data editor and card tool
//   .art-cache/      the web-size art, downloaded by `npm run art:fetch` (not in git)
//   arc.local.json   { "artHost": true, "artDir": "~/ArcSpiritsArt" }            on the art host
//                    { "artHostSsh": "user@host", "artHostRepo": "~/path/to/repo" }  elsewhere
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const expand = (p) => (typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

/** arc.local.json of this machine ({} when there is none). */
export function localConfig() {
	const file = join(repoRoot, 'arc.local.json');
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`arc.local.json is not valid JSON: ${e.message}`);
	}
}

/** The working game tables. */
export const dataDir = () => resolve(expand(process.env.ARC_DATA_DIR ?? process.env.ARC_LOCAL_GAME_DIR ?? join(repoRoot, 'data')));

/** The raw art folder (exports, icons), or null on a machine that does not have it. */
export function artDir() {
	const dir = expand(process.env.ARC_LOCAL_ART_DIR ?? localConfig().artDir ?? null);
	return dir && existsSync(dir) ? resolve(dir) : null;
}

/** True on the machine that makes card images and uploads art. */
export const isArtHost = () => localConfig().artHost === true && artDir() !== null;

export const editorDir = join(repoRoot, 'tools/editor');
export const artCacheDir = join(repoRoot, '.art-cache');

/** The play project (public values; keys are never stored in the repo). */
export const PLAY_PROJECT_REF = 'ydmlhjucgvultqhpctlr';
export const PLAY_ART_BASE = `https://${PLAY_PROJECT_REF}.supabase.co/storage/v1/object/public/game_assets/art`;
