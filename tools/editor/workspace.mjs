// Local art workspace: a folder on this computer that the page shows on the left side.
import { readdir, readFile, writeFile, mkdir, stat, rename, cp, open } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, sep, extname, basename, dirname } from 'node:path';
import * as niji from './niji.mjs';

export const ROOT = resolve(process.env.NIJI_WORKSPACE || join(homedir(), 'ArcSpiritsArt'));
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const CACHE = join(ROOT, '.niji-uploads.json'); // file -> Niji library image, so a file uploads only once
const THUMBS = join(ROOT, '.thumbs');
const isImage = (name) => extname(name).toLowerCase() in IMG;

// Uploads and the Niji history come from the local Chrome, or from the remote worker when this server is a client (see remote.mjs).
let uploader = niji.upload;
export const setUploader = (fn) => { uploader = fn; };
let historySource = async () => ({ list: await niji.history().catch(() => []), types: niji.jobTypes() });
export const setHistorySource = (fn) => { historySource = fn; };
// A failed history load gives no data: the files then show without it.
const history = () => historySource().catch(() => ({ list: [], types: new Map() }));

/** Resolves a workspace-relative path. Throws if it points outside the workspace. */
export function safe(rel = '') {
  const abs = resolve(ROOT, String(rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) throw new Error('Path is outside the workspace.');
  return abs;
}
const rel = (abs) => relative(ROOT, abs).split(sep).join('/');

async function tree(dir) {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    // Hidden files `.class-<Class name>.png` (spirit folder) and `.origin-<Origin name>.png` (origin folder) are game icons. The page shows them before the folder name.
    const names = await readdir(abs), icons = names.filter((n) => /^\.(class|origin)-.+\.png$/.test(n)).sort();
    const imgs = names.filter((n) => !n.startsWith('.') && isImage(n)).sort();
    // `guide`: the text of this folder's own guide.txt. The sidebar shows it on hover.
    const guide = names.includes('guide.txt') ? (await readFile(join(abs, 'guide.txt'), 'utf8')).trim() || null : null;
    out.push({ name: e.name, path: rel(abs), images: imgs.length, cover: imgs[0] ?? null, icons, guide, rank: names.includes('.guardian') ? 0 : names.includes('.special') ? 2 : 1, children: await tree(abs) });
  }
  // Order in an origin: the guardian (`.guardian` marker), the common spirits, then the spirits with a special class (`.special`).
  // The page puts a gap between these groups.
  return out.sort((a, b) => a.rank - b.rank);
}

async function imagesIn(dir) {
  return (await readdir(dir)).filter((n) => !n.startsWith('.') && isImage(n)).sort();
}

let cache = null;
export async function uploadCached(abs) {
  cache ??= existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};
  const st = await stat(abs);
  const key = `${rel(abs)}|${st.size}|${Math.round(st.mtimeMs)}`;
  if (!cache[key]) {
    // A large file is sent as a 2048 px JPEG: a reference does not need more, and the upload is much faster.
    let file = abs, type = IMG[extname(abs).toLowerCase()];
    if (st.size > 1_500_000) {
      const small = join(THUMBS, createHash('sha1').update(key).digest('hex') + '-ref.jpg');
      await mkdir(THUMBS, { recursive: true });
      const ok = await new Promise((res) => execFile('sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', abs, '--out', small], (e) => res(!e)));
      if (ok) { file = small; type = 'image/jpeg'; }
    }
    const data = await readFile(file);
    cache[key] = await uploader({ name: basename(file), type, base64: data.toString('base64') });
    await writeFile(CACHE, JSON.stringify(cache));
  }
  return { ...cache[key], name: basename(abs) };
}

// The text of a prompt without the reference URLs and the flags (used for file names).
export const promptText = (p) => p.replace(/https?:\/\/\S+/g, '').replace(/\s--[a-z].*$/, '').trim();
const slug = (s) => s.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/--.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';

/** Checks that a workspace-relative folder exists. Returns its normalized relative path. */
export async function checkFolder(path) {
  const abs = safe(path);
  if (!(await stat(abs).catch(() => null))?.isDirectory()) throw new Error(`Folder not found: ${path}`);
  return rel(abs);
}

// The prompt is stored in the PNG file (an iTXt chunk named "niji-prompt"). Thus it stays
// with the image when the file is renamed, moved or copied, also outside this app.
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PROMPT_KEY = Buffer.from('niji-prompt\0\0\0\0\0', 'latin1'); // keyword + empty iTXt fields
const LABEL_KEY = Buffer.from('niji-label\0\0\0\0\0', 'latin1'); // the job type shown in the generation lists (Arc retexture, Vary, ...)
function textChunk(key, text) {
  const type = Buffer.from('iTXt'), data = Buffer.concat([key, Buffer.from(text, 'utf8')]);
  const len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([len, type, data, crc]);
}
export function pngWithPrompt(buf, prompt, label) {
  if (!prompt || !buf.subarray(0, 8).equals(PNG_SIG)) return buf;
  const at = 8 + 25; // after the signature and the IHDR chunk
  return Buffer.concat([buf.subarray(0, at), textChunk(PROMPT_KEY, prompt), ...(label ? [textChunk(LABEL_KEY, label)] : []), buf.subarray(at)]);
}
export const readPrompt = (abs) => readChunk(abs, PROMPT_KEY);
export const readLabel = (abs) => readChunk(abs, LABEL_KEY);
async function readChunk(abs, KEY) {
  if (extname(abs).toLowerCase() !== '.png') return null;
  const fh = await open(abs, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(16384), 0, 16384, 0);
    for (let o = 8; o + 8 <= bytesRead; ) {
      const len = buffer.readUInt32BE(o), type = buffer.toString('latin1', o + 4, o + 8);
      if (type === 'IDAT') break;
      if (type === 'iTXt' && buffer.subarray(o + 8, o + 8 + KEY.length).equals(KEY)) return buffer.toString('utf8', o + 8 + KEY.length, Math.min(o + 8 + len, bytesRead));
      o += 12 + len;
    }
  } finally {
    await fh.close();
  }
  return null;
}
/** Returns { fileName: prompt } for the images of a folder that came from a generation. */
async function labelsIn(dir, names) {
  const out = {};
  for (const n of names) { const l = /-[0-9a-f]{8}-\d+\.png$/.test(n) ? await readLabel(join(dir, n)).catch(() => null) : null; if (l) out[n] = l; }
  return out;
}
async function promptsIn(dir, names) {
  const out = {}, unknown = [];
  for (const n of names) {
    const p = await readPrompt(join(dir, n)).catch(() => null);
    if (p) out[n] = p;
    else if (/-[0-9a-f]{8}-\d+\.png$/.test(n)) unknown.push(n);
  }
  // An older file has no prompt inside. Its name has the start of the Niji job id: find the job in the history.
  if (unknown.length) {
    const { list } = await history();
    for (const n of unknown) {
      const id8 = n.match(/-([0-9a-f]{8})-\d+\.png$/)[1], job = list.find((h) => h.id.startsWith(id8));
      if (job) out[n] = job.prompt;
    }
  }
  return out;
}

/** Downloads one result image of a Niji job. Returns the PNG bytes. */
export async function downloadImage(jobId, index) {
  const url = `https://cdn.midjourney.com/${jobId}/0_${index}.png`;
  // The CDN keeps a "not found" answer if a file was requested before it existed. A query string gets around that.
  return niji.download(url).catch(() => niji.download(`${url}?r=${Date.now()}`));
}
/** Writes one result image of a Niji job into a workspace folder, with its prompt inside. Returns the file name. */
export async function saveImageBytes({ path, jobId, index, prompt, fullPrompt, label, data }) {
  const name = `${slug(prompt ?? '')}-${jobId.slice(0, 8)}-${index}.png`;
  await writeFile(join(safe(path), name), pngWithPrompt(data, fullPrompt, label));
  return name;
}
/** Downloads one result image of a Niji job into a workspace folder. Returns the file name. */
export async function saveImage({ path, jobId, index, prompt, fullPrompt, label }) {
  return saveImageBytes({ path, jobId, index, prompt, fullPrompt, label, data: await downloadImage(jobId, index) });
}

/** Makes (and caches) a small JPEG of a workspace image with the macOS `sips` tool. */
async function thumbFor(abs) {
  const st = await stat(abs);
  const out = join(THUMBS, createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}`).digest('hex') + '.jpg');
  if (existsSync(out)) return out;
  await mkdir(THUMBS, { recursive: true });
  await new Promise((res, rej) => execFile('sips', ['-Z', '512', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', abs, '--out', out], (e) => (e ? rej(e) : res())));
  return out;
}

// Small WebP copies for the pages (`/ws/file?w=<pixels>`). WebP keeps transparency, so it also fits icons.
const WIDTHS = [64, 128, 256, 384, 512, 768, 1024];
const CWEBP = ['/opt/homebrew/bin/cwebp', '/usr/local/bin/cwebp'].find((p) => existsSync(p)) ?? 'cwebp';
const making = new Map(); // output file -> promise, so one image is made once even if many requests ask for it
let busy = 0;
const queue = [];
/** Runs at most 4 conversions at the same time; a page can ask for hundreds of images at once. */
const limited = (fn) => new Promise((res, rej) => {
  const run = () => { busy++; fn().then(res, rej).finally(() => { busy--; queue.shift()?.(); }); };
  if (busy < 4) run(); else queue.push(run);
});

/** Width in pixels: from the PNG header, or from `sips` for other formats. 0 if unknown. */
async function pixelWidth(abs) {
  if (extname(abs).toLowerCase() === '.png') {
    const fh = await open(abs, 'r');
    try { const { buffer } = await fh.read(Buffer.alloc(24), 0, 24, 0); return buffer.readUInt32BE(16); } finally { await fh.close(); }
  }
  return new Promise((res) => execFile('sips', ['-g', 'pixelWidth', abs], (e, out) => res(e ? 0 : Number(/pixelWidth: (\d+)/.exec(out)?.[1] ?? 0))));
}

/** Makes (and caches) a WebP copy at most `want` pixels wide. An image is never made larger. */
async function smallFor(abs, want, st) {
  const w = WIDTHS.find((x) => x >= want) ?? WIDTHS.at(-1);
  const out = join(THUMBS, createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}|w${w}`).digest('hex') + '.webp');
  if (existsSync(out)) return out;
  if (!making.has(out)) {
    making.set(out, limited(async () => {
      await mkdir(THUMBS, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      const resize = (await pixelWidth(abs).catch(() => 0)) > w ? ['-resize', String(w), '0'] : [];
      await new Promise((res, rej) => execFile(CWEBP, ['-quiet', '-q', '80', ...resize, abs, '-o', tmp], (e) => (e ? rej(e) : res())));
      await rename(tmp, out);
      return out;
    }).finally(() => making.delete(out)));
  }
  return making.get(out);
}

/** Returns a path in `dir` for `name` that is not in use: "a.png", then "a-2.png", ... */
function freeName(dir, name) {
  const ext = extname(name), stem = basename(name, ext);
  let to = join(dir, name);
  for (let n = 2; existsSync(to); n++) to = join(dir, `${stem}-${n}${ext}`);
  return to;
}

// Pinned images: workspace-relative paths, kept in one file. They follow renames and moves.
const PINS = join(ROOT, '.niji-pins.json');
let pins = null;
async function loadPins() {
  pins ??= new Set(existsSync(PINS) ? JSON.parse(await readFile(PINS, 'utf8')) : []);
  return pins;
}
async function remapPins(from, to) {
  const p = await loadPins();
  let changed = false;
  for (const x of [...p]) {
    if (x !== from && !x.startsWith(from + '/')) continue;
    p.delete(x); changed = true;
    if (to != null) p.add(to + x.slice(from.length));
  }
  if (changed) await writeFile(PINS, JSON.stringify([...p]));
}
// Tags: { workspace-relative path: [tag, ...] }, kept in one file. They follow renames and moves, like the pins.
const TAGS = join(ROOT, '.niji-tags.json');
let tags = null;
async function loadTags() {
  tags ??= existsSync(TAGS) ? JSON.parse(await readFile(TAGS, 'utf8')) : {};
  return tags;
}
const saveTags = () => writeFile(TAGS, JSON.stringify(tags));
async function remapTags(from, to) {
  const t = await loadTags();
  let changed = false;
  for (const x of Object.keys(t)) {
    if (x !== from && !x.startsWith(from + '/')) continue;
    const v = t[x]; delete t[x]; changed = true;
    if (to != null) t[to + x.slice(from.length)] = v;
  }
  if (changed) await saveTags();
}
/** Returns { fileName: { time, job } }: when the image was made and the start of its Niji job id. */
const KIND = (type = '') => (/upsample|upscale/.test(type) ? 'Upscale' : /pan/.test(type) ? 'Pan' : /outpaint/.test(type) ? 'Zoom out' : /vary|variation/.test(type) ? 'Vary' : /remix/.test(type) ? 'Remix' : /reroll/.test(type) ? 'Rerun' : /enhance/.test(type) ? 'Enhance' : /retexture/.test(type) ? 'Retexture' : /edit/.test(type) ? 'Edit' : null);
async function infoIn(dir, names) {
  const out = {};
  for (const n of names) out[n] = { time: (await stat(join(dir, n))).birthtimeMs, job: n.match(/-([0-9a-f]{8})-\d+\.png$/)?.[1] ?? null };
  if (names.some((n) => out[n].job)) {
    const { list, types: typeMap } = await history();
    for (const n of names) {
      const h = out[n].job && list.find((x) => x.id.startsWith(out[n].job));
      if (h?.time) out[n].time = Date.parse(h.time);
    }
    // The type of the job that made the image (zoom out, pan, upscale), for the row label.
    const types = [...typeMap];
    for (const n of names) { const t = out[n].job && types.find(([id]) => id.startsWith(out[n].job)); if (t) out[n].kind = KIND(t[1]); }
  }
  return out;
}

// Saved prompts: one file in the workspace, so each browser sees the same list.
const SAVED = join(ROOT, '.niji-saved.json');
const readSaved = async () => (existsSync(SAVED) ? JSON.parse(await readFile(SAVED, 'utf8')) : []);

export const routes = {
  async 'GET /api/saved'() {
    return [200, await readSaved()];
  },
  async 'POST /api/saved'(body) {
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name || typeof body.text !== 'string') return [400, { error: 'A saved prompt needs a name.' }];
    const list = (await readSaved()).filter((x) => x.name !== name); // the same name replaces the old one
    list.unshift({ id: createHash('sha1').update(name + Date.now()).digest('hex').slice(0, 12), name, text: body.text, style: String(body.style ?? ''), refs: body.refs ?? {}, settings: body.settings ?? {}, savedAt: Date.now() });
    await writeFile(SAVED, JSON.stringify(list, null, 1));
    return [200, list];
  },
  async 'POST /api/saved/delete'(body) {
    const list = (await readSaved()).filter((x) => x.id !== body.id);
    await writeFile(SAVED, JSON.stringify(list, null, 1));
    return [200, list];
  },
  async 'POST /api/ws/pin'(body) {
    const dir = rel(safe(body.path)), p = await loadPins();
    for (const n of body.names ?? []) { const key = `${dir}/${basename(String(n))}`; if (body.pinned) p.add(key); else p.delete(key); }
    await writeFile(PINS, JSON.stringify([...p]));
    return [200, {}];
  },
  /** Adds (on: true) or removes a tag on images of one folder. A tag is a short plain word or phrase. */
  async 'POST /api/ws/tag'(body) {
    const dir = rel(safe(body.path)), t = await loadTags(), tag = String(body.tag ?? '').trim().toLowerCase().slice(0, 40);
    if (!tag) return [400, { error: 'Type a tag.' }];
    for (const n of body.names ?? []) {
      const key = `${dir}/${basename(String(n))}`, list = (t[key] ?? []).filter((x) => x !== tag);
      if (body.on) list.push(tag);
      if (list.length) t[key] = list.sort(); else delete t[key];
    }
    await saveTags();
    return [200, {}];
  },
  /** All tags in use, with how many images have each one. */
  async 'GET /api/ws/tags'() {
    const t = await loadTags(), count = {};
    for (const list of Object.values(t)) for (const x of list) count[x] = (count[x] ?? 0) + 1;
    return [200, count];
  },
  async 'GET /api/ws/tree'() {
    if (!existsSync(ROOT)) return [200, { root: ROOT, missing: true, folders: [] }];
    for (const area of ['references', 'assets']) await mkdir(join(ROOT, area), { recursive: true }); // the two areas of the sidebar
    return [200, { root: ROOT, folders: await tree(ROOT) }];
  },
  async 'GET /api/ws/list'(_, url) {
    const dir = safe(url.searchParams.get('path') ?? '');
    const promptFile = join(dir, 'prompt.txt');
    const images = await imagesIn(dir);
    await loadPins();
    const here = rel(dir), pinned = images.filter((n) => (pins ?? new Set()).has(`${here}/${n}`));
    const t = await loadTags(), tagged = Object.fromEntries(images.filter((n) => t[`${here}/${n}`]).map((n) => [n, t[`${here}/${n}`]]));
    // Guide: `guide.txt` of this folder. If there is none, the guide of the nearest parent folder (for example the origin of a spirit).
    // They show above the images and are added to prompts made in this folder.
    const guides = [];
    for (let d = dir; d.startsWith(ROOT) && d !== ROOT; d = dirname(d)) {
      const f = join(d, 'guide.txt');
      if (existsSync(f)) { const text = (await readFile(f, 'utf8')).trim(); if (text) { guides.push({ from: basename(d), own: d === dir, text }); break; } }
    }
    const guide = guides.map((g) => g.text).join(', ') || null;
    return [200, { images, guide, guides, pinned, tags: tagged, info: await infoIn(dir, images), prompts: await promptsIn(dir, images), labels: await labelsIn(dir, images), prompt: existsSync(promptFile) ? (await readFile(promptFile, 'utf8')).trim() : null }];
  },
  async 'POST /api/ws/mkdir'(body) {
    const name = String(body.name ?? '').trim();
    if (!name || /[\\/]|^\./.test(name)) return [400, { error: 'Invalid folder name.' }];
    await mkdir(join(safe(body.path), name), { recursive: true });
    return [200, {}];
  },
  /** Saves one result image of a Niji job into a workspace folder. */
  async 'POST /api/ws/save'(body) {
    if (!/^[0-9a-f-]{36}$/.test(body.jobId ?? '') || !(Number(body.index) >= 0 && Number(body.index) < 16)) return [400, { error: 'Invalid image.' }];
    const dir = safe(body.path);
    const name = await saveImage({ path: rel(dir), jobId: body.jobId, index: Number(body.index), prompt: body.prompt });
    return [200, { name }];
  },
  /** Uploads workspace images to the Niji library so that they can be used as references. */
  async 'POST /api/ws/attach'(body) {
    const files = [];
    for (const p of body.paths ?? []) {
      const abs = safe(p);
      if ((await stat(abs)).isDirectory()) {
        // A folder gives its pinned images only (Michael, 2026-11-07); a folder with no pins gives all of them.
        const all = await imagesIn(abs), p = await loadPins(), pinned = all.filter((n) => p.has(rel(join(abs, n))));
        files.push(...(pinned.length ? pinned : all).map((n) => join(abs, n)));
      }
      else if (isImage(abs)) files.push(abs);
    }
    const first = safe(body.paths?.[0] ?? '');
    const dir = (await stat(first)).isDirectory() ? first : join(first, '..');
    const promptFile = join(dir, 'prompt.txt');
    const prompt = existsSync(promptFile) ? (await readFile(promptFile, 'utf8')).trim() : null;
    if (!files.length && !prompt) return [400, { error: 'No images there.' }];
    if (files.length > 24) return [400, { error: `${files.length} images is more than the limit of 24 for one drop.` }];
    const images = [];
    for (const f of files) images.push(await uploadCached(f));
    // A folder can carry a default prompt style in prompt.txt.
    return [200, { images, prompt, folder: rel(dir) }];
  },
  /** Moves an image or a folder into another workspace folder. A name that is in use gets a number. */
  async 'POST /api/ws/move'(body) {
    const from = safe(body.from), dir = safe(body.to);
    const st = await stat(from).catch(() => null);
    if (!st || from === ROOT || (!st.isDirectory() && !isImage(from))) return [400, { error: 'Item not found.' }];
    if (!(await stat(dir).catch(() => null))?.isDirectory()) return [400, { error: 'Folder not found.' }];
    if (join(from, '..') === dir) return [200, { same: true }];
    if (st.isDirectory() && (dir === from || dir.startsWith(from + sep))) return [400, { error: 'A folder cannot move into itself.' }];
    const to = freeName(dir, basename(from));
    await rename(from, to);
    await remapPins(rel(from), rel(to));
    await remapTags(rel(from), rel(to));
    return [200, { name: basename(to), ...(st.isDirectory() ? { movedFolder: { from: rel(from), to: rel(to) } } : {}) }];
  },
  /** Copies an image or a folder into a workspace folder. A name that is in use gets a number. */
  async 'POST /api/ws/copy'(body) {
    const from = safe(body.from), dir = safe(body.to);
    const st = await stat(from).catch(() => null);
    if (!st || from === ROOT || (!st.isDirectory() && !isImage(from))) return [400, { error: 'Item not found.' }];
    if (!(await stat(dir).catch(() => null))?.isDirectory()) return [400, { error: 'Folder not found.' }];
    if (st.isDirectory() && (dir === from || dir.startsWith(from + sep))) return [400, { error: 'A folder cannot be copied into itself.' }];
    const to = freeName(dir, basename(from));
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    return [200, { name: basename(to) }];
  },
  /** Gives an image or a folder a new name. An image keeps its file type. */
  async 'POST /api/ws/rename'(body) {
    const from = safe(body.path);
    const st = await stat(from).catch(() => null);
    if (!st || from === ROOT) return [400, { error: 'Item not found.' }];
    let name = String(body.name ?? '').trim();
    if (!name || /[\\/:]|^\./.test(name)) return [400, { error: 'That name is not valid.' }];
    if (!st.isDirectory() && extname(name).toLowerCase() !== extname(from).toLowerCase()) name += extname(from);
    const to = join(from, '..', name);
    if (to === from) return [200, { name }];
    if (existsSync(to) && to.toLowerCase() !== from.toLowerCase()) return [400, { error: `“${name}” is already in this folder.` }];
    await rename(from, to);
    await remapPins(rel(from), rel(to));
    await remapTags(rel(from), rel(to));
    return [200, { name, ...(st.isDirectory() ? { movedFolder: { from: rel(from), to: rel(to) } } : {}) }];
  },
  /** Deletes an image or a folder: it goes to the macOS Trash, so you can get it back. */
  async 'POST /api/ws/delete'(body) {
    const from = safe(body.path);
    const st = await stat(from).catch(() => null);
    if (!st || from === ROOT) return [400, { error: 'Item not found.' }];
    const trash = join(homedir(), '.Trash');
    await rename(from, freeName(trash, basename(from)));
    await remapPins(rel(from), null);
    await remapTags(rel(from), null);
    return [200, st.isDirectory() ? { deletedFolder: rel(from) } : {}];
  },
  /** Saves an image from this computer into a workspace folder. */
  async 'POST /api/ws/put'(body) {
    const dir = safe(body.path), name = basename(String(body.name ?? ''));
    if (!isImage(name) || name.startsWith('.') || typeof body.base64 !== 'string') return [400, { error: 'Only PNG, JPEG, WebP or GIF images.' }];
    if (!(await stat(dir).catch(() => null))?.isDirectory()) return [400, { error: 'Folder not found.' }];
    const to = freeName(dir, name);
    await writeFile(to, Buffer.from(body.base64, 'base64'));
    return [200, { name: basename(to) }];
  },
  async 'POST /api/ws/prompt'(body) {
    await writeFile(join(safe(body.path), 'prompt.txt'), String(body.text ?? '').trim() + '\n');
    return [200, {}];
  },
};

/** Serves one workspace image: GET /ws/file?path=... */
export async function serveFile(url, res) {
  const abs = safe(url.searchParams.get('path') ?? '');
  if (!isImage(abs) || !existsSync(abs)) {
    res.writeHead(404).end();
    return;
  }
  const st = await stat(abs);
  const ext = extname(abs).toLowerCase();
  const w = Math.max(0, Math.floor(Number(url.searchParams.get('w')) || 0));
  const mode = w ? `w${w}` : url.searchParams.has('thumb') ? 't' : 'f';
  // The ETag changes when the file changes, so the browser can keep the image and only ask "still the same?".
  // A URL with `v=<key>` already changes with the image: the browser keeps that one without asking.
  const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}-${mode}"`;
  const cache = url.searchParams.has('v') ? 'private, max-age=2592000, immutable' : 'private, no-cache';
  if (res.req?.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cache }).end();
    return;
  }
  // ?w=<pixels> serves a small WebP; ?thumb=1 serves a small JPEG. If the tool fails, or the copy is not smaller, the original file is served.
  let body = abs, type = IMG[ext], size = st.size;
  const small = w && ext !== '.gif' ? await smallFor(abs, w, st).catch(() => null) : !w && url.searchParams.has('thumb') ? await thumbFor(abs).catch(() => null) : null;
  if (small) {
    const ss = await stat(small);
    if (ss.size < st.size) { body = small; size = ss.size; type = small.endsWith('.webp') ? 'image/webp' : 'image/jpeg'; }
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, etag, 'cache-control': cache });
  createReadStream(body).pipe(res);
}
